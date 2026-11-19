'use strict';

// 실제 API·격리 DB를 기준으로 기간 선택, 집계 일치, 권한과 실패 복구를 검증한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

const LAST7 = [
  ['2026-11-12', 1, 0], ['2026-11-13', 0, 0], ['2026-11-14', 0, 0],
  ['2026-11-15', 0, 0], ['2026-11-16', 1, 1], ['2026-11-17', 1, 1], ['2026-11-18', 1, 4],
];
const FULL = Array.from({ length: 19 }, (_, index) => {
  const key = `2026-11-${String(index + 1).padStart(2, '0')}`;
  return LAST7.find(row => row[0] === key) || [key, index === 0 || index === 18 ? 1 : 0, 0];
});
const EXPANDED_FULL = [['2026-10-31', 1, 0], ...FULL];
const FIXED_NOW = new Date('2026-11-18T03:00:00Z');
const FAILURE = '기간 분석을 불러오지 못했습니다.';

async function assertNumbers(page, expected, days, showZero = false) {
  await page.waitForFunction(values => {
    // Reopened 2026-11-20: 요약 카드의 숫자 dd는 data-metric으로 고르고, 비교·설명 dd는 건너뛴다.
    const list = [...document.querySelectorAll('main dl')].find(dl => [...dl.querySelectorAll('dt')].some(dt => dt.textContent === '기간 고유 입장'));
    if (!list) return false;
    const pick = name => Number.parseInt(list.querySelector(`dd[data-metric="${name}"]`)?.textContent, 10);
    return JSON.stringify([pick('applications'), pick('entriesSum'), pick('unique')]) === JSON.stringify(values);
  }, expected);
  const table = page.getByRole('table', { name: '선택 기간 일별 신청·입장', exact: true });
  const actual = await table.locator('tbody tr').evaluateAll(rows => rows.map(row => [...row.querySelectorAll('th,td')].map(cell => cell.textContent.trim())));
  assert.deepEqual(actual, days.filter(row => showZero || row[1] || row[2]).map(([day, apps, entries]) => [day, `${apps}명`, `${entries}명`]));
  const chart = page.getByRole('img', { name: /^선택 기간 일별 신청·입장 막대그래프/ });
  assert.deepEqual(await chart.locator('rect title').allTextContents(), days.flatMap(([day, apps, entries]) => [`${day} 신청 ${apps}명`, `${day} 입장 ${entries}명(일별 고유)`]));
  assert.match(await chart.getAttribute('aria-label'), new RegExp(`기간 신청 ${expected[0]}명, 일별 입장 합 ${expected[1]}명, 기간 고유 입장 ${expected[2]}명`));
}

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'period-analysis'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  let f, browser, lastPage;
  const errors = [], checks = [];
  const step = async (name, run) => { await run(); checks.push(name); console.log(`PASS: ${name}`); };
  try {
    f = await startAuditFixture();
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const write = workspace => db.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    const seeded = await read();
    assert.equal(seeded.participants.length, 8);
    const dates = ['18T00:05', '17T23:55', '12T12:00', '18T10:00', '16T12:00', '01T12:00', '19T12:00'];
    seeded.participants.forEach((person, index) => {
      Object.assign(person, { status: index === 3 ? 'CANCELLED' : 'APPROVED', cancelled: index === 3 || index === 4, revoked: index === 3,
        createdAt: index < dates.length ? `2026-11-${dates[index]}:00+09:00` : 'invalid-date' });
    });
    const people = seeded.participants;
    const check = (id, person, day, hour, extra = {}) => ({ id, participantId: person?.id || '', deskId: f.deskId, action: 'IN', at: `2026-11-${day}T${hour}:00:00+09:00`, corrected: false, ...extra });
    seeded.checks = [
      check('period-in-1', people[0], '18', '09'), check('period-in-repeat', people[0], '18', '10'),
      check('period-in-yesterday', people[1], '17', '11'), check('period-in-next-day', people[1], '18', '11'),
      check('period-in-corrected', people[2], '12', '11', { corrected: true }),
      check('period-in-review', people[4], '16', '11'), check('period-in-cancelled', people[3], '18', '11'),
      check('period-out', people[0], '18', '12', { action: 'OUT' }), check('period-no-person', null, '18', '12'),
      check('period-bad-time', people[0], '18', '13', { at: 'invalid-date' }),
    ];
    await write(seeded);
    await db.query("UPDATE events SET payload=jsonb_set(payload, '{date}', '\"2026-11-10\"'::jsonb), revision=revision+1 WHERE id=$1", [f.eventId]);
    const analysis = `${f.baseUrl}/console/events/${f.eventId}/analysis`;
    const overview = `${f.baseUrl}/console/events/${f.eventId}`;
    const bootstrap = `**/api/events/${f.eventId}/bootstrap`;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = lastPage = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(12000);
    await page.clock.setFixedTime(FIXED_NOW);

    await step('운영 현황 요약과 분석 진입', async () => {
      await page.goto(overview);
      const link = page.getByRole('link', { name: '기간 분석 보기', exact: true });
      await link.waitFor();
      const line = await link.locator('..').innerText();
      // 2026-11-19: the overview shows the flow as number tiles (오늘 신청 · 오늘 입장 · 최근 7일 신청).
      assert.match(line, /오늘 신청\s*1\s*명\s*오늘 입장\s*4\s*명\s*최근 7일 신청\s*4\s*명/);
      await link.click();
      await page.waitForURL(analysis);
      await page.getByRole('heading', { level: 1, name: '기간 분석', exact: true }).waitFor();
      assert.equal(await page.getByRole('radio', { name: '최근 7일', exact: true }).isChecked(), true);
      await assertNumbers(page, [4, 6, 5], LAST7);
      assert.equal(await page.locator(`.console-sidebar a[href="/console/events/${f.eventId}/analysis"]:visible`).count(), 1);
    });
    await step('기간 선택·요약·막대·표 값 일치', async () => {
      await page.getByRole('radio', { name: '오늘', exact: true }).focus();
      await page.keyboard.press('Space');
      await assertNumbers(page, [1, 4, 4], [LAST7[6]]);
      await page.getByRole('radio', { name: '어제', exact: true }).check();
      await assertNumbers(page, [1, 1, 1], [LAST7[5]]);
      await page.getByRole('radio', { name: '행사 전체', exact: true }).check();
      await assertNumbers(page, [6, 6, 5], FULL);
      assert.equal(await page.getByLabel('시작일', { exact: true }).count(), 0);
      await page.getByRole('radio', { name: '직접 선택', exact: true }).check();
      await page.getByLabel('시작일', { exact: true }).fill('2026-11-16');
      await page.getByLabel('종료일', { exact: true }).fill('2026-11-18');
      await assertNumbers(page, [3, 6, 5], LAST7.slice(4));
      await page.getByLabel('시작일', { exact: true }).fill('2026-11-19');
      await page.getByRole('alert').filter({ hasText: '시작 날짜가 끝 날짜보다 늦습니다' }).waitFor();
      assert.equal(await page.getByRole('table', { name: '선택 기간 일별 신청·입장' }).count(), 0);
      await page.getByLabel('시작일', { exact: true }).fill('2026-01-01');
      await page.getByLabel('종료일', { exact: true }).fill('2026-03-04');
      await page.getByText('최대 62일까지만 봅니다. 종료일을 2026-03-03로 맞췄습니다.', { exact: true }).waitFor();
      await page.getByRole('radio', { name: '최근 7일', exact: true }).check();
      await assertNumbers(page, [4, 6, 5], LAST7);
      await page.getByRole('button', { name: '0명 3일 보기', exact: true }).click();
      await assertNumbers(page, [4, 6, 5], LAST7, true);
      await page.getByRole('button', { name: '0명 3일 접기', exact: true }).click();
      const basis = page.getByRole('button', { name: '집계 기준', exact: true });
      await basis.click();
      assert.equal(await basis.getAttribute('aria-expanded'), 'true');
      await page.getByText(/취소 기록과 신청 상태가 다른 인원은 확인 전까지 포함합니다/).waitFor();
      await basis.click();
      assert.equal(await basis.getAttribute('aria-expanded'), 'false');
    });
    await step('데스크톱·모바일 머리와 터치·가로 넘침', async () => {
      for (const width of [1440, 390, 320]) {
        await page.setViewportSize({ width, height: width > 768 ? 900 : 844 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${width}px 가로 넘침`);
        for (const radio of await page.getByRole('radio').all()) assert.ok((await radio.boundingBox()).height >= 44);
        if (width <= 768) {
          const heading = await page.getByRole('heading', { level: 1, name: '기간 분석', exact: true }).boundingBox();
          const refresh = await page.getByRole('button', { name: '새로고침', exact: true }).boundingBox();
          assert.ok(Math.abs(heading.y - refresh.y) < 24, '모바일 새로고침은 제목 줄에 있다');
        }
        await page.screenshot({ path: path.join(out, `analysis-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    });
    await step('새 자료와 현재 날짜에 맞춰 저장된 프리셋 범위 갱신', async () => {
      await page.getByRole('radio', { name: '행사 전체', exact: true }).check();
      const earlier = structuredClone(seeded);
      earlier.participants[7].createdAt = '2026-10-31T12:00:00+09:00';
      await write(earlier);

      const hold = Promise.withResolvers();
      let requests = 0;
      await page.route(bootstrap, async route => {
        requests += 1;
        if (requests === 1) await hold.promise;
        return route.continue();
      });
      const refreshButton = page.getByRole('button', { name: '새로고침', exact: true });
      try {
        const requested = page.waitForRequest(bootstrap);
        await refreshButton.click();
        await requested;
        assert.equal(await refreshButton.getAttribute('aria-disabled'), 'true');
        await refreshButton.click({ force: true });
      } finally {
        hold.resolve();
      }
      await assertNumbers(page, [7, 6, 5], EXPANDED_FULL);
      assert.equal(requests, 1, '진행 중에 강제로 다시 눌러도 추가 자료 요청은 보내지 않는다');
      await page.unroute(bootstrap);
      assert.equal(await refreshButton.getAttribute('aria-disabled'), null, '자료 요청이 끝나면 새로고침을 다시 사용할 수 있다');
      assert.equal(await page.getByRole('radio', { name: '행사 전체', exact: true }).isChecked(), true);

      await page.getByRole('radio', { name: '어제', exact: true }).check();
      await assertNumbers(page, [1, 1, 1], [LAST7[5]]);
      await page.clock.setFixedTime(new Date('2026-11-19T03:00:00Z'));
      await page.getByRole('button', { name: '새로고침', exact: true }).click();
      await assertNumbers(page, [1, 4, 4], [LAST7[6]]);
      assert.equal(await page.getByRole('radio', { name: '어제', exact: true }).isChecked(), true);
      await page.getByRole('radio', { name: '오늘', exact: true }).check();
      await assertNumbers(page, [1, 0, 0], [['2026-11-19', 1, 0]]);

      await page.clock.setFixedTime(FIXED_NOW);
      await page.getByRole('button', { name: '새로고침', exact: true }).click();
      await assertNumbers(page, [1, 4, 4], [LAST7[6]]);
      await page.getByRole('radio', { name: '최근 7일', exact: true }).check();
      await assertNumbers(page, [4, 6, 5], LAST7);
      await write(seeded);
    });
    await step('최초 실패와 재조회 실패·시간 초과 후 복구', async () => {
      await page.route(bootstrap, route => route.abort('failed'));
      await page.reload();
      await page.getByRole('alert').filter({ hasText: FAILURE }).waitFor();
      await page.unroute(bootstrap);
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      await assertNumbers(page, [4, 6, 5], LAST7);

      await page.getByRole('radio', { name: '직접 선택', exact: true }).check();
      await page.getByLabel('시작일', { exact: true }).fill('2026-11-16');
      await page.getByLabel('종료일', { exact: true }).fill('2026-11-18');
      await assertNumbers(page, [3, 6, 5], LAST7.slice(4));
      await page.route(bootstrap, route => route.abort('failed'));
      await page.getByRole('button', { name: '새로고침', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: FAILURE }).waitFor();
      await page.unroute(bootstrap);
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      assert.equal(await page.getByRole('radio', { name: '직접 선택', exact: true }).isChecked(), true);
      assert.equal(await page.getByLabel('시작일', { exact: true }).inputValue(), '2026-11-16');
      assert.equal(await page.getByLabel('종료일', { exact: true }).inputValue(), '2026-11-18');
      await assertNumbers(page, [3, 6, 5], LAST7.slice(4));
      await page.getByRole('radio', { name: '최근 7일', exact: true }).check();
      await assertNumbers(page, [4, 6, 5], LAST7);
      const held = [];
      await page.route(bootstrap, route => { held.push(route); });
      const requested = page.waitForRequest(bootstrap);
      const started = Date.now();
      await page.getByRole('button', { name: '새로고침', exact: true }).click();
      await requested;
      await page.getByRole('alert').filter({ hasText: FAILURE }).waitFor({ timeout: 20000 });
      assert.ok(Date.now() - started >= 7000, '8초 요청 제한이 실제로 작동한다');
      await page.unroute(bootstrap);
      assert.ok(held.length > 0, '실제 요청을 보류한 뒤 AbortController의 시간 초과를 확인했다');
      await page.getByRole('button', { name: '다시 불러오기', exact: true }).click();
      await assertNumbers(page, [4, 6, 5], LAST7);
    });
    await step('부분 자료 손상은 0명으로 표시하지 않고 복구한다', async () => {
      for (const source of ['participants', 'checks']) {
        const damaged = structuredClone(seeded);
        damaged[source] = { synthetic: '손상된 원본' };
        await write(damaged);
        await page.reload();
        await page.getByText(/참가자 또는 출입 기록을 확인할 수 없어 기간 분석을 표시할 수 없습니다/).waitFor();
        assert.equal(await page.getByRole('table', { name: '선택 기간 일별 신청·입장' }).count(), 0);
        await write(seeded);
        await page.getByRole('button', { name: '새로고침', exact: true }).click();
        await assertNumbers(page, [4, 6, 5], LAST7);
      }
    });
    await step('빈 자료는 실제 0명과 빈 날짜로 표시한다', async () => {
      await write({ ...seeded, participants: [], checks: [] });
      await page.reload();
      await assertNumbers(page, [0, 0, 0], LAST7.map(([day]) => [day, 0, 0]));
      await page.getByRole('button', { name: '0명 7일 보기', exact: true }).click();
      await assertNumbers(page, [0, 0, 0], LAST7.map(([day]) => [day, 0, 0]), true);
      await page.screenshot({ path: path.join(out, 'analysis-empty.png'), fullPage: true });
      await write(seeded);
      await page.reload();
      await assertNumbers(page, [4, 6, 5], LAST7);
    });
    await step('실제 운영자·스태프 세션과 접근 거절·로그인 이동', async () => {
      const ownerCookie = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
      const owner = await browser.newContext({ locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
      await owner.addCookies([{ ...cookieForContext({ ...f, manager: { cookie: ownerCookie } }, 'manager'), url: f.baseUrl }]);
      const ownerPage = await owner.newPage();
      await ownerPage.clock.setFixedTime(FIXED_NOW);
      await ownerPage.goto(analysis);
      await assertNumbers(ownerPage, [4, 6, 5], LAST7);
      await owner.close();
      const staff = await browser.newContext({ locale: 'ko-KR' });
      await staff.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
      const staffPage = await staff.newPage();
      await staffPage.goto(analysis);
      await staffPage.getByText(/기간 분석은 행사 운영자만 볼 수 있습니다|행사에 대한 접근 권한을 확인하세요/).waitFor();
      assert.equal(await staffPage.getByRole('table', { name: '선택 기간 일별 신청·입장' }).count(), 0);
      await staff.close();
      await page.goto(`${f.baseUrl}/console/events/nonexistent-period-audit/analysis`);
      await page.getByRole('alert').filter({ hasText: '행사를 찾을 수 없습니다.' }).waitFor();
      const foreignId = `period-foreign-${f.suffix}`;
      await f.helpers.insertEvent(db, { orgId: f.helpers.LEGACY_ORG, id: foreignId, slug: foreignId,
        payload: { id: foreignId, slug: foreignId, name: '접근 불가 합성 행사', stage: 'LIVE' }, workspace: f.helpers.emptyWorkspace() });
      const forbidden = await context.request.get(`${f.baseUrl}/api/events/${foreignId}/bootstrap`);
      assert.equal(forbidden.status(), 404, '다른 행사의 존재 여부를 노출하지 않는다');
      await page.goto(`${f.baseUrl}/console/events/${foreignId}/analysis`);
      await page.getByRole('alert').filter({ hasText: '행사를 찾을 수 없습니다.' }).waitFor();
      // 서버의 실제 404 권한 경계와 별도로, 403 오류 응답의 화면 처리만 주입 검증한다.
      await page.route(bootstrap, route => route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"FORBIDDEN"}' }));
      await page.goto(analysis);
      await page.getByRole('alert').filter({ hasText: '행사에 대한 접근 권한을 확인하세요.' }).waitFor();
      await page.unroute(bootstrap);
      await context.clearCookies();
      await page.goto(analysis);
      await page.waitForURL(url => url.pathname === '/login');
      assert.ok(decodeURIComponent(page.url()).includes(`/console/events/${f.eventId}/analysis`), '로그인 후 돌아올 분석 경로를 보존한다');
    });
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify({ checks, errors }, null, 2), { flag: 'wx', mode: 0o600 });
    console.log(`기간 분석 브라우저 감사 통과: ${checks.length}개 흐름`);
  } catch (error) {
    if (lastPage && !lastPage.isClosed()) {
      try { await lastPage.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }); }
      catch (captureError) { console.error('실패 화면 저장 오류:', captureError.message); }
    }
    throw error;
  } finally {
    try { await browser?.close(); } finally { await f?.close(); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
