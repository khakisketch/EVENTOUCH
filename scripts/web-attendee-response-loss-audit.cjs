'use strict';
const { openProgram } = require('./ui-journey-helpers.cjs');

// Real isolated PostgreSQL/API/Next Chromium check for attendee participation
// when the command commits but its response is lost. No product code changes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
let stage = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee-response-loss');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);

  const fixture = await startAuditFixture({ loseFirstResponseFor: 'response.submit' });
  let browser;
  try {
    const { database } = fixture.harness;
    const row = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0];
    const workspace = row.payload;
    const participant = workspace.participants.find(person => person.status === 'APPROVED');
    assert.ok(participant?.ticket, 'fixture provides an approved attendee ticket');
    const moduleId = 'response-loss-poll';
    const definiteFailureModuleId = 'response-rejected-poll';
    const photoModuleId = 'response-pending-photo';
    workspace.modules = (workspace.modules || []).filter(module => module.id !== moduleId);
    workspace.modules.push({ id: moduleId, type: 'poll', title: '응답 유실 재시도 투표', status: 'OPEN', published: true, options: ['첫 번째 선택', '두 번째 선택'] });
    workspace.modules.push({ id: definiteFailureModuleId, type: 'poll', title: '확정 거절 재시도 투표', status: 'OPEN', published: true, options: ['첫 번째 선택', '두 번째 선택'] });
    workspace.modules.push({ id: photoModuleId, type: 'photo', title: '승인 대기 사진 확인', status: 'OPEN', published: true });
    workspace.photos = (workspace.photos || []).filter(photo => photo.id !== 'audit-pending-photo');
    workspace.photos.push({ id: 'audit-pending-photo', participantId: participant.id, name: participant.name, image: { fileId: 'audit-missing-pending-image', name: 'pending.png', type: 'image/png', size: 1 }, caption: '승인 대기 합성 사진', status: 'PENDING', at: new Date().toISOString() });
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    const eventRow = (await database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0];
    eventRow.payload.features = [...new Set([...(eventRow.payload.features || []), 'photo'])];
    await database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [fixture.eventId, JSON.stringify(eventRow.payload)]);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await context.newPage();
    const attempts = [];
    const requestContext = [];
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
      try {
        const body = request.postDataJSON();
        if (body.command === 'response.submit' && body.payload?.moduleId === moduleId) {
          attempts.push(body);
          requestContext.push({
            path: new URL(request.url()).pathname,
            authorization: request.headers().authorization || '',
          });
        }
      } catch { /* Non-JSON request. */ }
    });

    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/engage?ticket=${encodeURIComponent(participant.ticket)}`, { waitUntil: 'networkidle' });
    const pendingPhotoSection = await openProgram(page, '승인 대기 사진 확인');
    stage = 'pending photo';
    await pendingPhotoSection.getByText('운영자 승인 대기 중', { exact: true }).waitFor();
    await page.waitForLoadState('networkidle');
    const brokenPendingImages = await pendingPhotoSection.locator('img').evaluateAll(images => images.filter(image => image.complete && image.naturalWidth === 0).length);
    assert.equal(brokenPendingImages, 0, 'an unavailable PENDING photo must render its fallback, not a broken image');
    assert.equal(new URL(page.url()).searchParams.has('ticket'), false, 'ticket bearer is removed from the address bar before capture');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await pendingPhotoSection.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `pending-photo-${width}px.png`), fullPage: true });
    }
    const poll = await openProgram(page, '응답 유실 재시도 투표');
    await poll.getByRole('radio', { name: /^첫 번째 선택/ }).check();
    await poll.getByRole('button', { name: '투표하기' }).click();
    await fixture.gateway.waitForResponseLoss('response.submit');
    const recoveryPanel = page.locator('section').filter({ has: page.getByRole('heading', { name: '요청 결과 확인', exact: true }) });
    stage = 'uncertain recovery panel';
    await recoveryPanel.getByRole('heading', { name: '요청 결과 확인', exact: true }).waitFor();

    const committed = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const initialResponses = committed.responses.filter(response => response.moduleId === moduleId && response.participantId === participant.id);
    assert.equal(initialResponses.length, 1, 'the first request committed exactly one attendee response before transport loss');
    assert.equal(attempts.length, 1, 'one browser command was sent before retry');
    assert.ok(attempts[0].commandId, 'the first submission has an idempotency key');

    // An ambiguous committed write freezes the original answer. Recovery
    // requires a deliberate, accessible confirmation instead of allowing an
    // edited choice to be submitted under the receipt's original command ID.
    const originalChoice = poll.getByRole('radio', { name: /^첫 번째 선택/ });
    assert.equal(await originalChoice.isChecked(), true, 'uncertain submission keeps the original choice selected');
    const answerLocked = await originalChoice.isDisabled();
    assert.equal(answerLocked, true, 'uncertain submission locks answer editing');
    const reconfirm = recoveryPanel.getByRole('button', { name: '원래 요청 다시 보내기', exact: true });
    assert.equal(await reconfirm.count(), 1, 'ambiguous outcome exposes one explicit same-answer confirmation');
    assert.equal(await reconfirm.isEnabled(), true, 'explicit retry confirmation is available');
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await recoveryPanel.scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, `response-recovery-${width}px.png`), fullPage: true });
    }
    await reconfirm.click();
    stage = 'replay confirmation';
    // A confirmed answer reads on its own card (2026-11-24), not in a page notice.
    await poll.getByRole('status').filter({ hasText: '제출을 마쳤습니다.' }).waitFor();
    assert.equal(attempts.length, 2, 'retry sends the command again');
    assert.equal(attempts[1].commandId, attempts[0].commandId, 'explicit confirmation reuses the original receipt ID');
    assert.equal(requestContext[0].path, `/api/events/${fixture.eventId}/commands`, 'initial request targets the fixture event');
    assert.equal(requestContext[1].path, requestContext[0].path, 'reconfirmation stays on the original event');
    assert.equal(requestContext[1].authorization, requestContext[0].authorization, 'reconfirmation keeps the original attendee authorization');
    assert.equal(new URL(page.url()).searchParams.has('ticket'), false, 'ticket bearer is not left in the address bar');
    const finalWorkspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const finalResponses = finalWorkspace.responses.filter(response => response.moduleId === moduleId && response.participantId === participant.id);
    process.stderr.write(`Response-loss recovery: answerLocked=${answerLocked}; sameCommandId=${attempts[1].commandId === attempts[0].commandId}; unchangedPayload=${JSON.stringify(attempts[1].payload) === JSON.stringify(attempts[0].payload)}; persistedResponseCount=${finalResponses.length}\n`);
    assert.deepEqual(attempts[1].payload, attempts[0].payload, 'explicit confirmation replays the original payload');
    assert.equal(finalResponses.length, 1, 'receipt replay does not duplicate the committed participation');
    assert.equal(finalResponses[0].answer, '첫 번째 선택');

    // A definitive API 400 is not ambiguous: the invalid attempt must not
    // freeze the form or create a response, and a corrected choice can submit.
    let rejectedAttemptInjected = false;
    await page.route('**/api/events/*/commands', route => {
      const request = route.request();
      if (rejectedAttemptInjected || request.method() !== 'POST') return route.continue();
      let body;
      try { body = request.postDataJSON(); } catch { return route.continue(); }
      if (body.command !== 'response.submit' || body.payload?.moduleId !== definiteFailureModuleId) return route.continue();
      rejectedAttemptInjected = true;
      return route.continue({ postData: JSON.stringify({ ...body, payload: { ...body.payload, answer: '감사에서 제외된 선택' } }) });
    });
    const rejectedPoll = await openProgram(page, '확정 거절 재시도 투표');
    await rejectedPoll.getByRole('radio', { name: /^첫 번째 선택/ }).check();
    const badResponse = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().method() === 'POST' && response.status() === 400);
    await rejectedPoll.getByRole('button', { name: '투표하기' }).click();
    await badResponse;
    stage = 'definitive rejection';
    await rejectedPoll.getByRole('alert').waitFor();
    assert.equal(await rejectedPoll.getByRole('radio', { name: /^첫 번째 선택/ }).isDisabled(), false, 'a definite 400 unlocks choice editing');
    const beforeCorrection = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.equal(beforeCorrection.responses.filter(response => response.moduleId === definiteFailureModuleId && response.participantId === participant.id).length, 0, 'a rejected 400 leaves no participation response');
    await rejectedPoll.getByRole('radio', { name: /^두 번째 선택/ }).check();
    await rejectedPoll.getByRole('button', { name: '투표하기' }).click();
    stage = 'corrected submission';
    await rejectedPoll.getByRole('status').filter({ hasText: '제출을 마쳤습니다.' }).waitFor();
    const afterCorrection = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const correctedResponses = afterCorrection.responses.filter(response => response.moduleId === definiteFailureModuleId && response.participantId === participant.id);
    assert.equal(correctedResponses.length, 1, 'a corrected request after definitive 400 commits once');
    assert.equal(correctedResponses[0].answer, '두 번째 선택');

    await context.close();
    process.stdout.write('Attendee participation recovery: poll receipt retry, definitive-400 correction and PENDING-photo fallback passed\n');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => {
  // Avoid reporting browser URLs (which may contain the synthetic bearer).
  const message = String(error && error.message || 'Unknown failure').split('\n')[0].replace(/https?:\/\/[^\s]+/g, '[url redacted]');
  console.error(`Stage ${stage}: ${message}`);
  process.exitCode = 1;
});
