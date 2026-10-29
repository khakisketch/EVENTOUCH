'use strict';

// Permanent browser regression helper: long-list boundaries for the three
// console workspaces that page incrementally (photos 12/step, messages
// 10/step, programs 12/step). Owned by a subagent; the parent
// (scripts/web-console-audit.cjs) owns the fixture, browser, build and every
// other phase. This module owns NOTHING else.
//
// Call order (parent guarantees): AFTER theme/save-conflict-publish, BEFORE
// Phase F (report/checkin/stage transitions), so the event is LIVE with every
// approved feature ON. Reads the live paging windows from the DOM — never
// hard-codes them — and expands each list to its documented end with real
// keyboard activation (focus + Enter), asserting row counts AND focus
// placement on every expansion, including the final one where the more button
// detaches.
//
// Seeding posture (honest fixture data, never real content):
// - Photos: 25 synthetic 1x1 PNG buffers (identical bytes, unique filenames)
//   uploaded through the real operator REST
//   (POST /api/events/:id/files, cookie session) then recorded through the
//   real event command (evidence.photo.add). NOT real field photos.
// - Messages: 25+ campaigns through the real message.create command with
//   simulate:true and no scheduled time, so every status is SIMULATED and
//   zero bytes reach a provider. NOT real deliveries.
// - Programs: real module.save commands (poll with two options) plus one
//   real UI dialog creation for the 13th. NOT curated content.
// - No SQL seeding anywhere in this file. No route interception, no fake
//   200/409, no SKIP, no silent catch, no optional pass: every failed
//   assertion throws inside the parent's check() so the phase fails.
//
// What this module never does (parent owns these): launch/close the browser,
// close the fixture, read process.env, touch provider keys, or run other
// audits. Contexts created here are always closed in finally.
//
// Selectors mirror the shipped workspaces (not shared imports, so UI drift
// fails loudly like the parent):
// - photos:   #evidence-photo-sections, desktop category buttons
//             (role=group "현장 사진 구간 선택", aria-pressed, name
//             "<label> <count>장" — the #evidence-photo-section select is
//             mobile-only and MUST NOT be driven on desktop),
//             li#evidence-photo-<id>[tabIndex=-1], button "더 보기 (N)"
// - messages: #history-heading, [data-history-row]#campaign-<id>,
//             #campaign-history-more "이전 발송 더 보기 (N)"
// - programs: button "프로그램 만들기", #program-title, #program-type,
//             #program-options, dialog submit "만들기",
//             h2#module-title-<id>[tabIndex=-1], button "더 보기 (N)"

const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, ensureCaptureDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const path = require('node:path');

const DEFAULT_CAPTURE_DIR = defaultCaptureDir(`console-unification-fallback-${runStamp()}`);
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };
const GOTO_TIMEOUT = 30000;
const UI_TIMEOUT = 15000;

const PHASE_PHOTOS = 'boundaries/photos-long-list';
const PHASE_MESSAGES = 'boundaries/messages-long-history';
const PHASE_PROGRAMS = 'boundaries/programs-long-list';

// A real 1x1 transparent PNG (70 bytes, valid IHDR: server inspectImage
// requires width/height >= 1). Identical bytes every upload; filenames stay
// unique so each upload binds its own idempotency receipt.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function tinyPngBuffer() {
  return Buffer.from(TINY_PNG_BASE64, 'base64');
}

