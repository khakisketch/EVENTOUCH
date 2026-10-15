'use strict';

// Accessibility + overflow audit for the new Next.js app (apps/web).
//
// The legacy audits (accessibility-audit.cjs, mobile-audit.cjs) boot their
// own API server and walk the vanilla hash routes. This one audits the
// running new-app demo instead: it needs seeded content (an event with
// notices/program, staff and admin accounts), which the preview demo
// databases already have. Override the base when auditing elsewhere:
//
//   WEB_BASE=http://127.0.0.1:8777 node scripts/web-audit.cjs
//
// Serious and critical axe violations fail the run. Horizontal overflow at
// any viewport fails the run. Moderate axe findings are reported for triage.

function loadPlaywright() {
  for (const candidate of ['/home/ksi/node_modules/playwright', 'playwright']) {
    try {
      const mod = require(candidate);
      if (mod && mod.chromium) return mod;
    } catch (err) { /* try the next location */ }
  }
  throw new Error('playwright is required to run the web audit');
}
const { chromium } = loadPlaywright();
const axeSource = require('axe-core').source;

const WEB_BASE = (process.env.WEB_BASE || 'http://127.0.0.1:8777').replace(/\/+$/, '');
const EVENT_SLUG = process.env.WEB_AUDIT_EVENT || 'partner-demo';
const ADMIN_EMAIL = process.env.WEB_AUDIT_ADMIN_EMAIL || 'admin@eventouch.demo';
const ADMIN_PASSWORD = process.env.WEB_AUDIT_ADMIN_PASSWORD || 'Eventouch2026!';
const STAFF_EMAIL = process.env.WEB_AUDIT_STAFF_EMAIL || 'sliceverify@example.test';
const STAFF_PASSWORD = process.env.WEB_AUDIT_STAFF_PASSWORD || 'Verify2026!';

const EXECUTABLE = '/home/ksi/.cache/ms-playwright/chromium-1234/chrome-linux/chrome';
const VIEWPORTS = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1280, height: 800 },
];
const BLOCKING = new Set(['serious', 'critical']);

async function axeViolations(page) {
  await page.addScriptTag({ content: axeSource });
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

async function login(page, email, password) {
  await page.goto(`${WEB_BASE}/login`, { waitUntil: 'networkidle' });
  await page.fill('#login-email', email);
  await page.fill('#login-password', password);
  await Promise.all([
    page.waitForURL(/\/staff(\/|$|\?)|\/console/, { timeout: 15000 }),
    page.click('button[type=submit]'),
  ]);
}

async function main() {
  const browser = await chromium.launch({ executablePath: EXECUTABLE });
  const failures = [];
  const moderate = [];
  try {
    // Public screens, every viewport.
    const publicPaths = [
      ['home', '/'],
      ['event', `/event/${EVENT_SLUG}`],
      ['register', `/event/${EVENT_SLUG}/register`],
      ['screen', `/screen/${EVENT_SLUG}`],
    ];
    for (const viewport of VIEWPORTS) {
      const page = await browser.newPage({ viewport });
      for (const [name, path] of publicPaths) {
        const label = `${name}@${viewport.width}`;
        try {
          await page.goto(`${WEB_BASE}${path}`, { waitUntil: 'networkidle', timeout: 30000 });
          await page.waitForTimeout(1200);
          for (const violation of await axeViolations(page)) {
            if (BLOCKING.has(violation.impact)) failures.push(`${label}: ${violation.id} (${violation.impact}, ${violation.nodes} nodes)`);
            else moderate.push(`${label}: ${violation.id} (${violation.impact})`);
          }
          const box = await overflow(page);
          if (box.scrollWidth > box.innerWidth + 1) {
            failures.push(`${label}: horizontal overflow ${box.scrollWidth}px > ${box.innerWidth}px`);
          }
        } catch (error) {
          failures.push(`${label}: ${error.message.split('\n')[0]}`);
        }
      }
      await page.close();
    }

    // Staff console (desktop viewport is the desk case; mobile checked above
    // for public flows and was exercised during slice verification).
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await login(page, STAFF_EMAIL, STAFF_PASSWORD);
        await page.waitForTimeout(1500);
        for (const violation of await axeViolations(page)) {
          if (BLOCKING.has(violation.impact)) failures.push(`staff-console: ${violation.id} (${violation.impact})`);
          else moderate.push(`staff-console: ${violation.id} (${violation.impact})`);
        }
      } catch (error) {
        failures.push(`staff-console: ${error.message.split('\n')[0]}`);
      }
      await page.close();
    }

    // Operator console home (read paths only).
    {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
      try {
        await login(page, ADMIN_EMAIL, ADMIN_PASSWORD);
        await page.waitForTimeout(1500);
        for (const violation of await axeViolations(page)) {
          if (BLOCKING.has(violation.impact)) failures.push(`console-home: ${violation.id} (${violation.impact})`);
          else moderate.push(`console-home: ${violation.id} (${violation.impact})`);
        }
      } catch (error) {
        failures.push(`console-home: ${error.message.split('\n')[0]}`);
      }
      await page.close();
    }
  } finally {
    await browser.close();
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
