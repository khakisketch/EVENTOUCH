'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const axeSource = require('axe-core').source;
let stage = 'setup';

(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-locked-reference');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture(); let browser;
  try {
    const row = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0];
    const workspace = row.payload;
    const people = workspace.participants.slice(0, 2);
    people.forEach((person, index) => { person.name = '동명이인'; person.phone = index ? '01099990002' : '01099990001'; });
    const id = `locked-${crypto.randomUUID()}`, oldId = `legacy-${crypto.randomUUID()}`;
    const incompleteId = `partial-${crypto.randomUUID()}`, closedId = `closed-${crypto.randomUUID()}`;
    const make = (messageId, title, options = {}) => ({
      id: messageId, title, body: '합성 안내', channel: 'SMS', recipientIds: people.map((person) => person.id),
      status: 'SENDING', genericTransport: true, genericAttemptActive: options.active !== false,
      genericSubmissionUnconfirmed: true, deliveryUnconfirmed: true,
      ...(options.legacy ? {} : { providerSubmission: { id: `submission-${crypto.randomUUID()}`, kind: 'HTTP' } }),
      recipientSnapshot: options.snapshot || people.map((person, index) => ({ id: person.id, name: person.name, phone: index ? '01022223333' : '01011114444' })),
      deliveries: people.map((person) => ({ participantId: person.id, name: person.name, status: 'SENDING', at: new Date().toISOString() })),
      at: new Date().toISOString(),
    });
    workspace.messages.unshift(make(closedId, '합성 루프 종료', { active: false }));
    workspace.messages.unshift(make(incompleteId, '합성 불완전 기록', { snapshot: [
      { id: people[0].id, name: people[0].name, phone: '01011114444' },
      { id: people[0].id, name: people[0].name, phone: '01022223333' },
    ] }));
    workspace.messages.unshift(make(oldId, '합성 이전 기록', { legacy: true }));
    workspace.messages.unshift(make(id, '합성 확인 잠김'));
    await fixture.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    const before = structuredClone(workspace.messages);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    let writes = 0;
    page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/commands')) writes += 1; });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/messages`, { waitUntil: 'networkidle' });
    stage = 'locked reference';
    await page.getByRole('button', { name: '합성 확인 잠김 상세', exact: true }).click();
    const detail = page.locator(`[id="campaign-detail-${id}"]`);
    await detail.getByText('수신자별 처리 상태', { exact: false }).click();
    assert.equal(await detail.getByRole('button', { name: /공급사 확인 기록/ }).count(), 0, 'the prior attempt still cannot be manually resolved');
    const disclosures = detail.getByText('공급사 대조 정보', { exact: true });
    assert.equal(await disclosures.count(), 2);
    await disclosures.nth(0).focus(); await page.keyboard.press('Enter');
    const first = detail.locator('li').filter({ has: page.getByRole('textbox', { name: '동명이인 010-****-4444 대조 ID' }) });
    const reference = `${id}:${people[0].id}`;
    assert.equal(await first.getByRole('textbox').inputValue(), reference);
    assert.equal(await first.getByText('발송 당시 연락처 · 010-****-4444').count(), 1);
    assert.equal((await detail.innerText()).includes('01011114444'), false, 'the full old number is never rendered');
    assert.equal((await detail.innerText()).includes('010-****-0001'), false, 'the current number is never substituted');
    assert.equal(await first.getByText(/전송이나 접수의 증거가 아닙니다/).count(), 1);
    await first.getByRole('textbox').focus();
    assert.equal(await first.getByRole('textbox').evaluate(node => node.selectionStart === 0 && node.selectionEnd === node.value.length), true, 'manual keyboard copying selects the entire reference');
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }));
    await first.getByRole('button', { name: /대조 ID 복사/ }).click();
    await first.getByRole('status').filter({ hasText: '직접 선택해 복사' }).waitFor();
    assert.equal(await first.getByRole('textbox').inputValue(), reference);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async value => { window.__syntheticCopiedReference = value; } } }));
    await first.getByRole('button', { name: /대조 ID 복사/ }).click();
    assert.equal(await page.evaluate(() => window.__syntheticCopiedReference), reference);
    await first.getByRole('status').filter({ hasText: '복사했습니다' }).waitFor();
    await disclosures.nth(1).click();
    assert.equal(await detail.getByRole('textbox', { name: '동명이인 010-****-3333 대조 ID' }).inputValue(), `${id}:${people[1].id}`);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 }); await first.scrollIntoViewIfNeeded();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'no horizontal page overflow');
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `locked-reference-${width}.png`) });
    }
    await page.getByRole('button', { name: '합성 확인 잠김 상세 닫기', exact: true }).click();
    stage = 'legacy and partial records';
    stage = 'legacy record';
    await page.getByRole('button', { name: '합성 이전 기록 상세', exact: true }).click();
    const legacy = page.locator(`[id="campaign-detail-${oldId}"]`);
    await legacy.getByText('수신자별 처리 상태', { exact: false }).click();
    await legacy.getByText('공급사 대조 정보', { exact: true }).first().click();
    assert.equal(await legacy.getByText('이전 발송의 참조 정보를 확인할 수 없습니다. 운영 담당자에게 문의하세요.').first().isVisible(), true);
    assert.equal(await legacy.getByRole('textbox', { name: /대조 ID/ }).count(), 0);
    await page.getByRole('button', { name: '합성 이전 기록 상세 닫기', exact: true }).click();
    stage = 'partial snapshot';
    await page.getByRole('button', { name: '합성 불완전 기록 상세', exact: true }).click();
    const partial = page.locator(`[id="campaign-detail-${incompleteId}"]`);
    await partial.getByText('수신자별 처리 상태', { exact: false }).click();
    await partial.getByText('공급사 대조 정보', { exact: true }).first().click();
    assert.equal(await partial.getByText('발송 당시 연락처 · 확인할 수 없음').first().isVisible(), true);
    assert.equal(await partial.getByRole('textbox', { name: /대조 ID/ }).count(), 0);
    await page.getByRole('button', { name: '합성 불완전 기록 상세 닫기', exact: true }).click();
    stage = 'completed loop';
    await page.getByRole('button', { name: '합성 루프 종료 상세', exact: true }).click();
    const completed = page.locator(`[id="campaign-detail-${closedId}"]`);
    await completed.getByText('수신자별 처리 상태', { exact: false }).click();
    assert.equal(await completed.getByText('공급사 대조 정보', { exact: true }).count(), 0);
    assert.equal(await completed.getByRole('button', { name: /공급사 확인 기록/ }).count(), 2, 'existing manual review remains available after loop termination');
    stage = 'authorization and unchanged state';
    const otherId = `audit-no-event-${crypto.randomUUID()}`;
    await fixture.helpers.insertAccount(fixture.harness.database, { id: otherId, role: 'MANAGER', name: '합성 접근 제한', email: `${otherId}@example.test`, orgId: fixture.helpers.LEGACY_ORG });
    const otherCookie = await fixture.helpers.sessionCookie(fixture.harness, otherId);
    const unauthorized = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/bootstrap?messageRecipientReview=1`, { cookie: otherCookie });
    assert.ok([403, 404].includes(unauthorized.status), `event scope must deny a different account: ${unauthorized.status}`);
    assert.equal(JSON.stringify(unauthorized.json || {}).includes(reference), false);
    const operator = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/bootstrap?messageRecipientReview=1`, { cookie: fixture.manager.cookie });
    assert.equal(operator.status, 200);
    const projected = operator.json?.state?.workspaces?.[fixture.eventId]?.messages?.find(message => message.id === id);
    assert.deepEqual(projected?.deliveries?.[0]?.providerLookup, { maskedPhone: '010-****-4444', reference });
    assert.doesNotMatch(JSON.stringify(projected.deliveries[0].providerLookup), /01011114444|01099990001/);
    const staff = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/bootstrap?messageRecipientReview=1`, { cookie: fixture.staff.cookie });
    assert.ok([200, 403, 404].includes(staff.status));
    assert.equal(JSON.stringify(staff.json || {}).includes(reference), false, 'staff do not receive the operator lookup');
    assert.equal(JSON.stringify(staff.json || {}).includes('providerLookup'), false);
    const publicRead = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/public/events/${fixture.slug}`);
    assert.equal(publicRead.status, 200);
    assert.equal(JSON.stringify(publicRead.json || {}).includes(reference), false);
    assert.equal(JSON.stringify(publicRead.json || {}).includes('providerLookup'), false);
    const after = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    assert.deepEqual(after.messages, before, 'view and copy never change any send state');
    assert.equal(writes, 0, 'view and copy never send an event command');
    const output = { passed: true, maskedHistoricalNumbers: true, noPhoneSubstitution: true, sameNamesDistinguished: true, exactReference: true, noReferenceWithoutHttpProof: true, partialSnapshotNotGuessed: true, clipboardFailureManualSelection: true, clipboardSuccess: true, runningLockPreserved: true, existingManualReviewPreserved: true, unauthorizedAccountDenied: true, commands: 0, viewports: [320, 390, 1280] };
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify(output, null, 2), { mode: 0o600 });
    process.stdout.write('[message-locked-reference] passed\n');
    await context.close();
  } finally { if (browser) await browser.close(); await fixture.close(); }
})().catch(error => { console.error(`Stage ${stage}: ${String(error && error.message || 'Unknown failure').replace(/https?:\/\/[^\s]+/g, '[url redacted]')}`); process.exitCode = 1; });
