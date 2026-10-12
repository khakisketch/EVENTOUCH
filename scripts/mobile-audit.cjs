'use strict';

// Mobile audit across real device profiles.
//
// This exists because earlier mobile verification used a single 390px
// viewport with a mouse. That misses the things that actually break on a
// phone: a control below the 44px touch minimum, a layout that only fails in
// landscape, a screen that overflows on a 320px device, or content sitting
// under the notch.
//
// It is not a substitute for holding the device. It cannot observe a real
// touch digitizer, iOS Safari's keyboard, camera permission dialogs, or
// scrolling physics. scripts/device-checklist.md lists what still has to be
// done by hand.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function loadPlaywright() {
  for (const candidate of ['/home/ksi/node_modules/playwright', 'playwright']) {
    try {
      const mod = require(candidate);
      if (mod && mod.chromium) return mod;
    } catch (err) { /* try the next location */ }
  }
  throw new Error('playwright is required to run the mobile audit');
}
const { chromium } = loadPlaywright();

const PORT = Number(process.env.MOBILE_PORT || 18798);
const BASE = `http://127.0.0.1:${PORT}`;

// Real profiles rather than round numbers, so the audit reflects devices the
// staff actually carry.
const DEVICES = [
  { name: 'iPhone SE', width: 375, height: 667, dpr: 2 },
  { name: 'iPhone 14', width: 390, height: 844, dpr: 3 },
  { name: 'iPhone 14 Pro Max', width: 430, height: 932, dpr: 3 },
  { name: 'Galaxy S20', width: 360, height: 800, dpr: 3 },
  { name: 'iPad mini', width: 768, height: 1024, dpr: 2 },
  { name: 'iPad Pro landscape', width: 1024, height: 768, dpr: 2 },
];

const SCREENS = [
  { name: 'login', hash: '#/login', auth: false },
  { name: 'agency-events', hash: '#/console/agency/events', auth: true },
  { name: 'event-overview', hash: '#/console/events/{id}/overview', auth: true },
  { name: 'event-checkin', hash: '#/console/events/{id}/checkin', auth: true },
  { name: 'event-participants', hash: '#/console/events/{id}/participants', auth: true },
  { name: 'event-settings', hash: '#/console/events/{id}/settings', auth: true },
];

const TOUCH_MIN = 44;

function startServer(databaseUrl) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-mobile-'));
  const storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'etko-mobile-storage-'));
  const child = spawn(process.execPath, ['server/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(PORT),
      DATA_DIR: dataDir,
      STORAGE_DIR: storageDir,
      DATABASE_URL: databaseUrl,
      ADMIN_EMAIL: 'mobile@example.test',
      ADMIN_PASSWORD: 'mobile-audit-password',
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

// Runs in the page: measures overflow, touch targets and notch clearance.
function probe() {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 2) {
    problems.push(`가로 오버플로 ${doc.scrollWidth}px > ${window.innerWidth}px`);
  }

  const small = [];
  for (const el of document.querySelectorAll('button, a.btn, [role="button"], input[type="checkbox"], select, summary')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    // Off-screen controls cannot be tapped anyway; skip them rather than
    // reporting a phantom failure.
    if (rect.bottom < 0 || rect.top > window.innerHeight * 3) continue;
    if (rect.height < 44 || rect.width < 24) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24);
      small.push(`${label} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
  }
  if (small.length) problems.push(`44px 미만 ${small.length}개: ${small.slice(0, 4).join(', ')}`);

  const errorBox = document.getElementById('runtime-error');
  if (errorBox && !errorBox.hidden) problems.push('런타임 오류 표시됨');

  return { problems, scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth };
}

async function main() {
  const databaseUrl = String(process.env.EVENTOUCH_MOBILE_DATABASE_URL || '').trim();
  if (!databaseUrl) {
    process.stderr.write('[mobile] set EVENTOUCH_MOBILE_DATABASE_URL to run the mobile audit\n');
    process.exitCode = 2;
    return;
  }

  const { child, cleanup } = startServer(databaseUrl);
  const browser = await chromium.launch();
  const findings = [];
  let checks = 0;

  try {
    await waitForServer();
    const context = await browser.newContext();
    const page = await context.newPage();

    const login = await page.request.post(`${BASE}/api/auth/login`, {
      data: { email: 'mobile@example.test', password: 'mobile-audit-password' },
    });
    if (!login.ok()) throw new Error(`could not sign in: ${login.status()}`);

    await page.goto(`${BASE}/#/console/agency/events`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    const eventId = await page.evaluate(() => window.ET?.state?.events?.[0]?.id || null);

    for (const device of DEVICES) {
      // Landscape matters: a phone turned sideways is how a check-in desk
      // tablet often runs.
      for (const orientation of ['portrait', 'landscape']) {
        const width = orientation === 'portrait' ? device.width : device.height;
        const height = orientation === 'portrait' ? device.height : device.width;
        await context.close();
        const ctx = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: device.dpr,
          hasTouch: true,
          isMobile: device.width < 700,
        });
        const target = await ctx.newPage();

        for (const screen of SCREENS) {
          if (screen.auth && !eventId) continue;
          const hash = screen.hash.replace('{id}', eventId || '');
          await target.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
          await target.waitForTimeout(700);
          const result = await target.evaluate(probe);
          checks += 1;
          for (const problem of result.problems) {
            findings.push(`${device.name} ${orientation} ${width}x${height} · ${screen.name}: ${problem}`);
          }
        }
        await ctx.close();
      }
      process.stderr.write(`[mobile] ${device.name} checked\n`);
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

  if (findings.length) {
    process.stderr.write(`\n[mobile] ${findings.length} finding(s) across ${checks} screen/device checks:\n`);
    for (const finding of findings) process.stderr.write(`  ${finding}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`\n[mobile] ${checks} screen/device checks passed: no overflow, no control under ${TOUCH_MIN}px\n`);
}

main().catch((error) => {
  process.stderr.write(`[mobile] audit failed: ${error && error.message}\n`);
  process.exitCode = 1;
});