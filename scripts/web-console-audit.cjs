'use strict';

// Permanent real-browser outcome audit for the console unification: every
// console menu renders inside the shared ConsolePage frame with one
// registry H1 and one compact event context, and the representative
// interactions behave against the real isolated API.
//
// Execution: serial, by main (`npm run web:console:audit` once wired).
// Environment: startAuditFixture boots an owned Next production server bound
// to the real isolated API harness (same shape as the a11y/mobile/web
// audits). No preview, production, or user data is touched: all writes land
// in the harness's random PostgreSQL schema, dropped on fixture.close().
//
// Messaging posture is forced before any helper loads: provider keys are
// deleted, EVENTOUCH_SMS_MOCK=1 is set, and every campaign uses
// simulate=true, so nothing can actually send.
//
// Evidence: full-page captures under
// /tmp/opencode/eventouch-captures/console-unification/ (never in the repo).
// Print is covered by DOM/print-emulation simulation, never a physical
// printer.
//
// Batched checks: independent phases collect errors and every failure fails
// the run; a phase never stops at the first bad selector.

for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) {
  delete process.env[key];
}
process.env.EVENTOUCH_SMS_MOCK = '1';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const axeSource = require('axe-core').source;
const { launchBrowser, loadPlaywright, launchOptions } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { auditLongListBoundaries } = require('./web-console-boundaries.cjs');

const BLOCKING = new Set(['serious', 'critical']);
const CAPTURE_DIR = '/tmp/opencode/eventouch-captures/console-unification';
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

// Independent literal titles from the console page registry
// (apps/web/app/console/console-navigation.ts CONSOLE_PAGES): the audit pins
// the shipped copy, not a shared import, so registry drift fails loudly.
const SCREENS = [
  { key: 'events', path: '/console', title: '행사', scope: 'organization', marker: { css: '#console-event-directory' } },
  { key: 'clients', path: '/console/clients', title: '고객사', scope: 'organization', marker: { css: '#client-list-heading' } },
  { key: 'team', path: '/console/team', title: '팀·권한', scope: 'organization', marker: { css: '#team-members' } },
  { key: 'overview', path: '/console/events/:id', title: '운영 현황', scope: 'event', marker: { css: '#event-metrics-heading' } },
  { key: 'participants', path: '/console/events/:id/participants', title: '참가자', scope: 'event', marker: { css: 'input[placeholder*="이름·소속·연락처 검색"]' } },
  { key: 'import', path: '/console/events/:id/participants/import', title: '명단 가져오기', scope: 'event', marker: { css: '#participant-import-file-heading' } },
  { key: 'messages', path: '/console/events/:id/messages', title: '메시지', scope: 'event', marker: { css: '#campaign-title' } },
  { key: 'operations', path: '/console/events/:id/operations', title: '현장 운영', scope: 'event', marker: { css: '#ops-desks' } },
  { key: 'programs', path: '/console/events/:id/programs', title: '참여 프로그램', scope: 'event', marker: { role: 'button', name: '프로그램 만들기' } },
  { key: 'draws', path: '/console/events/:id/draws', title: '추첨·투표', scope: 'event', marker: { css: '#draws-vote' } },
  { key: 'photos', path: '/console/events/:id/photos', title: '현장 사진', scope: 'event', marker: { css: '#evidence-photo-sections' } },
  { key: 'content', path: '/console/events/:id/content', title: '콘텐츠', scope: 'event', marker: { css: '#content-notices' } },
  { key: 'attendeePage', path: '/console/events/:id/page', title: '참가자 페이지', scope: 'event', marker: { css: '#home-intro' } },
  { key: 'rewards', path: '/console/events/:id/rewards', title: '경품', scope: 'event', marker: { css: '#rewards-list' } },
  { key: 'settings', path: '/console/events/:id/settings', title: '행사 설정', scope: 'event', marker: { css: '#set-name' } },
  { key: 'reports', path: '/console/events/:id/reports', title: '결과 보고서', scope: 'event', marker: { css: '#reports-list' } },
];

const ERROR_TEXT = ['Application error', 'Something went wrong', 'Minified React'];

function commandId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function sessionValue(cookie) {
  return decodeURIComponent(String(cookie).slice('etko_session='.length));
}

async function apiCommand(helpers, baseUrl, cookie, eventId, command, payload, assignmentId) {
  const response = await helpers.requestJson(baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId('console-audit'), command, payload, ...(assignmentId ? { assignmentId } : {}) },
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

// Seeds every approved non-payment feature with representative data through
// real commands only. Throws on the first failure: a half-seeded audit
// would assert against the wrong content.
async function extendFixtureSeed(fixture) {
  const { harness, helpers, manager, staff, eventId } = fixture;
  const baseUrl = harness.baseUrl;
  const managerCookie = manager.cookie;
  const staffCookie = staff.cookie;
  const ownerId = `audit-owner-${fixture.suffix}`;
  const ownerCookie = await helpers.sessionCookie(harness, ownerId);
  const run = (cookie, command, payload, assignmentId) => apiCommand(helpers, baseUrl, cookie, eventId, command, payload, assignmentId);
  await run(managerCookie, 'event.features', {
    features: ['poll', 'quiz', 'qa', 'draw', 'survey', 'stamp', 'photo', 'board', 'screen', 'venue', 'reward'],
  });

  const people = [];
  const rows = [
    ['통합 확정 입장', '01010100001', '감사 업체 1'],
    ['통합 확정 퇴장', '01010100002', '감사 업체 1'],
    ['통합 확정 미입장', '01010100003', '감사 업체 2'],
    ['통합 대기 하나', '01010100004', '감사 업체 2'],
    ['통합 대기 둘', '01010100005', '감사 업체 3'],
    ['통합 취소 건', '01010100006', '감사 업체 3'],
  ].map(([name, phone, company]) => ({ name, phone, company }));
  const imported = await run(managerCookie, 'participant.import', { rows });
  const importedPeople = imported.participants || [];
  if (importedPeople.length !== rows.length) {
    throw new Error(`seed participant.import: expected ${rows.length} people, got ${importedPeople.length}`);
  }
  const byName = Object.fromEntries(importedPeople.map((person) => [person.name, person]));
  const approve = async (name) => {
    await run(managerCookie, 'participant.status', { id: byName[name].id, status: 'APPROVED' });
  };
  await approve('통합 확정 입장');
  await approve('통합 확정 퇴장');
  await approve('통합 확정 미입장');
  for (const name of ['통합 대기 하나', '통합 대기 둘']) {
    await run(managerCookie, 'participant.status', { id: byName[name].id, status: 'PENDING' });
  }
  await run(managerCookie, 'participant.status', { id: byName['통합 취소 건'].id, status: 'CANCELLED' });
  // PENDING pair stays pending; the base fixture's 8 approved rows stay
  // never-entered so the deep-link subset stays deterministic.
  for (const name of ['통합 확정 입장', '통합 확정 퇴장']) people.push(byName[name]);

  // Real desk scans through the assigned staffer: one stays inside, one
  // leaves, so everIn/inside subsets are genuinely populated.
  const tickets = {};
  {
    const state = await readBootstrap(helpers, baseUrl, managerCookie);
    for (const person of state.workspaces[eventId].participants) tickets[person.name] = person.ticket;
  }
  const scan = async (ticket) => {
    await run(staffCookie, 'check.scan', { deskId: fixture.deskId, ticket }, `audit-assign-${fixture.suffix}`);
  };
  await scan(tickets['통합 확정 입장']);
  await scan(tickets['통합 확정 퇴장']);
  // The fixture desk only takes IN passes, so a dedicated OUT desk covers
  // the left subset through the same assigned staffer.
  const outDesk = (await run(managerCookie, 'desk.save', {
    name: '통합 감사 퇴장 데스크', action: 'OUT', mode: 'desk', open: true,
  })).desk;
  await helpers.insertAssignment(harness.database, {
    id: `console-audit-assign-${fixture.suffix}`, accountId: staff.id, eventId, type: 'DESK', targetId: outDesk.id,
  });
  await run(staffCookie, 'check.scan', { deskId: outDesk.id, ticket: tickets['통합 확정 퇴장'] }, `console-audit-assign-${fixture.suffix}`);

  await run(managerCookie, 'notice.save', { title: '통합 감사 둘째 안내', body: '둘째 날 일정이 추가됐습니다.' });
  const survey = await run(managerCookie, 'module.save', {
    type: 'survey', title: '통합 감사 만족도', questions: '전반 만족\n장소 만족',
  });
  await run(managerCookie, 'module.status', { id: survey.module.id, status: 'OPEN' });
  const qa = await run(managerCookie, 'module.save', { type: 'qa', title: '통합 감사 질문' });
  await run(managerCookie, 'module.status', { id: qa.module.id, status: 'OPEN' });
  const askerTicket = tickets['통합 확정 미입장'];
  await helpers.requestJson(baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    bearer: askerTicket,
    body: { commandId: commandId('console-audit'), command: 'question.submit', payload: { moduleId: qa.module.id, text: '중식은 제공되나요?' } },
  }).then((response) => {
    if (response.status !== 201) throw new Error(`seed question.submit: ${response.status} ${JSON.stringify(response.json)}`);
  });
  {
    const state = await readBootstrap(helpers, baseUrl, managerCookie);
    const question = state.workspaces[eventId].questions.find((item) => item.text === '중식은 제공되나요?');
    if (!question) throw new Error('seed question.submit: question missing from workspace');
    await run(managerCookie, 'question.manage', {
      id: question.id, answer: '네, 12시부터 제공됩니다.', approved: true,
    });
  }

  await run(managerCookie, 'template.save', {
    name: '통합 감사 안내', channel: 'SMS', body: '{{이름}}님 {{행사명}} 안내입니다.',
  });
  const campaign = await run(managerCookie, 'message.create', {
    ids: [byName['통합 확정 미입장'].id], title: '통합 감사 발송', channel: 'SMS',
    body: '{{이름}}님 {{행사명}} 안내입니다.', simulate: true,
  });
  if (campaign.message.status !== 'SIMULATED') throw new Error('seed message.create: expected SIMULATED');

  await run(managerCookie, 'reward.create', {
    participantId: byName['통합 확정 미입장'].id, method: 'ONSITE', name: '통합 감사 기념품',
  });

  const report = await run(managerCookie, 'report.create', {
    title: '통합 감사 결과', subtitle: '동결 검증용', summary: '스냅샷 동결 검증',
    sections: ['overview', 'attendance'], color: '#123456',
  });
  await run(managerCookie, 'report.publish', { id: report.report.id });

  const client = await helpers.requestJson(baseUrl, '/api/clients', {
    method: 'POST',
    cookie: ownerCookie,
    body: { name: '통합 감사 고객사', contact: '김담당', email: 'client@example.test', commandId: commandId('console-audit') },
  });
  if (client.status !== 201 && client.status !== 200) {
    throw new Error(`seed client.save: ${client.status} ${JSON.stringify(client.json)}`);
  }
  const invitation = await helpers.requestJson(baseUrl, '/api/auth/invitations', {
    method: 'POST',
    cookie: ownerCookie,
    body: { commandId: commandId('console-audit'), name: '통합 감사 매니저', email: `invite-${fixture.suffix}@example.test`, role: 'MANAGER', eventId },
  });
  if (invitation.status !== 201 && invitation.status !== 200) {
    throw new Error(`seed invitation.create: ${invitation.status} ${JSON.stringify(invitation.json)}`);
  }

  // Read-only events: direct payload seeding (no transitions to fake).
  // participant.* mutations stop at ENDED; domain writes stop at ARCHIVED.
  const readonlyPerson = (tag) => ({
    id: `console-audit-ro-${tag}-${fixture.suffix}`,
    name: `읽기전용 ${tag}`, phone: '01010100999', email: '', company: '감사 업체 9',
    group: '일반', status: 'APPROVED', registrationType: 'PRE', inside: false, everIn: true,
    revoked: false, ticket: `ET:${eventId}:T-readonly-${tag}`, ticketExpiresAt: '',
    paymentStatus: 'FREE', answers: {}, consent: null, createdAt: new Date().toISOString(),
  });
  for (const [tag, stage] of [['ended', 'ENDED'], ['archived', 'ARCHIVED']]) {
    const id = `console-audit-${tag}-${fixture.suffix}`;
    const workspace = helpers.emptyWorkspace();
    workspace.participants = [readonlyPerson(tag)];
    await helpers.insertEvent(harness.database, {
      id,
      slug: id,
      payload: {
        id, slug: id, name: tag === 'ended' ? '읽기전용 종료 행사' : '읽기전용 보관 행사',
        date: '2027-01-16', start: '09:00', end: '17:00', capacity: 200, stage,
        features: ['draw', 'poll', 'reward', 'screen', 'venue'],
      },
      workspace,
    });
  }

  // Unassigned staffer: session only, no membership or desk, for the
  // direct-access visibility check (no permission is invented for them).
  const outsiderId = `console-audit-outsider-${fixture.suffix}`;
  await helpers.insertAccount(harness.database, {
    id: outsiderId, role: 'STAFF', name: '통합 감사 외부 스태프', email: `${outsiderId}@example.test`,
  });
  const outsiderCookie = await helpers.sessionCookie(harness, outsiderId);

  // One open booth with a single allowed visit per participant, switched to
  // SELF before any visit exists (the mode freezes after the first one). The
  // attendee booth-stamp phase stamps with a checked-in participant.
  const booth = (await run(managerCookie, 'booth.save', {
    name: '통합 감사 부스', zone: 'A구역', status: 'OPEN', capacity: 0, limit: 1,
  })).booth;
  await run(managerCookie, 'booth.mode', { mode: 'SELF', acknowledge: true });
  // The staffer covers both tasks so the SELF booth QR can be rendered from
  // the real staff screen for the participant camera-scan phase.
  await helpers.insertAssignment(harness.database, {
    id: `console-audit-booth-assign-${fixture.suffix}`.toLowerCase(),
    accountId: staff.id, eventId, type: 'BOOTH', targetId: booth.id,
  });
  // A draw program on a published draw module: the runs list needs a real
  // program, and an unpublished one shows the run prerequisites honestly.
  const drawModule = (await run(managerCookie, 'module.save', { type: 'draw', title: '통합 감사 추첨 무대' })).module;
  await run(managerCookie, 'module.status', { id: drawModule.id, status: 'OPEN' });
  const drawProgram = (await run(managerCookie, 'draw.program.save', {
    name: '통합 감사 추첨 프로그램',
    quota: 2,
    moduleId: drawModule.id,
    eligibility: 'PERSON',
    eligibleGroups: [],
    eligibleCompanies: [],
    overlap: 'EVENT',
    prizeTiers: null,
    status: 'OPEN',
    published: false,
  })).program;
  if (!drawProgram?.id) throw new Error('seed draw.program.save: program missing');

  return {
    ownerCookie,
    outsiderCookie,
    boothId: String(booth.id),
    endedEventId: `console-audit-ended-${fixture.suffix}`,
    archivedEventId: `console-audit-archived-${fixture.suffix}`,
  };
}

