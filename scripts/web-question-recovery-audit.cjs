'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'question-recovery-before' : 'question-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const db = fixture.harness.database;
    const event = (await db.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    event.features = [...new Set([...event.features, 'qa'])]; event.stage = 'READY';
    await db.query('UPDATE events SET payload=$2 WHERE id=$1', [fixture.eventId, event]);
    const workspace = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const seeded = await workspace();
    const person = seeded.participants[0];
    person.status = 'APPROVED'; person.revoked = false;
    person.ticket = crypto.randomBytes(32).toString('base64url');
    person.ticketExpiresAt = new Date(Date.now() + 86400000).toISOString();
    await db.query('UPDATE event_workspaces SET payload=$2 WHERE event_id=$1', [fixture.eventId, seeded]);
    const call = (command, payload, bearer) => fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', ...(bearer ? { bearer } : { cookie: fixture.manager.cookie }), body: { commandId: crypto.randomUUID(), command, payload },
    });
    const module = (await call('module.save', { type: 'qa', title: '합성 질문 관리' })).json.module;
    assert.equal((await call('module.status', { id: module.id, status: 'OPEN' })).status, 200);
    const questions = [];
    for (let i = 1; i <= 3; i++) questions.push((await call('question.submit', { moduleId: module.id, text: `합성 비공개 질문 ${i}` }, person.ticket)).json.question);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/programs`, { waitUntil: 'networkidle' });
    await page.getByText('진행·응답 관리', { exact: true }).click();
    const row = (question) => page.locator(`#moderation-question-${question.id}`);
    let mode = 'lost';
    const ids = [];
    let editMode = 'pass';
    const editIds = [];
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (body.command === 'question.edit.approve') {
        editIds.push(body.commandId);
        if (editMode === 'lost') {
          const response = await route.fetch();
          assert.ok(response.status() >= 200 && response.status() < 300, 'edit approval committed before response loss');
          editMode = 'pass';
          return route.abort('failed');
        }
        return route.continue();
      }
      if (body.command !== 'question.manage') return route.continue();
      ids.push(body.commandId);
      if (mode === 'lost' || mode === 'malformed') {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, 'question committed before response fault');
        if (mode === 'lost') { mode = 'rejected'; return route.abort('failed'); }
        mode = 'pass';
        return route.fulfill({ status: 200, contentType: 'application/json', body: '{"question":{"id":"wrong"}}' });
      }
      if (mode === 'rejected') { mode = 'pass'; return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' }); }
      return route.continue();
    });
    phase = 'lost question result and later rejection';
    await row(questions[0]).getByLabel('답변', { exact: true }).fill('합성 답변 1');
    await row(questions[0]).getByRole('button', { name: '승인·공개' }).click();
    await row(questions[0]).getByRole('alert').waitFor();
    await page.screenshot({ path: path.join(out, 'unconfirmed-1280.png'), fullPage: true });
    if (before) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      console.log('Question recovery before capture passed');
      return;
    }
    const recovery = page.getByRole('region', { name: '질문 처리 확인' });
    await recovery.waitFor();
    assert.equal(await row(questions[0]).getByLabel('답변', { exact: true }).isDisabled(), true);
    await recovery.getByRole('button', { name: '원래 질문 처리 다시 확인' }).click();
    await row(questions[0]).getByRole('alert').filter({ hasText: /확인하지 못했습니다/ }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.getByLabel('진행 상태별 보기').selectOption('CLOSED');
    assert.equal(await row(questions[0]).count(), 0, 'the recovery survives a filter that hides its original row');
    await recovery.getByRole('button', { name: '원래 질문 처리 다시 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(ids.slice(0, 3)).size, 1);
    const confirmed = (await workspace()).questions.find((item) => item.id === questions[0].id);
    assert.equal(confirmed.answer, '합성 답변 1'); assert.equal(confirmed.approved, true);

    phase = 'status-only approval of a question edit';
    assert.equal((await call('question.edit', { id: questions[0].id, text: '합성 질문 수정안', expectedText: questions[0].text, expectedPendingId: '', expectedApproved: true }, person.ticket)).status, 200);
    await page.getByLabel('진행 상태별 보기').selectOption('');
    await page.getByRole('button', { name: '새로고침', exact: true }).click();
    await page.getByRole('button', { name: '질문 수정안 1건 검토' }).click();
    await row(questions[0]).getByText('수정 후: 합성 질문 수정안').waitFor();
    editMode = 'lost';
    await row(questions[0]).getByRole('button', { name: '수정안 승인' }).click();
    const approval = page.getByText(/수정안 승인 결과를 확인하지 못했습니다/).locator('..');
    await approval.getByRole('button', { name: '서버 처리 확인' }).click();
    await approval.waitFor({ state: 'hidden' });
    assert.equal(editIds.length, 1, 'read-only approval check must not re-send');
    assert.equal((await workspace()).questions.find((item) => item.id === questions[0].id).text, '합성 질문 수정안');

    phase = 'status-only recovery';
    await page.getByLabel('질문 상태별 보기').selectOption('all');
    await row(questions[1]).getByLabel('답변', { exact: true }).fill('합성 답변 2');
    mode = 'malformed';
    await row(questions[1]).getByRole('button', { name: '승인·공개' }).click();
    await recovery.waitFor();
    const beforeCheck = ids.length;
    await recovery.getByRole('button', { name: '서버 처리 확인' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(ids.length, beforeCheck);
    assert.equal((await workspace()).questions.find((item) => item.id === questions[1].id).approved, true);

    phase = 'reload stores only the scoped identifier';
    await row(questions[2]).getByLabel('답변', { exact: true }).fill('합성 답변 3');
    mode = 'malformed';
    await row(questions[2]).getByRole('button', { name: '승인·공개' }).click();
    await recovery.waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('question.manage') && !stored.includes('합성 비공개 질문') && !stored.includes('합성 답변'));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    await page.getByText('진행·응답 관리', { exact: true }).click();
    assert.equal(await row(questions[2]).getByLabel('답변', { exact: true }).isDisabled(), true);
    const beforeReloadCheck = ids.length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction((id) => !document.querySelector(`#answer-${id}`)?.disabled, questions[2].id);
    assert.equal(ids.length, beforeReloadCheck);
    assert.equal((await workspace()).questions.find((item) => item.id === questions[2].id).approved, true);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, originalRequestRetained: true, filterIndependent: true, statusOnly: true, noQuestionTextPersisted: true }, null, 2), { mode: 0o600 });
    console.log('Q&A: original question decision survives loss, rejection, filtering and reload');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
