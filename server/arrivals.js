'use strict';

// Venue arrivals (owner decision 2026-11-25). A participant scans the poster at a desk, a staff
// phone scans a ticket in the line, or an on-site signup finishes: each puts the person on that
// desk's waiting list ("도착"). Entry is confirmed at the desk, by handing over the name tag or
// scanning the ticket. An arrival stores ids and times only, never names or contact details, so
// erasing a participant leaves nothing personal behind.

const { failure, list, clean, nextId, findTicket } = require('./commands/shared.ts');
const { attendanceNeedsReview, indexLatestChecks } = require('../apps/web/lib/attendance-state.cjs');

const ARRIVAL_SOURCES = ['SELF', 'STAFF', 'SIGNUP'];
// A claim this old is free again: the laptop that took it was closed or lost its network.
const PRINT_CLAIM_MS = 60_000;

function isOpenArrival(arrival) {
  return Boolean(arrival) && !arrival.handedAt && !arrival.cancelledAt;
}

function openArrivalFor(workspace, participantId) {
  return list(workspace.arrivals).find((item) => isOpenArrival(item) && String(item.participantId) === String(participantId)) || null;
}

function deskTakesArrivals(desk) {
  return Boolean(desk) && desk.open !== false && String(desk.action || '').toUpperCase() === 'IN';
}

function requireEntryDesk(workspace, deskId) {
  const desk = list(workspace.desks).find((item) => item && String(item.id) === clean(deskId, 120));
  if (!desk) throw failure(404, '데스크를 찾을 수 없습니다.');
  if (!deskTakesArrivals(desk)) {
    throw failure(409, '이 데스크는 지금 입장을 받지 않습니다. 운영자에게 확인하세요.', undefined, 'DESK_CLOSED');
  }
  return desk;
}

// A cancelled, revoked or erased registration never appears on a desk.
function arrivalBlockedOut(person) {
  return !person || person.erased === true || person.revoked === true || person.cancelled === true ||
    String(person.status || '').toUpperCase() === 'CANCELLED';
}

