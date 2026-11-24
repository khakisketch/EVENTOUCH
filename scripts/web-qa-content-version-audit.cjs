'use strict';
const { programSection } = require('./ui-journey-helpers.cjs');
// Actual command path with isolated synthetic data; no real messages are sent.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
let stage = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'qa-content-version');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const db = f.harness.database;
    const manager = async (command, payload) => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: `qa-review-${crypto.randomUUID()}`, command, payload },
    });
    const workspace = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const people = (await workspace()).participants.filter((p) => p.status === 'APPROVED' && p.ticket);
    assert.ok(people.length >= 6);
    const event = (await db.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    assert.equal((await manager('event.features', { features: [...new Set([...event.features, 'qa', 'poll', 'quiz'])] })).status, 200);
    const seed = async (title) => {
      const result = await manager('module.save', { type: 'qa', title });
      assert.equal(result.status, 201, JSON.stringify(result.json));
      assert.equal((await manager('module.status', { id: result.json.module.id, status: 'OPEN' })).status, 200);
      return result.json.module.id;
    };
    const rename = async (id, title) => assert.equal((await manager('module.save', { id, type: 'qa', title })).status, 200);
    browser = await launchBrowser();
    const guest = async (person) => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
      await context.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: person.ticket });
      const page = await context.newPage(); page.on('dialog', (dialog) => dialog.dismiss());
      return { context, page };
    };
    const open = async (page, title) => {
      await page.goto(`${f.baseUrl}/event/${f.slug}/engage`, { waitUntil: 'networkidle' });
      await programSection(page, title);
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
      const section = (await programSection(page, title));
      const details = section.locator('details').first(); if (!(await details.evaluate((node) => node.open))) await details.locator('summary').click();
      return section;
    };
    stage = 'stale title and failed or partial latest reads';
    const id = await seed('합성 오전 Q&A');
    let { context, page } = await guest(people[0]);
    let section = await open(page, '합성 오전 Q&A');
    await section.getByLabel('질문하기').fill('오전 세션의 자료는 어디에 있나요?');
    await rename(id, '합성 오후 Q&A');
    await section.getByRole('button', { name: '질문 등록' }).click();
    await section.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    await section.getByText('작성 중인 질문은 아직 제출되지 않았습니다.', { exact: false }).waitFor();
    await section.getByText('질문을 작성할 때의 제목: 합성 오전 Q&A', { exact: true }).waitFor();
    assert.equal((await workspace()).questions.filter((q) => q.moduleId === id).length, 0);
    assert.equal(await section.getByLabel('질문하기').inputValue(), '오전 세션의 자료는 어디에 있나요?');
    let fault = '503';
    await page.route('**/api/public/events/*/ticket', async (route) => {
      if (fault === '503') { fault = 'partial'; return route.fulfill({ status: 503, json: { error: '합성 오류' } }); }
      if (fault === 'partial') { fault = 'none'; const response = await route.fetch(); const data = await response.json(); delete data.workspace.modules.find((m) => m.id === id).contentVersion; return route.fulfill({ response, json: data }); }
      return route.continue();
    });
    for (const failure of ['503', 'partial']) {
      await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
      await section.getByText('최신 참여 내용을 확인하지 못했습니다.', { exact: false }).waitFor();
      assert.equal(await section.getByLabel('질문하기').inputValue(), '오전 세션의 자료는 어디에 있나요?', failure);
    }
    await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
    await section.getByText('합성 오후 Q&A', { exact: false }).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width} overflow`);
      await page.evaluate(axe); assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
      await page.screenshot({ path: path.join(out, `qa-review-${width}.png`), fullPage: true });
    }
    await section.getByRole('button', { name: '최신 내용으로 질문 검토' }).click();
    assert.equal((await workspace()).questions.filter((q) => q.moduleId === id).length, 0);
    section = (await programSection(page, '합성 오후 Q&A'));
    await section.getByRole('button', { name: '질문 등록' }).click();
    await page.getByText('질문을 등록했습니다.', { exact: false }).first().waitFor();
    const questions = (await workspace()).questions.filter((q) => q.moduleId === id);
    assert.equal(questions.length, 1); assert.equal(questions[0].contentVersion, 2); assert.equal(questions[0].approved, false);
    await context.close();

    stage = 'missing version blocks submission';
    const missing = await seed('합성 버전 없는 Q&A');
    ({ context, page } = await guest(people[1]));
    await page.route('**/api/public/events/*/ticket', async (route) => { const response = await route.fetch(); const data = await response.json(); for (const m of data.workspace.modules) delete m.contentVersion; return route.fulfill({ response, json: data }); });
    section = await open(page, '합성 버전 없는 Q&A');
    await section.getByLabel('질문하기').fill('남겨둘 질문');
    await section.getByText('참여 내용을 확인할 수 없어 제출을 잠시 중단했습니다.', { exact: false }).waitFor();
    await section.getByText('작성 중인 질문은 이 화면에 남아 있습니다.', { exact: false }).waitFor();
    assert.equal(await section.getByRole('button', { name: '질문 등록' }).isDisabled(), true);
    assert.equal((await workspace()).questions.filter((q) => q.moduleId === missing).length, 0); await context.close();

    stage = 'type change retains copyable question and navigation guard';
    const converted = await seed('합성 이전 Q&A');
    ({ context, page } = await guest(people[2])); section = await open(page, '합성 이전 Q&A');
    await section.getByLabel('질문하기').fill('이전 질문은 여기에 남아야 합니다');
    assert.equal((await manager('module.save', { id: converted, type: 'poll', title: '합성 새 투표', options: ['예', '아니요'] })).status, 200);
    await section.getByRole('button', { name: '질문 등록' }).click();
    await section.getByRole('button', { name: '최신 내용 확인', exact: true }).click();
    await section.getByText('이전 질문을 제출할 수 없습니다.', { exact: false }).waitFor();
    assert.equal(await section.getByLabel('이전에 작성한 질문').inputValue(), '질문: 이전 질문은 여기에 남아야 합니다');
    await section.getByRole('button', { name: '이전 질문 복사' }).click();
    await section.getByRole('status').filter({ hasText: /복사|선택/ }).waitFor();
    await section.getByRole('button', { name: '최신 콘텐츠 보기' }).click();
    section = (await programSection(page, '합성 새 투표'));
    assert.equal(await section.getByLabel('이전에 작성한 질문').inputValue(), '질문: 이전 질문은 여기에 남아야 합니다');
    await page.screenshot({ path: path.join(out, 'qa-type-change-390.png'), fullPage: true });
    const before = page.url(); await page.getByRole('link', { name: '참가자 홈으로', exact: true }).click();
    assert.equal(page.url(), before); assert.equal(await section.getByLabel('이전에 작성한 질문').inputValue(), '질문: 이전 질문은 여기에 남아야 합니다');
    await section.getByRole('button', { name: '이전 질문 지우기' }).click();
    await section.getByRole('group', { name: '이전 질문 삭제 확인' }).getByText('이전 질문을 지울까요?', { exact: false }).waitFor();
    await section.getByRole('button', { name: '계속 보관' }).click();
    assert.equal(await section.getByLabel('이전에 작성한 질문').inputValue(), '질문: 이전 질문은 여기에 남아야 합니다');
    assert.equal((await workspace()).questions.some((q) => q.moduleId === converted), false); await context.close();

    stage = 'unrelated submission refresh preserves question baseline';
    const refreshed = await seed('합성 갱신 전 Q&A');
    const quiz = await manager('module.save', { type: 'quiz', title: '합성 별도 퀴즈', answer: '정답' });
    assert.equal(quiz.status, 201);
    assert.equal((await manager('module.status', { id: quiz.json.module.id, status: 'OPEN' })).status, 200);
    ({ context, page } = await guest(people[5])); section = await open(page, '합성 갱신 전 Q&A');
    await section.getByLabel('질문하기').fill('새로고침 전 질문'); await rename(refreshed, '합성 갱신 후 Q&A');
    const quizSection = (await programSection(page, '합성 별도 퀴즈'));
    const quizDetails = quizSection.locator('details').first(); if (!(await quizDetails.evaluate((node) => node.open))) await quizDetails.locator('summary').click();
    await quizSection.getByLabel('내 답안').fill('정답'); await quizSection.getByRole('button', { name: '답안 제출' }).click();
    await programSection(page, '합성 갱신 후 Q&A');
    await page.getByRole('heading', { name: '합성 갱신 후 Q&A', exact: true }).waitFor();
    section = (await programSection(page, '합성 갱신 후 Q&A'));
    const refreshedDetails = section.locator('details').first(); if (!(await refreshedDetails.evaluate((node) => node.open))) await refreshedDetails.locator('summary').click();
    await section.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    assert.equal(await section.getByLabel('질문하기').inputValue(), '새로고침 전 질문');
    assert.equal(await section.getByRole('button', { name: '질문 등록' }).isDisabled(), true);
    assert.equal((await workspace()).questions.filter((q) => q.moduleId === refreshed).length, 0); await context.close();

    stage = 'lost response followed by denial and definite conflict';
    const lost = await seed('합성 요청 유실 Q&A');
    ({ context, page } = await guest(people[3])); let mode = 'lost'; const ids = [];
    await page.route('**/api/events/*/commands', async (route) => {
      const request = route.request().postDataJSON();
      if (request.command !== 'question.submit' || request.payload.moduleId !== lost) return route.continue();
      ids.push(request.commandId);
      if (mode === 'lost') { mode = 'denied'; return route.abort('failed'); }
      if (mode === 'denied') { mode = 'generic'; return route.fulfill({ status: 403, json: { error: '합성 거절' } }); }
      if (mode === 'generic') { mode = 'pass'; return route.fulfill({ status: 409, json: { error: '합성 충돌' } }); }
      return route.continue();
    });
    section = await open(page, '합성 요청 유실 Q&A'); await section.getByLabel('질문하기').fill('응답이 유실된 질문'); await section.getByRole('button', { name: '질문 등록' }).click();
    await page.getByRole('heading', { name: '요청 결과 확인' }).waitFor(); await rename(lost, '합성 유실 후 변경 Q&A');
    for (let index = 0; index < 2; index++) { await page.getByRole('button', { name: '원래 요청 다시 보내기' }).click(); await page.getByRole('heading', { name: '요청 결과 확인' }).waitFor(); }
    await page.getByRole('button', { name: '원래 요청 다시 보내기' }).click(); await section.getByRole('heading', { name: '참여 내용이 변경됐습니다' }).waitFor();
    assert.equal(new Set(ids).size, 1); assert.equal((await workspace()).questions.filter((q) => q.moduleId === lost).length, 0);
    assert.equal(await section.getByLabel('질문하기').inputValue(), '응답이 유실된 질문'); await context.close();

    stage = 'committed receipt survives lost response and close';
    const committed = await seed('합성 저장 후 유실 Q&A');
    ({ context, page } = await guest(people[4])); let first = true; const committedIds = [];
    await page.route('**/api/events/*/commands', async (route) => {
      const request = route.request().postDataJSON(); if (request.command !== 'question.submit' || request.payload.moduleId !== committed) return route.continue();
      committedIds.push(request.commandId); if (first) { first = false; const response = await route.fetch(); assert.equal(response.status(), 201); return route.abort('failed'); } return route.continue();
    });
    section = await open(page, '합성 저장 후 유실 Q&A'); await section.getByLabel('질문하기').fill('이미 저장된 질문'); await section.getByRole('button', { name: '질문 등록' }).click();
    await page.getByRole('heading', { name: '요청 결과 확인' }).waitFor();
    assert.equal((await manager('module.status', { id: committed, status: 'CLOSED' })).status, 200);
    await page.getByRole('button', { name: '원래 요청 다시 보내기' }).click(); await page.getByText('요청 결과를 확인했습니다.', { exact: false }).waitFor();
    assert.equal(new Set(committedIds).size, 1); assert.equal((await workspace()).questions.filter((q) => q.moduleId === committed).length, 1); await context.close();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ staleRejected: true, failedAndPartialReadsPreserve: true, explicitReview: true, missingVersionBlocks: true, typeChangeAndNavigation: true, unrelatedRefreshPreservesDraft: true, uncertainDenialThenConflict: true, committedReceiptBeforeClosed: true, responsiveAndAxe: [320, 390, 1280], synthetic: true }, null, 2), { mode: 0o600 });
    console.log('Q&A content version: conflict, drafts, type changes and receipts verified');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(`Q&A audit failed at ${stage}:`, error); process.exitCode = 1; });
