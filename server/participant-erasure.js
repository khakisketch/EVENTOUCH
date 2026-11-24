'use strict';

// Pure helpers for the participant.erase command (server/commands/participants.js).
//
// Erasure anonymizes one participant in place. The row stays (ids, status,
// check-in rows, votes, rewards and counts keep their meaning); every personal
// value on it and every copy of that value in other records is removed.
// Nothing here touches files: stored bytes are never deleted (see
// docs/ARCHITECTURE.md, retention), so a participant-uploaded photo is hidden
// instead and its bytes stay until the separate purge procedure.

const ERASED_NAME = '삭제된 참가자';
const ERASED_TEXT = '삭제된 내용입니다';

// Participant keys that carry no personal data and keep the record working
// (counts, ticket state, consent evidence). Every other key is dropped, so an
// unknown imported column can never survive an erasure.
const KEPT_PARTICIPANT_KEYS = new Set([
  'id', 'group', 'status', 'registrationType', 'inside', 'everIn', 'revoked', 'cancelled',
  'ticket', 'ticketExpiresAt', 'ticketRevision', 'ticketNeedsExplicitReissue',
  'paymentStatus', 'createdAt', 'consent',
]);

// Keys that copy a person's identity into another record.
const IDENTITY_KEYS = ['name', 'phone', 'email', 'company', 'recipientName', 'participantName', 'recipientPhone', 'to'];

function list(value) {
  return Array.isArray(value) ? value : [];
}

function plain(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function blankIdentity(row) {
  let changed = false;
  for (const key of IDENTITY_KEYS) {
    if (typeof row[key] === 'string' && row[key] !== '') {
      row[key] = '';
      changed = true;
    }
  }
  return changed;
}

function anonymizeParticipant(person, at) {
  for (const key of Object.keys(person)) {
    if (!KEPT_PARTICIPANT_KEYS.has(key)) delete person[key];
  }
  person.name = ERASED_NAME;
  person.phone = '';
  person.email = '';
  person.company = '';
  person.answers = {};
  person.erased = true;
  person.erasedAt = at;
}

// Replace a former name inside free text that is tied to the participant (an
// audit detail such as "홍길동 · 사유"). Short names are not substituted: they
// would match unrelated text, and such entries are blanked by the caller.
function withoutName(value, name) {
  if (typeof value !== 'string' || !name || name.length < 2) return value;
  return value.split(name).join(ERASED_NAME);
}

// Removes every copy of the participant's personal data from the workspace
// (never the participant row itself). Returns counts per area for the audit
// response; counts are numbers only, never values.
function eraseWorkspaceCopies(workspace, participantId, formerName) {
  const pid = String(participantId);
  const counts = { checks: 0, visits: 0, responses: 0, questions: 0, photos: 0, posts: 0, messages: 0, winners: 0, audit: 0 };
  const mine = (row) => row && typeof row === 'object' && String(row.participantId) === pid;

  for (const row of list(workspace.checks)) {
    if (mine(row) && blankIdentity(row)) counts.checks += 1;
  }
  for (const row of list(workspace.visits)) {
    if (mine(row) && blankIdentity(row)) counts.visits += 1;
  }
  for (const row of list(workspace.responses)) {
    if (!mine(row)) continue;
    // Choices, scores and quiz answers stay as aggregate data; free text goes.
    const had = row.comment !== undefined && row.comment !== '';
    if (had) row.comment = '';
    if (blankIdentity(row) || had) counts.responses += 1;
  }
  for (const row of list(workspace.questions)) {
    if (!mine(row)) continue;
    blankIdentity(row);
    row.text = ERASED_TEXT;
    row.approved = false;
    delete row.pendingEdit;
    delete row.editRejection;
    counts.questions += 1;
  }
  for (const row of list(workspace.photos)) {
    if (!mine(row)) continue;
    blankIdentity(row);
    row.caption = ERASED_TEXT;
    row.status = 'HIDDEN';
    counts.photos += 1;
  }
  for (const row of list(workspace.posts)) {
    if (!mine(row)) continue;
    blankIdentity(row);
    row.body = ERASED_TEXT;
    row.status = 'HIDDEN';
    counts.posts += 1;
  }
  for (const message of list(workspace.messages)) {
    if (!message || typeof message !== 'object') continue;
    let touched = false;
    for (const key of ['recipientSnapshot', 'recipients']) {
      for (const row of list(message[key])) {
        if (row && typeof row === 'object' && String(row.id) === pid && blankIdentity(row)) touched = true;
      }
    }
    for (const row of list(message.deliveries)) {
      if (mine(row) && blankIdentity(row)) touched = true;
    }
    if (touched) counts.messages += 1;
  }
  const eraseWinner = (winner) => {
    if (!winner || typeof winner !== 'object') return;
    if (String(winner.id) !== pid && String(winner.recipientId) !== pid) return;
    if (blankIdentity(winner)) counts.winners += 1;
  };
  for (const program of list(workspace.drawPrograms)) list(program && program.winners).forEach(eraseWinner);
  for (const module of list(workspace.modules)) {
    for (const entry of list(module && module.drawHistory)) list(entry && entry.winners).forEach(eraseWinner);
  }
  for (const entry of list(workspace.audit)) {
    if (!entry || typeof entry !== 'object') continue;
    let touched = false;
    for (const key of Object.keys(entry)) {
      const nested = plain(entry[key]);
      if (nested && String(nested.participantId) === pid) {
        if (blankIdentity(nested)) touched = true;
      }
    }
    if (String(entry.participantId) === pid && blankIdentity(entry)) touched = true;
    if (touched) {
      // The detail line may quote the name ("홍길동 · 사유").
      if (formerName && typeof entry.detail === 'string') {
        const next = withoutName(entry.detail, formerName);
        entry.detail = next === entry.detail && entry.detail.includes(formerName) ? '' : next;
      }
      counts.audit += 1;
    }
  }
  return counts;
}

// Receipts keep the original response so a lost-response retry can replay it.
// For an erased participant the replayed copy must not carry personal values:
// walk the saved JSON and blank every record that names this participant.
// Returns the number of records changed (0 means the receipt is untouched).
function redactReceiptResult(result, participantId) {
  const pid = String(participantId);
  let changed = 0;
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    const row = plain(value);
    if (!row) return;
    // A reward entitlement points at the participant but its `name` is the prize.
    if ((String(row.id) === pid || String(row.participantId) === pid) && !Object.hasOwn(row, 'claim')) {
      let touched = blankIdentity(row);
      if (row.answers && typeof row.answers === 'object' && Object.keys(row.answers).length) {
        row.answers = {};
        touched = true;
      }
      if (typeof row.comment === 'string' && row.comment) {
        row.comment = '';
        touched = true;
      }
      if (touched) changed += 1;
    }
    Object.values(row).forEach(walk);
  };
  walk(result);
  return changed;
}

module.exports = {
  ERASED_NAME,
  ERASED_TEXT,
  anonymizeParticipant,
  eraseWorkspaceCopies,
  redactReceiptResult,
};
