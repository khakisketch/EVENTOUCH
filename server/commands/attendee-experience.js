'use strict';

// Attendee experience commands for the mobile landing shell:
//   lucky.assign      issue a personal lucky number to the ticket holder
//   lucky.config.save operator-managed lucky-number pool bounds (default 1..900)
//   lucky.preassign   operator batch pre-assignment before invitation messaging
//   roulette.spin     spin the mobile roulette for the ticket holder
//   roulette.config.save operator-managed named prize inventory + open/close/schedule
//   vote.ranked       submit a selection vote (legacy: up to 5 teams, ranks optional)
//   vote.config.save  operator-managed exact pick count + open/close + results gate
//   vote.tally        operator-visible top-3 aggregation with explicit ties
//   team.save         operator-managed voting team (id/name/order)
//   draw.program.save operator-managed draw program slot (quota/eligibility/overlap/...)
//   draw.program.run  run a configured draw program slot (batched, 20 per run)
//
// State lives in the event workspace JSONB (luckyNumbers, rouletteResults,
// teams, votes, voteConfig, rouletteConfig, luckyConfig, drawPrograms) so no
// schema migration is required. Existing draw.run/publish/display.set continue
// to own the big-screen draw output.
//
// Conservative defaults: every operator-controlled gate starts CLOSED or
// unconfigured, and a spin/vote/draw without valid setup is refused with a
// clear message instead of running on invented odds or silent exclusions.

const crypto = require('node:crypto');
const engagement = require('./engagement');

const COMMANDS = new Set([
  'lucky.assign',
  'lucky.config.save',
  'lucky.preassign',
  'roulette.spin',
  'roulette.config.save',
  'vote.ranked',
  'vote.config.save',
  'vote.tally',
  'team.save',
  'draw.program.save',
  'draw.program.run',
]);

const GUEST_COMMANDS = new Set(['lucky.assign', 'roulette.spin', 'vote.ranked']);

const LEGACY_MAX_VOTE_PICKS = 5;
const MAX_VOTE_RANK = 3;
const VOTE_PICK_MIN = 1;
const VOTE_PICK_MAX = 20;
const VOTE_PICK_DEFAULT = 5;
const LEGACY_LUCKY_MAX = 10000;
const LUCKY_DEFAULT_MIN = 1;
const LUCKY_DEFAULT_MAX = 900;
const DRAW_RUN_BATCH = 20;
const ATTENDEE_STAGES = new Set(['READY', 'LIVE', 'ENDED']);

function list(value) {
  return Array.isArray(value) ? value : [];
}

