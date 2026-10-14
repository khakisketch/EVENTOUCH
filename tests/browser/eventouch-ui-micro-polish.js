// Run in a named Playwright CLI session against the actual EVENTOUCH fixture:
// playwright-cli -s=eventouch-ui-polish --config=/home/ksi/.config/opencode/browser/playwright.json open 'http://100.116.163.1:46771/?__micro_polish=after#/login'
// playwright-cli -s=eventouch-ui-polish run-code --filename=tests/browser/eventouch-ui-micro-polish.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const capturePrefix = new URL(page.url()).searchParams.get('__micro_polish') || 'after';
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const routeUrl = hash => `${baseUrl}/?__micro_polish=${capturePrefix}${hash}`;
  const capture = async name => page.screenshot({ path: `/tmp/opencode/eventouch-captures/micro-polish-${capturePrefix}-${name}.png`, scale: 'css', type: 'png' });
  const clearFocus = async () => page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });

  const ensureAgencyLogin = async () => {
    await page.goto(routeUrl('#/console/agency/events'));
    await page.waitForFunction(() => document.querySelector('.admin-shell') || [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '빠른 로그인'));
    const shell = page.locator('.admin-shell');
    if (!await shell.isVisible().catch(() => false)) await page.getByRole('button', { name: '빠른 로그인' }).click();
    await shell.waitFor({ state: 'visible' });
    await page.locator('.page-head h1').waitFor({ state: 'visible' });
  };

  const workspaceContext = async () => page.evaluate(() => {
    const visible = element => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const selectors = ['.sidebar .workspace-caption', '.topbar .breadcrumb.agency-context .workspace-context', '.page-head .eyebrow'];
    return selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .filter(visible)
      .map(element => element.textContent.trim())
      .filter(text => text === '운영 워크스페이스');
  });

  await ensureAgencyLogin();
  for (const width of [1280, 390, 320]) {
    const height = width === 1280 ? 900 : 844;
    await page.setViewportSize({ width, height });
    await page.goto(routeUrl('#/console/agency/events'));
    await page.locator('.page-head h1').waitFor({ state: 'visible' });
    await clearFocus();
    await capture(`agency-events-${width}`);

    const contextCount = (await workspaceContext()).length;
    check(contextCount === 1, `${width}px agency events shows ${contextCount} visible workspace labels; expected one`);

    const header = await page.evaluate(() => {
      const title = document.querySelector('.page-head h1');
      const action = document.querySelector('.page-head .actions [data-action="new-event"]');
      const pageHead = document.querySelector('.page-head');
      if (!title || !action || !pageHead) return null;
      const textRange = document.createRange();
      textRange.selectNodeContents(title);
      const textBox = textRange.getBoundingClientRect();
      const buttonBox = action.getBoundingClientRect();
      const headBox = pageHead.getBoundingClientRect();
      return {
        title: { top: title.getBoundingClientRect().top, textRight: textBox.right },
        button: { top: buttonBox.top, left: buttonBox.left, right: buttonBox.right, height: buttonBox.height },
        head: { left: headBox.left, right: headBox.right },
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    if (!header) {
      failures.push(`${width}px agency events is missing its heading or authorized create-event action`);
      continue;
    }
    if (width <= 768) {
      check(Math.abs(header.button.top - header.title.top) <= 8, `${width}px create-event action is not aligned with the title row`);
      check(header.button.left >= header.title.textRight + 8, `${width}px create-event action is not positioned to the right of the title`);
    }
    check(header.button.right >= header.head.right - 4, `${width}px create-event action is not right-aligned to the page header`);
    check(header.button.height >= 44, `${width}px create-event action is shorter than the 44px touch target`);
    check(header.documentWidth <= header.clientWidth, `${width}px agency events has horizontal overflow`);

    if (width === 390) {
      const menuButton = page.locator('.menu-button');
      await menuButton.click();
      await page.waitForFunction(() => document.body.classList.contains('menu-open'));
      await capture('agency-drawer-390');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.body.classList.contains('menu-open'));
      check(await page.evaluate(() => document.activeElement?.matches('.menu-button')), '390px Escape did not restore focus to the navigation menu button');

      const createAction = page.locator('.page-head .actions [data-action="new-event"]');
      await createAction.click();
      await page.locator('.overlay [role="dialog"]').waitFor({ state: 'visible' });
      await capture('agency-new-event-dialog-390');
      await page.keyboard.press('Escape');
      await page.locator('.overlay [role="dialog"]').waitFor({ state: 'detached' });
      check(await page.evaluate(() => document.activeElement?.matches('.page-head .actions [data-action="new-event"]')), '390px closing the create-event dialog did not restore focus to its action');
      await capture('agency-events-390-focus');
    }
  }

  for (const pageName of ['clients', 'team', 'integrations']) {
    for (const width of [1280, 390]) {
      const height = width === 1280 ? 900 : 844;
      await page.setViewportSize({ width, height });
      await page.goto(routeUrl(`#/console/agency/${pageName}`));
      await page.locator('.page-head h1').waitFor({ state: 'visible' });
      await clearFocus();
      await capture(`agency-${pageName}-${width}`);
      const labels = await workspaceContext();
      check(labels.length === 1, `${width}px agency ${pageName} shows ${labels.length} visible workspace labels; expected one`);
    }
  }

  for (const width of [1280, 390, 320]) {
    const height = width === 1280 ? 900 : 844;
    await page.setViewportSize({ width, height });
    await page.goto(routeUrl('#/event/map-event/home'));
    await page.waitForFunction(() => {
      const hero = document.querySelector('.attendee-home-hero') || document.querySelector('.mobile-hero');
      const image = hero?.querySelector('img');
      return image && image.complete && image.naturalWidth > 0 && hero.querySelector('.hero-actions .btn');
    });
    await clearFocus();
    await capture(`attendee-home-${width}`);
    const hero = await page.evaluate(() => {
      const root = document.querySelector('.attendee-home-hero') || document.querySelector('.mobile-hero');
      const copy = root.querySelector('.attendee-home-copy');
      const image = root.querySelector('img');
      const action = root.querySelector('.hero-actions .btn');
      const copyBox = copy.getBoundingClientRect();
      const imageBox = image.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      return {
        columns: getComputedStyle(root).gridTemplateColumns.trim().split(/\s+/).length,
        copy: { top: copyBox.top, bottom: copyBox.bottom, left: copyBox.left, right: copyBox.right },
        image: { top: imageBox.top, bottom: imageBox.bottom, left: imageBox.left, width: imageBox.width, height: imageBox.height, ratio: imageBox.width / imageBox.height, naturalRatio: image.naturalWidth / image.naturalHeight },
        action: { top: actionBox.top, bottom: actionBox.bottom, height: actionBox.height },
        viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
      };
    });
    check(hero.documentWidth <= hero.clientWidth, `${width}px attendee home has horizontal overflow`);
    check(Math.abs(hero.image.ratio - hero.image.naturalRatio) <= 0.02, `${width}px attendee image aspect ratio is distorted`);
    if (width > 700) {
      check(hero.columns === 2 && hero.image.left > hero.copy.right, `${width}px attendee hero is not composed as two side-by-side columns`);
      check(hero.image.height <= 420, `${width}px attendee hero image is ${hero.image.height.toFixed(1)}px tall; expected at most 420px`);
      check(hero.action.bottom <= height, `${width}px attendee primary action ends below the first viewport at ${hero.action.bottom.toFixed(1)}px`);
      const registerAction = page.locator('.attendee-home-hero .hero-actions .btn');
      check(await registerAction.getAttribute('href') === '#/event/map-event/register', 'desktop attendee primary action no longer targets registration');
      await registerAction.click();
      await page.waitForFunction(() => location.hash === '#/event/map-event/register');
      await page.getByRole('heading', { name: '참가 신청', exact: true }).waitFor({ state: 'visible' });
      await page.getByRole('textbox', { name: '이름 *' }).waitFor({ state: 'visible' });
      await page.getByRole('button', { name: '신청 완료' }).waitFor({ state: 'visible' });
      await capture('attendee-registration-1280');
    } else {
      check(hero.columns === 1 && hero.copy.bottom <= hero.image.top, `${width}px attendee summary and image are not in the single-column order`);
      check(hero.image.bottom <= hero.action.top, `${width}px attendee mobile order changed: primary action precedes the image`);
      check(hero.action.height >= 44, `${width}px attendee primary action is shorter than the 44px touch target`);
      if (width === 390) {
        let actionFocused = false;
        for (let tab = 0; tab < 16; tab += 1) {
          actionFocused = await page.evaluate(() => document.activeElement?.matches('.hero-actions .btn'));
          if (actionFocused) break;
          await page.keyboard.press('Tab');
        }
        check(actionFocused, '390px keyboard tab order never reaches the attendee primary action');
        const focusRing = await page.evaluate(() => {
          const style = getComputedStyle(document.activeElement);
          return { style: style.outlineStyle, width: parseFloat(style.outlineWidth) || 0 };
        });
        check(focusRing.style !== 'none' && focusRing.width >= 2, '390px attendee primary action has no visible keyboard focus ring');
        await capture('attendee-home-390-focus');
      }
    }
  }

  if (failures.length) throw new Error(`EVENTOUCH micro-polish failures (${capturePrefix}):\n- ${failures.join('\n- ')}`);
  return { capturePrefix, result: 'all responsive layout assertions passed' };
}