function screenPath(screen, eventId) {
  return screen.path.replace(':id', encodeURIComponent(eventId));
}

async function waitForMarker(page, marker, timeout = 15000) {
  if (marker.css) {
    await page.locator(marker.css).first().waitFor({ state: 'visible', timeout });
  } else {
    await page.getByRole(marker.role, { name: marker.name }).first().waitFor({ state: 'visible', timeout });
  }
}

// The shared frame contract: exactly one H1 with the registry title, the
// compact event context only on event scope, and one real loaded marker —
// ConsolePage renders the same shell for error states, so the H1 alone
// cannot prove the screen loaded.
async function assertConsoleScreen(page, screen, eventId, eventName) {
  const url = page.url();
  const pathname = new URL(url).pathname;
  if (pathname !== screenPath(screen, eventId)) {
    throw new Error(`${screen.key}: landed on ${pathname} (login redirect or reroute)`);
  }
  // Client-side navigation lands before the page's bootstrap data arrives, so
  // wait for the loaded marker first; the structural checks below then run
  // against the real screen instead of its loading state.
  await waitForMarker(page, screen.marker);
  const h1Count = await page.locator('main h1').count();
  if (h1Count !== 1) throw new Error(`${screen.key}: expected a single H1, found ${h1Count}`);
  const h1Text = (await page.locator('main h1').first().innerText()).trim();
  if (h1Text !== screen.title) {
    throw new Error(`${screen.key}: H1 is ${JSON.stringify(h1Text)}, expected ${JSON.stringify(screen.title)}`);
  }
  // No legacy back row: the rail owns navigation, the frame owns context.
  if (await page.getByRole('link', { name: '← 운영 현황' }).count()) {
    throw new Error(`${screen.key}: legacy back row is present`);
  }
  const contextCount = await page.getByRole('link', { name: `행사 / ${eventName}` }).count();
  if (screen.scope === 'event' && contextCount !== 1) {
    throw new Error(`${screen.key}: missing compact event context for ${JSON.stringify(eventName)}`);
  }
  if (screen.scope === 'organization' && contextCount !== 0) {
    throw new Error(`${screen.key}: organization page must not render an event context`);
  }
  for (const text of ERROR_TEXT) {
    if (await page.getByText(text, { exact: false }).count()) {
      throw new Error(`${screen.key}: rendered an error boundary (found ${JSON.stringify(text)})`);
    }
  }
}

async function headerGeometry(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector('main h1');
    const header = h1 ? h1.closest('header') : null;
    if (!h1 || !header) return null;
    const box = header.getBoundingClientRect();
    return { x: box.x, width: box.width, fontSize: window.getComputedStyle(h1).fontSize };
  });
}

async function axeViolations(page) {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const results = await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
    }));
  });
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

async function saveShot(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  // Park the pointer where it hovers nothing actionable to avoid sticky
  // hover artifacts in the capture (best effort, viewport-relative).
  const size = page.viewportSize() || { width: 1280, height: 900 };
  await page.mouse.move(size.width - 2, size.height - 2);
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(CAPTURE_DIR, name), fullPage: true });
}

// Shared lost-response writer for the centralized write dialogs (clients,
// notices, desks): the first matching mutation really commits through
// route.fetch() — asserted 2xx, never a fake 200 — and only the browser's
// copy of the response is replaced with a 502. The shared dialog must show
// the alert with entered values intact and stay open; the unchanged retry
// must close the dialog and land exactly one new record with the same
// command id. A sidebar navigation afterwards must not confirm (pending
// refs cleared — no false guard). Loaded markers gate entry: the normal H1
// alone never suffices.
async function assertResponseLossRetry(page, helpers, baseUrl, eventId, eventName, {
  label, screen, openName, fields, submitName, routePattern,
  matchRequest, failureText, dialogShot, readRecords, isNewRecord,
  guardSelector, guardPathname,
}) {
  await page.goto(`${baseUrl}${screenPath(screen, eventId)}`, { waitUntil: 'networkidle', timeout: 30000 });
  await page.waitForTimeout(800);
  await assertConsoleScreen(page, screen, eventId, eventName);
  const before = await readRecords();
  await page.getByRole('button', { name: openName }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  for (const field of fields) await page.locator(field.selector).fill(field.value);
  // Exactly one owner asks about discarding a dirty dialog. Accepting the
  // shared Escape gate must not call another confirming onClose handler.
  const discardPrompts = [];
  const acceptDiscard = async (confirm) => {
    discardPrompts.push(confirm.message());
    await confirm.accept();
  };
  page.on('dialog', acceptDiscard);
  try {
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached', timeout: 10000 });
    if (discardPrompts.length !== 1) throw new Error(`${label}: dirty dismissal asked ${discardPrompts.length} times, expected once`);
  } finally {
    page.off('dialog', acceptDiscard);
  }
  await page.getByRole('button', { name: openName }).first().click();
  await dialog.waitFor({ state: 'visible', timeout: 10000 });
  for (const field of fields) await page.locator(field.selector).fill(field.value);
  const seenIds = [];
  let injected = false;
  let liveFailure = null;
  await page.route(routePattern, async (route) => {
    const request = route.request();
    let body = null;
    try {
      body = JSON.parse(request.postData() || 'null');
    } catch {
      await route.continue();
      return;
    }
    if (!body || !matchRequest(body)) {
      await route.continue();
      return;
    }
    seenIds.push(body.commandId);
    if (!injected) {
      injected = true;
      const live = await route.fetch();
      const status = live.status();
      await live.text().catch(() => '');
      if (status < 200 || status >= 300) {
        liveFailure = status;
        await route.fulfill({ response: live });
        return;
      }
      await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: '응답 유실 검증' }) });
      return;
    }
    await route.continue();
  });
  try {
    await dialog.getByRole('button', { name: submitName, exact: true }).click();
    try {
      await dialog.getByText(failureText, { exact: false }).first().waitFor({ timeout: 15000 });
    } catch (waitError) {
      // The route handler runs off the submit: a non-2xx live commit means
      // there was nothing to lose, so report that instead of a bare timeout.
      if (liveFailure !== null) throw new Error(`${label}: live commit failed with ${liveFailure}; refusing to inject loss`);
      throw waitError;
    }
    for (const field of fields) {
      const actual = await page.locator(field.selector).inputValue();
      if (actual !== field.value) throw new Error(`${label}: lost response overwrote ${field.selector}`);
    }
    if (!await dialog.isVisible()) throw new Error(`${label}: dialog closed on the lost response`);
    // Capture the actual error-state dialog as-is: no scroll reset, which
    // would move the fixed overlay's backdrop relative to the viewport.
    await page.screenshot({ path: path.join(CAPTURE_DIR, dialogShot) });
    await dialog.getByRole('button', { name: submitName, exact: true }).click();
    await dialog.waitFor({ state: 'detached', timeout: 15000 });
  } finally {
    await page.unroute(routePattern).catch(() => {});
  }
  const after = await readRecords();
  const fresh = after.filter(isNewRecord);
  if (after.length !== before.length + 1 || fresh.length !== 1) {
    throw new Error(`${label}: expected exactly one new record (${before.length} -> ${after.length}, ${fresh.length} matching)`);
  }
  if (seenIds.length < 2 || seenIds[0] !== seenIds[1]) {
    throw new Error(`${label}: unchanged retry must replay the receipt id (saw ${JSON.stringify(seenIds)})`);
  }
  // No false guard after the settled write: the pending refs cleared.
  let unexpectedConfirm = null;
  page.on('dialog', async (confirm) => {
    unexpectedConfirm = confirm.message();
    await confirm.dismiss();
  });
  await page.locator(guardSelector).first().click();
  await page.waitForTimeout(800);
  if (unexpectedConfirm !== null) {
    throw new Error(`${label}: unexpected draft confirm after settled write (${JSON.stringify(unexpectedConfirm)})`);
  }
  await page.waitForFunction(
    (expected) => window.location.pathname === expected || window.location.pathname.endsWith(expected),
    guardPathname,
    { timeout: 15000 },
  );
  const landed = new URL(page.url()).pathname;
  if (landed !== guardPathname && !landed.endsWith(guardPathname)) {
    throw new Error(`${label}: guard navigation landed on ${page.url()}`);
  }
}

