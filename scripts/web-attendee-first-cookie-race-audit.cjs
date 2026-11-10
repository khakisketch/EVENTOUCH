'use strict';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function main() {
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  const source = (await fixture.harness.database.query('SELECT e.payload AS event, w.payload AS workspace FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1', [fixture.eventId])).rows[0];
  const browser = await launchBrowser();
  const reports = [];
  async function run(mode) {
  const slugs = ['a', 'b', 'old'].map(x => `cookie-${mode}-${x}-${fixture.suffix}`);
  const phone = { reverse: '01098981001', normal: '01098981002', lost: '01098981003', blocked: '01098981004', legacy: '01098981005' }[mode];
  assert.ok(phone);
  let context;
  try {
    for (const slug of slugs) await fixture.helpers.insertEvent(fixture.harness.database, {
      id: slug, slug, orgId: fixture.helpers.LEGACY_ORG,
      payload: { ...source.event, id: slug, slug, name: `합성 동시 신청 ${slug.endsWith('-a-' + fixture.suffix) ? '가' : '나'}` },
      workspace: { ...source.workspace, participants: [], checks: [], visits: [], assignments: [], messages: [], audit: [], verificationRequired: false },
    });
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    const prepare = async slug => {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/event/${slug}/register`);
      await page.locator('#field-name').fill('합성 동시 신청 참가자');
      await page.locator('#field-phone').fill(phone);
      if (await page.locator('#consent').count()) await page.locator('#consent').check();
      return page;
    };
    if (mode === 'legacy') {
      const old = await prepare(slugs[2]);
      await old.getByRole('button', { name: '신청하기', exact: true }).click();
      await old.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
      const cookies = await context.cookies(fixture.baseUrl);
      let token;
      for (const cookie of cookies) {
        const hash = crypto.createHash('sha256').update(cookie.value).digest('hex');
        const exists = await fixture.harness.database.query('SELECT 1 FROM attendee_sessions WHERE token_hash=$1', [hash]);
        if (exists.rowCount) { token = cookie.value; break; }
      }
      assert.ok(token, 'an old session exists');
      await context.clearCookies();
      await context.addCookies([{ name: 'etko_attendee', value: token, url: fixture.baseUrl, httpOnly: true, sameSite: 'Lax' }]);
      await old.close();
    } else {
      assert.equal((await context.cookies(fixture.baseUrl)).some(item => item.name.startsWith('etko_attendee')), false);
    }
    const pages = await Promise.all(slugs.slice(0, 2).map(prepare));
    const pending = [];
    let both, release, received;
    const ready = new Promise(resolve => { both = resolve; });
    const sendTogether = new Promise(resolve => { release = resolve; });
    const responsesReady = new Promise(resolve => { received = resolve; });
    let intercept = true;
    await context.route('**/api/events/*/signup', async (route, req) => {
      if (!intercept) return route.continue();
      const requestHeaders = await req.allHeaders();
      const entry = { route, requestHeaders, response: null, slug: new URL(req.url()).pathname.split('/')[3], body: req.postData() };
      pending.push(entry);
      if (pending.length === 2) both();
      // Do not let route.fetch's cookie handling affect the other request:
      // both original browser requests must already be paused at this point.
      await sendTogether;
      entry.response = await route.fetch({ headers: { ...requestHeaders, cookie: requestHeaders.cookie || '' } });
      if (pending.length === 2 && pending.every(item => item.response)) received();
    });
    const clicks = pages.map(page => page.getByRole('button', { name: '신청하기', exact: true }).click());
    await Promise.race([ready, new Promise((_, reject) => setTimeout(() => reject(new Error('both submissions did not arrive')), 15000))]);
    if (mode !== 'legacy') assert.ok(pending.every(item => !(item.requestHeaders.cookie || '').includes('etko_attendee')), 'both first requests start without a session');
    else assert.ok(pending.every(item => (item.requestHeaders.cookie || '').includes('etko_attendee=')), 'both requests carry the existing common session');
    release();
    await Promise.race([responsesReady, new Promise((_, reject) => setTimeout(() => reject(new Error('both server responses did not arrive')), 15000))]);
    const bySlug = slug => { const found = pending.find(item => item.slug === slug); assert.ok(found); return found; };
    const first = bySlug(slugs[0]); const second = bySlug(slugs[1]);
    intercept = false;
    if (mode === 'blocked') {
      // Playwright's route.fetch stores cookies before fulfill. Clear these
      // synthetic writes, then strip Set-Cookie from each browser response.
      await context.clearCookies();
      for (const entry of [first, second]) {
        const headers = { ...entry.response.headers() }; delete headers['set-cookie'];
        await entry.route.fulfill({ response: entry.response, headers });
      }
    } else if (mode === 'lost') {
      const headers = await first.response.headersArray();
      for (const h of headers.filter(h => h.name.toLowerCase() === 'set-cookie')) {
        const name = h.value.split('=', 1)[0];
        await context.clearCookies({ name });
      }
      await first.route.abort('failed');
      await second.route.fulfill({ response: second.response });
    } else {
      for (const entry of mode === 'reverse' ? [second, first] : [first, second]) await entry.route.fulfill({ response: entry.response });
    }
    await Promise.all(clicks);
    if (mode === 'lost') {
      await pages[0].getByRole('button', { name: '신청 결과 다시 확인', exact: true }).waitFor();
      const [response] = await Promise.all([
        pages[0].waitForResponse(res => res.url().includes('/signup') && res.request().method() === 'POST'),
        pages[0].getByRole('button', { name: '신청 결과 다시 확인', exact: true }).click(),
      ]);
      assert.equal(response.status(), 200);
      // Do not print the request: it contains the recovery-capable command ID.
      assert.ok(response.request().postData() === first.body, 'the retry repeats the same request');
    }
    await Promise.all(pages.map(page => page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor()));
    if (mode === 'blocked') {
      assert.equal((await context.cookies(fixture.baseUrl)).some(item => item.name.startsWith('etko_attendee')), false, 'the cookie rejection simulation leaves no attendee cookie');
    }
    const fresh = [];
    const expectSlugs = mode === 'legacy' ? slugs : slugs.slice(0, 2);
    for (let i = 0; i < expectSlugs.length; i++) {
      const page = await context.newPage();
      await page.goto(`${fixture.baseUrl}/event/${expectSlugs[i]}/ticket`);
      await page.waitForLoadState('networkidle');
      const visible = await page.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).isVisible();
      fresh.push({ event: i + 1, visible });
      await page.screenshot({ path: path.join(out, `${mode}-fresh-${i + 1}.png`), mask: [page.getByRole('img', { name: /QR/ })] });
      await page.close();
    }
    const stats = [];
    for (const slug of slugs.slice(0, 2)) {
      const row = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [slug])).rows[0];
      stats.push(row.payload.participants.filter(person => person.phone === phone).length);
    }
    assert.deepEqual(stats, [1, 1], 'each event has one participant');
    const report = { mode, originalTabsVisible: true, reusedOriginalRequest: mode === 'lost', fresh, counts: stats, actualProvider: false };
    reports.push(report);
    assert.equal(fresh.filter(item => item.visible).length, mode === 'blocked' ? 0 : expectSlugs.length, 'fresh-tab ticket restoration');
  } finally { await context?.close(); }
  }
  try {
    for (const mode of ['normal', 'reverse', 'lost', 'legacy', 'blocked']) await run(mode);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ cases: reports, actualProvider: false }, null, 2), { mode: 0o600 });
    console.log('[attendee-first-cookie] all five isolated scenarios passed');
  } finally { await browser.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
