'use strict';
// Real writes against a disposable schema; response faults occur after commit.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { floorplanPng } = require('../tests/helpers/floorplan-image.cjs');
const before = process.argv.includes('--before');
const beforeMap = process.argv.includes('--before-map');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, beforeMap ? 'operations-map-before' : before ? 'operations-recovery-before' : 'operations-recovery');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser, page;
  try {
    const feature = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie, body: { commandId: 'audit-ops-stamp-feature', command: 'event.features', payload: { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp'] } },
    });
    assert.ok(feature.status >= 200 && feature.status < 300);
    const booth = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
      method: 'POST', cookie: fixture.manager.cookie, body: { commandId: 'audit-ops-booth-seed', command: 'booth.save', payload: { name: '합성 부스 위치', zone: 'A', status: 'WAITING', capacity: 0, limit: 1 } },
    });
    assert.ok(booth.status >= 200 && booth.status < 300);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('dialog', (dialog) => dialog.accept());
    const requests = new Map();
    const fileRequests = [];
    const partialFileRequests = [];
    await page.route('**/api/events/*/files?*', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const name = new URL(route.request().url()).searchParams.get('name');
      if (name === 'map-partial.png') {
        partialFileRequests.push(new URL(route.request().url()).searchParams.get('commandId'));
        if (partialFileRequests.length === 1) {
          const response = await route.fetch(); assert.ok(response.status() >= 200 && response.status() < 300);
          return route.fulfill({ status: 200, contentType: 'application/json', body: '{"file":{"fileId":"unrelated","name":"other.png","type":"image/png","size":1,"width":1,"height":1}}' });
        }
        return route.continue();
      }
      if (name !== 'map-recovery.png') return route.continue();
      fileRequests.push(new URL(route.request().url()).searchParams.get('commandId'));
      if (fileRequests.length === 1) { const response = await route.fetch(); assert.ok(response.status() >= 200 && response.status() < 300); return route.abort('failed'); }
      if (fileRequests.length === 2) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    await page.route('**/api/events/*/commands', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = route.request().postDataJSON();
      const key = body.command === 'desk.save' ? body.payload.name : body.command === 'staff.assign' ? 'assignment' : '';
      if (!key || (!key.startsWith('합성 운영 복구') && key !== 'assignment')) return route.continue();
      const prior = requests.get(key) || [];
      prior.push(body); requests.set(key, prior);
      if (prior.length === 1) {
        const response = await route.fetch();
        assert.ok(response.status() >= 200 && response.status() < 300, `${body.command} committed before response fault`);
        if (key.endsWith('부분 응답')) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
        return route.abort('failed');
      }
      if (prior.length === 2 && !key.endsWith('부분 응답')) return route.fulfill({ status: 403, contentType: 'application/json', body: '{"error":"접근을 확인하세요"}' });
      return route.continue();
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/operations`, { waitUntil: 'networkidle' });
    if (!before && !beforeMap) {
      phase = 'operation sections and keyboard navigation';
      const sections = page.locator('[data-workspace-section^="ops-"]:visible');
      const basic = ['ops-desks', 'ops-booths', 'ops-staff'];
      const boothSettings = ['ops-booth-mode', 'ops-booth-map'];
      const all = [...basic, 'ops-display', 'ops-participation', ...boothSettings];
      const sectionIds = () => sections.evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-labelledby')));
      await page.getByRole('heading', { name: '데스크', exact: true }).waitFor();
      assert.deepEqual(await sectionIds(), all);
      let navigationWrites = 0;
      const countWrite = request => {
        if (request.method() !== 'GET' && request.url().includes('/api/')) navigationWrites++;
      };
      page.on('request', countWrite);
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/operations#ops-booth-map`);
      const map = page.getByRole('region', { name: '부스 지도', exact: true });
      const details = map.locator('details');
      await map.locator('input[type="file"]').waitFor({ state: 'attached' });
      await page.waitForFunction(node => node.open, await details.elementHandle());
      for (const width of [1440, 1280, 390, 320]) {
        await page.setViewportSize({ width, height: 900 });
        const summary = details.locator('summary');
        await summary.focus();
        await page.keyboard.press('Enter');
        assert.equal(await details.evaluate(node => node.open), false);
        assert.equal(await summary.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Space');
        assert.equal(await details.evaluate(node => node.open), true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no overflow at ${width}`);
        await page.screenshot({ path: path.join(out, `navigation-${width}.png`) });
      }
      assert.equal(navigationWrites, 0, 'section navigation leaves the workspace unchanged');
      page.off('request', countWrite);
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/operations`);
      const featureCases = [
        { features: [], sections: basic },
        { features: ['poll'], sections: [...basic, 'ops-participation'] },
        { features: ['screen'], sections: [...basic, 'ops-display'] },
        { features: ['stamp'], sections: [...basic, ...boothSettings] },
        { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp'], sections: all },
      ];
      for (const [index, scenario] of featureCases.entries()) {
        const changed = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
          method: 'POST', cookie: fixture.manager.cookie,
          body: { commandId: `audit-ops-navigation-features-${index}`, command: 'event.features', payload: { features: scenario.features } },
        });
        assert.ok(changed.status >= 200 && changed.status < 300, `feature case ${index} is accepted`);
        await page.reload({ waitUntil: 'networkidle' });
        await page.getByRole('heading', { name: '데스크', exact: true }).waitFor();
        assert.deepEqual(await sectionIds(), scenario.sections);
      }
    }
    if (beforeMap) {
      const mapSection = page.getByRole('region', { name: '부스 지도', exact: true });
      await mapSection.locator('summary').click();
      const input = mapSection.locator('input[type="file"]');
      await input.setInputFiles({ name: 'map-before-a.png', mimeType: 'image/png', buffer: floorplanPng() });
      const image = mapSection.getByRole('img', { name: '부스 배치도' });
      await image.waitFor();
      const firstSource = await image.getAttribute('src');
      const row = mapSection.locator('li').filter({ hasText: '합성 부스 위치' });
      await row.getByRole('button', { name: '위치 지정', exact: true }).click();
      await image.click({ position: { x: 20, y: 20 } });
      await row.getByText('위치 지정됨').waitFor();
      await input.setInputFiles({ name: 'map-before-b.png', mimeType: 'image/png', buffer: floorplanPng() });
      await page.waitForFunction((source) => { const image = document.querySelector('img[alt="부스 배치도"]'); return image && image.getAttribute('src') !== source; }, firstSource);
      await row.getByText('위치 지정됨').waitFor();
      await page.screenshot({ path: path.join(out, 'before-replacement-1280.png'), fullPage: true });
      console.log('Map replacement before capture: old location remains on a different unsaved image');
      return;
    }
    const workspace = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const dialog = page.getByRole('dialog');
    const panel = page.getByRole('region', { name: '현장 운영 처리 확인 필요' });
    async function startDesk(name) {
      await page.getByRole('button', { name: '데스크 추가', exact: true }).click();
      await dialog.locator('#desk-name').fill(name);
      await dialog.getByRole('button', { name: '데스크 저장', exact: true }).click();
    }
    const first = '합성 운영 복구 원래 요청';
    phase = 'desk loss';
    await startDesk(first);
    if (before) {
      await dialog.getByRole('alert').first().waitFor();
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: path.join(out, 'before-unconfirmed-390.png'), fullPage: true });
      console.log('Operations recovery before capture passed');
      return;
    }
    await panel.waitFor();
    assert.equal(await dialog.locator('#desk-name').isDisabled(), true);
    assert.equal(await dialog.getByRole('button', { name: '데스크 저장' }).isDisabled(), true);
    await page.getByRole('region', { name: '처리 결과 확인' }).waitFor({ state: 'hidden' });
    const denied = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await denied;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
    assert.equal(await dialog.locator('#desk-name').isDisabled(), true, 'later 403 does not settle the lost write');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'unconfirmed-390.png'), fullPage: true });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.evaluate(axeSource);
    assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await panel.waitFor();
    const addBooth = page.getByRole('button', { name: '부스 추가', exact: true });
    await addBooth.scrollIntoViewIfNeeded();
    assert.equal(await addBooth.isDisabled(), true, 'the unsettled desk write also locks the booth section');
    await panel.waitFor();
    const beforeStatus = requests.get(first).length;
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await panel.waitFor({ state: 'hidden' });
    assert.equal(requests.get(first).length, beforeStatus, 'status check sends no write');
    assert.equal(new Set(requests.get(first).map((body) => body.commandId)).size, 1);
    assert.equal((await workspace()).desks.filter((item) => item.name === first).length, 1);

    phase = 'partial response then exact retry';
    await page.setViewportSize({ width: 1280, height: 900 });
    const second = '합성 운영 복구 부분 응답';
    await startDesk(second);
    await panel.waitFor();
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get(second).map((body) => body.commandId)).size, 1);
    assert.equal(new Set(requests.get(second).map((body) => JSON.stringify(body.payload))).size, 1);
    assert.equal((await workspace()).desks.filter((item) => item.name === second).length, 1);

    phase = 'staff assignment retains target and id';
    await page.getByRole('button', { name: `${first}에 스태프 배정` }).click();
    await dialog.locator('#assign-account').selectOption(fixture.staff.id);
    const targetId = await dialog.locator('#assign-target').inputValue();
    await dialog.getByRole('button', { name: '배정 저장' }).click();
    await panel.waitFor();
    const deniedAssignment = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/commands'));
    await panel.getByRole('button', { name: '같은 요청 다시 시도' }).click();
    await deniedAssignment;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 요청 다시 시도' && !button.disabled));
    await panel.getByRole('button', { name: '서버 처리 확인' }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(new Set(requests.get('assignment').map((body) => body.commandId)).size, 1);
    assert.equal(new Set(requests.get('assignment').map((body) => JSON.stringify(body.payload))).size, 1);
    const assigned = await fixture.harness.database.query('SELECT id FROM staff_assignments WHERE event_id=$1 AND account_id=$2 AND target_id=$3 AND active=true', [fixture.eventId, fixture.staff.id, targetId]);
    assert.equal(assigned.rowCount, 1);

    phase = 'map file retains original upload after response loss';
    const mapSection = page.getByRole('region', { name: '부스 지도', exact: true });
    await mapSection.locator('summary').click();
    const mapFile = mapSection.locator('input[type="file"]');
    await mapFile.setInputFiles({ name: 'map-recovery.png', mimeType: 'image/png', buffer: floorplanPng() });
    const filePanel = page.getByRole('region', { name: '지도 파일 확인 필요' });
    await filePanel.waitFor();
    assert.equal(await mapFile.isDisabled(), true);
    const deniedFile = page.waitForResponse((item) => item.status() === 403 && item.url().includes('/files?'));
    await filePanel.getByRole('button', { name: '같은 파일 요청 다시 시도' }).click();
    await deniedFile;
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '같은 파일 요청 다시 시도' && !button.disabled));
    await filePanel.getByRole('button', { name: '같은 파일 요청 다시 시도' }).click();
    await filePanel.waitFor({ state: 'hidden' });
    assert.equal(new Set(fileRequests).size, 1);
    const uploaded = await fixture.harness.database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'map-recovery.png']);
    assert.equal(uploaded.rowCount, 1);
    assert.match(await mapSection.getByRole('img', { name: '부스 배치도' }).getAttribute('src'), new RegExp(uploaded.rows[0].id));
    const boothRow = mapSection.locator('li').filter({ hasText: '합성 부스 위치' });
    await boothRow.getByRole('button', { name: '위치 지정', exact: true }).click();
    await mapSection.getByRole('img', { name: '부스 배치도' }).click({ position: { x: 20, y: 20 } });
    await boothRow.getByText('위치 지정됨').waitFor();
    await mapFile.setInputFiles({ name: 'map-partial.png', mimeType: 'image/png', buffer: floorplanPng() });
    await filePanel.waitFor();
    await filePanel.getByRole('button', { name: '같은 파일 요청 다시 시도' }).click();
    await filePanel.waitFor({ state: 'hidden' });
    assert.equal(new Set(partialFileRequests).size, 1);
    const partialFile = await fixture.harness.database.query('SELECT id FROM stored_files WHERE event_id=$1 AND original_name=$2', [fixture.eventId, 'map-partial.png']);
    assert.equal(partialFile.rowCount, 1);
    assert.match(await mapSection.getByRole('img', { name: '부스 배치도' }).getAttribute('src'), new RegExp(partialFile.rows[0].id));
    await boothRow.getByText('위치 미지정').waitFor();
    await page.getByText('배치도를 교체했습니다. 부스 위치를 다시 지정한 뒤 저장하세요.').waitFor();
    await page.screenshot({ path: path.join(out, 'map-replaced-1280.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(out, 'map-replaced-390.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    phase = 'reload retains only scoped pointer';
    const third = '합성 운영 복구 새로고침';
    await startDesk(third);
    await panel.waitFor();
    const stored = await page.evaluate(() => sessionStorage.getItem('eventouch.receipts.operator') || '');
    assert.ok(stored.includes('desk.save') && !stored.includes(third));
    await page.reload({ waitUntil: 'networkidle' });
    const shared = page.getByRole('region', { name: '처리 결과 확인' });
    await shared.waitFor();
    assert.equal(await page.getByRole('button', { name: '데스크 추가', exact: true }).isDisabled(), true);
    const beforeReloadCheck = requests.get(third).length;
    await shared.getByRole('button', { name: '서버 처리 확인' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some((button) => button.textContent?.trim() === '데스크 추가' && !button.disabled));
    await page.getByText(third, { exact: true }).first().waitFor();
    assert.equal(requests.get(third).length, beforeReloadCheck);
    assert.equal((await workspace()).desks.filter((item) => item.name === third).length, 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', isolated: true, frozenPayload: true, after403: true, staffTargetPreserved: true, mapFileSameId: true, statusOnly: true, noContentPersisted: true, duplicates: 0 }, null, 2), { mode: 0o600 });
    console.log('Operations: desk and staff recovery preserve the original request and target');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