function object(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function clean(value, max = 500) {
  return String(value === undefined || value === null ? '' : value).trim().slice(0, max);
}

function requireText(ctx, value, label, max, field) {
  const text = ctx.clean(value, max);
  if (!text) throw ctx.fail(400, `${label}을(를) 입력하세요`, field);
  return text;
}

function requireFeature(ctx, feature) {
  if (!list(ctx.event.features).includes(feature)) throw ctx.fail(409, '행사 설정에서 이 기능을 먼저 켜세요', feature);
}

function ensureAttendee(ctx) {
  const stage = String(ctx.event.stage || '').toUpperCase();
  if (!ATTENDEE_STAGES.has(stage)) throw ctx.fail(409, '현재 참여 프로그램을 이용할 수 없습니다');
  const person = ctx.participant;
  if (!person) throw ctx.fail(401, '티켓 링크를 확인하세요');
  const status = String(person.status || '').toUpperCase();
  if (status !== 'APPROVED') throw ctx.fail(403, '참가 확정 후 이용할 수 있습니다');
  return person;
}

function findModule(ctx, id) {
  const module = list(ctx.workspace.modules).find((item) => item && item.id === ctx.clean(id, 120));
  if (!module) throw ctx.fail(404, '참여 프로그램을 찾을 수 없습니다');
  return module;
}

// ---------------------------------------------------------------------------
// Lucky numbers
// ---------------------------------------------------------------------------

function getLuckyNumbers(workspace) {
  return Array.isArray(workspace.luckyNumbers) ? workspace.luckyNumbers : [];
}

function luckyRange(workspace) {
  const config = object(workspace.luckyConfig);
  if (Number.isInteger(config.min) && Number.isInteger(config.max) && config.min >= 1 && config.min <= config.max) {
    return { min: config.min, max: config.max, configured: true };
  }
  return { min: 1, max: LEGACY_LUCKY_MAX, configured: false };
}

function saveLuckyConfig(ctx, input) {
  requireFeature(ctx, 'draw');
  const old = object(ctx.workspace.luckyConfig);
  const rawMin = input.min === undefined || input.min === null || input.min === ''
    ? (old.min ?? LUCKY_DEFAULT_MIN)
    : Number(input.min);
  const rawMax = input.max === undefined || input.max === null || input.max === ''
    ? (old.max ?? LUCKY_DEFAULT_MAX)
    : Number(input.max);
  if (!Number.isInteger(rawMin) || !Number.isInteger(rawMax) || rawMin < 1 || rawMax < rawMin || rawMax > 999999) {
    throw ctx.fail(400, '럭키번호 범위를 1 이상의 정수로 입력하세요 (최소 ≤ 최대)', 'min');
  }
  // Issued numbers are immutable: shrinking the pool below an issued number
  // would orphan it, so the operator must keep every issued number covered.
  const issued = getLuckyNumbers(ctx.workspace).map((item) => item && item.number).filter(Number.isInteger);
  if (issued.some((number) => number < rawMin || number > rawMax)) {
    throw ctx.fail(409, '이미 발급된 번호가 있어 범위를 바꿀 수 없습니다');
  }
  ctx.workspace.luckyConfig = { min: rawMin, max: rawMax };
  return { body: { luckyConfig: { ...ctx.workspace.luckyConfig } } };
}

function drawUniqueNumbers(range, taken, count) {
  const size = range.max - range.min + 1;
  if (taken.size + count > size) return null;
  const assigned = [];
  const guard = size + 64;
  let attempts = 0;
  while (assigned.length < count && attempts < guard) {
    attempts += 1;
    const candidate = range.min + crypto.randomInt(size);
    if (!taken.has(candidate)) {
      taken.add(candidate);
      assigned.push(candidate);
    }
  }
  return assigned.length === count ? assigned : null;
}

// Atomic batch pre-assignment: the whole command runs in one transaction, so
// either every listed participant gets a number or none does. Invitation
// messaging must run only after this succeeds (message.retry refuses a
// {{럭키번호}} campaign while any recipient still lacks a number).
function preassignLuckyNumbers(ctx, input) {
  requireFeature(ctx, 'draw');
  const rawIds = Array.isArray(input.participantIds) ? input.participantIds : [];
  const ids = [...new Set(rawIds.map((id) => clean(id, 120)).filter(Boolean))];
  if (!ids.length || ids.length > 5000) {
    throw ctx.fail(400, '번호를 배정할 참가자를 1~5000명으로 선택하세요', 'participantIds');
  }
  const people = ids.map((id) => {
    const person = list(ctx.workspace.participants).find((item) => item && item.id === id) || null;
    if (!person || String(person.status || '').toUpperCase() === 'CANCELLED') {
      throw ctx.fail(404, '발송 가능한 참가자를 찾을 수 없습니다', 'participantIds');
    }
    return person;
  });
  const range = luckyRange(ctx.workspace);
  const numbers = getLuckyNumbers(ctx.workspace);
  const taken = new Set(numbers.map((item) => item && item.number).filter(Number.isInteger));
  const needy = people.filter((person) => !numbers.some((item) => item && item.participantId === person.id));
  const size = range.max - range.min + 1;
  if (taken.size + needy.length > size) {
    throw ctx.fail(
      409,
      `번호가 ${taken.size + needy.length - size}개 부족합니다. 번호 범위를 먼저 넓히세요`,
      'participantIds'
    );
  }
  const assigned = drawUniqueNumbers(range, taken, needy.length);
  if (!assigned) throw ctx.fail(409, '번호가 소진되었습니다. 번호 범위를 먼저 넓히세요', 'participantIds');
  const entries = needy.map((person, index) => {
    const entry = { participantId: person.id, number: assigned[index], at: ctx.now, preassigned: true };
    numbers.push(entry);
    return { participantId: person.id, number: entry.number };
  });
  ctx.workspace.luckyNumbers = numbers;
  return { body: { assigned: entries, skipped: people.length - needy.length, range: { min: range.min, max: range.max } } };
}

function assignLuckyNumber(ctx) {
  requireFeature(ctx, 'draw');
  const person = ensureAttendee(ctx);
  const numbers = getLuckyNumbers(ctx.workspace);
  const existing = numbers.find((item) => item && item.participantId === person.id);
  if (existing) return { body: { lucky: { number: existing.number, at: existing.at } } };
  const range = luckyRange(ctx.workspace);
  const taken = new Set(numbers.map((item) => item && item.number).filter(Number.isInteger));
  const assigned = drawUniqueNumbers(range, taken, 1);
  if (!assigned) throw ctx.fail(409, '번호가 소진되었습니다. 운영자에게 문의하세요');
  const entry = { participantId: person.id, number: assigned[0], at: ctx.now };
  numbers.push(entry);
  ctx.workspace.luckyNumbers = numbers;
  return { body: { lucky: { number: entry.number, at: entry.at } } };
}

// ---------------------------------------------------------------------------
// Roulette (mobile, independent of stage draw programs)
// ---------------------------------------------------------------------------

function getRouletteResults(workspace) {
  return Array.isArray(workspace.rouletteResults) ? workspace.rouletteResults : [];
}

function rouletteStatus() {
  return '룰렛은 특정 시간에 운영됩니다. 시작 안내를 확인하세요';
}

function getRouletteConfig(workspace) {
  const config = workspace.rouletteConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  return config;
}

function rouletteUsedCounts(results) {
  const used = new Map();
  for (const item of list(results)) {
    if (!item || typeof item.prizeId !== 'string') continue;
    used.set(item.prizeId, (used.get(item.prizeId) || 0) + 1);
  }
  return used;
}

function rouletteRemaining(config, results) {
  const used = rouletteUsedCounts(results);
  return list(config.prizes).map((prize) => ({
    prize,
    remaining: prize.quantity === null ? null : Math.max(0, Number(prize.quantity) - (used.get(prize.id) || 0)),
  }));
}

// The single selectability rule shared by save-OPEN validation, spin, and
// the public rouletteView.open projection. A finite prize is selectable
// while stock remains (explicit weight, when configured, replaces the
// remaining-count weight; 0 pauses it). An unlimited prize carries no
// stock, so its explicit positive weight IS its policy — there is no
// invented fallback share.
function rouletteEffectiveWeight(prize, usedCount) {
  if (!prize || typeof prize.id !== 'string') return 0;
  if (prize.quantity === null) {
    return Number.isInteger(prize.weight) && prize.weight > 0 ? prize.weight : 0;
  }
  const remaining = Number(prize.quantity) - usedCount;
  if (!Number.isFinite(remaining) || remaining <= 0) return 0;
  if (prize.weight === null || prize.weight === undefined) return remaining;
  return Number.isInteger(prize.weight) && prize.weight >= 0 ? prize.weight : 0;
}

function saveRouletteConfig(ctx, input) {
  requireFeature(ctx, 'draw');
  const old = getRouletteConfig(ctx.workspace) || {};
  const rawPrizes = input.prizes === undefined ? old.prizes : input.prizes;
  if (!Array.isArray(rawPrizes) || !rawPrizes.length || rawPrizes.length > 20) {
    throw ctx.fail(400, '룰렛 상품을 1~20개로 등록하세요', 'prizes');
  }
  const prizes = rawPrizes.map((raw, index) => {
    const source = object(raw);
    const label = clean(source.label, 80);
    if (!label) throw ctx.fail(400, `상품 ${index + 1}의 이름을 입력하세요`, 'prizes');
    let quantity;
    if (source.quantity === undefined || source.quantity === '') {
      throw ctx.fail(400, `상품 ${index + 1}의 수량을 입력하세요 (무제한은 null)`, 'prizes');
    }
    if (source.quantity === null) {
      // Unlimited means "never depletes", nothing more: without an explicit
      // positive weight there is no defined chance, so the prize is invalid
      // rather than silently assigned a house share.
      quantity = null;
    } else {
      quantity = Number(source.quantity);
      if (!Number.isInteger(quantity) || quantity < 0 || quantity > 100000) {
        throw ctx.fail(400, `상품 ${index + 1}의 수량을 0~100000으로 입력하세요`, 'prizes');
      }
    }
    let weight = null;
    if (source.weight !== undefined && source.weight !== null && source.weight !== '') {
      weight = Number(source.weight);
      if (!Number.isInteger(weight) || weight < 0 || weight > 1000000) {
        throw ctx.fail(400, `상품 ${index + 1}의 가중치를 확인하세요`, 'prizes');
      }
    }
    if (quantity === null && !(Number.isInteger(weight) && weight > 0)) {
      throw ctx.fail(400, `무제한 상품은 가중치를 1 이상으로 입력하세요: ${label}`, 'prizes');
    }
    return { id: clean(source.id, 120) || `prize-${index + 1}`, label, quantity, weight };
  });
  if (new Set(prizes.map((prize) => prize.id)).size !== prizes.length) {
    throw ctx.fail(400, '상품 ID가 중복되었습니다', 'prizes');
  }
  const status = clean(input.status, 16).toUpperCase() || old.status || 'DRAFT';
  if (!['DRAFT', 'OPEN', 'CLOSED'].includes(status)) {
    throw ctx.fail(400, '룰렛 상태를 선택하세요', 'status');
  }
  const startsAt = input.startsAt === undefined ? (old.startsAt || null) : (clean(input.startsAt, 64) || null);
  const endsAt = input.endsAt === undefined ? (old.endsAt || null) : (clean(input.endsAt, 64) || null);
  for (const key of ['startsAt', 'endsAt']) {
    const value = key === 'startsAt' ? startsAt : endsAt;
    if (value !== null && !Number.isFinite(Date.parse(value))) {
      throw ctx.fail(400, '룰렛 운영 시간을 확인하세요', key);
    }
  }
  if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) {
    throw ctx.fail(400, '종료 시간은 시작 이후여야 합니다', 'endsAt');
  }
  const results = getRouletteResults(ctx.workspace);
  const oldPrizes = list(old.prizes);
  if (oldPrizes.length && results.length) {
    // Issued spins pin prize identity: result rows and reward entitlements
    // reference prize IDs, and tiers are positional, so removing, adding,
    // reordering, or renaming a prize would silently remap or orphan
    // someone's persisted result. Stock, weights, status, and schedule stay
    // editable; structure does not. Rows that never had a config (genuinely
    // legacy) skip this: oldPrizes is empty for them.
    const oldIds = oldPrizes.map((prize) => String(prize && prize.id));
    const newIds = prizes.map((prize) => prize.id);
    const removed = oldPrizes.find((prize) => !newIds.includes(String(prize && prize.id)));
    if (removed) {
      throw ctx.fail(409, `이미 추첨 결과가 있어 상품을 삭제할 수 없습니다: ${String(removed.label || '')}`);
    }
    const added = prizes.find((prize) => !oldIds.includes(prize.id));
    if (added) {
      throw ctx.fail(409, `이미 추첨 결과가 있어 상품을 추가할 수 없습니다: ${added.label}`);
    }
    if (newIds.some((prizeId, index) => prizeId !== oldIds[index])) {
      throw ctx.fail(409, '이미 추첨 결과가 있어 상품 순서를 변경할 수 없습니다');
    }
    const renamed = prizes.find((prize, index) => prize.label !== String(oldPrizes[index] && oldPrizes[index].label));
    if (renamed) {
      throw ctx.fail(409, '이미 추첨 결과가 있어 상품 이름을 변경할 수 없습니다');
    }
  }
  const used = rouletteUsedCounts(results);
  const selectable = prizes.some((prize) =>
    rouletteEffectiveWeight(prize, used.get(prize.id) || 0) > 0
  );
  if (status === 'OPEN' && !selectable) {
    throw ctx.fail(400, '운영하려면 추첨 가능한 상품이 1개 이상 필요합니다', 'prizes');
  }
  // Shrinking finite inventory below already-persisted results would
  // retroactively void someone's result, so it is refused instead of
  // silently applied. (Removal bypass of this rule is closed by the
  // structural freeze above.)
  for (const prize of prizes) {
    if (prize.quantity === null) continue;
    const usedCount = results.filter((item) => item && item.prizeId === prize.id).length;
    if (usedCount > prize.quantity) {
      throw ctx.fail(409, `이미 나온 결과(${usedCount}건)보다 적게 줄일 수 없습니다: ${prize.label}`);
    }
  }
  ctx.workspace.rouletteConfig = { prizes, status, startsAt, endsAt };
  const remaining = rouletteRemaining(ctx.workspace.rouletteConfig, results).map(({ prize, remaining: left }) => ({
    prizeId: prize.id,
    label: prize.label,
    quantity: prize.quantity,
    remaining: left,
  }));
  return { body: { rouletteConfig: { ...ctx.workspace.rouletteConfig }, remaining } };
}

