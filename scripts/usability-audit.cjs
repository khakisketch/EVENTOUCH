'use strict';

// Usability audit: measures how many user operations it takes to finish real
// field goals in the running product, and where operators/attendees get
// stuck. Source-contract tests prove strings exist; axe/overflow audits prove
// rendering health. Neither proves a goal is reachable. This fills that gap.
//
// Execution: serial (`npm run audit:usability`). Environment: startAuditFixture
// boots an owned Next production server bound to the real isolated API
// harness on a loopback port (same shape as the web/mobile/console audits).
// No preview, production, or user data is touched: all writes land in the
// harness's random PostgreSQL schema, dropped on fixture.close().
//
// Messaging posture is forced before any helper loads: provider keys are
// deleted, EVENTOUCH_SMS_MOCK=1 is set, and campaigns are sent without
// simulate so they land as NEEDS_CONNECTION (recorded, never delivered).
//
// What each task measures:
//   steps          user operations to reach the goal (click/fill/select/check
//                  each count once). null on failure.
//   scrolls        vertical scroll events during the task (finding-cost proxy;
//                  includes Playwright actionability scrolls). Must be <= 6.
//   resultVisible  the goal-achieved copy is actually on screen.
//   serverState    the goal is also confirmed in server state (bootstrap);
//                  null with a reason when not confirmable.
//   errors         pageerror events, 4xx/5xx API/document responses, and
//                  failure copy. Any one fails the task.
//   keyboardStops  Actual shortest keyboard path to the task's primary
//                  action button (cap 40). Unreachable fails. Definition:
//                  - focusable skip link present -> Tab once to it, Enter to
//                    move focus into #main-content (verified by checking
//                    document.activeElement), then Tabs inside main. The
//                    value is 1 + in-main Tabs. A skip link that does not
//                    actually move focus fails the task (verified per page).
//                  - target inside an open modal dialog -> Tabs inside the
//                    focus trap (the skip link is unreachable behind it).
//                  - target outside #main-content, or no skip link ->
//                    top-only Tabs, marked as such in the result.
//   keyboardStopsRaw  The naive top-only Tab sweep, always recorded for
//                  transparency. The pass criterion applies to the corrected
//                  keyboardStops; tasks whose raw exceeds 40 are named in the
//                  report instead of being hidden.
//
// Thresholds (also written into the report): operator tasks must finish in
// <= 12 steps, attendee tasks in <= 10 steps; scrolls <= 6 per task;
// keyboardStops <= 40. The caps are justified in the console report from the
// actually achieved values, never loosened to force a pass.
//
// Evidence: result JSON + per-task screenshots under
// /tmp/opencode/eventouch-captures/usability-<YYYYMMDD>/ (never in the repo).
//
// What this tool cannot measure (by design): comprehension, preference,
// satisfaction, screen-reader experience, real-device touch behavior, and
// real message delivery. Those need humans; see the report output.

for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) {
  delete process.env[key];
}
process.env.EVENTOUCH_SMS_MOCK = '1';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');

const OPERATOR_STEP_CAP = 12;
const ATTENDEE_STEP_CAP = 10;
const SCROLL_CAP = 6;
const KEYBOARD_CAP = 40;

const FAILURE_COPY = /(실패|못했습니다|오류|Application error|Something went wrong|Minified React)/;

function datestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
}

const CAPTURE_DIR = `/tmp/opencode/eventouch-captures/usability-${datestamp()}`;

function sessionValue(cookie) {
  return decodeURIComponent(String(cookie).slice('etko_session='.length));
}