function commandId(prefix) {
  if (typeof crypto.randomUUID === 'function') return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function eventPath(eventId, suffix) {
  return `/console/events/${encodeURIComponent(eventId)}${suffix}`;
}

// Bootstrap read through the parent's real helper. Any non-200 fails with
// the status: there is no "empty is fine" path.
async function readState(helpers, baseUrl, cookie) {
  const response = await helpers.requestJson(baseUrl, '/api/bootstrap', { cookie });
  if (response.status !== 200) {
    throw new Error(`seed bootstrap: ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json.state;
}

// Event-command write through the real command path with a fresh receipt id.
// Any non-2xx fails naming the command and status: 409s are reported, never
// faked or swallowed.
async function apiCommand(helpers, baseUrl, cookie, eventId, command, payload) {
  const response = await helpers.requestJson(baseUrl, `/api/events/${eventId}/commands`, {
    method: 'POST',
    cookie,
    body: { commandId: commandId('boundary'), command, payload },
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`seed ${command}: ${response.status} ${JSON.stringify(response.json)}`);
  }
  return response.json;
}

// Operator byte upload through the existing REST endpoint (the same endpoint
// EvidencePhotosWorkspace uses). Cookie session => created_by is the operator
// account, which is what evidence.photo.add requires. Non-2xx fails loudly
// with the status so the parent sees the actual blocker.
async function uploadOperatorFile({ baseUrl, eventId, cookie, name, buffer }) {
  const url =
    `${baseUrl}/api/events/${encodeURIComponent(eventId)}/files` +
    `?name=${encodeURIComponent(name)}&commandId=${encodeURIComponent(commandId('boundary-upload'))}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { cookie, 'content-type': 'image/png' },
    body: buffer,
  });
  const json = await response.json().catch(() => null);
  const file = json && json.file;
  if (!response.ok || !file || typeof file.fileId !== 'string') {
    throw new Error(`seed file upload: ${response.status} ${JSON.stringify(json)}`);
  }
  return file;
}

function remainingCount(buttonText, label) {
  const match = /\(\s*(\d+)\s*\)/.exec(String(buttonText));
  if (!match) throw new Error(`${label}: more-button count unreadable in ${JSON.stringify(buttonText)}`);
  return Number(match[1]);
}

async function activeElementId(page) {
  return page.evaluate(() => (document.activeElement && document.activeElement.id) || '');
}

async function waitForCount(page, selector, wanted) {
  await page.waitForFunction(
    (args) => document.querySelectorAll(args.selector).length === args.wanted,
    { selector, wanted },
    { timeout: UI_TIMEOUT },
  );
}

async function waitForCountAbove(page, selector, prev) {
  await page.waitForFunction(
    (args) => document.querySelectorAll(args.selector).length > args.prev,
    { selector, prev },
    { timeout: UI_TIMEOUT },
  );
}

// Keyboard-activate a more button and return the fresh ordered row/head ids.
// Focus + Enter is the contract: a click() would pass even if keyboard focus
// handling regressed.
async function keyboardExpand(page, moreButton) {
  await moreButton.focus();
  await page.keyboard.press('Enter');
}

async function waitForFocus(page, expectedId, label) {
  // Row counts can settle before the reveal/focus effect runs: bound the
  // focus arrival itself, then assert. A bare read here would race the
  // effect and flake.
  await page.waitForFunction(
    (id) => Boolean(document.activeElement) && document.activeElement.id === id,
    expectedId,
    { timeout: UI_TIMEOUT },
  ).catch(() => {
    throw new Error(`${label}: focus did not arrive at #${expectedId} within bounds; focus not confirmed`);
  });
}

function assertFocus(focusedId, expectedId, label) {
  if (focusedId !== expectedId) {
    throw new Error(
      `${label}: focus landed on #${focusedId || '(none)'}; expected #${expectedId}; focus not confirmed`,
    );
  }
}

async function confirmFocus(page, expectedId, label) {
  await waitForFocus(page, expectedId, label);
  assertFocus(await activeElementId(page), expectedId, label);
}

async function openOwnerPage({ newContext, baseUrl, ownerSession, url }) {
  const context = await newContext({ viewport: DESKTOP_VIEWPORT });
  try {
    await context.addCookies([{
      name: 'etko_session', value: ownerSession, httpOnly: true, sameSite: 'Lax', url: baseUrl,
    }]);
    const page = await context.newPage();
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: GOTO_TIMEOUT });
      return { context, page };
    } catch (error) {
      await page.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    await context.close().catch(() => {});
    throw error;
  }
}

async function closeOwnerPage(context, page) {
  if (page) await page.close().catch(() => {});
  if (context) await context.close().catch(() => {});
}

async function saveShot(page, captureDir, name) {
  ensureCaptureDir(captureDir);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(captureDir, name), fullPage: true });
}