function pickPrizeByRemaining(entries) {
  // Every entry carries its explicit effective weight (remaining-count
  // derivation or operator-configured policy). No invented shares: a prize
  // with no selectable weight never reaches this table.
  const total = entries.reduce((sum, entry) => sum + Math.max(0, entry.weight), 0);
  if (total <= 0) return null;
  let roll = crypto.randomInt(total);
  for (let index = 0; index < entries.length; index += 1) {
    roll -= Math.max(0, entries[index].weight);
    if (roll < 0) return entries[index];
  }
  return entries[entries.length - 1];
}

function spinRoulette(ctx) {
  requireFeature(ctx, 'draw');
  const person = ensureAttendee(ctx);
  const results = getRouletteResults(ctx.workspace);
  // A persisted result is replayed even after closing: closing stops new
  // spins, it never voids a result the participant already saw.
  const previous = results.find((item) => item && item.participantId === person.id);
  if (previous) {
    return {
      body: {
        roulette: {
          tier: previous.tier,
          label: previous.label,
          at: previous.at,
          ...(previous.rewardId ? { rewardId: previous.rewardId } : {}),
        },
      },
    };
  }
  const config = getRouletteConfig(ctx.workspace);
  if (!config) throw ctx.fail(409, rouletteStatus());
  if (config.status !== 'OPEN') throw ctx.fail(409, rouletteStatus());
  const nowMs = Date.parse(ctx.now);
  if (config.startsAt && nowMs < Date.parse(config.startsAt)) throw ctx.fail(409, rouletteStatus());
  if (config.endsAt && nowMs > Date.parse(config.endsAt)) throw ctx.fail(409, '룰렛 운영이 종료되었습니다');
  const used = rouletteUsedCounts(results);
  const entries = rouletteRemaining(config, results)
    .map(({ prize, remaining }) => ({
      prize,
      remaining,
      weight: rouletteEffectiveWeight(prize, used.get(prize.id) || 0),
    }))
    .filter((entry) => entry.weight > 0);
  if (!entries.length) throw ctx.fail(409, '경품이 모두 소진되었습니다. 운영자에게 문의하세요');
  const picked = pickPrizeByRemaining(entries);
  if (!picked) throw ctx.fail(409, '경품이 모두 소진되었습니다. 운영자에게 문의하세요');
  const tier = list(config.prizes).findIndex((prize) => prize && prize.id === picked.prize.id) + 1;
  // Every result mints its own reward entitlement (id = the spin receipt, so
  // a lost-response retry replays instead of minting a second one). Rewards
  // are ONSITE claims with no real-inventory code attached.
  const rewardId = `roulette-${ctx.commandId}`;
  if (!Array.isArray(ctx.workspace.rewards)) ctx.workspace.rewards = [];
  if (!ctx.workspace.rewards.some((item) => item && item.id === rewardId)) {
    ctx.workspace.rewards.push({
      id: rewardId,
      participantId: person.id,
      name: picked.prize.label,
      method: 'ONSITE',
      status: 'READY',
      at: ctx.now,
      code: '',
      claim: null,
      source: { kind: 'roulette', prizeId: picked.prize.id },
    });
  }
  const result = {
    participantId: person.id,
    prizeId: picked.prize.id,
    tier,
    label: picked.prize.label,
    rewardId,
    at: ctx.now,
  };
  results.push(result);
  ctx.workspace.rouletteResults = results;
  return { body: { roulette: { tier: result.tier, label: result.label, at: result.at, rewardId } } };
}

