'use strict';

// Exercises the real production routes against an owned, synthetic API schema.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const axe = require('axe-core').source;

async function run() {
  const capture = process.env.EVENTOUCH_CAPTURE_ROOT
    ? path.join(process.env.EVENTOUCH_CAPTURE_ROOT, `astryx-controls-${runStamp()}`)
    : defaultCaptureDir(`astryx-controls-${runStamp()}`);
  prepareCaptureDir(capture);
  ensureRunTmpDir(capture);
  let fixture;
  let browser;
  const results = [];
  try {
    fixture = await startAuditFixture();
    browser = await launchBrowser();
    for (const width of [1440, 1280, 390, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'Asia/Seoul', colorScheme: 'dark', isMobile: width < 768, hasTouch: width < 768 });
      await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const response = await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}`);
      assert.equal(response.status(), 200);
      assert.match(response.headers()['content-security-policy'] || '', /nonce-/);
      await page.locator('[data-console-page="overview"] #event-metrics-heading').waitFor();
      const refresh = page.getByRole('button', { name: '새로고침', exact: true });
      assert.equal(await refresh.getAttribute('data-product-action'), 'true', 'actual overview must use the product action adapter');
      assert.equal(await refresh.getAttribute('type'), 'button');
      await refresh.focus();
      await refresh.press('Enter');
      await page.waitForFunction(() => {
        const button = document.querySelector('button[aria-label="새로고침"]');
        return button && button.getAttribute('aria-busy') !== 'true';
      });
      assert.equal(await refresh.evaluate(element => element === document.activeElement), true, 'refresh retains keyboard focus');
      if (width === 1440) {
        const enabledPaint = await page.evaluate(async () => {
          const buttons = [...document.querySelectorAll('button[data-product-action]')]
            .filter(button => !button.disabled && button.getAttribute('aria-disabled') !== 'true' && button.getClientRects().length);
          const previous = buttons.map(button => ({ button, ariaDisabled: button.getAttribute('aria-disabled') }));
          try {
            for (const { button } of previous) {
              button.disabled = true;
              button.setAttribute('aria-disabled', 'true');
              getComputedStyle(button).opacity;
            }
            await Promise.all(buttons.flatMap(button => button.getAnimations()
              .filter(animation => animation.effect.getTiming().iterations !== Infinity)
              .map(animation => animation.finished.catch(() => {}))));
            for (const { button, ariaDisabled } of previous) {
              button.disabled = false;
              if (ariaDisabled === null) button.removeAttribute('aria-disabled');
              else button.setAttribute('aria-disabled', ariaDisabled);
            }
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            return buttons.map(button => ({ name: button.getAttribute('aria-label'), opacity: Number(getComputedStyle(button).opacity), transition: getComputedStyle(button).transition, animations: button.getAnimations().map(animation => ({ type: animation.constructor.name, state: animation.playState, frames: animation.effect.getKeyframes() })) }));
          } finally {
            for (const { button, ariaDisabled } of previous) {
              button.disabled = false;
              if (ariaDisabled === null) button.removeAttribute('aria-disabled');
              else button.setAttribute('aria-disabled', ariaDisabled);
            }
          }
        });
        assert.ok(enabledPaint.length > 0);
        assert.deepEqual(enabledPaint.filter(button => button.opacity < 0.999), [], 'available actions must not retain translucent disabled paint');
        await refresh.focus();
      }
      if (width >= 1280) {
        const alignment = await page.locator('.desktop-side-nav .console-nav-root-item').first().evaluate(anchor => {
          const icon = anchor.querySelector('svg').getBoundingClientRect();
          const caption = anchor.querySelector('span:not(.astryx-text)').getBoundingClientRect();
          return Math.abs((icon.y + icon.height / 2) - (caption.y + caption.height / 2));
        });
        assert.ok(alignment <= 3, `navigation icon and label must share one row: ${alignment}px`);
        const accountAlignment = await page.locator('.sidebar-bottom .operator-menu-trigger').evaluate(button => {
          const avatar = button.querySelector('.operator-avatar').getBoundingClientRect();
          const identity = button.querySelector('.operator-identity').getBoundingClientRect();
          return Math.abs(avatar.y + avatar.height / 2 - identity.y - identity.height / 2);
        });
        assert.ok(accountAlignment <= 3, `account identity and avatar must share one row: ${accountAlignment}px`);
      }
      const measurements = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        scheme: getComputedStyle(document.body).colorScheme,
        fontRole: getComputedStyle(document.querySelector("[data-console-page]")).getPropertyValue("--font-family-body"),
        undersized: [...document.querySelectorAll('button[data-product-action], a.product-action')]
          .filter(element => element.getClientRects().length)
          .map(element => ({ name: element.getAttribute('aria-label') || element.textContent.trim(), box: element.getBoundingClientRect() }))
          .filter(({ box }) => box.height < 43.5 || box.width < 43.5)
          .map(({ name, box }) => ({ name, width: box.width, height: box.height })),
      }));
      assert.ok(measurements.overflow <= 1, `horizontal overflow at ${width}: ${measurements.overflow}`);
      assert.equal(measurements.scheme, 'light', 'product stays explicitly light even when OS is dark');
      assert.match(measurements.fontRole, /Pretendard/, 'touch layouts retain the canonical font');
      assert.deepEqual(measurements.undersized, [], 'product action hit targets');
      await page.evaluate(axe);
      const violations = await page.evaluate(async () => (await window.axe.run(document, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] },
      })).violations.map(({ id, impact, nodes }) => ({ id, impact, targets: nodes.map(node => node.target), details: nodes.map(node => {
        const element = document.querySelector(node.target[0]);
        return { html: node.html, text: element?.innerText, name: element?.getAttribute('aria-label'), checks: node.any.map(check => ({ id: check.id, data: check.data })) };
      }) })));
      assert.deepEqual(violations, [], `accessibility at ${width}`);
      assert.deepEqual(errors, [], 'no runtime or hydration errors');
      await page.screenshot({ path: path.join(capture, `overview-${width}.png`), fullPage: true });
      results.push({ width, ...measurements, violations, pageErrors: errors });
      await context.close();
    }
    fs.writeFileSync(path.join(capture, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ ok: true, capture, results }, null, 2));
  } finally {
    if (browser) await browser.close();
    if (fixture) await fixture.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
