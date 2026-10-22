'use strict';

// Real browser / real API / isolated PostgreSQL. Only network response loss
// is injected; no successful API data is fabricated and no message is sent.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
process.env.TMPDIR = '/tmp/opencode';
process.env.EVENTOUCH_SMS_MOCK = '1';
delete process.env.SOLAPI_API_KEY;
delete process.env.SOLAPI_API_SECRET;
const { chromium } = require('playwright');
const XLSX = require('../apps/web/node_modules/xlsx');
const jsQR = require('../apps/web/node_modules/jsqr');
const axeSource = require('axe-core').source;
const { emptyWorkspace } = require('../server/state');
const { buildMessageDispatch } = require('../server/commands/content-results');
const { startApiHarness, insertAccount, insertEvent, insertMembership, insertAssignment, sessionCookie, requestJson } = require('../tests/helpers/postgres-api-server.cjs');
const { startWebApiGateway } = require('../tests/helpers/web-api-gateway.cjs');

const captures = '/tmp/opencode/eventouch-captures/hanwool-real';
const webBase = process.env.WEB_BASE || 'http://127.0.0.1:8777';
let phase = 'setup';

function matchesCommand(response, command) {
  if (!response.url().includes('/commands') || response.request().method() !== 'POST') return false;
  try { return response.request().postDataJSON().command === command; } catch { return false; }
}

async function clickCommand(page, button, command) {
  const pending = page.waitForResponse((response) => matchesCommand(response, command), { timeout: 15000 });
  pending.catch(() => {}); // Keep an actionability failure from masking its own error during teardown.
  await button.click();
  const response = await pending;
  const data = await response.json();
  assert.ok(response.ok(), `${command}: ${response.status()} ${JSON.stringify(data)}`);
  await page.waitForLoadState('networkidle');
  return data;
}

function participantWorkbook() {
  const rows = [['이름', '연락처', '소속']];
  for (let index = 1; index <= 8; index += 1) rows.push([`검증 참가자 ${index}`, `010000000${String(index).padStart(2, '0')}`, `검증 업체 ${(index - 1) % 4 + 1}`]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), '참가자');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
}

async function decodeRenderedTicket(page) {
  const pixels = await page.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ }).locator('svg').evaluate(async (svg) => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 360;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 360, 360);
    context.drawImage(image, 24, 24, 312, 312);
    return Array.from(context.getImageData(0, 0, 360, 360).data);
  });
  const decoded = jsQR(Uint8ClampedArray.from(pixels), 360, 360);
  assert.ok(decoded, 'the rendered admission QR must be software-decodable');
  return decoded.data;
}