async function main() {
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });
  fs.mkdirSync(path.join(CAPTURE_DIR, 'sweep'), { recursive: true });
  let fixture;
  try {
    fixture = await startAuditFixture();
  } catch (error) {
    process.stderr.write(`[console-audit] fixture: ${error && error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const failures = [];
  const moderate = [];
  const phases = [];
  const check = async (label, fn) => {
    const started = Date.now();
    try {
      await fn();
      phases.push({ label, passed: true, milliseconds: Date.now() - started });
    } catch (error) {
      failures.push(`${label}: ${(error && error.message || String(error)).split('\n')[0]}`);
      phases.push({ label, passed: false, milliseconds: Date.now() - started, error: String(error && error.message || error) });
    }
  };

  let browser;
  try {
    const extended = await extendFixtureSeed(fixture).catch((error) => {
      failures.push(`seed: ${error.message.split('\n')[0]}`);
      return null;
    });
    if (!extended) throw new Error(`extended seed failed: ${failures[0]}; aborting browser phases`);

    const { helpers, eventId } = fixture;
    const baseUrl = fixture.baseUrl;
    const state = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
    const eventName = state.events.find((item) => item.id === eventId).name;
    const ownerSession = sessionValue(extended.ownerCookie);

    browser = await launchBrowser();
    const newContext = async (options) => {
      const context = await browser.newContext(options);
      context.on('page', (page) => page.on('pageerror', (error) => failures.push(`pageerror ${new URL(page.url()).pathname}: ${error.message}`)));
      return context;
    };

    // Phase A — all 16 menus, both viewports: one H1, context, loaded
    // marker, common header geometry, no overflow, axe.
    const geometries = [];
    for (const viewport of VIEWPORTS) {
      const tag = `${viewport.width}x${viewport.height}`;
      const context = await newContext({ viewport });
      await context.addCookies([{
        name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl,
      }]);
      for (const screen of SCREENS) {
        const label = `${screen.key}@${tag}`;
        const page = await context.newPage();
        await check(label, async () => {
          await page.goto(`${baseUrl}${screenPath(screen, eventId)}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(1200);
          await assertConsoleScreen(page, screen, eventId, eventName);
          if (screen.key === 'events') {
            for (const card of await page.locator('main article').all()) {
              const name = await card.locator('h3').textContent();
              const event = state.events.find((item) => item.name === name);
              if (!event) throw new Error(`unexpected event card ${name}`);
              const pending = (state.workspaces[event.id]?.participants || []).filter((person) => person.status === 'PENDING').length;
              if (await card.locator('dl').count() || /등록 인원|현재 입장/.test(await card.textContent())) throw new Error('directory regained dashboard KPIs');
              const queue = card.getByRole('link', { name: `${name} 승인 대기 ${pending}명 처리`, exact: true });
              if (pending > 0) {
                if (!await queue.isVisible() || await queue.getAttribute('href') !== `/console/events/${encodeURIComponent(event.id)}/participants?status=PENDING`) throw new Error('pending follow-up missing or misdirected');
                const bounds = await queue.boundingBox();
                if (!bounds || bounds.height < 44) throw new Error('approval follow-up lost its touch height');
              } else if (/승인 대기/.test(await card.textContent())) throw new Error('empty approval queue should not occupy a card');
              if (await card.locator('a a, a button').count()) throw new Error('nested card controls');
              if (!await card.getByRole('button', { name: '복제', exact: true }).isVisible()) throw new Error('duplicate action lost');
            }
          }
          const geometry = await headerGeometry(page);
          if (!geometry) throw new Error('header geometry unreadable');
          geometries.push({ viewport: tag, scope: screen.scope, ...geometry });
          const box = await overflow(page);
          if (box.scrollWidth > box.innerWidth + 1) {
            throw new Error(`horizontal overflow ${box.scrollWidth}px > ${box.innerWidth}px`);
          }
          for (const violation of await axeViolations(page)) {
            if (BLOCKING.has(violation.impact)) {
              throw new Error(`axe ${violation.id} (${violation.impact}, ${violation.nodes} nodes)`);
            }
            moderate.push(`${label}: ${violation.id} (${violation.impact})`);
          }
        });
        await saveShot(page, `sweep/${screen.key}-${tag}.png`).catch(() => {});
        await page.close();
      }
      await context.close();
    }
    await check('frame/common-header-geometry', async () => {
      // The chrome around domain bodies does not differ: same viewport and
      // scope share header x/width/font-size within 2px.
      const groups = new Map();
      for (const entry of geometries) {
        const key = `${entry.viewport}|${entry.scope}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(entry);
      }
      for (const [key, entries] of groups) {
        if (entries.length < 2) continue;
        const first = entries[0];
        for (const entry of entries.slice(1)) {
          for (const field of ['x', 'width']) {
            if (Math.abs(entry[field] - first[field]) > 2) {
              throw new Error(`${key}: header ${field} ${entry[field]} vs ${first[field]}`);
            }
          }
          if (entry.fontSize !== first.fontSize) throw new Error(`${key}: H1 font-size ${entry.fontSize} vs ${first.fontSize}`);
        }
      }
    });

    // Phone composition is an outcome, not just zero document overflow.
    // These are the screenshot-feedback widths; keep both independently.
    for (const width of [360, 412]) {
      const context = await newContext({ viewport: { width, height: 780 }, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      const go = async (key, query = '') => {
        const screen = SCREENS.find((item) => item.key === key);
        await page.goto(`${baseUrl}${screenPath(screen, eventId)}${query}`, { waitUntil: 'networkidle' });
        await assertConsoleScreen(page, screen, eventId, eventName);
      };
      const shot = (name) => page.screenshot({ path: path.join(CAPTURE_DIR, `phone-${name}-${width}.png`) });
      try {
        await check(`phone/home-composition@${width}`, async () => {
          await go('events');
          const search = await page.getByRole('searchbox', { name: '행사명·고객사·장소 검색', exact: true }).boundingBox();
          const first = await page.locator('main article').first().boundingBox();
          if (!search || search.width < width - 40) throw new Error(`search squeezed to ${search?.width}px`);
          if (!first || first.y > 440) throw new Error(`first event starts too late: ${first?.y}px`);
          const stage = await page.locator('main select').first().evaluate((e) => {
            const css = getComputedStyle(e);
            const label = e.closest('label').getBoundingClientRect();
            const approval = document.querySelector('main label:has(input[type="checkbox"])').getBoundingClientRect();
            const title = document.getElementById('console-event-directory');
            const count = title.closest('section').querySelector('p').getBoundingClientRect();
            return { background: css.backgroundColor, border: css.borderTopWidth, radius: css.borderRadius, height: e.getBoundingClientRect().height,
              filterGap: approval.x - label.right, countGap: count.top - title.getBoundingClientRect().bottom };
          });
          if (stage.background !== 'rgba(0, 0, 0, 0)' || stage.border !== '0px' || stage.radius !== '0px' || stage.height < 44) throw new Error('stage filter regained card styling or lost its touch height');
          if (Math.abs(stage.filterGap - 12) > 1 || stage.countGap > 4.5) throw new Error('home filter or title-summary spacing drifted');
          const heading = page.locator('section[aria-labelledby="console-event-directory"]');
          if (!await heading.getByRole('button', { name: '달력', exact: true }).isVisible()) throw new Error('view switch detached from list');
          await shot('events');
          await page.getByRole('searchbox', { name: '행사명·고객사·장소 검색', exact: true }).fill('존재하지 않는 검색');
          await page.getByRole('button', { name: '필터 초기화', exact: true }).click();
          if (await page.getByRole('searchbox', { name: '행사명·고객사·장소 검색', exact: true }).inputValue()) throw new Error('home reset lost');
        });
        await check(`phone/card-follow-up@${width}`, async () => {
          await go('events');
          const card = page.locator('main article').filter({ has: page.getByRole('heading', { name: eventName, exact: true }) });
          const queue = card.getByRole('link', { name: `${eventName} 승인 대기 2명 처리`, exact: true });
          await queue.focus();
          await page.keyboard.press('Enter');
          await page.waitForURL((url) => url.pathname === `/console/events/${eventId}/participants` && url.searchParams.get('status') === 'PENDING');
          await assertConsoleScreen(page, SCREENS.find((item) => item.key === 'participants'), eventId, eventName);
          if (await page.getByLabel('상태별 보기', { exact: true }).inputValue() !== 'PENDING') throw new Error('card queue did not apply its pending filter');
          await page.goBack({ waitUntil: 'networkidle' });
          await card.getByRole('button', { name: '복제', exact: true }).click();
          const dialog = page.getByRole('dialog');
          await dialog.waitFor({ state: 'visible' });
          await dialog.getByRole('button', { name: '취소', exact: true }).click();
          await card.locator('a').first().click();
          await page.waitForURL((url) => url.pathname === `/console/events/${eventId}`);
          await assertConsoleScreen(page, SCREENS.find((item) => item.key === 'overview'), eventId, eventName);
          if (!await page.locator('#event-metrics-heading').isVisible()) throw new Error('event statistics no longer reachable from identity');
          await go('events');
        });
        await check(`phone/global-navigation@${width}`, async () => {
          await go('events');
          const trigger = page.locator('.console-global-trigger');
          const menu = page.locator('#console-global-menu');
          const account = page.getByRole('button', { name: /^계정 메뉴,/ });
          const search = page.getByRole('searchbox', { name: '행사명·고객사·장소 검색', exact: true });
          if (await page.locator('.mobile-primary-nav').count()) throw new Error('bottom navigation still rendered');
          const box = await trigger.boundingBox();
          if (!box || box.height < 44 || await menu.isVisible()) throw new Error('top trigger missing or popup initially open');
          await trigger.focus();
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => document.activeElement?.id === 'workspace-events-link-global');
          if (await menu.getByRole('link').count() !== 2) throw new Error('owner global destinations changed');
          await shot('global-menu');
          await page.keyboard.press('Tab');
          if (!(await menu.getByRole('link', { name: '고객사', exact: true }).evaluate((e) => e === document.activeElement))) throw new Error('Tab skipped second destination');
          await page.keyboard.press('Tab');
          await menu.waitFor({ state: 'hidden' });
          if (await page.evaluate(() => document.activeElement?.closest('#console-global-menu') !== null)) throw new Error('Tab trapped in global menu');
          await trigger.click();
          await page.keyboard.press('Escape');
          await page.waitForFunction(() => document.activeElement?.classList.contains('console-global-trigger'));
          if (await menu.isVisible()) throw new Error('Escape left popup open');
          await page.keyboard.press('Space');
          await page.waitForFunction(() => document.activeElement?.id === 'workspace-events-link-global');
          await page.keyboard.press('Escape');
          await menu.waitFor({ state: 'hidden' });
          await trigger.click();
          await search.click();
          if (await menu.isVisible() || !(await search.evaluate((e) => e === document.activeElement))) throw new Error('outside pointer stole input focus');
          await account.click();
          await page.locator('#operator-menu').waitFor({ state: 'visible' });
          await trigger.click();
          await page.waitForFunction(() => document.activeElement?.id === 'workspace-events-link-global');
          if (await page.locator('#operator-menu').isVisible()) throw new Error('both global and account menus open');
          await account.click();
          if (await menu.isVisible()) throw new Error('account open left global menu open');
          await page.keyboard.press('Escape');
          await trigger.click();
          await menu.getByRole('link', { name: '고객사', exact: true }).click();
          await page.waitForURL('**/console/clients');
          await menu.waitFor({ state: 'hidden' });
          await trigger.click();
          await menu.getByRole('link', { name: '고객사', exact: true }).click();
          await menu.waitFor({ state: 'hidden' });
          await go('settings');
          const value = await page.locator('#set-name').inputValue();
          await page.locator('#set-name').fill(`${value} 미저장`);
          await trigger.click();
          const rejected = page.waitForEvent('dialog');
          const rejectClick = menu.getByRole('link', { name: '고객사', exact: true }).click();
          const rejectDialog = await rejected;
          const guardMessage = rejectDialog.message();
          await rejectDialog.dismiss();
          await rejectClick;
          if (!guardMessage.includes('저장하지 않은 행사 설정 변경')) throw new Error(`unexpected settings draft guard: ${JSON.stringify(guardMessage)}`);
          if (!new URL(page.url()).pathname.endsWith('/settings') || !await menu.isVisible() || await page.locator('#set-name').inputValue() !== `${value} 미저장`) throw new Error('cancelled leave discarded input or menu');
          await shot('global-menu-guard-cancel');
          const accepted = page.waitForEvent('dialog');
          const acceptClick = menu.getByRole('link', { name: '고객사', exact: true }).click();
          await (await accepted).accept();
          await acceptClick;
          await page.waitForURL('**/console/clients');
          await menu.waitFor({ state: 'hidden' });
          await page.setViewportSize({ width: 320, height: 568 });
          await trigger.click();
          const bounds = await menu.boundingBox();
          if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 321) throw new Error('global popup clipped at 320px');
          const logoClipped = await page.locator('.console-brand .console-wordmark').evaluate((e) => e.scrollWidth > e.clientWidth + 1);
          if (logoClipped) throw new Error('menu crowds the wordmark at 320px');
          for (const violation of await axeViolations(page)) {
            if (BLOCKING.has(violation.impact)) throw new Error(`open menu axe ${violation.id}`);
          }
          await shot('global-menu-320');
          await page.setViewportSize({ width: 1280, height: 900 });
          await menu.waitFor({ state: 'hidden' });
          await page.waitForFunction(() => document.querySelector('.console-global-trigger')?.getAttribute('aria-expanded') === 'false');
          if (await trigger.isVisible() || !await page.locator('.desktop-side-nav').isVisible()) throw new Error('desktop navigation regressed after resize');
          await page.setViewportSize({ width, height: 780 });
          if (await menu.isVisible()) throw new Error('popup reopened after returning to mobile');
        });
        await check(`phone/roster-disclosure@${width}`, async () => {
          await go('participants');
          const toggle = page.locator('#roster-filter-toggle');
          if (await toggle.getAttribute('aria-expanded') !== 'false') throw new Error('clean roster filters not collapsed');
          if (await page.getByLabel('상태별 보기', { exact: true }).isVisible()) throw new Error('advanced filters consume clean first screen');
          const first = await page.locator('main li').first().boundingBox();
          if (!first || first.y > 600) throw new Error(`roster starts too late: ${first?.y}px`);
          await shot('participants');
          const selected = page.getByRole('checkbox', { name: '통합 확정 미입장 선택' });
          await selected.check();
          await toggle.click();
          await page.getByLabel('상태별 보기', { exact: true }).selectOption('PENDING');
          await toggle.click();
          if (!(await toggle.innerText()).includes('1개 적용 중')) throw new Error('collapsed active filter hidden');
          await toggle.click();
          await page.locator('#roster-filter-reset').click();
          if (!await selected.isChecked()) throw new Error('filter reset discarded selection');
          const download = page.waitForEvent('download');
          await page.getByRole('button', { name: /목록 CSV/ }).click();
          if (!(await download).suggestedFilename().endsWith('.csv')) throw new Error('CSV no longer downloads');
          await go('participants', '?status=PENDING');
          if (await toggle.getAttribute('aria-expanded') !== 'true' || !await page.getByLabel('상태별 보기', { exact: true }).isVisible()) throw new Error('pending deep link does not disclose its filter');
          await shot('participants-filtered');
        });
        await check(`phone/section-destinations@${width}`, async () => {
          for (const key of ['draws', 'operations', 'settings', 'content']) {
            await go(key);
            const links = page.locator('main nav a[href^="#"]');
            if (!await links.count()) throw new Error(`${key}: no section links`);
            for (const link of await links.all()) {
              const box = await link.boundingBox();
              if (!box || box.x < 0 || box.x + box.width > width + 1 || box.height < 44) throw new Error(`${key}: clipped or undersized ${await link.innerText()}`);
            }
            await shot(key);
          }
          await page.getByRole('link', { name: '장소 안내', exact: true }).click();
          await page.waitForURL('**#content-venue');
          const target = await page.locator('#content-venue').boundingBox();
          const rail = await page.locator('.console-sidebar').boundingBox();
          if (!target || !rail || target.y < rail.y + rail.height - 1) throw new Error('anchor heading covered by sticky rail');
          await shot('anchor');
        });
        await check(`phone/preview-status@${width}`, async () => {
          await go('attendeePage');
          const status = page.getByText('실시간', { exact: true });
          const box = await status.boundingBox();
          if (!box || box.height > 30 || box.width < 40) throw new Error('preview status squeezed into vertical Korean');
          await status.scrollIntoViewIfNeeded();
          await shot('preview');
          await go('reports');
          await shot('reports');
        });
      } finally {
        await page.close();
        await context.close();
      }
    }

    // Phase B — overview deep link: confirmed-but-never-entered is a real
    // subset with visible filters; reload/back/selection survive it.
    await check('overview/confirmed-not-entered', async () => {
      const context = await newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      try {
        const link = page.getByRole('link', { name: /확정자 중 미입장/ });
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}`, { waitUntil: 'networkidle', timeout: 30000 });
        await link.first().waitFor({ state: 'visible', timeout: 15000 });
        const href = await link.first().getAttribute('href');
        if (href !== `/console/events/${encodeURIComponent(eventId)}/participants?status=APPROVED&attendance=NOT_ENTERED`) {
          throw new Error(`deep link href is ${JSON.stringify(href)}`);
        }
        await Promise.all([page.waitForURL(/\/participants\?/, { timeout: 15000 }), link.first().click()]);
        await waitForMarker(page, SCREENS.find((screen) => screen.key === 'participants').marker);
        const live = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const people = live.workspaces[eventId].participants;
        const expected = people.filter((person) => person.status === 'APPROVED' && person.everIn !== true);
        if (!expected.length) throw new Error('seed has no never-entered approved people');
        if (expected.length >= people.length) throw new Error('subset is not a subset');
        const countText = (await page.locator('p[role="status"]').first().innerText()).replace(/\s+/g, ' ');
        if (!countText.includes(`${expected.length}명 / 전체 ${people.length}명`)) {
          throw new Error(`filtered count is ${JSON.stringify(countText)}`);
        }
        // The visible filters carry the deep link, and the entered subset
        // is genuinely absent while a never-entered name is present.
        const statusValue = await page.getByLabel('상태별 보기', { exact: true }).inputValue();
        const attendanceValue = await page.getByLabel('출입 상태별 보기', { exact: true }).inputValue();
        if (statusValue !== 'APPROVED' || attendanceValue !== 'NOT_ENTERED') {
          throw new Error(`filters show status=${statusValue} attendance=${attendanceValue}`);
        }
        if (await page.getByText('통합 확정 입장', { exact: false }).count()) {
          throw new Error('entered person leaks into the not-entered subset');
        }
        if (!await page.getByText('통합 확정 미입장', { exact: false }).count()) {
          throw new Error('never-entered person missing from the subset');
        }
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
        await waitForMarker(page, SCREENS.find((screen) => screen.key === 'participants').marker);
        if ((await page.getByLabel('상태별 보기', { exact: true }).inputValue()) !== 'APPROVED' ||
          (await page.getByLabel('출입 상태별 보기', { exact: true }).inputValue()) !== 'NOT_ENTERED') {
          throw new Error('reload did not restore the shared deep-link filters');
        }
        // Selection survives a cross-filter excursion: check a row, filter
        // it away, come back — the choice is still there.
        await page.getByRole('checkbox', { name: '통합 확정 미입장 선택' }).check();
        await page.getByLabel('출입 상태별 보기', { exact: true }).selectOption('INSIDE');
        await page.getByText(/숨김 \d+명/, { exact: false }).first().waitFor({ timeout: 10000 });
        await page.getByLabel('출입 상태별 보기', { exact: true }).selectOption('NOT_ENTERED');
        if (!await page.getByRole('checkbox', { name: '통합 확정 미입장 선택' }).isChecked()) {
          throw new Error('selection did not survive the cross-filter excursion');
        }
        // Reset through the visible filters restores the full list and URL.
        await page.getByLabel('상태별 보기', { exact: true }).selectOption('');
        await page.getByLabel('출입 상태별 보기', { exact: true }).selectOption('');
        const resetCount = (await page.locator('p[role="status"]').first().innerText()).replace(/\s+/g, ' ');
        if (!resetCount.includes(`전체 ${people.length}명`) || resetCount.includes('/')) {
          throw new Error(`reset count is ${JSON.stringify(resetCount)}`);
        }
        // Filters replace the current entry rather than adding route visits:
        // Back still returns to the actual overview entry we came from.
        await page.goBack({ waitUntil: 'networkidle', timeout: 30000 });
        if (new URL(page.url()).pathname !== `/console/events/${encodeURIComponent(eventId)}`) {
          throw new Error(`back landed on ${page.url()}`);
        }
        await saveShot(page, 'overview-deep-link.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Phase C — shared draft guard, settings first (the success criterion):
    // a dirty #set-name followed by a real sidebar messages link confirms;
    // dismiss stays with the value preserved, accept navigates. The theme
    // surface gets the same treatment as an additional guarded workspace.
    // A missing confirm is a real failure, never rerouted to an easier page.
    const assertDraftGuard = async (page, { fromPath, toSuffix, inputSelector, draftValue, reasonFragment }) => {
      await page.goto(`${baseUrl}${fromPath}`, { waitUntil: 'networkidle', timeout: 30000 });
      await page.locator(inputSelector).waitFor({ state: 'visible', timeout: 15000 });
      await page.locator(inputSelector).fill(draftValue);
      const targetLink = page.locator(`.desktop-side-nav a[href$="${toSuffix}"]`).first();
      let dialogMessage = null;
      page.on('dialog', async (dialog) => {
        dialogMessage = dialog.message();
        await dialog.dismiss();
      });
      await targetLink.click();
      await page.waitForTimeout(800);
      if (!dialogMessage || !dialogMessage.includes(reasonFragment)) {
        throw new Error(`cancel path: no draft confirm (saw ${JSON.stringify(dialogMessage)})`);
      }
      if (new URL(page.url()).pathname !== fromPath) {
        throw new Error(`cancel path: left the page to ${page.url()}`);
      }
      if ((await page.locator(inputSelector).inputValue()) !== draftValue) {
        throw new Error('cancel path: draft input was not preserved');
      }
      page.removeAllListeners('dialog');
      page.on('dialog', async (dialog) => dialog.accept());
      const arrived = new RegExp(`${toSuffix.replace(/\//g, '\\/')}($|[?#])`);
      await Promise.all([
        page.waitForURL(arrived, { timeout: 15000 }),
        targetLink.click(),
      ]);
      const landed = new URL(page.url()).pathname;
      if (!landed.endsWith(toSuffix)) throw new Error(`accept path: landed on ${page.url()}`);
    };
    await check('guard/settings-dirty-navigate', async () => {
      const context = await newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      try {
        const settingsPath = `/console/events/${encodeURIComponent(eventId)}/settings`;
        await page.goto(`${baseUrl}${settingsPath}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('#set-name').waitFor({ state: 'visible', timeout: 15000 });
        const original = await page.locator('#set-name').inputValue();
        await assertDraftGuard(page, {
          fromPath: settingsPath,
          toSuffix: '/messages',
          inputSelector: '#set-name',
          draftValue: `${original} · 가드 검증`,
          reasonFragment: '저장하지 않은 행사 설정',
        });
      } finally {
        await page.close();
        await context.close();
      }
    });
    await check('guard/theme-dirty-navigate', async () => {
      const context = await newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      try {
        await assertDraftGuard(page, {
          fromPath: `/console/events/${encodeURIComponent(eventId)}/page`,
          toSuffix: '/messages',
          inputSelector: '#home-intro',
          draftValue: `가드 검증 소개 ${Date.now()}`,
          reasonFragment: '저장하지 않은 변경',
        });
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Phase D — shared create dialog: initial focus, tab loop, dirty
    // Escape confirm (dismiss preserves, accept closes + restores focus).
    await check('dialog/create-focus-loop', async () => {
      const context = await newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/programs`, { waitUntil: 'networkidle', timeout: 30000 });
        const opener = page.getByRole('button', { name: '프로그램 만들기' }).first();
        await opener.click();
        await page.locator('#program-title').waitFor({ state: 'visible', timeout: 10000 });
        if (await page.evaluate(() => document.activeElement && document.activeElement.id) !== 'program-title') {
          throw new Error('initial focus is not on the dialog title input');
        }
        for (let index = 0; index < 12; index += 1) {
          await page.keyboard.press('Tab');
        }
        const escaped = await page.evaluate(() => {
          const dialog = document.querySelector('[role="dialog"]');
          const active = document.activeElement;
          return !dialog || !(active instanceof Node && dialog.contains(active));
        });
        if (escaped) throw new Error('tab loop left the dialog');
        await page.locator('#program-title').fill('통합 감사 포커스 검증');
        let dialogMessage = null;
        page.on('dialog', async (dialog) => {
          dialogMessage = dialog.message();
          await dialog.dismiss();
        });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);
        if (!dialogMessage || !dialogMessage.includes('작성 중인 프로그램 내용')) {
          throw new Error(`dirty Escape: no confirm (saw ${JSON.stringify(dialogMessage)})`);
        }
        if (!await page.locator('#program-title').isVisible()) throw new Error('dirty Escape dismiss closed the dialog');
        if ((await page.locator('#program-title').inputValue()) !== '통합 감사 포커스 검증') {
          throw new Error('dirty Escape dismiss dropped the draft');
        }
        page.removeAllListeners('dialog');
        page.on('dialog', async (dialog) => dialog.accept());
        await page.keyboard.press('Escape');
        await page.locator('#program-title').waitFor({ state: 'detached', timeout: 10000 });
        const restored = await page.evaluate(() => document.activeElement && document.activeElement.textContent);
        if (!String(restored || '').includes('프로그램 만들기')) {
          throw new Error('confirmed cancel did not restore focus to the opener');
        }
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Two actual tabs edit disjoint fields from the same draft version.
    // Merge must retain the other operator's title, not replace the whole
    // homeStyle object with the stale local snapshot.
    await check('theme/two-tab-field-merge', async () => {
      const context = await newContext({ viewport: { width: 412, height: 780 }, reducedMotion: 'reduce' });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const first = await context.newPage();
      const second = await context.newPage();
      second.on('dialog', (dialog) => dialog.accept());
      try {
        const href = `${baseUrl}/console/events/${encodeURIComponent(eventId)}/page`;
        await first.goto(href, { waitUntil: 'networkidle' });
        await second.goto(href, { waitUntil: 'networkidle' });
        const title = `동시 편집 제목 ${Date.now()}`;
        // Use a canonical value: the server intentionally trims outer
        // whitespace; that normalization is not a lost merge field.
        const intro = '현장 운영 인수인계 안내입니다. '.repeat(6).trim();
        await first.locator('#home-hero-title').fill(title);
        await second.locator('#home-intro').fill(intro);
        await first.getByRole('button', { name: '초안 저장', exact: true }).click();
        await first.getByText('초안을 저장했습니다.', { exact: false }).first().waitFor();
        await second.getByRole('button', { name: '초안 저장', exact: true }).click();
        await second.getByRole('heading', { name: '최신 초안이 달라졌습니다' }).waitFor();
        await second.getByRole('button', { name: '최신 초안 확인', exact: true }).click();
        await second.getByRole('button', { name: '내 변경을 최신 초안에 적용' }).click();
        // The merge is confirmed in place (one grammar for irreversible
        // commands), so the operator presses the confirming button.
        await second.getByRole('button', { name: '내 변경 유지하기', exact: true }).click();
        await second.getByText(/저장 대상으로 준비했습니다/).first().waitFor();
        if (await second.locator('#home-hero-title').inputValue() !== title || await second.locator('#home-intro').inputValue() !== intro) throw new Error('two-tab merge discarded a disjoint field');
        await second.getByRole('button', { name: '초안 저장', exact: true }).click();
        await second.getByText('초안을 저장했습니다.', { exact: false }).first().waitFor();
        const current = (await readBootstrap(helpers, baseUrl, extended.ownerCookie)).workspaces[eventId].pageExperience;
        if (current.draft.homeStyle.heroTitle !== title || current.draft.intro !== intro) throw new Error(`merged fields not persisted: ${JSON.stringify({ title: current.draft.homeStyle.heroTitle, intro: current.draft.intro })}`);
        await second.locator('#home-intro').scrollIntoViewIfNeeded();
        await second.screenshot({ path: path.join(CAPTURE_DIR, 'theme-two-tab-merge-phone.png') });
      } finally {
        await first.close();
        await second.close();
        await context.close();
      }
    });

    // Phase E — lose the RESPONSE AFTER a real commit. Unchanged retries
    // replay the same receipt; edits bind a new intent and must not replay
    // the earlier payload. The stale version then conflicts honestly.
    await check('theme/save-conflict-publish', async () => {
      const context = await newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      const saveIds = [];
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/page`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.locator('#home-intro').waitFor({ state: 'visible', timeout: 15000 });
        const committed = `통합 감사 확정 소개 ${Date.now()}`;
        await page.locator('#home-intro').fill(committed);
        await page.getByRole('button', { name: '초안 저장', exact: true }).click();
        await page.getByText('초안을 저장했습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        const live = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const draftVersion = live.workspaces[eventId].pageExperience.draftVersion;
        // Labeled response-loss injection: route.fetch really commits first,
        // then only the browser-visible response becomes 502 (never fake 200).
        let injectOnce = true;
        await page.route('**/api/events/*/commands', async (route) => {
          const request = route.request();
          let body = null;
          try { body = JSON.parse(request.postData() || 'null'); } catch { /* non-JSON passes through */ }
          if (injectOnce && body && body.command === 'attendee.page.save') {
            injectOnce = false;
            saveIds.push(body.commandId);
            const real = await route.fetch();
            if (real.status() !== 200) throw new Error(`save before response loss: ${real.status()}`);
            await route.fulfill({ status: 502, contentType: 'application/json', body: '{}' });
            return;
          }
          if (body && (body.command === 'attendee.page.save' || body.command === 'attendee.page.publish')) {
            saveIds.push(body.commandId);
          }
          await route.continue();
        });
        const edited = `${committed} · 추가 편집`;
        await page.locator('#home-intro').fill(edited);
        await page.getByRole('button', { name: '초안 저장', exact: true }).click();
        await page.getByText('초안을 저장하지 못했습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        if ((await page.locator('#home-intro').inputValue()) !== edited) {
          throw new Error('failed save overwrote the local edit');
        }
        // Unchanged retry must settle the already-committed same request.
        await page.getByRole('button', { name: '초안 저장', exact: true }).click();
        await page.getByText('초안을 저장했습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        if (saveIds.length < 2 || saveIds[0] !== saveIds[1]) {
          throw new Error(`unchanged retry must replay the receipt id (saw ${JSON.stringify(saveIds)})`);
        }
        // A second lost response followed by another edit must bind a NEW id.
        const second = `${edited} · 응답 유실`;
        await page.locator('#home-intro').fill(second);
        injectOnce = true;
        await page.getByRole('button', { name: '초안 저장', exact: true }).click();
        await page.getByText('초안을 저장하지 못했습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        const finalEdit = `${second} · 보존할 새 입력`;
        await page.locator('#home-intro').fill(finalEdit);
        await page.getByRole('button', { name: '초안 저장', exact: true }).click();
        await page.getByRole('heading', { name: '최신 초안이 달라졌습니다' }).waitFor({ timeout: 15000 });
        if ((await page.locator('#home-intro').inputValue()) !== finalEdit) {
          throw new Error('conflict overwrote the local edit');
        }
        if (saveIds.length < 4 || saveIds[2] === saveIds[3]) {
          throw new Error(`changed payload reused an old receipt id (saw ${JSON.stringify(saveIds)})`);
        }
        await page.getByRole('button', { name: '최신 초안 확인', exact: true }).click();
        await page.getByRole('button', { name: '내 변경을 최신 초안에 적용' }).waitFor({ state: 'visible', timeout: 15000 });
        await page.getByRole('button', { name: '내 변경을 최신 초안에 적용' }).click();
        await page.getByRole('button', { name: '내 변경 유지하기', exact: true }).click();
        await page.getByText(/저장 대상으로 준비했습니다/).first().waitFor({ timeout: 15000 });
        if ((await page.locator('#home-intro').inputValue()) !== finalEdit) {
          throw new Error('apply-latest dropped the local edit');
        }
        await page.unroute('**/api/events/*/commands');
        await page.getByRole('button', { name: '초안 저장', exact: true }).click();
        await page.getByText('초안을 저장했습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: '게시', exact: true }).click();
        await page.getByRole('button', { name: '게시하기', exact: true }).click();
        await page.getByText('게시했습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        const published = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const experience = published.workspaces[eventId].pageExperience;
        if (experience.published.intro !== finalEdit) {
          throw new Error('published intro is not the applied local edit');
        }
        if (!(experience.draftVersion >= draftVersion + 2)) {
          throw new Error(`draft version did not advance (saw ${experience.draftVersion})`);
        }
        await saveShot(page, 'theme-conflict-publish.png');
      } finally {
        await page.unroute('**/api/events/*/commands').catch(() => {});
        await page.close();
        await context.close();
      }
    });

    await auditLongListBoundaries({ fixture, extended, baseUrl, eventId, ownerSession, newContext, check, captureDir: CAPTURE_DIR });

    // Phase F — report print emits only the chosen saved snapshot: stub
    // window.print (simulation) to observe the clone mid-print, then let
    // afterprint clean up. Snapshot counts stay frozen after a real scan.
    await check('report/print-snapshot', async () => {
      const context = await newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/reports`, { waitUntil: 'networkidle', timeout: 30000 });
        await waitForMarker(page, SCREENS.find((screen) => screen.key === 'reports').marker);
        await page.getByRole('button', { name: '내용 보기' }).first().click();
        await page.locator('article').first().waitFor({ state: 'visible', timeout: 10000 });
        const snapshotText = (await page.locator('article').first().innerText()).replace(/\s+/g, ' ');
        await page.evaluate(() => {
          window.__printSawClone = null;
          window.print = () => {
            const clone = document.getElementById('eventouch-report-print');
            window.__printSawClone = clone ? clone.innerText.replace(/\s+/g, ' ').slice(0, 2000) : null;
          };
        });
        await page.getByRole('button', { name: '인쇄하기' }).click();
        await page.waitForFunction(() => window.__printSawClone !== null, null, { timeout: 10000 });
        const seen = await page.evaluate(() => window.__printSawClone);
        if (!seen || !seen.includes('통합 감사 결과')) {
          throw new Error(`print clone missed the chosen snapshot (saw ${JSON.stringify((seen || '').slice(0, 120))})`);
        }
        if (seen.includes('결과 분석')) throw new Error('print clone leaked the live analysis section');
        await page.emulateMedia({ media: 'print' });
        const visibleChildren = await page.evaluate(() => [...document.body.children]
          .filter((node) => getComputedStyle(node).display !== 'none' && node.getBoundingClientRect().height > 0)
          .map((node) => node.id));
        if (visibleChildren.length !== 1 || visibleChildren[0] !== 'eventouch-report-print') {
          throw new Error(`print contains unselected page content: ${JSON.stringify(visibleChildren)}`);
        }
        await page.screenshot({ path: path.join(CAPTURE_DIR, 'report-print-emulated.png'), fullPage: true });
        await page.pdf({ path: path.join(CAPTURE_DIR, 'report-print-emulated.pdf'), format: 'A4', printBackground: true });
        await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
        await page.waitForFunction(
          () => !document.getElementById('eventouch-report-print') && !document.body.classList.contains('report-printing'),
          null,
          { timeout: 10000 },
        );
        await page.emulateMedia({ media: 'screen' });
        // A real check-in after publication must not move the frozen counts.
        const scanTarget = (await readBootstrap(helpers, baseUrl, extended.ownerCookie))
          .workspaces[eventId].participants.find((person) => person.name === '통합 확정 미입장');
        await apiCommand(helpers, baseUrl, fixture.staff.cookie, eventId, 'check.scan', {
          deskId: fixture.deskId, ticket: scanTarget.ticket,
        }, `audit-assign-${fixture.suffix}`);
        await page.reload({ waitUntil: 'networkidle', timeout: 30000 });
        await page.getByRole('button', { name: '내용 보기' }).first().click();
        await page.locator('article').first().waitFor({ state: 'visible', timeout: 10000 });
        const afterText = (await page.locator('article').first().innerText()).replace(/\s+/g, ' ');
        if (afterText !== snapshotText) throw new Error('published snapshot moved after a real check-in');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Phase G — archived/ended availability mirrors the server: mutations
    // 409 through the real API, reads/exports stay available in the UI.
    await check('readonly/stage-gates', async () => {
      const live = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
      const endedPerson = live.workspaces[extended.endedEventId].participants[0];
      const archivedPerson = live.workspaces[extended.archivedEventId].participants[0];
      const endedStatus = await helpers.requestJson(baseUrl, `/api/events/${extended.endedEventId}/commands`, {
        method: 'POST',
        cookie: extended.ownerCookie,
        body: { commandId: commandId('console-audit'), command: 'participant.status', payload: { id: endedPerson.id, status: 'CANCELLED' } },
      });
      if (endedStatus.status !== 409) throw new Error(`ENDED participant.status: ${endedStatus.status}`);
      const archivedNotice = await helpers.requestJson(baseUrl, `/api/events/${extended.archivedEventId}/commands`, {
        method: 'POST',
        cookie: extended.ownerCookie,
        body: { commandId: commandId('console-audit'), command: 'notice.save', payload: { title: '보관 후 쓰기', body: '거부되어야 함' } },
      });
      if (archivedNotice.status !== 409) throw new Error(`ARCHIVED notice.save: ${archivedNotice.status}`);
      const context = await newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(extended.archivedEventId)}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.getByText('보관된 행사는 변경할 수 없습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        if (!await page.locator('input[placeholder*="이름·소속·연락처 검색"]').count()) {
          throw new Error('archived reads unavailable');
        }
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(extended.archivedEventId)}/page`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.getByText('보관된 행사는 읽기 전용입니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        if (await page.getByRole('button', { name: '초안 저장', exact: true }).isEnabled()) {
          throw new Error('archived save affordance is enabled');
        }
        await page.goto(`${baseUrl}/console/events/${encodeURIComponent(extended.endedEventId)}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.getByText('종료된 행사는 참가자를 변경할 수 없습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        await saveShot(page, 'readonly-ended.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Phases W1–W3 — centralized write dialogs under a lost response: the
    // first mutation really commits (route.fetch, asserted 2xx) and only
    // the browser's copy is replaced with a 502. Shared-dialog alert,
    // intact inputs, open dialog; unchanged retry closes it with exactly
    // one new record on the same receipt id; settled writes guard nothing.
    const stamp = Date.now();
    const ownerCtxFor = async (viewport) => {
      const context = await browser.newContext({ viewport });
      await context.addCookies([{ name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      return context;
    };
    await check('writes/response-loss-client', async () => {
      const clientName = `유실 검증 고객사 ${stamp}`;
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await assertResponseLossRetry(page, helpers, baseUrl, eventId, eventName, {
          label: 'writes/response-loss-client',
          screen: SCREENS.find((screen) => screen.key === 'clients'),
          openName: '고객사 등록',
          fields: [
            { selector: '#client-name', value: clientName },
            { selector: '#client-contact', value: '유실 담당' },
            { selector: '#client-email', value: `writeloss-${stamp}@example.test` },
          ],
          submitName: '저장',
          routePattern: '**/api/clients',
          matchRequest: (body) => body && body.name === clientName,
          failureText: '응답 유실 검증',
          dialogShot: 'writes-client-dialog-error.png',
          readRecords: async () => (await readBootstrap(helpers, baseUrl, extended.ownerCookie)).clients,
          isNewRecord: (client) => client && client.name === clientName,
          guardSelector: 'a[href="/console"]:visible',
          guardPathname: '/console',
        });
      } finally {
        await page.close();
        await context.close();
      }
    });
    await check('writes/response-loss-notice', async () => {
      const noticeTitle = `유실 검증 공지 ${stamp}`;
      const context = await ownerCtxFor({ width: 390, height: 844 });
      const page = await context.newPage();
      try {
        await assertResponseLossRetry(page, helpers, baseUrl, eventId, eventName, {
          label: 'writes/response-loss-notice',
          screen: SCREENS.find((screen) => screen.key === 'content'),
          openName: '공지 작성',
          fields: [
            { selector: '#content-notice-title', value: noticeTitle },
            { selector: '#content-notice-body', value: '응답 유실 재시도 검증 본문입니다.' },
          ],
          submitName: '만들기',
          routePattern: '**/api/events/*/commands',
          matchRequest: (body) => body && body.command === 'notice.save' && body.payload && body.payload.title === noticeTitle,
          failureText: '응답 유실 검증',
          dialogShot: 'writes-notice-dialog-error.png',
          readRecords: async () => (await readBootstrap(helpers, baseUrl, extended.ownerCookie)).workspaces[eventId].notices,
          isNewRecord: (notice) => notice && notice.title === noticeTitle,
          guardSelector: 'a[href$="/messages"]:visible',
          guardPathname: `/console/events/${encodeURIComponent(eventId)}/messages`,
        });
      } finally {
        await page.close();
        await context.close();
      }
    });
    await check('writes/response-loss-desk', async () => {
      const deskName = `유실 검증 데스크 ${stamp}`;
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await assertResponseLossRetry(page, helpers, baseUrl, eventId, eventName, {
          label: 'writes/response-loss-desk',
          screen: SCREENS.find((screen) => screen.key === 'operations'),
          openName: '데스크 추가',
          fields: [{ selector: '#desk-name', value: deskName }],
          submitName: '데스크 저장',
          routePattern: '**/api/events/*/commands',
          matchRequest: (body) => body && body.command === 'desk.save' && body.payload && body.payload.name === deskName,
          failureText: '응답 유실 검증',
          dialogShot: 'writes-desk-dialog-error.png',
          readRecords: async () => (await readBootstrap(helpers, baseUrl, extended.ownerCookie)).workspaces[eventId].desks,
          isNewRecord: (desk) => desk && desk.name === deskName,
          guardSelector: 'a[href$="/messages"]:visible',
          guardPathname: `/console/events/${encodeURIComponent(eventId)}/messages`,
        });
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Desk edit is a real operator need (typo/direction fixes after creation);
    // the dialog must reuse the existing desk.save update path, keep the
    // current open state, and require the server's direction confirmation.
    await check('ops/desk-edit', async () => {
      const deskName = `편집 검증 데스크 ${stamp}`;
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/operations`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'operations'), eventId, eventName);
        await page.getByRole('button', { name: '데스크 추가' }).click();
        const addDialog = page.getByRole('dialog');
        await addDialog.locator('#desk-name').fill(deskName);
        await addDialog.getByRole('button', { name: '데스크 저장' }).click();
        const row = page.getByRole('listitem').filter({ hasText: deskName }).first();
        await row.waitFor({ timeout: 10000 });
        await row.getByRole('button', { name: '편집' }).click();
        const editDialog = page.getByRole('dialog');
        if (!await editDialog.getByText('데스크 편집', { exact: true }).count()) throw new Error('edit dialog did not open in edit mode');
        if (await editDialog.locator('#desk-name').inputValue() !== deskName) throw new Error('edit dialog lost the desk name');
        await editDialog.locator('#desk-name').fill(`${deskName} 수정`);
        await editDialog.locator('#desk-mode').selectOption('tablet');
        if (await editDialog.locator('#desk-direction-confirm').count()) throw new Error('direction confirmation shown without a change');
        await editDialog.getByRole('button', { name: '데스크 저장' }).click();
        const edited = page.getByRole('listitem').filter({ hasText: `${deskName} 수정` }).first();
        await edited.waitFor({ timeout: 10000 });
        const editedText = await edited.innerText();
        if (!editedText.includes('태블릿') || !editedText.includes('가동 중')) throw new Error(`edit lost mode or open state: ${editedText}`);
        await edited.getByRole('button', { name: '편집' }).click();
        const directionDialog = page.getByRole('dialog');
        await directionDialog.locator('#desk-action').selectOption('OUT');
        if (!await directionDialog.locator('#desk-direction-confirm').isVisible()) throw new Error('direction change did not ask for confirmation');
        if (await directionDialog.getByRole('button', { name: '데스크 저장' }).isEnabled()) throw new Error('direction change saved without confirmation');
        await directionDialog.locator('#desk-direction-confirm').check();
        await directionDialog.getByRole('button', { name: '데스크 저장' }).click();
        await page.waitForFunction(() => !document.querySelector('[role="dialog"]'), null, { timeout: 10000 });
        const desks = (await readBootstrap(helpers, baseUrl, extended.ownerCookie)).workspaces[eventId].desks;
        const saved = desks.find((desk) => desk.name === `${deskName} 수정`);
        if (!saved || saved.action !== 'OUT' || saved.mode !== 'tablet' || saved.open !== false) {
          throw new Error(`desk update mismatch: ${JSON.stringify(saved)}`);
        }
        await saveShot(page, 'ops/desk-edit.png');
      } finally {
        await page.close();
        await context.close();
      }
    });
    // The participant map is the published version only; saving a draft used
    // to look done. The screen must separate 초안 저장 from 게시.
    await check('ops/map-draft-publish', async () => {
      const fixture = path.join(CAPTURE_DIR, 'ops-map-fixture.png');
      fs.writeFileSync(fixture, Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAOklEQVR42u3PMQEAAAgDoJdc/9C3gR9JgVx3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3d3dw8t5QABvTqR5QAAAABJRU5ErkJggg==',
        'base64'
      ));
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/operations`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'operations'), eventId, eventName);
        if (!await page.locator('#ops-booth-map').count()) throw new Error('booth map section missing');
        // `headingId` labels the section; the file input lives inside it.
        await page.locator('section[aria-labelledby="ops-booth-map"] input[type="file"]').setInputFiles(fixture);
        const saveDraft = page.getByRole('button', { name: '초안 저장' });
        await saveDraft.waitFor({ timeout: 15000 });
        await saveDraft.click();
        await page.getByText('초안이 아직 게시되지 않았습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        await page.getByRole('button', { name: '게시', exact: true }).click();
        await page.getByText('초안이 아직 게시되지 않았습니다.', { exact: false }).first().waitFor({ state: 'detached', timeout: 15000 });
        if (!await page.getByText(/게시본 v\d+ · \d+개 위치/).first().isVisible()) throw new Error('published map hint missing after 게시');
        const workspace = (await readBootstrap(helpers, baseUrl, extended.ownerCookie)).workspaces[eventId];
        if (!workspace.boothMap?.published?.version) throw new Error('booth map not published in API state');
        await saveShot(page, 'ops/map-published.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // The draw target condition must name the server pool rule (check-in
    // completed), and the quizzes' grading rule must be stated where the
    // result counts appear.
    await check('draws/target-condition-copy', async () => {
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/draws`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'draws'), eventId, eventName);
        const program = page.locator('li').filter({ hasText: '통합 감사 추첨 프로그램' }).first();
        await program.waitFor({ timeout: 10000 });
        if (!await program.getByText('입장(체크인)한 승인 참가자 전체 대상', { exact: false }).count()) {
          throw new Error('draw target condition does not name the check-in requirement');
        }
        await saveShot(page, 'draws/target-condition.png');
      } finally {
        await page.close();
        await context.close();
      }
    });
    await check('programs/draw-link', async () => {
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/programs`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'programs'), eventId, eventName);
        const drawCard = page.locator('li').filter({ hasText: '통합 감사 추첨 무대' }).first();
        await drawCard.waitFor({ timeout: 10000 });
        const link = drawCard.getByRole('link', { name: '추첨', exact: true });
        if (!await link.count() || !(await link.getAttribute('href')).endsWith('/draws')) {
          throw new Error('program draw card does not link to the draws screen');
        }
        await saveShot(page, 'programs/draw-link.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // The SELF booth QR is scanned by the participant inside their own tab
    // (the ticket bearer never leaves it). Render the real staff QR, feed it
    // to Chromium as a fake camera and let jsQR decode it in the participant
    // screen; the decoded code goes through the same server-checked submit.
    await check('attendee/booth-scan-stamp', async () => {
      const qrShot = path.join(CAPTURE_DIR, 'attendee/booth-qr.png');
      const qrPadded = path.join(CAPTURE_DIR, 'attendee/booth-qr-padded.png');
      const qrVideo = path.join(CAPTURE_DIR, 'attendee/booth-qr.y4m');
      fs.mkdirSync(path.dirname(qrShot), { recursive: true });
      const staffContext = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      await staffContext.addCookies([{ name: 'etko_session', value: sessionValue(fixture.staff.cookie), httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const staffPage = await staffContext.newPage();
      try {
        await staffPage.goto(`${baseUrl}/staff/events/${encodeURIComponent(eventId)}`, { waitUntil: 'networkidle', timeout: 30000 });
        await staffPage.getByRole('button', { name: '부스 인증', exact: true }).click();
        await staffPage.locator('#staff-booth').selectOption(extended.boothId);
        const qr = staffPage.getByRole('img', { name: /인증 QR/ });
        await qr.waitFor({ timeout: 10000 });
        await qr.scrollIntoViewIfNeeded();
        const qrGraphic = qr.locator('svg').first();
        await qrGraphic.waitFor({ timeout: 10000 });
        await qrGraphic.screenshot({ path: qrShot });
        await saveShot(staffPage, 'attendee/booth-staff-qr.png');
      } finally {
        await staffPage.close();
        await staffContext.close();
      }
      // A quiet zone and nearest-neighbour upscale make the rendered SVG
      // decodable frame after frame; ffmpeg turns it into a fake camera feed.
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', qrShot,
        '-vf', 'scale=iw*3:ih*3:flags=neighbor,pad=iw+240:ih+240:120:120:color=white',
        '-frames:v', '1', qrPadded]);
      // yuv420p needs even dimensions: an odd frame size produces a video the
      // fake camera cannot open, and the scan would silently never decode.
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-loop', '1', '-i', qrPadded,
        '-vf', 'scale=600:600:flags=neighbor', '-t', '10', '-r', '10', '-pix_fmt', 'yuv420p', qrVideo]);
      const { chromium } = loadPlaywright();
      const scanBrowser = await chromium.launch({
        ...launchOptions(),
        args: [
          '--use-fake-ui-for-media-stream',
          '--use-fake-device-for-media-stream',
          `--use-file-for-fake-video-capture=${qrVideo}`,
        ],
      });
      try {
        const context = await scanBrowser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.on('pageerror', (error) => failures.push(`pageerror attendee scan: ${error.message}`));
        const state = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const person = state.workspaces[eventId].participants.find(
          (item) => item.inside === true && item.status === 'APPROVED'
        );
        if (!person || !person.ticket) throw new Error('no checked-in participant with a ticket for stamping');
        await page.goto(`${baseUrl}/event/${encodeURIComponent(fixture.slug)}/home?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.getByRole('button', { name: '부스 인증', exact: true }).click();
        await page.getByRole('button', { name: '카메라로 스캔', exact: true }).click();
        await page.getByText(/인증을 기록했습니다/).first().waitFor({ timeout: 30000 });
        const after = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const visits = after.workspaces[eventId].visits.filter(
          (visit) => visit.boothId === extended.boothId && visit.participantId === person.id
        );
        if (visits.length !== 1) throw new Error(`expected 1 scanned booth visit, got ${visits.length}`);
        const boothRow = after.workspaces[eventId].booths.find((item) => item.id === extended.boothId);
        if (Number(boothRow.used) !== 1) throw new Error(`booth.used expected 1, got ${boothRow.used}`);
        await saveShot(page, 'attendee/booth-scan-done.png');
        await context.close();
      } finally {
        await scanBrowser.close();
      }
    });

    // The manual code path stays for phones without a usable camera, and the
    // per-booth visit limit is enforced by the server, not the screen.
    await check('attendee/booth-self-stamp', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(`pageerror attendee booth stamp: ${error.message}`));
      try {
        const state = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const person = state.workspaces[eventId].participants.find(
          (item) => item.inside === true && item.status === 'APPROVED'
        );
        if (!person || !person.ticket) throw new Error('no checked-in participant with a ticket for stamping');
        const code = `ET:BOOTH:${eventId}:${extended.boothId}`;
        await page.goto(`${baseUrl}/event/${encodeURIComponent(fixture.slug)}/home?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.getByRole('button', { name: '부스 인증', exact: true }).click();
        const field = page.getByLabel('부스 코드');
        await field.waitFor({ timeout: 10000 });
        await field.fill(code);
        await page.getByRole('button', { name: '인증하기', exact: true }).click();
        // The camera-scan phase already used the single allowed visit: the
        // typed code must be refused by the server and must not double-count.
        await page.getByRole('alert').getByText(/인증 횟수를 모두 사용했습니다/).waitFor({ timeout: 15000 });
        const after = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const visits = after.workspaces[eventId].visits.filter(
          (visit) => visit.boothId === extended.boothId && visit.participantId === person.id
        );
        if (visits.length !== 1) throw new Error(`expected the scan visit only, got ${visits.length}`);
        const boothRow = after.workspaces[eventId].booths.find((item) => item.id === extended.boothId);
        if (Number(boothRow.used) !== 1) throw new Error(`booth.used expected 1, got ${boothRow.used}`);
        await saveShot(page, 'attendee/booth-stamp-limit.png');
      } finally {
        await page.close();
        await context.close();
      }
    });
    await check('attendee/booth-stamp-needs-ticket', async () => {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(`pageerror attendee booth ticket: ${error.message}`));
      try {
        await page.goto(`${baseUrl}/event/${encodeURIComponent(fixture.slug)}/home`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.getByRole('button', { name: '부스 인증', exact: true }).click();
        await page.getByText('티켓이 확인되지 않습니다.').first().waitFor({ timeout: 10000 });
        await page.getByRole('link', { name: '내 티켓 찾기' }).first().waitFor({ timeout: 5000 });
        await saveShot(page, 'attendee/booth-stamp-no-ticket.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // A price without the payment feature is silently not charged; the
    // settings screen has to say which side of that contract it is on.
    await check('settings/price-payment-hint', async () => {
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'settings'), eventId, eventName);
        const price = page.locator('#set-price');
        const hint = page.getByText('이 시스템은 결제를 처리하지 않습니다', { exact: false });
        if (await hint.count()) throw new Error('price hint shown for a zero price');
        if (await page.getByLabel('결제', { exact: true }).count()) throw new Error('payment feature toggle still rendered');
        await price.fill('10000');
        await page.getByRole('button', { name: '기본 정보 저장' }).click();
        await hint.first().waitFor({ timeout: 15000 });
        await saveShot(page, 'settings/price-hint.png');
        await price.fill('0');
        await page.getByRole('button', { name: '기본 정보 저장' }).click();
        await hint.first().waitFor({ state: 'detached', timeout: 15000 });
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Operator-side information batch: an agency operator must see the
    // approval backlog, the group-assignment scope, the draw prerequisites
    // and the stage-board selection state without combining other screens.
    await check('operator/information-batch', async () => {
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(`pageerror operator batch: ${error.message}`));
      try {
        // Reports: the approval backlog is visible, and creating a report
        // warns that later approvals will not be reflected.
        await page.goto(`${baseUrl}/console/events/${eventId}/reports`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'reports'), eventId, eventName);
        const backlog = page.getByText('승인 대기 (명)');
        await backlog.first().waitFor({ timeout: 10000 });
        const backlogValue = await backlog.first().locator('xpath=..').innerText();
        if (!/2/.test(backlogValue)) throw new Error(`approval backlog card shows no pending count: ${backlogValue}`);
        await page.getByRole('button', { name: '보고서 만들기', exact: true }).click();
        const warning = page.getByText(/승인 대기 2명이 남아 있습니다/);
        await warning.first().waitFor({ timeout: 10000 });
        const pendingLink = page.getByRole('link', { name: '참가자에서 승인 처리하기' });
        if (!await pendingLink.count() || !(await pendingLink.getAttribute('href')).includes('status=PENDING')) {
          throw new Error('report dialog does not link to the pending queue');
        }
        await page.keyboard.press('Escape');
        await saveShot(page, 'operator/report-approval-backlog.png');

        // Participants: a selection that the filter hides says so, and the
        // group dialog repeats the scope. One selected row stays visible so
        // the group action stays available.
        await page.goto(`${baseUrl}/console/events/${eventId}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'participants'), eventId, eventName);
        await page.getByRole('checkbox', { name: '통합 대기 하나 선택' }).check();
        await page.getByRole('checkbox', { name: '통합 대기 둘 선택' }).check();
        const search = page.getByPlaceholder('이름·소속·연락처 검색');
        await search.fill('통합 대기 둘');
        await page.getByText(/숨김 \d+명\(그룹 지정 제외\)/).first().waitFor({ timeout: 10000 });
        await page.getByRole('button', { name: '그룹 지정', exact: true }).click();
        await page.getByText(/화면 밖에서 선택한 \d+명은 이번 지정에 포함되지 않습니다/).first().waitFor({ timeout: 10000 });
        await saveShot(page, 'operator/group-scope.png');
        await page.getByRole('button', { name: '취소', exact: true }).first().click();

        // Draws: one line states every missing prerequisite.
        await page.goto(`${baseUrl}/console/events/${eventId}/draws`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'draws'), eventId, eventName);
        await page.getByText(/실행 전제:/).first().waitFor({ timeout: 10000 });
        await saveShot(page, 'operator/draw-prerequisites.png');

        // Messages: a template can carry every channel a campaign can send.
        await page.goto(`${baseUrl}/console/events/${eventId}/messages`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'messages'), eventId, eventName);
        await page.getByText('템플릿 관리 열기').click();
        const channel = page.locator('#template-channel');
        await channel.waitFor({ timeout: 10000 });
        await channel.selectOption('MMS');
        await page.getByText('MMS 이미지는 발송할 때 첨부합니다.').first().waitFor({ timeout: 10000 });
        await saveShot(page, 'operator/template-mms.png');

        // Stage board: an unapplied selection says so.
        await page.goto(`${baseUrl}/console/events/${eventId}/operations`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'operations'), eventId, eventName);
        const displayPick = page.locator('#ops-display-pick');
        await displayPick.waitFor({ timeout: 10000 });
        const options = await displayPick.locator('option').allTextContents();
        // The applied output is identified by its value, not its label, so try
        // every real option: the notice must appear for at least the choices
        // that are not the currently applied output.
        let announced = false;
        for (const label of options) {
          if (!label || label === '출력 고르기') continue;
          await displayPick.selectOption({ label });
          try {
            await page.getByText('선택한 출력은 아직 적용되지 않았습니다.').first().waitFor({ timeout: 1500 });
            announced = true;
            await saveShot(page, 'operator/display-unapplied.png');
            break;
          } catch (error) {
            // This option is the applied one; try the next.
          }
        }
        if (!announced) throw new Error(`no stage-board selection reported the unapplied state: ${options.join(', ')}`);

        // Settings: ending a stage reminds the operator to freeze the report.
        await page.goto(`${baseUrl}/console/events/${eventId}/settings`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'settings'), eventId, eventName);
        const stageFold = page.locator('details').filter({ hasText: '진행 단계' }).first();
        if (await stageFold.count() && !(await stageFold.getAttribute('open'))) {
          await stageFold.locator('summary').first().click();
        }
        await page.getByRole('button', { name: /종료\(으\)로 전환/ }).click();
        await page.getByText(/결과 보고서는 생성 시점 값으로 고정되므로/).first().waitFor({ timeout: 10000 });
        await saveShot(page, 'operator/ended-report-reminder.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Rewards: a prize must name its draw program and link to that program.
    await check('rewards/draw-program-link', async () => {
      const state = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
      const program = (state.workspaces[eventId].drawPrograms || [])[0];
      if (!program) throw new Error('no draw program to draw from');
      await apiCommand(helpers, baseUrl, extended.ownerCookie, eventId, 'draw.program.save', { id: program.id, published: true }, `draw-publish-${fixture.suffix}`);
      await apiCommand(helpers, baseUrl, extended.ownerCookie, eventId, 'draw.program.run', { id: program.id, count: 1 }, `draw-run-${fixture.suffix}`);
      // A company draw leaves the prize without a recipient, which is the
      // case that offers the "지정" link to the draw program.
      const companyProgram = (await apiCommand(helpers, baseUrl, extended.ownerCookie, eventId, 'draw.program.save', {
        name: '통합 감사 업체 추첨', quota: 1, moduleId: program.moduleId,
        eligibility: 'COMPANY', eligibleGroups: [], eligibleCompanies: [],
        overlap: 'NONE', prizeTiers: null, status: 'OPEN', published: true,
      }, `draw-company-save-${fixture.suffix}`)).program;
      await apiCommand(helpers, baseUrl, extended.ownerCookie, eventId, 'draw.program.run', { id: companyProgram.id, count: 1 }, `draw-company-run-${fixture.suffix}`);
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/rewards`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'rewards'), eventId, eventName);
        const rows = page.locator('li').filter({ hasText: '통합 감사 추첨 프로그램' });
        await rows.first().waitFor({ timeout: 10000 });
        if (await page.getByText('연결 추첨 확인 필요').count()) throw new Error('a draw prize still hides its program name');
        const link = page.getByRole('link', { name: '추첨에서 수령자 지정' });
        await link.first().waitFor({ timeout: 10000 });
        const href = await link.first().getAttribute('href');
        if (!href || !href.includes('#draw-program-')) throw new Error(`reward link misses the program anchor: ${href}`);
        await saveShot(page, 'operator/rewards-draw-program.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Adding one participant by hand is a working path of its own: no file,
    // no import wizard, and the record lands with a ticket.
    await check('operator/add-participant', async () => {
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(`pageerror operator add participant: ${error.message}`));
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'participants'), eventId, eventName);
        await page.getByRole('button', { name: '참가자 추가', exact: true }).click();
        const dialog = page.getByRole('dialog');
        await dialog.waitFor({ timeout: 10000 });
        const name = `통합 감사 수동 ${Date.now()}`;
        const phone = `010${String(Date.now()).slice(-8)}`;
        await dialog.getByLabel('이름', { exact: true }).fill(name);
        await dialog.getByLabel('연락처', { exact: true }).fill(phone);
        await dialog.getByLabel('소속 (선택)').fill('감사 업체 9');
        await dialog.getByLabel('등록 방식', { exact: true }).selectOption('PRE');
        await dialog.getByRole('button', { name: '등록', exact: true }).click();
        await page.getByText(name, { exact: true }).first().waitFor({ timeout: 15000 });
        const after = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const created = after.workspaces[eventId].participants.find((person) => person.name === name);
        if (!created) throw new Error('manually added participant is missing from the roster');
        if (created.phone !== phone) throw new Error('manual participant kept a different phone');
        if (created.status !== 'APPROVED') throw new Error(`manual participant status is ${created.status}`);
        if (!created.ticket) throw new Error('manual participant got no ticket');
        await saveShot(page, 'operator/added-participant.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    // Bulk approval: one action settles a pile of waiting applications.
    await check('operator/bulk-approve', async () => {
      const context = await ownerCtxFor({ width: 1280, height: 900 });
      const page = await context.newPage();
      page.on('pageerror', (error) => failures.push(`pageerror operator bulk approve: ${error.message}`));
      try {
        await page.goto(`${baseUrl}/console/events/${eventId}/participants?status=PENDING`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertConsoleScreen(page, SCREENS.find((screen) => screen.key === 'participants'), eventId, eventName);
        const pendingBoxes = page.getByRole('checkbox', { name: /선택$/ });
        const count = await pendingBoxes.count();
        if (count < 2) throw new Error(`expected several waiting participants, got ${count}`);
        await pendingBoxes.nth(0).check();
        await pendingBoxes.nth(1).check();
        await page.getByRole('button', { name: '선택 승인', exact: true }).click();
        await page.getByText(/명을 승인했습니다/).first().waitFor({ timeout: 15000 });
        const after = await readBootstrap(helpers, baseUrl, extended.ownerCookie);
        const waiting = after.workspaces[eventId].participants.filter((person) => person.status === 'PENDING');
        if (waiting.length !== count - 2) {
          throw new Error(`bulk approval left ${waiting.length} waiting of ${count}`);
        }
        await saveShot(page, 'operator/bulk-approve.png');
      } finally {
        await page.close();
        await context.close();
      }
    });

    await check('roles/mobile-global-navigation', async () => {
      for (const [role, cookie] of [['MANAGER', fixture.manager.cookie], ['STAFF', fixture.staff.cookie]]) {
        const context = await newContext({ viewport: { width: 360, height: 780 }, reducedMotion: 'reduce' });
        await context.addCookies([{ name: 'etko_session', value: sessionValue(cookie), httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
        const page = await context.newPage();
        try {
          await page.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`, { waitUntil: 'networkidle' });
          await waitForMarker(page, SCREENS.find((screen) => screen.key === 'participants').marker);
          const trigger = page.locator('.console-global-trigger');
          if (role === 'STAFF') {
            if (await trigger.count()) throw new Error('staff was offered an empty or unauthorized global menu');
          } else {
            await trigger.click();
            const links = page.locator('#console-global-menu').getByRole('link');
            if (await links.count() !== 1 || await links.first().innerText() !== '행사 목록') throw new Error('manager global destinations exceed the existing permission projection');
          }
          await page.screenshot({ path: path.join(CAPTURE_DIR, `phone-global-menu-${role.toLowerCase()}.png`) });
        } finally {
          await page.close();
          await context.close();
        }
      }
    });

    // Phase H — role visibility from the real session only: anonymous
    // bounces to login, an unassigned staffer gets the fail message with no
    // event read, assigned staff reads without mutating, and the manager
    // keeps its assignment workflows. Nothing is invented: the server stays
    // the permission authority (403 contract unchanged).
    await check('roles/visibility', async () => {
      const anonCtx = await newContext({ viewport: { width: 1280, height: 900 } });
      const anonPage = await anonCtx.newPage();
      try {
        await anonPage.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await anonPage.waitForURL(/\/login/, { timeout: 15000 });
      } finally {
        await anonPage.close();
        await anonCtx.close();
      }
      const outsiderCtx = await newContext({ viewport: { width: 1280, height: 900 } });
      await outsiderCtx.addCookies([{
        name: 'etko_session', value: sessionValue(extended.outsiderCookie), httpOnly: true, sameSite: 'Lax', url: baseUrl,
      }]);
      const outsiderPage = await outsiderCtx.newPage();
      try {
        await outsiderPage.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await outsiderPage.getByText('행사를 찾을 수 없거나 접근 권한이 없습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        if (await outsiderPage.getByRole('link', { name: '파일로 등록' }).count()) {
          throw new Error('unassigned staff was offered the import action');
        }
      } finally {
        await outsiderPage.close();
        await outsiderCtx.close();
      }
      const staffCtx = await newContext({ viewport: { width: 1280, height: 900 } });
      const staffSession = sessionValue(fixture.staff.cookie);
      await staffCtx.addCookies([{ name: 'etko_session', value: staffSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const staffPage = await staffCtx.newPage();
      try {
        // Assigned staff reads participants but gets no write affordances:
        // the warning shows, the search stays, import and group writes do
        // not exist; write-only bulk-selection controls are absent too.
        await staffPage.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await staffPage.getByText('상태 변경 권한이 없습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        if (!await staffPage.locator('input[placeholder*="이름·소속·연락처 검색"]').count()) {
          throw new Error('assigned staff lost participant read access');
        }
        if (await staffPage.getByRole('link', { name: '파일로 등록' }).count()) {
          throw new Error('assigned staff was offered the import action');
        }
        if (await staffPage.getByRole('checkbox', { name: '통합 확정 미입장 선택' }).count()) {
          throw new Error('assigned staff was offered write-only bulk selection');
        }
        if (await staffPage.getByRole('button', { name: '그룹 지정' }).count()) {
          throw new Error('assigned staff was offered the group write');
        }
        // Operations console stays read-only: the reason shows and the
        // mutation buttons render disabled, never enabled.
        await staffPage.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/operations`, { waitUntil: 'networkidle', timeout: 30000 });
        await staffPage.getByText('현장 운영을 변경할 운영 권한이 없습니다.', { exact: false }).first().waitFor({ timeout: 15000 });
        const deskAdd = staffPage.getByRole('button', { name: '데스크 추가' });
        if (!await deskAdd.count()) throw new Error('operations desk section missing for staff read');
        if (await deskAdd.isEnabled()) throw new Error('operations mutation button enabled for staff');
        const deskTitle = await deskAdd.getAttribute('title');
        if (!deskTitle || !deskTitle.includes('현장 운영을 변경할 운영 권한이 없습니다')) {
          throw new Error(`desk action lacks the disabled reason (saw ${JSON.stringify(deskTitle)})`);
        }
      } finally {
        await staffPage.close();
        await staffCtx.close();
      }
      const managerCtx = await newContext({ viewport: { width: 1280, height: 900 } });
      const managerSession = sessionValue(fixture.manager.cookie);
      await managerCtx.addCookies([{ name: 'etko_session', value: managerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl }]);
      const managerPage = await managerCtx.newPage();
      try {
        await managerPage.goto(`${baseUrl}/console/events/${encodeURIComponent(eventId)}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await waitForMarker(managerPage, SCREENS.find((screen) => screen.key === 'participants').marker);
        if (!await managerPage.getByRole('link', { name: '파일로 등록' }).count()) {
          throw new Error('assigned manager lost the import action');
        }
      } finally {
        await managerPage.close();
        await managerCtx.close();
      }
    });
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close().catch((error) => failures.push(`fixture cleanup: ${error.message}`));
    fs.writeFileSync(path.join(CAPTURE_DIR, 'verification.json'), JSON.stringify({
      at: new Date().toISOString(), buildId: fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim(),
      viewports: VIEWPORTS, phases, failures, moderate,
    }, null, 2));
  }

  for (const line of moderate) process.stdout.write(`[console-audit] moderate: ${line}\n`);
  if (failures.length) {
    for (const line of failures) process.stderr.write(`[console-audit] FAIL: ${line}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('[console-audit] console unification outcomes hold across 16 menus\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[console-audit] failed: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { SCREENS, CAPTURE_DIR };
