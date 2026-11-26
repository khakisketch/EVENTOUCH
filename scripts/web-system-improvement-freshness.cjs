'use strict';
// Two real tabs in one synthetic session; no fetch/notification mocks.
process.env.EVENTOUCH_SMS_MOCK = '1';
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const assert = require('node:assert/strict');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { openStudioPanel } = require('./ui-journey-helpers.cjs');
const captureRoot = process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`system-improvement-20261024/ux-${runStamp()}`);
const runId = process.env.EVENTOUCH_AUDIT_RUN_ID || new Date().toISOString().replace(/[:.]/g, '-');
const OUT = path.join(captureRoot, `freshness-${runId}`);

(async () => {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const fixture = await startAuditFixture();
  let browser;
  const checks = [];
  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(fixture.manager.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const editor = await context.newPage();
    const base = `${fixture.baseUrl}/console/events/${fixture.eventId}`;
    await editor.goto(base + '/page');
    // Reopened 2026-11-20 (참가자 화면 스튜디오): 편집 칸은 네 개의 줄 뒤에 있어 '소개와 공개 범위'를 열어야 한다.
    await openStudioPanel(editor, 'exposure');
    await editor.locator('#home-intro').fill('다른 탭 갱신에도 남는 참가자 홈 초안');
    const roster = await context.newPage();
    await roster.goto(base + '/participants');
    await roster.locator('#roster-search').waitFor();
    // Reopened 2026-11-20 (참가자 명단 확정): 넓은 화면의 명단은 표이고, 상태 변경은 행이 아니라 참가자 상세 시트에 있다.
    const row = roster.locator('tbody tr').filter({ has: roster.getByRole('checkbox', { name: '감사 참가자 1 선택', exact: true, includeHidden: true }) });
    await row.getByRole('button', { name: '감사 참가자 1 참가자 상세', exact: true }).click();
    await roster.getByRole('dialog', { name: '감사 참가자 1', exact: true })
      .getByRole('combobox', { name: '감사 참가자 1 상태 변경', exact: true }).selectOption('WAITLIST');
    await row.getByText('대기 명단', { exact: true }).first().waitFor();
    const saved = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(saved.participants.find((person) => person.name === '감사 참가자 1').status, 'WAITLIST', 'the other tab committed a real write');
    await editor.bringToFront();
    const refresh = editor.getByRole('button', { name: '최신 내용 불러오기', exact: true });
    await refresh.waitFor();
    assert.equal(await editor.locator('#home-intro').inputValue(), '다른 탭 갱신에도 남는 참가자 홈 초안');
    checks.push({ name: 'other-tab committed write shows freshness notice without replacing draft', ok: true });
    let warning;
    editor.once('dialog', async (dialog) => { warning = dialog.message(); await dialog.dismiss(); });
    await refresh.click();
    assert.ok(warning?.includes('저장하지 않은 변경'), warning);
    assert.equal(await editor.locator('#home-intro').inputValue(), '다른 탭 갱신에도 남는 참가자 홈 초안');
    checks.push({ name: 'manual reload still asks unsaved guard and cancellation retains input', ok: true });
    await editor.screenshot({ path: `${OUT}/two-tab-draft-preserved-1280.png`, fullPage: false });
  } finally {
    fs.writeFileSync(`${OUT}/freshness-verification.json`, JSON.stringify({ build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8'), checks, simulation: 'Synthetic event and two real Chromium tabs; actual roster write and BroadcastChannel delivery, no event mocks.' }, null, 2), { mode: 0o600 });
    console.log(`Freshness evidence: ${OUT}`);
    if (browser) await browser.close();
    await fixture.close();
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
