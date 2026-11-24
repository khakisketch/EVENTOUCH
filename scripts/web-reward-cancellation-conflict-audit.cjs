'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
(async () => {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const before = process.argv.includes('--before');
  const lost = process.argv.includes('--lost');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'reward-conflict-before' : lost ? 'reward-conflict-lost' : 'reward-conflict-after'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  const read = async () => (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  try {
    const ws = await read(); ws.participants[0].cancelled = true; ws.participants[3].status = 'CANCELLED'; ws.participants[5].status = 'PENDING'; ws.participants[6].id = 42;
    const ids = ['conflict', 'valid', 'race', 'cancelled', 'missing', 'unapproved', 'numeric'];
    for (let i = 0; i < ids.length; i++) ws.rewards.push({ id: `reward-${ids[i]}`, name: `합성 경품 ${ids[i]}`, participantId: i === 4 ? 'missing-participant' : ws.participants[i].id, status: 'READY', method: 'ONSITE', at: new Date().toISOString() });
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage(), errors = [], attempts = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/events/*/commands', async route => {
      const body = route.request().postDataJSON();
      if (body.command !== 'reward.fulfill' || body.payload?.id !== 'reward-race') return route.continue();
      attempts.push(body.commandId);
      if (lost && attempts.length === 1) {
        const response = await route.fetch(); assert.equal(response.status(), 409);
        return route.abort('failed');
      }
      return route.continue();
    });
    await page.goto(`${f.baseUrl}/console/events/${f.eventId}/rewards`, { waitUntil: 'networkidle' });
    const row = name => page.getByRole('listitem').filter({ hasText: `합성 경품 ${name}` });
    // The reason sentence sits in the row's fold; 수령 처리 itself is only offered when nothing blocks it.
    const reason = async (name, pattern) => {
      const toggle = row(name).getByRole('button', { name: /상세$/ });
      if (await toggle.getAttribute('aria-expanded') !== 'true') await toggle.click();
      await row(name).getByText(pattern).waitFor();
    };
    const offersFulfil = async name => await row(name).getByRole('button', { name: '수령 처리' }).count() > 0;
    await row('conflict').waitFor();
    if (before) {
      assert.equal(await row('conflict').getByRole('button', { name: '수령 처리' }).isEnabled(), true);
      await page.screenshot({ path: path.join(out, 'before-1280.png'), fullPage: true });
      return;
    }
    await reason('conflict', /신청 상태와 취소 기록이 일치하지 않습니다/);
    for (const name of ['conflict', 'cancelled', 'missing', 'unapproved']) assert.equal(await offersFulfil(name), false, `${name}: a blocked prize never offers 수령 처리`);
    await reason('unapproved', /참가 확정 후 수령을 처리할 수 있습니다/);
    assert.equal(await row('numeric').getByRole('button', { name: '수령 처리' }).isEnabled(), true, 'one legacy numeric participant remains actionable');
    await row('numeric').getByText(ws.participants[6].name, { exact: false }).waitFor();
    assert.equal(await row('valid').getByRole('button', { name: '수령 처리' }).isEnabled(), true);
    assert.equal(await row('conflict').getByRole('link', { name: /^참가자 명단에서 확인/ }).getAttribute('href'), `/console/events/${encodeURIComponent(f.eventId)}/participants?ticket=review`);
    for (const width of [320, 390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.addScriptTag({ content: axeSource });
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run(document)).violations.filter(v => ['serious', 'critical'].includes(v.impact))), []);
      await page.screenshot({ path: path.join(out, `after-${width}.png`), fullPage: true });
    }
    const reviewPage = await context.newPage();
    await reviewPage.goto(`${f.baseUrl}/console/events/${f.eventId}/rewards`, { waitUntil: 'networkidle' });
    const reviewLink = reviewPage.getByRole('listitem').filter({ hasText: '합성 경품 conflict' }).getByRole('link', { name: /^참가자 명단에서 확인/ });
    await reviewLink.focus(); await reviewPage.keyboard.press('Enter');
    await reviewPage.getByRole('heading', { name: '참가자 명단', exact: true }).waitFor();
    // This fixture deliberately holds one participant with a numeric id, which the roster now refuses to
    // list as complete; the link's job here is to land on the ticket-review roster, not to render rows.
    assert.equal(new URL(reviewPage.url()).searchParams.get('ticket'), 'review', 'the link opens the ticket-review roster');
    await row('race').getByRole('button', { name: '수령 처리' }).click();
    const confirm = row('race').getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '처리하기' });
    await confirm.waitFor();
    const latest = await read(); latest.participants[2].cancelled = true;
    await f.harness.database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(latest)]);
    if (lost) {
      await confirm.click();
      await page.getByRole('region', { name: '경품 처리 확인 필요' }).getByRole('button', { name: '같은 요청 다시 시도' }).waitFor();
    }
    const [response] = await Promise.all([page.waitForResponse(r => r.url().endsWith('/commands') && r.request().method() === 'POST'), lost
      ? page.getByRole('region', { name: '경품 처리 확인 필요' }).getByRole('button', { name: '같은 요청 다시 시도' }).click()
      : confirm.click()]);
    assert.equal(response.status(), 409); assert.equal((await response.json()).code, 'REWARD_PARTICIPANT_CHANGED');
    if (lost) { assert.equal(attempts.length, 2); assert.equal(attempts[0], attempts[1]); }
    await page.getByText(/수령자의 참가 상태를 확인한 뒤 다시 처리하세요/).waitFor();
    assert.equal((await read()).rewards.find(reward => reward.id === 'reward-race').status, 'READY');
    await page.getByRole('button', { name: '경품 목록 다시 확인' }).click();
    await reason('race', /신청 상태와 취소 기록이 일치하지 않습니다/);
    assert.equal(await offersFulfil('race'), false);
    await row('valid').getByRole('button', { name: '수령 처리' }).click();
    const [completed] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/commands') && r.request().method() === 'POST'),
      row('valid').getByRole('group', { name: '실행 확인' }).getByRole('button', { name: '처리하기' }).click(),
    ]);
    assert.equal(completed.status(), 200);
    // 2026-11-20: a received prize moves into the folded 완료·취소 group; open it to see the row.
    await page.locator('[data-reward-group="done"] summary').click();
    await row('valid').getByText('수령 완료', { exact: true }).waitFor();
    assert.equal((await read()).rewards.find(reward => reward.id === 'reward-valid').status, 'RECEIVED');
    assert.deepEqual(errors, []);
    console.log('reward cancellation conflict: passed');
  } finally { if (browser) await browser.close(); await f.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
