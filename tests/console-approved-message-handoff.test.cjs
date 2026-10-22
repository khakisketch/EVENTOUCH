'use strict';

// Bulk-approval -> message follow-up (candidate 6). The approval success
// copy stays, and only a proven approval offers the follow-up link with
// exactly the approved ids plus an explicit approved filter. Messaging
// reuses its existing handoff selection; the status param only names the
// filter. Source-only wiring plus behavioral checks of the real helper.

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const LIST = 'app/console/events/[id]/participants/ParticipantList.tsx';
const MESSAGES = 'app/console/events/[id]/messages/MessagingWorkspace.tsx';

let handoff = null;
before(async () => {
  const web = path.join(WEB, 'app');
  const dir = '/tmp/opencode/eventouch-handoff-under-test';
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'event-stage.ts'),
    fs.readFileSync(path.join(web, 'event-stage.ts'), 'utf8')
  );
  const source = fs.readFileSync(path.join(web, 'console', 'console-handoff.ts'), 'utf8');
  const rewritten = source.replace(
    /from\s+["']\.\.\/event-stage["']/,
    'from "./event-stage.ts"'
  );
  assert.notEqual(rewritten, source, 'helper must reuse eventStageLabel, not a copy');
  const helperPath = path.join(dir, 'console-handoff.under-test.ts');
  fs.writeFileSync(helperPath, rewritten);
  handoff = await import(`file://${helperPath}`);
});

// --- helper behavior ----------------------------------------------------------

test('recipient status reader: explicit allowlist, absent leaves the filter, bad is safe', () => {
  assert.equal(handoff.readRecipientStatusHandoff('?to=a&status=APPROVED'), 'APPROVED');
  assert.equal(handoff.readRecipientStatusHandoff('?to=a&status=pending'), 'PENDING');
  assert.equal(handoff.readRecipientStatusHandoff('?to=a&status=Waitlist'), 'WAITLIST');
  assert.equal(handoff.readRecipientStatusHandoff('?to=a&status=ALL'), 'ALL');
  assert.equal(handoff.readRecipientStatusHandoff('?to=a'), null);
  assert.equal(handoff.readRecipientStatusHandoff('?status=BOGUS&to=a'), 'APPROVED');
  assert.equal(handoff.readRecipientStatusHandoff('?status=CANCELLED&to=a'), 'APPROVED');
  assert.equal(handoff.readRecipientStatusHandoff('?status=&to=a'), 'APPROVED');
  assert.equal(handoff.readRecipientStatusHandoff(''), null);
});

test('approved handoff href carries exactly the approved ids plus the filter', () => {
  assert.equal(
    handoff.buildApprovedMessageHandoffHref('event-1', ['p1', 'p2']),
    '/console/events/event-1/messages?to=p1%2Cp2&status=APPROVED'
  );
  // Dedupes and drops blanks; never invents ids.
  assert.equal(
    handoff.buildApprovedMessageHandoffHref('event-1', ['p1', ' p1 ', '', 'p2']),
    '/console/events/event-1/messages?to=p1%2Cp2&status=APPROVED'
  );
  assert.equal(
    handoff.buildApprovedMessageHandoffHref('event 1', []),
    '/console/events/event%201/messages?to=&status=APPROVED'
  );
});

// --- roster wiring --------------------------------------------------------------

test('bulk approval keeps its success copy and links only proven approvals', () => {
  const list = read(LIST);
  // Existing success wording is untouched.
  assert.match(list, /명을 승인했습니다\./u);
  assert.match(list, /승인 대기 필터를 전체로 되돌려 승인한 사람을 보여 줍니다\./u);
  // The follow-up link names its destination and filter.
  assert.match(list, /id="roster-approved-message"/u, 'stable selector for the follow-up');
  assert.match(list, /승인자에게 안내 보내기/u);
  assert.match(list, /buildApprovedMessageHandoffHref\(eventId, approvedHandoffIds\)/u, 'only the approved ids travel');
  // Lifecycle: cleared on every new attempt, set only on proven success,
  // cleared by every other success notice and on event switch.
  assert.match(list, /const \[approvedHandoffIds, setApprovedHandoffIds\] = useState<string\[\] \| null>\(null\)/u);
  const approveAt = list.indexOf('async function approveSelected()');
  const approveBody = list.slice(approveAt, list.indexOf('async function createParticipant()', approveAt));
  assert.match(approveBody, /setApprovedHandoffIds\(null\)/u, 'a new attempt drops the old link first');
  assert.match(approveBody, /setApprovedHandoffIds\(ids\)/u, 'proven success arms exactly this approval');
  assert.equal(approveBody.match(/setApprovedHandoffIds\(ids\)/g)?.length ?? 0, 1, 'one arming point');
  const failureAt = approveBody.indexOf('if (!res.ok)');
  const failureBody = approveBody.slice(failureAt, approveBody.indexOf('pendingBulkRef.current = null;', failureAt));
  assert.doesNotMatch(failureBody, /setApprovedHandoffIds\(ids\)/u, 'failure never arms the link');
  assert.match(list, /setApprovedHandoffIds\(null\);\s*\n\s*setNotice\(`\$\{added\}님을 등록했습니다\./u, 'other notices clear it');
});

test('bulk approval still validates and recovers exactly as before', () => {
  const list = read(LIST);
  assert.match(list, /command: "participant\.status"/u);
  assert.match(list, /payload: \{ ids, status: "APPROVED" \}/u, 'bulk payload is unchanged');
  assert.match(list, /선택한 참가자 중 승인 대기 중인 사람이 없습니다\./u, 'empty attempt still explains itself');
  assert.match(list, /같은 내용으로 다시 시도하세요\./u, 'lost responses still retry the same request');
});

// --- messaging wiring --------------------------------------------------------------

test('messaging applies the handoff status to the filter only, selection untouched', () => {
  const source = read(MESSAGES);
  assert.match(source, /readRecipientStatusHandoff\(window\.location\.search\)/u);
  assert.match(source, /if \(handoffStatus !== null\) setRecipientStatus\(handoffStatus\)/u, 'absent leaves the filter alone');
  assert.match(source, /url\.searchParams\.delete\("status"\)/u, 'the consumed filter does not linger in the URL');
  assert.match(source, /url\.searchParams\.delete\("to"\)/u, 'the existing consume stays');
  assert.match(source, /window\.history\.replaceState/u, 'no navigation on consume');
  // Existing handoff mechanics are untouched.
  assert.match(source, /params\.get\("to"\)/u);
  assert.match(source, /handoffAppliedRef/u);
  assert.match(source, /인계받았습니다/u);
  assert.match(source, /setShowSelectedOnly\(true\)/u);
  const handoffAt = source.indexOf('Roster→message handoff');
  const handoffBody = source.slice(handoffAt, source.indexOf('}, [state, eventId]);', handoffAt));
  assert.doesNotMatch(handoffBody, /postCommand|executeCampaignCreate|message\.create/u, 'the handoff never sends');
});
