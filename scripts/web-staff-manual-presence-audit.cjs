'use strict';
// Isolated fixture only: real check-in commands and synthetic roster changes.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk } = require('./audit-staff-direction.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'staff-manual-presence');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const workspace = await read();
    const people = workspace.participants.slice(0, 4);
    const send = async (command, payload, cookie = f.manager.cookie, assignmentId) => {
      const result = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie, body: { command, commandId: crypto.randomUUID(), payload, ...(assignmentId ? { assignmentId } : {}) },
      });
      assert.equal(result.status, 200, `${command} must succeed in the synthetic fixture`);
    };
    const scan = async (person) => send('check.scan', { deskId: f.deskId, expectedAction: 'IN', ticket: person.ticket }, f.staff.cookie, `audit-assign-${f.suffix}`.toLowerCase());
    await scan(people[0]);
    const corrupt = await read();
    const reviewPerson = corrupt.participants.find((person) => person.id === people[2].id);
    reviewPerson.inside = true; reviewPerson.everIn = false;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(corrupt)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    await confirmInitialStaffDesk(page);
    await page.getByText('카메라가 안 될 때 · 참가자 명단 확인').click();
    const search = page.locator('#staff-manual-search');
    await search.fill('감사 참가자');
    const row = (person) => page.getByRole('list', { name: '참가자 검색 결과' }).getByRole('listitem').filter({ hasText: person.name });
    await row(people[0]).getByText('입장 중', { exact: true }).waitFor();
    await row(people[1]).getByText('입장 중 아님', { exact: true }).waitFor();
    await row(people[2]).getByText('출입 기록 확인 필요', { exact: true }).waitFor();
    assert.equal(await row(people[0]).getByRole('button', { name: /선택/ }).isEnabled(), true, 'a snapshot must not block a server-checked action');
    await page.getByText(/마지막으로 확인한 명단 기준/).waitFor();
    await page.evaluate(axeSource);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `overflow ${width}`);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((item) => ['serious', 'critical'].includes(item.impact)).map((item) => item.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `presence-${width}.png`), fullPage: true });
      if (width === 390) await page.locator('details').filter({ hasText: '카메라가 안 될 때 · 참가자 명단 확인' }).screenshot({ path: path.join(out, 'manual-list-390.png') });
    }
    await scan(people[1]);
    await row(people[1]).getByText('입장 중 아님', { exact: true }).waitFor();
    const refreshButton = page.getByRole('button', { name: '참가자 명단 새로고침' });
    const refreshBounds = await refreshButton.boundingBox();
    assert.ok(refreshBounds && refreshBounds.width >= 44 && refreshBounds.height >= 44, 'refresh has a 44px touch target');
    await refreshButton.focus();
    await page.keyboard.press('Enter');
    await row(people[1]).getByText('입장 중', { exact: true }).waitFor();
    assert.equal(await search.inputValue(), '감사 참가자');

    // Keep an identity confirmation open while another operator cancels that
    // person's registration, then re-read the actual server state.
    await row(people[3]).getByRole('button', { name: /선택/ }).click();
    await page.getByLabel('이름·소속을 직접 확인했습니다').check();
    await send('participant.status', { id: people[3].id, status: 'CANCELLED' });
    await page.getByRole('button', { name: '참가자 명단 새로고침' }).click();
    await page.getByText('참가 상태가 바뀌어 처리할 수 없습니다. 현장 책임자에게 확인하세요.').waitFor();
    assert.equal(await page.getByRole('button', { name: '확인한 참가자 입장 처리' }).isDisabled(), true);
    assert.equal(await search.inputValue(), '감사 참가자');
    assert.equal((await read()).checks.filter((check) => check.participantId === people[3].id).length, 0);

    // An unavailable read must call the shown states previous, not current.
    await page.route('**/api/bootstrap', (route) => route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"synthetic"}' }));
    await page.getByRole('button', { name: '참가자 명단 새로고침' }).click();
    await page.getByText(/표시된 출입 상태는 이전 확인 기준/).waitFor();
    assert.equal(await row(people[1]).getByText('입장 중', { exact: true }).isVisible(), true);
    await page.unroute('**/api/bootstrap');
    await page.getByRole('button', { name: '참가자 명단 새로고침' }).click();
    await page.getByText(/마지막으로 확인한 명단 기준/).waitFor();
    // Older or incomplete projections must not label an unverified boolean
    // as a reliable current attendance state.
    await page.route('**/api/bootstrap', async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const person = body.state.workspaces[f.eventId].participants.find((item) => item.id === people[1].id);
      delete person.attendanceReview;
      return route.fulfill({ response, body: JSON.stringify(body) });
    });
    await page.getByRole('button', { name: '참가자 명단 새로고침' }).click();
    await row(people[1]).getByText('출입 상태 확인 불가', { exact: true }).waitFor();
    assert.equal(await row(people[1]).getByText('입장 중', { exact: true }).count(), 0);
    await page.unroute('**/api/bootstrap');
    assert.deepEqual(errors, []);
    console.log('Staff manual presence audit passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