async function photosPhase({ fixture, ownerCookie, baseUrl, eventId, ownerSession, newContext, captureDir, stamp }) {
  const { helpers } = fixture;
  const section = 'SPACE';
  const target = 25;
  const png = tinyPngBuffer();

  let state = await readState(helpers, baseUrl, ownerCookie);
  const before = (state.workspaces[eventId].evidencePhotos || []).filter((photo) => photo.section === section).length;
  if (before !== 0) {
    throw new Error(`photos: fresh SPACE section holds ${before} photos; refusing to assert boundaries on pre-seeded data`);
  }
  for (let index = 1; index <= target; index += 1) {
    const file = await uploadOperatorFile({
      baseUrl,
      eventId,
      cookie: ownerCookie,
      name: `경계-사진-${stamp}-${String(index).padStart(2, '0')}.png`,
      buffer: png,
    });
    const recorded = await apiCommand(helpers, baseUrl, ownerCookie, eventId, 'evidence.photo.add', {
      section,
      image: { fileId: file.fileId, name: file.name, type: file.type, size: file.size },
    });
    if (!recorded.photo || typeof recorded.photo.id !== 'string') {
      throw new Error(`photos: evidence.photo.add #${index} returned no photo record`);
    }
  }
  state = await readState(helpers, baseUrl, ownerCookie);
  const serverCount = (state.workspaces[eventId].evidencePhotos || []).filter((photo) => photo.section === section).length;
  if (serverCount !== target) {
    throw new Error(`photos: server holds ${serverCount} SPACE photos, expected ${target}`);
  }

  let context = null;
  let page = null;
  try {
    ({ context, page } = await openOwnerPage({
      newContext,
      baseUrl,
      ownerSession,
      url: `${baseUrl}${eventPath(eventId, '/photos')}`,
    }));
    await page.locator('#evidence-photo-sections').first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await page.waitForTimeout(800);
    // Desktop drives the category buttons, NOT the mobile-only
    // #evidence-photo-section select (hidden on desktop: driving it would
    // only time out or force a hidden element). Fresh loads default to SPACE;
    // prove it via the pressed button's accessible name, which also carries
    // the rendered section count ("공간구성 25장").
    const spaceButton = page.getByRole('button', { name: /공간구성\s*25장/ });
    await spaceButton.first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    if ((await spaceButton.first().getAttribute('aria-pressed')) !== 'true') {
      await spaceButton.first().click();
      await page.waitForFunction(
        () => {
          const pressed = document.querySelector('button[aria-pressed="true"]');
          return Boolean(pressed) && /공간구성/.test(pressed.textContent || '');
        },
        null,
        { timeout: UI_TIMEOUT },
      );
    }

    const rowSelector = 'li[id^="evidence-photo-"]';
    let ids = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), rowSelector);
    if (ids.length === 0) {
      throw new Error('photos: empty list rendered; refusing to claim more-expansion verified');
    }
    if (ids.length !== 12) {
      throw new Error(`photos: initial window shows ${ids.length} rows, expected 12 (server ${serverCount})`);
    }
    const more = page.getByRole('button', { name: /^더 보기/ });
    if ((await more.count()) !== 1) throw new Error('photos: more button missing on the first page');
    const firstRemaining = remainingCount(await more.first().innerText(), 'photos');
    if (ids.length + firstRemaining !== serverCount) {
      throw new Error(`photos: ${ids.length} shown + ${firstRemaining} remaining != server ${serverCount}`);
    }

    // First expansion: 12 -> 24. Focus must land on the first NEW row.
    await keyboardExpand(page, more.first());
    await waitForCount(page, rowSelector, 24);
    ids = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), rowSelector);
    await confirmFocus(page, ids[12], 'photos/first-expansion');
    if (remainingCount(await more.first().innerText(), 'photos') !== 1) {
      throw new Error('photos: intermediate more button does not report exactly 1 remaining');
    }

    // Final expansion: 24 -> 25. The button detaches; focus must still land
    // on the first NEW row (the regression this phase exists for).
    await keyboardExpand(page, more.first());
    await waitForCount(page, rowSelector, 25);
    ids = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), rowSelector);
    await confirmFocus(page, ids[24], 'photos/final-expansion');
    if ((await more.count()) !== 0) {
      throw new Error('photos: more button still present after the final reveal');
    }

    state = await readState(helpers, baseUrl, ownerCookie);
    const finalServer = (state.workspaces[eventId].evidencePhotos || []).filter((photo) => photo.section === section).length;
    if (finalServer !== target || ids.length !== target) {
      throw new Error(`photos: server ${finalServer} vs rendered ${ids.length}, expected ${target}`);
    }
    await saveShot(page, captureDir, 'long-photos.png');
  } finally {
    await closeOwnerPage(context, page);
  }
  return { section, target, rendered: target };
}

