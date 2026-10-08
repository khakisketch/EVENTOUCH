// Run in a named Playwright CLI session against the actual EVENTOUCH fixture:
// playwright-cli -s=eventouch-toast --config=/home/ksi/.config/opencode/browser/playwright.json open about:blank
// playwright-cli -s=eventouch-toast run-code --filename=tests/browser/mobile-admin-toast-layout.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const widths = [320, 390];
  const message = '지도 검증 운영자 계정으로 빠른 로그인으로 접속했습니다.';
  const selectors = ['.topbar', '.page-head', '.page-head .actions'];
  const protectedSelectors = [...selectors, '.toolbar', '.panel'];

  await page.setViewportSize({ width: widths[0], height: 844 });
  await page.goto(`${baseUrl}/?__toast_layout_run=${Date.now()}#/login`);
  await page.locator('#dev-quick-login').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '빠른 로그인' }).click();
  await page.waitForFunction(() => location.hash === '#/console/agency/events');
  await page.locator('.page-head h1').waitFor({ state: 'visible' });

  const geometry = (selectorsToMeasure = selectors) => page.evaluate(selectorsToMeasure => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { top: box.top, bottom: box.bottom, left: box.left, right: box.right };
    };
    return {
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      elements: Object.fromEntries(selectorsToMeasure.map(selector => {
        const element = document.querySelector(selector);
        if (!element) throw new Error(`Missing layout target: ${selector}`);
        return [selector, rect(element)];
      })),
      toast: rect(document.querySelector('#toast')),
      toastText: document.querySelector('#toast').textContent.trim(),
      toastRole: document.querySelector('#toast').getAttribute('role'),
      toastLive: document.querySelector('#toast').getAttribute('aria-live'),
    };
  }, selectorsToMeasure);

  const assertStable = (before, after, phase, width) => {
    for (const selector of selectors) {
      const delta = Math.abs(after.elements[selector].top - before.elements[selector].top);
      if (delta > 8) {
        throw new Error(`${width}px ${phase}: ${selector} moved ${delta.toFixed(1)}px (limit 8px)`);
      }
    }
  };

  const overlaps = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
  const results = [];

  await page.waitForFunction(() => document.querySelector('#toast')?.textContent.trim());
  const quickLoginVisible = await geometry(protectedSelectors);
  if (!quickLoginVisible.toastText.includes('빠른 로그인으로 접속했습니다.')) {
    throw new Error('Quick-login success toast was not preserved across the route change');
  }
  if (quickLoginVisible.toastRole !== 'status' || quickLoginVisible.toastLive !== 'polite') {
    throw new Error('Quick-login toast lost its accessible status semantics');
  }
  if (quickLoginVisible.documentWidth > quickLoginVisible.clientWidth) {
    throw new Error('320px quick-login toast state has horizontal overflow');
  }
  for (const selector of protectedSelectors) {
    if (overlaps(quickLoginVisible.toast, quickLoginVisible.elements[selector])) {
      throw new Error(`320px quick-login toast obscures ${selector} after navigation`);
    }
  }
  await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
  const quickLoginDismissed = await geometry();
  assertStable(quickLoginVisible, quickLoginDismissed, 'quick-login dismissal', widths[0]);

  for (const width of widths) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
    const before = await geometry();
    if (before.elements['.topbar'].top > 8) {
      throw new Error(`${width}px baseline: sticky topbar starts ${before.elements['.topbar'].top.toFixed(1)}px below the viewport top`);
    }
    const headingLimit = 120;
    const actionLimit = width === 320 ? 258 : 232;
    if (before.elements['.page-head'].top > headingLimit) {
      throw new Error(`${width}px baseline: page heading starts ${before.elements['.page-head'].top.toFixed(1)}px down; limit ${headingLimit}px`);
    }
    if (before.elements['.page-head .actions'].top > actionLimit) {
      throw new Error(`${width}px baseline: primary action starts ${before.elements['.page-head .actions'].top.toFixed(1)}px down; limit ${actionLimit}px`);
    }

    const focusPreserved = await page.evaluate(text => {
      const activeElement = document.activeElement;
      window.ET.toast(text);
      return document.activeElement === activeElement;
    }, message);
    if (!focusPreserved) {
      throw new Error(`${width}px toast appearance moved keyboard focus`);
    }
    await page.waitForFunction(text => document.querySelector('#toast')?.textContent.trim() === text, message);
    const visible = await geometry(protectedSelectors);

    if (visible.toastRole !== 'status' || visible.toastLive !== 'polite') {
      throw new Error(`${width}px toast lost its accessible status semantics`);
    }
    if (visible.documentWidth > visible.clientWidth) {
      throw new Error(`${width}px page has horizontal overflow while the toast is visible`);
    }
    for (const selector of protectedSelectors) {
      if (overlaps(visible.toast, visible.elements[selector])) {
        throw new Error(`${width}px toast obscures ${selector}`);
      }
    }
    assertStable(before, visible, 'toast appearance', width);

    const scrollTargets = await page.evaluate(() => [...new Set([
      80,
      160,
      Math.max(0, Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight),
    ])]);
    for (const scrollY of scrollTargets) {
      await page.evaluate(y => {
        document.documentElement.style.scrollBehavior = 'auto';
        document.body.style.scrollBehavior = 'auto';
        window.scrollTo({ top: y, behavior: 'instant' });
      }, scrollY);
      await page.waitForFunction(y => Math.abs(window.scrollY - y) < 2, scrollY);
      const scrolled = await geometry(protectedSelectors);
      for (const selector of protectedSelectors) {
        if (overlaps(scrolled.toast, scrolled.elements[selector])) {
          throw new Error(`${width}px toast obscures ${selector} while scrolling to ${scrollY}px`);
        }
      }
    }
    await page.evaluate(() => window.scrollTo(0, 0));

    await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
    const dismissed = await geometry();
    assertStable(visible, dismissed, 'toast dismissal', width);
    assertStable(before, dismissed, 'dismissed state', width);
    results.push({ width, before, visible, dismissed });
  }

  return results;
}
