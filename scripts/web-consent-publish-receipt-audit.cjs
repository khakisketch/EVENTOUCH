'use strict';

// Synthetic, isolated browser regression for publishing a consent notice.
// A committed command may lose its response; checking its receipt must not
// republish it, and old receipts must remain readable after an upgrade.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const workspace = async () => (await fixture.harness.database.query(
      'SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId]
    )).rows[0].payload;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    let sentCount = 0;
    let mode = 'normal';
    await page.route('**/api/events/*/commands', async route => {
      if (route.request().postDataJSON()?.command !== 'form.publish') return route.continue();
      sentCount += 1;
      if (mode === 'lost') {
        mode = 'normal';
        const actual = await route.fetch();
        assert.equal(actual.status(), 200);
        return route.abort('failed');
      }
      if (mode === 'malformed') {
        mode = 'normal';
        const actual = await route.fetch();
        assert.equal(actual.status(), 200);
        const data = await actual.json();
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ publishedVersion: data.publishedVersion }) });
      }
      return route.continue();
    });

    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/settings`);
    await page.getByRole('tab', { name: /^참가 접수/ }).click();
    await page.locator('#set-consent').fill('합성 게시 A');
    await page.getByRole('button', { name: '양식 게시·접수 열기' }).click();
    await page.getByText('양식을 게시하고 접수를 열었습니다.', { exact: true }).first().waitFor();
    let current = await workspace();
    assert.equal(current.consentText, '합성 게시 A');
    assert.equal(current.consentNotices.filter(notice => notice.text === '합성 게시 A').length, 1);

    const panel = page.getByRole('region', { name: '행사 설정 처리 확인 필요' });
    async function checkCommittedRequest(nextMode, text) {
      await page.locator('#set-consent').fill(text);
      mode = nextMode;
      await page.getByRole('button', { name: '양식 게시·접수 열기' }).click();
      await panel.waitFor();
      const beforeCheck = sentCount;
      await panel.getByRole('button', { name: '서버 처리 확인' }).click();
      await panel.waitFor({ state: 'hidden' });
      assert.equal(sentCount, beforeCheck, 'checking the receipt must not republish');
      current = await workspace();
      assert.equal(current.consentText, text);
      assert.equal(current.consentNotices.filter(notice => notice.text === text).length, 1);
    }
    await checkCommittedRequest('lost', '합성 게시 B');
    await checkCommittedRequest('malformed', '합성 게시 C');

    // Model a receipt created by the former server, whose response contained
    // only the publication version. The fixture's data is always synthetic.
    const oldId = crypto.randomUUID();
    const old = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie,
      body: { commandId: oldId, command: 'form.publish', payload: { expectedFormVersion: current.formVersion } },
    });
    assert.equal(old.status, 200);
    await fixture.harness.database.query(
      "UPDATE command_receipts SET result=jsonb_set(result,'{response}',$2::jsonb) WHERE command_id=$1",
      [oldId, JSON.stringify({ publishedVersion: old.json.publishedVersion })]
    );
    await page.evaluate(({ userId, organizationId, eventId, commandId }) => {
      sessionStorage.setItem('eventouch.receipts.operator', JSON.stringify([{ userId, organizationId, eventId, commandId, command: 'form.publish' }]));
    }, { userId: fixture.manager.id, organizationId: fixture.helpers.LEGACY_ORG, eventId: fixture.eventId, commandId: oldId });
    await page.reload();
    const receipts = page.getByRole('region', { name: '처리 결과 확인' });
    await receipts.getByRole('button', { name: '서버 처리 확인' }).waitFor();
    await receipts.getByRole('button', { name: '서버 처리 확인' }).click();
    await receipts.getByText('서버에 반영된 것을 확인했습니다.', { exact: false }).waitFor();
    assert.equal(await receipts.getByRole('button', { name: '서버 처리 확인' }).count(), 0);
    assert.deepEqual(pageErrors, []);

    await page.screenshot({ path: path.join(out, 'settings-confirmed.png') });
    const build = fs.readFileSync(path.join(process.cwd(), 'apps/web/.next/BUILD_ID'), 'utf8').trim();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
      build, normalPublish: true, lostResponseRecovered: true, malformedResponseRecovered: true,
      legacyReceiptConfirmed: true, actualProvider: false,
    }, null, 2), { mode: 0o600 });
    console.log('[consent-publish-receipt] all isolated scenarios passed');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
