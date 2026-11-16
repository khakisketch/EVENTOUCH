'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const axe = require('axe-core').source;
async function main() {
  const out = process.env.EVENTOUCH_CAPTURE_ROOT ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'delivery-ui') : defaultCaptureDir(`delivery-ui-${runStamp()}`);
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  process.env.EVENTOUCH_LOGIN_HISTORY_DAYS = '14';
  const checks = [], errors = []; const check = (name, ok) => { assert.ok(ok, name); checks.push(name); };
  let f, browser;
  try {
    f = await startAuditFixture({ loseFirstResponseFor: ['response.grade'] });
    await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload,'{features}',(payload->'features') || '[\"quiz\"]'::jsonb) WHERE id=$1", [f.eventId]);
    const command = async (name, payload) => {
      const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command: name, payload } });
      assert.ok(r.status === 200 || r.status === 201, JSON.stringify(r.json)); return r.json;
    };
    const module = (await command('module.save', { type: 'quiz', title: '주관식 채점 검수', answer: '정답' })).module;
    await command('module.status', { id: module.id, status: 'CLOSED' });
    const workspace = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    workspace.responses.push({ id: 'delivery-quiz-response', moduleId: module.id, participantId: workspace.participants[0].id, answer: '정 답' });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2 WHERE event_id=$1', [f.eventId, workspace]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)), url: f.baseUrl }]);
    const p = await context.newPage(); p.on('pageerror', e => errors.push(e.message));
    const scan = async name => {
      await p.evaluate(axe); const violations = await p.evaluate(async () => (await axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id));
      check(`${name}: no blocking accessibility violations`, violations.length === 0);
      check(`${name}: no horizontal overflow`, await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const small = await p.locator('button:not(:disabled), summary').evaluateAll(elements => elements.filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44); }).map(el => el.textContent.trim().slice(0, 60)));
      check(`${name}: controls meet 44px targets`, small.length === 0);
    };
    await p.goto(`${f.baseUrl}/console/events/${f.eventId}/programs`, { waitUntil: 'networkidle' });
    const card = p.locator('li').filter({ has: p.getByRole('heading', { name: '주관식 채점 검수', exact: true }) }).first();
    // The row itself is the disclosure now; the manual-grading fold sits inside it.
    const open = async () => {
      const row = card.locator(':scope > details').first();
      if (!await row.evaluate(el => el.open)) await row.locator(':scope > summary').click();
      const grading = card.locator('summary').filter({ hasText: '응답별 수동 채점' }).first();
      if (!await grading.evaluate(el => el.parentElement.open)) await grading.click();
    };
    await open();
    const attempts = []; p.on('request', r => { if (r.method() === 'POST' && r.url().endsWith('/commands')) { const body = r.postDataJSON(); if (body.command === 'response.grade') attempts.push(body); } });
    await card.getByRole('button', { name: '응답 1 정답 처리', exact: true }).click();
    await f.gateway.waitForResponseLoss('response.grade');
    const retry = p.getByRole('button', { name: '같은 채점 다시 확인', exact: true }); await retry.waitFor();
    check('unconfirmed grading freezes all other grade actions', await card.getByRole('button', { name: '응답 1 오답 처리', exact: true }).isDisabled());
    // The list search only appears past eight rows; with fewer there is nothing to filter the recovery away.
    const search = p.getByRole('searchbox', { name: '콘텐츠 검색', exact: true });
    if (await search.count()) { await search.fill('검색 결과 없음'); check('filtering cannot hide the unconfirmed grade recovery', await retry.isVisible()); await search.fill(''); }
    else check('the unconfirmed grade recovery stays visible without a list filter', await retry.isVisible());
    const endpoint = `**/api/events/${f.eventId}/commands`; let faults = 0;
    await p.route(endpoint, async route => { if (route.request().postDataJSON()?.command !== 'response.grade') return route.continue(); faults++; await route.fulfill({ status: faults === 1 ? 429 : 200, contentType: 'application/json', body: faults === 1 ? '{"error":"잠시 후 다시 시도하세요"}' : '{}' }); });
    await retry.click();
    await p.getByRole('button', { name: '같은 채점 다시 확인', exact: true }).waitFor({ state: 'visible' });
    // Playwright's enabled assertion waits for React to finish the rejected attempt.
    await p.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '같은 채점 다시 확인' && !b.disabled));
    await retry.click();
    await p.waitForFunction(() => [...document.querySelectorAll('button')].some(b => b.textContent === '같은 채점 다시 확인' && !b.disabled));
    check('a rejected retry and incomplete success preserve the original request', attempts.length === 3 && attempts.every(a => JSON.stringify(a) === JSON.stringify(attempts[0])));
    await p.unroute(endpoint); await retry.click(); await retry.waitFor({ state: 'hidden' });
    check('receipt recovery reuses the original command', attempts.length === 4 && attempts.every(a => JSON.stringify(a) === JSON.stringify(attempts[0])));
    await open();
    check('manual grading overrides exact-text comparison', await card.getByText('정답 1 · 오답 0 · 미채점 0', { exact: true }).isVisible());
    for (const width of [1280, 390]) {
      await p.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await scan(`quiz-${width}`);
      await p.screenshot({ path: path.join(out, `quiz-${width}.png`), fullPage: true });
    }
    await card.getByRole('button', { name: '응답 1 자동 비교로 복원', exact: true }).click();
    await card.getByText('정답 0 · 오답 1 · 미채점 0', { exact: true }).waitFor(); check('automatic comparison can be restored', true);
    const response = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.responses.find(r => r.id === 'delivery-quiz-response');
    check('retries save one manual grade, then one explicit restoration', response.gradeVersion === 2 && response.manualGrade === null);
    const login = await f.helpers.requestJson(f.harness.baseUrl, '/api/auth/login', { method: 'POST', body: { email: f.manager.email, password: f.manager.password } }); assert.equal(login.status, 200);
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(login.headers.get('set-cookie').split(';')[0].slice('etko_session='.length)), url: f.baseUrl }]);
    await p.goto(`${f.baseUrl}/account/email`, { waitUntil: 'networkidle' }); await p.getByText('최근 로그인', { exact: true }).click();
    await p.getByText('최근 14일 이내의 로그인 중 최신 20건입니다.', { exact: true }).waitFor();
    check('the account holder can read a real successful-login timestamp', await p.locator('time[datetime]').count() === 1);
    for (const width of [1280, 390]) { await p.setViewportSize({ width, height: width === 390 ? 844 : 900 }); await scan(`login-history-${width}`); await p.screenshot({ path: path.join(out, `login-history-${width}.png`), fullPage: true }); }
    check('no runtime errors', errors.length === 0);
    const report = { ok: true, build: fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim(), checks, errors, boundary: 'isolated synthetic API/PostgreSQL and Chromium; no real devices or provider delivery' };
    fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); process.stdout.write(`delivery UI: ${checks.length} checks passed\n`);
  } finally { await browser?.close(); await f?.close(); }
}
if (require.main === module) main().catch(error => { process.stderr.write(`[delivery-ui] ${error.message}\n`); process.exitCode = 1; });
