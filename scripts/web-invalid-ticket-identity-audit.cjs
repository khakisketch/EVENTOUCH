'use strict';
// Isolated synthetic ticket identity: an invalid explicit bearer must not
// silently render a different attendee from the same-browser session.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const jsQR = require('../apps/web/node_modules/jsqr');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { createAttendeeAccess } = require('../server/attendees');

async function decode(page) {
  const pixels = await page.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ }).locator('svg').evaluate(async svg => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 360;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 360, 360);
    context.drawImage(image, 24, 24, 312, 312);
    return Array.from(context.getImageData(0, 0, 360, 360).data);
  });
  const result = jsQR(Uint8ClampedArray.from(pixels), 360, 360);
  assert.ok(result, 'the displayed QR must decode');
  return result.data;
}

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const row = (await fixture.harness.database.query(
      'SELECT e.payload AS event, w.payload AS workspace FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1', [fixture.eventId],
    )).rows[0];
    const [a, b] = row.workspace.participants;
    assert.ok(a.ticket && b.ticket);
    const access = createAttendeeAccess(fixture.harness.database);
    const session = await access.grantAccess({ event: { id: fixture.eventId, payload: row.event }, participantId: b.id, phone: b.phone });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'etko_attendee', value: session.token, url: fixture.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = `${fixture.baseUrl}/event/${fixture.slug}/ticket`;
    // Store synthetic bearer in tab storage without putting it in a URL or
    // assertion output; screenshot is taken only after the QR disappears.
    await page.goto(url);
    await page.getByRole('img', { name: `${b.name}님의 행사 입장 및 퇴장용 QR` }).waitFor();
    await page.evaluate(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: fixture.slug, ticket: a.ticket });
    await page.reload();
    await page.getByRole('img', { name: `${a.name}님의 행사 입장 및 퇴장용 QR` }).waitFor();
    assert.ok((await decode(page)) === a.ticket, 'a valid explicit ticket must render that participant');
    const cancelled = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'participant.status', payload: { id: a.id, status: 'CANCELLED' } },
    });
    assert.equal(cancelled.status, 200);
    const [response] = await Promise.all([
      page.waitForResponse(res => res.url().includes('/ticket') && res.request().headers().authorization === `Bearer ${a.ticket}`),
      page.getByRole('button', { name: '상태 다시 확인' }).click(),
    ]);
    assert.equal(response.status(), 404);
    await page.getByRole('heading', { name: '티켓을 사용할 수 없습니다' }).waitFor();
    assert.equal(await page.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ }).count(), 0);
    assert.equal(await page.getByText(b.name, { exact: true }).count(), 0, 'another attendee must not appear');
    await page.screenshot({ path: path.join(out, 'invalid-ticket-390.png'), fullPage: true });
    await page.evaluate(axe);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
    }
    await page.goto(`${url}?session=1`);
    await page.getByRole('img', { name: `${b.name}님의 행사 입장 및 퇴장용 QR` }).waitFor();
    assert.ok((await decode(page)) === b.ticket, 'an explicit session lookup still recovers the session owner');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ validExplicitMatches: true,
      cancelledExplicitStatus: response.status(), wrongParticipantShown: false, explicitSessionMatches: true, actualProvider: false }, null, 2), { mode: 0o600 });
    console.log('explicit ticket identity: passed');
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
