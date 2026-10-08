// Run against the actual EVENTOUCH fixture:
// playwright-cli -s=eventouch-toast-edges --config=/home/ksi/.config/opencode/browser/playwright.json open about:blank
// playwright-cli -s=eventouch-toast-edges run-code --filename=tests/browser/mobile-admin-toast-edge-layout.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const message = '지도 검증 운영자 계정으로 빠른 로그인으로 접속했습니다.';
  const allResults = {};

  for (const width of [320, 390]) {
  const failures = [];
  const results = {};
  await page.setViewportSize({ width, height: 844 });
  await page.goto(`${baseUrl}/?__toast_edge_run=${width}-${Date.now()}#/login`);
  await page.locator('#dev-quick-login').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '빠른 로그인' }).click();
  await page.waitForFunction(() => location.hash === '#/console/agency/events');
  await page.locator('.page-head h1').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  results.toastRestoreBaseline = await page.evaluate(() => {
    const documentTop = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return rect.top + window.scrollY;
    };
    return {
      pageHeadBottom: documentTop('.page-head') + document.querySelector('.page-head').getBoundingClientRect().height,
      actionTop: documentTop('.page-head .actions'),
      toolbarTop: documentTop('.toolbar'),
      inlineMarginBottom: document.querySelector('.page-head').style.marginBottom,
    };
  });

  // A mobile-admin toast raised while a dialog is open must remain visible
  // without hiding the sticky menu or modal title/actions behind the scrim.
  await page.evaluate(() => window.ET.dialog('토스트 검증', '<p>확인용 모달입니다.</p>'));
  const modalFocusPreserved = await page.evaluate(text => {
    const active = document.activeElement;
    window.ET.toast(text);
    return document.activeElement === active;
  }, message);
  await page.waitForFunction(text => document.querySelector('#toast')?.textContent.trim() === text, message);
  results.modal = await page.evaluate(() => {
    const toast = document.querySelector('#toast');
    const box = toast.getBoundingClientRect();
    const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    return {
      toast: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      toastIsHitTarget: hit === toast || toast.contains(hit),
      toastRole: toast.getAttribute('role'),
      toastLive: toast.getAttribute('aria-live'),
      topbar: document.querySelector('.topbar')?.getBoundingClientRect().toJSON(),
      modalHeader: document.querySelector('.modal header')?.getBoundingClientRect().toJSON(),
      modalFooter: document.querySelector('.modal footer')?.getBoundingClientRect().toJSON(),
    };
  });
  if (!modalFocusPreserved) failures.push('modal toast appearance moved keyboard focus');
  if (!results.modal.toastIsHitTarget) failures.push('modal toast is painted behind the dialog scrim');
  for (const selector of ['.topbar', '.modal header', '.modal footer']) {
    const collides = await page.evaluate(({ toastBox, selectorToCheck }) => {
      const node = document.querySelector(selectorToCheck);
      if (!node) return false;
      const target = node.getBoundingClientRect();
      return toastBox.left < target.right && toastBox.right > target.left && toastBox.top < target.bottom && toastBox.bottom > target.top;
    }, { toastBox: results.modal.toast, selectorToCheck: selector });
    if (collides) failures.push(`modal toast obscures ${selector}`);
  }
  await page.waitForFunction(text => document.querySelector('#toast')?.textContent.trim() === text, message);
  await page.evaluate(() => window.ET.close());
  await page.waitForFunction(() => !document.querySelector('.overlay'));
  await page.waitForFunction(() => {
    const toast = document.querySelector('#toast');
    return toast?.classList.contains('admin-flow-toast') && !toast.classList.contains('admin-viewport-toast');
  });
  results.modalClosedToast = await page.evaluate(() => {
    const box = document.querySelector('#toast').getBoundingClientRect();
    const overlap = selector => {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      return rect && box.left < rect.right && box.right > rect.left && box.top < rect.bottom && box.bottom > rect.top;
    };
    return {
      toast: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      visible: box.bottom > 0 && box.top < innerHeight,
      className: document.querySelector('#toast').className,
      overlapsTopbar: overlap('.topbar'),
      overlapsPageHead: overlap('.page-head'),
      overlapsAction: overlap('.page-head .actions'),
      overlapsToolbar: overlap('.toolbar'),
    };
  });
  if (!results.modalClosedToast.visible) failures.push('toast is not visible after its dialog closes');
  if (!results.modalClosedToast.className.includes('admin-flow-toast') || results.modalClosedToast.className.includes('admin-viewport-toast')) {
    failures.push('closing the dialog did not return an active toast to normal flow placement');
  }
  for (const selector of ['overlapsTopbar', 'overlapsPageHead', 'overlapsAction', 'overlapsToolbar']) {
    if (results.modalClosedToast[selector]) failures.push(`toast after dialog close obscures ${selector}`);
  }
  await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
  results.modalClosedDismissal = await page.evaluate(() => {
    const documentTop = selector => {
      const rect = document.querySelector(selector).getBoundingClientRect();
      return rect.top + window.scrollY;
    };
    const head = document.querySelector('.page-head');
    return {
      pageHeadBottom: documentTop('.page-head') + head.getBoundingClientRect().height,
      actionTop: documentTop('.page-head .actions'),
      toolbarTop: documentTop('.toolbar'),
      inlineMarginBottom: head.style.marginBottom,
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    };
  });
  for (const anchor of ['pageHeadBottom', 'actionTop', 'toolbarTop']) {
    if (Math.abs(results.modalClosedDismissal[anchor] - results.toastRestoreBaseline[anchor]) > 1) {
      failures.push(`dialog-close toast dismissal did not restore ${anchor}`);
    }
  }
  if (results.modalClosedDismissal.inlineMarginBottom !== results.toastRestoreBaseline.inlineMarginBottom) {
    failures.push('dialog-close toast dismissal did not restore the page-head margin');
  }
  if (results.modalClosedDismissal.scrollWidth !== results.modalClosedDismissal.clientWidth) {
    failures.push('dialog-close toast dismissal introduced horizontal overflow');
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  // The reverse ordering must also keep toast feedback above the newly opened scrim.
  await page.evaluate(text => window.ET.toast(text), message);
  await page.waitForFunction(text => document.querySelector('#toast')?.textContent.trim() === text, message);
  await page.evaluate(() => window.ET.dialog('토스트 검증', '<p>확인용 모달입니다.</p>'));
  await page.locator('.overlay').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.querySelector('.modal')?.getAnimations().every(animation => animation.playState === 'finished'));
  results.toastBeforeModal = await page.evaluate(() => {
    const toast = document.querySelector('#toast');
    const box = toast.getBoundingClientRect();
    const hit = document.elementFromPoint((box.left + box.right) / 2, (box.top + box.bottom) / 2);
    const overlap = selector => {
      const target = document.querySelector(selector)?.getBoundingClientRect();
      return target && box.left < target.right && box.right > target.left && box.top < target.bottom && box.bottom > target.top;
    };
    return {
      toast: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      toastIsHitTarget: hit === toast || toast.contains(hit),
      overlapsTopbar: overlap('.topbar'),
      overlapsModalHeader: overlap('.modal header'),
      overlapsModalFooter: overlap('.modal footer'),
    };
  });
  if (!results.toastBeforeModal.toastIsHitTarget) failures.push('toast shown before modal is hidden behind the dialog scrim');
  for (const selector of ['overlapsTopbar', 'overlapsModalHeader', 'overlapsModalFooter']) {
    if (results.toastBeforeModal[selector]) failures.push(`toast shown before modal obscures ${selector}`);
  }
  await page.waitForFunction(text => document.querySelector('#toast')?.textContent.trim() === text, message);
  await page.evaluate(() => window.ET.close());
  await page.waitForFunction(() => !document.querySelector('.overlay'));
  await page.waitForFunction(() => {
    const toast = document.querySelector('#toast');
    return toast?.classList.contains('admin-flow-toast') && !toast.classList.contains('admin-viewport-toast');
  });
  results.toastBeforeModalClosed = await page.evaluate(() => {
    const toast = document.querySelector('#toast');
    const box = toast.getBoundingClientRect();
    const overlaps = selector => {
      const target = document.querySelector(selector)?.getBoundingClientRect();
      return target && box.left < target.right && box.right > target.left && box.top < target.bottom && box.bottom > target.top;
    };
    return {
      visible: box.bottom > 0 && box.top < innerHeight,
      className: toast.className,
      overlapsTopbar: overlaps('.topbar'),
      overlapsPageHead: overlaps('.page-head'),
      overlapsAction: overlaps('.page-head .actions'),
      overlapsToolbar: overlaps('.toolbar'),
    };
  });
  if (!results.toastBeforeModalClosed.visible) failures.push('toast-first feedback is not visible after its dialog closes');
  if (!results.toastBeforeModalClosed.className.includes('admin-flow-toast') || results.toastBeforeModalClosed.className.includes('admin-viewport-toast')) {
    failures.push('toast-first dialog close did not restore normal flow placement');
  }
  for (const selector of ['overlapsTopbar', 'overlapsPageHead', 'overlapsAction', 'overlapsToolbar']) {
    if (results.toastBeforeModalClosed[selector]) failures.push(`toast-first feedback after dialog close obscures ${selector}`);
  }
  await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));

  // Simulate a long admin content region with a real focusable action at deep scroll.
  // Keep the test-only action inside .content so the real sticky topbar stays in its shell.
  await page.evaluate(text => {
    const action = document.createElement('button');
    action.id = 'toast-deep-trigger';
    action.className = 'btn';
    action.type = 'button';
    action.textContent = '깊은 화면 테스트 동작';
    action.style.cssText = 'display:block;margin-top:1200px;';
    action.addEventListener('click', () => window.ET.toast(text));
    document.querySelector('.content').append(action);
  }, message);
  await page.locator('#toast-deep-trigger').scrollIntoViewIfNeeded();
  await page.getByRole('button', { name: '깊은 화면 테스트 동작' }).click();
  await page.waitForFunction(text => document.querySelector('#toast')?.textContent.trim() === text, message);
  results.deepScroll = await page.evaluate(() => {
    const toast = document.querySelector('#toast');
    const box = toast.getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const action = document.querySelector('#toast-deep-trigger').getBoundingClientRect();
    const overlap = target => box.left < target.right && box.right > target.left && box.top < target.bottom && box.bottom > target.top;
    return {
      scrollY: window.scrollY,
      viewportHeight: innerHeight,
      toast: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      visible: box.bottom > 0 && box.top < innerHeight,
      overlapsTopbar: overlap(topbar),
      overlapsAction: overlap(action),
      toastRole: toast.getAttribute('role'),
      toastLive: toast.getAttribute('aria-live'),
    };
  });
  if (!results.deepScroll.visible) failures.push('toast triggered from deep scroll is outside the viewport');
  if (results.deepScroll.overlapsTopbar) failures.push('deep-scroll toast obscures the sticky topbar');
  if (results.deepScroll.overlapsAction) failures.push('deep-scroll toast obscures its triggering action');
  await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
  await page.evaluate(() => {
    document.querySelector('#toast-deep-trigger')?.remove();
    window.scrollTo({ top: 0, behavior: 'instant' });
  });

  // Some admin shells can render an empty/permission state without .page-head.
  // The fallback still needs to be visible and clear of the sticky menu.
  await page.evaluate(() => document.querySelector('.page-head')?.remove());
  results.noPageHeadBaselineToolbarTop = await page.locator('.toolbar').evaluate(node => node.getBoundingClientRect().top);
  await page.evaluate(text => window.ET.toast(text), message);
  await page.waitForFunction(text => document.querySelector('#toast')?.textContent.trim() === text, message);
  results.noPageHead = await page.evaluate(() => {
    const toast = document.querySelector('#toast');
    const box = toast.getBoundingClientRect();
    const topbar = document.querySelector('.topbar').getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar')?.getBoundingClientRect();
    const panel = document.querySelector('.panel')?.getBoundingClientRect();
    const overlap = target => target && box.left < target.right && box.right > target.left && box.top < target.bottom && box.bottom > target.top;
    return {
      toast: { top: box.top, bottom: box.bottom, left: box.left, right: box.right },
      visible: box.bottom > 0 && box.top < innerHeight,
      overlapsTopbar: overlap(topbar),
      overlapsToolbar: overlap(toolbar),
      overlapsPanel: overlap(panel),
      toastRole: toast.getAttribute('role'),
      toastLive: toast.getAttribute('aria-live'),
    };
  });
  if (!results.noPageHead.visible) failures.push('toast without a page-head anchor is outside the viewport');
  if (results.noPageHead.overlapsTopbar) failures.push('page-head fallback toast obscures the sticky topbar');
  if (results.noPageHead.overlapsToolbar) failures.push('page-head fallback toast obscures .toolbar');
  if (results.noPageHead.overlapsPanel) failures.push('page-head fallback toast obscures .panel');
  await page.evaluate(() => {
    const toolbar = document.querySelector('.toolbar');
    const replacement = toolbar.cloneNode(true);
    replacement.style.marginTop = '';
    toolbar.replaceWith(replacement);
  });
  await page.waitForFunction(() => {
    const toast = document.querySelector('#toast')?.getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar')?.getBoundingClientRect();
    return toast && toolbar && toolbar.top >= toast.bottom;
  });
  results.noPageHeadAfterRender = await page.evaluate(() => {
    const toast = document.querySelector('#toast').getBoundingClientRect();
    const toolbar = document.querySelector('.toolbar').getBoundingClientRect();
    return { toastBottom: toast.bottom, toolbarTop: toolbar.top, inlineMarginTop: document.querySelector('.toolbar').style.marginTop };
  });
  await page.waitForFunction(() => !document.querySelector('#toast')?.textContent.trim());
  results.noPageHeadDismissedAfterRender = await page.evaluate(baselineTop => {
    const toolbar = document.querySelector('.toolbar');
    return { toolbarTop: toolbar.getBoundingClientRect().top, inlineMarginTop: toolbar.style.marginTop, baselineTop };
  }, results.noPageHeadBaselineToolbarTop);
  if (Math.abs(results.noPageHeadDismissedAfterRender.toolbarTop - results.noPageHeadDismissedAfterRender.baselineTop) > 1) failures.push('no-heading fallback layout did not restore after toolbar re-render and dismissal');

  allResults[width] = { results, failures };
  }
  const failures = Object.entries(allResults).flatMap(([width, result]) => result.failures.map(failure => `${width}px: ${failure}`));
  if (failures.length) throw new Error(failures.join('; '));
  return Object.fromEntries(Object.entries(allResults).map(([width, result]) => [width, result.results]));
}
