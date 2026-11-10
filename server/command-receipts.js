'use strict';

// A receipt proves that a transaction committed. It does not prove a message
// was delivered, or that a missing receipt will never appear. Never return
// the stored response: it can contain personal data or newly issued tokens.
const { hashTicket } = require('./commands/shared.ts');
const { resolveActorOrg, resolveEventAuthority } = require('./tenancy');
const { managerWriteAllowed } = require('./event-permissions');
const { ticketReviewState } = require('./ticket-lifetime');

const ORG_COMMANDS = new Set(['event.create', 'event.duplicate', 'client.save', 'org.permissions.save', 'member.assign', 'invitation.create', 'account.password-reset']);
const UNKNOWN = Object.freeze({ status: 'UNCONFIRMED' });

function invalid(status, message) {
  return Object.assign(new Error(message), { status });
}

function checkId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(value)) {
    throw invalid(400, '요청 식별자를 확인하세요');
  }
  return value;
}

function activeParticipant(workspace, token) {
  if (!token || token.length > 2048) return null;
  const people = Array.isArray(workspace?.participants) ? workspace.participants : [];
  return people.find(person => person && person.ticket === token && person.revoked !== true && person.cancelled !== true &&
    String(person.status || '').toUpperCase() === 'APPROVED' &&
    ['FREE', 'PAID'].includes(String(person.paymentStatus || '').toUpperCase()) &&
    Number.isFinite(Date.parse(person.ticketExpiresAt)) && Date.parse(person.ticketExpiresAt) > Date.now()) || null;
}

async function getReceipt(client, id) {
  const result = await client.query(
    'SELECT event_id, actor_id, org_id, result FROM command_receipts WHERE command_id = $1 LIMIT 1', [id]
  );
  return result.rows[0] || null;
}

function verdict(receipt, { eventId, orgId, actorId, participant, token, organizationOnly = false }) {
  if (!receipt || String(receipt.org_id || '') !== String(orgId || '') ||
      (eventId !== undefined && String(receipt.event_id || '') !== String(eventId))) return UNKNOWN;
  const saved = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
  const command = typeof saved.command === 'string' ? saved.command : saved.operation;
  if (typeof command !== 'string' || !command || (organizationOnly && !ORG_COMMANDS.has(command))) return UNKNOWN;
  if (participant) {
    if (receipt.actor_id !== null || saved.ticketHash !== hashTicket(token) ||
        // The operations executor's guest booth receipts have always kept
        // the ticket hash but leave participantId null. The active ticket
        // lookup above binds that hash to the same participant and event.
        (saved.participantId == null ? command !== 'booth.visit' : String(saved.participantId) !== String(participant.id))) return UNKNOWN;
  } else if (String(receipt.actor_id || '') !== String(actorId || '') || saved.ticketHash) return UNKNOWN;
  return { status: 'APPLIED', command };
}