async function messagesPhase({ fixture, ownerCookie, baseUrl, eventId, ownerSession, newContext, captureDir, stamp }) {
  const { helpers } = fixture;
  const minTotal = 25;

  let state = await readState(helpers, baseUrl, ownerCookie);
  const approved = (state.workspaces[eventId].participants || []).find((person) => person.status === 'APPROVED');
  if (!approved) throw new Error('messages: no APPROVED participant to target simulated campaigns at');
  const have = (state.workspaces[eventId].messages || []).length;
  for (let index = 0; index < Math.max(0, minTotal - have); index += 1) {
    const created = await apiCommand(helpers, baseUrl, ownerCookie, eventId, 'message.create', {
      ids: [approved.id],
      title: `경계 발송 ${stamp}-${String(index + 1).padStart(2, '0')}`,
      channel: 'SMS',
      body: '경계 검증 안내입니다. 모의 발송이므로 전달되지 않습니다.',
      simulate: true,
    });
    if (!created.message || created.message.status !== 'SIMULATED') {
      throw new Error(`messages: message.create #${index + 1} did not return SIMULATED (${JSON.stringify(created.message && created.message.status)})`);
    }
  }
  state = await readState(helpers, baseUrl, ownerCookie);
  const total = (state.workspaces[eventId].messages || []).length;
  if (total < minTotal) throw new Error(`messages: server holds ${total} campaigns, expected at least ${minTotal}`);
  const nonSimulated = (state.workspaces[eventId].messages || []).filter((message) => message.status !== 'SIMULATED');
  if (nonSimulated.length) {
    throw new Error(`messages: ${nonSimulated.length} non-SIMULATED campaigns present; refusing to claim mock-only history`);
  }

  let context = null;
  let page = null;
  let expansions = 0;
  try {
    ({ context, page } = await openOwnerPage({
      newContext,
      baseUrl,
      ownerSession,
      url: `${baseUrl}${eventPath(eventId, '/messages')}`,
    }));
    await page.locator('#history-heading').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await page.locator('summary', { hasText: '기록 목록 접기' }).waitFor();

    const rowSelector = '[data-history-row]';
    let ids = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), rowSelector);
    if (ids.length === 0) {
      throw new Error('messages: empty history rendered; refusing to claim more-expansion verified');
    }
    const more = page.locator('#campaign-history-more');
    if ((await more.count()) !== 1) throw new Error('messages: history more button missing on the first page');
    const firstRemaining = remainingCount(await more.first().innerText(), 'messages');
    if (ids.length + firstRemaining !== total) {
      throw new Error(`messages: ${ids.length} shown + ${firstRemaining} remaining != server ${total}`);
    }

    // Expand to exhaustion with the keyboard. Every expansion — middle ones
    // and the final detaching one — must focus the first newly revealed row.
    for (;;) {
      if ((await more.count()) === 0) break;
      if (expansions > 6) throw new Error('messages: history more button did not exhaust after 6 expansions');
      const prev = ids.length;
      await keyboardExpand(page, more.first());
      await waitForCountAbove(page, rowSelector, prev);
      ids = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), rowSelector);
      expansions += 1;
      await confirmFocus(page, ids[prev], `messages/expansion-${expansions}`);
    }
    if (expansions < 1) throw new Error('messages: history never expanded');
    if (ids.length !== total) {
      throw new Error(`messages: rendered ${ids.length} rows, server holds ${total}`);
    }
    if ((await more.count()) !== 0) {
      throw new Error('messages: history more button still present after the final reveal');
    }
    await saveShot(page, captureDir, 'long-messages.png');
  } finally {
    await closeOwnerPage(context, page);
  }
  return { total, expansions };
}

