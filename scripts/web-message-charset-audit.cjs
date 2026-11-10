'use strict';
// Synthetic event and loopback provider only. No external messages are sent.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { messageStep } = require('./ui-journey-helpers.cjs');
const axe = require('axe-core').source;
let phase = 'setup';
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Private capture root required');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-charset');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const calls = [];
  const mock = http.createServer((req, res) => {
    let raw = ''; req.on('data', chunk => raw += chunk); req.on('end', () => {
      calls.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(req.url.startsWith('/messages/v4/send-many/detail')
        ? { failedMessageList: [], groupInfo: { groupId: 'SYNTHETIC-GROUP' } }
        : { messageList: {}, limit: 20, startKey: null }));
    });
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  let f, browser;
  try {
    f = await startAuditFixture({ fixtureSolapiHost: `http://127.0.0.1:${mock.address().port}`, fixtureSolapiKakao: true });
    const getWorkspace = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const saveWorkspace = async ws => f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    const ws = await getWorkspace(); const person = ws.participants.find(item => item.status === 'APPROVED'); assert.ok(person);
    const command = async (name, payload) => {
      const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload } });
      assert.ok(r.status >= 200 && r.status < 300, `${name}: ${JSON.stringify(r.json)}`); return r.json;
    };
    const template = (await command('template.save', { name: '합성 알림톡', channel: 'ALIMTALK', body: '행사에 오신 것을 환영합니다 🎉', solapiTemplateId: 'KAFIXTURE_ONLY' })).template;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const providerCalls = () => calls.filter(call => call.path.startsWith('/messages/v4/send-many/detail'));
    const open = async title => {
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages?to=${encodeURIComponent(person.id)}`, { waitUntil: 'networkidle' });
      await messageStep(page, 2); await page.locator('#campaign-title').fill(title);
    };
    phase = 'body validation'; await open('합성 문자');
    const original = '환영합니다 🎉'; await page.locator('#campaign-body').fill(original);
    await page.getByRole('button', { name: '발송 검토로', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '문자로 보낼 수 없는 문자' }).waitFor();
    assert.equal(await page.locator('#campaign-body').inputValue(), original);
    await page.waitForFunction(() => document.activeElement?.id === 'campaign-body' && document.activeElement.selectionStart === 6);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      await page.addScriptTag({ content: axe });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `body-warning-${width}.png`), fullPage: true });
    }
    assert.equal(providerCalls().length, 0);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#campaign-body').scrollIntoViewIfNeeded();
    const visibleError = await page.locator('#campaign-body-error').boundingBox();
    assert.ok(visibleError && visibleError.y >= 0 && visibleError.y + visibleError.height <= 844, 'body error must be visible with the focused input on mobile');
    await page.screenshot({ path: path.join(out, 'body-warning-viewport-390.png') });
    phase = 'old server refuses without losing draft';
    await page.locator('#campaign-body').fill('환영합니다'); await messageStep(page, 3);
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body?.command === 'message.create-charset-reviewed') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '지원하지 않는 명령입니다.' }) });
      return route.continue();
    });
    await page.locator('#campaign-submit').click(); await page.getByRole('button', { name: '발송 요청한다', exact: true }).click();
    await page.getByText('지원하지 않는 명령입니다.', { exact: false }).waitFor();
    assert.equal(await page.locator('#campaign-body').inputValue(), '환영합니다'); assert.equal(providerCalls().length, 0);
    await page.unroute('**/api/events/*/commands');
    phase = 'personalized recipient';
    const updated = await getWorkspace(); updated.participants.find(item => item.id === person.id).name = '합성 🎉'; await saveWorkspace(updated);
    await open('합성 개인화'); await page.locator('#campaign-body').fill('{{이름}}님 환영합니다');
    await messageStep(page, 1); await page.locator('#recipient-status-filter').selectOption('PENDING'); await messageStep(page, 2);
    const candidateUrl = page.url();
    await page.getByRole('button', { name: '이름 확인이 필요한 참가자 보기', exact: true }).click();
    assert.equal(page.url(), candidateUrl, 'candidate navigation does not add identity to the URL');
    assert.equal(await page.locator('#recipient-status-filter').inputValue(), 'PENDING', 'candidate view preserves the previous filter');
    const candidates = page.getByRole('list', { name: '참가자 선택', exact: true });
    assert.equal(await candidates.locator('li').count(), 1); assert.ok(await candidates.getByText('합성 🎉').isVisible());
    assert.equal(await candidates.locator('input[type=checkbox]').isChecked(), true, 'candidate navigation preserves the selected target');
    await messageStep(page, 2); await messageStep(page, 3);
    await page.locator('#campaign-submit').click(); await page.getByRole('button', { name: '발송 요청한다', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '문자로 보낼 수 없는 글자' }).waitFor();
    assert.equal(await page.locator('#campaign-body').inputValue(), '{{이름}}님 환영합니다'); assert.equal(providerCalls().length, 0);
    await page.screenshot({ path: path.join(out, 'personalized-rejected-390.png'), fullPage: true });
    phase = 'Alimtalk explicit fallback'; await open('합성 알림톡'); await page.locator('#campaign-template').selectOption(template.id);
    assert.equal(await page.locator('#campaign-sms-fallback input[value=on]').isChecked(), true);
    await page.getByRole('button', { name: '발송 검토로', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: '대체 문자로 보낼 수 없는' }).waitFor();
    await page.locator('#campaign-sms-fallback input[value=on]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('#campaign-sms-fallback input[value=off]').isChecked(), true, 'keyboard changes the explicit fallback choice');
    await page.addScriptTag({ content: axe });
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'alimtalk-fallback-off-390.png'), fullPage: true });
    await page.locator('#campaign-sms-fallback').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'alimtalk-fallback-viewport-390.png') });
    await messageStep(page, 3); await page.locator('section[aria-labelledby="campaign-review-heading"]').getByText('알림톡을 전달하지 못해도 문자로 대체 발송하지 않습니다.', { exact: false }).waitFor();
    await page.locator('#campaign-submit').click();
    await page.getByRole('button', { name: '발송 요청한다', exact: true }).click();
    try { await page.getByRole('button', { name: '메시지 작성', exact: true }).waitFor(); }
    catch (error) { console.error('Alimtalk response:', (await page.locator('body').innerText()).slice(-2200)); await page.screenshot({ path: path.join(out, 'alimtalk-failure.png'), fullPage: true }); throw error; }
    assert.equal(providerCalls().length, 1); const sent = providerCalls()[0].body.messages[0];
    assert.equal(sent.type, 'ATA'); assert.equal(sent.kakaoOptions.disableSms, true); assert.ok(sent.text.includes('🎉'));
    phase = 'scheduled recipient recheck';
    const clean = await getWorkspace(); clean.participants.find(item => item.id === person.id).name = '합성 참가자'; await saveWorkspace(clean);
    await open('합성 예약'); await page.locator('#campaign-body').fill('{{이름}}님 행사 안내'); await messageStep(page, 3);
    await page.getByText('예약 등록 · 선택', { exact: false }).first().click();
    const futureSeoul = new Date(Date.now() + (9 * 60 + 10) * 60000).toISOString().slice(0, 16);
    await page.locator('#campaign-scheduled').fill(futureSeoul);
    await page.locator('#campaign-submit').click(); await page.getByRole('button', { name: '예약 등록한다', exact: true }).click();
    await page.getByRole('button', { name: '메시지 작성', exact: true }).waitFor();
    assert.equal(providerCalls().length, 1, 'reservation does not send');
    const changed = await getWorkspace(); changed.participants.find(item => item.id === person.id).name = '합성 🎉'; await saveWorkspace(changed);
    await page.reload({ waitUntil: 'networkidle' }); await page.getByRole('button', { name: '합성 예약 상세', exact: true }).click();
    await page.getByText(/수신자 1명의 문자에 지원하지 않는 문자 또는 제어문자/).first().waitFor();
    assert.equal(providerCalls().length, 1, 'reviewing a blocked reservation never sends');
    await page.screenshot({ path: path.join(out, 'scheduled-blocked-390.png'), fullPage: true });
    phase = 'cancel blocked reservation and recover original';
    const scheduled = (await getWorkspace()).messages.find(item => item.title === '합성 예약'); assert.ok(scheduled);
    const detail = page.locator(`[id="campaign-detail-${scheduled.id}"]`);
    const scheduledRow = page.locator(`[id="campaign-${scheduled.id}"]`);
    await scheduledRow.getByRole('button', { name: '예약 취소', exact: true }).click();
    await detail.getByRole('button', { name: '예약을 취소한다', exact: true }).click();
    await page.waitForFunction(id => document.getElementById(`campaign-${id}`)?.textContent?.includes('취소'), scheduled.id);
    const cancelled = (await getWorkspace()).messages.find(item => item.id === scheduled.id);
    assert.equal(cancelled.status, 'CANCELLED'); assert.equal(cancelled.smsTextReloadSafe, true); assert.equal(cancelled.smsTextProblemCount, 1);
    await scheduledRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
    assert.equal(await page.locator('#campaign-body').inputValue(), '{{이름}}님 행사 안내');
    assert.equal(providerCalls().length, 1, 'reload never sends');
    phase = 'uncertain cancellation stays read-only';
    const uncertain = await getWorkspace(); const unknownId = `synthetic-unknown-${crypto.randomUUID()}`;
    const failedUnknownId = `synthetic-failed-unknown-${crypto.randomUUID()}`;
    uncertain.messages.unshift({ id: unknownId, title: '합성 접수 불확실', channel: 'SMS', body: '이전 합성 문구', status: 'CANCELLED',
      recipientIds: [person.id], scheduled: new Date(Date.now() + 3600000).toISOString(), simulate: false,
      deliveryUnconfirmed: true, providerSubmission: { id: 'SYNTHETIC-PENDING', kind: 'HTTP' },
      deliveries: [], at: new Date().toISOString() });
    uncertain.messages.unshift({ id: failedUnknownId, title: '합성 실패 접수 불확실', channel: 'SMS', body: '실패한 합성 문구', status: 'FAILED',
      recipientIds: [person.id], simulate: false, deliveryUnconfirmed: true, providerSubmission: { id: 'SYNTHETIC-PENDING-2', kind: 'HTTP' },
      deliveries: [], at: new Date().toISOString() });
    await saveWorkspace(uncertain);
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`, { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '합성 접수 불확실 상세', exact: true }).click();
    const unknown = page.locator(`[id="campaign-detail-${unknownId}"]`);
    assert.equal(await page.locator(`[id="campaign-${unknownId}"]`).getByRole('button', { name: '내용·대상 불러오기', exact: true }).count(), 0);
    await unknown.getByText('기존 내용 보기', { exact: true }).click();
    await unknown.getByText('이전 합성 문구', { exact: true }).waitFor();
    await unknown.getByText(/공급사에서 먼저 확인/).waitFor();
    await page.getByRole('button', { name: '합성 실패 접수 불확실 상세', exact: true }).click();
    assert.equal(await page.locator(`[id="campaign-${failedUnknownId}"]`).getByRole('button', { name: '내용·대상 불러오기', exact: true }).count(), 0);
    const failedUnknown = page.locator(`[id="campaign-detail-${failedUnknownId}"]`);
    await failedUnknown.getByText('기존 내용 보기', { exact: true }).click();
    await failedUnknown.getByText('실패한 합성 문구', { exact: true }).waitFor();
    assert.equal(providerCalls().length, 1);
    phase = 'generic transport authoring';
    const cleanAgain = await getWorkspace(); cleanAgain.participants.find(item => item.id === person.id).name = '합성 참가자'; await saveWorkspace(cleanAgain);
    let genericProjection = false;
    await page.route('**/api/**', async route => {
      if (!new URL(route.request().url()).pathname.endsWith('/bootstrap')) return route.continue();
      const response = await route.fetch(); const body = await response.json();
      const state = body.state || body;
      if (state.integrations) { state.integrations = { ...state.integrations, provider: 'http' }; genericProjection = true; }
      await route.fulfill({ response, json: body });
    });
    await open('합성 HTTP'); await page.locator('#campaign-body').fill('일반 연결 안내 🎉');
    assert.equal(genericProjection, true, 'the synthetic HTTP integration projection must actually reach the UI');
    try { await messageStep(page, 3); } catch (error) { console.error('Generic compose:', (await page.locator('body').innerText()).slice(-2000)); throw error; }
    assert.equal(await page.getByRole('heading', { name: '발송 전 검토' }).isVisible(), true);
    assert.equal(providerCalls().length, 1, 'generic authoring check does not send');
    assert.deepEqual(errors, []);
    console.log('Message charset UI: body, old server, personalized guard, Alimtalk choice, mock provider, keyboard, widths and axe passed.');
  } catch (error) { console.error('Failed phase:', phase); throw error; }
  finally { if (browser) await browser.close(); if (f) await f.close(); await new Promise(resolve => mock.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