// Why this person cannot simply be handed a name tag, judged from the current record.
function arrivalReview(workspace, person, checkIndex) {
  const status = String(person.status || '').toUpperCase();
  if (status === 'PENDING') return 'PENDING';
  if (status === 'WAITLIST') return 'WAITLIST';
  if (status !== 'APPROVED') return 'STATUS';
  // The entry scan refuses an expired ticket, so no tag is printed for one.
  const expiry = clean(person.ticketExpiresAt, 64);
  if (expiry && !(Date.parse(expiry) > Date.now())) return 'EXPIRED';
  if (!['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase())) return 'PAYMENT';
  if (attendanceNeedsReview(person, checkIndex || indexLatestChecks(workspace.checks))) return 'ATTENDANCE';
  if (person.inside !== true && person.everIn === true && workspace.allowReentry !== true) return 'REENTRY';
  return null;
}

// One open arrival per person. Arriving again refreshes it; moving to another desk clears the
// print state so the new desk prints.
function recordArrival(workspace, { participantId, deskId, source, now }) {
  if (!ARRIVAL_SOURCES.includes(source)) throw failure(400, '도착 경로를 확인하세요.');
  if (!Array.isArray(workspace.arrivals)) workspace.arrivals = [];
  const current = openArrivalFor(workspace, participantId);
  if (current) {
    if (String(current.deskId) !== String(deskId)) {
      Object.assign(current, { deskId: String(deskId), printedAt: null, printFailedAt: null, printClaim: null });
    }
    Object.assign(current, { at: now, source });
    return current;
  }
  const arrival = {
    id: nextId('arrival'), participantId: String(participantId), deskId: String(deskId), at: now, source,
    printedAt: null, printFailedAt: null, printClaim: null, handedAt: null, checkId: null, cancelledAt: null,
  };
  workspace.arrivals.push(arrival);
  return arrival;
}

// Any successful entry, at any desk, ends the wait.
function closeArrivals(workspace, participantId, { checkId, now }) {
  for (const arrival of list(workspace.arrivals)) {
    if (!isOpenArrival(arrival) || String(arrival.participantId) !== String(participantId)) continue;
    Object.assign(arrival, { handedAt: now, checkId: String(checkId || ''), printClaim: null });
  }
}

function requireOpenArrival(workspace, desk, arrivalId) {
  const arrival = list(workspace.arrivals).find((item) => item && String(item.id) === clean(arrivalId, 120));
  if (!arrival || String(arrival.deskId) !== String(desk.id)) {
    throw failure(404, '이 데스크의 도착 기록을 찾을 수 없습니다. 목록을 다시 확인하세요.', undefined, 'ARRIVAL_NOT_FOUND');
  }
  if (!isOpenArrival(arrival)) {
    throw failure(409, '이미 처리했거나 취소한 도착입니다. 목록을 다시 확인하세요.', undefined, 'ARRIVAL_CLOSED');
  }
  return arrival;
}

function stationId(value) {
  const station = clean(value, 64);
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(station)) throw failure(400, '출력 기기를 확인할 수 없습니다. 화면을 새로 고치세요.');
  return station;
}

// Two laptops on one desk must not print the same tag twice: one of them claims it first.
function claimPrint(workspace, desk, input, now) {
  const arrival = requireOpenArrival(workspace, desk, input.arrivalId);
  const station = stationId(input.station);
  const person = list(workspace.participants).find((item) => item && String(item.id) === arrival.participantId);
  if (arrivalBlockedOut(person) || arrivalReview(workspace, person)) return { arrival, claimed: false };
  const force = input.force === true;
  const held = arrival.printClaim && arrival.printClaim.station !== station &&
    Date.parse(now) - Date.parse(arrival.printClaim.at) < PRINT_CLAIM_MS;
  if (!force && (arrival.printedAt || arrival.printFailedAt || held)) return { arrival, claimed: false };
  Object.assign(arrival, { printClaim: { station, at: now }, printedAt: null, printFailedAt: null });
  return { arrival, claimed: true };
}

function reportPrint(workspace, desk, input, now) {
  const arrival = requireOpenArrival(workspace, desk, input.arrivalId);
  const station = stationId(input.station);
  if (typeof input.ok !== 'boolean') throw failure(400, '출력 결과를 확인하세요.');
  if (arrival.printClaim && arrival.printClaim.station === station) {
    Object.assign(arrival, { printClaim: null, printedAt: input.ok ? now : null, printFailedAt: input.ok ? null : now });
  }
  return arrival;
}

// A staff phone scanning a ticket in the line. The same identity and ticket rules as a desk
// scan apply to the ticket itself; approval or payment problems still reach the desk list.
function arrivalPersonByTicket(workspace, token) {
  const person = findTicket(workspace, token);
  if (!person) throw failure(404, '이 행사에서 티켓을 찾을 수 없습니다. 다른 행사 또는 잘못된 코드를 확인하세요.');
  if (arrivalBlockedOut(person)) throw failure(409, '입장 가능한 티켓이 아닙니다. 등록 상태를 확인하세요.');
  const expiry = Date.parse(person.ticketExpiresAt);
  if (!Number.isFinite(expiry) || expiry <= Date.now()) throw failure(409, '티켓이 만료되었습니다. 운영자에게 재발급을 요청하세요.');
  return person;
}

const namesakeKey = (person) => `${String(person.name || '').normalize('NFC').replace(/\s+/g, '')}\n${String(person.company || '').normalize('NFC').replace(/\s+/g, '')}`.toLowerCase();

// What one desk screen reads every few seconds: its waiting list and the entry count.
// `now` is the server's clock, so a laptop with a wrong clock judges waiting times correctly.
function deskArrivalView(workspace, desk) {
  const people = new Map(list(workspace.participants).filter(Boolean).map((person) => [String(person.id), person]));
  const checkIndex = indexLatestChecks(workspace.checks);
  // Two registrations that look identical on a tag need a second look before handing it over.
  const namesakes = new Map();
  for (const person of people.values()) {
    if (!arrivalBlockedOut(person)) namesakes.set(namesakeKey(person), (namesakes.get(namesakeKey(person)) || 0) + 1);
  }
  const arrivals = [];
  for (const arrival of list(workspace.arrivals)) {
    if (!isOpenArrival(arrival) || String(arrival.deskId) !== String(desk.id)) continue;
    const person = people.get(String(arrival.participantId));
    if (arrivalBlockedOut(person) || person.inside === true) continue;
    arrivals.push({
      id: String(arrival.id), participantId: String(arrival.participantId),
      name: String(person.name || ''), company: String(person.company || ''), group: String(person.group || ''),
      source: String(arrival.source || ''), at: String(arrival.at || ''),
      review: arrivalReview(workspace, person, checkIndex),
      namesake: namesakes.get(namesakeKey(person)) > 1,
      printedAt: arrival.printedAt || null, printFailedAt: arrival.printFailedAt || null,
      printClaim: arrival.printClaim ? { station: arrival.printClaim.station, at: arrival.printClaim.at } : null,
    });
  }
  arrivals.sort((left, right) => left.at.localeCompare(right.at));
  const approved = [...people.values()].filter((person) => !arrivalBlockedOut(person) && String(person.status || '').toUpperCase() === 'APPROVED');
  return {
    now: new Date().toISOString(),
    desk: { id: String(desk.id), name: String(desk.name || ''), action: String(desk.action || ''), open: desk.open !== false, nametag: desk.nametag !== false },
    arrivals,
    entered: approved.filter((person) => person.inside === true).length,
    total: approved.length,
  };
}

module.exports = {
  arrivalBlockedOut,
  arrivalPersonByTicket,
  arrivalReview,
  claimPrint,
  closeArrivals,
  deskArrivalView,
  deskTakesArrivals,
  isOpenArrival,
  openArrivalFor,
  recordArrival,
  reportPrint,
  requireEntryDesk,
  requireOpenArrival,
  PRINT_CLAIM_MS,
};
