'use strict';
// Synthetic two-operator races against the real event command and receipt path.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { openStudioPanel } = require('./ui-journey-helpers.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'page-publication-context');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const otherId = `page-other-${crypto.randomUUID()}`;
    await f.helpers.insertAccount(f.harness.database, { id: otherId, orgId: f.helpers.LEGACY_ORG, role: 'MANAGER', name: '합성 두 번째 운영자', email: `${otherId}@example.test` });
    const otherCookie = await f.helpers.sessionCookie(f.harness, otherId);
    const other = async (id, command, payload) => {
      const result = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${id}/commands`, {
        method: 'POST', cookie: otherCookie, body: { commandId: crypto.randomUUID(), command, payload },
      });
      assert.equal(result.status, 200, `${command}: ${JSON.stringify(result.json)}`);
      return result.json;
    };
    const seed = async (stage = 'DRAFT') => {
      const id = `page-ctx-${crypto.randomUUID()}`;
      await f.helpers.insertEvent(f.harness.database, { id, slug: id, orgId: f.helpers.LEGACY_ORG,
        payload: { id, slug: id, name: '합성 게시 검토 행사', stage, date: '2027-02-01', start: '09:00', end: '17:00', capacity: 100, features: ['venue'] },
        workspace: f.helpers.emptyWorkspace() });
      await f.helpers.insertMembership(f.harness.database, f.manager.id, id, ['page']);
      await f.helpers.insertMembership(f.harness.database, otherId, id, ['settings']);
      return id;
    };
    const read = async id => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [id])).rows[0].payload;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const editor = async id => {
      await page.goto(`${f.baseUrl}/console/events/${id}/page`, { waitUntil: 'networkidle' });
      await openStudioPanel(page, 'exposure');
      await page.locator('#home-intro').fill('합성 검토된 페이지');
      await page.getByRole('button', { name: '초안 저장', exact: true }).click();
      await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
    };
    const review = async () => {
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '참가자 페이지 게시 검토', exact: true });
      await dialog.waitFor(); return dialog;
    };
    const confirm = async dialog => dialog.getByRole('button', { name: '게시하기', exact: true }).click();
    const refreshAfterConflict = async () => {
      const panel = page.getByRole('region', { name: '행사 공개 상태 또는 주소가 달라졌습니다' });
      await panel.waitFor();
      assert.match(await panel.innerText(), /게시하지 않았습니다/);
      await panel.getByRole('button', { name: '최신 상태 확인', exact: true }).click();
      await panel.getByRole('button', { name: '최신 상태 불러오기', exact: true }).click();
      await panel.waitFor({ state: 'hidden' });
    };
    const checkAxe = async label => {
      await page.evaluate(axeSource);
      const findings = await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id));
      assert.deepEqual(findings, [], label);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, label);
    };
    for (const mode of ['stage', 'lost-before', 'lost-after', 'slug', 'old-server']) {
      const id = await seed(mode === 'slug' ? 'READY' : 'DRAFT');
      let first = true;
      const requests = [];
      const intercept = async route => {
        const body = route.request().postDataJSON();
        if (body.command !== 'attendee.page.publish-reviewed') return route.continue();
        requests.push(body);
        if (mode === 'old-server') return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: '지원하지 않는 참가자 작업입니다', field: 'command' }) });
        if (first && (mode === 'lost-before' || mode === 'lost-after')) {
          first = false;
          if (mode === 'lost-after') assert.equal((await route.fetch()).status(), 200);
          return route.abort('failed');
        }
        return route.continue();
      };
      await page.route('**/api/events/*/commands', intercept);
      await editor(id);
      let dialog = await review();
      if (mode !== 'slug') {
        assert.match(await dialog.innerText(), /기획 단계.*참가자.*공개되지/s);
        assert.equal(await dialog.getByRole('link', { name: /화면 열기/ }).count(), 0);
      }
      if (mode === 'old-server') {
        await confirm(dialog);
        await page.getByRole('alert').filter({ hasText: '현재 서버가 이 게시 검토를 지원하지 않습니다' }).waitFor();
        assert.equal((await read(id)).pageExperience.publishedAt, null);
        assert.equal(requests.length, 1);
        await page.unroute('**/api/events/*/commands', intercept);
        console.log('old-server: reviewed publication fails closed without a legacy fallback');
        continue;
      }
      if (mode === 'lost-before' || mode === 'lost-after') {
        await confirm(dialog);
        await page.getByRole('alert').filter({ hasText: '게시 응답을 확인하지 못했습니다' }).waitFor();
      }
      let slug = id;
      if (mode === 'slug') {
        slug = `moved-${crypto.randomUUID()}`;
        await other(id, 'event.update', { name: '합성 게시 검토 행사', slug, date: '2027-02-01', start: '09:00', end: '17:00', capacity: 100 });
      } else await other(id, 'event.stage', { stage: 'READY' });
      if (mode === 'lost-before' || mode === 'lost-after') dialog = await review();
      await confirm(dialog);
      assert.equal(requests[0].payload.expectedDestinations.slug, id);
      assert.equal(requests[0].payload.expectedDestinations.public, mode === 'slug');
      if (mode === 'lost-before' || mode === 'lost-after') {
        assert.equal(requests[0].commandId, requests[1].commandId, 'retry reuses the exact reviewed request');
      }
      if (mode === 'lost-after') {
        const panel = page.getByRole('region', { name: '게시 후 행사 공개 상태 또는 주소가 달라졌습니다' });
        await panel.waitFor();
        assert.equal((await read(id)).pageExperience.published.intro, '합성 검토된 페이지');
        assert.equal(await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).count(), 0);
        await panel.getByRole('button', { name: '최신 상태 불러오기', exact: true }).click();
        await panel.waitFor({ state: 'hidden' });
        assert.equal(await page.getByText('현재 초안 게시됨', { exact: true }).count() > 0, true);
      } else {
        const panel = page.getByRole('region', { name: '행사 공개 상태 또는 주소가 달라졌습니다' });
        await panel.waitFor();
        assert.equal((await read(id)).pageExperience.publishedAt, null, 'stale reviewed context does not publish');
        for (const width of [1280, 390, 320]) {
          await page.setViewportSize({ width, height: 900 }); await checkAxe(`${mode} conflict ${width}`);
          if (width === 320) {
            const split = await panel.locator('h2').evaluate(element => {
              const node = element.firstChild;
              const index = node?.textContent?.indexOf('달라졌습니다') ?? -1;
              if (!node || index < 0) return null;
              const range = document.createRange();
              range.setStart(node, index); range.setEnd(node, index + '달라졌습니다'.length);
              return range.getClientRects().length > 1;
            });
            assert.equal(split, false, 'the Korean status word stays together');
            const overflow = await panel.locator('h2').evaluate(element => {
              const probe = element.cloneNode(false);
              probe.textContent = '합성긴상태'.repeat(100);
              element.after(probe);
              const result = probe.scrollWidth > probe.clientWidth + 1;
              probe.remove();
              return result;
            });
            assert.equal(overflow, false, 'unbroken text still wraps without overflow');
          }
          if (mode === 'stage') await page.screenshot({ path: path.join(out, `stage-conflict-${width}.png`), fullPage: true });
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await refreshAfterConflict();
        dialog = await review();
        assert.equal(await dialog.getByRole('link', { name: /화면 열기/ }).count(), 2);
        assert.equal(await dialog.getByRole('link', { name: /화면 열기/ }).last().getAttribute('href'), `/event/${slug}`);
        await confirm(dialog);
        await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).waitFor();
        assert.equal((await read(id)).pageExperience.published.intro, '합성 검토된 페이지');
      }
      if (mode === 'lost-before' || mode === 'lost-after') {
        const pointerRemains = await page.evaluate(commandId => {
          for (const storage of [localStorage, sessionStorage]) {
            for (let index = 0; index < storage.length; index++) {
              const key = storage.key(index) || '';
              if (!key.startsWith('eventouch.receipt') || key.includes('.done.')) continue;
              if ((storage.getItem(key) || '').includes(commandId)) return true;
            }
          }
          return false;
        }, requests[0].commandId);
        assert.equal(pointerRemains, false, 'resolved requests do not leave an outstanding receipt pointer');
      }
      const result = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${slug}`);
      assert.equal(result.status, 200);
      assert.equal(result.json.workspace.pageExperience.published.intro, '합성 검토된 페이지');
      await page.unroute('**/api/events/*/commands', intercept);
      console.log(`${mode}: exact reviewed destination, conflict recovery and public state verified`);
    }
    // A partial successful bootstrap must not guess that the event is public.
    const partialId = await seed('READY');
    let corruptStage = true;
    const partial = async route => {
      if (!corruptStage || !route.request().url().includes(`/events/${partialId}/bootstrap`)) return route.continue();
      const response = await route.fetch();
      const body = await response.json();
      delete body.state.events.find(event => event.id === partialId).stage;
      return route.fulfill({ response, body: JSON.stringify(body) });
    };
    await page.route('**/api/events/*/bootstrap', partial);
    await page.goto(`${f.baseUrl}/console/events/${partialId}/page`, { waitUntil: 'networkidle' });
    await openStudioPanel(page, 'exposure');
    await page.locator('#home-intro').fill('합성 보존할 입력');
    assert.equal(await page.getByRole('button', { name: '게시 검토', exact: true }).isDisabled(), true);
    await page.getByText(/행사 공개 상태나 주소를 확인하지 못했습니다/).waitFor();
    corruptStage = false;
    await page.getByRole('button', { name: '최신 상태 확인', exact: true }).click();
    const partialPanel = page.getByRole('region', { name: '행사 공개 상태 또는 주소가 달라졌습니다' });
    await partialPanel.getByRole('button', { name: '내 변경을 최신 초안에 적용', exact: true }).click();
    const merge = page.getByRole('group', { name: '실행 확인', exact: true });
    await merge.getByRole('button', { name: '내 변경 유지하기', exact: true }).click();
    await openStudioPanel(page, 'exposure');
    assert.equal(await page.locator('#home-intro').inputValue(), '합성 보존할 입력');
    await page.getByRole('button', { name: '초안 저장', exact: true }).click();
    await page.getByText('초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.', { exact: true }).waitFor();
    const recoveredReview = await review();
    assert.equal(await recoveredReview.getByRole('link', { name: /화면 열기/ }).count(), 2);
    await confirm(recoveredReview);
    await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).waitFor();
    assert.equal((await read(partialId)).pageExperience.published.intro, '합성 보존할 입력');
    await page.unroute('**/api/events/*/bootstrap', partial);
    console.log('partial-stage: unknown public status blocks publication and preserves unsaved input through recovery');
    const endedId = await seed('ENDED');
    await editor(endedId);
    const endedReview = await review();
    assert.equal(await endedReview.getByRole('link', { name: /화면 열기/ }).count(), 2);
    await confirm(endedReview);
    await page.getByText('게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.', { exact: true }).waitFor();
    assert.equal((await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${endedId}`)).status, 200);
    console.log('ended: public event state and participant links agree with the API');
    assert.deepEqual(errors, []);
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error.stack || error).replace(/https?:\/\/[^\s]+/g, '[url]')); process.exitCode = 1; });
