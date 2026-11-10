'use strict';

// Real browser/API/PostgreSQL on a private synthetic fixture. The two tabs
// intentionally share one participant; no real attendees or delivery exist.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'question-like');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const db = f.harness.database;
    const workspace = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const people = (await workspace()).participants.filter((person) => person.status === 'APPROVED' && person.ticket);
    assert.ok(people.length >= 2);
    const call = (command, payload, ticket, commandId = crypto.randomUUID()) => f.helpers.requestJson(
      f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', ...(ticket ? { bearer: ticket } : { cookie: f.manager.cookie }), body: { commandId, command, payload },
      });
    const event = (await db.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    assert.equal((await call('event.features', { features: [...new Set([...event.features, 'qa'])] })).status, 200);
    const created = await call('module.save', { type: 'qa', title: '합성 질문과 좋아요' });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const moduleId = created.json.module.id;
    assert.equal((await call('module.status', { id: moduleId, status: 'OPEN' })).status, 200);
    const submitted = await call('question.submit', { moduleId, text: '합성 질문에 공감하시나요?' }, people[1].ticket);
    assert.equal(submitted.status, 201, JSON.stringify(submitted.json));
    const questionId = submitted.json.question.id;
    assert.equal((await call('question.manage', { id: questionId, answer: '합성 답변입니다.', approved: true })).status, 200);
    const savedLikes = async () => (await workspace()).questions.find((question) => question.id === questionId).likes;
    browser = await launchBrowser();
    const contexts = [];
    const open = async (person = people[0], intercept) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
      contexts.push(context);
      await context.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: person.ticket });
      const page = await context.newPage();
      page.on('dialog', (dialog) => dialog.accept());
      const errors = []; page.on('pageerror', (error) => errors.push(error.message));
      if (intercept) await page.route('**/api/public/events/*/ticket', intercept);
      await page.goto(`${f.baseUrl}/event/${f.slug}/engage`, { waitUntil: 'networkidle' });
      const heading = page.getByRole('heading', { name: '합성 질문과 좋아요', exact: true });
      await heading.waitFor();
      const section = page.locator('section').filter({ has: heading });
      const details = section.locator('details').first(); if (!(await details.evaluate((el) => el.open))) await details.locator('summary').click();
      const row = section.locator('li').filter({ has: page.locator(`#like-${questionId}`) });
      await row.waitFor();
      return { context, page, row, errors };
    };
    const button = (screen) => screen.row.locator(`#like-${questionId}`);
    const first = await open(), second = await open();
    phase = 'keyboard reaction and responsive states';
    assert.equal(await button(first).getAttribute('aria-pressed'), 'false');
    assert.equal(await button(second).getAttribute('aria-pressed'), 'false');
    await button(first).focus(); await first.page.keyboard.press('Enter');
    await first.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'true', questionId);
    assert.deepEqual(await savedLikes(), [people[0].id]);
    assert.equal(await button(second).getAttribute('aria-pressed'), 'false');
    for (const width of [320, 390, 1280]) {
      await first.page.setViewportSize({ width, height: 900 });
      assert.equal(await first.page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width} overflow`);
      await first.page.evaluate(axe);
      assert.deepEqual(await first.page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
      await first.page.screenshot({ path: path.join(out, `liked-${width}.png`), fullPage: true });
    }

    phase = 'stale second tab must review, not toggle';
    const requests = [];
    await second.page.route('**/api/events/*/commands', (route) => {
      const body = route.request().postDataJSON(); if (body.command === 'question.like') requests.push(body);
      return route.continue();
    });
    await button(second).click();
    const conflict = second.row.locator(`#like-conflict-${questionId}`);
    await conflict.waitFor();
    assert.equal(await button(second).isDisabled(), true);
    await second.row.getByText('좋아요 상태 확인 필요', { exact: false }).waitFor();
    assert.equal(await second.row.getByText(/좋아요 0개/).count(), 0, 'stale count must not look current');
    assert.deepEqual(await savedLikes(), [people[0].id]);
    assert.deepEqual(requests[0].payload, { id: questionId, expectedLiked: false, liked: true, expectedQuestionText: '합성 질문에 공감하시나요?' });
    await second.page.screenshot({ path: path.join(out, 'conflict-390.png'), fullPage: true });

    phase = 'failed and incomplete latest reads';
    let fault = '';
    await second.page.route('**/api/public/events/*/ticket', async (route) => {
      const mode = fault; fault = '';
      if (mode === '503') return route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
      if (mode === 'partial') {
        const response = await route.fetch(); const data = await response.json();
        delete data.workspace.questions.find((question) => question.id === questionId).likedByMe;
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    for (const mode of ['503', 'partial']) {
      fault = mode;
      const response = second.page.waitForResponse((value) => /\/ticket$/.test(value.url()));
      await second.row.getByRole('button', { name: '최신 질문과 좋아요 확인' }).click(); await response;
      await second.row.getByText('최신 좋아요 상태를 확인하지 못했습니다.', { exact: false }).waitFor();
      await second.row.getByRole('button', { name: '최신 질문과 좋아요 확인' }).waitFor({ state: 'visible' });
      assert.equal(await button(second).isDisabled(), true);
      assert.deepEqual(await savedLikes(), [people[0].id]);
    }
    phase = 'stalled response body times out';
    await second.page.evaluate(() => {
      const original = window.fetch;
      window.fetch = function(input, init) {
        if (typeof input === 'string' && /\/ticket$/.test(input) && window.__likeStall) {
          window.__likeStall = false;
          return Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'application/json' } }));
        }
        return original.call(this, input, init);
      };
      window.__likeStall = true;
    });
    await second.row.getByRole('button', { name: '최신 질문과 좋아요 확인' }).click();
    await second.row.getByRole('button', { name: '확인 중…' }).waitFor();
    await second.row.getByRole('button', { name: '최신 질문과 좋아요 확인' }).waitFor({ timeout: 16000 });
    await second.row.getByText('최신 좋아요 상태를 확인하지 못했습니다.', { exact: false }).waitFor();
    assert.equal(await button(second).isDisabled(), true);
    assert.deepEqual(await savedLikes(), [people[0].id]);

    phase = 'explicit read followed by an explicit cancellation';
    const writes = requests.length;
    await second.row.getByRole('button', { name: '최신 질문과 좋아요 확인' }).click();
    await second.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'true', questionId);
    assert.equal(requests.length, writes, 'reading the latest state must not write');
    assert.deepEqual(await savedLikes(), [people[0].id]);
    await button(second).click();
    await second.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'false', questionId);
    assert.deepEqual(await savedLikes(), []);

    phase = 'question wording changes before the reaction';
    const wording = await open();
    const edit = await call('question.edit', { id: questionId, text: '수정 승인된 합성 질문입니다.', expectedText: '합성 질문에 공감하시나요?', expectedPendingId: '', expectedApproved: true }, people[1].ticket);
    assert.equal(edit.status, 200, JSON.stringify(edit.json));
    const approval = await call('question.edit.approve', { id: questionId, expectedEditId: edit.json.editId, expectedText: '합성 질문에 공감하시나요?', expectedAnswer: '합성 답변입니다.', expectedNewText: '수정 승인된 합성 질문입니다.' });
    assert.equal(approval.status, 200, JSON.stringify(approval.json));
    assert.equal((await call('question.manage', { id: questionId, answer: '변경된 합성 답변입니다.', approved: true, expectedText: '수정 승인된 합성 질문입니다.' })).status, 200);
    await button(wording).click();
    await wording.row.locator(`#like-conflict-${questionId}`).waitFor();
    await wording.row.getByText('위 질문은 확인 전 내용입니다.', { exact: false }).waitFor();
    assert.deepEqual(await savedLikes(), []);
    await wording.page.screenshot({ path: path.join(out, 'changed-question-390.png'), fullPage: true });
    await wording.row.getByRole('button', { name: '최신 질문과 좋아요 확인' }).click();
    await wording.row.getByText('수정 승인된 합성 질문입니다.', { exact: false }).waitFor();
    await wording.row.getByText('변경된 합성 답변입니다.', { exact: false }).waitFor();
    assert.deepEqual(await savedLikes(), [], 'reviewing the changed question does not react');
    await button(wording).click();
    await wording.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'true', questionId);
    assert.deepEqual(await savedLikes(), [people[0].id]);
    await button(wording).click();
    await wording.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'false', questionId);
    assert.deepEqual(await savedLikes(), []);

    phase = 'committed request loses response and replays the same receipt';
    const lost = await open(); let loss = true; const attempts = [];
    await lost.page.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON();
      if (body.command !== 'question.like') return route.continue();
      attempts.push(body);
      if (loss) { loss = false; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed'); }
      return route.continue();
    });
    await button(lost).click();
    await lost.page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    assert.deepEqual(await savedLikes(), [people[0].id]);
    await lost.page.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await lost.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'true', questionId);
    assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1]);
    assert.deepEqual(await savedLikes(), [people[0].id]);

    phase = 'receipt lookup survives a reload after lost cancellation';
    loss = true;
    await button(lost).click();
    await lost.page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    assert.deepEqual(await savedLikes(), []);
    await lost.page.reload({ waitUntil: 'networkidle' });
    await lost.page.getByRole('heading', { name: '서버 처리 결과 확인' }).waitFor();
    const numberOfAttempts = attempts.length;
    await lost.page.getByRole('button', { name: '서버 처리 확인', exact: true }).click();
    await lost.page.getByText('서버에 처리가 반영된 것을 확인했습니다.', { exact: false }).waitFor();
    assert.equal(attempts.length, numberOfAttempts, 'receipt lookup must not resend');
    await lost.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'false', questionId);
    assert.deepEqual(await savedLikes(), []);

    phase = 'unconfirmed guarded success stays recoverable';
    const incompleteSuccess = await open(); let incomplete = true; const incompleteAttempts = [];
    await incompleteSuccess.page.route('**/api/events/*/commands', async (route) => {
      const body = route.request().postDataJSON();
      if (body.command !== 'question.like') return route.continue();
      incompleteAttempts.push(body);
      if (incomplete) {
        incomplete = false; const response = await route.fetch(); const data = await response.json();
        delete data.confirmedQuestionText;
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    await button(incompleteSuccess).click();
    await incompleteSuccess.page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    assert.deepEqual(await savedLikes(), [people[0].id]);
    await incompleteSuccess.page.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await incompleteSuccess.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'true', questionId);
    assert.equal(incompleteAttempts.length, 2); assert.deepEqual(incompleteAttempts[0], incompleteAttempts[1]);
    await button(incompleteSuccess).click();
    await incompleteSuccess.page.waitForFunction((id) => document.getElementById(`like-${id}`)?.getAttribute('aria-pressed') === 'false', questionId);
    assert.deepEqual(await savedLikes(), []);

    phase = 'old server without personal reaction field';
    const legacy = await open(people[0], async (route) => {
      const response = await route.fetch(); const data = await response.json();
      for (const question of data.workspace.questions) delete question.likedByMe;
      return route.fulfill({ response, json: data });
    });
    assert.equal(await button(legacy).isDisabled(), true);
    await legacy.row.getByText('좋아요 상태를 확인할 수 없습니다.', { exact: false }).waitFor();
    assert.deepEqual(await savedLikes(), []);
    await legacy.page.screenshot({ path: path.join(out, 'missing-state-390.png'), fullPage: true });

    phase = 'accurate large aggregate without exposing identities';
    const many = await workspace();
    many.questions.find((question) => question.id === questionId).likes.push(people[0].id, ...Array.from({ length: 1001 }, (_, index) => `aggregate-only-${index}`));
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(many)]);
    const large = await open();
    await large.row.getByText(/좋아요 1002개/).waitFor();
    assert.equal(await button(large).getAttribute('aria-pressed'), 'true');
    const publicResponse = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}`);
    const publicQuestion = publicResponse.json.workspace.questions.find((question) => question.id === questionId);
    assert.equal(publicQuestion.likedCount, 1002); assert.equal(publicQuestion.likes.length, 1000);
    assert.equal(Object.hasOwn(publicQuestion, 'likedByMe'), false);
    assert.equal(JSON.stringify(publicQuestion).includes('aggregate-only-'), false);
    for (const screen of [first, second, wording, lost, incompleteSuccess, legacy, large]) assert.deepEqual(screen.errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
      synthetic: true, responsiveAndAxe: [320, 390, 1280], keyboard: true, staleActionBlocked: true, staleCountNotPresentedAsCurrent: true,
      explicitReadBeforeNewAction: true, failedAndIncompleteReadsPreserve: true, stalledBodyTimesOut: true,
      changedQuestionRequiresReview: true, lostReceiptReplay: true, receiptLookupAfterReload: true,
      unconfirmedGuardedSuccessRetainsReceipt: true,
      missingViewerStateBlocks: true, accurateCountAbove1000: true, anonymousIdentifiersHidden: true,
      before: 'qa-like-before-v1/qa-like-before/before-390.png',
    }, null, 2), { mode: 0o600 });
    console.log('Question reactions: state, stale tabs, recovery, accessibility and count verified');
    for (const context of contexts) await context.close();
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(`Question reaction audit failed at ${phase}:`, error); process.exitCode = 1; });
