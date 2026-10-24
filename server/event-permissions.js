'use strict';

// Event-scoped manager write permissions: the single authority that maps an
// operator command to the membership grant it requires.
//
// Stored meaning (set only through POST /api/events/:id/members, validated
// against EVENT_PERMISSIONS in server/state.js, projected to the console via
// bootstrap memberships as `write: [...]`):
//   - 'all' grants every event write.
//   - any other entry grants exactly the command family listed under that key
//     in COMMAND_WRITE_SCOPE below. An explicitly stored empty array grants
//     no writes. Creation paths that name no scope default to full access
//     instead: invitation acceptance (server/auth.js) and an omitted `write`
//     in assignMember store ['all'], preserving the pre-allow-list behaviour.
//   - anything else (unknown command, unknown key) is denied. This is the
//     conservative allow-list: a grant that is not listed is not a grant.
//
// Deliberate non-goals, kept membership-gated rather than key-gated:
//   - reads (bootstrap projection, file.read, participants.read) and
//     file.upload stay on membership existence. An upload alone mutates no
//     event state; the command that references the file (booth.map.save,
//     attendee.page.save, message.create, ...) is key-gated, and every upload
//     is actor-bound in command_receipts. There is no 'files' key in the
//     vocabulary, so inventing one here would strand legitimate flows.
//   - guest commands (ticket-bearer writes) never consult memberships.
//   - AGENCY bypasses everything; STAFF keeps its assignment allow-list.
//
// Scope rationale (one key per command, documented because the 8 keys do not
// map 1:1 to console pages):
//   - 'participants' covers the roster and its intake surface: participant.*,
//     ticket.reissue, group.*, and the registration schema (field.*, form.*).
//     The settings screen's form.publish toggle therefore needs this key.
//   - 'page' covers what an attendee sees: attendee.page.*, branding, and the
//     content screen's notices/venue (they render on the attendee page).
//   - 'programs' covers staged engagement: program.*, module.*, moderation
//     (question/photo/post), draw.*, display.set, and the draws screen's
//     config commands (team, vote, lucky, roulette, draw.program).
//   - 'onsite' covers desk work: desk.*, staff assign/unassign, check.*,
//     and desk-side reward lookup/collect.
//   - 'booth' covers booths and the stamp map: booth.save/mode/visit and
//     booth.map.*.
//   - 'messages' covers outbound messaging and its templates plus the
//     participant-money commands that ride the same executor (payment.*).
//   - 'results' covers recorded outcomes: report.*, reward lifecycle
//     (create/assign/fulfill/cancel), and evidence photos. reward.create is
//     sent from the participant row, so a participants-scoped manager cannot
//     register rewards; that stays denied until granted here.
//   - 'settings' covers event identity and lifecycle: event.update/features/
//     stage. A settings-scoped manager still needs 'participants' for the
//     form.publish toggle above.

const EVENT_PERMISSIONS = new Set([
  'all',
  'participants',
  'page',
  'programs',
  'onsite',
  'booth',
  'messages',
  'results',
  'settings',
]);

const COMMAND_WRITE_SCOPE = {
  // participants: roster + intake
  'participant.create': 'participants',
  'participant.update': 'participants',
  'participant.status': 'participants',
  'participant.import': 'participants',
  'ticket.reissue': 'participants',
  'group.save': 'participants',
  'group.assign': 'participants',
  'field.save': 'participants',
  'field.move': 'participants',
  'field.delete': 'participants',
  'form.publish': 'participants',
  'form.close': 'participants',
  // settings: event identity + lifecycle
  'event.update': 'settings',
  'event.features': 'settings',
  'event.stage': 'settings',
  // page: attendee-visible surface
  'attendee.page.save': 'page',
  'attendee.page.publish': 'page',
  'branding.save': 'page',
  'notice.save': 'page',
  'notice.delete': 'page',
  'venue.save': 'page',
  // programs: staged engagement
  'program.save': 'programs',
  'program.delete': 'programs',
  'module.save': 'programs',
  'module.status': 'programs',
  'module.reveal': 'programs',
  'question.manage': 'programs',
  'photo.moderate': 'programs',
  'post.moderate': 'programs',
  'draw.run': 'programs',
  'draw.publish': 'programs',
  'display.set': 'programs',
  'team.save': 'programs',
  'vote.config.save': 'programs',
  'vote.tally': 'programs',
  'lucky.config.save': 'programs',
  'lucky.preassign': 'programs',
  'roulette.config.save': 'programs',
  'draw.program.save': 'programs',
  'draw.program.run': 'programs',
  // onsite: desk work
  'desk.save': 'onsite',
  'desk.set-open': 'onsite',
  'staff.assign': 'onsite',
  'staff.unassign': 'onsite',
  'check.scan': 'onsite',
  'check.correct': 'onsite',
  'reward.lookup': 'onsite',
  'reward.collect': 'onsite',
  // booth: booths + stamp map
  'booth.save': 'booth',
  'booth.mode': 'booth',
  'booth.visit': 'booth',
  'booth.map.save': 'booth',
  'booth.map.publish': 'booth',
  'booth.map.unpublish': 'booth',
  // messages: outbound messaging + template + payments on the same executor
  'message.create': 'messages',
  'message.cancel': 'messages',
  'message.retry': 'messages',
  'message.sync': 'messages',
  'template.save': 'messages',
  'payment.simulate': 'messages',
  'payment.refund-request': 'messages',
  'payment.refund': 'messages',
  // results: recorded outcomes
  'report.create': 'results',
  'report.update': 'results',
  'report.publish': 'results',
  'report.successor': 'results',
  'reward.create': 'results',
  'reward.assign': 'results',
  'reward.fulfill': 'results',
  'reward.cancel': 'results',
  'evidence.photo.add': 'results',
  'evidence.photo.move': 'results',
  'evidence.photo.remove': 'results',
  // Compatibility alias: the command dispatcher historically authorized the
  // whole participant executor as 'participants.write'. Callers that still
  // pass the alias get the participants scope; the executors always
  // re-check the real command, so the alias can never widen a grant.
  'participants.write': 'participants',
};

// Commands that stay membership-gated (no write scope): reads plus the
// actor-bound file staging area described above.
const MEMBERSHIP_ONLY_COMMANDS = new Set([
  'assignment.read',
  'participants.read',
  'file.read',
  'file.upload',
]);

function writeScopeForCommand(command) {
  return Object.hasOwn(COMMAND_WRITE_SCOPE, String(command || ''))
    ? COMMAND_WRITE_SCOPE[String(command)]
    : null;
}

function normalizeWriteGrants(write) {
  return Array.isArray(write) ? write.map((value) => String(value)) : [];
}

function managerWriteAllowed(write, command) {
  const grants = normalizeWriteGrants(write);
  if (grants.includes('all')) return true;
  const scope = writeScopeForCommand(command);
  if (!scope) return false;
  return grants.includes(scope);
}

function membershipOnlyCommand(command) {
  return MEMBERSHIP_ONLY_COMMANDS.has(String(command || ''));
}

module.exports = {
  EVENT_PERMISSIONS,
  COMMAND_WRITE_SCOPE,
  MEMBERSHIP_ONLY_COMMANDS,
  writeScopeForCommand,
  managerWriteAllowed,
  membershipOnlyCommand,
};