// ---------------------------------------------------------------------------
// Voting
// ---------------------------------------------------------------------------

function getTeams(workspace) {
  return Array.isArray(workspace.teams) ? workspace.teams : [];
}

function getVoteConfig(workspace) {
  const config = workspace.voteConfig;
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  return config;
}

function saveVoteConfig(ctx, input) {
  requireFeature(ctx, 'poll');
  const old = getVoteConfig(ctx.workspace) || {};
  const rawCount = input.pickCount === undefined || input.pickCount === null || input.pickCount === ''
    ? (old.pickCount ?? VOTE_PICK_DEFAULT)
    : Number(input.pickCount);
  if (!Number.isInteger(rawCount) || rawCount < VOTE_PICK_MIN || rawCount > VOTE_PICK_MAX) {
    throw ctx.fail(400, `선택 수를 ${VOTE_PICK_MIN}~${VOTE_PICK_MAX}로 입력하세요`, 'pickCount');
  }
  const status = clean(input.status, 16).toUpperCase() || old.status || 'CLOSED';
  if (!['OPEN', 'CLOSED'].includes(status)) {
    throw ctx.fail(400, '투표 상태를 선택하세요', 'status');
  }
  if (list(ctx.workspace.votes).length && rawCount !== (old.pickCount ?? VOTE_PICK_DEFAULT)) {
    throw ctx.fail(409, '투표가 시작되어 선택 수를 변경할 수 없습니다');
  }
  const resultsPublished = input.resultsPublished === undefined ? (old.resultsPublished === true) : input.resultsPublished === true;
  ctx.workspace.voteConfig = { pickCount: rawCount, status, resultsPublished };
  return { body: { voteConfig: { ...ctx.workspace.voteConfig } } };
}

function saveTeam(ctx, input) {
  requireFeature(ctx, 'poll');
  const id = clean(input.id || ctx.makeId('team'), 120);
  if (!id) throw ctx.fail(400, '팀을 확인하세요', 'id');
  const name = requireText(ctx, input.name, '팀 이름', 80, 'name');
  const order = input.order === undefined || input.order === null || input.order === ''
    ? getTeams(ctx.workspace).length + 1
    : Number(input.order);
  if (!Number.isInteger(order) || order < 0 || order > 1000) {
    throw ctx.fail(400, '팀 순서를 확인하세요', 'order');
  }
  if (list(ctx.workspace.votes).length) {
    throw ctx.fail(409, '투표가 시작되어 팀을 변경할 수 없습니다');
  }
  const teams = getTeams(ctx.workspace);
  if (teams.some((team) => team && team.id !== id && team.name === name)) {
    throw ctx.fail(400, '같은 이름의 팀이 있습니다', 'name');
  }
  const old = teams.find((team) => team && team.id === id);
  const team = { id, name, order };
  if (old) Object.assign(old, team);
  else teams.push(team);
  teams.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
  ctx.workspace.teams = teams;
  return { body: { team } };
}

