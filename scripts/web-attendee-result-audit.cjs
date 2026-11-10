'use strict';
// Synthetic participant; all changed responses are injected after real commits.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { openProgram } = require('./ui-journey-helpers.cjs');
const { floorplanPng } = require('../tests/helpers/floorplan-image.cjs');
const before = process.argv.includes('--before');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'attendee-result-before' : 'attendee-result');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const database = fixture.harness.database;
    const read = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await read();
    const person = workspace.participants.find((entry) => entry.status === 'APPROVED');
    assert.ok(person?.ticket);
    workspace.modules.push({ id: 'proof-qa', type: 'qa', title: '합성 질문 프로그램', status: 'OPEN', published: true });
    workspace.modules.push({ id: 'proof-photo', type: 'photo', title: '합성 사진 프로그램', status: 'OPEN', published: true });
    workspace.modules.push({ id: 'proof-survey', type: 'survey', title: '합성 만족도 프로그램', status: 'OPEN', published: true, questions: ['서비스'] });
    workspace.modules.push({ id: 'proof-board', type: 'board', title: '합성 게시판 프로그램', status: 'OPEN', published: true });
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    const event = (await database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    event.features = [...new Set([...(event.features || []), 'qa', 'photo', 'survey', 'board'])];
    await database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [fixture.eventId, JSON.stringify(event)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const commands = new Map();
    const uploads = [];
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      if (!['question.submit', 'photo.submit', 'response.submit', 'post.submit'].includes(body.command)) return route.continue();
      const rows = commands.get(body.command) || []; rows.push(body); commands.set(body.command, rows);
      if (rows.length === 1) {
        const response = await route.fetch(); assert.ok(response.ok());
        const altered = await response.json();
        if (body.command === 'question.submit') altered.question.text = '다른 질문';
        else if (body.command === 'photo.submit') altered.photo.caption = '다른 설명';
        else if (body.command === 'response.submit') altered.response.ratings['서비스'] = 1;
        else altered.post.body = '다른 게시글';
        return route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(altered) });
      }
      return route.continue();
    });
    await page.route('**/api/public/events/*/files?*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const url = new URL(route.request().url()); uploads.push(url.searchParams.get('commandId'));
      if (uploads.length === 1) {
        const response = await route.fetch(); assert.ok(response.ok());
        const altered = await response.json(); altered.file.name = 'other.png';
        return route.fulfill({ status: response.status(), contentType: 'application/json', body: JSON.stringify(altered) });
      }
      if (uploads.length === 2) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/engage?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'networkidle' });
    const qa = await openProgram(page, '합성 질문 프로그램');
    const question = qa.getByLabel('질문하기');
    const original = '확인이 필요한 합성 질문';
    phase = 'unrelated successful question response';
    await question.fill(original); await qa.getByRole('button', { name: '질문 등록' }).click();
    if (before) {
      await page.getByText('질문을 등록했습니다. 운영자 승인 후 공개됩니다.').waitFor();
      assert.equal(await question.inputValue(), '', 'old screen treats an unrelated question response as success');
      await page.screenshot({ path: path.join(out, 'before-question-390.png'), fullPage: true });
      return;
    }
    const recovery = page.locator('section').filter({ has: page.getByRole('heading', { name: '요청 결과 확인', exact: true }) });
    await recovery.waitFor();
    assert.equal(await question.inputValue(), original);
    assert.equal((await read()).questions.filter((entry) => entry.text === original).length, 1);
    await page.screenshot({ path: path.join(out, 'question-unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await recovery.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(commands.get('question.submit').map((entry) => entry.commandId)).size, 1);
    assert.equal((await read()).questions.filter((entry) => entry.text === original).length, 1);

    phase = 'survey response must match the submitted score and comment';
    const survey = await openProgram(page, '합성 만족도 프로그램');
    await survey.getByRole('radio', { name: '5점' }).check();
    await survey.getByLabel('의견 · 선택').fill('합성 만족 의견');
    await survey.getByRole('button', { name: '만족도 제출' }).click();
    await recovery.waitFor();
    assert.equal(await survey.getByRole('radio', { name: '5점' }).isChecked(), true);
    assert.equal(await survey.getByLabel('의견 · 선택').inputValue(), '합성 만족 의견');
    await recovery.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(commands.get('response.submit').map((entry) => entry.commandId)).size, 1);
    assert.equal((await read()).responses.filter((entry) => entry.moduleId === 'proof-survey' && entry.participantId === person.id).length, 1);

    phase = 'post response must match the submitted body';
    const board = await openProgram(page, '합성 게시판 프로그램');
    await board.getByLabel('게시글 작성').fill('합성 게시글 내용');
    await board.getByRole('button', { name: '게시글 등록' }).click();
    await recovery.waitFor();
    assert.equal(await board.getByLabel('게시글 작성').inputValue(), '합성 게시글 내용');
    await recovery.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(commands.get('post.submit').map((entry) => entry.commandId)).size, 1);
    assert.equal((await read()).posts.filter((entry) => entry.body === '합성 게시글 내용').length, 1);

    phase = 'upload identity and later rejection';
    const photo = await openProgram(page, '합성 사진 프로그램');
    const input = photo.locator('input[type=file]');
    await input.setInputFiles({ name: 'synthetic-photo.png', mimeType: 'image/png', buffer: floorplanPng() });
    await photo.getByLabel('사진 설명').fill('합성 사진 설명');
    await photo.getByRole('button', { name: '사진 공유' }).click();
    await recovery.waitFor();
    assert.equal((commands.get('photo.submit') || []).length, 0, 'invalid upload metadata never records the photo');
    await recovery.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await recovery.waitFor();
    assert.equal((commands.get('photo.submit') || []).length, 0, 'later 403 does not discard the unknown upload');
    await recovery.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await recovery.waitFor();
    assert.equal(commands.get('photo.submit').length, 1);
    assert.equal(new Set(uploads).size, 1, 'the same file upload ID is retried');
    assert.equal((await read()).photos.filter((entry) => entry.caption === '합성 사진 설명').length, 1);
    phase = 'photo response caption must match';
    await recovery.getByRole('button', { name: '원래 요청 다시 보내기' }).click();
    await recovery.waitFor({ state: 'hidden' });
    assert.equal(new Set(commands.get('photo.submit').map((entry) => entry.commandId)).size, 1);
    assert.equal(uploads.length, 3, 'record retry does not upload again');
    assert.equal((await read()).photos.filter((entry) => entry.caption === '합성 사진 설명').length, 1);
    assert.equal((await database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'synthetic-photo.png'])).rowCount, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, mismatchedBodiesRejected: true, uploadMetadataRequired: true, after403: true, sameIds: true, duplicateQuestions: 0, duplicatePhotos: 0 }, null, 2), { mode: 0o600 });
    console.log('Participant response and photo metadata checked against original input with duplicate-free retry');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