function commandId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function apiCommand(helpers, baseUrl, cookie, eventId, command, payload, assignmentId) {
  const response = await helpers.requestJson(baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId('usability-audit'), command, payload, ...(assignmentId ? { assignmentId } : {}) },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`seed ${command}: ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

async function readBootstrap(helpers, baseUrl, cookie) {
  const response = await helpers.requestJson(baseUrl, '/api/bootstrap', { cookie });
  if (response.status !== 200) throw new Error(`bootstrap: ${response.status}`);
  return response.json.state;
}

// Test-only setup through real commands and helpers (never UI): the step
// counts below must reflect the product as a user finds it, not our setup.
async function extendFixtureSeed(fixture) {
  const { harness, helpers, manager, staff, eventId, suffix } = fixture;
  const baseUrl = harness.baseUrl;
  const managerCookie = manager.cookie;
  const run = (command, payload) => apiCommand(helpers, baseUrl, managerCookie, eventId, command, payload);

  // Booth work needs the stamp feature; the base fixture does not enable it.
  await run('event.features', { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp'] });
  // The register form must show the consent agreement the task fills in.
  await run('form.publish', { consentText: '사용성 감사: 이름·연락처를 행사 운영에만 씁니다.' });

  // Task 1: one genuinely pending participant to approve.
  const pendingName = '사용성 대기 김';
  const imported = await run('participant.import', {
    rows: [{ name: pendingName, phone: '01088881111', company: '사용성 업체' }],
  });
  const pendingPerson = (imported.participants || [])[0];
  if (!pendingPerson) throw new Error('seed participant.import: no participant returned');
  await run('participant.status', { id: pendingPerson.id, status: 'PENDING' });

  // Task 8: an open booth in SELF mode (no visits exist yet, so the mode is
  // still switchable) plus one voting team and an open 1-pick vote (task 9).
  const booth = (await run('booth.save', {
    name: '사용성 부스', zone: '가구역', status: 'OPEN', capacity: 0, limit: 1,
  })).booth;
  await run('booth.mode', { mode: 'SELF', acknowledge: true });
  await run('team.save', { name: '사용성 팀 가' });
  await run('vote.config.save', { pickCount: 1, status: 'OPEN' });

  // Task 5: a second, unassigned staffer so the assign flow really picks an
  // account. accounts.active defaults to true (001_initial.sql).
  const staff2Id = `usability-staff2-${suffix}`.toLowerCase();
  await helpers.insertAccount(harness.database, {
    id: staff2Id, role: 'STAFF', name: '사용성 스태프', email: `${staff2Id}@example.test`,
  });

  return {
    pendingName,
    boothId: String(booth.id),
    teamName: '사용성 팀 가',
    staff2Id,
    staff2Name: '사용성 스태프',
    deskAssignId: `audit-assign-${suffix}`.toLowerCase(),
  };
}

// Per-task instrumentation. Steps count explicit user operations only;
// keyboard probing Tabs are a separate metric and never inflate steps.
function createTask(key, title, actor, stepCap) {
  return {
    key, title, actor, stepCap,
    steps: 0,
    blocked: false,
    scrolls: null,
    keyboardStops: null,
    keyboardStopsRaw: null,
    keyboardSkip: '',
    skipLink: '',
    skipVerified: false,
    keyboardNote: '',
    resultVisible: false,
    resultNote: '',
    serverState: null,
    serverNote: '',
    errors: [],
    passed: false,
    detail: '',
    milliseconds: 0,
  };
}

async function act(task, fn) {
  task.steps += 1;
  return fn();
}

async function installScrollCounter(page) {
  await page.evaluate(() => {
    window.__usScrolls = 0;
    window.__usLastY = window.scrollY;
    window.__usLastCount = 0;
    window.__usOnScroll = () => {
      // One gesture, one count: a smooth scrollIntoView animation fires many
      // scroll events, but the user experiences a single jump. Count a new
      // scroll only after the previous one settled (>400ms) and moved >80px.
      const now = Date.now();
      if (Math.abs(window.scrollY - window.__usLastY) > 80 && now - window.__usLastCount > 400) {
        window.__usScrolls += 1;
        window.__usLastCount = now;
      }
      window.__usLastY = window.scrollY;
    };
    window.addEventListener('scroll', window.__usOnScroll, { passive: true });
  });
}

async function readScrolls(page) {
  return page.evaluate(() => Number(window.__usScrolls) || 0).catch(() => 0);
}

function attachErrorListeners(page, task, baseUrl) {
  page.on('pageerror', (error) => {
    task.errors.push(`pageerror: ${String((error && error.message) || error).split('\n')[0]}`);
  });
  page.on('response', (response) => {
    const status = response.status();
    if (status < 400) return;
    const url = response.url();
    if (!url.startsWith(baseUrl)) return;
    if (url.includes('/api/') || response.request().resourceType() === 'document') {
      task.errors.push(`http ${status}: ${url.split('?')[0].slice(url.indexOf('/', 8))}`);
    }
  });
}

// Visible failure copy at task end. Static help text on these screens never
// contains these phrases; anything matched here is a real failure surface.
async function collectFailureCopy(page, task) {
  const texts = await page.evaluate(() => {
    const alerts = [...document.querySelectorAll('[role="alert"]')]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      })
      .map((element) => element.innerText.replace(/\s+/g, ' ').trim());
    const body = document.body ? document.body.innerText.replace(/\s+/g, ' ').slice(0, 4000) : '';
    return { alerts, body };
  }).catch(() => ({ alerts: [], body: '' }));
  for (const alert of texts.alerts) {
    task.errors.push(`화면 오류 문구: ${alert.slice(0, 120)}`);
  }
  const match = texts.body.match(FAILURE_COPY);
  if (match && texts.alerts.length === 0) {
    const index = texts.body.indexOf(match[0]);
    task.errors.push(`실패류 문구: …${texts.body.slice(Math.max(0, index - 40), index + 80)}…`);
  }
}

// Tab from the ready state until focus lands on the target. The target is
// tagged in-DOM so the check survives re-renders; a full cycle back to the
// start without landing counts as unreachable (focus trap / hidden control).
async function activeInfo(page) {
  return page.evaluate(() => {
    const active = document.activeElement;
    if (!active || active === document.body) return { where: 'body', isSkip: false };
    return {
      where: 'element',
      isSkip: active.tagName === 'A' && active.classList.contains('skip-link'),
    };
  }).catch(() => ({ where: 'unknown', isSkip: false }));
}

async function resetFocus(page) {
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    document.body.setAttribute('tabindex', '-1');
    document.body.focus();
  }).catch(() => {});
}

async function focusedMainId(page) {
  return page.evaluate(
    () => (document.activeElement ? document.activeElement.id || '' : ''),
  ).catch(() => '');
}

// Skip-link verification (pass criterion 4): runs on the ready page BEFORE
// any task act, so no modal can be open yet and the real first-Tab path is
// observed without trap interference. Passes only when Tab lands on the
// skip link AND Enter moves focus to #main-content (document.activeElement
// check). A present-but-non-moving link marks the task broken, which fails
// it in finishTask. Runs before the scroll counter is installed, so the
// verification's own scrolling never pollutes the scrolls metric.
async function verifySkipLink(page, task) {
  try {
    await resetFocus(page);
    await page.keyboard.press('Tab');
    const first = await activeInfo(page);
    if (!first.isSkip) {
      task.skipLink = 'absent';
      task.skipVerified = false;
      task.detail += ' [스킵 링크 없음: 최상단 Tab 경로로 측정]';
      return;
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    if ((await focusedMainId(page)) === 'main-content') {
      task.skipLink = 'present';
      task.skipVerified = true;
    } else {
      task.skipLink = 'broken';
      task.skipVerified = false;
    }
  } catch (error) {
    task.skipLink = 'absent';
    task.skipVerified = false;
    task.detail += ` [스킵 링크 확인 불가: ${String((error && error.message) || error).split('\n')[0]}]`;
  } finally {
    await resetFocus(page);
  }
}

// Corrected keyboard measurement: the actual shortest path, caps unchanged.
// keyboardStopsRaw always records the naive top-only sweep for transparency;
// keyboardStops records the corrected path the pass criterion judges.
async function probeKeyboard(page, task, locator, label) {
  const sweep = async (max) => {
    for (let stops = 1; stops <= max; stops += 1) {
      await page.keyboard.press('Tab');
      const landed = await page.evaluate(() => {
        const active = document.activeElement;
        return !!(active && active.dataset && active.dataset.usTarget === '1');
      }).catch(() => false);
      if (landed) return stops;
    }
    return null;
  };
  try {
    await locator.first().waitFor({ state: 'visible', timeout: 10000 });
    await locator.first().evaluate((element) => { element.dataset.usTarget = '1'; });
    // Raw path first: naive top-only sweep, always recorded.
    await resetFocus(page);
    const raw = await sweep(KEYBOARD_CAP);
    task.keyboardStopsRaw = raw;

    const placement = await locator.first().evaluate((element) => ({
      inDialog: !!(element.closest && element.closest('[role="dialog"]')),
      inMain: !!(element.closest && element.closest('#main-content')),
    })).catch(() => ({ inDialog: false, inMain: false }));

    if (placement.inDialog) {
      // Modal trap: the skip link sits unreachable behind the dialog and the
      // dialog holds every Tab inside itself, so the real path starts where
      // the dialog put focus. Count within the trap.
      await locator.first().evaluate((element) => {
        const dialog = element.closest('[role="dialog"]');
        if (dialog) dialog.focus();
      }).catch(() => {});
      const inDialog = await sweep(KEYBOARD_CAP);
      task.keyboardStops = inDialog;
      task.keyboardSkip = 'modal';
      task.keyboardNote = inDialog === null
        ? `${label}에 모달 안에서 Tab ${KEYBOARD_CAP}회 내 도달 불가`
        : `${label}까지 모달 안 Tab ${inDialog}회(포커스 트랩 안 최단 경로, raw ${raw === null ? '40회 초과' : `${raw}회`})`;
      return inDialog;
    }
    if (!placement.inMain) {
      task.keyboardStops = raw;
      task.keyboardSkip = 'outside-main';
      task.keyboardNote = raw === null
        ? `${label}에 최상단 Tab ${KEYBOARD_CAP}회 내 도달 불가(본문 밖 목표)`
        : `${label}까지 최상단 Tab ${raw}회(본문 밖 목표)`;
      return raw;
    }
    if (task.skipLink !== 'present') {
      task.keyboardStops = raw;
      task.keyboardSkip = task.skipLink === 'broken' ? 'broken' : 'none';
      task.keyboardNote = raw === null
        ? `${label}에 Tab ${KEYBOARD_CAP}회 내 도달 불가(스킵 링크 ${task.skipLink === 'broken' ? '미동작' : '없음'})`
        : `${label}까지 Tab ${raw}회(스킵 링크 ${task.skipLink === 'broken' ? '미동작' : '없음'} — 최상단 경로)`;
      return raw;
    }
    // Skip path, re-run for real and counted: Tab to the verified skip
    // link, Enter into #main-content, then Tabs inside main.
    await resetFocus(page);
    await page.keyboard.press('Tab');
    if (!(await activeInfo(page)).isSkip) {
      task.keyboardStops = raw;
      task.keyboardSkip = 'skip-unstable';
      task.keyboardNote = `${label}까지 Tab ${raw === null ? `${KEYBOARD_CAP}회 내 도달 불가` : `${raw}회`}(스킵 링크 재현 불안정 — 최상단 경로로 대체)`;
      return raw;
    }
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    if ((await focusedMainId(page)) !== 'main-content') {
      task.skipLink = 'broken';
      task.skipVerified = false;
      task.keyboardStops = null;
      task.keyboardSkip = 'broken';
      task.keyboardNote = `${label}: 측정 중 스킵 링크가 포커스를 옮기지 못함(준비 시에는 동작) — 실패로 기록`;
      return null;
    }
    const inMain = await sweep(KEYBOARD_CAP);
    if (inMain === null) {
      task.keyboardStops = null;
      task.keyboardSkip = 'skip';
      task.keyboardNote = `${label}에 본문 안에서 Tab ${KEYBOARD_CAP}회 내 도달 불가(스킵 이후)`;
      return null;
    }
    task.keyboardStops = 1 + inMain;
    task.keyboardSkip = 'skip';
    task.keyboardNote = `${label}까지 스킵 경로 Tab 1+${inMain}=${1 + inMain}회(Enter 1회, raw ${raw === null ? '40회 초과' : `${raw}회`})`;
    return task.keyboardStops;
  } catch (error) {
    task.keyboardStops = null;
    task.keyboardNote = `${label} 키보드 측정 불가: ${String((error && error.message) || error).split('\n')[0]}`;
    return null;
  } finally {
    await locator.first().evaluate((element) => { delete element.dataset.usTarget; }).catch(() => {});
  }
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(CAPTURE_DIR, name) }).catch(() => {});
}

// A single isVisible() snapshot races the list refetch that follows every
// successful write (load(true)/reload). Wait instead, so the check observes
// the settled list the operator actually ends on.
async function settledVisible(locator, timeout = 10000) {
  try {
    await locator.first().waitFor({ state: 'visible', timeout });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  let fixture;
  try {
    fixture = await startAuditFixture();
  } catch (error) {
    process.stderr.write(`[usability-audit] fixture: ${error && error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const tasks = [];
  let browser;
  const startedAll = Date.now();
  try {
    let seed;
    try {
      seed = await extendFixtureSeed(fixture);
    } catch (error) {
      process.stderr.write(`[usability-audit] seed: ${error && error.message}\n`);
      process.exitCode = 2;
      return;
    }
    const { helpers, eventId, slug } = fixture;
    const baseUrl = fixture.baseUrl;
    const managerSession = sessionValue(fixture.manager.cookie);
    browser = await launchBrowser();

    const newOperatorPage = async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: managerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      return { context, page };
    };
    const newAttendeePage = async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
      const page = await context.newPage();
      return { context, page };
    };

    const finishTask = async (task, page, started) => {
      task.milliseconds = Date.now() - started;
      // A blocked task never reached its goal: steps is null by definition,
      // never a partial count that could read as progress.
      if (task.blocked) task.steps = null;
      if (!task.keyboardNote) task.keyboardNote = '미측정(과제 중단)';
      task.scrolls = await readScrolls(page);
      await collectFailureCopy(page, task);
      const stepOk = task.steps !== null && task.steps <= task.stepCap;
      const scrollOk = task.scrolls !== null && task.scrolls <= SCROLL_CAP;
      const keyboardOk = task.keyboardStops !== null && task.keyboardStops <= KEYBOARD_CAP;
      const serverOk = task.serverState !== null;
      // A present-but-non-moving skip link fails the task outright: the
      // shortcut the keyboard path depends on is broken.
      const skipOk = task.skipLink !== 'broken';
      task.passed = stepOk && scrollOk && keyboardOk && task.resultVisible && serverOk && task.errors.length === 0 && skipOk;
      if (!stepOk) task.detail += ` [steps ${task.steps}/${task.stepCap}]`;
      if (!scrollOk) task.detail += ` [scrolls ${task.scrolls}/${SCROLL_CAP}]`;
      if (!keyboardOk) task.detail += ` [keyboard ${task.keyboardNote}]`;
      if (!skipOk) task.detail += ' [스킵 링크 미동작: Tab→Enter 후 #main-content로 포커스 이동 없음]';
      if (!task.resultVisible) task.detail += ` [결과 문구 미확인: ${task.resultNote}]`;
      if (!serverOk) task.detail += ` [서버 미확인: ${task.serverNote}]`;
      tasks.push(task);
    };

    // ---- Task 1: approve one pending participant (operator) ----
    {
      const task = createTask('approve', '대기 참가자 1명 승인', 'operator', OPERATOR_STEP_CAP);
      const started = Date.now();
      const { context, page } = await newOperatorPage();
      attachErrorListeners(page, task, baseUrl);
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('input[placeholder*="이름·소속·연락처 검색"]').first().waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.locator('input[placeholder*="이름·소속·연락처 검색"]').first().fill('사용성 대기'));
        await act(task, () => page.getByRole('checkbox', { name: `${seed.pendingName} 선택` }).check());
        await probeKeyboard(page, task, page.locator('#roster-approve-selected'), '선택 승인 버튼');
        await act(task, () => page.locator('#roster-approve-selected').click());
        await page.getByText(/명을 승인했습니다/).first().waitFor({ timeout: 15000 });
        const notice = await page.getByText(/명을 승인했습니다/).first().innerText().catch(() => '');
        // Scope the chip to the person's row: the status filter <select>
        // above holds hidden <option> copies of the same labels, so an
        // unscoped first-match would read the filter, not the list.
        const row = page.locator('li').filter({ hasText: seed.pendingName }).first();
        const approvedChip = await settledVisible(row.getByText('참가 확정', { exact: true }));
        task.resultVisible = notice.includes(seed.pendingName) && approvedChip;
        task.resultNote = `승인 안내 "${notice.replace(/\s+/g, ' ').slice(0, 60)}" + 목록에 참가 확정 표시`;
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const person = state.workspaces[eventId].participants.find((item) => item.name === seed.pendingName);
          task.serverState = person && person.status === 'APPROVED' ? `bootstrap status=${person.status}` : null;
          if (!task.serverState) task.serverNote = `서버 status=${person ? person.status : '없음'}`;
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-1-approve.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        task.resultNote = task.resultNote || '목표 미달성';
        await shot(page, 'task-1-approve-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // ---- Task 2: register one participant directly (operator) ----
    {
      const task = createTask('direct-add', '참가자 1명 직접 등록', 'operator', OPERATOR_STEP_CAP);
      const started = Date.now();
      const directName = '사용성 직접 김';
      const { context, page } = await newOperatorPage();
      attachErrorListeners(page, task, baseUrl);
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('input[placeholder*="이름·소속·연락처 검색"]').first().waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.getByRole('button', { name: '참가자 추가', exact: true }).click());
        await page.locator('#participant-add-name').waitFor({ state: 'visible', timeout: 10000 });
        await act(task, () => page.locator('#participant-add-name').fill(directName));
        await act(task, () => page.locator('#participant-add-phone').fill('01077776666'));
        const submit = page.locator('button[type="submit"][form="participant-add-form"]');
        await probeKeyboard(page, task, submit, '등록 버튼');
        await act(task, () => submit.click());
        await page.getByText(/님을 등록했습니다/).first().waitFor({ timeout: 15000 });
        const notice = await page.getByText(/님을 등록했습니다/).first().innerText().catch(() => '');
        const inList = await settledVisible(page.getByText(directName, { exact: true }));
        task.resultVisible = notice.includes(directName) && inList;
        task.resultNote = `등록 안내 "${notice.replace(/\s+/g, ' ').slice(0, 60)}" + 목록에 이름 표시`;
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const person = state.workspaces[eventId].participants.find((item) => item.name === directName);
          task.serverState = person ? `bootstrap에 등록됨(id=${String(person.id).slice(0, 18)}…)` : null;
          if (!task.serverState) task.serverNote = '서버 참가자 목록에 이름 없음';
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-2-direct-add.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-2-direct-add-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // ---- Task 3: request a message send to one person (operator) ----
    {
      const task = createTask('message', '메시지 1명에게 발송 요청', 'operator', OPERATOR_STEP_CAP);
      const started = Date.now();
      const title = `사용성 발송 ${datestamp()}`;
      const { context, page } = await newOperatorPage();
      attachErrorListeners(page, task, baseUrl);
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/messages`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('#campaign-title').waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.locator('#campaign-title').fill(title));
        await act(task, () => page.locator('#campaign-body').fill('{{이름}}님 사용성 감사 안내입니다.'));
        await act(task, () => page.getByText('수신자 목록 열기·닫기', { exact: false }).first().click());
        await page.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]').first().waitFor({ state: 'visible', timeout: 10000 });
        await act(task, () => page.locator('ul[aria-label="참가자 선택"] input[type="checkbox"]').first().check());
        await probeKeyboard(page, task, page.locator('#campaign-submit'), '발송 요청 버튼');
        await act(task, () => page.locator('#campaign-submit').click());
        await page.getByRole('button', { name: '발송 요청한다', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
        await act(task, () => page.getByRole('button', { name: '발송 요청한다', exact: true }).click());
        await page.getByText('발송 요청을 기록했습니다').first().waitFor({ timeout: 15000 });
        // Read the status off the new history row itself: the page also
        // carries a static "모의 발송도 전달되지 않습니다" warning, so a
        // body-wide match would prove nothing about this campaign.
        const historyItem = page.locator('li').filter({ hasText: title }).first();
        const historyTitle = await settledVisible(historyItem);
        const itemText = await historyItem.innerText().catch(() => '');
        const statusRead = itemText.includes('연결 필요') ? '연결 필요'
          : ['모의 발송', '예약', '발송 요청', '전달'].find((word) => itemText.includes(word)) || '';
        task.resultVisible = historyTitle && statusRead !== '';
        task.resultNote = `발송 기록에 "${title}" 표시 + 상태 "${statusRead || '읽히지 않음'}"`;
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const campaign = state.workspaces[eventId].messages.find((item) => item.title === title);
          task.serverState = campaign ? `bootstrap message status=${campaign.status}` : null;
          if (!task.serverState) task.serverNote = '서버 발송 기록에 제목 없음';
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-3-message.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-3-message-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // ---- Task 4: create one booth and check its operating state (operator) ----
    {
      const task = createTask('booth', '부스 1개 만들고 운영 상태 확인', 'operator', OPERATOR_STEP_CAP);
      const started = Date.now();
      const boothName = '사용성 현장 부스';
      const { context, page } = await newOperatorPage();
      attachErrorListeners(page, task, baseUrl);
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/operations`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('#ops-desks').waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.getByRole('button', { name: '부스 추가', exact: true }).click());
        await page.locator('#booth-name').waitFor({ state: 'visible', timeout: 10000 });
        await act(task, () => page.locator('#booth-name').fill(boothName));
        await act(task, () => page.locator('#booth-status').selectOption('OPEN'));
        const submit = page.getByRole('button', { name: '부스 저장', exact: true });
        await probeKeyboard(page, task, submit, '부스 저장 버튼');
        await act(task, () => submit.click());
        await page.getByText('부스를 저장했습니다').first().waitFor({ timeout: 15000 });
        const inList = await settledVisible(page.getByText(boothName, { exact: true }));
        const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
        const metaRead = bodyText.includes('진행') && bodyText.includes('인증');
        task.resultVisible = inList && metaRead;
        task.resultNote = `목록에 "${boothName}" + 상태/인증 표시 ${metaRead ? '있음' : '없음'}`;
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const booth = state.workspaces[eventId].booths.find((item) => item.name === boothName);
          task.serverState = booth ? `bootstrap status=${booth.status} 인증 ${booth.used}회` : null;
          if (!task.serverState) task.serverNote = '서버 부스 목록에 이름 없음';
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-4-booth.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-4-booth-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // ---- Task 5: assign one staffer (operator) ----
    {
      const task = createTask('assign', '스태프 1명 배정', 'operator', OPERATOR_STEP_CAP);
      const started = Date.now();
      const { context, page } = await newOperatorPage();
      attachErrorListeners(page, task, baseUrl);
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/operations`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('#ops-staff').waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.getByRole('button', { name: '스태프 배정', exact: true }).first().click());
        await page.locator('#assign-account').waitFor({ state: 'visible', timeout: 10000 });
        // A brand-new staffer must be pickable here for the goal to hold.
        // Dump the actual options on failure: a MANAGER bootstrap only lists
        // accounts with a membership or assignment on this event
        // (server/state.js MANAGER accountQuery), so an unconnected account
        // never appears — no product code is touched to work around it.
        await act(task, async () => {
          const options = await page.locator('#assign-account option').allInnerTexts().catch(() => []);
          task.detail += ` [현장 스태프 선택지: ${JSON.stringify(options)}]`;
          await page.locator('#assign-account').selectOption(seed.staff2Id, { timeout: 8000 });
        });
        await act(task, () => page.locator('#assign-target').selectOption({ index: 1 }));
        const submit = page.getByRole('button', { name: '배정 저장', exact: true });
        await probeKeyboard(page, task, submit, '배정 저장 버튼');
        await act(task, () => submit.click());
        await page.getByText('스태프를 배정했습니다').first().waitFor({ timeout: 15000 });
        const inList = await settledVisible(page.getByText(seed.staff2Name, { exact: true }));
        task.resultVisible = inList;
        task.resultNote = `배정 목록에 "${seed.staff2Name}" 표시`;
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const assignment = state.workspaces[eventId].assignments.find((item) => item.accountId === seed.staff2Id);
          task.serverState = assignment ? `bootstrap 배정 ${assignment.type}→${String(assignment.targetId).slice(0, 18)}…` : null;
          if (!task.serverState) task.serverNote = '서버 배정 목록에 계정 없음';
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-5-assign.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-5-assign-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // ---- Task 6: apply and get a ticket (attendee, no session) ----
    let attendeeTicket = '';
    {
      const task = createTask('signup', '참가 신청 후 티켓 발급', 'attendee', ATTENDEE_STEP_CAP);
      const started = Date.now();
      const { context, page } = await newAttendeePage();
      attachErrorListeners(page, task, baseUrl);
      try {
        await page.goto(`${baseUrl}/event/${encodeURIComponent(slug)}/register`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('form.registration-form').waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.locator('#field-name').fill('사용성 신청 김'));
        await act(task, () => page.locator('#field-phone').fill('01055554444'));
        const consent = page.locator('#consent');
        if (await consent.count()) {
          await act(task, () => consent.check());
        } else {
          task.detail += ' [동의 체크박스 없음: consentText 미노출]';
        }
        const submit = page.getByRole('button', { name: '신청하기', exact: true });
        await probeKeyboard(page, task, submit, '신청하기 버튼');
        await act(task, () => submit.click());
        await page.waitForURL(/\/ticket\?ticket=/, { timeout: 20000 });
        attendeeTicket = new URL(page.url()).searchParams.get('ticket') || '';
        const qr = page.getByRole('img', { name: /QR/ }).first();
        await qr.waitFor({ state: 'visible', timeout: 15000 });
        task.resultVisible = attendeeTicket !== '' && await qr.isVisible().catch(() => false);
        task.resultNote = '티켓 화면 이동 + QR 표시';
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const person = state.workspaces[eventId].participants.find((item) => item.phone === '01055554444');
          task.serverState = person ? `bootstrap status=${person.status} ticket=${person.ticket ? '발급됨' : '없음'}` : null;
          if (!task.serverState) task.serverNote = '서버 참가자 목록에 연락처 없음';
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-6-signup.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-6-signup-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // Setup for task 8 only (not a counted user goal): the SELF booth visit
    // requires an APPROVED + checked-in participant. The signup above is
    // already APPROVED (approvalRequired=false); the check-in goes through
    // the real staff command path with the real desk assignment.
    if (attendeeTicket) {
      try {
        await apiCommand(helpers, fixture.harness.baseUrl, fixture.staff.cookie, eventId,
          'check.scan', { deskId: fixture.deskId, ticket: attendeeTicket }, seed.deskAssignId);
      } catch (error) {
        const task = createTask('checkin-setup', '부스 인증용 체크인(측정 외 준비)', 'setup', 0);
        task.detail = `체크인 준비 실패: ${error.message.split('\n')[0]}`;
        task.serverNote = '준비 단계이므로 판정에서 제외';
        tasks.push(task);
      }
    }

    // ---- Task 7: open the ticket screen (attendee) ----
    {
      const task = createTask('ticket', '티켓 화면 열기', 'attendee', ATTENDEE_STEP_CAP);
      const started = Date.now();
      const { context, page } = await newAttendeePage();
      attachErrorListeners(page, task, baseUrl);
      try {
        if (!attendeeTicket) throw new Error('과제 6의 티켓이 없어 티켓을 열 수 없음');
        await page.goto(`${baseUrl}/event/${encodeURIComponent(slug)}/home?ticket=${encodeURIComponent(attendeeTicket)}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('nav[aria-label="참가 메뉴"]').waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        const menu = page.getByRole('button', { name: /모바일 티켓/ }).first();
        await probeKeyboard(page, task, menu, '모바일 티켓 메뉴');
        await act(task, () => menu.click());
        const qr = page.getByRole('img', { name: /QR/ }).first();
        await qr.waitFor({ state: 'visible', timeout: 15000 });
        task.resultVisible = await qr.isVisible().catch(() => false);
        task.resultNote = '참가자 홈→모바일 티켓→QR 표시';
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const person = state.workspaces[eventId].participants.find((item) => item.phone === '01055554444');
          task.serverState = person && person.status === 'APPROVED' ? `bootstrap status=${person.status}(QR 발급 조건)` : null;
          if (!task.serverState) task.serverNote = `서버 status=${person ? person.status : '없음'}`;
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-7-ticket.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-7-ticket-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // ---- Task 8: stamp a booth by typing the code (attendee) ----
    {
      const task = createTask('stamp', '부스 인증(코드 직접 입력)', 'attendee', ATTENDEE_STEP_CAP);
      const started = Date.now();
      const code = `ET:BOOTH:${eventId}:${seed.boothId}`;
      const { context, page } = await newAttendeePage();
      attachErrorListeners(page, task, baseUrl);
      try {
        if (!attendeeTicket) throw new Error('과제 6의 티켓이 없어 인증할 수 없음');
        await page.goto(`${baseUrl}/event/${encodeURIComponent(slug)}/home?ticket=${encodeURIComponent(attendeeTicket)}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('nav[aria-label="참가 메뉴"]').waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.getByRole('button', { name: /부스 인증/ }).first().click());
        await page.locator('#booth-code').waitFor({ state: 'visible', timeout: 15000 });
        await act(task, () => page.locator('#booth-code').fill(code));
        const submit = page.getByRole('button', { name: '인증하기', exact: true });
        await probeKeyboard(page, task, submit, '인증하기 버튼');
        await act(task, () => submit.click());
        await page.getByText(/인증을 기록했습니다/).first().waitFor({ timeout: 15000 });
        const done = await page.getByText(/인증을 기록했습니다/).first().innerText().catch(() => '');
        task.resultVisible = done.length > 0;
        task.resultNote = `인증 결과 "${done.replace(/\s+/g, ' ').slice(0, 60)}"`;
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const visits = state.workspaces[eventId].visits || [];
          const hit = visits.find((visit) => String(visit.boothId) === seed.boothId);
          task.serverState = hit ? `bootstrap visits에 부스 인증 기록됨` : null;
          if (!task.serverState) task.serverNote = `서버 visits ${visits.length}건 중 해당 부스 없음`;
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-8-stamp.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-8-stamp-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }

    // ---- Task 9: submit a rank vote (attendee) ----
    {
      const task = createTask('vote', '순위 투표 제출', 'attendee', ATTENDEE_STEP_CAP);
      const started = Date.now();
      const { context, page } = await newAttendeePage();
      attachErrorListeners(page, task, baseUrl);
      try {
        if (!attendeeTicket) throw new Error('과제 6의 티켓이 없어 투표할 수 없음');
        await page.goto(`${baseUrl}/event/${encodeURIComponent(slug)}/home?ticket=${encodeURIComponent(attendeeTicket)}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('nav[aria-label="참가 메뉴"]').waitFor({ state: 'visible', timeout: 15000 });
        await verifySkipLink(page, task);
        await installScrollCounter(page);
        await act(task, () => page.getByRole('button', { name: /순위 투표/ }).first().click());
        await page.locator('[aria-label="투표 대상 팀"]').waitFor({ state: 'visible', timeout: 15000 });
        await act(task, () => page.getByLabel(`${seed.teamName} 선택`, { exact: true }).click());
        const submit = page.getByRole('button', { name: '투표 제출', exact: true });
        await probeKeyboard(page, task, submit, '투표 제출 버튼');
        await act(task, () => submit.click());
        await page.getByText('투표가 접수되었습니다').first().waitFor({ timeout: 15000 });
        task.resultVisible = true;
        task.resultNote = '제출 결과 "투표가 접수되었습니다" 표시';
        try {
          const state = await readBootstrap(helpers, baseUrl, fixture.manager.cookie);
          const votes = state.workspaces[eventId].votes || [];
          task.serverState = votes.length ? `bootstrap votes ${votes.length}건` : null;
          if (!task.serverState) task.serverNote = '서버 votes 비어 있음';
        } catch (error) {
          task.serverNote = `bootstrap 확인 불가: ${error.message.split('\n')[0]}`;
        }
        await shot(page, 'task-9-vote.png');
      } catch (error) {
        task.blocked = true;
        task.detail += ` 막힘: ${String((error && error.message) || error).split('\n')[0]}`;
        await shot(page, 'task-9-vote-blocked.png');
      } finally {
        await finishTask(task, page, started);
        await context.close().catch(() => {});
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
  }

  // ---- Report ----
  const measured = tasks.filter((task) => task.actor !== 'setup');
  const report = {
    tool: 'usability-audit',
    date: datestamp(),
    milliseconds: Date.now() - startedAll,
    caps: {
      operatorSteps: OPERATOR_STEP_CAP,
      attendeeSteps: ATTENDEE_STEP_CAP,
      scrolls: SCROLL_CAP,
      keyboardStops: KEYBOARD_CAP,
    },
    justification: '상한 근거: 운영자 과제는 검색·선택·확인의 3~6회 실제 조작에 여유를 둔 12회, 참가자 과제는 메뉴 진입 1회+입력 1~3회+제출 1회에 여유를 둔 10회. scrolls 6회는 한 화면 목표에서 찾기 스크롤이 6회를 넘으면 정보 구조 결함으로 본다. keyboard 40회는 Tab 이동 한계선이다.',
    tasks: measured.map((task) => ({
      key: task.key,
      title: task.title,
      actor: task.actor,
      steps: task.steps,
      blocked: task.blocked,
      stepCap: task.stepCap,
      scrolls: task.scrolls,
      keyboardStops: task.keyboardStops,
      keyboardStopsRaw: task.keyboardStopsRaw,
      keyboardSkip: task.keyboardSkip,
      skipLink: task.skipLink,
      skipVerified: task.skipVerified,
      keyboardNote: task.keyboardNote,
      resultVisible: task.resultVisible,
      resultNote: task.resultNote,
      serverState: task.serverState,
      serverNote: task.serverNote,
      errors: task.errors,
      passed: task.passed,
      detail: task.detail.trim(),
      milliseconds: task.milliseconds,
    })),
    passed: measured.every((task) => task.passed),
  };
  fs.writeFileSync(path.join(CAPTURE_DIR, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);

  const line = (text) => process.stdout.write(`${text}\n`);
  line('');
  line('== 사용성 감사 결과 (실제 목표 달성까지의 조작 측정) ==');
  line('과제 | steps(상한) | scrolls | keyboardStops(정정) | keyboardStopsRaw(최상단) | 결과');
  const kbText = (task, value) => {
    if (value !== null) return `${value}회`;
    return task.blocked ? '미측정' : '40회 초과';
  };
  for (const task of measured) {
    const stepText = task.steps === null ? '미완' : `${task.steps}회`;
    line(`- ${task.title} | ${stepText}(${task.stepCap}) | ${task.scrolls}회 | ${kbText(task, task.keyboardStops)} | ${kbText(task, task.keyboardStopsRaw)} | ${task.passed ? '통과' : '실패'}`);
  }
  // Transparency over the corrected metric: name every task whose naive
  // top-only path exceeds the cap, even when the corrected path passes.
  const rawOver = measured.filter((task) => task.keyboardStopsRaw === null && !task.blocked);
  if (rawOver.length) {
    line('');
    line('== 최상단 Tab 경로가 40회를 넘는 과제(정정 전 raw, 숨기지 않음) ==');
    for (const task of rawOver) {
      line(`- ${task.title}: raw 40회 초과 → 정정 ${kbText(task, task.keyboardStops)} (${task.keyboardNote})`);
    }
  }
  line('');
  line('== 스킵 링크 포커스 이동 검증(과제 페이지 준비 상태에서 Tab→Enter 실측) ==');
  for (const task of measured) {
    const verdict = task.skipLink === 'present'
      ? '동작 확인(Tab→본문으로 건너뛰기→Enter→#main-content 포커스)'
      : task.skipLink === 'broken'
        ? '미동작(Enter 후 #main-content로 포커스 이동 없음) — 과제 실패'
        : '없음(최상단 Tab 경로로 측정)';
    line(`- ${task.title}: ${verdict}`);
  }
  const failures = measured.filter((task) => !task.passed);
  if (failures.length) {
    line('');
    line('== 실패·아슬한 과제와 구체적 지점 ==');
    for (const task of failures) {
      line(`[${task.title}] ${task.detail.trim() || '(상세 없음)'}`);
      for (const error of task.errors) line(`  - 오류: ${error}`);
      if (!task.resultVisible) line(`  - 화면: ${task.resultNote || '결과 문구 미확인'}`);
      if (!task.serverState) line(`  - 서버: ${task.serverNote || '미확인'}`);
    }
  } else {
    line('');
    line('== 실패·아슬한 과제 ==');
    line('없음. 전 과제 통과.');
  }
  line('');
  line('== 목표당 조작 수 나쁜 화면 순 ==');
  const ranked = [...measured].sort((a, b) => (b.steps ?? 99) - (a.steps ?? 99));
  for (const task of ranked) {
    const stepText = task.steps === null ? '미완' : `${task.steps}회`;
    line(`- ${task.title}: ${stepText}(상한 ${task.stepCap}) · scrolls ${task.scrolls}회 · keyboard ${kbText(task, task.keyboardStops)}(raw ${kbText(task, task.keyboardStopsRaw)})${task.errors.length ? ` · 오류 ${task.errors.length}건` : ''}`);
  }
  line('');
  line('== 이 도구가 아직 못 재는 것 ==');
  line('- 이해도·선호·만족도: 조작 수는 재지만 왜 헷갈렸는지는 모른다. 관찰 인터뷰가 필요하다.');
  line('- 스크린리더 실청취: Tab 도달만 재고 낭독 순서는 재지 않는다.');
  line('- 실기기 터치·카메라 스캔·발열/네트워크 열악 환경: Chromium 에뮬레이션과 격리망만 본다.');
  line('- 실제 메시지 전달: 공급사 미연동 격리이므로 NEEDS_CONNECTION까지만 확인한다.');
  line('- 장기 학습 효과: 첫 시도 1회만 재고 반복 사용 숙련도 변화는 모른다.');
  line('');
  line('== 재현 방법 ==');
  line(`1. npm --prefix apps/web run build (격리 Next 산출물 필요)`);
  line(`2. EVENTOUCH_A11Y_DATABASE_URL='postgres://...' npm run audit:usability (직렬 실행)`);
  line(`3. 결과: ${path.join(CAPTURE_DIR, 'result.json')} + 같은 폴더 과제 캡처`);
  line(`근거 파일: scripts/usability-audit.cjs, scripts/audit-fixture.cjs`);
  line('');
  line(`[usability-audit] ${measured.filter((task) => task.passed).length}/${measured.length} 통과 (${Math.round((Date.now() - startedAll) / 1000)}s)`);

  if (!report.passed) {
    for (const task of failures) {
      process.stderr.write(`[usability-audit] FAIL: ${task.title} — ${(task.detail.trim() || task.errors[0] || task.serverNote || task.resultNote).slice(0, 200)}\n`);
    }
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[usability-audit] failed: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {};