// Votes are selections, never voter-assigned rankings: ranks 1..3 on the
// result board are decided by total selections. A rank may still ride along
// for compatibility, but it is never required and never decides the outcome.
function validateRankedVote(ctx, input, teams, exactCount) {
  const rawPicks = Array.isArray(input.picks) ? input.picks : [];
  const maxCount = exactCount === null ? LEGACY_MAX_VOTE_PICKS : exactCount;
  if (!rawPicks.length || rawPicks.length > maxCount) {
    throw ctx.fail(400, `투표는 1~${maxCount}팀을 선택해야 합니다`, 'picks');
  }
  if (exactCount !== null && rawPicks.length !== exactCount) {
    throw ctx.fail(400, `투표는 ${exactCount}팀을 선택해야 합니다`, 'picks');
  }
  const teamIds = new Set();
  const ranks = new Set();
  const picks = [];
  for (const raw of rawPicks) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const teamId = clean(source.teamId, 120);
    if (!teamId) throw ctx.fail(400, '팀을 선택하세요', 'picks');
    if (!teams.some((team) => team && team.id === teamId)) {
      throw ctx.fail(404, '존재하지 않는 팀입니다', 'picks');
    }
    if (teamIds.has(teamId)) throw ctx.fail(400, '중복된 팀을 선택할 수 없습니다', 'picks');
    teamIds.add(teamId);
    const pick = { teamId };
    if (source.rank !== undefined && source.rank !== null && source.rank !== '') {
      const rank = Number(source.rank);
      if (!Number.isInteger(rank) || rank < 1 || rank > MAX_VOTE_RANK) {
        throw ctx.fail(400, `순위는 1~${MAX_VOTE_RANK} 사이여야 합니다`, 'picks');
      }
      if (ranks.has(rank)) throw ctx.fail(400, '같은 순위는 한 번만 선택할 수 있습니다', 'picks');
      ranks.add(rank);
      pick.rank = rank;
    }
    picks.push(pick);
  }
  return picks;
}

function submitRankedVote(ctx, input) {
  requireFeature(ctx, 'poll');
  const person = ensureAttendee(ctx);
  const teams = getTeams(ctx.workspace);
  if (!teams.length) throw ctx.fail(409, '투표 대상이 없습니다');
  const votes = Array.isArray(ctx.workspace.votes) ? ctx.workspace.votes : [];
  if (votes.some((item) => item && item.participantId === person.id)) {
    throw ctx.fail(409, '이미 투표하셨습니다');
  }
  const config = getVoteConfig(ctx.workspace);
  if (config) {
    if (config.status !== 'OPEN') throw ctx.fail(409, '투표 기간이 아닙니다. 운영 안내를 확인하세요');
  }
  const exactCount = config ? config.pickCount : null;
  const picks = validateRankedVote(ctx, input, teams, exactCount);
  const vote = {
    id: ctx.commandId,
    participantId: person.id,
    picks,
    at: ctx.now,
  };
  votes.push(vote);
  ctx.workspace.votes = votes;
  return { status: 201, body: { vote: { id: vote.id, picks: vote.picks, at: vote.at } } };
}

function tallyVotes(teams, votes) {
  const counts = new Map();
  for (const vote of list(votes)) {
    if (!vote || !Array.isArray(vote.picks)) continue;
    for (const pick of vote.picks) {
      if (!pick || typeof pick.teamId !== 'string') continue;
      counts.set(pick.teamId, (counts.get(pick.teamId) || 0) + 1);
    }
  }
  const rows = list(teams)
    .filter((team) => team && typeof team.id === 'string')
    .map((team) => ({
      teamId: team.id,
      name: String(team.name || ''),
      order: Number(team.order) || 0,
      selections: counts.get(team.id) || 0,
    }))
    .sort((a, b) => b.selections - a.selections || a.order - b.order || (a.name < b.name ? -1 : 1));
  // Competition ranking with explicit ties: teams on equal selections share
  // one rank and are flagged, and the following rank skips. No silent
  // tie-break is ever invented — a tie stays visible as a tie.
  const results = [];
  let rank = 0;
  let previousSelections = null;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (previousSelections === null || row.selections !== previousSelections) {
      rank = index + 1;
      previousSelections = row.selections;
    }
    results.push({ ...row, rank });
  }
  const tiedSelections = new Set(
    results
      .map((row) => row.selections)
      .filter((selections, index, all) => all.indexOf(selections) !== index)
  );
  for (const row of results) row.tied = tiedSelections.has(row.selections);
  return {
    results,
    top3: results.filter((row) => row.rank <= 3),
    totalVotes: list(votes).length,
  };
}

function tallyVoteResults(ctx) {
  requireFeature(ctx, 'poll');
  const teams = getTeams(ctx.workspace);
  if (!teams.length) throw ctx.fail(409, '투표 대상이 없습니다');
  const tally = tallyVotes(teams, ctx.workspace.votes);
  const config = getVoteConfig(ctx.workspace);
  return { body: { ...tally, published: config ? config.resultsPublished === true : true } };
}

// ---------------------------------------------------------------------------
// Stage draw programs (PERSON and COMPANY/GROUP eligibility)
// ---------------------------------------------------------------------------

function getDrawPrograms(workspace) {
  return Array.isArray(workspace.drawPrograms) ? workspace.drawPrograms : [];
}

function cleanStringList(value, maxItems, maxLength) {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value)) return null;
  const items = [...new Set(value.map((item) => clean(item, maxLength)).filter(Boolean))];
  if (items.length > maxItems) return null;
  return items;
}

