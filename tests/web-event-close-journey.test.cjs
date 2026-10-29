'use strict';

// Static contract for the event-close paired journey audit
// (scripts/web-event-close-journey-audit.cjs). These assertions pin the
// seam without booting Next.js: the rendered proof comes from running the
// audit itself (`--before` against the current build, `after` once the hub
// lands). Fixture protection: this file never touches the protected review
// event/API, the database schema, or any existing cap.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'web-event-close-journey-audit.cjs');
const read = () => fs.readFileSync(SCRIPT, 'utf8');

test('event-close audit boots the isolated stack and logs the owner in through the real form', () => {
  const source = read();
  assert.match(source, /startAuditFixture/, 'isolated schema + real API + owned Next + gateway');
  assert.match(source, /#login-email/, 'owner types the real login form');
  assert.match(source, /#login-password/, 'owner password field');
  assert.match(source, /FIXTURE_PASSWORD/, 'test-only password stays inside the dropped schema');
  assert.match(source, /fixture\.close\(\)/, 'isolated fixture is closed, never a shared database');
  assert.doesNotMatch(source, /39511/, 'the protected review API is never referenced');
});

test('event-close audit seeds LIVE + PENDING + OPEN + open intake with the real commands', () => {
  const source = read();
  assert.match(source, /participant\.create/, 'setup creates the waiting applicant');
  assert.match(source, /participant\.status/, 'setup moves the applicant to PENDING');
  assert.match(source, /module\.save/, 'setup saves the participation program');
  assert.match(source, /module\.status/, 'setup opens the program');
  assert.match(source, /registrationOpen/, 'intake starts open (seed form.publish)');
  assert.match(source, /reports.*length.*0|length.*0.*reports/, 'reports start at 0');
  assert.match(source, /stage.*LIVE|LIVE.*stage/, 'the journey starts at LIVE');
});

test('event-close audit mocks the result notice and forbids any real send', () => {
  const source = read();
  assert.match(source, /simulate=true/, 'the campaign is recorded simulated');
  assert.match(source, /SIMULATED/, 'the SIMULATED status is asserted');
  assert.match(source, /EVENTOUCH_SMS_MOCK/, 'mock posture forced before helpers load');
  assert.match(source, /SOLAPI_API_KEY/, 'provider keys are deleted');
  assert.match(source, /실제 전달 없음|real send is forbidden|never a send/i, 'no-send intent is explicit');
});

test('event-close audit runs the result notice before the archive lock', () => {
  const source = read();
  const notifyAt = source.indexOf('result-notify');
  const archiveAt = source.indexOf("'archive'");
  assert.ok(notifyAt >= 0 && archiveAt >= 0 && notifyAt < archiveAt,
    'result-notify must precede archive because ARCHIVED rejects every command write');
  assert.match(source, /ARCHIVED.*reject|rejects every command write/, 'the archive write-lock is documented');
});

test('event-close audit reports click/fill/select/check, path, back and revisit metrics exactly', () => {
  const source = read();
  for (const metric of ['clicks', 'fills', 'selects', 'checks', 'pathChanges', 'backs', 'revisits']) {
    assert.match(source, new RegExp(metric), `metric ${metric} is recorded`);
  }
  assert.match(source, /already-visited pathname|already-visited/, 'revisit means arrival at an already-visited pathname');
  assert.match(source, /pathname only|pathname-only/, 'hash-only moves never count as path changes');
  assert.match(source, /goBack/, 'backs go through the counted wrapper');
});

test('event-close audit keeps every phase within 12 steps and touches no existing cap', () => {
  const source = read();
  assert.match(source, /STEP_CAP = 12/, 'phase cap is 12');
  assert.match(source, /steps exceed cap/, 'phases assert the cap instead of raising it');
  assert.match(source, /adds no new cap|no new cap/, 'the whole journey adds no arbitrary cap');
  assert.doesNotMatch(source, /STEP_CAP = (1[3-9]|[2-9]\d)/, 'the cap is never raised');
});

test('event-close audit proves ENDED mid-flight and ARCHIVED + PUBLISHED from the raw rows', () => {
  const source = read();
  assert.match(source, /endedStage|ENDED.*intermediate|intermediate.*ENDED/i, 'the ENDED intermediate is checkpointed');
  assert.match(source, /event_workspaces/, 'final proof reads the raw workspace row');
  assert.match(source, /ARCHIVED/, 'final events.payload.stage is ARCHIVED');
  assert.match(source, /PUBLISHED/, 'final report status is PUBLISHED');
});

test('event-close audit captures paired desktop + mobile shots and keeps failure evidence', () => {
  const source = read();
  assert.match(source, /1280, height: 900|1280.*900/, 'desktop 1280x900 capture');
  assert.match(source, /390, height: 844|390.*844/, 'mobile 390x844 capture');
  assert.match(source, /round-close/, 'captures live under round-close/');
  assert.match(source, /paired-failure/, 'failures keep their own evidence shots');
  assert.match(source, /axe/, 'axe serious/critical is probed where possible');
  assert.match(source, /overflow/, 'horizontal overflow is probed where possible');
  assert.match(source, /44/, '44px touch targets are checked');
});

test('event-close audit separates direct reference from the linear path and preserves hub evidence', () => {
  const source = read();
  assert.match(source, /--before/, 'the before flag selects the current UI path');
  assert.match(source, /event-close/, 'the after hub is anchored at headingId event-close');
  assert.match(source, /closeReturn/, 'hub deep links carry closeReturn');
  assert.match(source, /공유 완료·잠금|보고서 만들기/, 'report create/publish keep their existing labels');
  assert.match(source, /round-close\/linear/, 'linear results cannot overwrite the historical hub or original before');
  assert.match(source, /fromMapEntry/, 'the overview launcher is counted and entry-only numbers are labelled separately');
});

test('linear measured phases use direct next controls and a single settings intake/end visit', () => {

  const source = read();
  const phases = source.slice(source.indexOf('// ---- Phase 1:'), source.indexOf('// ---- Final proof'));
  assert.doesNotMatch(phases, /backToHub\(|page\.goto\(/, 'no mandatory hub return or hidden measured navigation');
  assert.match(source, /data-close-linear-next/);
  assert.match(source, /data-close-report-next/);
  assert.match(source, /intake and ENDED stay in one settings visit/);
  assert.match(source, /linear-completed-messages/);
  assert.match(source, /totals\.pathChanges <= 6/, 'the original six-transition goal is not raised');
  assert.match(source, /result notice and archive stay on the messages screen/);
});

test('approve phase clicks the current filter-scope roster select-all, not retired copy', () => {
  const source = read();
  assert.doesNotMatch(source, /검색·필터 결과 \\d/, 'the retired roster select-all label is gone from the audit');
  assert.match(source, /\/\^전체 \\d\+명 선택\$\//, 'phase 1 anchors to the exact filter-scope label');
  const list = fs.readFileSync(path.join(
    __dirname, '..', 'apps', 'web', 'app', 'console', 'events', '[id]', 'participants', 'ParticipantList.tsx',
  ), 'utf8');
  assert.match(list, /전체 \{visiblePeople\.length\}명 선택/, 'the product still renders the filter-scope select-all the audit clicks');
  assert.match(list, /function selectVisible\(\) \{\s*\n?.*visiblePeople\.map/, 'that label selects the whole filter scope, not just the page');
});

test('out-of-order recovery opens the collapsed composer before drafting the guard probe', () => {
  const source = read();
  const recovery = source.slice(
    source.indexOf('linear-out-of-order-warning'),
    source.indexOf('archiveDraftCancelled'),
  );
  assert.ok(recovery.includes('#message-compose-open'), 'collapsed composer is opened first');
  assert.ok(
    recovery.indexOf('#message-compose-open') < recovery.indexOf('#campaign-title'),
    'composer opens before the draft fill, mirroring the measured result-notify handoff',
  );
});
