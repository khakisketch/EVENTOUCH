'use strict';

// Accessibility + overflow + attendee-home geometry audit for the new
// Next.js app (apps/web) against an isolated fixture.
//
// The retired vanilla audits are gone. This boots a real API harness on an
// isolated PostgreSQL schema, seeds a realistic event (manager + staff,
// approved participants, an open desk, notices), and drives the running
// Next build (WEB_BASE, default 8777) through the same-origin test gateway
// — a real reverse proxy, never a mocked API. Explicit fixture route ids
// replace the old hard-coded demo-slug dependency; demo accounts are not used.
//
// Preserved attendee-home outcomes: the five-tile menu fits short-phone
// viewports without scrolling (9 viewports), every tile label, category and
// icon stays inside its touch surface, every tile clears 44px, the event
// banner stays a separate visible region above the grid, keyboard Enter
// opens the first destination, each destination has browser navigation
// state, browser back restores the menu, and details open independently.
//
// Serious and critical axe violations fail the run. Horizontal overflow at
// any viewport fails the run. Moderate axe findings are reported for triage.

const path = require('node:path');
const fs = require('node:fs');
const axeSource = require('axe-core').source;
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, assertAuditRoute } = require('./audit-fixture.cjs');

const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];
const BLOCKING = new Set(['serious', 'critical']);

async function axeViolations(page) {
  // Browser-protocol instrumentation (see accessibility-audit.cjs): the
  // production nonce CSP stays enabled for hydration; axe is injected
  // through CDP evaluation, never as an inline script that would need the
  // policy weakened.
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const results = await window.axe.run(document, {
      resultTypes: ['violations'],
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
    });
    return results.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      help: violation.help,
      nodes: violation.nodes.length,
    }));
  });
}

async function overflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
}

// The customer reference is a phone menu of ticket, notice, lucky draw,
// roulette, rank voting and — added for self-service booth stamping — 부스 인증.
// Check rendered geometry and navigation against the running API without
// authorizing any participant or submitting any commands.
async function attendeeHomeNavigation(page, label, failures, navigate = true) {
  const names = [
    /참가자 개인 QR|모바일 티켓/,
    /행사 안내.*공지|공지사항/,
    /럭키드로우 번호/,
    /룰렛 이벤트/,
    /순위 투표/,
    /부스 인증/,
  ];
  const menu = names.map((name) => page.getByRole('button', { name })
    .or(page.getByRole('link', { name })));
  const boxes = [];
  for (const button of menu) {
    await button.waitFor({ state: 'visible', timeout: 10000 });
    boxes.push(await button.boundingBox());
    const clipped = await button.evaluate((element) => {
      const tile = element.getBoundingClientRect();
      return [...element.querySelectorAll('span, svg')].some((child) => {
        const rect = child.getBoundingClientRect();
        if (!rect.width || !rect.height) return false;
        return rect.left < tile.left - 1 || rect.right > tile.right + 1
          || rect.top < tile.top - 1 || rect.bottom > tile.bottom + 1;
      });
    });
    if (clipped) failures.push(`${label}: a tile label, category or icon extends outside its touch surface`);
  }
  const near = (a, b) => Math.abs(a - b) <= 2;
  if (boxes.some((box) => !box)
    || boxes.some((box) => !near(box.width, boxes[0].width))
    || boxes.some((box) => box.width < 44 || box.height < 44)
    || !near(boxes[0].x, boxes[2].x)
    || !near(boxes[0].x, boxes[4].x)
    || !near(boxes[1].x, boxes[3].x)
    || !near(boxes[1].x, boxes[5].x)
    || !near(boxes[0].y, boxes[1].y)
    || !near(boxes[2].y, boxes[3].y)
    || !near(boxes[4].y, boxes[5].y)
    || boxes[1].x <= boxes[0].x
    || boxes[2].y <= boxes[0].y
    || boxes[4].y <= boxes[2].y) {
    failures.push(`${label}: expected two-column menu rows 1/2, 3/4, 5/6`);
  }
  const viewport = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    scrollHeight: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight),
  }));
  const banner = await page.getByRole('region', { name: /참가자 홈$/ }).boundingBox();
  if (!banner || !boxes[0] || banner.y + banner.height > boxes[0].y + 1) {
    failures.push(`${label}: event banner and menu must remain separate, visible regions`);
  }
  if (viewport.scrollHeight > viewport.height + 1
    || boxes.some((box) => box && (box.y < 0 || box.y + box.height > viewport.height + 1
      || box.x < 0 || box.x + box.width > viewport.width + 1))) {
    failures.push(`${label}: home and every tile must fit without scrolling (${viewport.scrollHeight}px / ${viewport.height}px)`);
  }
  if (!navigate) return;
  const homeURL = page.url();
  for (let index = 0; index < menu.length; index += 1) {
    if (index === 0) {
      await menu[index].focus();
      await page.keyboard.press('Enter');
    } else {
      await menu[index].click();
    }
    for (const button of menu) {
      if (await button.isVisible()) {
        failures.push(`${label}: home menu remains above destination ${index + 1}`);
        break;
      }
    }
    if (page.url() === homeURL) {
      failures.push(`${label}: destination ${index + 1} is missing browser navigation state`);
      break;
    }
    const box = await overflow(page);
    if (box.scrollWidth > box.innerWidth + 1) {
      failures.push(`${label}: destination ${index + 1} has horizontal overflow`);
    }
    await page.goBack({ waitUntil: 'networkidle' });
    await menu[index].waitFor({ state: 'visible', timeout: 10000 });
    if (page.url() !== homeURL) {
      failures.push(`${label}: browser back did not restore the participant menu`);
      break;
    }
  }
}

