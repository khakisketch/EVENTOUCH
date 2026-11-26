'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { messageStep, openRecipientList, openMessageMore, closeRecipientList } = require('./ui-journey-helpers.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'message-focus'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser, page;
  try {
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await ctx.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await ctx.newPage(); page.on('dialog', dialog => dialog.accept());
    // Reopened 2026-11-24 (owner: 시안 A): the composer is one sentence with folded panels. The
    // recipient list opens from the 받는 사람 pill's 직접 고르기, and the record title lives under
    // 더 보기 (optional, auto-filled), so each step opens what it touches.
    const open = async () => {
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`);
      await page.locator('#message-compose-open').click();
      await openRecipientList(page);
      await page.getByRole('checkbox', { name: /표시 \d+명 모두 선택/ }).check();
      await closeRecipientList(page); // Reopened 2026-11-26: the list is a dialog; the work continues behind it
    };
    // The skip link is the only jump left: it moves focus to the body without gating anything.
    await open();
    await page.locator('a[data-skip-to="campaign-body"]').focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'campaign-body');
    // Moving between the title (under 더 보기) and the body keeps each value separate, and the body
    // keeps focus while typing even with the panels open.
    await openMessageMore(page);
    await page.locator('#campaign-title').fill('합성 제목');
    await page.locator('#campaign-body').focus();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'campaign-body');
    await page.keyboard.type('합성 내용');
    assert.equal(await page.locator('#campaign-title').inputValue(), '합성 제목');
    assert.equal(await page.locator('#campaign-body').inputValue(), '합성 내용');
    await page.screenshot({ path: path.join(out, 'composer-1280.png'), fullPage: true });
    // The send review is always reachable in its dock; reaching it never sends or validates.
    await messageStep(page, 3);
    assert.equal(await page.locator('#campaign-submit').isVisible(), true);
    // Validation lives in 발송 검토: with recipients but no body it directs focus to the body.
    await open();
    await page.locator('#campaign-submit').click();
    await page.waitForFunction(() => document.activeElement?.id === 'campaign-body');
    await page.locator('#campaign-body-error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#campaign-submit-warning').count(), 1);
    // If that validation focus is delayed, it must not steal a newly chosen field.
    await open();
    await page.evaluate(() => {
      const original = window.setTimeout.bind(window); window.__heldErrorFocus = [];
      window.setTimeout = function (fn, delay, ...args) {
        if (typeof fn === 'function' && delay === 0 && String(fn).includes('campaign-body') && String(fn).includes('recipient-status-filter') && !String(fn).includes('campaign-review-heading')) {
          window.__heldErrorFocus.push(() => fn(...args)); return 999998;
        }
        return original(fn, delay, ...args);
      };
    });
    await page.locator('#campaign-submit').click();
    await page.waitForFunction(() => window.__heldErrorFocus.length === 1);
    await openMessageMore(page);
    await page.locator('#campaign-title').focus(); await page.evaluate(() => window.__heldErrorFocus.shift()());
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'campaign-title');
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, defaultFocus: true, delayedFocusPreservesUserChoice: true, titleAndBodySeparate: true, reviewReached: true, validationFocusAndDelayedChoice: true, sent: false }, null, 2), { mode: 0o600 });
    console.log('PASS: skip focus, delayed focus respects user input, review reachable');
  } catch (error) { if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
