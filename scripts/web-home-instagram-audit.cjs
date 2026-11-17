'use strict';

// The photo-first 인스타형 home (owner decision 2026-11-18, option B: a feed of
// approved participant photos under a slim banner), in a real browser against
// the real build and a real API: the operator picks it in the studio and sees
// the approved photos in the live phone, saves and publishes it, and an
// anonymous attendee gets the feed. Only approved photos reach it; a page with
// no approved photo (or with the 사진 feature off) reads as the tile home; more
// than twelve show the latest twelve with a quiet note.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const path = require('node:path');
const zlib = require('node:zlib');
const { source: axeSource } = require('axe-core');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type), data]);
  const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}
// A solid-color PNG, so each synthetic photo is visibly its own.
function solidPng(width, height, [red, green, blue]) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4);
  header[8] = 8; header[9] = 2;
  const row = Buffer.alloc(width * 3 + 1);
  for (let x = 0; x < width; x++) { row[1 + x * 3] = red; row[2 + x * 3] = green; row[3 + x * 3] = blue; }
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'home-instagram'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  const db = f.harness.database;
  const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
  const write = async (workspace) => db.query('UPDATE event_workspaces SET payload=$2::jsonb, revision=revision+1 WHERE event_id=$1', [f.eventId, JSON.stringify(workspace)]);
  const setFeatures = async (features) => db.query("UPDATE events SET payload=jsonb_set(payload, '{features}', $2::jsonb), revision=revision+1 WHERE id=$1", [f.eventId, JSON.stringify(features)]);
  const FEATURES = ['draw', 'poll', 'reward', 'screen', 'venue', 'photo'];
  try {
    await setFeatures(FEATURES);

    // Real uploaded files, so the public file route has something to serve.
    const upload = async (name, color) => {
      const response = await fetch(`${f.harness.baseUrl}/api/events/${f.eventId}/files?name=${encodeURIComponent(name)}&commandId=${encodeURIComponent(crypto.randomUUID())}`, {
        method: 'POST', headers: { 'content-type': 'image/png', cookie: f.manager.cookie }, body: solidPng(400, 300, color),
      });
      const json = await response.json();
      assert.equal(response.status, 201, JSON.stringify(json));
      return json.file;
    };
    const palette = [[46, 61, 91], [200, 68, 31], [62, 124, 89], [217, 164, 65], [108, 122, 137], [142, 111, 184]];
    const workspace = await read();
    const person = workspace.participants.find((item) => item.status === 'APPROVED');
    const entry = async (id, status, caption, at, color) => ({
      id, participantId: person.id, name: '감사 참가자 1', status, caption, at,
      image: await upload(`${id}.png`, color),
    });
    workspace.photos = [
      await entry('p-old', 'APPROVED', '부스 투어 중', '2026-11-18T03:02:00.000Z', palette[0]),
      await entry('p-new', 'APPROVED', '개막 키노트 현장', '2026-11-18T05:13:00.000Z', palette[1]),
      await entry('p-mid', 'APPROVED', '네트워킹 시간', '2026-11-18T04:20:00.000Z', palette[2]),
      await entry('p-pending', 'PENDING', '승인 대기 중인 사진', '2026-11-18T06:00:00.000Z', palette[3]),
      await entry('p-hidden', 'HIDDEN', '숨김 처리된 사진', '2026-11-18T06:10:00.000Z', palette[4]),
    ];
    await write(workspace);

    browser = await launchBrowser();
    const operator = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
    await operator.addCookies([{ ...cookieForContext(f, 'manager'), url: f.baseUrl }]);
    const editor = await operator.newPage();
    const errors = [];
    editor.on('pageerror', (error) => errors.push(error.message));
    editor.setDefaultTimeout(15000);

    // 1) the studio: 인스타형 is a real choice, and the live phone shows the approved photos only.
    await editor.goto(`${f.baseUrl}/console/events/${f.eventId}/page`, { waitUntil: 'networkidle' });
    const layouts = editor.getByRole('radiogroup', { name: '홈 레이아웃', exact: true });
    const instagram = layouts.getByRole('radio', { name: /인스타형/ });
    await instagram.waitFor();
    assert.equal(await instagram.getAttribute('aria-disabled'), null, 'no longer a locked card');
    assert.equal(await editor.getByText('곧 제공').count(), 0);
    await instagram.click();
    assert.equal(await instagram.getAttribute('aria-checked'), 'true');
    // The studio's own live phone (not the layout card thumbnails or the full view).
    const phone = editor.getByRole('region', { name: /홈 디자인 미리보기$/ }).first();
    await phone.locator('[data-feed-photo]').first().waitFor();
    const feedIds = () => phone.locator('[data-feed-photo]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-feed-photo')));
    assert.deepEqual(await feedIds(), ['p-new', 'p-mid', 'p-old'], 'approved photos only, newest first');
    await phone.getByText('개막 키노트 현장', { exact: false }).waitFor();
    assert.equal(await phone.getByText('승인 대기 중인 사진').count(), 0, 'a pending photo is not in the feed');
    assert.equal(await phone.getByText('숨김 처리된 사진').count(), 0, 'a hidden photo is not in the feed');
    await phone.getByText('감사 참가자 1 · 오후 2:13', { exact: true }).waitFor();
    await editor.screenshot({ path: path.join(out, 'studio-1440.png'), fullPage: true });

    // 2) save the draft from the studio, publish it.
    const saved = editor.waitForResponse((response) => response.request().method() === 'POST' && response.url().includes('/commands') && (() => { try { return response.request().postDataJSON().command === 'attendee.page.save'; } catch { return false; } })());
    await editor.getByRole('button', { name: '초안 저장', exact: true }).click();
    assert.equal((await saved).status(), 200);
    assert.equal((await read()).pageExperience.draft.homeStyle.layout, 'instagram', 'the studio saved the layout');
    const published = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      method: 'POST', cookie: f.manager.cookie, body: { commandId: crypto.randomUUID(), command: 'attendee.page.publish', payload: {} },
    });
    assert.equal(published.status, 200, JSON.stringify(published.json));
    assert.equal(published.json.published.homeStyle.layout, 'instagram');

    // 3) an anonymous attendee gets the feed; pending and hidden files stay private.
    const attendeeContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', timezoneId: 'Asia/Seoul', reducedMotion: 'reduce' });
    const attendee = await attendeeContext.newPage();
    attendee.on('pageerror', (error) => errors.push(error.message));
    attendee.setDefaultTimeout(15000);
    const home = `${f.baseUrl}/event/${f.slug}/home`;
    await attendee.goto(home, { waitUntil: 'networkidle' });
    const feed = attendee.getByRole('region', { name: '현장 사진', exact: true });
    await feed.waitFor();
    assert.equal(await attendee.locator('[data-layout]').first().getAttribute('data-layout'), 'instagram');
    assert.deepEqual(await feed.locator('[data-feed-photo]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-feed-photo'))), ['p-new', 'p-mid', 'p-old']);
    await feed.getByRole('heading', { name: '현장 사진 3', exact: true }).waitFor();
    await feed.getByText('개막 키노트 현장', { exact: false }).waitFor();
    assert.equal(await attendee.getByText('승인 대기 중인 사진').count(), 0);
    assert.equal(await attendee.getByText('숨김 처리된 사진').count(), 0);
    const loaded = await feed.locator('img').evaluateAll((images) => images.map((image) => image.complete && image.naturalWidth > 0));
    assert.deepEqual(loaded, [true, true, true], 'every feed photo is readable by the public file route');
    const stored = (await read()).photos;
    for (const hiddenId of ['p-pending', 'p-hidden']) {
      const { fileId } = stored.find((photo) => photo.id === hiddenId).image;
      assert.equal((await attendee.request.get(`${f.baseUrl}/api/public/events/${f.slug}/files/${fileId}`)).status(), 404, `${hiddenId}: its file is not public`);
    }
    await attendee.getByRole('navigation', { name: '참가 메뉴' }).waitFor();
    for (const width of [320, 390, 768]) {
      await attendee.setViewportSize({ width, height: 844 });
      assert.equal(await attendee.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `no horizontal overflow at ${width}`);
    }
    await attendee.setViewportSize({ width: 390, height: 844 });
    await attendee.evaluate(axeSource);
    assert.deepEqual(await attendee.evaluate(async () => (await window.axe.run()).violations.filter((v) => ['serious', 'critical'].includes(v.impact)).map((v) => ({ id: v.id, nodes: v.nodes.map((node) => node.target) }))), [], 'no serious accessibility findings');
    await attendee.screenshot({ path: path.join(out, 'attendee-390.png'), fullPage: true });

    // 4) more than twelve: the latest twelve and a quiet note.
    const many = await read();
    for (let n = 0; n < 11; n += 1) {
      many.photos.push({ id: `p-extra-${n}`, participantId: person.id, name: '감사 참가자 1', status: 'APPROVED', caption: `추가 사진 ${n}`, at: `2026-11-18T0${n % 3}:3${n % 6}:00.000Z`, image: many.photos[0].image });
    }
    await write(many);
    await attendee.reload({ waitUntil: 'networkidle' });
    assert.equal(await attendee.locator('[data-feed-photo]').count(), 12, 'the feed stops at the latest twelve');
    await attendee.getByRole('heading', { name: '현장 사진 14', exact: true }).waitFor();
    await attendee.getByText('최근 12장을 보여 드려요. 전체 사진은 참여 콘텐츠에서 볼 수 있어요.', { exact: true }).waitFor();

    // 5) no approved photo, or the 사진 feature off: the tile home, not an empty feed.
    const none = await read();
    none.photos = none.photos.map((photo) => ({ ...photo, status: 'HIDDEN' }));
    await write(none);
    await attendee.reload({ waitUntil: 'networkidle' });
    await attendee.getByRole('navigation', { name: '참가 메뉴' }).waitFor();
    assert.equal(await attendee.locator('[data-layout]').first().getAttribute('data-layout'), 'tile', 'no approved photo reads as the tile home');
    assert.equal(await attendee.locator('[data-feed-photo]').count(), 0);
    await attendee.screenshot({ path: path.join(out, 'attendee-no-photos-390.png'), fullPage: true });
    const approved = await read();
    approved.photos = approved.photos.map((photo, index) => ({ ...photo, status: index < 3 ? 'APPROVED' : 'HIDDEN' }));
    await write(approved);
    await setFeatures(FEATURES.filter((feature) => feature !== 'photo'));
    await attendee.reload({ waitUntil: 'networkidle' });
    await attendee.getByRole('navigation', { name: '참가 메뉴' }).waitFor();
    assert.equal(await attendee.locator('[data-layout]').first().getAttribute('data-layout'), 'tile', 'the 사진 feature is off, so no feed');
    await setFeatures(FEATURES);

    // 6) the console keeps the layout and says where the photos will go.
    await write(none);
    await editor.reload({ waitUntil: 'networkidle' });
    const instagramAgain = editor.getByRole('radiogroup', { name: '홈 레이아웃', exact: true }).getByRole('radio', { name: /인스타형/ });
    const emptyPhone = editor.getByRole('region', { name: /홈 디자인 미리보기$/ }).first();
    await emptyPhone.getByText('승인된 참가자 사진이 여기에 표시됩니다', { exact: false }).waitFor();
    assert.equal(await emptyPhone.locator('[data-feed-photo]').count(), 0);
    assert.equal(await instagramAgain.getAttribute('aria-checked'), 'true', 'the studio keeps the saved layout');
    await editor.screenshot({ path: path.join(out, 'studio-empty-1440.png'), fullPage: true });

    assert.deepEqual(errors, []);
    await operator.close(); await attendeeContext.close();
    console.log('인스타형 홈: 스튜디오 선택·승인 사진만·최신순·12장 제한·사진 없으면 타일형·공개 파일 경계 확인');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch((error) => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