async function login(page, baseUrl, email, password) {
  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await Promise.all([
    page.waitForURL(/\/staff(\/|$|\?)|\/console/, { timeout: 15000 }),
    page.click('button[type=submit]'),
  ]);
}

async function attendeeTicket(baseUrl, eventId, fixture) {
  const cookie = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: fixture.manager.email, password: fixture.manager.password }),
  }).then((res) => (res.headers.getSetCookie() || []).map((value) => value.split(';')[0]).join('; ')).catch(() => '');
  const res = await fetch(`${baseUrl}/api/bootstrap`, { headers: { cookie } }).catch(() => null);
  if (!res || !res.ok) return '';
  const body = await res.json().catch(() => null);
  const people = body?.state?.workspaces?.[eventId]?.participants;
  if (!Array.isArray(people)) return '';
  const person = people.find((item) => item && item.status === 'APPROVED' && typeof item.ticket === 'string');
  return person ? person.ticket : '';
}

async function main() {
  let fixture;
  try {
    fixture = await startAuditFixture();
  } catch (error) {
    process.stderr.write(`[web-audit] ${error && error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const captureDir = process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'web')
    : '/tmp/opencode/eventouch-captures/web-audit';
  fs.mkdirSync(captureDir, { recursive: true });
  const baseUrl = fixture.baseUrl;
  const slug = fixture.slug;
  const eventId = fixture.eventId;
  let browser;
  const failures = [];
  const moderate = [];
  try {
    // Inside the protected block: if the browser executable is unavailable,
    // the owned fixture (Next + gateway + harness) still unwinds below.
    browser = await launchBrowser();
    // Public screens, every viewport.
    const publicPaths = [
      ['home', '/'],
      ['event', `/event/${slug}`],
      ['attendee-home', `/event/${slug}/home`],
      ['register', `/event/${slug}/register`],
      ['screen', `/screen/${slug}`],
    ];
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport });
      for (const [name, path] of publicPaths) {
        const label = `${name}@${viewport.width}`;
        try {
          await page.goto(`${baseUrl}${path}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(1200);
          // An error boundary, not-found page, or login redirect must fail
          // the run here, never count as an audited screen.
          await assertAuditRoute(page, { name, path });
          for (const violation of await axeViolations(page)) {
            if (BLOCKING.has(violation.impact)) failures.push(`${label}: ${violation.id} (${violation.impact}, ${violation.nodes} nodes)`);
            else moderate.push(`${label}: ${violation.id} (${violation.impact})`);
          }
          const box = await overflow(page);
          if (box.scrollWidth > box.innerWidth + 1) {
            failures.push(`${label}: horizontal overflow ${box.scrollWidth}px > ${box.innerWidth}px`);
          }
          if (name === 'attendee-home') {
            await attendeeHomeNavigation(page, label, failures);
          }
        } catch (error) {
          failures.push(`${label}: ${error.message.split('\n')[0]}`);
        }
      }
      await page.close();
    }

    // The client keeps the participant home at its initial simple shape: a QR
    // is not handed to every participant, so the landing is the activity
    // entries and the ticket opens from the first one when it exists.
    {
      const ticket = await attendeeTicket(baseUrl, eventId, fixture);
      for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 664 }, { width: 1280, height: 800 }]) {
        const page = await browser.newPage({ viewport });
        const label = `attendee-home-entries@${viewport.width}x${viewport.height}`;
        try {
          const query = ticket ? `?ticket=${encodeURIComponent(ticket)}` : "";
          await page.goto(`${baseUrl}/event/${slug}/home${query}`, { waitUntil: 'networkidle', timeout: 30000 });
          const entries = await page.locator('nav[aria-label="참가 메뉴"] button').count();
          if (entries !== 6) failures.push(`${label}: expected the six home entries, got ${entries}`);
          // The ticket stays one tap away: the first entry, on screen.
          const ticketEntry = await page.getByRole('button', { name: /모바일 티켓/ }).first().boundingBox();
          if (!ticketEntry || ticketEntry.y < 0 || ticketEntry.y + ticketEntry.height > viewport.height) {
            failures.push(`${label}: the ticket entry must be reachable in the first viewport`);
          }
          // The landing does not assume a QR: none is printed on the home.
          if (await page.locator('[aria-label*="입장 및 퇴장용 QR"]').count()) {
            failures.push(`${label}: the home stays the simple entry list`);
          }
          const overflowBox = await overflow(page);
          if (overflowBox.scrollWidth > overflowBox.innerWidth + 1) failures.push(`${label}: horizontal overflow`);
          await page.screenshot({ path: path.join(captureDir, `home-entries-${viewport.width}.png`), fullPage: false });
        } catch (error) {
          failures.push(`${label}: ${error.message.split('\n')[0]}`);
        } finally {
          await page.close();
        }
      }
    }

    // Browser toolbars reduce usable phone height. The home must fit that
    // viewport too; this is deliberately not a no-scroll rule for long details.
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 360, height: 600 },
      { width: 375, height: 600 },
      { width: 390, height: 664 },
      { width: 412, height: 700 },
      { width: 414, height: 700 },
      { width: 430, height: 740 },
      { width: 768, height: 800 },
      { width: 1280, height: 800 },
    ]) {
      const page = await browser.newPage({ viewport });
      const label = `attendee-home@${viewport.width}x${viewport.height}`;
      try {
        await page.goto(`${baseUrl}/event/${slug}/home`, { waitUntil: 'networkidle', timeout: 30000 });
        await assertAuditRoute(page, { name: 'attendee-home', path: `/event/${slug}/home` });
        await attendeeHomeNavigation(page, label, failures, viewport.width === 320 || viewport.width === 412);
        const box = await overflow(page);
        if (box.scrollWidth > box.innerWidth + 1) failures.push(`${label}: horizontal overflow`);
      } catch (error) {
        failures.push(`${label}: ${error.message.split('\n')[0]}`);
      } finally {
        await page.close();
      }
    }

    // Unknown slug reads as not-found, never a crash or a leak.
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await page.goto(`${baseUrl}/event/unknown-slug-000000`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(800);
        for (const violation of await axeViolations(page)) {
          if (BLOCKING.has(violation.impact)) failures.push(`unknown-slug: ${violation.id} (${violation.impact})`);
          else moderate.push(`unknown-slug: ${violation.id} (${violation.impact})`);
        }
      } catch (error) {
        failures.push(`unknown-slug: ${error.message.split('\n')[0]}`);
      }
      await page.close();
    }

    // Staff console (desktop viewport is the desk case).
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await login(page, baseUrl, fixture.staff.email, fixture.staff.password);
        await page.goto(`${baseUrl}/staff/events/${eventId}`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        await assertAuditRoute(page, { name: 'staff', path: `/staff/events/${eventId}` });
        for (const violation of await axeViolations(page)) {
          if (BLOCKING.has(violation.impact)) failures.push(`staff-console: ${violation.id} (${violation.impact})`);
          else moderate.push(`staff-console: ${violation.id} (${violation.impact})`);
        }
        const box = await overflow(page);
        if (box.scrollWidth > box.innerWidth + 1) failures.push('staff-console: horizontal overflow');
      } catch (error) {
        failures.push(`staff-console: ${error.message.split('\n')[0]}`);
      }
      await page.close();
    }

    // Operator console home (read paths only).
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await login(page, baseUrl, fixture.manager.email, fixture.manager.password);
        await page.goto(`${baseUrl}/console/events/${eventId}/participants`, { waitUntil: 'networkidle', timeout: 30000 });
        await page.waitForTimeout(1500);
        await assertAuditRoute(page, { name: 'console-participants', path: `/console/events/${eventId}/participants` });
        for (const violation of await axeViolations(page)) {
          if (BLOCKING.has(violation.impact)) failures.push(`console-home: ${violation.id} (${violation.impact})`);
          else moderate.push(`console-home: ${violation.id} (${violation.impact})`);
        }
        const box = await overflow(page);
        if (box.scrollWidth > box.innerWidth + 1) failures.push('console-home: horizontal overflow');
      } catch (error) {
        failures.push(`console-home: ${error.message.split('\n')[0]}`);
      }
      await page.close();
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
  }

  for (const line of moderate) process.stdout.write(`[web-audit] moderate: ${line}\n`);
  if (failures.length) {
    for (const line of failures) process.stderr.write(`[web-audit] FAIL: ${line}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write('[web-audit] no serious or critical violations, no overflow\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`[web-audit] failed: ${error && error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {};
