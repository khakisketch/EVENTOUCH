'use strict';

// Accessibility audit of the new Next.js app (apps/web) against a live
// build with a real API and an isolated PostgreSQL schema.
//
// Earlier accessibility work walked the retired vanilla hash shell
// (#/login, #/console/agency/…). That product is retired; this audits the
// sole UI instead: public, operator, staff, unknown-slug, unauthenticated
// private, and error states, all served from the running Next build through
// the same-origin test gateway (real reverse proxy, never a mocked API).
//
// Serious and critical axe violations fail the run. Moderate ones are
// reported for triage. The default root API and any user demo database are
// never touched.

const axeSource = require('axe-core').source;
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, auditRoutes, cookieForContext, assertAuditRoute } = require('./audit-fixture.cjs');

const BLOCKING = new Set(['serious', 'critical']);

async function audit(page) {
  // Browser-protocol instrumentation: evaluate runs through CDP, outside the
  // page's own script pipeline, so the production nonce CSP stays enabled
  // and normal hydration exercises the real policy. Tag-based injection
  // would be blocked by that policy (or need it weakened just for the audit).
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
      nodes: violation.nodes.slice(0, 3).map((node) => ({
        target: node.target.join(' '),
        summary: (node.failureSummary || '').split('\n').slice(0, 2).join(' '),
      })),
      count: violation.nodes.length,
    }));
  });
}

async function main() {
  let fixture;
  let browser;
  const failures = [];
  const advisories = [];
  try {
    fixture = await startAuditFixture();
  } catch (error) {
    process.stderr.write(`[a11y] ${error && error.message}\n`);
    process.exitCode = 2;
    return;
  }

  try {
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // Authenticated screens start from real sessions via cookies.
    await context.addCookies([
      { ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl },
      // One session cookie wins; staff coverage uses its own context below.
    ]);
    const page = await context.newPage();

    const targets = auditRoutes(fixture).map((route) => ({ ...route, auth: route.auth || null }));
    targets.push(
      { name: 'unknown-slug', path: '/event/unknown-slug-000000/home', auth: null },
      { name: 'unknown-screen', path: '/screen/unknown-slug-000000', auth: null },
      { name: 'login', path: '/login', auth: null },
    );

    for (const screen of targets) {
      // Each route audits as its real actor: staff and manager routes use
      // their sessions, public routes stay anonymous. A session on a public
      // route redirects by product design (e.g. / -> /console) and must not
      // leak from the previous iteration.
      if (screen.auth === 'staff') {
        await context.clearCookies();
        await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
      } else if (screen.auth === 'manager') {
        await context.clearCookies();
        await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
      } else {
        await context.clearCookies();
      }
      // domcontentloaded, not networkidle: the display board polls its
      // public projection on an interval, so networkidle never settles on
      // screen routes (and an unknown slug must still render its error
      // state for the audit instead of timing out the whole run).
      await page.goto(`${fixture.baseUrl}${screen.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(1500);
      // An error boundary, not-found page, or login redirect must fail the
      // run here, never count as an audited screen.
      await assertAuditRoute(page, screen);
      const violations = await audit(page);
      for (const violation of violations) {
        const entry = { screen: screen.name, ...violation };
        if (BLOCKING.has(violation.impact)) failures.push(entry);
        else advisories.push(entry);
      }
      process.stderr.write(`[a11y] ${screen.name}: ${violations.length} violation(s)\n`);
    }

    // Unauthenticated private route must not leak operator content.
    {
      const anon = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      const anonPage = await anon.newPage();
      await anonPage.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await anonPage.waitForTimeout(1500);
      const violations = await audit(anonPage);
      for (const violation of violations) {
        const entry = { screen: 'private-anon', ...violation };
        if (BLOCKING.has(violation.impact)) failures.push(entry);
        else advisories.push(entry);
      }
      process.stderr.write(`[a11y] private-anon: ${violations.length} violation(s)\n`);
      await anon.close();
    }

    // Staff console with its own session.
    {
      const staffCtx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await staffCtx.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
      const staffPage = await staffCtx.newPage();
      await staffPage.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await staffPage.waitForTimeout(1500);
      const violations = await audit(staffPage);
      for (const violation of violations) {
        const entry = { screen: 'staff-authed', ...violation };
        if (BLOCKING.has(violation.impact)) failures.push(entry);
        else advisories.push(entry);
      }
      process.stderr.write(`[a11y] staff-authed: ${violations.length} violation(s)\n`);
      await staffCtx.close();
    }

    if (advisories.length) {
      process.stderr.write(`\n[a11y] ${advisories.length} moderate/minor finding(s) for triage:\n`);
      for (const item of advisories) {
        process.stderr.write(`  ${item.screen} · ${item.id} · ${item.help} (${item.count} node(s))\n`);
        for (const node of item.nodes) process.stderr.write(`      ${node.target}\n`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (fixture) await fixture.close().catch(() => {});
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
