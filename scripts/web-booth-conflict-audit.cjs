'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { openLocationEditor } = require('./ui-journey-helpers.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'booth-conflict'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  let a;
  try {
    const secondId = `second-manager-${crypto.randomUUID()}`;
    await f.helpers.insertAccount(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id: secondId, role: 'MANAGER', name: '합성 운영자 B', email: `${secondId}@example.test` });
    await f.helpers.insertMembership(f.harness.database, secondId, f.eventId, ['all']);
    const secondCookie = await f.helpers.sessionCookie(f.harness, secondId);
    const command = async (command, payload) => {
      const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.equal(response.status, 200, JSON.stringify(response.json));
      return response.json;
    };
    await command('event.features', { features: ['stamp', 'draw', 'poll', 'reward', 'screen', 'venue'] });
    const created = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'booth.save', payload: { name: '합성 공동 부스', zone: 'A', status: 'OPEN', capacity: 30, limit: 1 } },
    });
    assert.equal(created.status, 201, JSON.stringify(created.json));
    const boothId = created.json.booth.id;
    const readWorkspace = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const retainLegacyTime = async () => {
      const workspace = await readWorkspace();
      const booth = workspace.booths.find(item => item.id === boothId);
      booth.startsAt = '2026-12-01T09:00:00'; delete booth.endsAt;
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    };
    await retainLegacyTime();
    browser = await launchBrowser();
    const contextA = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    const contextB = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await contextA.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    await contextB.addCookies([{ name: 'etko_session', value: decodeURIComponent(secondCookie.split('=')[1]), url: f.baseUrl }]);
    a = await contextA.newPage();
    const b = await contextB.newPage();
    for (const page of [a, b]) {
      page.setDefaultTimeout(12000);
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/operations?setup=1`, { waitUntil: 'networkidle' });
      // Reopened 2026-11-20: 부스 탭과 행의 '편집' 버튼이 사라지고 행 → 상세 시트 → '부스 편집'으로 열린다.
      await openLocationEditor(page, '부스', '합성 공동 부스');
      await page.getByRole('dialog', { name: '부스 편집' }).waitFor();
    }
    const dialogA = a.getByRole('dialog', { name: '부스 편집' });
    const dialogB = b.getByRole('dialog', { name: '부스 편집' });
    await dialogA.getByText(/시간대 확인 필요 \(2026-12-01T09:00:00\)/).waitFor();
    await dialogA.locator('#booth-name').fill('합성 A 작성 부스');
    await dialogB.locator('#booth-status').selectOption('CLOSED');
    await dialogB.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialogB.waitFor({ state: 'detached' });
    assert.equal((await readWorkspace()).booths.find(item => item.id === boothId).status, 'CLOSED');
    // Recreate the persisted pre-time-fields shape after B's change, so the
    // current projection must normalize the legacy row during conflict read.
    await retainLegacyTime();
    const [rejected] = await Promise.all([
      a.waitForResponse(response => response.url().endsWith('/commands') && response.request().postDataJSON()?.command === 'booth.save'),
      dialogA.getByRole('button', { name: '부스 저장', exact: true }).click(),
    ]);
    assert.equal(rejected.status(), 409);
    assert.equal((await rejected.json()).code, 'BOOTH_CHANGED');
    assert.equal(await dialogA.locator('#booth-name').inputValue(), '합성 A 작성 부스');
    a.once('dialog', dialog => dialog.dismiss());
    await dialogA.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await dialogA.locator('#booth-name').inputValue(), '합성 A 작성 부스');
    let partial = true;
    await a.route(`**/api/events/${f.eventId}/bootstrap`, async route => {
      if (!partial) return route.continue();
      partial = false;
      const response = await route.fetch();
      const json = await response.json();
      delete json.state.workspaces[f.eventId].booths.find(item => item.id === boothId).capacity;
      return route.fulfill({ response, json });
    });
    await dialogA.getByRole('button', { name: '최신 부스 확인', exact: true }).click();
    await dialogA.getByRole('alert').filter({ hasText: '최신 부스를 불러오지 못했습니다' }).waitFor();
    assert.equal(await dialogA.locator('#booth-name').inputValue(), '합성 A 작성 부스');
    await dialogA.getByRole('button', { name: '최신 부스 확인', exact: true }).click();
    await dialogA.getByText('최신 부스와 내 작성 내용 비교', { exact: true }).waitFor();
    assert.ok((await dialogA.innerText()).includes('종료'));
    assert.ok((await dialogA.innerText()).includes('합성 A 작성 부스'));
    assert.ok((await dialogA.innerText()).includes('시간대 확인 필요 (2026-12-01T09:00:00)'));
    const comparison = dialogA.getByRole('table', { name: '최신 부스와 내 작성 내용 비교' });
    const rowFor = label => comparison.locator('tbody tr').filter({ hasText: new RegExp(`^${label}`) });
    for (const changed of ['이름', '상태']) {
      assert.equal(await rowFor(changed).getByText('다름', { exact: true }).count(), 1, `${changed} must name the difference`);
    }
    for (const unchanged of ['구역', '수량', '1인 횟수']) {
      assert.equal(await rowFor(unchanged).getByText('다름', { exact: true }).count(), 0, `${unchanged} must not be marked different`);
    }
    const changedColor = await rowFor('상태').evaluate(node => getComputedStyle(node).backgroundColor);
    const normalColor = await rowFor('구역').evaluate(node => getComputedStyle(node).backgroundColor);
    assert.notEqual(changedColor, normalColor, 'different rows have a visual treatment in addition to text');
    await a.screenshot({ path: path.join(out, 'comparison-1280.png') });
    for (const width of [320, 390]) {
      await a.setViewportSize({ width, height: 844 });
      assert.ok(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await rowFor('상태').getByText('다름', { exact: true }).waitFor();
      await a.screenshot({ path: path.join(out, `comparison-${width}.png`) });
    }
    await dialogA.getByRole('button', { name: '최신 정보 사용', exact: true }).click();
    assert.equal(await dialogA.locator('#booth-status').inputValue(), 'CLOSED');
    assert.equal(await dialogA.locator('#booth-name').inputValue(), '합성 공동 부스');
    await dialogA.locator('#booth-name').fill('합성 A 검토 후 저장');
    await dialogA.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialogA.waitFor({ state: 'detached' });
    const saved = (await readWorkspace()).booths.find(item => item.id === boothId);
    assert.equal(saved.status, 'CLOSED'); assert.equal(saved.name, '합성 A 검토 후 저장');
    assert.equal(saved.startsAt, '2026-12-01T09:00:00'); assert.equal(saved.endsAt, '');
    // Exercise the other recovery choice too: retaining A's draft does not
    // write until A explicitly saves the reviewed full set of values.
    await openLocationEditor(a, '부스', '합성 A 검토 후 저장');
    await dialogA.locator('#booth-name').fill('합성 A 이어 쓰는 초안');
    await b.reload({ waitUntil: 'networkidle' });
    await openLocationEditor(b, '부스', '합성 A 검토 후 저장');
    await dialogB.locator('#booth-zone').fill('B 구역');
    await dialogB.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialogB.waitFor({ state: 'detached' });
    await dialogA.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialogA.getByRole('button', { name: '최신 부스 확인', exact: true }).click();
    await dialogA.getByText('최신 부스와 내 작성 내용 비교', { exact: true }).waitFor();
    assert.ok((await dialogA.innerText()).includes('B 구역'));
    await dialogA.getByRole('button', { name: '내 작성 내용으로 계속', exact: true }).click();
    assert.equal(await dialogA.locator('#booth-name').inputValue(), '합성 A 이어 쓰는 초안');
    assert.equal((await readWorkspace()).booths.find(item => item.id === boothId).zone, 'B 구역');
    await dialogA.getByRole('button', { name: '부스 저장', exact: true }).click();
    await dialogA.waitFor({ state: 'detached' });
    const final = (await readWorkspace()).booths.find(item => item.id === boothId);
    assert.equal(final.name, '합성 A 이어 쓰는 초안');
    assert.equal(final.status, 'CLOSED');
    assert.equal(final.startsAt, '2026-12-01T09:00:00');
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, physicalDevices: false,
      build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), checks: ['two managers conflict',
        'legacy missing end normalized', 'timezone-less time preserved', 'partial response rejected', 'cancel preserves draft',
        'changed rows named and colored', '320 and 390 comparison', 'latest selected before save', 'closed status retained', 'explicit retained draft save'] }, null, 2), { mode: 0o600 });
    console.log('Booth conflict: independent operators and legacy projection verified');
  } catch (error) {
    if (a) await a.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await f.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
