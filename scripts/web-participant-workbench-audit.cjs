'use strict';

// Real participant commands and isolated PostgreSQL; no production service or
// synthetic API successes. --before captures the incumbent production build.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const axe = require('axe-core').source;
const before = process.argv.includes('--before');
const OUT = path.join(process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`participant-workbench-20261027-${runStamp()}`), before ? 'before' : 'after');

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const buildId = fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim();
  const checks = [], errors = [];
  const check = (name, condition, detail = null) => { checks.push({ name, ok: Boolean(condition), detail }); assert.ok(condition, `${name}: ${JSON.stringify(detail)}`); };
  let fixture, browser, completed = false;
  try {
    fixture = await startAuditFixture({ loseFirstResponseFor: before ? null : ['participant.status', 'group.assign'] });
    const f = fixture, route = `/console/events/${f.eventId}/participants`, base = `${f.baseUrl}${route}`;
    const request = (url, options = {}) => f.helpers.requestJson(f.harness.baseUrl, url, { cookie: f.manager.cookie, ...options });
    const command = async (command, payload) => {
      const r = await request(`/api/events/${f.eventId}/commands`, { method: 'POST', body: { commandId: crypto.randomUUID(), command, payload } });
      assert.equal(r.status, 200, JSON.stringify(r.json)); return r.json;
    };
    const workspace = async () => (await request('/api/bootstrap')).json.state.workspaces[f.eventId];
    await command('participant.import', { rows: ['김하늘', '이지훈', '박서연', '정민수', '신예린', '배준서'].map((name, i) => ({ name, company: ['모먼트랩', '스튜디오 온', '리프컴퍼니'][i % 3], phone: `0105555${String(i + 1).padStart(4, '0')}` })) });
    let people = (await workspace()).participants;
    const pending = people.slice(-6, -2), waiting = people.slice(-2);
    await command('participant.status', { ids: pending.map(p => p.id), status: 'PENDING' });
    await command('participant.status', { ids: waiting.map(p => p.id), status: 'WAITLIST' });
    browser = await launchBrowser();
    const context = await browser.newContext({ reducedMotion: 'reduce', timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    const loaded = async (url = base) => { await page.goto(url, { waitUntil: 'networkidle' }); await page.locator('#roster-search').waitFor(); };
    const shot = async (name, width, scan = true) => {
      await page.evaluate(() => document.fonts.ready); await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `${name}-${width}-viewport.png`) });
      await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: true });
      check(`${name}@${width}: no document overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      if (scan) { await page.evaluate(axe); const v = await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['moderate', 'serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) }))); check(`${name}@${width}: axe moderate+`, v.length === 0, v); }
    };

    for (const width of [1440, 1280, 390, 320]) {
      await page.setViewportSize({ width, height: width > 768 ? 900 : 844 }); await loaded();
      if (!before) {
        check(`header@${width}: task title precedes event context`, await page.locator('main header').first().evaluate(el => el.querySelector('h1').getBoundingClientRect().top < el.querySelector('a').getBoundingClientRect().top));
        const table = page.getByRole('table', { name: /참가자 목록/ });
        check(`roster@${width}: correct responsive data surface`, width > 768 ? await table.isVisible() : await page.locator('li[class*="participantRow"]').first().isVisible());
        check(`roster@${width}: no permanent inspector`, await page.locator('[class*="rosterInspector"]').count() === 0);
        if (width > 768) check(`roster@${width}: table owns width`, await table.evaluate(el => el.getBoundingClientRect().width / el.closest('main').getBoundingClientRect().width > .85));
        // The meta row must never squeeze its count into a syllable-wide
        // column beside the nowrap controls, nor strand the scope caption
        // apart from its select button. Geometry, not screenshots: count
        // width, Range line boxes, and caption/button row alignment.
        const metaCountWidth = await page.locator('.participant-count').evaluate(el => el.getBoundingClientRect().width);
        check(`roster@${width}: meta count keeps a readable width`, metaCountWidth >= 120, { width: metaCountWidth });
        const metaCountLines = await page.locator('.participant-count').evaluate(el => { const range = document.createRange(); range.selectNodeContents(el); return range.getClientRects().length; });
        check(`roster@${width}: meta count avoids letter-by-letter wrapping`, metaCountLines <= 3, { lines: metaCountLines });
        // A 16–20px caption vertically centered beside a 44px button
        // differs in `top` by 10px+ on a healthy row, so same-row means
        // vertical overlap (shared span), not equal tops. A caption
        // stranded on another flex line shares no vertical span and fails.
        if (width > 768) {
          const scopeRow = await page.locator('[class*="scopeGroup"]').evaluate(el => {
            const caption = el.querySelector('[class*="scopeLabel"]').getBoundingClientRect();
            const button = el.querySelector('button').getBoundingClientRect();
            return { overlap: Math.min(caption.bottom, button.bottom) - Math.max(caption.top, button.top) };
          });
          check(`roster@${width}: scope caption stays on its button's line`, scopeRow.overlap >= 8, scopeRow);
        } else {
          const scope = page.getByText('여러 명 선택', { exact: true });
          const bounds = await scope.boundingBox();
          check(`roster@${width}: scope disclosure is visible and touch-sized`, await scope.isVisible() && bounds?.height >= 44, bounds);
        }
      }
      await shot('roster', width);
    }
    if (before) { completed = true; return; }
    await page.setViewportSize({ width: 1280, height: 900 }); await loaded();
    await page.getByRole('checkbox', { name: `${pending[0].name} 선택`, exact: true }).check();
    await page.getByRole('checkbox', { name: `${pending[1].name} 선택`, exact: true }).check();
    await page.locator('#roster-search').fill(pending[1].name);
    check('hidden selection named', (await page.locator('#roster-selection-count').innerText()).includes('숨김 1명'));
    const handoff = page.locator('#roster-send-message');
    check('message handoff preserves full exact selection', new URL(await handoff.getAttribute('href'), base).searchParams.get('to').split(',').sort().join(',') === pending.slice(0, 2).map(p => p.id).sort().join(','));
    await shot('selected-scope', 1280);
    await page.locator('#roster-filter-toggle').click();
    await page.locator('#roster-filter-reset').click();
    check('reset retains selection', (await page.locator('#roster-selection-count').innerText()).includes('선택한 참가자 2명'));
    await page.locator('#roster-search').fill(pending[1].name);
    await page.getByRole('button', { name: '그룹 지정', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('그룹', { exact: true }).selectOption('VIP');
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await f.gateway.waitForResponseLoss('group.assign');
    await dialog.getByText(/같은 요청으로 다시 시도|같은 내용으로 다시 시도/).waitFor();
    await dialog.getByRole('button', { name: '지정', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const groupRequests = f.gateway.commands.filter(c => c.command === 'group.assign');
    check('group response loss reuses receipt', groupRequests.length === 2 && groupRequests[0].commandId === groupRequests[1].commandId);
    people = (await workspace()).participants;
    check('group assignment excludes hidden selection', people.find(p => p.id === pending[1].id).group === 'VIP' && people.find(p => p.id === pending[0].id).group !== 'VIP');
    check('proven group success clears its completed selection', !await page.locator('#roster-selection-count').count());
    await loaded();
    const approveRow = page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `${pending[0].name} 선택`, exact: true }) });
    await approveRow.getByRole('button', { name: '승인', exact: true }).click();
    await f.gateway.waitForResponseLoss('participant.status');
    await page.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true }).click();
    await page.getByText(`${pending[0].name} 상태를 참가 확정`, { exact: false }).first().waitFor();
    const statusRequests = f.gateway.commands.filter(c => c.command === 'participant.status');
    check('single approval reuses lost-response receipt', statusRequests.length === 2 && statusRequests[0].commandId === statusRequests[1].commandId);
    check('approval persisted', (await workspace()).participants.find(p => p.id === pending[0].id).status === 'APPROVED');
    await page.reload(); await page.locator('#roster-search').waitFor();
    check('approval survives reload', !await page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: `${pending[0].name} 선택`, exact: true }) }).getByRole('button', { name: '승인', exact: true }).count());
    const detailButton = page.getByRole('button', { name: `${pending[1].name} 참가자 상세`, exact: true });
    await detailButton.click(); await dialog.getByRole('heading', { name: pending[1].name, exact: true }).waitFor();
    await shot('detail', 1280);
    await dialog.getByLabel(`${pending[1].name} 상태 변경`, { exact: true }).selectOption('CANCELLED');
    check('cancellation requires explicit confirm', (await workspace()).participants.find(p => p.id === pending[1].id).status === 'PENDING');
    await dialog.getByRole('button', { name: '취소', exact: true }).click();
    await page.keyboard.press('Escape');
    check('detail Escape restores trigger focus', await detailButton.evaluate(el => el === document.activeElement));
    await page.getByRole('button', { name: /참가자.*이름순 정렬/ }).click();
    check('table sort reports ascending', await page.locator('th[aria-sort="ascending"]').count() === 1);
    await page.getByText('명단 도구', { exact: true }).click();
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: /CSV 내보내기/ }).click();
    check('CSV download remains real', (await download).suggestedFilename() === 'EVENTOUCH_participants.csv');

    // Initial failure and slow loading are transport faults, not fake API
    // success. Retrying reads the same real fixture and keeps route readiness.
    const scopedBootstrap = `**/api/events/${f.eventId}/bootstrap`;
    await page.route(scopedBootstrap, r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '검수용 연결 실패' }) }));
    await page.reload(); await page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor(); await shot('load-error', 1280);
    await page.unroute(scopedBootstrap); await page.getByRole('button', { name: '다시 불러오기', exact: true }).click(); await page.locator('#roster-search').waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#roster-search').fill('없는참가자999'); await shot('no-match', 390);
    check('empty search keeps reset reachable', await page.getByRole('button', { name: '검색·필터 초기화', exact: true }).isVisible());
    const emptyId = `${f.eventId}-empty`;
    await f.helpers.insertEvent(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id: emptyId, slug: emptyId,
      payload: { id: emptyId, slug: emptyId, name: '빈 명단 검수 행사', stage: 'LIVE' }, workspace: f.helpers.emptyWorkspace() });
    await f.helpers.insertMembership(f.harness.database, f.manager.id, emptyId, ['all']);
    await loaded(`${f.baseUrl}/console/events/${emptyId}/participants`);
    await page.getByRole('heading', { name: '아직 등록된 참가자가 없습니다.', exact: true }).waitFor();
    check('empty roster has one reachable create action', await page.getByRole('button', { name: '참가자 추가', exact: true }).count() === 1);
    await shot('empty', 390);
    check('runtime errors', errors.length === 0, errors);
    check('same build throughout', fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim() === buildId);
    completed = true;
  } finally {
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({ buildId, before, completed, checks, errors, disclosures: ['isolated API/PostgreSQL synthetic fixture', 'Chromium; not real-device or screen-reader listening', 'no external delivery, no production modification'] }, null, 2), { mode: 0o600 });
    if (browser) await browser.close();
    if (fixture) await fixture.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
