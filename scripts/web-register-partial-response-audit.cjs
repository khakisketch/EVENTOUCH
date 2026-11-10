'use strict';

// A partial HTTP 200 must not replace a reviewed signup form with invented
// defaults. All event data and participants in this audit are synthetic.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');

async function main() {
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`register-partial-response-${runStamp()}`));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const read = async () => (await fixture.harness.database.query(
      'SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId]
    )).rows[0].payload;
    const command = async (name, payload) => {
      const response = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie,
        body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.equal(response.status, 200);
      return read();
    };
    let state = await read();
    state = await command('field.save', { id: 'meal', label: '식사', type: 'select', required: true,
      options: ['채식', '일반'], expectedFormVersion: state.formVersion });
    state = await command('form.publish', { consentText: '합성 동의 안내 A', expectedFormVersion: state.formVersion });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    const page = await context.newPage();
    await page.goto(`${fixture.baseUrl}/event/${fixture.slug}/register`);
    await page.getByText('합성 동의 안내 A', { exact: true }).waitFor();
    await page.locator('#field-name').fill('합성 참가자');
    await page.locator('#field-phone').fill('01099112233');
    await page.locator('#field-meal').selectOption({ label: '채식' });
    await page.locator('#consent').check();
    state = await command('form.publish', { consentText: '합성 동의 안내 B', expectedFormVersion: state.formVersion });
    const [rejected] = await Promise.all([
      page.waitForResponse(response => response.url().includes('/signup') && response.request().method() === 'POST'),
      page.getByRole('button', { name: '신청하기', exact: true }).click(),
    ]);
    assert.equal(rejected.status(), 409);
    assert.equal((await rejected.json()).code, 'SIGNUP_FORM_CHANGED');
    await page.getByRole('button', { name: '최신 신청 양식 불러오기' }).waitFor();

    const cases = [
      ['consent-text', value => { delete value.workspace.consentText; }],
      ['consent-version', value => { delete value.workspace.consentVersion; }],
      ['verification', value => { delete value.workspace.verificationRequired; }],
      ['approval', value => { delete value.workspace.approvalRequired; }],
      ['stage', value => { delete value.event.stage; }],
      ['features', value => { delete value.event.features; }],
      ['price', value => { delete value.workspace.price; }],
      ['form-version', value => { value.workspace.formVersion += 1; }],
      ['field-required', value => { delete value.workspace.publishedFields.find(field => field.id === 'meal').required; }],
      ['field-type', value => { value.workspace.publishedFields.find(field => field.id === 'meal').type = 'unknown'; }],
      ['field-options', value => { value.workspace.publishedFields.find(field => field.id === 'meal').options = [1]; }],
      ['required-select-empty', value => { value.workspace.publishedFields.find(field => field.id === 'meal').options = []; }],
      ['duplicate-field', value => { const field = value.workspace.publishedFields.find(item => item.id === 'meal'); value.workspace.publishedFields.push({ ...field }); }],
    ];
    let selected = null;
    await page.route('**/api/public/events/*', async route => {
      if (route.request().method() !== 'GET' || !selected) return route.continue();
      const original = await route.fetch();
      const value = await original.json();
      selected(value);
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    });
    for (const [, mutate] of cases) {
      selected = mutate;
      await page.getByRole('button', { name: '최신 신청 양식 불러오기' }).click();
      await page.getByText('최신 양식을 불러오지 못했습니다.', { exact: false }).waitFor();
      assert.equal(await page.getByRole('button', { name: '신청하기', exact: true }).isDisabled(), true);
      assert.equal(await page.locator('#field-name').inputValue(), '합성 참가자');
      assert.equal(await page.locator('#field-phone').inputValue(), '01099112233');
      assert.equal(await page.locator('#field-meal').inputValue(), '채식');
      assert.equal(await page.locator('#consent').isChecked(), true);
      assert.equal(await page.getByText('합성 동의 안내 A', { exact: true }).isVisible(), true);
    }
    await page.screenshot({ path: path.join(out, 'partial-390.png'), fullPage: true,
      mask: [page.locator('#field-phone')] });
    selected = null;
    await page.getByRole('button', { name: '최신 신청 양식 불러오기' }).click();
    await page.getByText('합성 동의 안내 B', { exact: true }).waitFor();
    assert.equal(await page.locator('#field-name').inputValue(), '합성 참가자');
    assert.equal(await page.locator('#field-meal').inputValue(), '채식');
    assert.equal(await page.locator('#consent').isChecked(), false);
    await page.locator('#consent').check();
    await page.getByRole('button', { name: '신청하기', exact: true }).click();
    await page.getByText('합성 참가자', { exact: true }).first().waitFor();
    const people = (await read()).participants.filter(person => person.name === '합성 참가자');
    assert.equal(people.length, 1);
    assert.equal(people[0].consent.version, state.consentVersion);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ partialCasesRejected: cases.map(([name]) => name),
      inputPreserved: true, signupLockedUntilComplete: true, finalSignupCount: people.length, actualProvider: false }, null, 2), { mode: 0o600 });
    console.log('[register-partial-response] partial payloads rejected; normal recovery passed');
  } finally {
    await browser?.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
