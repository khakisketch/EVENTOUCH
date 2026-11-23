'use strict';
const { messageStep, chooseScheduleDate } = require('./ui-journey-helpers.cjs');


// Browser -> real API -> isolated PostgreSQL. Fixture records and captures are synthetic.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
for (const key of Object.keys(process.env)) {
  if (/^(?:SOLAPI_|MESSAGING_|ADMIN_)/.test(key) || /^EVENTOUCH_(?:MESSAGE_|DEV_|PUBLIC_URL|MAIL_|SMTP_)/.test(key)) delete process.env[key];
}
process.env.EVENTOUCH_SMS_MOCK = '1';
const root = path.resolve(__dirname, '..');
const requireRepo = createRequire(path.join(root, 'package.json'));
const { startAuditFixture } = requireRepo('./scripts/audit-fixture.cjs');
const { chromium } = requireRepo('playwright');
const axeSource = requireRepo('axe-core').source;
const out = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'qa-schedule')
  : defaultCaptureDir(`qa-schedule-${runStamp()}`);
const snapshot = async (page, name) => {
  const target = path.join(out, `${name}.png`);
  if (fs.existsSync(target)) throw new Error(`refusing to overwrite ${target}`);
  await page.screenshot({ path: target, fullPage: true });
};

(async () => {
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  const browser = await chromium.launch({ headless: true });
  try {
    const db = f.harness.database;
    const event = (await db.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    event.features = [...new Set([...event.features, 'qa'])];
    event.stage = 'READY';
    await db.query('UPDATE events SET payload=$2 WHERE id=$1', [f.eventId, event]);
    const workspace = (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    for (const person of workspace.participants.slice(0, 2)) {
      person.status = 'APPROVED'; person.revoked = false;
      person.ticket = crypto.randomBytes(32).toString('base64url');
      person.ticketExpiresAt = new Date(Date.now() + 86400000).toISOString();
    }
    await db.query('UPDATE event_workspaces SET payload=$2 WHERE event_id=$1', [f.eventId, workspace]);
    const [owner, other] = workspace.participants;
    const call = (command, payload, bearer) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', ...(bearer ? { bearer } : { cookie: f.manager.cookie }),
      body: { commandId: crypto.randomUUID(), command, payload },
    });
    const module = (await call('module.save', { type: 'qa', title: '질문 검증' })).json.module;
    assert.equal((await call('module.status', { id: module.id, status: 'OPEN' })).status, 200);
    const mine = (await call('question.submit', { moduleId: module.id, text: '나의 기존 질문' }, owner.ticket)).json.question;
    const theirs = (await call('question.submit', { moduleId: module.id, text: '다른 참가자 질문' }, other.ticket)).json.question;
    assert.equal((await call('question.manage', { id: theirs.id, answer: '다른 답변', approved: true })).status, 200);

    const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await guestContext.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: owner.ticket });
    const guest = await guestContext.newPage();
    await guest.goto(`${f.baseUrl}/event/${f.slug}/engage`, { waitUntil: 'networkidle' });
    await guest.locator('li').filter({ hasText: '나의 기존 질문' }).last().waitFor();
    await snapshot(guest, 'attendee-before-edit');

    const managerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await managerContext.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.split('=')[1]), domain: '127.0.0.1', path: '/' }]);
    const manager = await managerContext.newPage();
    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}`, { waitUntil: 'networkidle' });
    // Reopened 2026-11-20: 운영 현황의 준비 확인이 한 줄 문구('안내 발송 · 선택 사항')에서 제목 + 상태 알약('선택') + 설명 줄로 나뉘었다. 같은 사실을 한 행 안에서 확인한다.
    const messageRow = manager.getByRole('listitem').filter({ has: manager.getByText('안내 발송', { exact: true }) });
    await messageRow.getByText('선택', { exact: true }).waitFor();
    await messageRow.getByText('미연결 · 실제 발송 불가', { exact: true }).waitFor();
    assert.equal(await manager.getByRole('link', { name: '발송 확인', exact: true }).count(), 1);
    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}/programs`, { waitUntil: 'networkidle' });
    await manager.getByRole('heading', { name: '질문 검증' }).waitFor();
    // Moderation sits in the review drawer behind the one doorway.
    await manager.getByRole('button', { name: /^검토할 것/ }).click();
    await manager.locator(`#review-question-${mine.id}`).waitFor();
    await snapshot(manager, 'operator-before-edit');
    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
    await manager.getByText(/발송 연결 ·/).first().click();
    await snapshot(manager, 'schedule-before');
    // Only the author has an edit control. Approval-pending questions save directly.
    const ownRow = guest.locator('li').filter({ hasText: '나의 기존 질문' }).last();
    const otherRow = guest.locator('li').filter({ hasText: '다른 참가자 질문' }).last();
    assert.equal(await ownRow.getByText('내 질문 수정', { exact: true }).count(), 1);
    assert.equal(await otherRow.getByText('내 질문 수정', { exact: true }).count(), 0);
    await ownRow.getByText('내 질문 수정', { exact: true }).focus();
    await guest.keyboard.press('Enter');
    await ownRow.getByLabel('수정할 질문').fill('승인 전 수정 질문');
    await snapshot(guest, 'attendee-edit');
    guest.on('response', async response => {
      if (response.request().method() === 'POST' && response.url().includes('/commands')) {
        const body = response.request().postDataJSON();
        if (body.command === 'question.edit') console.log('question edit response', response.status(), await response.json().catch(() => null));
      }
    });
    await ownRow.getByRole('button', { name: '질문 저장' }).click();
    try { await guest.locator('li').filter({ hasText: '승인 전 수정 질문' }).last().waitFor({ timeout: 8000 }); }
    catch (error) { await snapshot(guest, 'edit-failure'); console.log('edit failure text:', (await guest.locator('main').innerText()).slice(-2500)); throw error; }

    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}/programs`, { waitUntil: 'networkidle' });
    // Moderation sits in the review drawer behind the one doorway.
    await manager.getByRole('button', { name: /^검토할 것/ }).click();
    const reviewRow = manager.locator(`#review-question-${mine.id}`);
    await reviewRow.getByRole('button').first().click();
    await reviewRow.getByLabel(/질문에 답변$/).fill('유지할 답변');
    await reviewRow.getByRole('button', { name: '답변하고 공개' }).click();
    await manager.getByText('답변을 저장하고 질문을 공개했습니다.').waitFor();
    await guest.reload({ waitUntil: 'networkidle' });
    const approvedRow = guest.locator('li').filter({ hasText: '승인 전 수정 질문' }).last();
    await approvedRow.getByText('내 질문 수정', { exact: true }).click();
    await approvedRow.getByLabel('수정할 질문').fill('공개 후 수정안');
    // Closing a dirty edit by navigation must offer a chance to stay.
    const leaveWarning = guest.waitForEvent('dialog').then(async dialog => {
      const message = dialog.message();
      await dialog.dismiss();
      return message;
    });
    await guest.getByRole('link', { name: '← 참가 메뉴로' }).click({ noWaitAfter: true });
    assert.match(await leaveWarning, /작성 중인 입력/);
    assert.equal(await approvedRow.getByLabel('수정할 질문').inputValue(), '공개 후 수정안');
    const guestAttempts = [];
    await guest.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'question.edit') return route.continue();
      guestAttempts.push(body);
      if (guestAttempts.length === 1) { await route.fetch(); return route.abort('failed'); }
      if (guestAttempts.length === 2) return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"잠시 후 다시 시도하세요"}' });
      return route.continue();
    });
    await approvedRow.getByRole('button', { name: '수정안 제출' }).click();
    await guest.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await guest.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await guest.getByText(/수정안 승인 대기: 공개 후 수정안/).waitFor();
    assert.deepEqual(guestAttempts[0], guestAttempts[1]);
    assert.deepEqual(guestAttempts[0], guestAttempts[2]);
    // A pending edit is reviewed on the content's own row; the drawer's 수정안 확인 hands it over.
    const openEditReview = async () => {
      await manager.getByRole('button', { name: /^검토할 것/ }).click();
      await manager.locator(`#review-question-${mine.id}`).getByRole('button', { name: '수정안 확인' }).click();
    };
    const publicBefore = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}`);
    const publicQuestion = publicBefore.json.workspace.questions.find(q => q.id === mine.id);
    assert.equal(publicQuestion.text, '승인 전 수정 질문');
    assert.equal(publicQuestion.answer, '유지할 답변');
    assert.equal('pendingEdit' in publicQuestion, false);

    await manager.reload({ waitUntil: 'networkidle' });
    await openEditReview();
    await manager.getByText('수정 후: 공개 후 수정안').waitFor();
    await snapshot(manager, 'operator-pending-edit');
    for (const page of [guest, manager]) {
      await page.addScriptTag({ content: axeSource });
      const results = await page.evaluate(async () => window.axe.run());
      assert.deepEqual(results.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id), []);
    }
    const managerAttempts = [];
    await manager.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'question.edit.approve') return route.continue();
      managerAttempts.push(body);
      if (managerAttempts.length === 1) { await route.fetch(); return route.abort('failed'); }
      if (managerAttempts.length === 2) return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"잠시 후 다시 시도하세요"}' });
      return route.continue();
    });
    await manager.getByRole('button', { name: '수정안 승인', exact: true }).click();
    await manager.getByRole('button', { name: '원래 승인 재확인' }).click();
    await manager.getByRole('button', { name: '원래 승인 재확인' }).click();
    await manager.getByText('수정안을 승인했습니다. 기존 답변은 유지됩니다.').waitFor();
    assert.deepEqual(managerAttempts[0], managerAttempts[1]);
    assert.deepEqual(managerAttempts[0], managerAttempts[2]);
    const publicAfter = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}`);
    assert.equal(publicAfter.json.workspace.questions.find(q => q.id === mine.id).text, '공개 후 수정안');
    assert.equal(publicAfter.json.workspace.questions.find(q => q.id === mine.id).answer, '유지할 답변');

    // Reject a subsequent proposal, preserving the published answer and making
    // the reason visible only to the author. Exercise lost response + 429 with
    // exactly the same id and payload, then revise the rejected proposal.
    await guest.reload({ waitUntil: 'networkidle' });
    const acceptedRow = guest.locator('li').filter({ hasText: '공개 후 수정안' }).last();
    await acceptedRow.getByText('내 질문 수정', { exact: true }).click();
    await acceptedRow.getByLabel('수정할 질문').fill('다시 검토할 수정안');
    await acceptedRow.getByRole('button', { name: '수정안 제출' }).click();
    await guest.getByText('수정안 승인 대기: 다시 검토할 수정안').waitFor();
    await manager.reload({ waitUntil: 'networkidle' });
    await openEditReview();
    const rejectRow = manager.locator(`#moderation-question-${mine.id}`);
    await manager.waitForFunction((id) => document.activeElement?.id === `moderation-question-${id}`, mine.id);
    await rejectRow.getByText('수정안 반려', { exact: true }).focus();
    await manager.keyboard.press('Enter');
    const reasonInput = rejectRow.getByLabel('반려 사유');
    await reasonInput.waitFor();
    await rejectRow.getByRole('button', { name: '사유를 전달하고 반려' }).click();
    assert.equal(await reasonInput.evaluate(el => el.validity.valueMissing), true);
    await reasonInput.fill('   ');
    await rejectRow.getByRole('button', { name: '사유를 전달하고 반려' }).click();
    await rejectRow.getByText('반려 사유를 입력하세요.', { exact: true }).waitFor();
    assert.equal(await reasonInput.evaluate(el => document.activeElement === el), true);
    // A concurrent replacement must not inherit a reason written for the old proposal.
    await reasonInput.fill('이전 수정안에만 해당하는 사유');
    assert.equal(await rejectRow.getByText('반려 사유를 입력하세요.', { exact: true }).count(), 0);
    if (!await acceptedRow.getByLabel('수정할 질문').isVisible()) {
      await acceptedRow.getByText('수정안 다시 작성', { exact: true }).click();
    }
    await acceptedRow.getByLabel('수정할 질문').fill('새로 바뀐 수정안');
    await acceptedRow.getByRole('button', { name: '수정안 제출' }).click();
    await guest.getByText('수정안 승인 대기: 새로 바뀐 수정안').waitFor();
    await acceptedRow.getByLabel('수정할 질문').fill('보존할 내 초안');
    await acceptedRow.getByText('수정안 다시 작성', { exact: true }).click();
    await acceptedRow.getByText('수정안 다시 작성', { exact: true }).click();
    assert.equal(await acceptedRow.getByLabel('수정할 질문').inputValue(), '보존할 내 초안', 'closing a disclosure preserves an unsent draft');
    await manager.getByRole('button', { name: '새로고침', exact: true }).click();
    await rejectRow.getByText('수정 후: 새로 바뀐 수정안').waitFor();
    assert.equal(await reasonInput.inputValue(), '', 'a new proposal does not inherit the previous draft reason');
    await reasonInput.fill('행사 일정을 확인해 주세요');
    await snapshot(manager, 'operator-reject-reason');
    for (const width of [320, 390, 1280]) {
      await manager.setViewportSize({ width, height: 844 });
      assert.equal(await manager.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      for (const control of [rejectRow.getByText('수정안 반려', { exact: true }), reasonInput, rejectRow.getByRole('button', { name: '사유를 전달하고 반려' })]) {
        const box = await control.boundingBox();
        assert.ok(box && box.width >= 44 && box.height >= 44, `rejection control target at ${width}px`);
      }
      if (width === 1280) await snapshot(manager, 'operator-reject-desktop');
    }
    await manager.setViewportSize({ width: 390, height: 844 });
    await manager.addScriptTag({ content: axeSource });
    const rejectAxe = await manager.evaluate(async () => window.axe.run());
    assert.deepEqual(rejectAxe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id), []);
    const rejectAttempts = [];
    await manager.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'question.edit.reject') return route.continue();
      rejectAttempts.push(body);
      if (rejectAttempts.length === 1) { await route.fetch(); return route.abort('failed'); }
      if (rejectAttempts.length === 2) return route.fulfill({ status: 429, contentType: 'application/json', body: '{"error":"잠시 후 다시 시도하세요"}' });
      return route.continue();
    });
    await rejectRow.getByRole('button', { name: '사유를 전달하고 반려' }).click();
    await manager.getByRole('button', { name: '원래 반려 재확인' }).click();
    await manager.getByRole('button', { name: '원래 반려 재확인' }).click();
    await manager.getByText('수정안을 반려했습니다. 작성자는 참여 화면에서 사유를 확인할 수 있습니다.').waitFor();
    assert.deepEqual(rejectAttempts[0], rejectAttempts[1]);
    assert.deepEqual(rejectAttempts[0], rejectAttempts[2]);
    const rejectedPublic = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}`);
    const rejectedOther = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}/ticket`, { bearer: other.ticket });
    for (const view of [rejectedPublic, rejectedOther]) {
      const question = view.json.workspace.questions.find(q => q.id === mine.id);
      assert.equal(question.text, '공개 후 수정안');
      assert.equal(question.answer, '유지할 답변');
      assert.equal('editRejection' in question, false);
      assert.equal(JSON.stringify(question).includes('행사 일정을 확인해 주세요'), false);
    }
    // A server refresh while the author is typing must keep the local draft
    // and require acknowledgement before using the newer question state.
    await acceptedRow.getByRole('button', { name: '좋아요', exact: true }).click();
    await acceptedRow.getByText('반려 사유: 행사 일정을 확인해 주세요').waitFor();
    await acceptedRow.getByText(/질문 상태가 바뀌었습니다/).waitFor();
    assert.equal(await acceptedRow.getByLabel('수정할 질문').inputValue(), '보존할 내 초안');
    assert.equal(await acceptedRow.getByRole('button', { name: '수정안 제출' }).isDisabled(), true);
    await snapshot(guest, 'attendee-draft-stale');
    await acceptedRow.getByRole('button', { name: '현재 질문에 맞춰 계속 작성' }).click();
    assert.equal(await acceptedRow.getByLabel('수정할 질문').inputValue(), '보존할 내 초안');
    assert.equal(await acceptedRow.getByRole('button', { name: '수정안 제출' }).isEnabled(), true);
    await guest.reload({ waitUntil: 'networkidle' });
    const rejectedRow = guest.locator('li').filter({ hasText: '수정안이 반려되었습니다.' }).last();
    await rejectedRow.getByText('반려 사유: 행사 일정을 확인해 주세요').waitFor();
    await rejectedRow.getByText('반려된 수정안: 새로 바뀐 수정안').waitFor();
    await snapshot(guest, 'attendee-rejected');
    await guest.setViewportSize({ width: 320, height: 844 });
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    const revisionTarget = await rejectedRow.getByText('수정안 고쳐 다시 제출', { exact: true }).boundingBox();
    assert.ok(revisionTarget && revisionTarget.width >= 44 && revisionTarget.height >= 44);
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.addScriptTag({ content: axeSource });
    const attendeeRejectAxe = await guest.evaluate(async () => window.axe.run());
    assert.deepEqual(attendeeRejectAxe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id), []);
    await rejectedRow.getByText('수정안 고쳐 다시 제출', { exact: true }).click();
    assert.equal(await rejectedRow.getByLabel('수정할 질문').inputValue(), '새로 바뀐 수정안');
    await rejectedRow.getByLabel('수정할 질문').fill('다시 고친 질문');
    await rejectedRow.getByRole('button', { name: '수정안 제출' }).click();
    await guest.getByText('수정안 승인 대기: 다시 고친 질문').waitFor();
    assert.equal(await guest.getByText('반려 사유: 행사 일정을 확인해 주세요').count(), 0);
    const revisedView = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}/ticket`, { bearer: owner.ticket });
    assert.equal(revisedView.json.workspace.questions.find(q => q.id === mine.id).editRejection, null);
    assert.equal(revisedView.json.workspace.questions.find(q => q.id === mine.id).pendingEdit.text, '다시 고친 질문');

    const latest = (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    latest.messages.unshift({ id: 'qa-audit-schedule', title: '예약 점검', status: 'SCHEDULED', channel: 'SMS', body: '{{럭키번호}}',
      scheduled: '2020-01-01T00:00:00Z', at: '2020-01-01T00:00:00Z', recipientIds: [owner.id], deliveries: [], simulate: false, attempts: 0 });
    await db.query('UPDATE event_workspaces SET payload=$2 WHERE event_id=$1', [f.eventId, latest]);
    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
    await manager.getByText(/발송 연결 ·/).first().click();
    await manager.getByText('이 서버의 예약 자동 실행 설정이 꺼져 있습니다.', { exact: false }).first().waitFor();
    await manager.getByRole('button', { name: '예약 점검 상세', exact: true }).click();
    await manager.getByText(/수신자 1명의 럭키번호가 배정되지 않았습니다/).waitFor();
    await snapshot(manager, 'schedule-after');
    assert.ok((await manager.locator('#campaign-detail-qa-audit-schedule').innerText()).includes('수동 실행'));
    await manager.goto(`${f.baseUrl}/console/events/${f.eventId}/messages?to=${encodeURIComponent(owner.id)}`, { waitUntil: 'networkidle' });
    await manager.locator('#campaign-title').fill('새 자동 예약 검증');
    await manager.locator('#campaign-body').fill('합성 안내');
    await messageStep(manager, 3);
    // Reopened 2026-11-23: the 예약 details is the 보낼 때 radio zone; pick 날짜·시각 지정 first.
    await (await chooseScheduleDate(manager)).fill('2099-01-16T10:00');
    const manual = manager.getByRole('radio', { name: '수동 실행', exact: true });
    const automatic = manager.getByRole('radio', { name: '자동 실행', exact: true });
    assert.equal(await manual.isChecked(), true);
    await automatic.check();
    await manager.getByLabel('모의 발송으로 기록', { exact: false }).check();
    await manager.getByLabel('모의 발송으로 기록', { exact: false }).uncheck();
    assert.equal(await manual.isChecked(), true, 'simulation clears the prior auto choice');
    await automatic.check();
    await manager.locator('#campaign-submit').click();
    await manager.getByText(/나중에 설정을 켜면 발송될 수 있습니다/).last().waitFor();
    await snapshot(manager, 'schedule-auto-review');
    await manager.addScriptTag({ content: axeSource });
    const scheduleAxe = await manager.evaluate(async () => window.axe.run());
    assert.deepEqual(scheduleAxe.violations.filter(v => v.impact === 'serious' || v.impact === 'critical').map(v => v.id), []);
    for (const radio of [manual, automatic]) {
      const box = await radio.locator('xpath=..').boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, 'schedule choice has a 44px touch target');
    }
    await manager.getByRole('button', { name: '예약 등록한다', exact: true }).click();
    await manager.getByText('새 자동 예약 검증', { exact: true }).first().waitFor();
    const stored = (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    assert.equal(stored.messages.find(item => item.title === '새 자동 예약 검증').scheduleMode, 'AUTO');
    assert.equal(stored.messages.find(item => item.title === '새 자동 예약 검증').autoScheduleIntent, 'confirmed-v1');
    assert.equal(stored.messages.find(item => item.id === 'qa-audit-schedule').scheduleMode, undefined);
    for (const page of [guest, manager]) assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    console.log('[qa-schedule-audit] author edit/revision, approval/rejection, response-loss replay, public privacy and schedule status passed');
  } finally {
    await browser.close();
    await f.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
