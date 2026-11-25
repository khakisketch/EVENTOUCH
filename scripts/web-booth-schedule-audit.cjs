'use strict';
// Isolated synthetic fixture. --before captures the prior built form only.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { openLocationEditor } = require('./ui-journey-helpers.cjs');
const before = process.argv.includes('--before');
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'booth-schedule-before' : 'booth-schedule'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser, page;
  try {
    const command = async (payload) => {
      const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie,
        body: { commandId: crypto.randomUUID(), command: 'booth.save', payload },
      });
      assert.ok([200, 201].includes(response.status), JSON.stringify(response.json));
      return response.json.booth;
    };
    const features = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'event.features', payload: { features: ['stamp', 'draw', 'poll', 'reward', 'screen', 'venue'] } },
    });
    assert.equal(features.status, 200);
    const initial = await command({ name: '시간 검증 부스', zone: 'A', status: 'OPEN', capacity: 30, limit: 1,
      startsAt: '2026-11-12T00:23:45.123Z', endsAt: '2026-11-12T16:00:30+09:00' });
    const boothId = initial.id;
    const readWorkspace = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const read = async () => (await readWorkspace()).booths.find(item => item.id === boothId);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', timezoneId: 'America/Los_Angeles' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/operations?setup=1`, { waitUntil: 'networkidle' });
    // Reopened 2026-11-20: 부스는 더 이상 탭이 아니라 같은 화면의 구역이고, 행의 '편집' 버튼은 상세 시트의 '부스 편집'으로 옮겨졌다.
    const dialog = page.getByRole('dialog', { name: '부스 편집' });
    const open = async () => { await openLocationEditor(page, '부스', /시간 검증 부스/); await dialog.waitFor(); };
    const save = async () => { await dialog.getByRole('button', { name: '부스 저장', exact: true }).click(); await dialog.waitFor({ state: 'detached' }); };
    await open();
    if (before) {
      assert.equal(await dialog.locator('#booth-starts').count(), 0);
      await page.screenshot({ path: path.join(out, 'before-1280.png') });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-390.png') });
      return;
    }
    assert.equal(await dialog.locator('#booth-starts').inputValue(), '2026-11-12T09:23');
    assert.equal(await dialog.locator('#booth-ends').inputValue(), '2026-11-12T16:00');
    assert.equal(await dialog.locator('#booth-starts-confirm').innerText(), '화면에 표시된 시간: 2026년 11월 12일 09:23 (한국 시간)');
    assert.ok((await dialog.locator('#booth-starts').getAttribute('aria-describedby')).includes('booth-starts-confirm'));
    await dialog.getByText(/저장된 시작에는 초 단위가 있습니다/).waitFor();
    await dialog.getByText(/저장된 종료에는 초 단위가 있습니다/).waitFor();
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      await dialog.locator('#booth-starts').focus();
      // Native datetime-local controls can expose several keyboard segments.
      for (let step = 0; step < 12 && !(await dialog.getByRole('button', { name: '시작 시간 지우기', exact: true }).evaluate(node => node === document.activeElement)); step += 1) {
        await page.keyboard.press('Tab');
      }
      assert.equal(await dialog.getByRole('button', { name: '시작 시간 지우기', exact: true }).evaluate(node => node === document.activeElement), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `form-${width}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await dialog.locator('#booth-name').fill('시간 검증 부스 원문 보존');
    await save();
    let current = await read();
    assert.equal(current.startsAt, '2026-11-12T00:23:45.123Z');
    assert.equal(current.endsAt, '2026-11-12T16:00:30+09:00');
    await open();
    await dialog.locator('#booth-starts').fill('');
    assert.equal(await dialog.locator('#booth-starts-confirm').count(), 0, 'an empty value must not be guessed');
    await dialog.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '날짜와 시간을 모두 입력하거나' }).waitFor();
    assert.equal((await read()).startsAt, '2026-11-12T00:23:45.123Z', 'empty typing is not an implicit delete');
    await dialog.locator('#booth-starts').fill('2026-11-12T10:00');
    assert.equal(await dialog.locator('#booth-starts-confirm').innerText(), '변경할 시간: 2026년 11월 12일 10:00 (한국 시간)');
    await save();
    current = await read();
    assert.equal(current.startsAt, '2026-11-12T10:00:00+09:00');
    assert.equal(current.endsAt, '2026-11-12T16:00:30+09:00');
    await open();
    await dialog.locator('#booth-ends').fill('2026-11-12T09:00');
    await dialog.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '종료 시간은 시작 시간보다 늦어야 합니다' }).waitFor();
    assert.equal((await read()).endsAt, '2026-11-12T16:00:30+09:00');
    page.once('dialog', d => d.dismiss());
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await dialog.locator('#booth-ends').inputValue(), '2026-11-12T09:00');
    page.once('dialog', d => d.accept());
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    await open();
    assert.equal(await dialog.locator('#booth-ends').inputValue(), '2026-11-12T16:00');
    await dialog.getByRole('button', { name: '종료 시간 지우기', exact: true }).click();
    await save();
    current = await read();
    assert.equal(current.startsAt, '2026-11-12T10:00:00+09:00'); assert.equal(current.endsAt, '');
    await open();
    await dialog.locator('#booth-ends').fill('2026-11-12T16:00');
    await save();
    await open();
    await dialog.locator('#booth-starts').fill('2026-11-12T11:00');
    current = await read();
    await command({ ...current, zone: '다른 운영자', endsAt: '2026-11-12T18:00:00+09:00' });
    await dialog.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialog.getByRole('button', { name: '최신 부스 확인', exact: true }).click();
    const comparison = dialog.getByRole('table', { name: '최신 부스와 내 작성 내용 비교' });
    await comparison.waitFor();
    assert.ok((await comparison.innerText()).includes('최신값 유지'));
    await page.screenshot({ path: path.join(out, 'conflict-1280.png') });
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.evaluate(axeSource);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      await page.screenshot({ path: path.join(out, `conflict-${width}.png`) });
    }
    await dialog.getByRole('button', { name: '내 작성 내용으로 계속', exact: true }).click();
    assert.equal(await dialog.locator('#booth-starts').inputValue(), '2026-11-12T11:00');
    assert.equal(await dialog.locator('#booth-ends').inputValue(), '2026-11-12T18:00');
    await save();
    current = await read();
    assert.equal(current.startsAt, '2026-11-12T11:00:00+09:00');
    assert.equal(current.endsAt, '2026-11-12T18:00:00+09:00');
    // A second conflict must let the operator discard the edited time and use
    // the other operator's actual new time without normalizing it on save.
    await open();
    await dialog.locator('#booth-starts').fill('2026-11-12T12:00');
    current = await read();
    await command({ ...current, startsAt: '2026-11-12T04:00:42.123Z', endsAt: '2026-11-12T19:00:30+09:00' });
    await dialog.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialog.getByRole('button', { name: '최신 부스 확인', exact: true }).click();
    await dialog.getByRole('table', { name: '최신 부스와 내 작성 내용 비교' }).waitFor();
    await dialog.getByRole('button', { name: '최신 정보 사용', exact: true }).click();
    assert.equal(await dialog.locator('#booth-starts').inputValue(), '2026-11-12T13:00');
    assert.equal(await dialog.locator('#booth-ends').inputValue(), '2026-11-12T19:00');
    await dialog.locator('#booth-name').fill('시간 검증 부스 최신 시간 유지');
    await save();
    current = await read();
    assert.equal(current.startsAt, '2026-11-12T04:00:42.123Z');
    assert.equal(current.endsAt, '2026-11-12T19:00:30+09:00');
    await open();
    await dialog.locator('#booth-starts').fill('2026-11-12T14:00');
    const retryRequests = [];
    const track = request => {
      if (request.method() === 'POST' && request.url().endsWith('/commands')) {
        const body = request.postDataJSON();
        if (body?.command === 'booth.save') retryRequests.push(body);
      }
    };
    page.on('request', track);
    await page.route(`**/api/events/${f.eventId}/commands`, async route => {
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      await route.abort('failed');
    }, { times: 1 });
    await dialog.getByRole('button', { name: '부스 저장', exact: true }).click();
    const recovery = dialog.getByRole('region', { name: '현장 운영 처리 확인 필요' });
    await recovery.waitFor();
    await recovery.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.waitFor({ state: 'detached' });
    page.off('request', track);
    assert.equal(retryRequests.length, 2);
    assert.deepEqual(retryRequests[1], retryRequests[0]);
    current = await read();
    assert.equal(current.startsAt, '2026-11-12T14:00:00+09:00');
    assert.equal(current.endsAt, '2026-11-12T19:00:30+09:00');
    // Legacy time strings are left intact until the operator explicitly fixes them.
    const workspace = await readWorkspace();
    Object.assign(workspace.booths.find(item => item.id === boothId), { startsAt: '2026-11-12T09:00', endsAt: 'invalid-legacy' });
    workspace.stampMode = 'STAFF';
    const participant = workspace.participants.find(item => item.status === 'APPROVED' && item.ticket);
    assert.ok(participant);
    Object.assign(participant, { inside: true, everIn: true, paymentStatus: 'FREE', revoked: false,
      ticketExpiresAt: new Date(Date.now() + 86400000).toISOString() });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    await f.helpers.insertAssignment(f.harness.database, { id: 'schedule-booth-assignment', accountId: f.staff.id,
      eventId: f.eventId, type: 'BOOTH', targetId: boothId });
    const visit = () => f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.staff.cookie, body: { commandId: crypto.randomUUID(), command: 'booth.visit', assignmentId: 'schedule-booth-assignment',
        payload: { boothId, ticket: participant.ticket } },
    });
    const blockedVisit = await visit();
    assert.equal(blockedVisit.status, 409);
    assert.equal(blockedVisit.json.code, 'BOOTH_UNAVAILABLE');
    await page.reload({ waitUntil: 'networkidle' });
    await open();
    await dialog.getByText(/시간대 확인 필요/).waitFor();
    assert.equal(await dialog.locator('#booth-starts').inputValue(), '');
    assert.equal(await dialog.locator('#booth-ends').inputValue(), '');
    await dialog.locator('#booth-name').fill('시간 검증 부스 레거시 보존');
    await save();
    current = await read();
    assert.equal(current.startsAt, '2026-11-12T09:00'); assert.equal(current.endsAt, 'invalid-legacy');
    await open();
    await dialog.locator('#booth-starts').fill('2020-01-01T09:00');
    await dialog.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialog.getByRole('alert').filter({ hasText: '기존 시간의 시간대나 형식을 확인할 수 없습니다' }).waitFor();
    await dialog.getByRole('button', { name: '종료 시간 지우기', exact: true }).click();
    await save();
    current = await read();
    assert.equal(current.startsAt, '2020-01-01T09:00:00+09:00'); assert.equal(current.endsAt, '');
    const resumedVisit = await visit();
    assert.equal(resumedVisit.status, 201, JSON.stringify(resumedVisit.json));
    // Invalid calendar values are not silently normalized by Date.parse.
    const impossible = await readWorkspace();
    impossible.booths.find(item => item.id === boothId).startsAt = '2026-02-30T09:00:00+09:00';
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(impossible)]);
    await page.reload({ waitUntil: 'networkidle' });
    await open();
    await dialog.getByText(/확인 필요 \(2026-02-30T09:00:00\+09:00\)/).waitFor();
    assert.equal(await dialog.locator('#booth-starts').inputValue(), '');
    await dialog.locator('#booth-name').fill('시간 검증 부스 오류 원문 유지');
    await save();
    assert.equal((await read()).startsAt, '2026-02-30T09:00:00+09:00');
    await open();
    await dialog.getByRole('button', { name: '시작 시간 지우기', exact: true }).click();
    await save();
    assert.equal((await read()).startsAt, '');
    // Non-string legacy values remain distinguishable without exposing the
    // server's internal marker, and are repairable through the same editor.
    const nonString = await readWorkspace();
    nonString.booths.find(item => item.id === boothId).startsAt = { broken: 'legacy' };
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(nonString)]);
    await page.reload({ waitUntil: 'networkidle' });
    await open();
    await dialog.getByText(/시간 형식 확인 필요/).waitFor();
    assert.equal((await dialog.innerText()).includes('__invalid_booth_'), false);
    await dialog.locator('#booth-name').fill('시간 검증 부스 비문자 보존');
    await save();
    assert.deepEqual((await read()).startsAt, { broken: 'legacy' });
    await open();
    await dialog.getByRole('button', { name: '시작 시간 지우기', exact: true }).click();
    await save();
    assert.equal((await read()).startsAt, '');
    await page.getByRole('button', { name: '부스 추가', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: '부스 추가' });
    await createDialog.locator('#booth-name').fill('신규 시간 지정 부스');
    await createDialog.locator('#booth-starts').fill('2026-12-01T09:15');
    await createDialog.locator('#booth-ends').fill('2026-12-01T18:30');
    await createDialog.getByRole('button', { name: '부스 저장', exact: true }).click();
    await createDialog.waitFor({ state: 'detached' });
    const added = (await readWorkspace()).booths.find(item => item.name === '신규 시간 지정 부스');
    assert.equal(added.startsAt, '2026-12-01T09:15:00+09:00');
    assert.equal(added.endsAt, '2026-12-01T18:30:00+09:00');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, physicalDevices: false,
      build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), browserTimezone: 'America/Los_Angeles',
      checks: ['new booth schedule', 'unchanged seconds and offsets preserved', 'Korean time deterministic and visibly confirmed', 'empty input and chronology rejected', 'cancel preserves',
        'one-sided clear', 'both conflict choices', 'same-request receipt retry', 'legacy ambiguity blocks visits then explicit repair resumes',
        'impossible date and non-string legacy values explicitly repaired', 'keyboard and mobile axe'] }, null, 2), { mode: 0o600 });
    console.log('Booth schedule: editing, legacy values and concurrent conflict verified');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
