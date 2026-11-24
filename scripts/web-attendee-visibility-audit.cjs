'use strict';
const path = require('node:path');
const assert = require('node:assert/strict');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'visibility');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture();
  let browser;
  try {
    const db = f.harness.database;
    const original = (await db.query('SELECT payload FROM events WHERE id=$1', [f.eventId])).rows[0].payload;
    browser = await launchBrowser();
    for (const enabled of [false, true]) {
      const features = enabled ? ['draw', 'poll', 'stamp', 'venue'] : ['venue'];
      await db.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [f.eventId, JSON.stringify({ ...original, features })]);
      const page = await browser.newPage({ viewport: { width: 320, height: 568 } });
      await page.goto(`${f.baseUrl}/event/${f.slug}/home`, { waitUntil: 'networkidle' });
      await page.getByRole('button', { name: '모바일 티켓' }).waitFor();
      await page.screenshot({ path: path.join(out, `${enabled ? 'enabled' : 'disabled'}-320.png`) });
        for (const label of ['럭키드로우 번호', '룰렛 이벤트', '순위 투표', '부스 인증']) {
          assert.equal(await page.getByRole('button', { name: new RegExp(`^${label}`) }).count(), enabled ? 1 : 0); // tiles may add a hint such as 티켓 필요
        }
        assert.equal(await page.locator('[aria-label*="입장 및 퇴장용 QR"]').count(), 0);
        for (const label of ['모바일 티켓', '공지사항', '내 신청 정보']) await page.getByRole('button', { name: new RegExp(`^${label}`) }).first().waitFor();
        const ticketBox = await page.getByRole('button', { name: /^모바일 티켓/ }).boundingBox();
        assert.ok(ticketBox && ticketBox.y >= 0 && ticketBox.y + ticketBox.height <= 568 && ticketBox.height >= 44);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        for (const control of await page.locator('nav[aria-label="참가 메뉴"] button, nav[aria-label="행사 안내와 참여"] button, nav[aria-label="행사 안내와 참여"] a').all()) {
          const box = await control.boundingBox();
          assert.ok(box && box.width >= 44 && box.height >= 44);
        }
        if (!enabled) for (const view of ['lucky', 'roulette', 'vote', 'stamp']) {
          await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=${view}`, { waitUntil: 'networkidle' });
          await page.getByText('현재 이 행사에서 제공하지 않습니다.', { exact: false }).waitFor();
          await page.getByRole('button', { name: '참가자 홈' }).click();
          await page.getByRole('button', { name: '모바일 티켓' }).waitFor();
          assert.equal(await page.getByRole('button', { name: '모바일 티켓' }).evaluate(el => el === document.activeElement), true);
        }
      await page.close();
    }
    console.log('[attendee-visibility] synthetic visibility checks passed');
  } finally { if (browser) await browser.close(); await f.close(); }
}
main().catch(error => { console.error('[attendee-visibility] failed:', String(error.message).split('\n')[0]); process.exitCode = 1; });
