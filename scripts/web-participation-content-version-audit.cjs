'use strict';
const { programSection } = require('./ui-journey-helpers.cjs');
// Actual command path and isolated synthetic PostgreSQL; never sends SMS.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
let stage = 'setup';
const command = (name, payload) => ({ commandId: `content-review-${crypto.randomUUID()}`, command: name, payload });
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'participation-content-version');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const db = f.harness.database;
    const manager = async (name, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: command(name, payload),
    });
    const workspace = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const before = await workspace(); const people = before.participants.filter((person) => person.status === 'APPROVED' && person.ticket);
    assert.ok(people.length >= 3);
    const seedPoll = async (title) => {
      const saved = await manager('module.save', { type: 'poll', title, options: ['예', '아니요'] });
      assert.equal(saved.status, 201, JSON.stringify(saved.json));
      assert.equal((await manager('module.status', { id: saved.json.module.id, status: 'OPEN' })).status, 200);
      return saved.json.module.id;
    };
    const editPoll = async (id, title) => {
      const changed = await manager('module.save', { id, type: 'poll', title, options: ['예', '아니요'] });
      assert.equal(changed.status, 200, JSON.stringify(changed.json));
    };
    browser = await launchBrowser();
    const guest = async (person, viewport = { width: 390, height: 844 }) => {
      const context = await browser.newContext({ viewport, locale: 'ko-KR' });
      await context.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: person.ticket });
      const page = await context.newPage(); page.on('dialog', (dialog) => dialog.dismiss());
      return { context, page };
    };
    const open = async (page, title) => {
      await page.goto(`${f.baseUrl}/event/${f.slug}/engage`, { waitUntil: 'networkidle' });
      await programSection(page, title);
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
      const section = (await programSection(page, title));
      const details = section.locator('details').first();
      if (!(await details.evaluate((node) => node.open))) await details.locator('summary').click();
      return section;
    };
    stage = 'stale question, failed and partial reads, explicit review';
    const id = await seedPoll('합성 질문: 오전이 편한가요?');
    let { context, page } = await guest(people[0]);
    let section = await open(page, '합성 질문: 오전이 편한가요?');
    await section.getByLabel(/^예/).check();
    await editPoll(id, '합성 질문: 오후가 편한가요?');
    await section.getByRole('button', { name: '투표하기' }).click();
    await section.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === id).length, 0);
    assert.equal(await section.getByLabel(/^예/).isChecked(), true, 'draft remains selected');
    assert.equal(await section.getByText('참가 확정 후 제출할 수 있습니다.', { exact: true }).count(), 0, 'approved attendees receive the actual conflict reason');
    await page.waitForFunction(() => document.activeElement?.id?.startsWith('content-conflict-'));
    await page.screenshot({ path: path.join(out, 'conflict-390.png'), fullPage: true });
    let fault = '503';
    await page.route('**/api/public/events/*/ticket', async (route) => {
      if (fault === '503') { fault = 'partial'; return route.fulfill({ status: 503, json: { error: '합성 실패' } }); }
      if (fault === 'partial') {
        fault = 'none'; const response = await route.fetch(); const data = await response.json();
        delete data.workspace.modules.find((item) => item.id === id).contentVersion;
        return route.fulfill({ response, json: data });
      }
      return route.continue();
    });
    for (const unused of ['503', 'partial']) {
      await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
      await section.getByText('최신 참여 내용을 확인하지 못했습니다.', { exact: false }).waitFor();
      assert.equal(await section.getByLabel(/^예/).isChecked(), true);
      assert.equal((await workspace()).responses.filter((item) => item.moduleId === id).length, 0);
    }
    await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
    await section.getByText('합성 질문: 오후가 편한가요?', { exact: false }).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width} overflow`);
      await page.evaluate(axe); assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id)), []);
      await page.screenshot({ path: path.join(out, `review-${width}.png`), fullPage: true });
    }
    await section.getByRole('button', { name: '최신 내용으로 답변 검토' }).click();
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === id).length, 0, 'review never submits');
    section = (await programSection(page, '합성 질문: 오후가 편한가요?'));
    await section.getByRole('button', { name: '투표하기' }).click();
    await section.getByText('이미 제출했습니다.', { exact: false }).waitFor();
    const accepted = (await workspace()).responses.filter((item) => item.moduleId === id);
    assert.equal(accepted.length, 1); assert.equal(accepted[0].contentVersion, 2); assert.equal(accepted[0].answer, '예');
    await context.close();

    stage = 'missing version blocks old server response';
    const oldId = await seedPoll('합성 버전 없는 투표');
    ({ context, page } = await guest(people[1]));
    await page.route('**/api/public/events/*/ticket', async (route) => {
      const response = await route.fetch(); const data = await response.json();
      for (const item of data.workspace.modules) delete item.contentVersion;
      return route.fulfill({ response, json: data });
    });
    section = await open(page, '합성 버전 없는 투표');
    await section.getByText('참여 내용을 확인할 수 없어 제출을 잠시 중단했습니다.', { exact: false }).waitFor();
    assert.equal(await section.getByLabel(/^예/).isDisabled(), true);
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === oldId).length, 0);
    await context.close();

    stage = 'unrelated form reload cannot rebase an unsent answer';
    const event = (await db.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    assert.equal((await manager('event.features', { features: [...new Set([...event.features, 'quiz', 'survey', 'qa'])] })).status, 200);
    const pollId = await seedPoll('합성 이전 질문');
    const quiz = await manager('module.save', { type: 'quiz', title: '합성 별도 퀴즈', answer: '정답' });
    assert.equal(quiz.status, 201); assert.equal((await manager('module.status', { id: quiz.json.module.id, status: 'OPEN' })).status, 200);
    ({ context, page } = await guest(people[2]));
    section = await open(page, '합성 이전 질문'); await section.getByLabel(/^예/).check();
    await editPoll(pollId, '합성 변경 질문');
    const quizSection = (await programSection(page, '합성 별도 퀴즈'));
    const quizDetails = quizSection.locator('details').first(); if (!(await quizDetails.evaluate((node) => node.open))) await quizDetails.locator('summary').click();
    await quizSection.getByLabel('내 답안').fill('정답'); await quizSection.getByRole('button', { name: '답안 제출' }).click();
    await programSection(page, '합성 변경 질문');
    await page.getByRole('heading', { name: '합성 변경 질문', exact: true }).waitFor();
    const changedSection = (await programSection(page, '합성 변경 질문'));
    const changedDetails = changedSection.locator('details').first(); if (!(await changedDetails.evaluate((node) => node.open))) await changedDetails.locator('summary').click();
    await changedSection.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    assert.equal(await changedSection.getByLabel(/^예/).isChecked(), true);
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === pollId).length, 0);
    await changedSection.getByRole('button', { name: '최신 내용으로 답변 검토' }).click();
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === pollId).length, 0);
    await changedSection.getByRole('button', { name: '투표하기' }).click();
    await changedSection.getByText('이미 제출했습니다.', { exact: false }).waitFor();
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === pollId).length, 1);
    await context.close();

    stage = 'removed choices stay visible but cannot be submitted';
    const removedId = await seedPoll('합성 선택지 이전');
    ({ context, page } = await guest(people[3]));
    section = await open(page, '합성 선택지 이전'); await section.getByLabel(/^예/).check();
    assert.equal((await manager('module.save', { id: removedId, type: 'poll', title: '합성 선택지 변경', options: ['다른 선택', '새 선택'] })).status, 200);
    await section.getByRole('button', { name: '투표하기' }).click();
    await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
    await section.getByRole('button', { name: '최신 내용으로 답변 검토' }).click();
    section = (await programSection(page, '합성 선택지 변경'));
    await section.getByText('이전에 고른 ‘예’ 선택지가 없습니다.', { exact: false }).waitFor();
    assert.equal(await section.getByRole('button', { name: '투표하기' }).isDisabled(), true);
    await section.getByLabel(/^다른 선택/).check(); await section.getByRole('button', { name: '투표하기' }).click();
    await section.getByText('이미 제출했습니다.', { exact: false }).waitFor();
    assert.equal((await workspace()).responses.find((item) => item.moduleId === removedId).answer, '다른 선택');
    await context.close();

    stage = 'removed survey answers are retained visibly and excluded';
    const survey = await manager('module.save', { type: 'survey', title: '합성 설문 이전', questions: ['전반 만족', '운영 만족'] });
    assert.equal(survey.status, 201); assert.equal((await manager('module.status', { id: survey.json.module.id, status: 'OPEN' })).status, 200);
    ({ context, page } = await guest(people[4]));
    section = await open(page, '합성 설문 이전');
    await section.getByRole('group', { name: '전반 만족' }).getByLabel('4점').check();
    await section.getByRole('group', { name: '운영 만족' }).getByLabel('2점').check();
    await section.getByLabel('의견 · 선택').fill('유지할 합성 의견');
    assert.equal((await manager('module.save', { id: survey.json.module.id, type: 'survey', title: '합성 설문 변경', questions: ['전반 만족', '식사 만족'] })).status, 200);
    await section.getByRole('button', { name: '만족도 제출' }).click();
    await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
    await section.getByRole('button', { name: '최신 내용으로 답변 검토' }).click();
    section = (await programSection(page, '합성 설문 변경'));
    await section.getByText('운영 만족: 2점', { exact: true }).waitFor();
    assert.equal(await section.getByLabel('의견 · 선택').inputValue(), '유지할 합성 의견');
    assert.equal(await section.getByRole('group', { name: '전반 만족' }).getByLabel('4점').isChecked(), true);
    await section.getByRole('group', { name: '식사 만족' }).getByLabel('3점').check();
    await section.getByRole('button', { name: '만족도 제출' }).click();
    await section.getByText('이미 제출했습니다.', { exact: false }).waitFor();
    const surveyResponse = (await workspace()).responses.find((item) => item.moduleId === survey.json.module.id);
    assert.deepEqual(surveyResponse.ratings, { '전반 만족': 4, '식사 만족': 3 });
    assert.equal(surveyResponse.comment, '유지할 합성 의견');
    await context.close();

    stage = 'type change preserves a copyable previous answer';
    const convertedId = await seedPoll('합성 이전 유형');
    ({ context, page } = await guest(people[6]));
    section = await open(page, '합성 이전 유형'); await section.getByLabel(/^예/).check();
    assert.equal((await manager('module.save', { id: convertedId, type: 'qa', title: '합성 새 질문 공간' })).status, 200);
    await section.getByRole('button', { name: '투표하기' }).click();
    await section.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
    await section.getByText('이전 답변을 제출할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(await section.getByLabel('이전에 작성한 답변').inputValue(), '선택: 예');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `type change ${width} overflow`);
      await page.evaluate(axe); assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id)), []);
      await page.screenshot({ path: path.join(out, `type-change-review-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await section.getByRole('button', { name: '이전 답변 복사' }).click();
    await section.getByRole('status').filter({ hasText: /복사|선택/ }).waitFor();
    await section.getByRole('button', { name: '최신 콘텐츠 보기' }).click();
    section = (await programSection(page, '합성 새 질문 공간'));
    assert.equal(await section.getByLabel('이전에 작성한 답변').inputValue(), '선택: 예');
    await page.screenshot({ path: path.join(out, 'type-change-preserved-390.png'), fullPage: true });
    const beforeNavigation = page.url();
    await page.getByRole('link', { name: '참가 메뉴로', exact: true }).click();
    assert.equal(page.url(), beforeNavigation, 'cancelling navigation keeps the current page');
    assert.equal(await section.getByLabel('이전에 작성한 답변').inputValue(), '선택: 예', 'the preserved answer survives cancelling navigation');
    await section.getByRole('button', { name: '이전 답변 지우기' }).click();
    await section.getByRole('button', { name: '계속 보관' }).click();
    assert.equal(await section.getByLabel('이전에 작성한 답변').inputValue(), '선택: 예');
    await section.getByRole('button', { name: '이전 답변 지우기' }).click();
    await section.getByRole('button', { name: '답변 지우기', exact: true }).click();
    assert.equal(await section.getByLabel('이전에 작성한 답변').count(), 0, 'discard requires explicit confirmation');
    assert.equal((await workspace()).responses.some((item) => item.moduleId === convertedId), false);
    await section.getByLabel('질문하기').fill('새 유형에 직접 쓴 질문');
    await section.getByRole('button', { name: '질문 등록' }).click();
    await page.getByText('질문을 등록했습니다.', { exact: false }).first().waitFor();
    assert.equal((await workspace()).questions.filter((item) => item.moduleId === convertedId).length, 1);
    assert.equal((await workspace()).responses.some((item) => item.moduleId === convertedId), false);
    await context.close();

    stage = 'type change during unrelated refresh still blocks new type';
    const autoTypeId = await seedPoll('합성 자동 갱신 이전 유형');
    ({ context, page } = await guest(people[7]));
    section = await open(page, '합성 자동 갱신 이전 유형'); await section.getByLabel(/^예/).check();
    assert.equal((await manager('module.save', { id: autoTypeId, type: 'qa', title: '합성 자동 갱신 새 유형' })).status, 200);
    const existingQuiz = (await programSection(page, '합성 별도 퀴즈'));
    const existingQuizDetails = existingQuiz.locator('details').first();
    if (!(await existingQuizDetails.evaluate((node) => node.open))) await existingQuizDetails.locator('summary').click();
    await existingQuiz.getByLabel('내 답안').fill('정답'); await existingQuiz.getByRole('button', { name: '답안 제출' }).click();
    await programSection(page, '합성 자동 갱신 새 유형');
    await page.getByRole('heading', { name: '합성 자동 갱신 새 유형', exact: true }).waitFor();
    section = (await programSection(page, '합성 자동 갱신 새 유형'));
    const autoDetails = section.locator('details').first(); if (!(await autoDetails.evaluate((node) => node.open))) await autoDetails.locator('summary').click();
    await section.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    assert.equal(await section.getByLabel('이전에 작성한 답변').inputValue(), '선택: 예');
    assert.equal(await section.getByRole('button', { name: '질문 등록' }).isDisabled(), true);
    await page.screenshot({ path: path.join(out, 'type-change-refresh-390.png'), fullPage: true });
    await section.getByRole('button', { name: '최신 콘텐츠 보기' }).click();
    assert.equal(await section.getByLabel('이전에 작성한 답변').inputValue(), '선택: 예');
    assert.equal((await workspace()).responses.some((item) => item.moduleId === autoTypeId), false);
    await context.close();

    stage = 'ambiguous response followed by denial and definitive conflict';
    const lostId = await seedPoll('합성 응답 유실 질문');
    ({ context, page } = await guest(people[1]));
    const requestIds = []; let mode = 'lost';
    await page.route('**/api/events/*/commands', async (route) => {
      const payload = route.request().postDataJSON();
      if (payload.command !== 'response.submit' || payload.payload.moduleId !== lostId) return route.continue();
      requestIds.push(payload.commandId);
      if (mode === 'lost') { mode = 'denied'; return route.abort('failed'); }
      if (mode === 'denied') { mode = 'generic'; return route.fulfill({ status: 403, json: { error: '합성 거절' } }); }
      if (mode === 'generic') { mode = 'pass'; return route.fulfill({ status: 409, json: { error: '합성 일반 충돌' } }); }
      return route.continue();
    });
    section = await open(page, '합성 응답 유실 질문'); await section.getByLabel(/^예/).check();
    await section.getByRole('button', { name: '투표하기' }).click();
    await page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    await editPoll(lostId, '합성 응답 변경 질문');
    await page.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    await page.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    await page.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await section.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    assert.equal(new Set(requestIds).size, 1, 'same original request id is retried');
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === lostId).length, 0);
    assert.equal(await section.getByLabel(/^예/).isChecked(), true);
    await context.close();

    stage = 'committed answer receipt takes precedence after closing';
    const committedId = await seedPoll('합성 저장 후 유실 질문');
    ({ context, page } = await guest(people[5]));
    const committedIds = []; let loseCommitted = true;
    await page.route('**/api/events/*/commands', async (route) => {
      const payload = route.request().postDataJSON();
      if (payload.command !== 'response.submit' || payload.payload.moduleId !== committedId) return route.continue();
      committedIds.push(payload.commandId);
      if (loseCommitted) {
        loseCommitted = false; const response = await route.fetch(); assert.equal(response.status(), 201);
        return route.abort('failed');
      }
      return route.continue();
    });
    section = await open(page, '합성 저장 후 유실 질문'); await section.getByLabel(/^예/).check();
    await section.getByRole('button', { name: '투표하기' }).click();
    await page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    assert.equal((await manager('module.status', { id: committedId, status: 'CLOSED' })).status, 200);
    await page.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await page.getByText('요청 결과를 확인했습니다.', { exact: false }).waitFor();
    assert.equal(new Set(committedIds).size, 1);
    assert.equal((await workspace()).responses.filter((item) => item.moduleId === committedId).length, 1);
    await context.close();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ staleRejected: true, failedAndPartialReadsPreserve: true,
      explicitReviewBeforeSubmit: true, missingVersionBlocks: true, unrelatedRefreshRequiresReview: true,
      removedChoiceAndSurveyDrafts: true,
      typeChangePreservesCopyableAnswer: true, autoRefreshTypeChangeBlocked: true, navigationCancelPreservesDraft: true,
      uncertainDenialThenDefiniteConflict: true, committedReceiptBeforeClosed: true,
      responsiveAndAxe: [320, 390, 1280], synthetic: true }, null, 2), { mode: 0o600 });
    console.log('Participation content: stale answers are rejected, reviewed and explicitly resubmitted; prior drafts stay intact');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(`Participation content audit failed at ${stage}:`, error); process.exitCode = 1; });