function saveDrawProgram(ctx, input) {
  requireFeature(ctx, 'draw');
  const id = clean(input.id || ctx.makeId('drawprog'), 120);
  if (!id) throw ctx.fail(400, '추첨 프로그램을 확인하세요', 'id');
  const status = clean(input.status, 16).toUpperCase() || undefined;
  if (status !== undefined && !['DRAFT', 'OPEN', 'CLOSED'].includes(status)) {
    throw ctx.fail(400, '프로그램 상태를 선택하세요', 'status');
  }
  const programs = getDrawPrograms(ctx.workspace);
  const old = programs.find((item) => item && item.id === id);
  const started = Boolean(old && old.winners && old.winners.length);
  // After the first draw the configuration is frozen, but operations are
  // not: the operator may close/reopen a partial program (status) and
  // explicitly publish/unpublish its results (published). Anything else must
  // be omitted or byte-identical, never silently rewritten.
  function unchanged(label, field, normalize) {
    if (input[field] === undefined) return old ? old[field] : undefined;
    const nextValue = normalize(input[field]);
    const same = JSON.stringify(nextValue) === JSON.stringify(old ? old[field] : undefined);
    if (started && !same) throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
    return nextValue;
  }
  // Existing slots (started or not) default omitted config fields to stored
  // values before validating: a status/publication-only save carries no
  // config. Explicit empty/invalid values still reject, and new slots still
  // require every field. Started slots additionally freeze any difference.
  const name = !old
    ? requireText(ctx, input.name, '추첨 이름', 80, 'name')
    : unchanged('추첨 이름', 'name', (value) => requireText(ctx, value, '추첨 이름', 80, 'name'));
  const quota = (() => {
    if (input.quota === undefined || input.quota === null || input.quota === '') {
      if (!old) throw ctx.fail(400, '당첨 인원을 1~10000명으로 입력하세요', 'quota');
      return old.quota;
    }
    const value = Number(input.quota);
    if (!Number.isInteger(value) || value < 1 || value > 10000) {
      throw ctx.fail(400, '당첨 인원을 1~10000명으로 입력하세요', 'quota');
    }
    if (started && value !== old.quota) throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
    return value;
  })();
  const moduleId = clean(input.moduleId, 120) || (old ? old.moduleId : '');
  if (!moduleId) throw ctx.fail(400, '추첨 프로그램을 선택하세요', 'moduleId');
  if (started && moduleId !== old.moduleId) throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
  const module = findModule(ctx, moduleId);
  if (module.type !== 'draw') throw ctx.fail(400, '추첨 프로그램을 선택하세요', 'moduleId');
  const eligibility = (() => {
    const value = clean(input.eligibility, 16).toUpperCase() || (old ? old.eligibility : 'PERSON');
    if (!['PERSON', 'COMPANY'].includes(value)) throw ctx.fail(400, '추첨 대상을 선택하세요', 'eligibility');
    if (started && value !== old.eligibility) throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
    return value;
  })();
  const eligibleGroups = input.eligibleGroups === undefined
    ? (old ? old.eligibleGroups || [] : [])
    : cleanStringList(input.eligibleGroups, 50, 80);
  if (eligibleGroups === null) throw ctx.fail(400, '대상 그룹을 50개 이하로 입력하세요', 'eligibleGroups');
  if (started && JSON.stringify(eligibleGroups) !== JSON.stringify(old.eligibleGroups || [])) {
    throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
  }
  const eligibleCompanies = input.eligibleCompanies === undefined
    ? (old ? old.eligibleCompanies || [] : [])
    : cleanStringList(input.eligibleCompanies, 200, 200);
  if (eligibleCompanies === null) throw ctx.fail(400, '대상 업체를 200개 이하로 입력하세요', 'eligibleCompanies');
  if (started && JSON.stringify(eligibleCompanies) !== JSON.stringify(old.eligibleCompanies || [])) {
    throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
  }
  const overlap = clean(input.overlap, 16).toUpperCase() || (old ? old.overlap : 'EVENT');
  // Overlap scope is explicit, never silent: EVENT excludes every winner of
  // every program, PROGRAM excludes only this program's own winners, NONE
  // excludes nobody (repeat wins stay possible).
  if (!['EVENT', 'PROGRAM', 'NONE'].includes(overlap)) {
    throw ctx.fail(400, '당첨 중복 범위를 선택하세요', 'overlap');
  }
  if (started && overlap !== (old.overlap || 'EVENT')) {
    throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
  }
  let prizeTiers = old ? old.prizeTiers || null : null;
  if (input.prizeTiers !== undefined) {
    if (input.prizeTiers === null) {
      prizeTiers = null;
    } else {
      if (!Array.isArray(input.prizeTiers) || !input.prizeTiers.length || input.prizeTiers.length > 20) {
        throw ctx.fail(400, '상품 등급을 1~20개로 입력하세요', 'prizeTiers');
      }
      prizeTiers = input.prizeTiers.map((raw) => {
        const source = object(raw);
        const tierName = clean(source.name, 80);
        if (!tierName) throw ctx.fail(400, '상품 등급 이름을 입력하세요', 'prizeTiers');
        const count = Number(source.count);
        if (!Number.isInteger(count) || count < 1 || count > 10000) {
          throw ctx.fail(400, '상품 등급별 인원을 1~10000명으로 입력하세요', 'prizeTiers');
        }
        return { name: tierName, count };
      });
      const tierTotal = prizeTiers.reduce((sum, tier) => sum + tier.count, 0);
      if (tierTotal !== quota) {
        throw ctx.fail(400, '상품 등급별 인원 합계가 당첨 인원과 같아야 합니다', 'prizeTiers');
      }
    }
    if (started && JSON.stringify(prizeTiers) !== JSON.stringify(old.prizeTiers || null)) {
      throw ctx.fail(409, '추첨이 시작되어 설정을 변경할 수 없습니다');
    }
  }
  const nextStatus = status || (old ? old.status : 'DRAFT');
  // Publication choice stickiness: an explicit published bool is recorded
  // (internal marker, never projected) and survives later status-only
  // saves, so closing/reopening cannot silently republish an unpublished
  // program. Slots without a recorded choice keep the legacy behavior of
  // deriving publication from status (DRAFT->OPEN auto-publishes).
  const explicitChoice = input.published != null;
  const nextPublished = explicitChoice
    ? input.published === true
    : (old && old.publishedExplicit === true ? old.published === true : nextStatus !== 'DRAFT');
  const next = {
    id,
    name,
    quota,
    moduleId,
    status: nextStatus,
    published: nextPublished,
    // Internal marker only: records that the operator chose publication
    // explicitly. The public projection allowlists program fields, so this
    // never crosses to attendees.
    ...(explicitChoice || (old && old.publishedExplicit === true) ? { publishedExplicit: true } : {}),
    eligibility,
    eligibleGroups,
    eligibleCompanies,
    overlap,
    prizeTiers,
    winners: old && Array.isArray(old.winners) ? old.winners : [],
    drawnAt: old ? old.drawnAt || null : null,
  };
  if (old) Object.assign(old, next);
  else programs.push(next);
  ctx.workspace.drawPrograms = programs;
  if (old) {
    // Publication is a property of the program slot, but the linked module's
    // history is the venue display surface: entries drawn under this program
    // follow its flag, or unpublishing here would still leak winners through
    // the module. Entries without this programId (legacy draws) are untouched.
    for (const entry of list(module.drawHistory)) {
      if (entry && entry.programId === old.id) entry.published = next.published;
    }
  }
  return { body: { program: { ...next } } };
}

