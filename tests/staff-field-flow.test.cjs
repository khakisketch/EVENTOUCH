'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const work = fs.readFileSync(
  path.join(__dirname, '../apps/web/app/staff/StaffEventWork.tsx'),
  'utf8'
);
const styles = fs.readFileSync(
  path.join(__dirname, '../apps/web/app/staff/staff-event-work.module.css'),
  'utf8'
);

test('scan-success-groups-summary-and-next-action-before-auxiliary-acts', () => {
  assert.match(work, /aria-label="스캔 결과"/);
  assert.match(work, /다음 참가자를 스캔하세요/);
  assert.match(work, /className="button button-primary" onClick=\{prepareNextParticipant\}>[\s\S]*?다음 참가자/);
  // Auxiliary nametag stays available but secondary and after the next action.
  const nextIndex = work.indexOf('다음 참가자');
  const nametagIndex = work.indexOf('네임택 인쇄');
  assert.ok(nextIndex !== -1 && nametagIndex !== -1 && nextIndex < nametagIndex);
  assert.match(work, /button-secondary \$\{prizeStyles\.auxAction\}/);
  // No existing copy is dropped: identity, verdict, booth, and reentry stay.
  assert.match(work, /result\.name\}/);
  assert.match(work, /부스 인증/);
  assert.match(work, /재입장/);
});

test('scan-failure-guides-retry-and-manual-entry-without-repeating-itself', () => {
  assert.match(work, /aria-label="스캔 실패"/);
  assert.match(work, /role="alert">\{result\.message\}/);
  assert.match(work, /카메라가 안 되면 티켓 코드를 직접 입력하세요/);
  assert.match(work, /result\.message\.includes\("다시 시도"\)/);
  assert.match(work, />\s*다시 시도\s*</);
});

test('recent-checks-read-as-one-line-and-offer-next-scan-flow', () => {
  assert.match(work, /같은 티켓을 다시 스캔하면 같은 결과가 나옵니다/);
  assert.match(work, /actionLabel/);
  assert.match(work, /부스 인증/);
  assert.match(work, /정정됨/);
  assert.match(work, /slice\(0, 10\)/);
  assert.match(work, /aria-label=\{\`\$\{check\.name\} 다시 스캔 준비\`\}/);
  assert.match(work, />\s*다시 스캔\s*</);
  assert.match(work, /onClick=\{prepareNextParticipant\}/);
});

test('field-flow-keeps-touch-size-sticky-scan-and-kiosk-distinction', () => {
  assert.match(work, /prizeStyles\.scanInput/);
  assert.match(work, /kiosk-mode/);
  assert.match(work, /키오스크 모드/);
  assert.match(styles, /\.nextActions button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.recentRow button\s*\{[^}]*min-height:\s*44px/s);
  assert.match(styles, /\.scanInput\s*{[^}]*position:\s*sticky[^}]*bottom:\s*0/s);
  assert.match(styles, /\.nextActions button,[\s\S]*?width:\s*100%/);
});
