'use strict';

// A file column titled like one of the event's own form fields (식사 선택,
// 요청 사항, 마케팅 동의) imports that answer with the roster. Real operator
// import, isolated API/database, synthetic CSV only: the chips connect
// themselves, a bad answer is a row error by file row, a required field the
// file has no column for never blocks the rows, and the stored answers are
// what the file said.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'import-extra-fields'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const db = f.harness.database;
  const workspace = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  try {
    // The event's form: a required choice plus two optional extras.
    const seeded = await workspace();
    seeded.fields = [
      { id: 'name', label: '이름', type: 'text', required: true, options: [] },
      { id: 'phone', label: '연락처', type: 'text', required: true, options: [] },
      { id: 'company', label: '소속', type: 'text', required: false, options: [] },
      { id: 'meal', label: '식사 선택', type: 'select', required: true, options: ['일반식', '채식'] },
      { id: 'memo', label: '요청 사항', type: 'text', required: false, options: [] },
      { id: 'agree', label: '마케팅 동의', type: 'checkbox', required: false, options: [] },
    ];
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(seeded)]);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', acceptDownloads: true });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants/import`);
    const file = page.locator('input[type=file]');
    const review = page.locator(':is(section,[role="region"])[aria-labelledby="participant-import-review-heading"]');
    const pick = async (name, text) => {
      const again = page.getByRole('button', { name: '다른 파일 가져오기', exact: true });
      if (await again.count()) await again.click();
      const change = page.getByRole('button', { name: '파일 바꾸기', exact: true });
      if (await change.count() && await change.isEnabled()) await change.click();
      await file.setInputFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });
    };
    const ready = (count) => review.locator('[class*="heroNumber"]').getByText(String(count), { exact: true }).waitFor();
    const errorList = async (count) => {
      await review.getByRole('heading', { name: `${count}행은 등록하지 않아요` }).waitFor();
      await review.getByRole('button', { name: /^오류 \d+행 보기$/ }).click();
      return review.getByRole('list', { name: '가져오기 오류 목록' });
    };
    const chip = (label) => review.getByLabel(`${label}에 연결할 열`, { exact: true });
    const person = async (phone) => (await workspace()).participants.find((item) => item.phone === phone);

    // 1) the template names the extra fields too.
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '양식 CSV 받기', exact: true }).click()]);
    const template = fs.readFileSync(await download.path(), 'utf8');
    assert.match(template, /^﻿?이름,연락처,이메일,소속,식사 선택,요청 사항,마케팅 동의\r?\n/u, 'the template carries the extra fields as columns');
    assert.match(template.split(/\r?\n/)[1], /일반식,예시,예/u, 'with an example a field accepts');

    // 2) titles match the form: the chips connect themselves; bad answers are row errors.
    await pick('추가항목.csv', [
      '이름,연락처,식사 선택,요청 사항,마케팅 동의',
      '합성가,01090001001,채식,창가 자리,예',
      '합성나,01090001002,일반식,,아니오',
      '합성다,01090001003,육식,,예',
      '합성라,01090001004,,,',
      '',
    ].join('\n'));
    await ready(2);
    assert.equal(await chip('식사 선택').inputValue(), '2', 'the 식사 선택 chip found its column');
    assert.equal(await chip('요청 사항').inputValue(), '3');
    assert.equal(await chip('마케팅 동의').inputValue(), '4');
    const list = await errorList(2);
    const listText = await list.innerText();
    assert.match(listText, /파일 4행/); assert.match(listText, /식사 선택의 선택지에 없는 값입니다\(육식\)/);
    assert.match(listText, /파일 5행/); assert.match(listText, /식사 선택을\(를\) 입력하세요/);
    assert.equal(await review.getByText(/연결된 열이 없어/).count(), 0, 'every required field has its column, so no notice');
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no horizontal overflow at ${width}`);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), [], `no serious accessibility findings at ${width}`);
      await page.screenshot({ path: path.join(out, `review-extra-${width}.png`), fullPage: true });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await person('01090001003'), undefined, 'nothing is written before the operator registers');
    await page.getByRole('button', { name: /^2명 등록$/ }).click();
    await page.getByText(/^2명을 반영했습니다\./).waitFor();
    const first = await person('01090001001'), second = await person('01090001002');
    assert.deepEqual(first.answers, { meal: '채식', memo: '창가 자리', agree: true });
    assert.deepEqual(second.answers, { meal: '일반식', agree: false });
    assert.equal(first.status, 'APPROVED'); assert.equal(first.consent, null, 'import never records consent');
    assert.equal(await person('01090001004'), undefined, 'a rejected row is not registered');

    // 3) a file without the required column: no block, a quiet notice, empty answers.
    await pick('열없음.csv', '이름,연락처\n합성마,01090001005\n');
    await ready(1);
    assert.equal(await chip('식사 선택').inputValue(), '', 'no column, so the chip stays on 사용 안 함');
    await review.getByText(/필수 신청 항목 식사 선택은\(는\) 연결된 열이 없어 가져온 참가자의 답이 비어 있습니다/).waitFor();
    await page.screenshot({ path: path.join(out, 'review-no-column-1280.png'), fullPage: true });
    await page.getByRole('button', { name: /^1명 등록$/ }).click();
    await page.getByText(/^1명을 반영했습니다\./).waitFor();
    assert.deepEqual((await person('01090001005')).answers, {}, 'no answers were invented');

    // 4) an unfamiliar title: the operator connects it by hand and the preview follows.
    await pick('메뉴.csv', '이름,연락처,메뉴\n합성바,01090001006,채식\n합성사,01090001007,없는메뉴\n');
    await ready(2);
    assert.equal(await chip('식사 선택').inputValue(), '');
    await chip('식사 선택').selectOption({ label: '메뉴' });
    await ready(1);
    assert.match(await (await errorList(1)).innerText(), /파일 3행.*식사 선택의 선택지에 없는 값입니다\(없는메뉴\)/s);
    await chip('식사 선택').selectOption({ label: '사용 안 함' });
    await ready(2);
    await chip('식사 선택').selectOption({ label: '메뉴' });
    await ready(1);
    await page.getByRole('button', { name: /^1명 등록$/ }).click();
    await page.getByText(/^1명을 반영했습니다\./).waitFor();
    assert.deepEqual((await person('01090001006')).answers, { meal: '채식' });

    // 5) a TXT file has a fixed order and offers no extra chips.
    await pick('고정.txt', '합성아,01090001008\n');
    await ready(1);
    assert.equal(await review.getByLabel('식사 선택에 연결할 열', { exact: true }).count(), 0, 'TXT never maps extra fields');
    await review.getByText(/필수 신청 항목 식사 선택은\(는\) 연결된 열이 없어/).waitFor();

    assert.deepEqual(errors, []);
    await context.close();
    console.log('명단 가져오기 추가 항목: 제목이 같은 열은 자동 연결·오류는 파일 행으로·없는 필수 항목은 막지 않음·저장 답변 확인');
  } finally { await browser?.close(); await f.close(); }
}
main().catch((error) => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