async function main() {
  fs.mkdirSync(captures, { recursive: true });
  const oldOrigin = process.env.EVENTOUCH_PUBLIC_URL;
  let harness, gateway, browser;
  let fixtureEventId;
  const pages = [];
  try {
    harness = await startApiHarness();
    const suffix = crypto.randomUUID().replace(/-/g, '');
    const eventId = `browser-hanwool-${suffix}`;
    fixtureEventId = eventId;
    const slug = eventId;
    const managerId = `browser-manager-${suffix}`;
    const staffId = `browser-staff-${suffix}`;
    const event = { id: eventId, slug, name: '실제 연동 검증 행사', date: '2027-01-16', start: '09:00', end: '17:00', capacity: 100, stage: 'LIVE', features: ['draw', 'poll', 'reward', 'screen', 'venue'] };
    await insertAccount(harness.database, { id: managerId, role: 'MANAGER', name: '검증 운영자', email: `${managerId}@example.test` });
    await insertAccount(harness.database, { id: staffId, role: 'STAFF', name: '검증 스태프', email: `${staffId}@example.test` });
    await insertEvent(harness.database, { id: eventId, slug, payload: event, workspace: emptyWorkspace() });
    await insertMembership(harness.database, managerId, eventId, ['all']);
    const managerCookie = await sessionCookie(harness, managerId);
    const staffCookie = await sessionCookie(harness, staffId);
    const command = async (name, payload, options = {}) => {
      const response = await requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
        method: 'POST', cookie: Object.hasOwn(options, 'cookie') ? options.cookie : managerCookie, bearer: options.bearer,
        body: { commandId: `browser-${crypto.randomUUID()}`, command: name, payload, ...(options.assignmentId ? { assignmentId: options.assignmentId } : {}) },
      });
      assert.ok(response.status >= 200 && response.status < 300, `${name}: ${response.status} ${JSON.stringify(response.json)}`);
      return response.json;
    };
    const read = async () => (await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [eventId])).rows[0].payload;
    const inDesk = (await command('desk.save', { name: '검증 입장 데스크', action: 'IN', mode: 'desk', open: true })).desk;
    const outDesk = (await command('desk.save', { name: '검증 퇴장 데스크', action: 'OUT', mode: 'desk', open: true })).desk;
    const inAssignment = `browser-in-${suffix}`, outAssignment = `browser-out-${suffix}`;
    await insertAssignment(harness.database, { id: inAssignment, accountId: staffId, eventId, type: 'DESK', targetId: inDesk.id });
    await insertAssignment(harness.database, { id: outAssignment, accountId: staffId, eventId, type: 'DESK', targetId: outDesk.id });
    gateway = await startWebApiGateway({ apiBase: harness.baseUrl, webBase, loseFirstResponseFor: ['draw.program.run', 'reward.collect'] });
    process.env.EVENTOUCH_PUBLIC_URL = gateway.baseUrl;
    browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {});
    const errors = [];
    const newPage = async (context) => {
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', (error) => errors.push(error.message));
      page.on('dialog', (dialog) => dialog.accept());
      return page;
    };
    const authenticated = async (cookie, viewport) => {
      const context = await browser.newContext({ viewport });
      await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: gateway.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
      return context;
    };
    const operator = await newPage(await authenticated(managerCookie, { width: 1440, height: 1000 }));
    const staff = await newPage(await authenticated(staffCookie, { width: 390, height: 844 }));

    phase = 'UI Excel import';
    await operator.goto(`${gateway.baseUrl}/console/events/${eventId}/participants/import`, { waitUntil: 'networkidle' });
    await operator.locator('input[type=file]').setInputFiles({ name: '검증참가자.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: participantWorkbook() });
    await operator.getByText(/유효 8행 · 오류 0행/).waitFor();
    await clickCommand(operator, operator.getByRole('button', { name: '유효 행 반영', exact: true }), 'participant.import');
    let workspace = await read();
    assert.equal(workspace.participants.length, 8);
    const people = workspace.participants;

    phase = 'UI teams, exact ballot and lucky preassignment';
    await operator.goto(`${gateway.baseUrl}/console/events/${eventId}/draws`, { waitUntil: 'networkidle' });
    for (let index = 1; index <= 20; index += 1) {
      await operator.locator('#draws-team-name').fill(`검증팀 ${String(index).padStart(2, '0')}`);
      await clickCommand(operator, operator.getByRole('button', { name: '팀 등록', exact: true }), 'team.save');
    }
    await operator.locator('#vote-pick-count').fill('5');
    await operator.locator('#vote-status').selectOption('CLOSED');
    await clickCommand(operator, operator.getByRole('button', { name: '투표 설정 저장', exact: true }), 'vote.config.save');
    await operator.locator('#lucky-min').fill('1'); await operator.locator('#lucky-max').fill('900');
    await clickCommand(operator, operator.getByRole('button', { name: '번호 범위 저장', exact: true }), 'lucky.config.save');
    await operator.getByRole('checkbox', { name: /승인 참가자 전체 8명 선택/ }).check();
    await clickCommand(operator, operator.getByRole('button', { name: '8명 번호 일괄 배정', exact: true }), 'lucky.preassign');
    workspace = await read();
    assert.equal(workspace.luckyNumbers.length, 8);
    assert.equal(new Set(workspace.luckyNumbers.map((item) => item.number)).size, 8);
    assert.ok(workspace.luckyNumbers.every((item) => item.number >= 1 && item.number <= 900));

    phase = 'UI simulated invitation and real personalized entry';
    await operator.goto(`${gateway.baseUrl}/console/events/${eventId}/messages`, { waitUntil: 'networkidle' });
    await operator.locator('#campaign-title').fill('검증 초대');
    await operator.locator('#campaign-body').fill('{{이름}}님, 럭키번호 {{럭키번호}} / {{티켓링크}}');
    await operator.getByRole('button', { name: '표시된 대상 추가 선택', exact: true }).click();
    await operator.getByRole('checkbox', { name: /모의 발송으로 기록/ }).check();
    await clickCommand(operator, operator.getByRole('button', { name: '모의 발송 기록', exact: true }), 'message.create');
    workspace = await read();
    const invitation = workspace.messages.find((message) => message.title === '검증 초대');
    assert.equal(invitation.status, 'SIMULATED'); assert.equal(invitation.simulate, true);
    const dispatch = buildMessageDispatch(event, workspace, invitation);
    assert.equal(dispatch.recipients.length, 8);
    assert.equal(new Set(dispatch.recipients.map((recipient) => recipient.variables.티켓링크)).size, 8);
    const variables = dispatch.recipients.find((recipient) => recipient.participantId === people[0].id).variables;
    assert.ok(variables.럭키번호);
    const entry = new URL(variables.티켓링크);
    assert.equal(entry.origin, gateway.baseUrl); assert.equal(entry.searchParams.get('ticket'), people[0].ticket);
    const mobile = await newPage(await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference' }));
    await mobile.goto(entry.href, { waitUntil: 'networkidle' });
    await mobile.getByRole('button', { name: '모바일 티켓', exact: true }).waitFor();
    assert.equal(new URL(mobile.url()).searchParams.has('ticket'), false);
    assert.equal(await mobile.evaluate((token) => Object.values(localStorage).some((value) => value.includes(token)), people[0].ticket), false);
    await mobile.screenshot({ path: path.join(captures, 'home-390.png'), fullPage: true });
    await mobile.getByRole('button', { name: '모바일 티켓', exact: true }).click();
    const decodedTicket = await decodeRenderedTicket(mobile);
    assert.equal(decodedTicket, people[0].ticket);

    phase = 'real staff admission with displayed QR';
    await staff.goto(`${gateway.baseUrl}/staff/events/${eventId}`, { waitUntil: 'networkidle' });
    await staff.locator('#staff-desk').selectOption(inDesk.id);
    await staff.locator('#staff-ticket').fill(decodedTicket);
    await clickCommand(staff, staff.getByRole('button', { name: /체크인|입장 처리/, exact: false }).first(), 'check.scan');
    workspace = await read(); assert.equal(workspace.participants[0].everIn, true);
    assert.ok(workspace.checks.find((check) => check.participantId === people[0].id && check.action === 'IN' && check.at));

    phase = 'live exact 5-of-20 ballot and retained choices';
    await mobile.getByRole('button', { name: '참가 메뉴', exact: true }).click();
    await mobile.getByRole('button', { name: '순위 투표', exact: true }).click();
    await operator.goto(`${gateway.baseUrl}/console/events/${eventId}/draws`, { waitUntil: 'networkidle' });
    await operator.locator('#vote-status').selectOption('OPEN');
    await clickCommand(operator, operator.getByRole('button', { name: '투표 설정 저장', exact: true }), 'vote.config.save');
    const choice = (index) => mobile.getByRole('button', { name: `검증팀 ${String(index).padStart(2, '0')} 선택`, exact: true });
    await choice(1).click(); await choice(2).click();
    for (let index = 0; index < 2; index += 1) await mobile.waitForResponse((response) => response.url().endsWith(`/api/public/events/${slug}/ticket`) && response.ok(), { timeout: 10000 });
    assert.equal(await choice(1).getAttribute('aria-pressed'), 'true');
    assert.equal(await choice(2).getAttribute('aria-pressed'), 'true');
    for (let index = 3; index <= 5; index += 1) await choice(index).click();
    await choice(6).click(); assert.equal(await choice(6).getAttribute('aria-pressed'), 'false');
    await clickCommand(mobile, mobile.getByRole('button', { name: '투표 제출', exact: true }), 'vote.ranked');
    await mobile.getByText('투표가 접수되었습니다.', { exact: true }).waitFor();
    workspace = await read(); assert.equal(workspace.votes.length, 1); assert.equal(workspace.votes[0].picks.length, 5);
    const publicBefore = await requestJson(harness.baseUrl, `/api/public/events/${slug}/ticket`, { bearer: people[0].ticket });
    assert.deepEqual(publicBefore.json.workspace.voteCounts, {});
    const teams = [...workspace.teams].sort((a, b) => a.order - b.order);
    const additional = [[1, 2, 3, 6, 7], [1, 2, 3, 8, 9], [1, 2, 4, 10, 11], [1, 3, 12, 13, 14], [1, 2, 5, 15, 16]];
    for (let index = 0; index < additional.length; index += 1) await command('vote.ranked', { picks: additional[index].map((number) => ({ teamId: teams[number - 1].id })) }, { cookie: null, bearer: people[index + 1].ticket });
    await operator.locator('#vote-status').selectOption('CLOSED');
    await operator.getByRole('checkbox', { name: '참가자에게 집계 결과 공개', exact: true }).check();
    await clickCommand(operator, operator.getByRole('button', { name: '투표 설정 저장', exact: true }), 'vote.config.save');
    const tally = await clickCommand(operator, operator.getByRole('button', { name: '서버 집계 새로고침', exact: true }), 'vote.tally');
    assert.equal(tally.totalVotes, 6); assert.deepEqual(tally.top3.map((row) => row.teamId), teams.slice(0, 3).map((team) => team.id));
    const publishedVote = await requestJson(harness.baseUrl, `/api/public/events/${slug}`);
    assert.equal(publishedVote.json.workspace.voteCounts[teams[0].id].count, 6);
    assert.equal(publishedVote.json.workspace.ownVote, null);
    await mobile.reload({ waitUntil: 'networkidle' }); await mobile.getByText('투표가 접수되었습니다.', { exact: true }).waitFor();
    await mobile.screenshot({ path: path.join(captures, 'vote-submitted-390.png'), fullPage: true });

    phase = 'independent mobile roulette and persisted entitlement';
    const spinControl = mobile.getByRole('button', { name: /^START/ });
    await operator.locator('#roulette-status').selectOption('CLOSED');
    await operator.getByLabel('경품 이름', { exact: true }).first().fill('검증 기념품 A');
    await operator.getByLabel('유한 재고 수량', { exact: true }).first().fill('4');
    await operator.getByRole('button', { name: '경품 추가', exact: true }).click();
    await operator.getByLabel('경품 이름', { exact: true }).nth(1).fill('검증 기념품 B');
    await operator.getByLabel('유한 재고 수량', { exact: true }).nth(1).fill('4');
    await clickCommand(operator, operator.getByRole('button', { name: '룰렛 설정 저장', exact: true }), 'roulette.config.save');
    await mobile.getByRole('button', { name: '참가 메뉴', exact: true }).click();
    await mobile.getByRole('button', { name: '룰렛 이벤트', exact: true }).click();
    assert.equal(await spinControl.count(), 0);
    await operator.locator('#roulette-status').selectOption('OPEN');
    await clickCommand(operator, operator.getByRole('button', { name: '룰렛 설정 저장', exact: true }), 'roulette.config.save');
    await spinControl.waitFor();
    await mobile.screenshot({ path: path.join(captures, 'roulette-ready-390.png'), fullPage: true });
    await clickCommand(mobile, spinControl, 'roulette.spin');
    workspace = await read(); assert.equal(workspace.rouletteResults.length, 1);
    const spin = workspace.rouletteResults[0];
    assert.ok(['검증 기념품 A', '검증 기념품 B'].includes(spin.label));
    assert.equal(workspace.rewards.filter((reward) => reward.participantId === people[0].id).length, 1);
    const resultPanel = mobile.getByRole('status').filter({ hasText: '내 당첨 경품' });
    await resultPanel.waitFor();
    assert.ok((await resultPanel.innerText()).includes(spin.label));
    const rotor = mobile.getByRole('img', { name: /동일 크기 섹터로 표시한 룰렛/ }).locator(':scope > g');
    const rotation = await rotor.evaluate((element) => element.style.transform);
    const angle = Number(rotation.match(/rotate\((-?[\d.]+)deg\)/)?.[1]);
    const prizeCount = workspace.rouletteConfig.prizes.length;
    const expectedAngle = ((-((spin.tier - 0.5) * 360 / prizeCount) % 360) + 360) % 360;
    assert.ok(Math.abs(angle - expectedAngle) < 0.01, 'the fixed pointer must land on the actual server-selected sector');

    const reduced = await newPage(await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' }));
    const reducedEntry = new URL(dispatch.recipients.find((recipient) => recipient.participantId === people[1].id).variables.티켓링크);
    reducedEntry.searchParams.set('view', 'roulette');
    await reduced.goto(reducedEntry.href, { waitUntil: 'networkidle' });
    const reducedAt = Date.now();
    await clickCommand(reduced, reduced.getByRole('button', { name: /^START/ }), 'roulette.spin');
    await reduced.getByRole('status').filter({ hasText: '내 당첨 경품' }).waitFor();
    assert.ok(Date.now() - reducedAt < 2000, 'reduced motion must not wait for the 3.4-second wheel reveal');
    workspace = await read(); assert.equal(workspace.rouletteResults.length, 2);
    await operator.locator('#roulette-status').selectOption('CLOSED');
    await clickCommand(operator, operator.getByRole('button', { name: '룰렛 설정 저장', exact: true }), 'roulette.config.save');
    await mobile.reload({ waitUntil: 'networkidle' }); await mobile.getByText(spin.label, { exact: true }).first().waitFor();
    assert.equal(await spinControl.count(), 0);
    assert.equal(await rotor.evaluate((element) => element.style.transform), rotation, 'reload must restore the same stopped sector without a new spin');
    await mobile.screenshot({ path: path.join(captures, 'roulette-result-390.png'), fullPage: true });

    phase = 'UI stage modules and individual draw';
    async function createModule(title) {
      await operator.goto(`${gateway.baseUrl}/console/events/${eventId}/programs`, { waitUntil: 'networkidle' });
      await operator.getByRole('button', { name: '프로그램 만들기', exact: true }).click();
      const dialog = operator.getByRole('dialog');
      await dialog.locator('#program-title').fill(title); await dialog.locator('#program-type').selectOption('draw');
      await clickCommand(operator, dialog.getByRole('button', { name: /저장|만들기/, exact: false }).last(), 'module.save');
      const module = (await read()).modules.find((item) => item.title === title);
      const card = operator.locator('li').filter({ has: operator.getByText(title, { exact: true }) }).first();
      await clickCommand(operator, card.getByRole('button', { name: '시작', exact: true }), 'module.status');
      return module;
    }
    const personModule = await createModule('개인 검증 무대');
    const companyModule = await createModule('업체 검증 무대');
    await operator.goto(`${gateway.baseUrl}/console/events/${eventId}/draws`, { waitUntil: 'networkidle' });
    async function createProgram(name, module, eligibility, quota, tier) {
      await operator.locator('#draws-program-name').fill(name); await operator.locator('#draws-program-quota').fill(String(quota));
      await operator.locator('#draws-program-module').selectOption(module.id); await operator.locator('#draws-program-eligibility').selectOption(eligibility);
      await operator.locator('#draws-program-overlap').selectOption('PROGRAM');
      await operator.getByRole('button', { name: '등급 추가', exact: true }).click();
      await operator.getByLabel('등급 1 이름', { exact: true }).fill(tier); await operator.getByLabel('당첨 인원', { exact: true }).fill(String(quota));
      await clickCommand(operator, operator.getByRole('button', { name: '추첨 만들기', exact: true }), 'draw.program.save');
      const program = (await read()).drawPrograms.find((item) => item.name === name);
      const card = () => operator.locator('li').filter({ has: operator.getByText(name, { exact: true }) }).first();
      await clickCommand(operator, card().getByRole('button', { name: '운영 시작', exact: true }), 'draw.program.save');
      return { program, card };
    }
    const personRun = await createProgram('개인 검증 추첨', personModule, 'PERSON', 1, '개인 검증상');
    const stage = await newPage(await browser.newContext({ viewport: { width: 1920, height: 1080 } }));
    await stage.goto(`${gateway.baseUrl}/screen/${slug}`, { waitUntil: 'networkidle' });
    await stage.waitForResponse((response) => response.url().endsWith(`/api/public/events/${slug}`) && response.ok());
    const stageUpdated = stage.waitForResponse(async (response) => {
      if (!response.url().endsWith(`/api/public/events/${slug}`) || !response.ok()) return false;
      const data = await response.json(); return data.workspace?.display?.moduleId === personModule.id && data.workspace?.modules?.some((module) => module.id === personModule.id && module.drawHistory?.length);
    }).then(() => Date.now());
    stageUpdated.catch(() => {});
    const touchAt = Date.now();
    await personRun.card().getByRole('button', { name: '무대 터치 실행', exact: true }).click();
    await gateway.waitForResponseLoss('draw.program.run');
    await operator.getByRole('alert').filter({ hasText: /응답|연결|Failed to fetch/ }).waitFor();
    const firstStageDelayMs = (await stageUpdated) - touchAt;
    assert.ok(firstStageDelayMs < 2500, `first MC touch reached public stage too late: ${firstStageDelayMs}ms`);
    await operator.screenshot({ path: path.join(captures, 'stage-retry-1440.png'), fullPage: true });
    workspace = await read(); assert.equal(workspace.drawPrograms[0].winners.length, 1); assert.equal(workspace.display.moduleId, personModule.id);
    await clickCommand(operator, personRun.card().getByRole('button', { name: '무대 터치 실행', exact: true }), 'draw.program.run');
    const drawCalls = gateway.commands.filter((item) => item.command === 'draw.program.run');
    assert.equal(drawCalls[0].commandId, drawCalls[1].commandId);
    workspace = await read();
    assert.equal(workspace.drawPrograms[0].winners.length, 1); assert.equal(workspace.drawPrograms[0].winners[0].id, people[0].id);
    const calledNumber = workspace.luckyNumbers.find((entry) => entry.participantId === people[0].id).number;
    await stage.getByRole('img', { name: `럭키번호 ${calledNumber}`, exact: true }).waitFor();
    await stage.getByText(people[0].name, { exact: true }).first().waitFor();
    await stage.screenshot({ path: path.join(captures, 'person-stage-1920.png'), fullPage: true });

    phase = 'four sequential company touches and explicit recipients';
    for (const person of people.slice(1)) await command('check.scan', { deskId: inDesk.id, ticket: person.ticket }, { cookie: staffCookie, assignmentId: inAssignment });
    const companyRun = await createProgram('업체 검증 추첨', companyModule, 'COMPANY', 4, '업체 검증상');
    for (let index = 0; index < 4; index += 1) {
      await clickCommand(operator, companyRun.card().getByRole('button', { name: '무대 터치 실행', exact: true }), 'draw.program.run');
      const current = (await read()).drawPrograms.find((item) => item.id === companyRun.program.id);
      assert.equal(current.winners.length, index + 1);
    }
    workspace = await read();
    const companyProgram = workspace.drawPrograms.find((item) => item.id === companyRun.program.id);
    assert.equal(new Set(companyProgram.winners.map((winner) => winner.company)).size, 4);
    const pendingCompany = workspace.rewards.filter((reward) => reward.source?.programId === companyProgram.id);
    assert.equal(pendingCompany.length, 4); assert.ok(pendingCompany.every((reward) => reward.status === 'PENDING' && reward.participantId === null));
    for (const reward of pendingCompany) {
      const recipient = people.find((person) => person.company === reward.company);
      const select = operator.locator(`select[id=${JSON.stringify(`recipient-${reward.id}`)}]`);
      await select.selectOption(recipient.id);
      await clickCommand(operator, select.locator('..').getByRole('button', { name: '수령자 지정', exact: true }), 'reward.assign');
    }
    await stage.getByText(companyProgram.winners[3].company, { exact: true }).first().waitFor();
    await stage.screenshot({ path: path.join(captures, 'company-stage-1920.png'), fullPage: true });

    phase = 'STAFF scoped OUT scan, explicit collection and lost response';
    await staff.locator('#staff-desk').selectOption(outDesk.id);
    await staff.locator('#staff-ticket').fill(decodedTicket);
    await clickCommand(staff, staff.getByRole('button', { name: /체크인|퇴장 처리/, exact: false }).first(), 'check.scan');
    workspace = await read();
    const ownRewards = workspace.rewards.filter((reward) => reward.participantId === people[0].id);
    assert.equal(ownRewards.length, 3); assert.ok(ownRewards.every((reward) => reward.status === 'READY'));
    const prizePanel = staff.getByRole('region', { name: '경품 확인 및 수령', exact: true });
    await prizePanel.getByRole('button', { name: '수령 확인', exact: true }).first().click();
    await gateway.waitForResponseLoss('reward.collect');
    await prizePanel.getByRole('alert').waitFor();
    await staff.screenshot({ path: path.join(captures, 'staff-claim-retry-390.png'), fullPage: true });
    await clickCommand(staff, prizePanel.getByRole('button', { name: '같은 요청으로 다시 확인', exact: true }), 'reward.collect');
    while (await prizePanel.getByRole('button', { name: '수령 확인', exact: true }).count()) await clickCommand(staff, prizePanel.getByRole('button', { name: '수령 확인', exact: true }).first(), 'reward.collect');
    const collectedCalls = gateway.commands.filter((item) => item.command === 'reward.collect');
    assert.equal(collectedCalls[0].commandId, collectedCalls[1].commandId);
    workspace = await read(); assert.ok(workspace.rewards.filter((reward) => reward.participantId === people[0].id).every((reward) => reward.status === 'RECEIVED'));
    const staffBoot = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: staffCookie });
    assert.deepEqual(staffBoot.json.state.workspaces[eventId].rewards, []);
    assert.equal(JSON.stringify(staffBoot.json).includes(people[0].ticket), false);
    await staff.screenshot({ path: path.join(captures, 'staff-received-390.png'), fullPage: true });
    await staff.reload({ waitUntil: 'networkidle' }); await staff.locator('#staff-desk').selectOption(outDesk.id);
    await staff.locator('#reward-lookup-ticket').fill(decodedTicket);
    await clickCommand(staff, staff.getByRole('button', { name: '경품 조회', exact: true }), 'reward.lookup');
    assert.equal(await staff.getByRole('region', { name: '경품 확인 및 수령', exact: true }).getByRole('button', { name: '수령 확인', exact: true }).count(), 0);
    phase = 'real-content accessibility and overflow';
    for (const [name, page] of [['operator', operator], ['staff', staff], ['mobile', mobile], ['reduced-motion', reduced], ['stage', stage]]) {
      await page.evaluate(axeSource);
      const findings = await page.evaluate(async () => {
        const results = await window.axe.run(document, { resultTypes: ['violations'], runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } });
        return results.violations.filter((violation) => violation.impact === 'serious' || violation.impact === 'critical').map((violation) => ({ id: violation.id, nodes: violation.nodes.map((node) => ({ html: node.html, summary: node.failureSummary })) }));
      });
      assert.deepEqual(findings, [], `${name}: blocking accessibility findings`);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      assert.equal(overflow, false, `${name}: horizontal overflow`);
    }
    phase = 'HTTP restart persistence';
    await harness.restartHttp();
    const persisted = await requestJson(harness.baseUrl, '/api/bootstrap', { cookie: managerCookie });
    assert.equal(persisted.json.state.workspaces[eventId].votes.length, 6);
    assert.equal(persisted.json.state.workspaces[eventId].rouletteResults.length, 2);
    assert.equal(persisted.json.state.workspaces[eventId].rewards.filter((reward) => reward.status === 'RECEIVED').length, 3);
    assert.deepEqual(errors, []);
    const result = { outcome: 'passed', apiResponsesMocked: false, realDeliveryAttempted: false, participants: 8, teams: 20, exactPicks: 5, browserBallots: 1, apiFixtureBallots: 5, renderedQrDecoded: true, browserAdmissions: 1, apiFixtureAdmissions: 7, independentRoulette: true, wheelStopsAtServerPrize: true, wheelStopRestoredOnReload: true, reducedMotionImmediateResult: true, browserRouletteParticipants: 2, individualTouchReplayedWithoutDuplicate: true, companyTouches: 4, companyRecipientsExplicit: true, firstStageDelayMs, staffBootstrapGlobalRewards: 0, collectedPrizes: 3, collectionRetryReusedId: true, persistedAfterHttpRestart: true, realContentAxeBlockingFindings: 0, horizontalOverflow: 0, pageErrors: 0, captures };
    fs.writeFileSync(path.join(captures, 'verification.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    if (harness && fixtureEventId) {
      const row = await harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixtureEventId]).catch(() => null);
      const state = row?.rows?.[0]?.payload;
      console.error(JSON.stringify({ phase, commands: gateway?.commands, programs: state?.drawPrograms?.map((program) => ({ id: program.id, status: program.status, winners: program.winners?.length })), display: state?.display }));
    }
    for (let index = 0; index < pages.length; index += 1) await pages[index].screenshot({ path: path.join(captures, `failure-${index}.png`), fullPage: true }).catch(() => {});
    console.error(`Failed phase: ${phase}`); throw error;
  } finally {
    if (browser) await browser.close();
    if (gateway) await gateway.close();
    if (harness) await harness.close();
    if (oldOrigin === undefined) delete process.env.EVENTOUCH_PUBLIC_URL; else process.env.EVENTOUCH_PUBLIC_URL = oldOrigin;
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
