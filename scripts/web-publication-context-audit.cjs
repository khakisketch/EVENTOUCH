'use strict';
// Two-operator publication races against the real API and synthetic data.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'publication-context');
  prepareCaptureDir(out); process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser, page;
  try {
    const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    const command = async (name, payload) => {
      const response = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok(response.status >= 200 && response.status < 300, `${name}: ${response.status}`);
      return response.json;
    };
    const publishPage = async patch => {
      const draft = await command('attendee.page.save', { intro: '합성 행사 안내', accent: '#E76D26', showAnnouncements: true, showSchedule: true, showVenue: true, showPrograms: true, ...patch });
      await command('attendee.page.publish', { expectedDraftVersion: draft.draftVersion });
    };
    const draft = (await command('notice.save', { title: '합성 공지', body: '합성 입장 안내', mode: 'draft' })).notice;
    browser = await launchBrowser();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', locale: 'ko-KR' });
    const publicCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce', locale: 'ko-KR' });
    await ctx.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    page = await ctx.newPage(); page.setDefaultTimeout(15000);
    const errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && request.url().endsWith('/commands')) writes.push(request.postDataJSON()); });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/content`, { waitUntil: 'networkidle' });
    const dialog = page.getByRole('dialog');
    async function openReview(title) {
      // Rows open the editor in place; 게시 검토 lives there. Leave any open editor first.
      const crumb = page.locator('#content-panel').getByRole('button', { name: /^(공지|일정) 목록으로$/ });
      if (await crumb.count()) await crumb.first().click();
      await page.locator('#content-panel li').filter({ hasText: title }).last().getByRole('button').first().click();
      await page.getByRole('button', { name: '게시 검토', exact: true }).click();
      await dialog.getByRole('heading', { name: /게시 검토/ }).waitFor();
    }
    async function submit(kind) {
      const response = page.waitForResponse(res => res.request().method() === 'POST' && res.request().postDataJSON()?.command === `${kind}.publish-reviewed`);
      await dialog.getByRole('button', { name: '게시하기', exact: true }).click();
      return response;
    }
    async function blocked() {
      await dialog.getByText('게시 위치가 변경되었습니다. 돌아가서 최신 설정을 다시 검토하세요.', { exact: true }).waitFor();
      assert.ok(await dialog.getByRole('button', { name: '게시하기', exact: true }).isDisabled());
    }

    // Another operator hides notices after this review was opened.
    await openReview('합성 공지');
    assert.ok(await dialog.getByText('게시 후 공개됩니다.', { exact: true }).isVisible());
    await publishPage({ showAnnouncements: false });
    assert.equal((await submit('notice')).status(), 409);
    await blocked();
    assert.equal((await read()).notices.find(item => item.id === draft.id).published, false);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width === 320 ? 568 : 900 });
      const warning = await dialog.getByRole('alert').filter({ hasText: '게시 위치가 변경되었습니다' }).boundingBox();
      assert.ok(warning && warning.y >= 0 && warning.y + warning.height <= (width === 320 ? 568 : 900), `conflict explanation visible beside the disabled action at ${width}px`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.evaluate(axe);
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
      if (width !== 320) await page.screenshot({ path: path.join(out, `notice-conflict-${width}.png`) });
    }
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    await openReview('합성 공지');
    await dialog.getByText(/공지 표시가 꺼져 있어 현재 보이지 않습니다/).waitFor();
    assert.equal((await submit('notice')).status(), 200); await dialog.waitFor({ state: 'hidden' });
    const attendee = await publicCtx.newPage(); await attendee.goto(`${f.baseUrl}/event/${f.slug}`, { waitUntil: 'networkidle' });
    assert.equal(await attendee.getByRole('heading', { name: '합성 공지', exact: true }).count(), 0);
    await attendee.close();

    // An already published notice can be selected on the screen while a new
    // draft's publication is under review by a different operator.
    await publishPage({});
    const current = (await read()).notices.find(item => item.id === draft.id);
    await command('notice.save', { id: current.id, title: '무대 입장 공지', body: '변경된 합성 안내', mode: 'draft', expectedVersion: current.version });
    await page.reload({ waitUntil: 'networkidle' });
    await openReview('무대 입장 공지');
    await command('display.set', { type: 'notice', noticeId: current.id });
    assert.equal((await submit('notice')).status(), 409); await blocked();
    assert.equal((await read()).notices.find(item => item.id === current.id).title, '합성 공지');
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    await openReview('무대 입장 공지');
    await dialog.getByText(/전광판 내용도 즉시 바뀝니다/).waitFor();
    assert.equal((await submit('notice')).status(), 200); await dialog.waitFor({ state: 'hidden' });
    const screen = await publicCtx.newPage(); await screen.goto(`${f.baseUrl}/screen/${f.slug}`, { waitUntil: 'networkidle' });
    await screen.getByText('변경된 합성 안내', { exact: true }).waitFor(); await screen.close();

    // Lost response replays the committed receipt even if page settings
    // change afterwards; it must not create a second publication.
    const next = (await command('notice.save', { title: '응답 유실 공지', body: '합성 복구 본문', mode: 'draft' })).notice;
    await page.reload({ waitUntil: 'networkidle' });
    let lost = false;
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (!lost && body.command === 'notice.publish-reviewed' && body.payload.id === next.id) {
        lost = true; const response = await route.fetch(); assert.equal(response.status(), 200); return route.abort('failed');
      }
      return route.continue();
    });
    await openReview('응답 유실 공지');
    await dialog.getByRole('button', { name: '게시하기', exact: true }).click();
    const recovery = dialog.getByRole('region', { name: '콘텐츠 저장 확인 필요', exact: true });
    await recovery.waitFor();
    await publishPage({ showAnnouncements: false });
    await recovery.getByRole('button', { name: '같은 요청 다시 시도', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const attempts = writes.filter(item => item.command === 'notice.publish-reviewed' && item.payload.id === next.id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].commandId, attempts[1].commandId);
    assert.deepEqual(attempts[0].payload, attempts[1].payload);
    assert.equal((await read()).notices.find(item => item.id === next.id).version, next.version + 1);

    // Program and venue use the same server guard, each with its own page setting.
    await publishPage({});
    const program = (await command('program.save', { title: '합성 일정', date: '2027-01-16', start: '10:00', end: '11:00', mode: 'draft' })).program;
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /^일정/ }).click();
    await openReview('합성 일정'); await publishPage({ showPrograms: false });
    assert.equal((await submit('program')).status(), 409); await blocked();
    assert.equal((await read()).program.find(item => item.id === program.id).published, false);
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    await openReview('합성 일정'); await dialog.getByText(/프로그램 표시가 꺼져/).waitFor();
    assert.equal((await submit('program')).status(), 200); await dialog.waitFor({ state: 'hidden' });

    await publishPage({});
    const venue = (await read()).venue;
    await command('venue.save', { name: '합성 장소', address: '합성로 1', mode: 'draft', expectedVersion: venue.version || 0 });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /^장소 안내/ }).click();
    await page.getByRole('button', { name: '게시 검토', exact: true }).click();
    await dialog.getByRole('heading', { name: '장소 안내 게시 검토' }).waitFor();
    await publishPage({ showVenue: false });
    assert.equal((await submit('venue')).status(), 409); await blocked();
    assert.notEqual((await read()).venue.name, '합성 장소');
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    await page.getByRole('button', { name: '게시 검토', exact: true }).click();
    await dialog.getByText(/장소 안내 표시가 꺼져/).waitFor();
    assert.equal((await submit('venue')).status(), 200); await dialog.waitFor({ state: 'hidden' });
    assert.equal((await read()).venue.name, '합성 장소');

    await publishPage({});
    const venueBeforeFeatureChange = (await read()).venue;
    await command('venue.save', { name: '합성 장소 변경', address: '합성로 2', mode: 'draft', expectedVersion: venueBeforeFeatureChange.version });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /^장소 안내/ }).click();
    await page.getByRole('button', { name: '게시 검토', exact: true }).click();
    await dialog.getByRole('heading', { name: '장소 안내 게시 검토' }).waitFor();
    const event = (await f.harness.database.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    await command('event.features', { features: event.features.filter(feature => feature !== 'venue'), expectedFeatures: event.features });
    assert.equal((await submit('venue')).status(), 409); await blocked();
    await dialog.getByText(/장소 안내 기능이 꺼져 있어 현재 보이지 않습니다/).waitFor();
    await page.screenshot({ path: path.join(out, 'venue-feature-disabled-320.png') });
    assert.equal((await read()).venue.name, '합성 장소');
    await command('event.features', { features: event.features, expectedFeatures: event.features.filter(feature => feature !== 'venue') });
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();

    // If the refreshed settings cannot be read after the conflict, keep the
    // action locked and offer an explicit read retry without publishing.
    await publishPage({});
    const refreshDraft = (await command('notice.save', { title: '조회 실패 공지', body: '합성 내용', mode: 'draft' })).notice;
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: /^공지/ }).click();
    await openReview('조회 실패 공지');
    await publishPage({ showAnnouncements: false });
    let failRefresh = true;
    const failBootstrap = route => failRefresh
      ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"합성 조회 실패"}' })
      : route.continue();
    await page.route('**/api/events/*/bootstrap', failBootstrap);
    assert.equal((await submit('notice')).status(), 409);
    const refresh = dialog.getByRole('button', { name: '최신 내용 다시 불러오기', exact: true });
    await refresh.waitFor();
    assert.ok(await dialog.getByRole('button', { name: '게시하기', exact: true }).isDisabled());
    assert.equal((await read()).notices.find(item => item.id === refreshDraft.id).published, false);
    failRefresh = false; await refresh.click(); await blocked();
    await page.unroute('**/api/events/*/bootstrap', failBootstrap);
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();

    // An event address change must not leave destination links pointing at
    // the old URL while permitting the old review to publish.
    await publishPage({});
    const addressDraft = (await command('notice.save', { title: '주소 변경 공지', body: '새 주소 확인', mode: 'draft' })).notice;
    await page.reload({ waitUntil: 'networkidle' });
    await openReview('주소 변경 공지');
    const newSlug = `moved-${f.suffix}`;
    await command('event.update', { name: '감사 검증 행사', slug: newSlug, date: '2027-01-16', start: '09:00', end: '17:00', capacity: 200 });
    assert.equal((await submit('notice')).status(), 409); await blocked();
    assert.equal((await read()).notices.find(item => item.id === addressDraft.id).published, false);
    await dialog.getByRole('button', { name: '돌아가기', exact: true }).click();
    await openReview('주소 변경 공지');
    assert.ok((await dialog.getByRole('link').first().getAttribute('href')).includes(`/event/${newSlug}`));
    assert.equal((await submit('notice')).status(), 200); await dialog.waitFor({ state: 'hidden' });
    const movedPage = await publicCtx.newPage(); await movedPage.goto(`${f.baseUrl}/event/${newSlug}`, { waitUntil: 'networkidle' });
    await movedPage.getByRole('heading', { name: '주소 변경 공지', exact: true }).waitFor();
    await movedPage.close();

    // A server without the new reviewed command must reject it rather than
    // quietly publishing without the destination check.
    const legacyDraft = (await command('notice.save', { title: '구 서버 공지', body: '합성 내용', mode: 'draft' })).notice;
    await page.reload({ waitUntil: 'networkidle' });
    await openReview('구 서버 공지');
    const oldServer = route => {
      const body = route.request().postDataJSON();
      if (body.command === 'notice.publish-reviewed' && body.payload.id === legacyDraft.id) {
        return route.fulfill({ status: 400, contentType: 'application/json', body: '{"error":"지원하지 않는 행사 작업입니다","field":"command"}' });
      }
      return route.continue();
    };
    await page.route('**/api/events/*/commands', oldServer);
    assert.equal((await submit('notice')).status(), 400);
    await dialog.getByRole('alert').filter({ hasText: '지원하지 않는 행사 작업입니다' }).waitFor();
    assert.equal((await read()).notices.find(item => item.id === legacyDraft.id).published, false);
    assert.equal(await dialog.getByRole('region', { name: '콘텐츠 저장 확인 필요' }).count(), 0);
    await page.unroute('**/api/events/*/commands', oldServer);

    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ noticePage: true, screen: true, lostReceipt: true, schedule: true, venue: true, venueFeatureChange: true, failedRefresh: true, changedAddress: true, oldServerRejectionSimulated: true, syntheticData: true, deployment: false }, null, 2), { mode: 0o600 });
    console.log('Publication: participant visibility, screen, schedule, venue and lost receipt passed');
  } catch (error) {
    if (page) await page.screenshot({ path: path.join(out, 'failure.png') }).catch(() => {});
    throw error;
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