function drawPool(ctx, program, programs, { forCompanyDraw = false } = {}) {
  const scope = program.overlap || 'EVENT';
  const excludedIds = new Set();
  const excludedCompanies = new Set();
  // EVENT excludes every winner event-wide: people by id from all program
  // slots, companies by name but only from COMPANY-mode slots, plus
  // identifiable people from pre-existing legacy stage draws (module history
  // entries WITHOUT a programId — program entries are already covered via
  // the slots, and counting them twice would double their semantics).
  // PROGRAM excludes only this program's own winners. NONE excludes nobody
  // (repeat wins stay possible — an explicit operator policy).
  // A company award never disqualifies every employee from PERSON draws:
  // company exclusion applies to COMPANY-mode pools only (typed winner
  // identity, no invented representative).
  const scoped = scope === 'EVENT'
    ? list(programs)
    : scope === 'PROGRAM'
      ? [program]
      : [];
  for (const other of scoped) {
    if (!other) continue;
    for (const winner of list(other.winners)) {
      if (!winner) continue;
      if (winner.id) excludedIds.add(String(winner.id));
      if (other.eligibility === 'COMPANY' && winner.company) {
        excludedCompanies.add(String(winner.company));
      }
    }
  }
  if (scope === 'EVENT') {
    for (const module of list(ctx.workspace.modules)) {
      if (!module || module.type !== 'draw') continue;
      for (const entry of list(module.drawHistory)) {
        if (!entry || entry.programId) continue;
        for (const winner of list(entry.winners)) {
          if (winner && winner.id) excludedIds.add(String(winner.id));
        }
      }
    }
  }
  return list(ctx.workspace.participants).filter((person) => {
    if (!person || person.status !== 'APPROVED' || person.revoked === true || person.everIn !== true) return false;
    if (!['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase())) return false;
    if (excludedIds.has(String(person.id))) return false;
    if (forCompanyDraw && person.company && excludedCompanies.has(String(person.company))) return false;
    if (program.eligibleGroups && program.eligibleGroups.length &&
        !program.eligibleGroups.includes(String(person.group || ''))) return false;
    if (program.eligibleCompanies && program.eligibleCompanies.length &&
        !program.eligibleCompanies.includes(String(person.company || ''))) return false;
    return true;
  });
}

function tierForWinner(program, winnerIndex) {
  const tiers = list(program.prizeTiers);
  if (!tiers.length) return null;
  let cursor = 0;
  for (const tier of tiers) {
    cursor += Number(tier.count) || 0;
    if (winnerIndex < cursor) return String(tier.name || '');
  }
  return String((tiers[tiers.length - 1] && tiers[tiers.length - 1].name) || '');
}

function mintDrawReward(ctx, program, person, tierName, winnerIndex) {
  if (!Array.isArray(ctx.workspace.rewards)) ctx.workspace.rewards = [];
  // One entitlement per WIN OCCURRENCE, keyed by winner ordinal: overlap NONE
  // lets the same person win again, and each win carries its own tier. A
  // lost-response retry replays the stored receipt before apply, so the same
  // command never mints twice.
  const id = `drawreward-${program.id}-p${winnerIndex}-${person.id}`;
  const existing = ctx.workspace.rewards.find((item) => item && item.id === id);
  if (existing) return existing;
  const reward = {
    id,
    participantId: person.id,
    name: tierName || program.name,
    method: 'ONSITE',
    status: 'READY',
    at: ctx.now,
    code: '',
    claim: null,
    source: { kind: 'draw', programId: program.id, winnerIndex, ...(tierName ? { tier: tierName } : {}) },
  };
  ctx.workspace.rewards.push(reward);
  return reward;
}

async function runDrawProgram(ctx, input) {
  requireFeature(ctx, 'draw');
  const id = clean(input.id, 120);
  if (!id) throw ctx.fail(400, '추첨 프로그램을 선택하세요', 'id');
  const programs = getDrawPrograms(ctx.workspace);
  const program = programs.find((item) => item && item.id === id);
  if (!program) throw ctx.fail(404, '추첨 프로그램을 찾을 수 없습니다');
  if (program.status !== 'OPEN' || program.published !== true) {
    throw ctx.fail(409, '진행 중인 추첨 프로그램을 선택하세요');
  }
  const module = findModule(ctx, program.moduleId);
  if (module.type !== 'draw') throw ctx.fail(400, '추첨 프로그램을 확인하세요');
  const winners = Array.isArray(program.winners) ? program.winners : [];
  if (winners.length >= program.quota) {
    throw ctx.fail(409, '이미 추첨이 완료된 프로그램입니다');
  }
  const remaining = program.quota - winners.length;
  // Sequential stage touches pass count 1; omitting count keeps the legacy
  // batched behavior (up to 20). An explicit count is validated 1..20 and
  // capped at the remaining quota so a run can never overdraw.
  let count = Math.min(remaining, DRAW_RUN_BATCH);
  if (input.count !== undefined && input.count !== null && input.count !== '') {
    const requested = Number(input.count);
    if (!Number.isInteger(requested) || requested < 1 || requested > DRAW_RUN_BATCH) {
      throw ctx.fail(400, `추첨 인원을 1~${DRAW_RUN_BATCH}명으로 입력하세요`, 'count');
    }
    count = Math.min(remaining, requested);
  }
  const drawn = [];
  let poolSize = 0;
  if ((program.eligibility || 'PERSON') === 'COMPANY') {
    const pool = drawPool(ctx, program, programs, { forCompanyDraw: true })
      .filter((person) => String(person.company || ''));
    const byCompany = new Map();
    for (const person of pool) {
      const company = String(person.company);
      if (!byCompany.has(company)) byCompany.set(company, []);
      byCompany.get(company).push(person);
    }
    const companies = [...byCompany.keys()];
    poolSize = companies.length;
    if (companies.length < count) throw ctx.fail(409, '추첨 대상 업체가 부족합니다');
    while (drawn.length < count) {
      const index = crypto.randomInt(companies.length);
      const [company] = companies.splice(index, 1);
      const members = byCompany.get(company);
      // The company wins as a unit, but imported data never says who may
      // collect for it — so no representative is invented. The entitlement
      // stays pending until the operator assigns an explicit recipient
      // (reward.assign); until then it is not fulfillable by anyone.
      const tierName = tierForWinner(program, winners.length + drawn.length);
      const winnerIndex = winners.length + drawn.length;
      if (!Array.isArray(ctx.workspace.rewards)) ctx.workspace.rewards = [];
      const rewardId = `drawreward-${program.id}-c${winnerIndex}`;
      if (!ctx.workspace.rewards.some((item) => item && item.id === rewardId)) {
        ctx.workspace.rewards.push({
          id: rewardId,
          participantId: null,
          company,
          name: tierName || program.name,
          method: 'ONSITE',
          status: 'PENDING',
          at: ctx.now,
          code: '',
          claim: null,
          source: { kind: 'draw', programId: program.id, winnerIndex, ...(tierName ? { tier: tierName } : {}) },
        });
      }
      drawn.push({
        // The winning unit's public name is the company itself — an explicit
        // safe display value, never an invented representative identity.
        // No participant id is attached (see reward.assign for the explicit
        // recipient path). kind marks eligibility for stage reference.
        company,
        name: company,
        memberCount: members.length,
        kind: 'COMPANY',
        ...(tierName ? { tier: tierName } : {}),
      });
    }
  } else {
    const pool = drawPool(ctx, program, programs);
    poolSize = pool.length;
    if (pool.length < count) throw ctx.fail(409, '미당첨 입장 참가자가 부족합니다');
    const luckyByPerson = new Map(
      getLuckyNumbers(ctx.workspace)
        .filter((item) => item && Number.isInteger(item.number))
        .map((item) => [String(item.participantId), item.number])
    );
    while (drawn.length < count) {
      const index = crypto.randomInt(pool.length);
      const [person] = pool.splice(index, 1);
      const winnerIndex = winners.length + drawn.length;
      const tierName = tierForWinner(program, winnerIndex);
      mintDrawReward(ctx, program, person, tierName, winnerIndex);
      drawn.push({
        id: person.id,
        name: String(person.name || ''),
        company: String(person.company || ''),
        kind: 'PERSON',
        // The winner's drawn lucky number is stage-called public data once
        // published; null when none was ever issued. Never a ticket/phone/id
        // beyond the internal winner link (stripped in projections).
        luckyNumber: luckyByPerson.has(String(person.id)) ? luckyByPerson.get(String(person.id)) : null,
        ...(tierName ? { tier: tierName } : {}),
      });
    }
  }
  winners.push(...drawn);
  program.winners = winners;
  if (winners.length >= program.quota) {
    program.status = 'CLOSED';
    program.drawnAt = ctx.now;
  }
  ctx.workspace.drawPrograms = programs;
  // Mirror into the linked draw module's history as published, so the venue
  // display (display.set type draw) and the existing draw UI show the same
  // result without a second publish step. The program slot stays the owner
  // of quota and duplicate exclusion; the module is the display surface.
  if (!Array.isArray(module.drawHistory)) module.drawHistory = [];
  module.drawHistory.unshift({
    id: ctx.commandId,
    programId: program.id,
    programName: program.name,
    winners: drawn.map((winner) => ({ ...winner })),
    at: ctx.now,
    poolCount: poolSize,
    published: true,
  });
  // Opt-in stage touch (showOnScreen === true only): select the venue
  // display in the SAME transaction and receipt. Reuses display.set
  // validation verbatim (screen feature, published draw module holding a
  // published result — ours was just mirrored), so a missing screen setup
  // rolls winners, rewards, history, and display back together. No
  // module/program flags are auto-published by this path.
  let display = null;
  if (input.showOnScreen === true) {
    const displayResult = await engagement.apply({
      ...ctx,
      command: 'display.set',
      input: { type: 'draw', moduleId: module.id },
    });
    display = displayResult.body.display;
  }
  return {
    body: {
      winners: drawn,
      program: { ...program },
      remaining: program.quota - winners.length,
      ...(display ? { display } : {}),
    },
  };
}

async function apply(ctx) {
  switch (ctx.command) {
    case 'lucky.assign': return assignLuckyNumber(ctx);
    case 'lucky.config.save': return saveLuckyConfig(ctx, ctx.input);
    case 'lucky.preassign': return preassignLuckyNumbers(ctx, ctx.input);
    case 'roulette.spin': return spinRoulette(ctx);
    case 'roulette.config.save': return saveRouletteConfig(ctx, ctx.input);
    case 'vote.ranked': return submitRankedVote(ctx, ctx.input);
    case 'vote.config.save': return saveVoteConfig(ctx, ctx.input);
    case 'vote.tally': return tallyVoteResults(ctx);
    case 'team.save': return saveTeam(ctx, ctx.input);
    case 'draw.program.save': return saveDrawProgram(ctx, ctx.input);
    case 'draw.program.run': return runDrawProgram(ctx, ctx.input);
    default: throw ctx.fail(400, '지원하지 않는 참가자 경험 작업입니다', 'command');
  }
}

module.exports = { COMMANDS, GUEST_COMMANDS, apply, tallyVotes };