async function eventReceipt(database, { account, eventId, commandId, ticketToken, ticketReissueView = false, cancellationReviewView = false }) {
  const id = checkId(commandId);
  return database.transaction(async client => {
    if (ticketToken) {
      const event = await client.query(
        'SELECT e.org_id, w.payload FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1 LIMIT 1',
        [eventId]
      );
      const row = event.rows[0];
      const participant = row && activeParticipant(row.payload, ticketToken);
      if (!participant) throw invalid(404, '티켓 링크를 확인할 수 없습니다');
      return verdict(await getReceipt(client, id), { eventId, orgId: row.org_id, participant, token: ticketToken });
    }

    const org = await resolveEventAuthority(client, account, eventId, { requireHeaders: false });
    let mayRecoverTicket = org.role === 'AGENCY';
    if (org.role === 'MANAGER') {
      const membership = await client.query('SELECT write_permissions FROM memberships WHERE account_id=$1 AND event_id=$2 LIMIT 1 FOR SHARE', [account.id, eventId]);
      if (!membership.rowCount) throw invalid(403, '권한을 확인하세요');
      mayRecoverTicket = managerWriteAllowed(membership.rows[0].write_permissions, 'ticket.reissue-reviewed');
    } else if (org.role === 'STAFF') {
      const assignment = await client.query(
        'SELECT 1 FROM staff_assignments WHERE account_id=$1 AND event_id=$2 AND active=true LIMIT 1', [account.id, eventId]
      );
      if (!assignment.rowCount) throw invalid(403, '권한을 확인하세요');
    } else if (org.role !== 'AGENCY') throw invalid(403, '권한을 확인하세요');
    const receipt = await getReceipt(client, id);
    const result = verdict(receipt, { eventId, orgId: org.orgId, actorId: account.id });
    if (cancellationReviewView && mayRecoverTicket && result.status === 'APPLIED' && result.command === 'participant.resolve-cancellation-conflict') {
      const saved = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
      const review = saved.response && typeof saved.response === 'object' ? saved.response.review : null;
      const participantId = review && typeof review.participantId === 'string' ? review.participantId : '';
      if (!participantId || review.resolutionId !== id || review.ticketRevoked !== true ||
          typeof review.reviewedName !== 'string' || !review.reviewedName || typeof review.reviewedCompany !== 'string' ||
          typeof review.reviewedMaskedPhone !== 'string' || !/^\d{3}-\*{4}-\d{4}$/.test(review.reviewedMaskedPhone) ||
          typeof saved.conflictReviewProof !== 'string' || !/^[a-f0-9]{64}$/.test(saved.conflictReviewProof)) return result;
      const current = await client.query('SELECT w.payload FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1 AND e.org_id=$2 LIMIT 1', [eventId, org.orgId]);
      const people = Array.isArray(current.rows[0]?.payload?.participants) ? current.rows[0].payload.participants.filter(person => person && person.id === participantId) : [];
      if (people.length !== 1 || typeof people[0].name !== 'string' || !people[0].name.trim()) return result;
      const person = people[0], digits = typeof person.phone === 'string' ? person.phone.replace(/\D/g, '') : '';
      return { ...result, cancellationReview: { participantId, name: person.name.trim().slice(0, 100),
        reviewedName: review.reviewedName, reviewedCompany: review.reviewedCompany, reviewedMaskedPhone: review.reviewedMaskedPhone,
        company: typeof person.company === 'string' ? person.company.trim().slice(0, 100) : '',
        maskedPhone: digits.length >= 9 && digits.length <= 15 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : '',
        currentStatus: typeof person.status === 'string' ? person.status : '', currentTicketReview: ticketReviewState(person) } };
    }
    if (!ticketReissueView || !mayRecoverTicket || result.status !== 'APPLIED' || result.command !== 'ticket.reissue-reviewed') return result;
    // This opt-in projection is derived from an actor-owned receipt and the
    // current event, not the stored response. It never returns bearer links,
    // original contact details, or the full original request.
    const saved = receipt.result && typeof receipt.result === 'object' ? receipt.result : {};
    const original = saved.response && typeof saved.response === 'object' ? saved.response : {};
    const participantId = original.participant && typeof original.participant.id === 'string' ? original.participant.id : '';
    const revision = original.ticketRevision;
    if (!participantId || !Number.isSafeInteger(revision) || revision < 1 ||
        !Array.isArray(saved.participantIds) || saved.participantIds.length !== 1 || saved.participantIds[0] !== participantId ||
        typeof saved.issuedTicketHashes?.[participantId] !== 'string' || !/^[a-f0-9]{64}$/.test(saved.issuedTicketHashes[participantId])) return result;
    const event = await client.query('SELECT e.slug,w.payload FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1 AND e.org_id=$2 LIMIT 1', [eventId, org.orgId]);
    const row = event.rows[0];
    const people = Array.isArray(row?.payload?.participants) ? row.payload.participants.filter(person => person && person.id === participantId) : [];
    if (people.length !== 1 || typeof row?.slug !== 'string' || !row.slug || typeof people[0].name !== 'string' || !people[0].name.trim()) return result;
    const person = people[0], digits = typeof person.phone === 'string' ? person.phone.replace(/\D/g, '') : '';
    return { ...result, ticketReissue: {
      participantId,
      name: person.name.trim().slice(0, 100),
      company: typeof person.company === 'string' ? person.company.trim().slice(0, 100) : '',
      maskedPhone: digits.length >= 9 && digits.length <= 15 ? `${digits.slice(0, 3)}-****-${digits.slice(-4)}` : '',
      eventSlug: row.slug,
      expectedTicketRevision: revision - 1,
    } };
  });
}

async function organizationReceipt(database, { account, commandId }) {
  const id = checkId(commandId);
  return database.transaction(async client => {
    const active = await client.query('SELECT 1 FROM accounts WHERE id=$1 AND active=true LIMIT 1', [account.id]);
    if (!active.rowCount) throw invalid(401, '로그인이 필요합니다');
    const org = await resolveActorOrg(client, account, { requireHeaders: false });
    if (org.role !== 'AGENCY') throw invalid(403, '권한을 확인하세요');
    return verdict(await getReceipt(client, id), { orgId: org.orgId, actorId: account.id, organizationOnly: true });
  });
}

module.exports = { eventReceipt, organizationReceipt };
