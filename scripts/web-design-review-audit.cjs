'use strict';

// Same fixture/data shape on both sides of a visual-only review. No existing
// deployment, retained user data or provider is touched. --before reads the
// incumbent production build; the default verifies the refined build.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const before = process.argv.includes('--before');
const out = (process.env.CAPTURE_DIR || '').trim()
  || path.join(defaultCaptureDir(`design-review-${runStamp()}`), before ? 'before' : 'after');

async function main() {
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const errors = [];
  const checks = [];
  const run = async (command, payload) => {
    const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload },
    });
    assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r));
    return r.json;
  };
  try {
    const ownerCookie = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
    const invitation = await f.helpers.requestJson(f.harness.baseUrl, '/api/auth/invitations', {
      method: 'POST', cookie: ownerCookie,
      body: { commandId: crypto.randomUUID(), name: '통합 감사 매니저', email: 'event-manager@example.test', role: 'MANAGER', eventId: f.eventId },
    });
    assert.ok([200, 201].includes(invitation.status), JSON.stringify(invitation));
    await run('event.features', { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp', 'survey', 'qa'] });
    await run('notice.save', { title: '동문 입장 안내', body: '참가자는 동문에서 티켓을 보여 주세요.', published: true });
    await run('booth.save', { name: '체험 부스', zone: '동문', status: 'OPEN', capacity: 100, limit: 1 });
    await run('module.save', { type: 'survey', title: '행사 만족도', questions: '전반 만족\n장소 만족' });
    await run('module.save', { type: 'qa', title: '운영자에게 질문' });
    await run('report.create', { title: '행사 결과', subtitle: '행사 운영 결과', summary: '현장 운영 결과를 기록합니다.', sections: ['overview', 'attendance'] });
    for (const [stage, name] of [['ENDED', '읽기전용 종료 행사'], ['ARCHIVED', '읽기전용 보관 행사']]) {
      const id = `design-${stage.toLowerCase()}-${f.suffix}`;
      await f.helpers.insertEvent(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id, slug: id,
        payload: { id, slug: id, name, stage, date: '2027-01-16', start: '09:00', end: '17:00', features: ['screen'] },
        workspace: f.helpers.emptyWorkspace(),
      });
    }
    browser = await launchBrowser();
    const context = await browser.newContext();
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(ownerCookie.slice('etko_session='.length)), url: f.baseUrl }]);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    const screens = [
      ['events', '/console', '#console-event-directory'],
      ['team', '/console/team', '#team-members'],
      ['content', `/console/events/${f.eventId}/content`, '#content-notices'],
      ['reports', `/console/events/${f.eventId}/reports`, '#reports-list'],
    ];
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      for (const [name, route, marker] of screens) {
        await page.goto(f.baseUrl + route, { waitUntil: 'networkidle' });
        await page.locator(marker).waitFor();
        await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name}/${width} overflow`);
        const targets = await page.locator('main button:visible').evaluateAll(els => els.map(el => {
          const r = el.getBoundingClientRect();
          return { name: el.textContent.trim(), width: r.width, height: r.height };
        }));
        // The baseline records incumbent defects; the delivered build must pass.
        if (!before) assert.ok(targets.every(t => t.width >= 44 && t.height >= 44), `${name}/${width}: target below 44px ${JSON.stringify(targets.filter(t => t.width < 44 || t.height < 44))}`);
        checks.push({ name, width, overflow: false, targets });
        if (!before && name === 'content') {
          const row = page.locator('li').filter({ has: page.getByRole('heading', { name: '동문 입장 안내', exact: true }) }).last();
          const remove = row.getByRole('button', { name: '삭제', exact: true });
          const edit = row.getByRole('button', { name: '편집', exact: true });
          assert.notEqual(await remove.evaluate(el => getComputedStyle(el).color), await edit.evaluate(el => getComputedStyle(el).color));
          await remove.focus();
          await page.keyboard.press('Enter');
          const confirm = row.getByRole('group', { name: '실행 확인' });
          await confirm.waitFor();
          const rowBounds = await row.boundingBox();
          const confirmBounds = await confirm.boundingBox();
          assert.ok(rowBounds && confirmBounds && confirmBounds.width > rowBounds.width * 0.8,
            `${width}: confirmation must occupy its own full-width row`);
          await page.screenshot({ path: path.join(out, `content-confirm-${width}.png`), fullPage: true });
          await confirm.getByRole('button', { name: '취소', exact: true }).click();
          await page.getByRole('heading', { name: '동문 입장 안내', exact: true }).waitFor();
          checks.push({ name: 'delete-confirm-cancel', width, preserved: true, keyboard: 'Enter' });
        }
        if (!before && name === 'team') {
          await page.getByText('event-manager@example.test', { exact: true }).waitFor();
          await page.getByText('담당 행사: 감사 검증 행사', { exact: true }).waitFor();
          checks.push({ name: 'team-full-identity', width, fieldsVisible: true });
        }
        if (!before && name === 'reports') {
          const cells = await page.locator('main table tbody tr:first-child td:last-child').evaluateAll(els => els.map(el => ({ align: getComputedStyle(el).textAlign, numeric: getComputedStyle(el).fontVariantNumeric })));
          assert.ok(cells.length && cells.every(c => c.align === 'right' && c.numeric.includes('tabular-nums')), JSON.stringify(cells));
          checks.push({ name: 'numeric-alignment', width, cells });
        }
      }
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ at: new Date().toISOString(), buildId: fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim(), role: 'AGENCY', simulation: 'isolated PostgreSQL fixture and Chromium; no provider delivery', checks, errors }, null, 2), { mode: 0o600 });
    console.log(`[design-review] ${checks.length} rendered/interaction checks passed (${before ? 'before' : 'after'})`);
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
