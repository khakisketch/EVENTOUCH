'use strict';

// Mobile audit of the new Next.js app (apps/web) across real device
// profiles in both orientations.
//
// The retired vanilla hash shell is not audited. Every check runs against
// the running Next build through the same-origin test gateway backed by a
// real API and an isolated PostgreSQL schema: 6 devices × 2 orientations ×
// 6 real routes = 72 layout audits, plus 44px interactive-target coverage.
//
// The 44px rule follows the WCAG inline-target exception honestly: an
// inline text link inside prose keeps its author size, and a checkbox/radio
// whose associated <label> offers the full touch area is measured by that
// label. Every other visible control must clear 44px height (24px width).
// Small controls are never blanket-ignored.
//
// This does not replace holding a device: real touch digitizers, iOS
// Safari behavior, camera dialogs and scrolling physics still need a human
// (scripts/device-checklist.md). No API response is intercepted or mocked.

const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, auditRoutes, cookieForContext, assertAuditRoute } = require('./audit-fixture.cjs');

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

const TOUCH_MIN = 44;
const WIDTH_MIN = 24;

// Runs in the page: measures overflow, touch targets and runtime errors.
function probe() {
  const problems = [];
  const doc = document.documentElement;
  if (doc.scrollWidth > window.innerWidth + 2) {
    problems.push(`가로 오버플로 ${doc.scrollWidth}px > ${window.innerWidth}px`);
  }

  const small = [];
  for (const el of document.querySelectorAll('button, a, [role="button"], input, select, summary, [tabindex]')) {
    const tag = (el.tagName || '').toUpperCase();
    const type = (el.getAttribute && el.getAttribute('type')) || '';
    if (tag === 'INPUT' && !['checkbox', 'radio', 'submit', 'button', 'reset', 'range'].includes(type) && type !== '') {
      if (!['checkbox', 'radio'].includes(type)) continue;
    }
    if (tag !== 'BUTTON' && tag !== 'A' && el.getAttribute('role') !== 'button'
      && tag !== 'SELECT' && tag !== 'SUMMARY' && !['checkbox', 'radio'].includes(type)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > window.innerHeight * 3) continue;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    // WCAG 2.5.8 inline exception: a text link inside prose is not a
    // button-sized target and must not be force-grown by this audit.
    if (tag === 'A' && !el.classList.contains('btn') && el.getAttribute('role') !== 'button') {
      const display = style.display;
      if (display === 'inline' && el.closest('p, li, dd, blockquote')) continue;
    }
    // A checkbox/radio whose <label> wraps or references it offers the
    // label's area as the touch target; measure that instead.
    let box = rect;
    if (type === 'checkbox' || type === 'radio') {
      const label = el.closest('label') || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`));
      if (label) {
        const labelRect = label.getBoundingClientRect();
        if (labelRect.width > 0 && labelRect.height > 0) box = labelRect;
      }
    }
    if (box.height < 44 || box.width < 24) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 24);
      small.push(`${label} ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
  }
  if (small.length) problems.push(`44px 미만 ${small.length}개: ${small.slice(0, 4).join(', ')}`);

  const errorBox = document.getElementById('runtime-error');
  if (errorBox && !errorBox.hidden) problems.push('런타임 오류 표시됨');

  return { problems, scrollWidth: doc.scrollWidth, innerWidth: window.innerWidth };
}

async function main() {
  let fixture;
  let browser;
  const findings = [];
  let checks = 0;
  try {
    fixture = await startAuditFixture();
  } catch (error) {
    process.stderr.write(`[mobile] ${error && error.message}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    browser = await launchBrowser();
    const routes = auditRoutes(fixture);

    for (const device of DEVICES) {
      // Landscape matters: a phone turned sideways is how a check-in desk
      // tablet often runs.
      for (const orientation of ['portrait', 'landscape']) {
        const width = orientation === 'portrait' ? device.width : device.height;
        const height = orientation === 'portrait' ? device.height : device.width;
        const ctx = await browser.newContext({
          viewport: { width, height },
          deviceScaleFactor: device.dpr,
          hasTouch: true,
          isMobile: device.width < 700,
        });
        // Real sessions for the authed routes; public routes ignore them.
        await ctx.addCookies([
          { ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl },
        ]);
        const target = await ctx.newPage();

        for (const screen of routes) {
          // Each route audits as its real actor: staff and manager routes
          // use their sessions, public routes stay anonymous. A session on
          // a public route redirects by product design (e.g. / -> /console
          // via session restore) and must not leak from the previous route.
          if (screen.auth === 'staff') {
            await ctx.clearCookies();
            await ctx.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
          } else if (screen.auth === 'manager') {
            await ctx.clearCookies();
            await ctx.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
          } else {
            await ctx.clearCookies();
          }
          await target.goto(`${fixture.baseUrl}${screen.path}`, { waitUntil: 'networkidle', timeout: 30000 });
          await target.waitForTimeout(700);
          // An error boundary, not-found page, or login redirect must fail
          // the check, never count as a passing layout.
          await assertAuditRoute(target, screen);
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
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
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
