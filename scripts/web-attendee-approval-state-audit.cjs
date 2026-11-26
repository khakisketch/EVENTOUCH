'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee-approval-state'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const save = value => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(value)]);
    const source = await read();
    const [unknown, waiting, waitingReturn] = source.participants;
    delete unknown.status; unknown.paymentStatus = 'FREE';
    waiting.status = 'WAITLIST'; waiting.paymentStatus = 'FREE';
    waitingReturn.status = 'WAITLIST'; waitingReturn.paymentStatus = 'FREE';
    await save(source);
    const status = async (person, next, expectedStatus) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: 'participant.status', payload: { id: person.id, status: next, expectedStatus } },
    });
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }); page.setDefaultTimeout(12000);
    const qr = page.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ });
    const open = ticket => page.goto(`${f.baseUrl}/event/${f.slug}/ticket?ticket=${encodeURIComponent(ticket)}`);
    const visibility = state => page.evaluate(value => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value });
      document.dispatchEvent(new Event('visibilitychange'));
    }, state);
    await open(unknown.ticket);
    if (process.argv.includes('--before')) {
      await qr.waitFor();
      assert.equal(await page.getByText('참가 확정', { exact: true }).isVisible(), true, 'missing approval is falsely presented as confirmed');
      await page.screenshot({ path: path.join(out, 'before-unknown-390.png'), mask: [qr], maskColor: '#e4e6ea', fullPage: true });
      await open(waiting.ticket); await page.getByText('대기 명단', { exact: true }).waitFor();
      await visibility('hidden');
      assert.equal((await status(waiting, 'APPROVED', 'WAITLIST')).status, 200);
      await visibility('visible'); await page.waitForTimeout(500);
      assert.equal(await page.getByText('대기 명단', { exact: true }).isVisible(), true, 'returning leaves the previous waitlist status on screen');
      assert.equal(await qr.count(), 0);
      await page.screenshot({ path: path.join(out, 'before-waitlist-390.png'), fullPage: true });
      console.log('REPRODUCED: missing approval shows QR and a confirmed waitlist stays stale on return');
      return;
    }
    await page.getByText('상태 확인 필요', { exact: true }).waitFor();
    assert.equal(await qr.count(), 0);
    assert.doesNotMatch(await page.innerText('body'), /참가 확정|이 화면이 입장권/);
    assert.match(await page.innerText('body'), /신청 상태를 확인할 수 없습니다/);
    await page.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious','critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `unknown-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=application`);
    await page.getByRole('heading', { name: '내 신청 정보' }).waitFor();
    await page.getByText('상태 확인 필요', { exact: true }).waitFor();
    assert.doesNotMatch(await page.innerText('body'), /참가 확정/);
    const repaired = await read(); repaired.participants.find(person => person.id === unknown.id).status = 'PENDING'; await save(repaired);
    await page.getByRole('button', { name: '상태 다시 확인' }).click();
    await page.getByText('승인 대기', { exact: true }).waitFor();
    await visibility('hidden');
    assert.equal((await status(unknown, 'APPROVED', 'PENDING')).status, 200);
    await visibility('visible');
    await page.getByText('참가 확정', { exact: true }).waitFor();
    await open(unknown.ticket); await qr.waitFor();
    const ticketApi = `**/api/public/events/${f.slug}/ticket`;
    for (const malformed of ['missing', 'empty', 'unknown', 'payment']) {
      await page.route(ticketApi, async route => {
        const response = await route.fetch(); const body = await response.json();
        if (malformed === 'missing') delete body.participant.status;
        if (malformed === 'empty') body.participant.status = '';
        if (malformed === 'unknown') body.participant.status = 'UNRECOGNIZED';
        if (malformed === 'payment') delete body.participant.paymentStatus;
        await route.fulfill({ response, json: body });
      }, { times: 1 });
      await page.getByRole('button', { name: '상태 다시 확인' }).click();
      await page.getByText(malformed === 'payment' ? '결제 확인 필요' : '상태 확인 필요', { exact: true }).waitFor();
      assert.equal(await qr.count(), 0, `${malformed}: a partial recheck cannot retain a confirmed QR verdict`);
      await page.getByRole('button', { name: '상태 다시 확인' }).click(); await qr.waitFor();
    }
    await open(waiting.ticket); await page.getByText('대기 명단', { exact: true }).waitFor();
    // Reopened 2026-11-26: the result shows on this screen; a text may not come.
    assert.match(await page.innerText('body'), /결과는 이 화면에서 확인할 수 있습니다/);
    await page.screenshot({ path: path.join(out, 'waitlist-390.png'), fullPage: true });
    await visibility('hidden'); assert.equal((await status(waiting, 'APPROVED', 'WAITLIST')).status, 200);
    await page.route(ticketApi, route => route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }), { times: 1 });
    await visibility('visible');
    await page.getByRole('alert').filter({ hasText: '최신 상태를 확인하지 못했습니다' }).waitFor();
    assert.equal(await page.getByText('대기 명단', { exact: true }).isVisible(), true, 'a failed read keeps the last known state with an error');
    assert.equal(await qr.count(), 0);
    await page.getByRole('button', { name: '상태 다시 확인' }).click(); await qr.waitFor();
    assert.equal(await page.getByText('참가 확정', { exact: true }).isVisible(), true);
    await open(waitingReturn.ticket); await page.getByText('대기 명단', { exact: true }).waitFor();
    await visibility('hidden');
    assert.equal((await status(waitingReturn, 'APPROVED', 'WAITLIST')).status, 200);
    await visibility('visible'); await qr.waitFor();
    assert.equal(await page.getByText('참가 확정', { exact: true }).isVisible(), true, 'a waitlisted attendee sees confirmation on return');
    const blank = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    await blank.route(ticketApi, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      event: { name: '합성 행사', date: '2027-01-16' }, participant: { name: '합성 참가자', status: 'APPROVED', paymentStatus: 'FREE' },
    }) }));
    await blank.goto(`${f.baseUrl}/event/${f.slug}/ticket`);
    await blank.getByText('티켓 확인 필요', { exact: true }).waitFor();
    assert.equal(await blank.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ }).count(), 0, 'a confirmed status without a ticket never draws an empty QR');
    assert.match(await blank.innerText('body'), /입장 QR을 확인할 수 없습니다/);
    await blank.close();
    console.log('PASS: missing status or ticket, pending and waitlist return, failed refresh and manual recovery');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.message || error).replace(/\?[^\s"'<>]*/g, '?[redacted]')); process.exitCode = 1; });
