'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { chromium } = require('playwright');

// Exercise the actual workspace nav callback in Chromium with a controlled
// animation-frame queue. The shared section nav focuses its target immediately
// after calling onNavigate; the save shortcut then focuses the save button.
test('a later save shortcut is not displaced by a pending section jump', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../apps/web/app/console/events/[id]/page/ThemeWorkspace.tsx'), 'utf8');
  const match = source.match(/onNavigate=\{\(id\) => \{([\s\S]*?)\n            \}\}/u);
  assert.ok(match, 'workspace navigation callback exists');
  const browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : {}) });
  try {
    const page = await browser.newPage();
    await page.setContent('<a id="nav" href="#theme-edit">편집</a><div id="theme-edit" tabindex="-1"><a id="shortcut" href="#theme-save">저장·게시 검토</a><button id="theme-save-draft">초안 저장</button></div>');
    const result = await page.evaluate((body) => {
      const frames = [];
      window.requestAnimationFrame = (fn) => { frames.push(fn); return frames.length; };
      window.setMobileView = () => {};
      window.setActiveSection = () => {};
      const onNavigate = new Function('id', body);
      const edit = document.getElementById('theme-edit');
      const shortcut = document.getElementById('shortcut');
      const save = document.getElementById('theme-save-draft');
      document.getElementById('nav').focus();
      onNavigate('theme-edit');
      edit.focus({ preventScroll: true }); // ConsoleSectionNav's immediate handoff
      shortcut.focus();
      save.focus(); // shortcut's synchronous handoff
      for (const frame of frames) frame();
      const laterFocus = document.activeElement.id;
      frames.length = 0;
      document.getElementById('nav').focus();
      onNavigate('theme-edit');
      // A hidden destination could not receive the shared nav's immediate
      // focus. Once React reveals it, the queued handoff must still work.
      for (const frame of frames) frame();
      return { laterFocus, revealedFocus: document.activeElement.id };
    }, match[1]);
    assert.equal(result.laterFocus, 'theme-save-draft');
    assert.equal(result.revealedFocus, 'theme-edit');
  } finally {
    await browser.close();
  }
});
