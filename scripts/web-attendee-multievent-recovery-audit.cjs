'use strict';
// Real screens, isolated PostgreSQL, and loopback-only fake verification SMS.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const axe = require('axe-core').source;
const jsQR = require('../apps/web/node_modules/jsqr');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture } = require('./audit-fixture.cjs');

async function decodedTicket(page) {
  const pixels = await page.getByRole('img', { name: /행사 입장 및 퇴장용 QR/ }).locator('svg').evaluate(async svg => {
    const image = new Image();
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(new XMLSerializer().serializeToString(svg))}`;
    await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 360;
    const context = canvas.getContext('2d'); context.fillStyle = '#fff'; context.fillRect(0, 0, 360, 360);
    context.drawImage(image, 24, 24, 312, 312);
    return Array.from(context.getImageData(0, 0, 360, 360).data);
  });
  const result = jsQR(Uint8ClampedArray.from(pixels), 360, 360);
  assert.ok(result, 'the displayed synthetic QR can be decoded');
  return result.data;
}

async function main() {
  const before = process.argv.includes('--before');
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, before ? 'recovery-before' : 'recovery-after');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const codes = new Map();
  const supplier = http.createServer((req, res) => {
    let body = '';
    req.on('data', part => { body += part; });
    req.on('end', () => {
      try {
        const message = JSON.parse(body).messages[0];
        const code = String(message.text).match(/인증번호 (\d{6})/)?.[1];
        if (!code) throw new Error('missing code');
        codes.set(String(message.to).replace(/\D/g, ''), code);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ groupInfo: { groupId: 'fixture-local' }, failedMessageList: [] }));
      } catch { res.writeHead(400); res.end(); }
    });
  });
  await new Promise(resolve => supplier.listen(0, '127.0.0.1', resolve));
  let fixture, browser;
  try {
    fixture = await startAuditFixture({ fixtureSolapiHost: `http://127.0.0.1:${supplier.address().port}` });
    const source = (await fixture.harness.database.query(
      'SELECT e.payload AS event, w.payload AS workspace FROM events e JOIN event_workspaces w ON w.event_id=e.id WHERE e.id=$1', [fixture.eventId],
    )).rows[0];
    const second = `recovery-second-${fixture.suffix}`;
    await fixture.helpers.insertEvent(fixture.harness.database, { id: second, slug: second, orgId: fixture.helpers.LEGACY_ORG,
      payload: { ...source.event, id: second, slug: second, name: '합성 두 번째 행사' },
      workspace: { ...source.workspace, participants: [], checks: [], visits: [], assignments: [], messages: [], audit: [], verificationRequired: false },
    });
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    const signup = async (tab, slug, name, phone) => {
      await tab.goto(`${fixture.baseUrl}/event/${slug}/register`);
      await tab.locator('#field-name').fill(name);
      await tab.locator('#field-phone').fill(phone);
      if (await tab.locator('#consent').count()) await tab.locator('#consent').check();
      await tab.getByRole('button', { name: '신청하기', exact: true }).click();
      await tab.getByRole('img', { name: /님의 행사 입장 및 퇴장용 QR/ }).waitFor();
    };
    await signup(page, fixture.slug, '첫 행사 참가자', '01098001001');
    await signup(page, second, '기존 두 번째 행사 참가자', '01098001002');
    const oldBTab = await context.newPage();
    await oldBTab.goto(`${fixture.baseUrl}/event/${second}/ticket`);
    await oldBTab.getByRole('img', { name: /기존 두 번째 행사 참가자님의/ }).waitFor();
    const otherContext = await browser.newContext();
    const otherPage = await otherContext.newPage();
    await signup(otherPage, second, '새로 인증한 참가자', '01098001003');
    await signup(otherPage, second, '저장 전환 참가자', '01098001004');
    await signup(otherPage, second, '일부 저장 실패 참가자', '01098001005');
    await otherContext.close();
    // The tab begins with an in-memory ticket because storage rejects
    // writes. Once storage becomes available, recover another attendee
    // through the real UI, then move through the actual participant menu.
    // None of the bearer or test SMS code is logged or stored in evidence.
    async function storageTransition(name, phone, writesBlocked, screenshot) {
    const transitionContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await transitionContext.addInitScript(({ slug }) => {
      window.__fixtureStorageMode = 'blocked';
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if ((window.__fixtureStorageMode === 'blocked' && String(key).startsWith('eventouch.ticket')) ||
            (window.__fixtureStorageMode === 'ticket-blocked' && String(key) === `eventouch.ticket.${slug}`)) {
          throw new DOMException('blocked', 'QuotaExceededError');
        }
        return set.call(this, key, value);
      };
    }, { slug: second });
    const transition = await transitionContext.newPage();
    const transitionWorkspace = (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [second])).rows[0].payload;
    const oldPerson = transitionWorkspace.participants.find(person => person.phone === '01098001002');
    const recoveredPerson = transitionWorkspace.participants.find(person => person.phone === phone);
    assert.ok(oldPerson?.ticket);
    assert.ok(recoveredPerson?.ticket);
    await transition.goto(`${fixture.baseUrl}/event/${second}/ticket?ticket=${encodeURIComponent(oldPerson.ticket)}`);
    await transition.getByRole('img', { name: /기존 두 번째 행사 참가자님의/ }).waitFor();
    await transition.evaluate(blocked => { window.__fixtureStorageMode = blocked ? 'ticket-blocked' : 'available'; }, writesBlocked);
    await transition.getByRole('link', { name: '← 참가 메뉴로' }).click();
    await transition.getByRole('link', { name: '행사 안내 보기' }).click();
    await transition.getByRole('link', { name: '이미 신청했다면 내 티켓 찾기' }).click();
    await transition.getByLabel('신청할 때 입력한 연락처').fill(phone);
    await transition.getByRole('button', { name: '인증번호 받기', exact: true }).click();
    await transition.getByLabel('인증번호 6자리').waitFor();
    assert.ok(codes.get(phone));
    await transition.getByLabel('인증번호 6자리').fill(codes.get(phone));
    await transition.getByRole('button', { name: '내 티켓 열기' }).click();
    await transition.getByRole('img', { name: `${name}님의 행사 입장 및 퇴장용 QR` }).waitFor();
    await transition.getByRole('link', { name: '← 참가 메뉴로' }).click();
    await transition.getByRole('button', { name: '내 신청 정보' }).click();
    await transition.getByRole('heading', { name: '내 신청 정보' }).waitFor();
    await transition.screenshot({ path: path.join(out, screenshot), fullPage: true });
    assert.equal(await transition.getByText('기존 두 번째 행사 참가자', { exact: true }).count(), 0, 'a stale in-memory identity must not replace recovered identity');
    await transition.getByText(name, { exact: true }).waitFor({ timeout: 5000 });
    await transition.evaluate(axe);
    for (const width of [320, 390, 1280]) {
      await transition.setViewportSize({ width, height: 844 });
      assert.equal(await transition.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
      assert.deepEqual(await transition.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
    }
    await transition.getByRole('button', { name: '참가 메뉴' }).click();
    await transition.getByRole('button', { name: '모바일 티켓' }).click();
    await transition.getByRole('img', { name: `${name}님의 행사 입장 및 퇴장용 QR` }).waitFor();
    assert.ok((await decodedTicket(transition)) === recoveredPerson.ticket, 'the displayed QR belongs to the recovered participant');
    await transitionContext.close();
    }
    if (!before) {
      await storageTransition('저장 전환 참가자', '01098001004', false, 'storage-transition-application-390.png');
      await storageTransition('일부 저장 실패 참가자', '01098001005', true, 'storage-write-failure-application-390.png');
    }
    const recoveredTab = await context.newPage();
    await recoveredTab.goto(`${fixture.baseUrl}/event/${fixture.slug}/ticket`);
    await recoveredTab.getByRole('img', { name: /첫 행사 참가자님의/ }).waitFor();
    await page.goto(`${fixture.baseUrl}/event/${second}/ticket/recover`);
    await page.getByLabel('신청할 때 입력한 연락처').fill('01098001003');
    await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
    await page.getByLabel('인증번호 6자리').waitFor();
    await page.getByLabel('인증번호 6자리').fill(codes.get('01098001003'));
    await page.getByRole('button', { name: '내 티켓 열기' }).click();
    await page.getByRole('heading', { name: '내 티켓' }).waitFor();
    const shown = await page.locator('h2').first().innerText();
    await page.screenshot({ path: path.join(out, `${before ? 'before' : 'after'}-390.png`), fullPage: true,
      mask: [page.getByRole('img', { name: /QR/ })] });
    assert.equal(shown, before ? '기존 두 번째 행사 참가자' : '새로 인증한 참가자');
    if (!before) {
      const freshFirst = await context.newPage();
      await freshFirst.goto(`${fixture.baseUrl}/event/${fixture.slug}/ticket`);
      await freshFirst.getByRole('img', { name: /첫 행사 참가자님의/ }).waitFor();
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(axe);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
      }
      assert.deepEqual(errors, []);
      // A separately opened attendee tab keeps its own bearer after recovery
      // changes the browser session to another person for the same event.
      await oldBTab.reload();
      await oldBTab.getByRole('img', { name: /기존 두 번째 행사 참가자님의/ }).waitFor();

      // Deliver the confirmation to the API but lose its response. The
      // existing shared session has changed even though the form cannot know
      // that; the explicit session check must not display the stale bearer.
      await page.goto(`${fixture.baseUrl}/event/${second}/ticket/recover`);
      await page.getByLabel('신청할 때 입력한 연락처').fill('01098001002');
      await page.getByRole('button', { name: '인증번호 받기', exact: true }).click();
      await page.getByLabel('인증번호 6자리').waitFor();
      await page.getByLabel('인증번호 6자리').fill(codes.get('01098001002'));
      await page.route('**/api/public/events/*/verification/confirm', async route => {
        const response = await route.fetch();
        assert.ok(response.ok());
        await route.abort('failed');
      });
      await page.getByRole('button', { name: '내 티켓 열기' }).click();
      await page.getByText('인증 결과를 확인하지 못했습니다.', { exact: false }).waitFor();
      await page.getByRole('button', { name: '연결된 티켓 확인', exact: true }).click();
      await page.getByRole('img', { name: /기존 두 번째 행사 참가자님의/ }).waitFor();
      await page.getByText('연결된 티켓입니다. 참가자 이름이 맞는지 확인하세요.').waitFor();

      // A session-first lookup without any valid session must not erase the
      // old tab's own bearer, which remains usable on its ordinary route.
      await context.clearCookies();
      await oldBTab.goto(`${fixture.baseUrl}/event/${second}/ticket?session=1`);
      await oldBTab.getByRole('heading', { name: '티켓이 확인되지 않습니다' }).waitFor();
      await oldBTab.goto(`${fixture.baseUrl}/event/${second}/ticket`);
      await oldBTab.getByRole('img', { name: /기존 두 번째 행사 참가자님의/ }).waitFor();
      fs.writeFileSync(path.join(out, 'additional.json'), JSON.stringify({ oldTabPreserved: true,
        lostConfirmUsesNewSession: true, failedSessionKeepsOldBearer: true, actualProvider: false }, null, 2), { mode: 0o600 });
    }
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ shown, otherEventRetained: !before,
      storageTransitionMatched: !before, partialWriteFailureMatched: !before, decodedQrMatchesRecoveredTicket: !before,
      actualProvider: false }, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ shown, otherEventRetained: !before, actualProvider: false }));
  } finally {
    await browser?.close();
    await fixture?.close();
    await new Promise(resolve => supplier.close(resolve));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
