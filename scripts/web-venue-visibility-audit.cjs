'use strict';

// Real commands, public projections and browser pages on an isolated fixture.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function main() {
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'venue-visibility'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  try {
    const command = async (name, payload) => {
      const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
        method: 'POST', cookie: f.manager.cookie,
        body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok(r.status >= 200 && r.status < 300, `${name}: ${r.status} ${JSON.stringify(r.json)}`);
      return r.json;
    };
    const read = async (bearer) => {
      const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/public/events/${f.slug}${bearer ? '/ticket' : ''}`, bearer ? { bearer } : {});
      assert.equal(r.status, 200); return r.json;
    };
    const imagePath = path.join(__dirname, '../tests/fixtures/booth-map/synthetic-demo-floorplan.png');
    const upload = await fetch(`${f.harness.baseUrl}/api/events/${f.eventId}/files?name=venue.png&commandId=${crypto.randomUUID()}`, {
      method: 'POST', headers: { cookie: f.manager.cookie, 'content-type': 'image/png' }, body: fs.readFileSync(imagePath),
    });
    assert.equal(upload.status, 201); const image = (await upload.json()).file;
    const original = { name: '합성 푸른 행사장', address: '합성시 예시로 123', directions: '합성 정문', contact: '합성 주최처 1234', description: '합성 장소 안내' };
    const draft = (await command('venue.save', { ...original, map: { image: { fileId: image.fileId }, alt: '합성 장소 안내도' }, mode: 'draft' })).venue;
    const published = (await command('venue.publish', { expectedVersion: draft.version })).venue;
    await command('venue.save', { ...original, name: '미게시 합성 장소', map: { image: { fileId: image.fileId }, alt: '미게시 안내도' }, mode: 'draft', expectedVersion: published.version });
    const currentVenue = () => f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId]).then(r => r.rows[0].payload.venue);
    const before = await currentVenue();
    const participant = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.participants[0];
    assert.ok(participant.ticket, 'synthetic approved participant has a ticket');
    const active = await read(); const features = active.event.features;
    assert.ok(features.includes('venue') && features.includes('screen'));
    assert.equal(active.workspace.venue.name, original.name);
    assert.equal(active.workspace.venue.map.image.fileId, image.fileId);
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    const eventPage = `${f.baseUrl}/event/${f.slug}`;
    const screenUrl = `${f.baseUrl}/screen/${f.slug}`;
    const recoverUrl = `${eventPage}/ticket/recover`;
    await page.goto(eventPage, { waitUntil: 'networkidle' });
    await page.getByText(original.name, { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(out, 'visible-public-390.png'), fullPage: true });
    await page.goto(recoverUrl, { waitUntil: 'networkidle' });
    assert.ok((await page.locator('body').innerText()).includes(original.contact), 'visible venue contact is shown for recovery');
    await page.goto(screenUrl, { waitUntil: 'networkidle' });
    await page.getByText(original.name, { exact: true }).first().waitFor();

    // The feature switch is an event command, not a destructive venue save.
    await command('event.features', { features: features.filter(value => value !== 'venue'), expectedFeatures: features });
    await page.waitForFunction(value => !document.body.innerText.includes(value), original.name, { timeout: 15000 });
    await page.screenshot({ path: path.join(out, 'live-screen-disabled-390.png'), fullPage: true });
    const hidden = await read();
    assert.deepEqual(hidden.workspace.venue, { name: '', address: '', directions: '', contact: '', description: '' });
    assert.deepEqual((await read(participant.ticket)).workspace.venue, { name: '', address: '', directions: '', contact: '', description: '' });
    assert.equal((await fetch(`${f.harness.baseUrl}/api/public/events/${f.slug}/files/${image.fileId}`)).status, 404);
    assert.deepEqual(await currentVenue(), before, 'both live and draft venue are preserved');
    await page.goto(eventPage, { waitUntil: 'networkidle' });
    const publicText = await page.locator('body').innerText();
    for (const value of Object.values(original)) assert.ok(!publicText.includes(value), `feature-off public event hides ${value}`);
    assert.equal(await page.locator('#public-venue').count(), 0);
    await page.screenshot({ path: path.join(out, 'disabled-public-390.png'), fullPage: true });
    await page.goto(recoverUrl, { waitUntil: 'networkidle' });
    assert.ok(!(await page.locator('body').innerText()).includes(original.contact), 'feature-off recovery hides contact');
    await page.goto(screenUrl, { waitUntil: 'networkidle' });
    await page.locator('.display-board').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes(original.name), 'feature-off display hides venue');
    await page.screenshot({ path: path.join(out, 'disabled-screen-390.png'), fullPage: true });

    // A previous API version may still supply the stored venue alongside an
    // off feature flag; the new screen must independently honour the flag.
    await page.route(`**/api/public/events/${f.slug}`, route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...hidden, workspace: { ...hidden.workspace, venue: active.workspace.venue } }) }));
    await page.goto(screenUrl, { waitUntil: 'networkidle' });
    await page.locator('.display-board').waitFor();
    assert.ok(!(await page.locator('body').innerText()).includes(original.name), 'legacy API response must not restore the venue on screen');
    await page.unrouteAll();

    const pageDraft = await command('attendee.page.save', { intro: '합성 행사 안내', accent: '#E76D26', showAnnouncements: true, showSchedule: true, showVenue: false, showPrograms: true });
    await command('attendee.page.publish', { expectedDraftVersion: pageDraft.draftVersion });
    await command('event.features', { features, expectedFeatures: features.filter(value => value !== 'venue') });
    await page.waitForFunction(value => document.body.innerText.includes(value), original.name, { timeout: 15000 });
    await page.screenshot({ path: path.join(out, 'live-screen-restored-390.png'), fullPage: true });
    assert.deepEqual(await currentVenue(), before, 'page and feature toggles preserve both venue versions');
    const pageHidden = await read();
    assert.equal(pageHidden.workspace.venue.name, original.name, 'page-only visibility does not hide screen venue');
    assert.equal(pageHidden.workspace.venue.map, undefined);
    await page.goto(eventPage, { waitUntil: 'networkidle' });
    assert.equal(await page.locator('#public-venue').count(), 0);
    assert.ok(!(await page.locator('body').innerText()).includes(original.name));
    await page.goto(recoverUrl, { waitUntil: 'networkidle' });
    assert.ok(!(await page.locator('body').innerText()).includes(original.contact));
    await page.goto(screenUrl, { waitUntil: 'networkidle' });
    await page.getByText(original.name, { exact: true }).first().waitFor();
    await page.screenshot({ path: path.join(out, 'page-hidden-screen-retained-390.png'), fullPage: true });

    const restoredPage = await command('attendee.page.save', { intro: '합성 행사 안내', accent: '#E76D26', showAnnouncements: true, showSchedule: true, showVenue: true, showPrograms: true });
    await command('attendee.page.publish', { expectedDraftVersion: restoredPage.draftVersion });
    assert.equal((await read()).workspace.venue.name, original.name);
    assert.equal((await fetch(`${f.harness.baseUrl}/api/public/events/${f.slug}/files/${image.fileId}`)).status, 200);
    await page.goto(eventPage, { waitUntil: 'networkidle' });
    await page.getByText(original.name, { exact: true }).first().waitFor();
    await page.goto(recoverUrl, { waitUntil: 'networkidle' });
    assert.ok((await page.locator('body').innerText()).includes(original.contact));
    assert.deepEqual(await currentVenue(), before);
    console.log('venue visibility: feature off, page-only hidden, legacy screen response, recovery, screen, published map and draft preservation passed');
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}
main().catch(error => { console.error('[venue-visibility]', error); process.exitCode = 1; });
