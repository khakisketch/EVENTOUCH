'use strict';

// Accessibility audit of the real product against a live server.
//
// Earlier accessibility work was manual: a rendered review looked at a few
// screenshots. That catches layout problems but not the ones that matter most
// — missing labels, bad contrast, broken heading order — and only on screens
// someone happened to capture. This runs axe over the screens an operator
// actually uses, in both the console and the attendee surface.
//
// Serious and critical violations fail the run. Moderate ones are reported so
// they can be triaged deliberately rather than discovered by a customer.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// Prefer a Playwright already installed on the machine and matching its
// cached browsers. The repo does not pin one, so a version mismatch here
// would otherwise force a browser download just to run an audit.
function loadPlaywright() {
  for (const candidate of ['/home/ksi/node_modules/playwright', 'playwright']) {
    try {
      const mod = require(candidate);
      if (mod && mod.chromium) return mod;
    } catch (err) { /* try the next location */ }
  }
  throw new Error('playwright is required to run the accessibility audit');
}
const { chromium } = loadPlaywright();
const axeSource = require('axe-core').source;

const PORT = Number(process.env.A11Y_PORT || 18797);
const BASE = `http://127.0.0.1:${PORT}`;

const SCREENS = [
  { name: 'login', hash: '#/login', auth: false },
  { name: 'agency-events', hash: '#/console/agency/events', auth: true },
  { name: 'agency-clients', hash: '#/console/agency/clients', auth: true },
  { name: 'agency-team', hash: '#/console/agency/team', auth: true },
  { name: 'agency-integrations', hash: '#/console/agency/integrations', auth: true },
];

// Representative event screens, resolved from the fixture at runtime.
const EVENT_SCREENS = [
  { name: 'event-overview', hash: '#/console/events/{id}/overview' },
  { name: 'event-participants', hash: '#/console/events/{id}/participants' },
  { name: 'event-checkin', hash: '#/console/events/{id}/checkin' },
  { name: 'event-messages', hash: '#/console/events/{id}/messages' },
  { name: 'event-results', hash: '#/console/events/{id}/results' },
  { name: 'event-reports', hash: '#/console/events/{id}/reports' },
  { name: 'event-settings', hash: '#/console/events/{id}/settings' },
];

const BLOCKING = new Set(['serious', 'critical']);

function startServer(databaseUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-a11y-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-a11y-storage-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      STORAGE_DIR: storageDir,
      DATABASE_URL: databaseUrl,
      ADMIN_EMAIL: 'a11y@example.test',
      ADMIN_PASSWORD: 'a11y-admin-password',
      // The audit injects axe as an inline script; report-only lets it run
      // without weakening the shipped policy.
      EVENTOUCH_CSP_REPORT_ONLY: '1',
    },
    stdio: 'ignore',
  });
  return { child, cleanup: () => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(storageDir, { recursive: true, force: true });
  } };
}

async function waitForServer() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return;
    } catch (err) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('server did not start');
}

async function audit(page) {
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
      nodes: violation.nodes.slice(0, 3).map((node) => ({
        target: node.target.join(' '),
        summary: (node.failureSummary || '').split('\n').slice(0, 2).join(' '),
      })),
      count: violation.nodes.length,
    }));
  });
}

async function main() {
  const databaseUrl = String(process.env.EVENTOUCH_A11Y_DATABASE_URL || '').trim();
  if (!databaseUrl) {
    process.stderr.write('[a11y] set EVENTOUCH_A11Y_DATABASE_URL to run the accessibility audit\n');
    process.exitCode = 2;
    return;
  }

  const { child, cleanup } = startServer(databaseUrl);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  const failures = [];
  const advisories = [];

  try {
    await waitForServer();

    // Sign in through the API so every screen starts from a real session.
    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: 'a11y@example.test', password: 'a11y-admin-password' },
    });
    if (!login.ok()) throw new Error(`could not sign in for the audit: ${login.status()}`);

    // Discover an event the signed-in account can actually reach.
    await page.goto(`${BASE}/#/console/agency/events`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const discovered = await page.evaluate(() => {
      const id = window.ET?.state?.events?.[0]?.id;
      return id || null;
    });

    const targets = [...SCREENS];
    if (discovered) {
      for (const screen of EVENT_SCREENS) {
        targets.push({ ...screen, hash: screen.hash.replace('{id}', discovered) });
      }
    }

    for (const screen of targets) {
      await page.goto(`${BASE}/${screen.hash}`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      const violations = await audit(page);
      for (const violation of violations) {
        const entry = { screen: screen.name, ...violation };
        if (BLOCKING.has(violation.impact)) failures.push(entry);
        else advisories.push(entry);
      }
      const count = violations.length;
      process.stderr.write(`[a11y] ${screen.name}: ${count} violation(s)\n`);
    }

    if (advisories.length) {
      process.stderr.write(`\n[a11y] ${advisories.length} moderate/minor finding(s) for triage:\n`);
      for (const item of advisories) {
        process.stderr.write(`  ${item.screen} · ${item.id} · ${item.help} (${item.count} node(s))\n`);
        for (const node of item.nodes) process.stderr.write(`      ${node.target}\n`);
      }
    }
  } finally {
    await browser.close();
    if (child.exitCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill();
      await exited;
    }
    cleanup();
  }

  if (failures.length) {
    process.stderr.write(`\n[a11y] FAILED: ${failures.length} serious or critical violation(s):\n`);
    for (const item of failures) {
      process.stderr.write(`  ${item.screen} · ${item.id} · ${item.help} (${item.count} node(s))\n`);
      for (const node of item.nodes) process.stderr.write(`      ${node.target}\n        ${node.summary}\n`);
    }
    process.exitCode = 1;
    return;
  }
  process.stderr.write('\n[a11y] no serious or critical violations\n');
}

main().catch((error) => {
  process.stderr.write(`[a11y] audit failed: ${error && error.message}\n`);
  process.exitCode = 1;
});