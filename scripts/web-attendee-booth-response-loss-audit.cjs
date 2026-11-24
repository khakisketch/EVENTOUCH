'use strict';

// Real isolated PostgreSQL/API/Next Chromium audit for SELF booth stamping
// after the first API request commits and its response is lost.
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee-booth-response-loss');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);

  const fixture = await startAuditFixture({ loseFirstResponseFor: 'booth.visit' });
  let browser;
  try {
    const { database } = fixture.harness;
    const row = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0];
    const workspace = row.payload;
    const participant = workspace.participants.find(person => person.status === 'APPROVED');
    assert.ok(participant?.ticket, 'fixture provides an approved attendee ticket');
    participant.status = 'APPROVED';
    participant.paymentStatus = 'FREE';
    participant.inside = true;
    participant.everIn = true;
    participant.revoked = false;
    participant.ticketExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    workspace.stampMode = 'SELF';
    workspace.booths = [
      { id: 'audit-booth-a', name: '합성 부스 A', status: 'OPEN', capacity: 0, limit: 2, used: 0 },
      { id: 'audit-booth-b', name: '합성 부스 B', status: 'OPEN', capacity: 0, limit: 2, used: 0 },
    ];
    workspace.visits = [];
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);

    const eventRow = (await database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0];
    eventRow.payload.features = [...new Set([...(eventRow.payload.features || []), 'stamp'])];
    await database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [fixture.eventId, JSON.stringify(eventRow.payload)]);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(({ slug, ticket }) => {
      sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket);
    }, { slug: fixture.slug, ticket: participant.ticket });
    const page = await context.newPage();
    const attempts = [];
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
      try {
        const body = request.postDataJSON();
        if (body.command !== 'booth.visit') return;
        attempts.push({
          body,
          path: new URL(request.url()).pathname,
          authorization: request.headers().authorization || '',
        });
      } catch { /* Non-JSON request. */ }
    });

    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/home?view=stamp`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '내 부스 인증' }).waitFor();
    assert.equal(new URL(page.url()).searchParams.has('ticket'), false, 'ticket bearer is kept out of the address bar');
    const boothCode = `ET:BOOTH:${fixture.eventId}:audit-booth-a`;
    const codeInput = page.getByLabel('부스 코드');
    await codeInput.fill(boothCode);
    const stayWarning = page.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await page.getByRole('button', { name: '참가자 홈', exact: true }).click({ noWaitAfter: true });
    assert.match(await stayWarning, /입력한 내용이 사라집니다/);
    assert.equal(await codeInput.inputValue(), boothCode, 'cancelled menu navigation retains the code');
    await page.getByRole('button', { name: '인증하기', exact: true }).click();
    await fixture.gateway.waitForResponseLoss('booth.visit');
    await page.getByRole('heading', { name: '처리 여부를 확인하지 못한 요청', exact: true }).waitFor();

    const firstVisit = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload.visits;
    assert.equal(firstVisit.length, 1, 'the first attendee booth request committed before its response was lost');
    assert.equal(firstVisit[0].participantId, participant.id, 'the committed visit belongs to the original attendee');
    assert.equal(firstVisit[0].boothId, 'audit-booth-a', 'the committed visit belongs to the original booth');
    assert.equal(attempts.length, 1, 'one SELF booth command was sent before confirmation');
    assert.equal(await codeInput.inputValue(), boothCode, 'the original booth code remains frozen for recovery');
    assert.equal(await codeInput.isDisabled(), true, 'pending booth input cannot be changed');
    assert.equal(new URL(page.url()).searchParams.has('ticket'), false, 'ticket bearer is removed from the address bar before capture');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.getByRole('heading', { name: '처리 여부를 확인하지 못한 요청', exact: true }).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `booth-recovery-${width}px.png`), fullPage: true });
    }

    await page.getByRole('button', { name: '원래 요청 다시 보내기', exact: true }).click();
    await page.getByRole('progressbar', { name: '합성 부스 A: 내 인증 1회, 부스당 한도 2회' }).waitFor();
    assert.equal(attempts.length, 2, 'confirmation retries the attendee command');
    assert.deepEqual(attempts[1].body, attempts[0].body, 'confirmation reuses the exact command ID and original booth code');
    assert.equal(attempts[0].path, `/api/events/${fixture.eventId}/commands`, 'the original request targets the fixture event');
    assert.equal(attempts[1].path, attempts[0].path, 'confirmation remains on the original event');
    assert.equal(attempts[1].authorization, attempts[0].authorization, 'confirmation retains the original attendee ticket');
    assert.equal(new URL(page.url()).pathname, `/event/${fixture.slug}/home`, 'the attendee remains on the original event screen');

    const finalWorkspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(finalWorkspace.visits.length, 1, 'receipt replay does not create a second booth visit');
    assert.equal(finalWorkspace.visits[0].participantId, participant.id, 'retry did not switch attendees');
    assert.equal(finalWorkspace.visits[0].boothId, 'audit-booth-a', 'retry did not switch booths');
    assert.equal(finalWorkspace.visits[0].mode, 'SELF');
    assert.equal(finalWorkspace.booths.find(booth => booth.id === 'audit-booth-a').used, 1);
    assert.equal(finalWorkspace.booths.find(booth => booth.id === 'audit-booth-b').used, 0, 'the other booth stays untouched');

    // Lose a second committed response that fills the last open booth. A
    // refreshed inventory must still leave its pending input frozen. After
    // reload only the opaque pointer survives, so lookup must never replay it.
    finalWorkspace.booths.find(booth => booth.id === 'audit-booth-a').status = 'CLOSED';
    finalWorkspace.booths.find(booth => booth.id === 'audit-booth-b').capacity = 1;
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(finalWorkspace)]);
    await page.getByRole('listitem').filter({ hasText: '합성 부스 A' }).getByText('운영 종료', { exact: true }).waitFor();
    let secondLost = false;
    await page.route('**/api/events/*/commands', async route => {
      let body;
      try { body = route.request().postDataJSON(); } catch {}
      if (!secondLost && body?.command === 'booth.visit' && String(body.payload?.code).includes('audit-booth-b')) {
        secondLost = true;
        await route.fetch();
        return route.abort('failed');
      }
      return route.continue();
    });
    const secondCode = `ET:BOOTH:${fixture.eventId}:audit-booth-b`;
    await codeInput.fill(secondCode);
    await page.getByRole('button', { name: '인증하기', exact: true }).click();
    await page.getByRole('heading', { name: '처리 여부를 확인하지 못한 요청', exact: true }).waitFor();
    await page.getByRole('listitem').filter({ hasText: '합성 부스 B' }).getByText('수량 소진', { exact: true }).waitFor();
    assert.equal(await codeInput.inputValue(), secondCode);
    assert.ok(await codeInput.isDisabled());
    assert.equal(attempts.length, 3);
    const pointer = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith('eventouch.receipts.guest.'))?.[1] || '');
    assert.ok(pointer && !pointer.includes(secondCode) && !pointer.includes(participant.ticket));
    page.once('dialog', dialog => dialog.accept());
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '서버에 부스 인증 기록이 있습니다. 인증 내역에서 대상 부스를 확인하세요.' }).waitFor();
    assert.equal(attempts.length, 3, 'status lookup never resends the visit');
    const afterLookup = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(afterLookup.visits.length, 2);
    assert.equal(afterLookup.visits.filter(visit => visit.boothId === 'audit-booth-b').length, 1);

    await context.close();
    process.stdout.write('SELF booth committed-response-loss audit passed (same attendee, event, code and receipt; one visit)\n');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => {
  const message = String(error && error.message || 'Unknown failure').split('\n')[0].replace(/https?:\/\/[^\s]+/g, '[url redacted]');
  console.error(message);
  process.exitCode = 1;
});
