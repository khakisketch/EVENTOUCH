'use strict';

// Smoke audit for the redesigned screens: every confirmed screen loads for the
// role that owns it, at desktop and phone width, without script errors, sideways
// scroll or blocking axe findings. It does not walk journeys or assert copy;
// the screen-composition tests pin the design and the journey audits pin the
// flows. Add a screen here when it is redesigned.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { extendFixtureSeed } = require('./web-console-audit.cjs');
const { prepareCaptureDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const axeSource = require('axe-core').source;

const out = process.env.EVENTOUCH_CAPTURE_ROOT
  ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'redesign-smoke')
  : defaultCaptureDir(`redesign-smoke-${runStamp()}`);
const VIEWPORTS = [
  { tag: '1280', width: 1280, height: 900 },
  { tag: '390', width: 390, height: 844 },
];

(async () => {
  prepareCaptureDir(out);
  const f = await startAuditFixture();
  let browser;
  const failures = [];
  let checked = 0;
  try {
    const seed = await extendFixtureSeed(f);
    const event = `/console/events/${encodeURIComponent(f.eventId)}`;
    const owner = [
      ['events', '/console'],
      ['clients', '/console/clients'],
      ['team', '/console/team'],
      ['overview', event],
      ['participants', `${event}/participants`],
      ['import', `${event}/participants/import`],
      ['operations', `${event}/operations`],
      ['programs', `${event}/programs`],
      ['draws', `${event}/draws`],
      ['rewards', `${event}/rewards`],
      ['photos', `${event}/photos`],
      ['content', `${event}/content`],
      ['page', `${event}/page`],
      ['messages', `${event}/messages`],
      ['reports', `${event}/reports`],
      ['settings', `${event}/settings`],
      ['fields', `${event}/settings/fields`],
    ];
    const anonymous = [
      ['landing', '/'],
      ['login', '/login'],
      ['recover', '/recover'],
      ['public-event', `/event/${f.slug}`],
      ['register', `/event/${f.slug}/register`],
      ['ticket-recover', `/event/${f.slug}/ticket/recover`],
      ['venue-screen', `/screen/${f.slug}`],
      ['not-found', '/this-page-does-not-exist', 404],
    ];
    const staff = [['staff-hub', '/staff']];
    const groups = [
      ['owner', owner, { name: 'etko_session', value: decodeURIComponent(seed.ownerCookie.slice('etko_session='.length)), url: f.baseUrl, httpOnly: true, sameSite: 'Lax' }],
      ['anonymous', anonymous, null],
      ['staff', staff, { ...cookieForContext(f, 'staff'), url: f.baseUrl }],
    ];
    browser = await launchBrowser();
    for (const viewport of VIEWPORTS) {
      for (const [role, screens, cookie] of groups) {
        const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height }, locale: 'ko-KR' });
        if (cookie) await context.addCookies([cookie]);
        for (const [name, route, expected = 200] of screens) {
          const label = `${role}/${name}@${viewport.tag}`;
          const page = await context.newPage();
          const problems = [];
          page.on('pageerror', (error) => problems.push(`script error: ${error.message}`));
          page.on('console', (message) => {
            if (message.type() === 'error' && !/Failed to load resource/u.test(message.text())) problems.push(`console error: ${message.text().slice(0, 160)}`);
          });
          try {
            const response = await page.goto(`${f.baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 45000 });
            await page.waitForTimeout(500);
            if (response.status() !== expected) problems.push(`status ${response.status()}, expected ${expected}`);
            if (!await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)) problems.push('sideways scroll');
            if (!await page.locator('h1, h2, [role="heading"]').first().isVisible().catch(() => false)) problems.push('no visible heading');
            await page.evaluate(axeSource);
            const blocking = await page.evaluate(async () => (await axe.run(document, {
              runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
            })).violations.filter((item) => ['serious', 'critical'].includes(item.impact))
              .map((item) => `${item.id} (${item.impact}, ${item.nodes.length}) ${item.nodes[0].target.join(' ').slice(0, 90)}`));
            problems.push(...blocking.map((item) => `axe ${item}`));
            await page.screenshot({ path: path.join(out, `${role}-${name}-${viewport.tag}.png`), fullPage: false });
          } catch (error) {
            problems.push(`load failed: ${String(error.message).split('\n')[0]}`);
          }
          checked += 1;
          if (problems.length) failures.push(`${label}: ${problems.join('; ')}`);
          console.log(problems.length ? `FAIL ${label}: ${problems.join('; ')}` : `ok   ${label}`);
          await page.close();
        }
        await context.close();
      }
    }
    fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify({ checked, failures }, null, 2));
    assert.equal(failures.length, 0, `${failures.length} of ${checked} screen checks failed`);
    console.log(`[redesign-smoke] ${checked} screen checks passed`);
  } finally {
    await browser?.close();
    await f.close?.();
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
