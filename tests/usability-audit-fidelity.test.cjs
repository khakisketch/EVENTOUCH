'use strict';

// Usability-audit fidelity: the audit must read what the operator actually
// sees. The desktop roster renders rows as <tr> (the mobile <ul> card list
// is display:none at the audit viewport) and message history renders as
// <tr data-history-row> (deliveries are nested <li> inside a collapsed
// detail), so a bare `li` filter would observe hidden/stale containers.
// The failure-word scan excludes closed filter <select> content at the DOM
// boundary (never a global string subtraction), so an unselected
// "발송 실패" choice cannot flag while identical visible text elsewhere
// still fails.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const AUDIT = fs.readFileSync(path.join(ROOT, 'scripts/usability-audit.cjs'), 'utf8');
const { collectFailureCopy } = require('../scripts/usability-audit.cjs');
const { launchBrowser } = require('../scripts/audit-browser.cjs');

test('roster approval observes the visible table row, not the hidden mobile list', () => {
  assert.match(AUDIT, /table tbody tr/u, 'roster row must scope to the desktop table');
  assert.match(AUDIT, /getByText\('참가 확정', \{ exact: true \}\)/u);
  assert.doesNotMatch(
    AUDIT,
    /const row = page\.locator\('li'\)\.filter\(\{ hasText: seed\.pendingName \}\)/u,
    'bare li filter would read the display:none mobile list at 1280px'
  );
});

test('message history rows are scoped to the exact campaign table row', () => {
  const hits = AUDIT.match(/tr\[data-history-row\]/g) || [];
  assert.ok(hits.length >= 2, 'both message tasks must scope to tr[data-history-row]');
  assert.match(AUDIT, /historyItem\.getByText\(title, \{ exact: true \}\)/u);
  assert.doesNotMatch(
    AUDIT,
    /page\.locator\('li'\)\.filter\(\{ hasText: title \}\)/u,
    'bare li filter would miss the history table (only delivery <li> exist, hidden)'
  );
});

test('failure scan excludes selects at the DOM boundary, never by string subtraction', () => {
  assert.match(AUDIT, /querySelectorAll\('select'\)/u);
  assert.doesNotMatch(AUDIT, /split\(selText\)\.join/su, 'global string subtraction must not exist');
  assert.doesNotMatch(AUDIT, /split\(sel[A-Za-z]*\)\.join/su, 'global string subtraction must not exist');
  assert.match(AUDIT, /element\.setAttribute\('style', 'display: none !important;'\)/u, 'selects hide in place while scanning');
  assert.match(AUDIT, /실패\|못했습니다\|오류/u, 'FAILURE_COPY must still catch visible failures');
});

test('message evidence frames the verified history row without hiding its cost', () => {
  const frames = AUDIT.match(/scrollIntoViewIfNeeded\(\{ timeout: 5000 \}\)/g) || [];
  assert.ok(frames.length >= 2, 'both message tasks must frame their history row for the screenshot');
  assert.match(AUDIT, /stays in the measured scrolls/u);
});

async function collectOnHtml(html, failureIgnore = []) {
  const attempt = async (options) => {
    const { chromium } = require('playwright');
    const browser = await chromium.launch(options);
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(html);
      const task = { errors: [], failureIgnore };
      await collectFailureCopy(page, task);
      await context.close().catch(() => {});
      return task.errors;
    } finally {
      await browser.close().catch(() => {});
    }
  };
  // Audits run against real Chromium: prefer the owned launcher, but fall
  // back to the system Chrome where the Playwright bundle is absent.
  try {
    const browser = await launchBrowser();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.setContent(html);
      const task = { errors: [], failureIgnore };
      await collectFailureCopy(page, task);
      await context.close().catch(() => {});
      return task.errors;
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (error) {
    const fallback = String(process.env.CHROMIUM_EXECUTABLE || '').trim() || '/usr/bin/google-chrome';
    try {
      fs.statSync(fallback);
    } catch {
      throw error;
    }
    return attempt({ executablePath: fallback });
  }
}

test('real detector: identical visible failure before AND after a single-option select still fails', async () => {
  const html = '<main><p>발송 실패</p>'
    + '<select><option>발송 실패</option></select>'
    + '<p>발송 실패</p></main>';
  const errors = await collectOnHtml(html);
  assert.equal(errors.length, 1, `visible failures around the select must fail, got ${JSON.stringify(errors)}`);
  assert.match(errors[0], /발송 실패|실패류 문구/u);
});

test('real detector: an identical failure on either side of a select still fails', async () => {
  for (const html of [
    '<main><p>발송 실패</p><select><option>발송 실패</option></select></main>',
    '<main><select><option>발송 실패</option></select><p>발송 실패</p></main>',
  ]) {
    const errors = await collectOnHtml(html);
    assert.equal(errors.length, 1, `visible failure must not be removed with the select: ${JSON.stringify(errors)}`);
  }
});

test('real detector: scanning restores select inline styles and priorities', async () => {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setContent('<select style="display:inline-block !important;color:red"><option>발송 실패</option></select><select><option>발송 실패</option></select><p>발송 실패</p>');
    const before = await page.locator('select').evaluateAll((elements) => elements.map((element) => element.getAttribute('style')));
    const task = { errors: [], failureIgnore: [] };
    await collectFailureCopy(page, task);
    const after = await page.locator('select').evaluateAll((elements) => elements.map((element) => element.getAttribute('style')));
    assert.deepEqual(after, before, 'the audit must not alter the UI it is inspecting');
    assert.equal(task.errors.length, 1);
  } finally {
    await browser.close();
  }
});

test('real detector: multi-option filter-only state passes', async () => {
  const html = '<main><label>발송 상태'
    + '<select><option>모든 상태</option><option>예약</option><option>연결 필요</option>'
    + '<option>발송 중</option><option>일부 실패</option><option>발송 실패</option>'
    + '<option>발송 완료</option><option>모의 발송 · 전달 없음</option><option>취소</option></select>'
    + '</label><p>총 1건 기록 목록</p></main>';
  const errors = await collectOnHtml(html);
  assert.deepEqual(errors, [], `unselected filter options must not flag, got ${JSON.stringify(errors)}`);
});

test('real detector: separate visible FAILED status chip fails', async () => {
  const html = '<main><label>발송 상태'
    + '<select><option>모든 상태</option><option>발송 실패</option></select></label>'
    + '<table><tbody><tr><td><span>발송 실패</span></td></tr></tbody></table></main>';
  const errors = await collectOnHtml(html);
  assert.equal(errors.length, 1, `visible status chip must fail, got ${JSON.stringify(errors)}`);
});

test('real detector: visible alert fails even with the filter present', async () => {
  const html = '<main><div role="alert">승인하지 못했습니다.</div>'
    + '<select><option>모든 상태</option><option>발송 실패</option></select></main>';
  const errors = await collectOnHtml(html);
  assert.ok(errors.some((line) => line.includes('승인하지 못했습니다.')), `alert text must fail, got ${JSON.stringify(errors)}`);
});

test('real detector: import review zero-error copy keeps its exemption', async () => {
  const html = '<main><p>유효 2행 · 오류 0행. 오류 행은 제외되며 원본 파일에서 수정 후 다시 가져올 수 있습니다.</p></main>';
  const errors = await collectOnHtml(html, [
    /오류 \d+행/g,
    /오류 행은 제외되며 원본 파일에서 수정 후 다시 가져올 수 있습니다\./,
  ]);
  assert.deepEqual(errors, [], `review exemption must hold with native spacing, got ${JSON.stringify(errors)}`);
});
