'use strict';

// Staff field flow: SELF booths guide participants to the in-home camera
// scan (copy/paste is the fallback, not the path), the prize panel replays
// the last scanned ticket with one touch, the scan input keeps a
// role-named identity, and the nametag print flag lifts on afterprint —
// cancelling the browser dialog must not leave the print stylesheet on.
// Source contracts pin the wiring; the staff browser suite walks the flow.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');
const read = (rel) => fs.readFileSync(path.join(WEB, rel), 'utf8');
const WORK = 'app/staff/StaffEventWork.tsx';

test('self booth guidance points at the in-home camera scan', () => {
  const work = read(WORK);
  assert.match(work, /참가자 홈.*부스 인증에서 카메라로 바로 인증하게 안내/u, 'staff wording matches the participant path');
  assert.match(work, /카메라를 쓸 수 없으면 아래 코드를 직접 입력/u, 'manual entry stays for camera failures');
  assert.match(work, /코드 직접 복사/u, 'clipboard fallback stays on the staff side');
  const stamp = read('app/event/[slug]/home/HomeShell.tsx');
  assert.match(stamp, /<CameraScan/u, 'participant booth tab reuses the shared camera input');
  assert.match(stamp, /id="booth-code"/u, 'manual code entry stays beside the scanner');
});

test('prize lookup replays the last scanned ticket with one touch', () => {
  const work = read(WORK);
  assert.match(work, /const \[lastScannedTicket, setLastScannedTicket\] = useState\(""\)/u, 'last scan is remembered in client memory');
  assert.match(work, /if \(isDesk\) setLastScannedTicket\(code\.trim\(\)\)/u, 'a successful desk scan records its ticket');
  assert.match(work, /마지막 스캔 티켓으로 조회/u, 'one-touch lookup exists beside the manual form');
  assert.match(work, /lookupRewardsByTicket\(event, lastScannedTicket\)/u, 'one touch replays through the existing lookup path');
  assert.match(work, /postRewardCommand\("reward\.lookup", \{ ticket: lookupTicket \}\)/u, 'server contract unchanged: reward.lookup by ticket');
});

test('scan input keeps a role-named identity', () => {
  const work = read(WORK);
  assert.match(work, /scanInputHasWork/u);
  assert.match(work, /prizeStyles\.scanInput/u);
  assert.doesNotMatch(work, /scanDock/u, 'no scanDock remnant in behavior');
  const styles = read('app/staff/staff-event-work.module.css');
  assert.match(styles, /\.scanInput\s*\{/u);
  assert.doesNotMatch(styles, /scanDock/u);
});

test('nametag print flag lifts on afterprint, not only on close', () => {
  const work = read(WORK);
  assert.match(work, /window\.addEventListener\("afterprint", liftPrintFlag\)/u, 'cancel/complete both lift the flag');
  assert.match(work, /document\.body\.classList\.remove\("nametag-printing"\)/u);
});
