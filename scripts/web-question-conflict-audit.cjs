'use strict';
// Two independent operator contexts and an isolated database; all names and
// answers are synthetic. Network faults never reach a customer environment.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
let phase = 'setup';

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'question-conflict');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const db = fixture.harness.database;
    const event = (await db.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    event.features = [...new Set([...event.features, 'qa'])]; event.stage = 'READY';
    await db.query('UPDATE events SET payload=$2 WHERE id=$1', [fixture.eventId, event]);
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const initial = await read();
    const person = initial.participants[0];
    person.status = 'APPROVED'; person.revoked = false; person.ticket = crypto.randomBytes(32).toString('base64url');
    person.ticketExpiresAt = new Date(Date.now() + 86400000).toISOString();
    await db.query('UPDATE event_workspaces SET payload=$2 WHERE event_id=$1', [fixture.eventId, initial]);
    const call = (command, payload, bearer) => fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', ...(bearer ? { bearer } : { cookie: fixture.manager.cookie }), body: { commandId: crypto.randomUUID(), command, payload },
    });
    const moduleResult = await call('module.save', { type: 'qa', title: '합성 Q&A 동시 검토' });
    assert.equal(moduleResult.status, 201); const module = moduleResult.json.module;
    assert.equal((await call('module.status', { id: module.id, status: 'OPEN' })).status, 200);
    const questions = [];
    for (let i = 1; i <= 2; i++) {
      const response = await call('question.submit', { moduleId: module.id, text: `합성 질문 ${i}` }, person.ticket);
      assert.equal(response.status, 201); questions.push(response.json.question);
    }
    browser = await launchBrowser();
    const contexts = await Promise.all([0, 1].map(() => browser.newContext({ viewport: { width: 1280, height: 900 } })));
    for (const context of contexts) await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const [a, b] = await Promise.all(contexts.map((context) => context.newPage()));
    const errors = []; for (const page of [a, b]) page.on('pageerror', (error) => errors.push(error.message));
    await Promise.all([a, b].map(async (page) => {
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/programs`, { waitUntil: 'networkidle' });
      await page.getByText('진행·응답 관리', { exact: true }).click();
    }));
    const row = (page, question) => page.locator(`#moderation-question-${question.id}`);
    const requests = [];
    let bootstrapFault = '';
    await a.route('**/api/events/*/bootstrap', async (route) => {
      if (bootstrapFault === 'missing-answer') {
        bootstrapFault = ''; const response = await route.fetch(); const data = await response.json();
        delete data.state.workspaces[fixture.eventId].questions.find((q) => q.id === questions[0].id).answer;
        return route.fulfill({ response, body: JSON.stringify(data) });
      }
      if (bootstrapFault) { const status = Number(bootstrapFault); bootstrapFault = ''; return route.fulfill({ status, contentType: 'application/json', body: '{}' }); }
      return route.continue();
    });
    await a.route('**/api/events/*/commands', (route) => {
      const body = route.request().postDataJSON();
      if (body?.command === 'question.manage') requests.push(body);
      return route.continue();
    });

    phase = 'two operator drafts and automatic reload';
    await row(a, questions[0]).getByLabel('답변', { exact: true }).fill('내가 작성한 답변');
    await row(b, questions[0]).getByLabel('답변', { exact: true }).fill('다른 운영자의 공개 답변');
    await row(b, questions[0]).getByRole('button', { name: '승인·공개' }).click();
    await b.getByText('답변을 저장하고 질문을 공개했습니다.').waitFor();
    // Saving another row refreshes A's data, but must not rebase its draft.
    await row(a, questions[1]).getByLabel('답변', { exact: true }).fill('다른 질문의 답변');
    await row(a, questions[1]).getByRole('button', { name: '답변 저장', exact: true }).click();
    await row(a, questions[0]).getByText(/다른 운영자의 공개 답변/).waitFor();
    assert.equal(await row(a, questions[0]).getByLabel('답변', { exact: true }).inputValue(), '내가 작성한 답변');
    await row(a, questions[0]).getByRole('button', { name: '답변 저장·공개 유지' }).click();
    const conflict = row(a, questions[0]).getByRole('region', { name: '질문 또는 답변이 변경되었습니다' });
    await conflict.waitFor();
    const attempt = requests.find((entry) => entry.payload.id === questions[0].id);
    assert.deepEqual(attempt.payload.expectedQuestion, { text: '합성 질문 1', answer: '', approved: false });
    assert.equal((await read()).questions.find((q) => q.id === questions[0].id).answer, '다른 운영자의 공개 답변');
    await a.waitForFunction((id) => document.activeElement?.id === `question-conflict-${id}`, questions[0].id);
    await a.screenshot({ path: path.join(out, 'conflict-1280.png'), fullPage: true });
    phase = 'return to conflict from hidden search and status filters';
    await a.getByRole('searchbox', { name: '콘텐츠 검색' }).fill('찾을 수 없는 콘텐츠');
    await a.getByLabel('진행 상태별 보기').selectOption('CLOSED');
    assert.equal(await row(a, questions[0]).count(), 0);
    await a.getByRole('region', { name: '질문 변경 확인' }).getByRole('button', { name: '변경 내용 확인' }).click();
    await conflict.waitFor();
    await a.waitForFunction((id) => document.activeElement?.id === `question-conflict-${id}`, questions[0].id);
    assert.equal(await a.getByRole('searchbox', { name: '콘텐츠 검색' }).inputValue(), '');

    phase = 'failed and partial latest reads preserve the draft';
    for (const fault of ['503', 'missing-answer']) {
      phase = `failed latest read: ${fault}`;
      bootstrapFault = fault;
      const response = a.waitForResponse((result) => /\/bootstrap$/.test(result.url()) && result.request().method() === 'GET');
      await conflict.getByRole('button', { name: '최신 내용 불러오기' }).click();
      await response;
      await conflict.getByRole('alert').waitFor();
      await a.waitForFunction((id) => {
        const region = document.getElementById(`question-conflict-${id}`)?.parentElement;
        return Array.from(region?.querySelectorAll('button') || []).some((button) => button.textContent?.trim() === '최신 내용 불러오기' && button.matches(':enabled'));
      }, questions[0].id);
      assert.equal(await row(a, questions[0]).getByLabel('답변', { exact: true }).inputValue(), '내가 작성한 답변');
      assert.equal(await conflict.getByRole('button', { name: '내 답변으로 계속' }).count(), 0);
    }
    phase = 'stalled response body times out';
    await a.evaluate(() => {
      const original = window.fetch;
      window.fetch = function(input, init) {
        const url = typeof input === 'string' ? input : input.url;
        if (window.__qaStall && /\/bootstrap$/.test(url)) {
          window.__qaStall = false;
          return original.call(this, input, init).then((response) => new Response(new ReadableStream({ start() {} }),
            { status: response.status, headers: response.headers }));
        }
        return original.call(this, input, init);
      };
      window.__qaStall = true;
    });
    await conflict.getByRole('button', { name: '최신 내용 불러오기' }).click();
    await conflict.getByRole('button', { name: '최신 내용 확인 중…' }).waitFor();
    await a.waitForFunction((id) => {
      const region = document.getElementById(`question-conflict-${id}`)?.parentElement;
      return Array.from(region?.querySelectorAll('button') || []).some((button) => button.textContent?.trim() === '최신 내용 불러오기' && button.matches(':enabled'));
    }, questions[0].id, { timeout: 16000 });
    await conflict.getByRole('alert').waitFor({ timeout: 16000 });
    assert.equal(await row(a, questions[0]).getByLabel('답변', { exact: true }).inputValue(), '내가 작성한 답변');
    assert.equal(await conflict.getByRole('button', { name: '내 답변으로 계속' }).count(), 0);
    phase = 'latest comparison and explicit choice';
    await conflict.getByRole('button', { name: '최신 내용 불러오기' }).focus();
    await a.keyboard.press('Enter');
    await conflict.getByText('다른 운영자의 공개 답변', { exact: false }).waitFor();
    await conflict.getByText('공개됨', { exact: false }).waitFor();
    await a.setViewportSize({ width: 320, height: 700 });
    await a.screenshot({ path: path.join(out, 'comparison-320.png'), fullPage: true });
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    assert.equal(await conflict.getByRole('button', { name: '내 답변으로 계속' }).isEnabled(), true);
    const narrowRefresh = a.waitForResponse((result) => /\/bootstrap$/.test(result.url()) && result.request().method() === 'GET');
    await conflict.getByRole('button', { name: '최신 내용 다시 확인' }).click();
    await narrowRefresh;
    await conflict.getByText('다른 운영자의 공개 답변', { exact: false }).waitFor();
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: path.join(out, 'comparison-390.png'), fullPage: true });
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await a.evaluate(axeSource);
    assert.deepEqual(await a.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    const writes = requests.length;
    await conflict.getByRole('button', { name: '내 답변으로 계속' }).click();
    assert.equal(requests.length, writes, 'choosing a draft never writes');
    assert.equal(await row(a, questions[0]).getByLabel('답변', { exact: true }).inputValue(), '내가 작성한 답변');
    await row(a, questions[0]).getByRole('button', { name: '답변 저장·공개 유지' }).click();
    await a.getByText('답변을 저장했습니다. 공개 상태를 유지합니다.').waitFor();
    const saved = (await read()).questions.find((q) => q.id === questions[0].id);
    assert.equal(saved.answer, '내가 작성한 답변'); assert.equal(saved.approved, true);

    phase = 'keeping the latest answer does not write';
    let bWrites = 0;
    await b.route('**/api/events/*/commands', (route) => { if (route.request().postDataJSON()?.command === 'question.manage') bWrites++; return route.continue(); });
    await row(b, questions[1]).getByLabel('답변', { exact: true }).fill('두 번째 창의 답변');
    await row(b, questions[1]).getByRole('button', { name: '답변 저장', exact: true }).click();
    const bConflict = row(b, questions[1]).getByRole('region', { name: '질문 또는 답변이 변경되었습니다' });
    await bConflict.waitFor();
    await bConflict.getByRole('button', { name: '최신 내용 불러오기' }).click();
    await bConflict.getByText('다른 질문의 답변', { exact: false }).waitFor();
    const priorWrites = bWrites;
    await bConflict.getByRole('button', { name: '최신 답변으로 계속' }).click();
    assert.equal(bWrites, priorWrites);
    assert.equal(await row(b, questions[1]).getByLabel('답변', { exact: true }).inputValue(), '다른 질문의 답변');
    assert.equal((await read()).questions.find((q) => q.id === questions[1].id).answer, '다른 질문의 답변');

    phase = '403 organization protection retains the draft and prevents writes';
    await row(b, questions[0]).getByLabel('답변', { exact: true }).fill('권한 변경 전 작성한 답변');
    await row(b, questions[0]).getByRole('button', { name: '답변 저장·공개 유지' }).click();
    const deniedConflict = row(b, questions[0]).getByRole('region', { name: '질문 또는 답변이 변경되었습니다' });
    await deniedConflict.waitFor();
    await b.route('**/api/events/*/bootstrap', (route) => route.fulfill({ status: 403, contentType: 'application/json', body: '{}' }));
    const denied = b.waitForResponse((response) => /\/bootstrap$/.test(response.url()) && response.status() === 403);
    await deniedConflict.getByRole('button', { name: '최신 내용 불러오기' }).click();
    await denied;
    await deniedConflict.getByRole('alert').waitFor();
    assert.equal(await row(b, questions[0]).getByLabel('답변', { exact: true }).inputValue(), '권한 변경 전 작성한 답변');
    assert.equal(await deniedConflict.getByRole('button', { name: '내 답변으로 계속' }).count(), 0);
    assert.equal((await read()).questions.find((q) => q.id === questions[0].id).answer, '내가 작성한 답변');
    assert.deepEqual(errors, []);
    console.log('Q&A operator conflict: isolated browser and PostgreSQL audit passed');
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`phase: ${phase}`, error); process.exitCode = 1; });
