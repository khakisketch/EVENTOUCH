'use strict';

// 운영 현황 "경품 확인 필요" row, in a real browser against the real build:
// the row counts the same prizes the 경품 지급 현황 screen does, links there,
// never takes the orange action, and disappears when the 경품 feature is off
// or nothing needs a look.
const assert = require('node:assert/strict');
const path = require('node:path');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'overview-reward-row'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const db = f.harness.database;
  const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async (workspace) => db.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  const setFeatures = async (features) => db.query("UPDATE events SET payload=jsonb_set(payload, '{features}', $2::jsonb), revision=revision+1 WHERE id=$1", [f.eventId, JSON.stringify(features)]);
  try {
    const workspace = await read();
    const approved = workspace.participants.find((person) => person.status === 'APPROVED');
    const other = workspace.participants.find((person) => person.id !== approved?.id);
    assert.ok(approved && other, 'the fixture needs two participants');
    Object.assign(other, { status: 'CANCELLED', cancelled: true, revoked: true });
    const prize = (id, status, participantId, extra = {}) => ({ id, name: `합성 경품 ${id}`, method: 'ONSITE', status, participantId, at: '2026-10-01T00:00:00Z', ...extra });
    workspace.rewards = [
      prize('wait-ok', 'READY', approved.id),
      prize('attn-cancelled', 'READY', other.id),
      prize('attn-missing', 'READY', 'no-such-person'),
      prize('attn-pending', 'PENDING', '', { source: { kind: 'draw', programId: 'synthetic-draw' } }),
      prize('done-received', 'RECEIVED', approved.id),
      prize('done-cancelled', 'CANCELLED', approved.id),
    ];
    await write(workspace);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const overview = `${f.baseUrl}/console/events/${f.eventId}`;
    const row = page.locator('[data-task="reward-attention"]');

    // 1) three of the six prizes need a look (cancelled recipient, unknown recipient, no recipient yet).
    await page.goto(overview);
    await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    await row.waitFor({ timeout: 10000 });
    await row.getByText('경품 확인 필요', { exact: true }).waitFor();
    await row.getByText('3건', { exact: true }).waitFor();
    const link = row.getByRole('link', { name: '경품 지급 현황' });
    assert.equal(await link.getAttribute('href'), `/console/events/${f.eventId}/rewards`);
    // LIVE overview already spends its one orange action on 현장 운영 열기: the queue adds none.
    assert.equal(await link.getAttribute('data-action-variant'), 'ghost', 'the reward row is a quiet link, not the orange action');
    assert.equal(await page.locator('[data-action-variant="primary"]:visible').count(), 1, 'exactly one orange action on the live overview');
    await page.screenshot({ path: path.join(out, 'overview-1280.png'), fullPage: true });

    // 2) the same prizes are counted on the destination screen.
    await link.click();
    await page.waitForURL(/\/rewards$/);
    await page.getByRole('heading', { level: 1, name: '경품 지급 현황', exact: true }).waitFor();
    await page.getByRole('region', { name: '경품 지급 목록' }).waitFor();
    await page.getByRole('button', { name: /^확인 필요\s*3$/ }).waitFor();
    await page.getByRole('button', { name: /^지급 대기\s*1$/ }).waitFor();
    await page.screenshot({ path: path.join(out, 'rewards-1280.png'), fullPage: true });

    // 3) a phone: the row fits and nothing scrolls sideways.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(overview);
    await row.waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'no horizontal overflow at 390');
    await page.screenshot({ path: path.join(out, 'overview-390.png'), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 900 });

    // 4) nothing needs a look: the row is gone, not "0건".
    const clean = await read();
    for (const reward of clean.rewards) if (reward.status === 'READY' || reward.status === 'PENDING') Object.assign(reward, { status: 'RECEIVED', participantId: approved.id });
    await write(clean);
    await page.goto(overview);
    await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await row.count(), 0, 'no prize needs a look, so no row');

    // 5) feature off: even with prizes needing a look the row stays away.
    await write(workspace);
    await setFeatures(['draw', 'poll', 'screen', 'venue']);
    await page.goto(overview);
    await page.getByRole('heading', { name: '지금 할 일' }).waitFor();
    assert.equal(await row.count(), 0, 'the 경품 feature is off, so no row');

    assert.deepEqual(errors, []);
    await context.close();
    console.log('Overview 경품 확인 필요: counts like the rewards screen, stays quiet, hides when empty or off');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
