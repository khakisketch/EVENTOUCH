'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { defaultCaptureDir, prepareCaptureDir, ensureRunTmpDir, runStamp } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk } = require('./audit-staff-direction.cjs');

async function main() {
  const out = process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'nametag')
    : defaultCaptureDir(`nametag-${runStamp()}`);
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  let page;
  const checks = [];
  const errors = [];
  const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
  const readWorkspace = async () => (await fixture.harness.database.query(
    'SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId],
  )).rows[0].payload;

  try {
    const workspace = await readWorkspace();
    const person = workspace.participants[0];
    const long = workspace.participants[1];
    long.name = '긴이름'.repeat(20);
    long.company = '긴소속'.repeat(66);
    await fixture.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    async function open(role, viewport) {
      const context = await browser.newContext({ viewport, locale: 'ko-KR', reducedMotion: 'reduce' });
      await context.addCookies([{ ...cookieForContext(fixture, role), url: fixture.baseUrl }]);
      const target = await context.newPage();
      target.setDefaultTimeout(12000);
      target.on('pageerror', error => errors.push(error.message));
      await target.addInitScript(() => { window.print = () => { window.__printCalls = (window.__printCalls || 0) + 1; }; });
      return target;
    }
    const preview = () => page.getByRole('region', { name: '네임택 미리보기', exact: true });
    const paper = () => preview().getByLabel('용지 규격', { exact: true });
    const print = () => preview().getByRole('button', { name: '인쇄하기', exact: true });
    const visibleText = () => page.locator('[data-nametag-output]').innerText();
    async function inspectA11y(name) {
      await page.evaluate(axeSource);
      const problems = await page.evaluate(async () => (await window.axe.run()).violations
        .filter(item => ['moderate', 'serious', 'critical'].includes(item.impact)).map(item => item.id));
      check(`${name} accessibility: ${problems.join(', ')}`, !problems.length);
      check(`${name} has no horizontal overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    }
    async function capturePrint(name, format, width, height, identity) {
      await paper().selectOption(format);
      const previousCalls = await page.evaluate(() => window.__printCalls || 0);
      await print().click();
      await page.waitForFunction((previous) => (window.__printCalls || 0) === previous + 1, previousCalls);
      check(`${name} requests native print once`, await page.evaluate(() => window.__printCalls) === previousCalls + 1);
      await page.emulateMedia({ media: 'print' });
      try {
        const output = page.locator('[data-nametag-output]');
        check(`${name} isolates the current label`, await output.isVisible() && await page.evaluate(() => Array.from(document.body.children)
          .every(node => node.hasAttribute('data-nametag-output') || getComputedStyle(node).display === 'none')));
        const content = await visibleText();
        check(`${name} fills the saved name and company without phone or QR`, content.includes(identity.name) && content.includes(identity.company) &&
          !content.includes(identity.phone) && await output.locator('svg').count() === 0);
        const pdf = (await page.pdf({ path: path.join(out, name + '.pdf'), preferCSSPageSize: true, printBackground: true })).toString('latin1');
        const boxes = [...pdf.matchAll(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/g)];
        const points = mm => mm * 72 / 25.4;
        check(`${name} one page and paper size ${boxes.map(box => box.slice(1)).join(', ')}`, (pdf.match(/\/Type\s*\/Page\b/g) || []).length === 1 && boxes.length === 1 &&
          Math.abs(Number(boxes[0][1]) - points(width)) < 1.5 && Math.abs(Number(boxes[0][2]) - points(height)) < 1.5);
      } finally {
        await page.emulateMedia({ media: 'screen' });
        await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
      }
      await page.locator('[data-nametag-output]').waitFor({ state: 'detached' });
      check(`${name} restores the page and allows another print`, await print().isEnabled() && !await page.evaluate(() => document.body.classList.contains('nametag-printing')));
    }

    page = await open('manager', { width: 1280, height: 900 });
    const commands = [];
    page.on('request', request => {
      if (request.method() === 'POST' && request.url().endsWith('/commands')) commands.push(request.postDataJSON());
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`, { waitUntil: 'networkidle' });
    async function openRosterTag(identity) {
      await page.locator('#roster-search').fill(identity.name);
      await page.getByRole('button', { name: `${identity.name} 참가자 상세`, exact: true }).click();
      await page.getByRole('dialog').getByText('네임택 인쇄', { exact: true }).click();
      await preview().waitFor();
    }
    await openRosterTag(person);
    await inspectA11y('roster preview desktop');
    await preview().scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(out, 'roster-nametag-1280.png') });
    await capturePrint('a4', 'a4', 210, 297, person);
    await capturePrint('label90', 'label90', 90, 60, person);
    await capturePrint('label100', 'label100', 100, 70, person);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await openRosterTag(long);
    await paper().selectOption('label90');
    await preview().getByText(/문구가 라벨에 모두 들어가지 않습니다/).waitFor();
    check('long valid text blocks a clipped small label', await print().isDisabled());
    await capturePrint('long-a4', 'a4', 210, 297, long);
    check('roster preview and repeat print issue no event write', commands.length === 0);

    page = await open('staff', { width: 390, height: 844 });
    await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`, { waitUntil: 'networkidle' });
    await confirmInitialStaffDesk(page);
    await page.locator('#staff-ticket').fill(person.ticket);
    await page.getByRole('button', { name: '입장 처리', exact: true }).click();
    const result = page.getByRole('region', { name: '스캔 결과 상세', exact: true });
    await result.getByRole('button', { name: '네임택 인쇄', exact: true }).click();
    await preview().waitFor();
    // The staff name and company are now shown after the authoritative
    // post-scan identity read completes, not immediately on opening.
    await preview().getByText(person.name, { exact: true }).waitFor();
    await print().waitFor({ state: 'visible' });
    assert.equal(await print().isEnabled(), true);
    check('staff preview follows the one persisted check-in', (await readWorkspace()).checks.length === 1 && (await preview().innerText()).includes(person.name));
    check('staff preview receives focus', await preview().evaluate(node => document.activeElement === node));
    await inspectA11y('staff preview mobile');
    await page.screenshot({ path: path.join(out, 'staff-nametag-390.png') });
    await capturePrint('staff-label90', 'label90', 90, 60, person);
    await result.getByRole('button', { name: '다음 참가자', exact: true }).click();
    await preview().waitFor({ state: 'detached' });
    check('the next check-in removes the previous label', await preview().count() === 0 && (await readWorkspace()).checks.length === 1);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({
      build: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(), checks, errors, synthetic: true, physicalPrinter: false,
    }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ checks: checks.length, output: out }));
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
