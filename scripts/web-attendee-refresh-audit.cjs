'use strict';
// Isolated PostgreSQL/API and local Chromium only; no real participants or sends.
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { startStalledResponseProxy } = require('./stalled-response-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'attendee-refresh');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  let proxy;
  let ticketProxy;
  try {
    const db = f.harness.database;
    const row = (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0];
    const workspace = row.payload;
    const participant = workspace.participants[0];
    participant.status = 'APPROVED';
    workspace.teams = [{ id: 'synthetic-team', name: '합성 팀', order: 1 }];
    workspace.voteConfig = { pickCount: 1, status: 'OPEN', resultsPublished: false };
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: participant.ticket });
    const page = await context.newPage();
    const choice = page.getByRole('button', { name: '합성 팀 선택' });
    let starts = 0;
    await page.route('**/api/public/events/*', async route => {
      if (!route.request().url().endsWith(`/api/public/events/${f.slug}`)) return route.continue();
      starts += 1;
      const result = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, 5500));
      try { await route.fulfill({ response: result }); } catch { /* navigation can cancel a read */ }
    });
    await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=vote`, { waitUntil: 'domcontentloaded' });
    await choice.waitFor({ timeout: 12000 });
    await page.screenshot({ path: path.join(out, 'slow-vote-ready-390.png') });
    await choice.click();
    assert.equal(await choice.getAttribute('aria-pressed'), 'true');
    await page.waitForTimeout(11000);
    assert.equal(await choice.getAttribute('aria-pressed'), 'true', 'slow refresh must retain selection');
    assert.ok(starts >= 2, 'polling continues after the slow successful read');
    await context.close();
    console.log('[attendee-refresh] slow 5.5s read settles; next refresh retains vote selection');

    const fast = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await fast.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: participant.ticket });
    const fastPage = await fast.newPage();
    await fastPage.goto(`${f.baseUrl}/event/${f.slug}/home?view=vote`, { waitUntil: 'domcontentloaded' });
    await fastPage.getByRole('button', { name: '합성 팀 선택' }).waitFor();
    workspace.voteConfig.status = 'CLOSED';
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    await fastPage.getByText('투표가 마감되었습니다.', { exact: true }).waitFor({ timeout: 9000 });
    await fastPage.screenshot({ path: path.join(out, 'fast-update-390.png') });
    await fast.close();
    console.log('[attendee-refresh] quick refresh reflects organizer closing the vote');

    workspace.voteConfig.status = 'OPEN';
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
    ticketProxy = await startStalledResponseProxy(f.baseUrl, `/api/public/events/${f.slug}/ticket`);
    const stale = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await stale.addInitScript(({ slug, ticket }) => sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket), { slug: f.slug, ticket: participant.ticket });
    const stalePage = await stale.newPage();
    await stalePage.goto(`${ticketProxy.origin}/event/${f.slug}/home?view=vote`, { waitUntil: 'domcontentloaded' });
    const staleChoice = stalePage.getByRole('button', { name: '합성 팀 선택' });
    await staleChoice.click();
    ticketProxy.setStalled(true);
    await stalePage.getByText('최신 상태를 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요.').waitFor({ timeout: 16000 });
    await ticketProxy.waitForClosed(0);
    assert.equal(await staleChoice.getAttribute('aria-pressed'), 'true', 'failed refresh must retain selected team');
    await stalePage.screenshot({ path: path.join(out, 'stale-selection-390.png') });
    ticketProxy.setStalled(false);
    await stalePage.getByRole('button', { name: '다시 시도', exact: true }).click();
    await stalePage.getByText('최신 상태를 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요.').waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(await staleChoice.getAttribute('aria-pressed'), 'true', 'retry must retain selected team');
    await stale.close();
    console.log('[attendee-refresh] a stalled refresh keeps the selected team and retry recovers');

    proxy = await startStalledResponseProxy(f.baseUrl, `/api/public/events/${f.slug}`);
    proxy.setStalled(true);
    const recovery = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const recoveryPage = await recovery.newPage();
    await recoveryPage.goto(`${proxy.origin}/event/${f.slug}/home`, { waitUntil: 'domcontentloaded' });
    await recoveryPage.getByRole('heading', { name: '행사를 불러올 수 없습니다' }).waitFor({ timeout: 12000 });
    await proxy.waitForClosed(0);
    await recoveryPage.screenshot({ path: path.join(out, 'stalled-retry-390.png') });
    proxy.setStalled(false);
    await recoveryPage.getByRole('button', { name: '다시 시도', exact: true }).click();
    await recoveryPage.getByRole('button', { name: '모바일 티켓' }).waitFor({ timeout: 10000 });
    await recovery.close();
    console.log('[attendee-refresh] stalled response body times out and same-screen retry recovers');
  } finally {
    if (proxy) await proxy.close();
    if (ticketProxy) await ticketProxy.close();
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(error => { console.error('[attendee-refresh] failed:', String(error.message || error).split('\n')[0].replace(/\?[^\s"'<>]*/g, '?[redacted]')); process.exitCode = 1; });
