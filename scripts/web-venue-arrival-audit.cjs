'use strict';

// Venue arrival end to end on an isolated fixture: a participant phone arrives from a desk
// poster, the desk laptop prints and hands over, two laptops never print twice, an on-site
// signup and a staff line scan reach the same list, review and no-name-tag desks behave, and
// the poster prints on whatever paper is chosen. Print is intercepted: no real device is used.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js', { paths: [path.join(__dirname, '..'), path.join(__dirname, '..', 'apps', 'web')] }), 'utf8');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'venue-arrival');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const checks = [];
  const pass = (name) => { checks.push(name); console.log(`ok ${checks.length} ${name}`); };
  try {
    const command = async (name, payload) => {
      const response = await fetch(`${f.harness.baseUrl}/api/events/${f.eventId}/commands`, {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: f.manager.cookie, origin: f.harness.baseUrl },
        body: JSON.stringify({ commandId: `venue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, command: name, payload }),
      });
      const json = await response.json();
      assert.ok(response.status < 300, `${name}: ${response.status} ${JSON.stringify(json)}`);
      return json;
    };
    const workspace = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const people = (await workspace()).participants;
    browser = await launchBrowser();
    const errors = [];
    const context = async ({ who, width, height }) => {
      const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce', locale: 'ko-KR' });
      if (who) await ctx.addCookies([{ ...cookieForContext(f, who), url: f.baseUrl }]);
      await ctx.addInitScript(() => {
        window.__printed = [];
        window.print = () => { window.__printed.push(document.querySelector('[data-nametag-output]')?.innerText || 'page'); window.dispatchEvent(new Event('afterprint')); };
      });
      const page = await ctx.newPage();
      page.on('pageerror', (error) => errors.push(error.message));
      return page;
    };
    const text = (page) => page.locator('main').innerText();
    const noOverflow = async (page) => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'horizontal overflow');
    const accessible = async (page) => {
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => v.id)), []);
    };
    const deskUrl = `${f.baseUrl}/staff/events/${f.eventId}?desk=${f.deskId}&as=IN`;
    const poster = `${f.baseUrl}/event/${f.slug}/arrive?desk=${f.deskId}`;
    const printed = (page) => page.evaluate(() => window.__printed);
    const waitFor = async (probe, label, timeout = 12000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) { if (await probe()) return; await new Promise((resolve) => setTimeout(resolve, 200)); }
      assert.fail(`timed out: ${label}`);
    };
    const typed = async (phone, person) => {
      await phone.locator('#arrive-name').fill(person.name);
      await phone.locator('#arrive-phone').fill(person.phone);
      await phone.getByRole('button', { name: '도착 접수' }).click();
    };

    const laptop = await context({ who: 'manager', width: 1440, height: 900 });
    await laptop.goto(deskUrl, { waitUntil: 'networkidle' });
    await laptop.getByRole('complementary', { name: '데스크 현황' }).waitFor();
    await waitFor(async () => (await text(laptop)).includes('아직 도착한 사람이 없습니다'), 'empty list');
    pass('desk laptop opens with an empty waiting list');

    const phone = await context({ width: 390, height: 844 });
    await phone.goto(poster, { waitUntil: 'networkidle' });
    await phone.locator('#arrive-title').waitFor();
    await noOverflow(phone); await accessible(phone);
    await phone.screenshot({ path: path.join(out, 'phone-1-identify.png') });
    await typed(phone, { name: '아무개', phone: '01099990000' });
    await phone.getByRole('alert').filter({ hasText: '데스크에 말씀해 주세요' }).waitFor();
    pass('a stranger gets one neutral refusal');
    await typed(phone, people[0]);
    await phone.getByText('접수됐습니다').waitFor();
    assert.equal(await phone.locator('svg title').filter({ hasText: '입장 QR' }).count(), 0, 'name and phone show no ticket QR');
    await noOverflow(phone); await accessible(phone);
    await phone.screenshot({ path: path.join(out, 'phone-2-arrived.png') });
    pass('name and phone arrive without exposing a ticket');

    await waitFor(async () => (await printed(laptop)).length === 1, 'auto print');
    assert.ok((await printed(laptop))[0].includes(people[0].name));
    await waitFor(async () => (await laptop.getByRole('list', { name: '도착한 참가자' }).innerText()).includes('출력함'), 'printed state');
    await laptop.screenshot({ path: path.join(out, 'laptop-1-waiting.png') });
    await accessible(laptop);
    pass('the tag prints by itself and the row says so');

    await laptop.getByRole('button', { name: '건넸어요 · 입장' }).click();
    await laptop.getByText('입장 완료').waitFor();
    await waitFor(async () => (await workspace()).participants.find((p) => p.id === people[0].id).inside === true, 'entry');
    await waitFor(async () => /1\s*\/ 8명 입장 중/.test((await text(laptop)).replace(/\n/g, ' ')), 'count');
    pass('handing over is the entry');

    const second = await context({ who: 'manager', width: 1440, height: 900 });
    await second.goto(deskUrl, { waitUntil: 'networkidle' });
    await phone.goto(poster, { waitUntil: 'networkidle' });
    await typed(phone, people[1]);
    await phone.getByText('접수됐습니다').waitFor();
    await waitFor(async () => (await printed(laptop)).length + (await printed(second)).length >= 2, 'one of the laptops prints');
    await new Promise((resolve) => setTimeout(resolve, 7000));
    assert.equal((await printed(laptop)).length + (await printed(second)).length, 2, 'two laptops print one tag once');
    await second.context().close();
    pass('two laptops on one desk never print the same tag twice');

    const newcomer = await context({ width: 390, height: 844 });
    await newcomer.goto(poster, { waitUntil: 'networkidle' });
    await newcomer.getByRole('link', { name: '신청하지 않았어요 · 현장 신청' }).click();
    await newcomer.locator('#field-name').fill('현장 방문객');
    await newcomer.locator('#field-phone').fill('01055550001');
    const consent = newcomer.locator('#consent');
    if (await consent.count()) await consent.check();
    await newcomer.getByRole('button', { name: /신청/ }).last().click();
    await newcomer.getByText('접수됐습니다').waitFor();
    await newcomer.locator('figure svg').waitFor();
    await noOverflow(newcomer);
    await newcomer.screenshot({ path: path.join(out, 'phone-3-signup-pass.png') });
    await waitFor(async () => (await laptop.getByRole('list', { name: '도착한 참가자' }).innerText()).includes('현장 방문객'), 'signup listed');
    pass('an on-site signup arrives and its phone shows the pass QR');

    await waitFor(async () => (await printed(laptop)).concat().some((tag) => tag.includes('현장 방문객')) , 'signup printed');
    const before = (await printed(laptop)).length;
    const walkIn = (await workspace()).participants.find((p) => p.name === '현장 방문객');
    await laptop.evaluate(() => document.activeElement && document.activeElement.blur());
    await laptop.keyboard.type(walkIn.ticket, { delay: 3 });
    await laptop.keyboard.press('Enter');
    await laptop.getByText('입장 처리됨').first().waitFor();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    assert.equal((await printed(laptop)).length, before, 'scanning the pass does not print the tag again');
    await newcomer.reload({ waitUntil: 'networkidle' });
    await newcomer.getByText('이미 입장하셨어요').waitFor();
    pass('scanning the pass hands over without a second print; the phone then reads inside');
    await laptop.getByRole('button', { name: '다음 참가자' }).first().click().catch(() => {});

    const staff = await context({ who: 'staff', width: 390, height: 844 });
    await staff.goto(`${deskUrl}&line=1`, { waitUntil: 'networkidle' });
    await staff.getByText('줄 스캔 ·', { exact: false }).waitFor();
    await staff.getByRole('button', { name: '코드 입력' }).click();
    await staff.locator('#staff-ticket').fill(people[2].ticket);
    await staff.getByRole('dialog').getByRole('button', { name: '입장 처리', exact: true }).click();
    await staff.getByText('데스크로 보냄').waitFor();
    await noOverflow(staff);
    await staff.screenshot({ path: path.join(out, 'staff-1-line.png') });
    assert.equal((await workspace()).participants.find((p) => p.id === people[2].id).inside, false, 'a line scan does not admit');
    await waitFor(async () => (await printed(laptop)).some((tag) => tag.includes(people[2].name)), 'line scan printed at the desk');
    pass('a staff line scan prints at the desk and waits for the handover');

    await command('participant.status', { id: people[3].id, status: 'PENDING' });
    await phone.goto(poster, { waitUntil: 'networkidle' });
    await typed(phone, people[3]);
    await phone.getByText('확인이 필요합니다').waitFor();
    await phone.screenshot({ path: path.join(out, 'phone-4-review.png') });
    const row = laptop.getByRole('list', { name: '도착한 참가자' }).getByRole('button', { name: new RegExp(people[3].name) });
    await row.waitFor();
    assert.ok((await row.innerText()).includes('승인 대기'));
    await row.click();
    await laptop.screenshot({ path: path.join(out, 'laptop-2-review.png') });
    const printsBefore = (await printed(laptop)).length;
    await laptop.getByRole('button', { name: '승인하고 입장' }).click();
    await waitFor(async () => (await workspace()).participants.find((p) => p.id === people[3].id).inside === true, 'approved entry');
    assert.equal((await printed(laptop)).length, printsBefore, 'nothing printed for a person under review');
    pass('a pending person waits for approval, then approval and entry are one button');

    const ops = await context({ who: 'manager', width: 1440, height: 900 });
    await ops.goto(`${f.baseUrl}/console/events/${f.eventId}/operations`, { waitUntil: 'networkidle' });
    await ops.getByRole('button', { name: /안내판 인쇄$/ }).first().click();
    await ops.getByRole('dialog').getByRole('button', { name: '인쇄하기' }).waitFor();
    await ops.screenshot({ path: path.join(out, 'ops-1-poster.png') });
    await ops.emulateMedia({ media: 'print' });
    for (const [name, width, height] of [['a4', 794, 1123], ['a5', 559, 794]]) {
      await ops.setViewportSize({ width, height });
      const sheet = await ops.evaluate(() => {
        const node = [...document.body.children].find((child) => child.tagName === 'ARTICLE');
        const others = [...document.body.children].filter((child) => child !== node && getComputedStyle(child).display !== 'none');
        return { others: others.length, height: node.getBoundingClientRect().height, scroll: node.scrollHeight, width: node.scrollWidth };
      });
      assert.equal(sheet.others, 0, `${name}: only the poster prints`);
      assert.ok(sheet.height <= height && sheet.scroll <= height && sheet.width <= width, `${name}: the poster fits one page ${JSON.stringify(sheet)}`);
      await ops.screenshot({ path: path.join(out, `poster-print-${name}.png`) });
    }
    pass('the poster is the only printed content and fits A4 and A5');

    const side = (await command('desk.save', { name: '명찰 없는 문', action: 'IN', mode: 'desk', open: true, nametag: false })).desk;
    await phone.goto(`${f.baseUrl}/event/${f.slug}/arrive?desk=${side.id}`, { waitUntil: 'networkidle' });
    await typed(phone, people[4]);
    await phone.getByText('입장 완료').waitFor();
    assert.equal((await workspace()).participants.find((p) => p.id === people[4].id).inside, true);
    pass('a desk without name tags admits on arrival');

    assert.deepEqual(errors, []);
    console.log(`Venue arrival: ${checks.length} checks passed; evidence ${out}`);
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
