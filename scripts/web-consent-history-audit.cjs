'use strict';

// Isolated synthetic participants only. The screenshot is limited to the
// selected detail panel and participant identity is masked even in fixtures.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const read = async () => (await fixture.harness.database.query(
      'SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId]
    )).rows[0].payload;
    let workspace = await read();
    const acceptedText = '신규 참가자가 확인한 합성 안내 B';
    const laterText = '그 뒤 변경된 합성 안내 C';
    workspace.consentText = acceptedText;
    workspace.consentVersion = 3;
    workspace.formVersion = Math.max(workspace.formVersion || 0, workspace.publishedVersion || 0) + 1;
    workspace.publishedVersion = workspace.formVersion;
    const legacy = workspace.participants.find((person) => person.name === '감사 참가자 2');
    assert.ok(legacy);
    legacy.consent = { version: 2, at: '2026-11-01T00:00:00.000Z' };
    await fixture.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1',
      [fixture.eventId, JSON.stringify(workspace)]);

    const signup = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.slug}/signup`, {
      method: 'POST', body: { commandId: crypto.randomUUID(), name: '합성 원문 참가자',
        phone: '01088887770', consent: true, formVersion: workspace.publishedVersion },
    });
    assert.equal(signup.status, 201);
    const published = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'form.publish', payload: { consentText: laterText } },
    });
    assert.equal(published.status, 200);
    workspace = await read();
    const accepted = workspace.participants.find((person) => person.name === '합성 원문 참가자');
    assert.ok(accepted?.consent?.noticeId);
    assert.equal(workspace.consentNotices.find((notice) => notice.id === accepted.consent.noticeId)?.text, acceptedText);
    assert.equal(workspace.participants.find((person) => person.id === legacy.id).consent.noticeId, undefined);

    browser = await launchBrowser();
    const cases = [];
    for (const [width, height] of [[390, 844], [1280, 900]]) {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', reducedMotion: 'reduce' });
      try {
        await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
        const page = await context.newPage();
        await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`);
        for (const [name, label] of [['감사 참가자 1', 'none'], ['감사 참가자 2', 'legacy'], ['합성 원문 참가자', 'known']]) {
          await page.getByRole('button', { name: `${name} 참가자 상세` }).first().click();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor();
          const disclosure = dialog.locator('details').filter({ has: page.getByText('동의한 안내 보기', { exact: true }) });
          if (label === 'known') await disclosure.locator('summary').click();
          const content = await dialog.innerText();
          if (label === 'none') assert.ok(content.includes('동의 기록이 없습니다.'));
          if (label === 'legacy') {
            assert.ok(content.includes('당시 동의 안내 원문은 확인할 수 없습니다.'));
            assert.ok(!content.includes(acceptedText));
          }
          if (label === 'known') {
            assert.ok(content.includes(acceptedText));
            assert.ok(!content.includes(laterText));
            assert.match(content, /버전 3/);
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
          await page.evaluate(axe);
          const violations = await page.evaluate(async () => (await window.axe.run()).violations
            .filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id));
          assert.deepEqual(violations, []);
          await dialog.screenshot({ path: path.join(out, `${label}-${width}.png`),
            mask: [dialog.locator('h2'), dialog.locator('[id$="-description"]'),
              dialog.locator('p').filter({ hasText: /010/ })] });
          cases.push({ width, state: label, correct: true });
          await dialog.getByRole('button', { name: '닫기', exact: true }).click();
        }
      } finally { await context.close(); }
    }
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ cases, synthetic: true }, null, 2), { mode: 0o600 });
    console.log('[consent-history] all isolated detail states passed');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
