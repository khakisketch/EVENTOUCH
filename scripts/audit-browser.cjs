'use strict';

// Portable browser launcher for the product audits.
//
// The repo does not pin a Playwright version, so this prefers a Playwright
// already installed on the machine (matching its cached browsers) and falls
// back to the project's own dependency. A CHROMIUM_EXECUTABLE override is
// honored for machines whose browser layout differs; no absolute user path
// is hardcoded here.

function loadPlaywright() {
  for (const candidate of ['playwright']) {
    try {
      const mod = require(candidate);
      if (mod && mod.chromium) return mod;
    } catch (err) { /* try the next location */ }
  }
  throw new Error('playwright is required to run the product audits (npm ci, then npx playwright install --with-deps chromium)');
}

function launchOptions() {
  const executablePath = String(process.env.CHROMIUM_EXECUTABLE || '').trim();
  if (executablePath) return { executablePath };
  return {};
}

async function launchBrowser() {
  const { chromium } = loadPlaywright();
  return chromium.launch(launchOptions());
}

module.exports = { loadPlaywright, launchOptions, launchBrowser };
