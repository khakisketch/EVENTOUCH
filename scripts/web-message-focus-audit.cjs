'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

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
    const open = async () => {
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/messages`);
      await page.locator('#message-compose-open').click();
      await page.getByRole('checkbox', { name: /표시 \d+명 모두 선택/ }).check();
    };
    await open(); await page.getByRole('button', { name: '내용 작성', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'campaign-title');
    // Delay only the app's step-transition focus callback. This represents a
    // busy browser where an operator reaches another field before the timer.
    await open(); await page.evaluate(() => {
      const original = window.setTimeout.bind(window); window.__heldFocus = [];
      window.setTimeout = function (fn, delay, ...args) {
        if (typeof fn === 'function' && delay === 0 && String(fn).includes('campaign-heading') && String(fn).includes('campaign-title')) {
          window.__heldFocus.push(() => fn(...args)); return 999999;
        }
        return original(fn, delay, ...args);
      };
    });
    await page.getByRole('button', { name: '내용 작성', exact: true }).click();
    await page.locator('#campaign-title').fill('합성 제목');
    await page.locator('#campaign-body').focus();
    assert.equal(await page.evaluate(() => window.__heldFocus.length), 1);
    await page.evaluate(() => window.__heldFocus.shift()());
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'campaign-body');
    await page.keyboard.type('합성 내용');
    assert.equal(await page.locator('#campaign-title').inputValue(), '합성 제목');
    assert.equal(await page.locator('#campaign-body').inputValue(), '합성 내용');
    await page.screenshot({ path: path.join(out, 'composer-1280.png'), fullPage: true });
    await page.getByRole('button', { name: '발송 검토로', exact: true }).click();
    await page.getByRole('navigation', { name: '메시지 작성 단계' }).locator('[aria-current="step"]').filter({ hasText: '검토·발송' }).waitFor();
    // Validation still directs the operator to the missing field normally.
    await open(); await page.getByRole('button', { name: '내용 작성', exact: true }).click(); await page.waitForFunction(() => document.activeElement?.id === 'campaign-title'); await page.locator('#campaign-title').fill('합성 제목');
    await page.getByRole('button', { name: '발송 검토로', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'campaign-body');
    // If that validation focus is delayed, it must not steal a newly chosen field.
    await open(); await page.getByRole('button', { name: '내용 작성', exact: true }).click(); await page.waitForFunction(() => document.activeElement?.id === 'campaign-title'); await page.locator('#campaign-title').fill('합성 제목');
    await page.evaluate(() => {
      const original = window.setTimeout.bind(window); window.__heldErrorFocus = [];
      window.setTimeout = function (fn, delay, ...args) {
        if (typeof fn === 'function' && delay === 0 && String(fn).includes('campaign-body') && String(fn).includes('recipient-status-filter') && !String(fn).includes('campaign-heading')) {
          window.__heldErrorFocus.push(() => fn(...args)); return 999998;
        }
        return original(fn, delay, ...args);
      };
    });
    await page.getByRole('button', { name: '발송 검토로', exact: true }).click();
    await page.waitForFunction(() => window.__heldErrorFocus.length === 1);
    await page.locator('#campaign-title').focus(); await page.evaluate(() => window.__heldErrorFocus.shift()());
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'campaign-title');
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, defaultFocus: true, delayedFocusPreservesUserChoice: true, titleAndBodySeparate: true, reviewReached: true, validationFocusAndDelayedChoice: true, sent: false }, null, 2), { mode: 0o600 });
    console.log('PASS: default step focus, delayed focus respects user input, review reachable');
  } catch (error) { if (page) await page.screenshot({ path: path.join(out, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
  finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
