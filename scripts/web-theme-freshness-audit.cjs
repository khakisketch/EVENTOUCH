'use strict';
// Two independently authorized operators and isolated synthetic page content.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');

async function scenario(kind, out, choice = 'latest') {
  const fixture = await startAuditFixture();
  let browser;
  try {
    const id = `freshness-${crypto.randomUUID()}`;
    await fixture.helpers.insertAccount(fixture.harness.database, { id, orgId: fixture.helpers.LEGACY_ORG, role: 'MANAGER', name: '합성 두 번째 운영자', email: `${id}@example.test` });
    await fixture.helpers.insertMembership(fixture.harness.database, id, fixture.eventId, ['page']);
    const second = await fixture.helpers.sessionCookie(fixture.harness, id);
    const call = async (command, payload) => {
      const response = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: second, body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.equal(response.status, 200, `${command} succeeds for another operator`);
      return response.json;
    };
    const pageState = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload.pageExperience;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR' });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let lost = false;
    let badRead = false;
    let injectIncompleteRead = false;
    const requests = [];
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== (kind === 'publish' ? 'attendee.page.publish-reviewed' : 'attendee.page.save')) return route.continue();
      requests.push(body);
      if (!lost) {
        lost = true;
        const response = await route.fetch();
        assert.equal(response.status(), 200, 'the first request committed');
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.route('**/api/events/*/bootstrap', async route => {
      if (!injectIncompleteRead) return route.continue();
      badRead = true;
      const response = await route.fetch();
      const body = await response.json();
      if (kind === 'publish') delete body.state.workspaces[fixture.eventId].pageExperience.publishedAt;
      else delete body.state.workspaces[fixture.eventId].pageExperience;
      return route.fulfill({ response, body: JSON.stringify(body) });
    });
    await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/page`, { waitUntil: 'networkidle' });
    const intro = page.locator('#home-intro');
    const save = page.getByRole('button', { name: '초안 저장', exact: true });
    const publish = async () => {
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      await page.getByRole('dialog', { name: '참가자 페이지 게시 검토' }).getByRole('button', { name: '게시하기', exact: true }).click();
    };
    await intro.fill('합성 첫 번째 안내');
    if (kind === 'publish') {
      await save.click();
      await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
      await publish();
    } else await save.click();
    await page.getByRole('alert').filter({ hasText: `${kind === 'save' ? '저장' : '게시'} 응답을 확인하지 못했습니다` }).waitFor();
    const previous = await pageState();
    const changed = await call('attendee.page.save', {
      intro: '합성 두 번째 최신 안내', accent: '#118855', homeStyle: { heroTitle: '합성 최신 배너 제목' }, showAnnouncements: true,
      showSchedule: true, showVenue: true, showPrograms: true, expectedDraftVersion: previous.draftVersion,
    });
    if (kind === 'publish' && choice !== 'draft-only') await call('attendee.page.publish', { expectedDraftVersion: changed.draftVersion });
    // A plausible HTTP 200 with a missing page must not certify the result.
    injectIncompleteRead = true;
    if (kind === 'publish') await publish(); else await save.click();
    await page.waitForFunction((verb) => {
      const text = document.body.innerText;
      return !text.includes(verb === '저장' ? '초안 저장 중…' : '게시 중…') &&
        [...document.querySelectorAll('[role="alert"]')].some(el => el.textContent.includes(`${verb} 요청은 처리됐지만`));
    }, kind === 'save' ? '저장' : '게시');
    await page.getByRole('alert').filter({ hasText: `${kind === 'save' ? '저장' : '게시'} 요청은 처리됐지만` }).waitFor();
    injectIncompleteRead = false;
    assert.equal(badRead, true, 'incomplete refresh was exercised');
    assert.equal(await intro.inputValue(), '합성 첫 번째 안내');
    assert.equal(await page.getByText('요청 후 페이지가 변경되었습니다', { exact: true }).count(), 0, 'incomplete refresh cannot supply a current conflict');
    if (kind === 'publish') await publish(); else await save.click();
    const conflict = page.getByRole('region', { name: '요청 후 페이지가 변경되었습니다' });
    await conflict.waitFor();
    assert.match(await conflict.innerText(), /행사 소개/);
    assert.equal(await page.getByText('현재 초안 게시됨', { exact: true }).count(), 0, 'a superseded local draft must not be called current');
    assert.ok(await page.getByText('최신 상태 확인 필요', { exact: true }).count() >= 1);
    assert.equal(await intro.inputValue(), '합성 첫 번째 안내', 'local content is preserved until explicitly replaced');
    assert.equal(new Set(requests.map(item => item.commandId)).size, 1, 'all retries reuse the original command');
    assert.equal(requests.length, 3);
    const actual = await pageState();
    assert.equal(actual.draft.intro, '합성 두 번째 최신 안내');
    if (kind === 'publish') {
      const visibleIntro = choice === 'draft-only' ? '합성 첫 번째 안내' : '합성 두 번째 최신 안내';
      assert.equal(actual.published.intro, visibleIntro);
      assert.match(await conflict.innerText(), new RegExp(`현재 게시본 v${actual.publishedVersion}`));
      const publicContext = await browser.newContext();
      const publicPage = await publicContext.newPage();
      await publicPage.goto(`${fixture.baseUrl}/event/${fixture.eventId}`, { waitUntil: 'networkidle' });
      await publicPage.getByText(visibleIntro, { exact: true }).waitFor();
      await publicContext.close();
    }
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.addScriptTag({ content: axeSource });
      const result = await page.evaluate(async () => ({
        overflow: document.documentElement.scrollWidth > window.innerWidth,
        violations: (await window.axe.run(document)).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id),
      }));
      assert.equal(result.overflow, false, `${width}px has no horizontal page overflow`);
      assert.deepEqual(result.violations, [], `${width}px has no serious or critical automated violations`);
      await page.screenshot({ path: path.join(out, `${kind}-${choice}-conflict-${width}.png`), fullPage: true });
    }
    if (choice === 'keep') {
      await conflict.getByRole('button', { name: '현재 화면 내용 적용', exact: true }).click();
      const review = page.getByRole('group', { name: '실행 확인' });
      assert.match(await review.innerText(), /행사 소개.*합성 두 번째 최신 안내.*합성 첫 번째 안내/s);
      assert.match(await review.innerText(), /강조색.*#118855.*#E76D26/s);
      assert.match(await review.innerText(), /배너 제목.*합성 최신 배너 제목.*기본값/s);
      assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '현재 화면 내용 적용하기', 'review moves keyboard focus to its action');
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
      await review.screenshot({ path: path.join(out, `${kind}-apply-review-320.png`) });
      await review.getByRole('button', { name: '취소', exact: true }).click();
      assert.equal(await intro.inputValue(), '합성 첫 번째 안내', 'cancelling review preserves the original screen');
      assert.equal((await pageState()).draft.intro, '합성 두 번째 최신 안내', 'review and cancellation do not save');
      await conflict.getByRole('button', { name: '현재 화면 내용 적용', exact: true }).click();
      await review.getByRole('button', { name: '현재 화면 내용 적용하기', exact: true }).click();
      assert.equal(await intro.inputValue(), '합성 첫 번째 안내', 'choosing to keep the first operator’s content must not silently replace it');
      assert.equal(await page.locator('#home-accent').inputValue(), '#e76d26', 'the explicitly reviewed current value is prepared');
      assert.equal(await save.isEnabled(), true, 'the preserved content must be ready for an explicit save');
      assert.equal((await pageState()).draft.intro, '합성 두 번째 최신 안내', 'applying a choice does not save');
      await save.click();
      await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
      const restored = await pageState();
      assert.equal(restored.draft.intro, '합성 첫 번째 안내');
      assert.equal(restored.draft.accent, '#E76D26');
      assert.equal(restored.draft.homeStyle.heroTitle, null);
      if (kind === 'publish') {
        assert.equal(restored.published.intro, '합성 두 번째 최신 안내', 'saving does not publish');
        await publish();
        await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).waitFor();
        assert.equal((await pageState()).published.intro, '합성 첫 번째 안내');
      }
      assert.deepEqual(errors, []);
      console.log(`${kind}: reviewed current values, cancelled, applied, explicitly saved${kind === 'publish' ? ' and published' : ''}`);
      return;
    }
    await conflict.getByRole('button', { name: '최신 초안 불러오기' }).click();
    await page.getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '최신 초안으로 바꾸기' }).click();
    await page.waitForFunction(() => document.querySelector('#home-intro')?.value === '합성 두 번째 최신 안내');
    assert.equal(await page.getByRole('region', { name: '요청 후 페이지가 변경되었습니다' }).count(), 0);
    assert.deepEqual(errors, []);
    console.log(`${kind}: lost response, later change, incomplete refresh, same-request recovery and latest draft passed`);
  } finally {
    await browser?.close();
    await fixture.close();
  }
}

(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'theme-freshness');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  await scenario('save', out);
  await scenario('publish', out);
  await scenario('save', out, 'keep');
  await scenario('publish', out, 'keep');
  await scenario('publish', out, 'draft-only');
})().catch(error => { console.error(String(error.stack || error).replace(/https?:\/\/[^\s]+/g, '[url]')); process.exitCode = 1; });
