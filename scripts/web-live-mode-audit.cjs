'use strict';

// 현장 모드(/live)와 입장·스태프(/operations)를 실제 API·격리 DB로 검증한다.
// 세 칸이 그려지는지, 행사장 화면 출력 변경과 이벤트 열기·마감·추첨·경품 지급이
// 기존 명령으로 반영되는지, 읽기 전용 운영자에게 조작이 없는지, 진행 전·종료 후
// 단계 차단, 새로고침 실패 시 이전 내용 유지, 1280/768/390 가로 넘침을 확인한다.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

// 결정적인 화면: 브라우저 시계를 행사일 13:24(KST)로 고정하고 일정도 그 기준으로 둔다.
const EVENT_DATE = '2027-01-16';
const FIXED_NOW = new Date('2027-01-16T13:24:00+09:00');

async function seedLiveFixture(f) {
  const { requestJson } = f.helpers;
  const call = async (command, payload, cookie = f.manager.cookie) => {
    const response = await requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie, body: { commandId: crypto.randomUUID(), command, payload },
    });
    if (response.status < 200 || response.status >= 300) throw new Error(`seed ${command}: ${response.status} ${JSON.stringify(response.json)}`);
    return response.json;
  };
  await call('event.features', { features: ['venue', 'poll', 'quiz', 'qa', 'survey', 'draw', 'reward', 'screen'] });
  const cue = (title, start, end, place) => call('program.save', { title, date: EVENT_DATE, start, end, place, published: true });
  await cue('개회 · 대표 인사', '13:00', '13:20', '대강당');
  await cue('오프닝 OX 퀴즈', '13:20', '13:35', '대강당');
  await cue('세션 1 · Q&A', '13:35', '14:20', '세션룸 A');
  await cue('스탬프 투어', '14:20', '16:30', '로비');
  await cue('럭키 드로우', '16:40', '17:00', '대강당');

  const quiz = (await call('module.save', { type: 'quiz', title: '오프닝 OX 퀴즈', options: ['O', 'X'], answer: 'O' })).module;
  await call('module.status', { id: quiz.id, status: 'OPEN' });
  const poll = (await call('module.save', { type: 'poll', title: '가장 기대되는 세션은?', options: ['기조 발표', '분과 세션 A', '워크숍'] })).module;
  await call('module.status', { id: poll.id, status: 'OPEN' });
  const qa = (await call('module.save', { type: 'qa', title: '세션 1 · Q&A' })).module;
  const draw = (await call('module.save', { type: 'draw', title: '럭키 드로우' })).module;
  await call('module.status', { id: draw.id, status: 'OPEN' });
  const program = (await call('draw.program.save', { name: '현장 경품 추첨', moduleId: draw.id, quota: 3, status: 'OPEN', eligibility: 'PERSON', overlap: 'EVENT' })).program;

  // 입장: 스태프가 데스크에서 몇 명을 스캔한다(합성 데이터).
  const boot = await requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/bootstrap`, { method: 'GET', cookie: f.manager.cookie });
  const people = boot.json.state.workspaces[f.eventId].participants;
  let entered = 0;
  for (const person of people.slice(0, 5)) {
    const response = await requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.staff.cookie, body: { commandId: crypto.randomUUID(), command: 'check.scan', assignmentId: `audit-assign-${f.suffix}`.toLowerCase(), payload: { deskId: f.deskId, ticket: person.ticket } },
    });
    if (response.status < 300) entered += 1;
  }
  for (const [index, person] of people.slice(0, 3).entries()) {
    await call('reward.create', { participantId: person.id, name: ['제휴 커피 쿠폰', '스마트 워치', '기념품'][index], method: 'ONSITE' });
  }

  // 참여자가 낸 응답과 질문은 참가자 화면이 쓰는 저장소 모양 그대로 넣는다(격리 DB 전용).
  const db = f.harness.database;
  const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const workspace = await read();
  workspace.responses = [
    ...people.slice(0, 4).map((person, index) => ({ id: `live-q-${index}`, moduleId: quiz.id, participantId: person.id, answer: index === 3 ? 'X' : 'O', at: FIXED_NOW.toISOString() })),
    ...people.slice(0, 5).map((person, index) => ({ id: `live-p-${index}`, moduleId: poll.id, participantId: person.id, answer: ['기조 발표', '기조 발표', '분과 세션 A', '워크숍', '기조 발표'][index], at: FIXED_NOW.toISOString() })),
  ];
  workspace.questions = [
    { id: 'live-question-1', moduleId: qa.id, name: '김하나', text: '발표 자료는 어디서 받을 수 있나요?', answer: '', approved: false, likes: [], at: FIXED_NOW.toISOString() },
    { id: 'live-question-2', moduleId: qa.id, name: '이두리', text: '다음 세션 장소가 궁금합니다.', answer: '', approved: false, likes: [], at: FIXED_NOW.toISOString() },
  ];
  await db.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  await call('display.set', { type: 'poll', moduleId: poll.id });
  return { quiz, poll, qa, draw, program, entered, people };
}

async function readWorkspace(f) {
  return (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
}

module.exports = { EVENT_DATE, FIXED_NOW, seedLiveFixture, readWorkspace };

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'live-mode'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  let f, browser, lastPage;
  const errors = [], checks = [];
  const step = async (name, run) => { await run(); checks.push(name); console.log(`PASS: ${name}`); };
  try {
    f = await startAuditFixture();
    const seed = await seedLiveFixture(f);
    const base = `${f.baseUrl}/console/events/${f.eventId}`;
    browser = await launchBrowser();
    const open = async (cookieWho, { width = 1440, height = 900 } = {}) => {
      const context = await browser.newContext({ viewport: { width, height }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
      await context.addCookies([{ ...cookieForContext(f, cookieWho), url: f.baseUrl }]);
      const page = await context.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      page.setDefaultTimeout(15000);
      await page.clock.setFixedTime(FIXED_NOW);
      lastPage = page;
      return { context, page };
    };
    const room = (page) => page.locator('[data-live-room]');
    const goLive = async (page) => { await page.goto(`${base}/live`); await room(page).waitFor(); };
    const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    const notice = (page, text) => page.locator('[aria-live="polite"]').getByText(text).waitFor();
    const { page } = await open('manager');

    await step('세 칸(진행 순서·행사장 화면·실시간 응답)과 상단 현황', async () => {
      await goLive(page);
      for (const pane of ['cues', 'stage', 'side']) await page.locator(`[data-live-pane="${pane}"]`).waitFor();
      const top = await room(page).locator('header').innerText();
      assert.match(top, /감사 검증 행사/);
      assert.match(top, /13:24/);
      assert.match(top, /입장 5 \/ 등록 8/);
      assert.match(top, /행사장 화면 송출 중/);
      assert.equal(await page.getByRole('link', { name: '관리 화면으로' }).getAttribute('href'), `/console/events/${f.eventId}`);
      assert.equal(await page.locator('[data-console-page="live"]').count(), 1);
      // 진행 순서: 지난 일정·지금·다음이 시계로 정해진다.
      const current = page.locator('[data-live-pane="cues"] li[aria-current="step"]');
      assert.match(await current.innerText(), /오프닝 OX 퀴즈/);
      assert.match(await page.locator('[data-live-pane="cues"]').innerText(), /지난 일정\s*개회 · 대표 인사/);
      assert.match(await page.locator('[data-live-pane="cues"]').innerText(), /다음\s*세션 1 · Q&A/);
      // 열려 있는 이벤트가 지금 순서 아래에 붙는다.
      assert.ok(await current.getByRole('button', { name: /가장 기대되는 세션은\?/ }).count(), '지금 열린 투표가 현재 순서 아래에 있다');
      // TV 틀과 현재 출력.
      assert.ok(await page.locator('[data-live-tv] iframe').count(), '행사장 화면 미리보기');
      assert.match(await page.locator('[data-live-tv]').innerText(), /현재 출력 ·\s*투표 · 가장 기대되는 세션은\?/);
      // 오른쪽: 응답 수, 다음 할 일, 검토 대기, 경품.
      const side = await page.locator('[data-live-pane="side"]').innerText();
      assert.match(side, /실시간 응답/);
      assert.match(side, /다음에 할 일/);
      assert.match(side, /Q&A 확인/);
      assert.match(side, /경품 지급 대기/);
      assert.equal(await page.locator('[data-live-rewards] li').count(), 3);
    });

    await step('행사장 화면 출력 변경: 같은 display.set, 선택 전에는 적용 불가', async () => {
      const apply = page.getByRole('button', { name: '출력 적용', exact: true });
      assert.equal(await apply.getAttribute('aria-disabled'), 'true');
      await page.getByLabel('행사장 화면 출력 선택').selectOption({ label: '유휴 화면 (안내 없음)' });
      await page.getByText('선택한 출력은 아직 적용되지 않았습니다').waitFor();
      await page.getByRole('button', { name: '유휴로 내리기', exact: true }).click();
      await notice(page, '행사장 화면을 유휴 화면으로 바꿨습니다.');
      assert.equal((await readWorkspace(f)).display.type, 'idle');
      await page.getByText('행사장 화면 대기 중').first().waitFor();
      await page.getByLabel('행사장 화면 출력 선택').selectOption({ label: '투표 · 가장 기대되는 세션은?' });
      await page.getByRole('button', { name: '출력 적용', exact: true }).click();
      await notice(page, '행사장 화면 출력을 바꿨습니다.');
      assert.equal((await readWorkspace(f)).display.moduleId, seed.poll.id);
    });

    await step('이벤트 열기·마감은 확인을 거친 module.status', async () => {
      await page.getByRole('button', { name: /세션 1 · Q&A.*준비 중/ }).first().click();
      await page.getByRole('button', { name: '열기', exact: true }).click();
      await page.getByText('“세션 1 · Q&A”을(를) 열까요?').waitFor();
      await page.getByRole('button', { name: '취소', exact: true }).click();
      assert.equal((await readWorkspace(f)).modules.find((m) => m.id === seed.qa.id).status, 'DRAFT', '취소하면 바뀌지 않는다');
      await page.getByRole('button', { name: '열기', exact: true }).click();
      await page.getByRole('button', { name: '연다', exact: true }).click();
      await notice(page, '“세션 1 · Q&A”을(를) 열었습니다.');
      assert.equal((await readWorkspace(f)).modules.find((m) => m.id === seed.qa.id).status, 'OPEN');
      await page.getByRole('button', { name: '마감', exact: true }).click();
      await page.getByRole('button', { name: '마감한다', exact: true }).click();
      await notice(page, '“세션 1 · Q&A”을(를) 마감했습니다.');
      assert.equal((await readWorkspace(f)).modules.find((m) => m.id === seed.qa.id).status, 'CLOSED');
    });

    await step('추첨 실행은 확인 후 draw.program.run, 경품 지급은 reward.fulfill', async () => {
      await page.getByRole('button', { name: '추첨 실행', exact: true }).last().click();
      await page.getByText(/“현장 경품 추첨”에서 1명을 추첨할까요/).waitFor();
      await page.getByRole('button', { name: '실행한다', exact: true }).click();
      await notice(page, '1명을 추첨했습니다.');
      assert.equal((await readWorkspace(f)).drawPrograms.find((p) => p.id === seed.program.id).winners.length, 1);
      await page.getByRole('button', { name: /지급 처리$/ }).first().click();
      // 지급은 되돌릴 수 없어 그 줄에서 먼저 확인한다 (경품 지급 화면과 같은 방식).
      await page.getByText(/님께 .+을\(를\) 지급할까요\? 처리한 뒤에는 취소할 수 없습니다/).waitFor();
      await page.getByRole('button', { name: '지급 처리하기', exact: true }).click();
      await page.locator('[aria-live="polite"]').getByText(/지급을 기록했습니다/).waitFor();
      assert.equal((await readWorkspace(f)).rewards.filter((reward) => reward.status === 'RECEIVED').length, 1);
      await page.waitForFunction(() => document.querySelectorAll('[data-live-rewards] li').length === 3); // 남은 2건 + 방금 추첨으로 생긴 경품 1건
    });

    await step('새로고침이 실패해도 이전 내용을 지우지 않고 다시 시도할 수 있다', async () => {
      const bootstrap = `**/api/events/${f.eventId}/bootstrap**`;
      await page.route(bootstrap, (route) => route.abort());
      await page.getByRole('button', { name: '지금 확인' }).click();
      await page.locator('[data-live-refresh-error]').waitFor();
      assert.ok(await page.locator('[data-live-pane="stage"]').isVisible(), '화면은 그대로');
      assert.match(await page.locator('[data-live-pane="cues"]').innerText(), /오프닝 OX 퀴즈/);
      await page.unroute(bootstrap);
      await page.getByRole('button', { name: '다시 시도', exact: true }).click();
      await page.locator('[data-live-refresh-error]').waitFor({ state: 'detached' });
    });

    await step('데스크톱·태블릿·휴대폰: 가로 넘침 없음, 조작 48px, 좁은 화면은 화면 미리보기가 먼저', async () => {
      for (const width of [1280, 768, 390]) {
        await page.setViewportSize({ width, height: width > 768 ? 900 : 1000 });
        await page.waitForTimeout(250);
        assert.ok((await overflow(page)) <= 1, `${width}px 가로 넘침 ${await overflow(page)}`);
        const small = await page.locator('[data-live-room] [data-product-action]:visible').evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().height < 43).map((node) => node.textContent.trim()));
        assert.deepEqual(small, [], `${width}px 44px 미만 조작`);
        if (width <= 768) {
          const stage = await page.locator('[data-live-pane="stage"]').boundingBox();
          const cues = await page.locator('[data-live-pane="cues"]').boundingBox();
          assert.ok(cues.height < 130, `접힌 진행 순서는 한 줄 요약 ${cues.height}`);
          assert.equal(await page.locator('[data-live-pane="cues"] details').evaluate((node) => node.open), false);
          assert.ok(stage.y < 700, `화면 미리보기가 첫 화면 안에 있다 ${stage.y}`);
        } else {
          assert.equal(await page.locator('[data-live-pane="cues"] details').evaluate((node) => node.open), true);
          const boxes = await Promise.all(['cues', 'stage', 'side'].map((pane) => page.locator(`[data-live-pane="${pane}"]`).boundingBox()));
          assert.ok(boxes[0].x < boxes[1].x && boxes[1].x < boxes[2].x, '세 칸이 왼쪽부터 놓인다');
        }
        await page.screenshot({ path: path.join(out, `live-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 900 });
    });

    await step('진행 전 단계는 안내만, 종료 후에는 읽기 전용', async () => {
      const db = f.harness.database;
      const setStage = (stage) => db.query("UPDATE events SET payload=jsonb_set(payload, '{stage}', to_jsonb($2::text)), revision=revision+1 WHERE id=$1", [f.eventId, stage]);
      await setStage('READY');
      await page.goto(`${base}/live`);
      await page.getByRole('heading', { name: '행사를 진행 중 단계로 바꾸면 사용할 수 있습니다' }).waitFor();
      assert.match(await page.getByRole('link', { name: '행사 설정에서 단계 바꾸기' }).getAttribute('href'), /\/settings#settings-stage$/);
      assert.equal(await page.locator('[data-live-room]').count(), 0);
      await setStage('ENDED');
      await page.goto(`${base}/live`);
      await room(page).waitFor();
      await page.getByText('현장 모드는 읽기 전용입니다').waitFor();
      const labels = ['열기', '마감', '출력 적용', '추첨 실행', '지급'];
      for (const label of labels) assert.equal(await page.getByRole('button', { name: new RegExp(`^${label}`) }).count(), 0, `종료 후 ${label} 없음`);
      await page.screenshot({ path: path.join(out, 'live-ended.png'), fullPage: true });
      await setStage('LIVE');
    });

    await step('읽기 전용 운영자는 같은 화면을 보지만 조작 버튼이 없다', async () => {
      const { helpers, harness } = f;
      const readerId = `audit-reader-${f.suffix}`.toLowerCase();
      await helpers.insertAccount(harness.database, { orgId: helpers.LEGACY_ORG, id: readerId, role: 'MANAGER', name: '읽기 운영자', email: `${readerId}@example.test` });
      await helpers.insertMembership(harness.database, readerId, f.eventId, []);
      const cookie = await helpers.sessionCookie(harness, readerId);
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), httpOnly: true, sameSite: 'Lax', url: f.baseUrl }]);
      const reader = await context.newPage();
      reader.on('pageerror', (error) => errors.push(error.message));
      reader.setDefaultTimeout(15000);
      await reader.clock.setFixedTime(FIXED_NOW);
      lastPage = reader;
      await reader.goto(`${base}/live`);
      await room(reader).waitFor();
      for (const pane of ['cues', 'stage', 'side']) await reader.locator(`[data-live-pane="${pane}"]`).waitFor();
      await reader.getByText(/현장 진행 권한이 없어 조회만 할 수 있습니다/).waitFor();
      for (const label of ['열기', '마감', '다시 열기', '출력 적용', '추첨 실행', '지급']) assert.equal(await reader.getByRole('button', { name: new RegExp(`^${label}`) }).count(), 0, `읽기 전용에 ${label} 없음`);
      assert.equal(await reader.locator('#live-display-pick').count(), 0);
      assert.match(await reader.locator('[data-live-pane="side"]').innerText(), /경품 지급 대기/);
      await reader.screenshot({ path: path.join(out, 'live-readonly.png'), fullPage: true });
      await context.close();
    });

    await step('입장·스태프: 세 단계, 전광판 출력과 요약 카드는 이 화면에 없다', async () => {
      await page.goto(`${base}/operations`);
      await page.getByRole('heading', { level: 1, name: '입장·스태프' }).waitFor();
      for (const step of ['입장 데스크 만들기', '스태프 배정', '스태프 폰에서 스캔']) await page.getByRole('heading', { name: step }).waitFor();
      const text = await page.locator('main').innerText();
      assert.doesNotMatch(text, /전광판 출력/);
      assert.equal(await page.locator('#ops-display-pick').count(), 0);
      assert.equal(await page.getByRole('group', { name: '현장 운영 요약' }).count(), 0);
      assert.ok(await page.locator('[data-device="phone"]').count(), '스태프 스캔 화면 미리보기');
      assert.ok((await overflow(page)) <= 1);
      await page.screenshot({ path: path.join(out, 'operations-1440.png'), fullPage: true });
      await page.setViewportSize({ width: 390, height: 900 });
      assert.ok((await overflow(page)) <= 1, '390px 가로 넘침');
      await page.screenshot({ path: path.join(out, 'operations-390.png'), fullPage: true });
    });

    assert.deepEqual(errors, [], `페이지 오류: ${errors.join('; ')}`);
    console.log(`web-live-mode-audit: ${checks.length} checks passed; captures in ${out}`);
  } catch (error) {
    if (lastPage) await lastPage.screenshot({ path: path.join(out || process.cwd(), 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (f) await f.close().catch(() => {});
  }
}

if (require.main === module) main().catch((error) => { console.error(error); process.exit(1); });