async function programsPhase({ fixture, ownerCookie, baseUrl, eventId, ownerSession, newContext, captureDir, stamp }) {
  const { helpers } = fixture;
  const fill = 12;
  const createdTotal = 13;
  const target = 25;

  const pollSeed = (index) => apiCommand(helpers, baseUrl, ownerCookie, eventId, 'module.save', {
    type: 'poll',
    title: `경계 프로그램 ${stamp}-${String(index).padStart(2, '0')}`,
    options: ['찬성', '반대'],
  });

  let state = await readState(helpers, baseUrl, ownerCookie);
  const precount = (state.workspaces[eventId].modules || []).length;
  if (precount > fill) {
    throw new Error(`programs: fresh fixture holds ${precount} modules (>${fill}); cannot establish the 12->13 boundary`);
  }
  for (let index = 1; index <= fill - precount; index += 1) {
    await pollSeed(index);
  }
  state = await readState(helpers, baseUrl, ownerCookie);
  if ((state.workspaces[eventId].modules || []).length !== fill) {
    throw new Error(`programs: server holds ${(state.workspaces[eventId].modules || []).length} modules, expected ${fill} before UI creation`);
  }

  const headingSelector = 'h2[id^="module-title-"]';
  let context = null;
  let page = null;
  try {
    ({ context, page } = await openOwnerPage({
      newContext,
      baseUrl,
      ownerSession,
      url: `${baseUrl}${eventPath(eventId, '/programs')}`,
    }));
    await page.getByRole('button', { name: '프로그램 만들기' }).first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await page.waitForTimeout(800);

    let headings = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), headingSelector);
    if (headings.length !== fill) {
      throw new Error(`programs: initial window shows ${headings.length} cards, expected ${fill}`);
    }
    if ((await page.getByRole('button', { name: /^더 보기/ }).count()) !== 0) {
      throw new Error('programs: more button present at exactly 12 modules');
    }

    // The 13th via the real creation dialog: typed title + poll options.
    const title13 = `경계 생성 ${stamp}`;
    await page.getByRole('button', { name: '프로그램 만들기' }).first().click();
    await page.locator('#program-title').waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await page.locator('#program-title').fill(title13);
    await page.locator('#program-options').fill('찬성\n반대');
    await page.getByRole('button', { name: '만들기', exact: true }).click();
    await page.locator('#program-title').waitFor({ state: 'detached', timeout: UI_TIMEOUT });
    await page.waitForFunction(
      (args) => [...document.querySelectorAll(args.selector)].some((node) => (node.textContent || '').trim() === args.title),
      { selector: headingSelector, title: title13 },
      { timeout: UI_TIMEOUT },
    );
    headings = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), headingSelector);
    if (headings.length !== createdTotal) {
      throw new Error(`programs: ${headings.length} cards after UI creation, expected ${createdTotal}`);
    }
    const createdId = await page.evaluate(
      (args) => {
        const found = [...document.querySelectorAll(args.selector)].find((node) => (node.textContent || '').trim() === args.title);
        return found ? found.id : '';
      },
      { selector: headingSelector, title: title13 },
    );
    if (!createdId) throw new Error('programs: created heading id not found in the DOM');
    await confirmFocus(page, createdId, 'programs/create-13th');
    state = await readState(helpers, baseUrl, ownerCookie);
    if ((state.workspaces[eventId].modules || []).length !== createdTotal) {
      throw new Error('programs: server did not persist the UI-created 13th module');
    }
    await saveShot(page, captureDir, 'long-programs-create.png');

    // Top up to 25 through commands, reload to the first page, expand 12 ->
    // 24 -> 25 with the keyboard, asserting first-new focus both times.
    for (let index = 1; index <= target - createdTotal; index += 1) {
      await pollSeed(fill + index);
    }
    state = await readState(helpers, baseUrl, ownerCookie);
    if ((state.workspaces[eventId].modules || []).length !== target) {
      throw new Error(`programs: server holds ${(state.workspaces[eventId].modules || []).length} modules, expected ${target}`);
    }
    await page.reload({ waitUntil: 'networkidle', timeout: GOTO_TIMEOUT });
    await page.getByRole('button', { name: '프로그램 만들기' }).first().waitFor({ state: 'visible', timeout: UI_TIMEOUT });
    await page.waitForTimeout(800);

    headings = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), headingSelector);
    if (headings.length !== 12) {
      throw new Error(`programs: reloaded first page shows ${headings.length} cards, expected 12`);
    }
    const more = page.getByRole('button', { name: /^더 보기/ });
    if ((await more.count()) !== 1) throw new Error('programs: more button missing at 12/25');
    if (remainingCount(await more.first().innerText(), 'programs') !== 13) {
      throw new Error('programs: reloaded more button does not report 13 remaining');
    }

    await keyboardExpand(page, more.first());
    await waitForCount(page, headingSelector, 24);
    headings = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), headingSelector);
    await confirmFocus(page, headings[12], 'programs/first-expansion');

    await keyboardExpand(page, more.first());
    await waitForCount(page, headingSelector, 25);
    headings = await page.evaluate((selector) => [...document.querySelectorAll(selector)].map((node) => node.id), headingSelector);
    await confirmFocus(page, headings[24], 'programs/final-expansion');
    if ((await more.count()) !== 0) {
      throw new Error('programs: more button still present after the final reveal');
    }
    await saveShot(page, captureDir, 'long-programs.png');
  } finally {
    await closeOwnerPage(context, page);
  }
  return { fill, createdTotal, target };
}

// Parent entry point. Runs AFTER theme/save-conflict-publish (event LIVE,
// all features ON) and BEFORE Phase F. Each phase owns one isolated
// 1280x900 context, uses the keyboard throughout, and fails on ANY failure
// via the parent's check() — no SKIP, no silent catch, no optional pass.
async function auditLongListBoundaries({
  fixture,
  extended,
  baseUrl,
  eventId,
  ownerSession,
  newContext,
  check,
  captureDir,
}) {
  if (!fixture || !fixture.helpers) throw new Error('boundaries: fixture.helpers missing');
  if (!extended || typeof extended.ownerCookie !== 'string') throw new Error('boundaries: extended.ownerCookie missing');
  if (typeof baseUrl !== 'string' || !baseUrl) throw new Error('boundaries: baseUrl missing');
  if (typeof eventId !== 'string' || !eventId) throw new Error('boundaries: eventId missing');
  if (typeof ownerSession !== 'string' || !ownerSession) throw new Error('boundaries: ownerSession missing');
  if (typeof newContext !== 'function') throw new Error('boundaries: newContext missing');
  if (typeof check !== 'function') throw new Error('boundaries: check missing');
  const root = captureDir || DEFAULT_CAPTURE_DIR;
  if (!captureDir) prepareCaptureDir(root);
  // The supplied directory belongs to the caller. Claim a fresh namespace
  // for this invocation rather than replacing same-named caller evidence.
  const captures = prepareCaptureDir(path.join(root, 'long-list-boundaries'));
  const ownerCookie = extended.ownerCookie;
  const stamp = Date.now();
  const shared = { fixture, ownerCookie, baseUrl, eventId, ownerSession, newContext, captureDir: captures, stamp };

  await check(PHASE_PHOTOS, () => photosPhase(shared));
  await check(PHASE_MESSAGES, () => messagesPhase(shared));
  await check(PHASE_PROGRAMS, () => programsPhase(shared));

  return {
    // Exact call API the parent wires: call this AFTER theme/save-conflict-
    // publish and BEFORE Phase F (report/checkin/stage transitions).
    call: 'auditLongListBoundaries({ fixture, extended, baseUrl, eventId, ownerSession, newContext, check, captureDir })',
    phases: [PHASE_PHOTOS, PHASE_MESSAGES, PHASE_PROGRAMS],
    expected: {
      photos: { section: 'SPACE', target: 25, firstPage: 12, reveals: [12, 24, 25], capture: 'long-photos.png' },
      messages: { minTotal: 25, allStatuses: ['SIMULATED'], capture: 'long-messages.png' },
      programs: { fill: 12, uiCreated: 13, target: 25, firstPage: 12, reveals: [12, 24, 25], capture: 'long-programs.png' },
    },
    captures: [
      path.join(captures, 'long-photos.png'),
      path.join(captures, 'long-messages.png'),
      path.join(captures, 'long-programs-create.png'),
      path.join(captures, 'long-programs.png'),
    ],
    seeds: {
      synthetic: true,
      note: 'Captures show synthetic fixture rows, not real photos or real deliveries: '
        + '1x1 PNG buffers with unique filenames, SIMULATED-only campaigns, generated poll titles.',
    },
    constraints: [
      'Event must be LIVE with all approved features ON (parent call order guarantees this).',
      'Desktop 1280x900 keyboard contract only; mobile re-check intentionally out of scope here '
        + '(parent phone-composition phases own mobile layout).',
      'Fresh SPACE photo section required (0 rows); module precount must be <= 12.',
      'Exactly one APPROVED participant must exist for simulated campaign targets.',
    ],
  };
}

module.exports = {
  auditLongListBoundaries,
  PHASES: [PHASE_PHOTOS, PHASE_MESSAGES, PHASE_PROGRAMS],
  DEFAULT_CAPTURE_DIR,
};
