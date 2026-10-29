'use strict';

// Owned Next + real isolated API/PostgreSQL. Mock delivery only; never use
// the running production service. --before captures the incumbent build.
for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const axe = require('axe-core').source;
const before = process.argv.includes('--before');
const OUT = path.join(process.env.EVENTOUCH_CAPTURE_ROOT || defaultCaptureDir(`message-workbench-20261027-${runStamp()}`), before ? 'before' : 'after');

async function main() {
  prepareCaptureDir(OUT);
  process.env.TMPDIR = ensureRunTmpDir(OUT);
  const buildId = fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim();
  const checks = [], errors = [];
  const check = (name, ok, detail = null) => { checks.push({ name, ok: Boolean(ok), detail }); assert.ok(ok, `${name}: ${JSON.stringify(detail)}`); };
  let f, browser, completed = false;
  try {
    f = await startAuditFixture();
    const base = `${f.baseUrl}/console/events/${f.eventId}/messages`;
    const command = async (command, payload) => {
      const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, { cookie: f.manager.cookie, method: 'POST', body: { commandId: crypto.randomUUID(), command, payload } });
      assert.ok(r.status >= 200 && r.status < 300, JSON.stringify(r.json)); return r.json;
    };
    const workspace = async () => (await f.helpers.requestJson(f.harness.baseUrl, '/api/bootstrap', { cookie: f.manager.cookie })).json.state.workspaces[f.eventId];
    const people = (await workspace()).participants;
    const ids = people.slice(0, 2).map(p => p.id);
    await command('template.save', { name: '현장 입장 안내', channel: 'SMS', body: '{{이름}}님, 안내 데스크에서 티켓을 보여 주세요.' });
    for (const title of ['사전 안내', '오시는 길', '입장 안내']) await command('message.create', { ids, title, channel: 'SMS', body: '행사 안내입니다. 모의 기록이며 전달되지 않습니다.', simulate: true });
    const scheduled = (await command('message.create', { ids, title: '당일 입장 안내', channel: 'SMS', body: '예약 검수용 안내', simulate: true, scheduled: new Date(Date.now() + 3600000).toISOString() })).message;
    const failed = (await command('message.create', { ids, title: '재작성할 실패 안내', channel: 'SMS', body: '실패 원문 {{이름}}님, 현장에서 뵙겠습니다.', simulate: true })).message;
    // Display-only FAILED fixture. This does not simulate a provider success.
    await f.harness.database.query("UPDATE event_workspaces SET payload=jsonb_set(payload,'{messages}',(SELECT jsonb_agg(CASE WHEN m->>'id'=$2 THEN jsonb_set(m,'{status}','\"FAILED\"'::jsonb) ELSE m END) FROM jsonb_array_elements(payload->'messages') m)) WHERE event_id=$1", [f.eventId, failed.id]);
    browser = await launchBrowser();
    const context = await browser.newContext({ reducedMotion: 'reduce', timezoneId: 'Asia/Seoul' });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    page.on('pageerror', e => errors.push(e.message));
    const loaded = async (url = base) => {
      await page.goto(url, { waitUntil: 'networkidle' });
      const handoff = new URL(url).searchParams.has('to');
      await page.locator(before || handoff ? '#campaign-title' : '#history-heading').waitFor();
    };
    const shot = async (name, width, anchor = null) => {
      await page.evaluate(() => document.fonts.ready); await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: path.join(OUT, `${name}-${width}.png`), fullPage: true });
      if (anchor) await page.locator(anchor).evaluate(el => el.scrollIntoView({ block: 'start' }));
      await page.screenshot({ path: path.join(OUT, `${name}-${width}-viewport.png`) });
      check(`${name}@${width}: no document overflow`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.evaluate(axe);
      const v = await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['moderate', 'serious', 'critical'].includes(v.impact)).map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
      check(`${name}@${width}: axe moderate+`, v.length === 0, v);
    };
    // Recipient meta wrap contract: measure the actually drawn text lines,
    // not the boxes. A Korean status must never split mid-syllable (참가 확/
    // 정): a new line may only start after a non-syllable boundary, and no
    // drawn char may stick out of its row. Long emails/numbers stay contained
    // via break-word instead of mid-syllable anywhere breaks.
    const checkRecipientMeta = async (name) => {
      if (!(await page.locator('ul[aria-label="참가자 선택"]').isVisible())) {
        await page.locator('#recipient-list-summary').click();
        await page.locator('ul[aria-label="참가자 선택"]').waitFor();
      }
      const result = await page.evaluate(() => {
        const range = document.createRange();
        const violations = [];
        let checked = 0;
        document.querySelectorAll('ul[aria-label="참가자 선택"] [data-recipient-meta]').forEach((el, index) => {
          if (el.getClientRects().length === 0) return; // folded list
          checked += 1;
          const row = el.closest('li').getBoundingClientRect();
          const seq = [];
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let textNode;
          while ((textNode = walker.nextNode())) {
            for (let i = 0; i < textNode.data.length; i++) {
              range.setStart(textNode, i);
              range.setEnd(textNode, i + 1);
              const rects = [...range.getClientRects()];
              seq.push({ ch: textNode.data[i], rect: rects.length ? rects[0] : null });
            }
          }
          const lines = [];
          seq.forEach((c, i) => {
            if (!c.rect) return;
            const top = Math.round(c.rect.top);
            const last = lines[lines.length - 1];
            if (last && last.top === top) last.chars.push({ ...c, index: i });
            else lines.push({ top, chars: [{ ...c, index: i }] });
          });
          lines.forEach((line, li) => {
            if (li === 0) return;
            const prev = seq[line.chars[0].index - 1];
            const first = line.chars[0];
            if (prev && /[가-힣]/.test(prev.ch) && /[가-힣]/.test(first.ch)) {
              violations.push({ row: index, kind: 'mid-syllable split', prev: prev.ch, first: first.ch });
            }
          });
          seq.forEach((c, i) => {
            if (!c.rect) return;
            if (c.rect.left < row.left - 1 || c.rect.right > row.right + 1) {
              violations.push({ row: index, kind: 'row overflow', index: i, ch: c.ch });
            }
          });
        });
        return { checked, violations };
      });
      check(name, result.checked > 0 && result.violations.length === 0, result);
    };
    for (const width of [1440, 1280, 390, 320]) {
      await page.setViewportSize({ width, height: width > 768 ? 900 : 844 }); await loaded();
      if (!before) {
        check(`header@${width}: task title precedes event context`, await page.locator('main header').first().evaluate(el => el.querySelector('h1').getBoundingClientRect().top < el.querySelector('a').getBoundingClientRect().top));
        check(`history@${width}: visible before compose`, await page.locator('[data-history-row]').first().isVisible() && !await page.locator('#campaign-title').isVisible());
        check(`history@${width}: create reachable`, await page.locator('#message-compose-open').isVisible());
      }
      await shot('history', width);
      if (!before && width === 320) {
        // Narrow ledger: measure the actually drawn text, not the grid cells.
        // A nowrap string can overflow its own 12px-gapped cell and read
        // joined (단문대상) while the cell boxes still look separated, so each
        // cell's text is ranged per drawn line and every vertically shared
        // band must keep a readable gap. Status chips join the same
        // comparison. The 4px floor sits well under the 12px design gap;
        // nothing is hidden with overflow to fake it.
        const meta = await page.evaluate(() => {
          const lines = (el) => {
            const range = document.createRange();
            range.selectNodeContents(el);
            return [...range.getClientRects()]
              .filter(b => b.right > b.left && b.bottom > b.top)
              .map(b => ({ left: b.left, right: b.right, top: b.top, bottom: b.bottom }));
          };
          const box = (el) => {
            const b = el.getBoundingClientRect();
            return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
          };
          return [...document.querySelectorAll('[data-history-row]')].map(row => {
            const cell = (name) => row.querySelector(`[data-history-${name}]`);
            return {
              channel: lines(cell('channel')),
              count: lines(cell('count')),
              time: lines(cell('time')),
              status: [...cell('status').querySelectorAll('span')].map(box).filter(b => b.right > b.left && b.bottom > b.top),
            };
          });
        });
        // Fragments on different vertical bands are independent rows, not
        // joins. Fragments sharing a band must read apart: touching or
        // overlapping drawn text fails.
        const sharesBand = (a, b) => a.top < b.bottom - 1 && b.top < a.bottom - 1;
        const gapBetween = (a, b) => {
          const left = a.left <= b.left ? a : b;
          const right = left === a ? b : a;
          return right.left - left.right;
        };
        let worst = null;
        const joined = meta.some((row, index) => {
          const pairs = [];
          for (const a of row.channel) for (const b of row.count) pairs.push(['channel×count', a, b]);
          for (const a of [...row.channel, ...row.count, ...row.time]) for (const b of row.status) pairs.push(['meta×status', a, b]);
          return pairs.some(([kind, a, b]) => {
            if (!sharesBand(a, b)) return false;
            const gap = gapBetween(a, b);
            if (worst === null || gap < worst.gap) worst = { row: index, kind, gap };
            return gap < 4;
          });
        });
        check('history@320: drawn channel, count and status text keeps its gaps',
          meta.length > 0 && !joined, { rows: meta.length, worst, meta });
        // The 44px touch floor is width as well as height: the narrowest row
        // action (상세, two syllables) measured 41.98px, so the real button box
        // and its center hit point are asserted, not the stylesheet alone.
        const detailTouch = await page.locator('[data-history-row]').first().getByRole('button', { name: /상세/ }).evaluate((el) => {
          const r = el.getBoundingClientRect();
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return { width: r.width, height: r.height, centerHit: hit === el || el.contains(hit) };
        });
        check('history@320: detail button meets the 44px touch target with a true hit',
          detailTouch.width >= 44 && detailTouch.height >= 44 && detailTouch.centerHit, detailTouch);
      }
      if (!before && width === 1280) {
        // Desktop ledger: every cell of a row shares that row's top and
        // bottom, so no single column (e.g. status) breaks the row boundary.
        const rows = await page.evaluate(() => [...document.querySelectorAll('[data-history-row]')].map(row => {
          const r = row.getBoundingClientRect();
          const status = row.querySelector('[data-history-status]').getBoundingClientRect();
          const edges = [...row.children].map(td => td.getBoundingClientRect());
          return {
            statusTop: status.top - r.top,
            statusBottom: r.bottom - status.bottom,
            innerTop: r.top - Math.min(...edges.map(c => c.top)),
            innerBottom: Math.max(...edges.map(c => c.bottom)) - r.bottom,
          };
        }));
        check('history@1280: status cell shares the row boundary',
          rows.length > 0 && rows.every(g => Math.abs(g.statusTop) <= 2 && Math.abs(g.statusBottom) <= 2
            && Math.abs(g.innerTop) <= 2 && Math.abs(g.innerBottom) <= 2), rows);
      }
      if (!before) {
        await page.locator('#message-compose-open').click(); await page.locator('#campaign-title').waitFor();
        check(`compose@${width}: history yields to the active workspace`,
          !await page.locator('#history-heading').isVisible() && await page.locator('#message-compose-close').isVisible());
        await shot('compose', width, '#campaign-heading');
        if (width === 320) {
          await checkRecipientMeta('compose@320: recipient meta breaks at word boundaries without overflow');
        }
      }
    }
    if (before) { completed = true; return; }
    // Behavioral scenarios follow the same persisted workspace, not API stubs.
    await page.setViewportSize({ width: 1280, height: 900 }); await loaded(`${base}?to=${ids.join(',')}`);
    await page.locator('#campaign-title').waitFor();
    check('exact-ID handoff reveals composer', (await page.locator('#recipient-summary').innerText()).includes('선택 2명'));
    check('handoff is consumed without send', !new URL(page.url()).searchParams.has('to') && f.gateway.commands.length === 0);
    await page.locator('#campaign-title').fill('보존할 안내'); await page.locator('#campaign-body').fill('입력과 선택을 보존합니다.');
    await page.locator('#message-compose-close').click();
    check('history return hides but does not destroy draft', !await page.locator('#campaign-title').isVisible());
    await page.locator('#message-compose-open').click();
    check('compose return retains input and exact selection', await page.locator('#campaign-title').inputValue() === '보존할 안내' && (await page.locator('#recipient-summary').innerText()).includes('선택 2명'));
    await page.locator('#recipient-selected-only').uncheck();
    await page.locator('#recipient-search').fill(people[0].name);
    check('recipient filter keeps hidden selection', (await page.locator('#recipient-summary').innerText()).includes('화면 밖 선택 1명'));
    await page.locator('#message-compose-close').click();
    const failedRow = page.locator(`#campaign-${failed.id}`);
    await failedRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
    const overwrite = page.getByRole('group', { name: '실행 확인' });
    await overwrite.getByRole('button', { name: '취소', exact: true }).click();
    check('failed reload cancel preserves draft', await page.locator('#campaign-title').inputValue() === '보존할 안내');
    await failedRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
    await overwrite.getByRole('button', { name: '불러온다', exact: true }).click();
    await page.locator('#campaign-title').waitFor();
    check('failed reload reveals exact saved content without sending', await page.locator('#campaign-body').inputValue() === failed.body && await page.locator('#campaign-scheduled').inputValue() === '' && f.gateway.commands.length === 0);
    await page.getByLabel('모의 발송으로 기록', { exact: false }).check();
    const countBefore = (await workspace()).messages.length;
    let lostId = null; const attempts = [];
    await page.route('**/api/events/*/commands', async route => {
      const data = route.request().postDataJSON();
      if (data.command !== 'message.create') return route.continue();
      attempts.push(data.commandId);
      if (lostId) return route.continue();
      const response = await route.fetch(); assert.ok(response.ok()); lostId = (await response.json()).message.id;
      await route.abort('failed');
    });
    await page.locator('#campaign-submit').click();
    check('review does not send', (await workspace()).messages.length === countBefore);
    await page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
    await page.getByText('응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.', { exact: true }).first().waitFor();
    await shot('lost-response', 1280, '#campaign-submit');
    // The preview previously stuck across the next grid row and painted over
    // the simulation control during this exact scroll. A visible element is
    // not enough: verify that pointer hit-testing reaches each real option.
    for (const [label, target] of [
      ['schedule', page.locator('#campaign-scheduled')],
      ['simulation', page.getByLabel('모의 발송으로 기록', { exact: false })],
    ]) {
      const geometry = await target.evaluate(element => {
        const rect = element.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
        const label = element.closest('label');
        return { left: rect.left, top: rect.top, width: rect.width, height: rect.height,
          inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          unobscured: hit === element || element.contains(hit) || Boolean(label && label.contains(hit)) };
      });
      check(`lost response: ${label} remains visible and unobscured`, geometry.inViewport && geometry.unobscured, geometry);
    }
    await checkRecipientMeta('lost-response@1280: selected recipient meta keeps whole syllables without overflow');
    await page.locator('#message-compose-close').click();
    await failedRow.getByRole('button', { name: '내용·대상 불러오기', exact: true }).click();
    await page.locator('#campaign-submit').waitFor();
    check('unresolved receipt recovery reveals composer', await page.locator('#campaign-submit').isVisible() && attempts.length === 1);
    await page.locator('#campaign-submit').click();
    await page.getByRole('button', { name: '모의 발송을 기록한다', exact: true }).click();
    await page.getByText('모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다.', { exact: true }).first().waitFor();
    check('lost response reuses receipt exactly once', attempts.length === 2 && attempts[0] === attempts[1] && (await workspace()).messages.filter(m => m.id === lostId).length === 1);
    await page.locator(`#campaign-${lostId}`).waitFor({ state: 'visible' });
    await page.waitForFunction(id => document.activeElement?.id === `campaign-${id}`, lostId);
    check('proven send returns focus to its visible history record', !await page.locator('#campaign-title').isVisible() && await page.locator(`#campaign-${lostId}`).isVisible());
    await page.unroute('**/api/events/*/commands');
    const reservation = page.locator(`#campaign-${scheduled.id}`);
    await reservation.getByRole('button', { name: '예약 취소', exact: true }).click();
    await page.getByRole('button', { name: '예약을 취소한다', exact: true }).click();
    await reservation.getByText('취소', { exact: true }).waitFor();
    check('reservation cancel persists', (await workspace()).messages.find(m => m.id === scheduled.id).status === 'CANCELLED');
    // Proven send already returned to history. Exercise a fresh explicit
    // compose → history return as a separate focus-restoration contract.
    await page.locator('#message-compose-open').click();
    await page.locator('#message-compose-close').click();
    await page.waitForFunction(() => document.activeElement?.id === 'message-compose-open');
    const detailsButton = failedRow.locator(`button[aria-controls="campaign-detail-${failed.id}"]`);
    await detailsButton.focus(); await page.keyboard.press('Enter');
    await page.locator(`#campaign-detail-${failed.id}`).waitFor();
    check('history detail opens by keyboard', await page.locator(`#campaign-detail-${failed.id}`).isVisible());
    await shot('detail', 1280, `#campaign-${failed.id}`);
    await detailsButton.click();
    const template = page.locator('#template-details'); await template.locator('summary').click();
    await template.getByRole('button', { name: '사용', exact: true }).first().click();
    await page.locator('#campaign-title').waitFor();
    check('template use reveals composer without sending', await page.locator('#campaign-body').inputValue() === '{{이름}}님, 안내 데스크에서 티켓을 보여 주세요.');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('#message-compose-close').click();
    await page.locator('#message-history-search').fill('없는발송999');
    check('no-match has reset', await page.getByRole('button', { name: '기록 검색·필터 초기화', exact: true }).isVisible());
    await shot('no-match', 390);
    await page.getByRole('button', { name: '기록 검색·필터 초기화', exact: true }).click();
    check('reset restores records without changing draft', await page.locator('[data-history-row]').count() === countBefore + 1 && await page.locator('#campaign-body').inputValue() === '{{이름}}님, 안내 데스크에서 티켓을 보여 주세요.');
    const scopedBootstrap = `**/api/events/${f.eventId}/bootstrap`;
    await page.route(scopedBootstrap, r => r.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: '검수용 연결 실패' }) }));
    await page.reload(); await page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor();
    await shot('load-error', 390);
    await page.unroute(scopedBootstrap); await page.getByRole('button', { name: '다시 불러오기', exact: true }).click(); await page.locator('#history-heading').waitFor();
    check('read error recovers real history', await page.locator('[data-history-row]').count() === countBefore + 1);
    // Real persisted long content, not CSS text injected over a screenshot.
    await f.harness.database.query("UPDATE events SET payload=jsonb_set(payload,'{name}',to_jsonb($2::text)) WHERE id=$1", [f.eventId, '전국 행사 운영 담당자와 현장 스태프가 함께하는 하반기 운영 실무 워크숍 및 성과 공유회']);
    await command('message.create', { ids, title: '하반기 운영 실무 워크숍 참가자를 위한 입장 장소 변경 및 등록 데스크 운영 시간 사전 안내', channel: 'SMS', body: '긴 제목 렌더 검수이며 실제로 전달되지 않습니다.', simulate: true });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: width > 768 ? 900 : 844 }); await loaded();
      await shot('long-content', width);
      check(`long header@${width}: task title remains first`, await page.locator('main header').first().evaluate(el => el.querySelector('h1').getBoundingClientRect().top < el.querySelector('a').getBoundingClientRect().top));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    const emptyId = `${f.eventId}-empty`;
    await f.helpers.insertEvent(f.harness.database, { orgId: f.helpers.LEGACY_ORG, id: emptyId, slug: emptyId, payload: { id: emptyId, slug: emptyId, name: '첫 안내 검수 행사', stage: 'LIVE' }, workspace: f.helpers.emptyWorkspace() });
    await f.helpers.insertMembership(f.harness.database, f.manager.id, emptyId, ['all']);
    await loaded(`${f.baseUrl}/console/events/${emptyId}/messages`);
    check('first-use retains clear create action', await page.getByText('아직 발송 기록이 없습니다. 메시지 작성에서 첫 안내를 준비하세요.', { exact: true }).isVisible() && await page.locator('#message-compose-open').isVisible());
    await shot('empty', 390);
    check('runtime errors', errors.length === 0, errors);
    check('same build', fs.readFileSync(path.join(__dirname, '../apps/web/.next/BUILD_ID'), 'utf8').trim() === buildId);
    completed = true;
  } finally {
    fs.writeFileSync(path.join(OUT, 'verification.json'), JSON.stringify({ buildId, before, completed, checks, errors, disclosures: ['isolated synthetic API/PostgreSQL fixture', 'FAILED status is display-only fixture; send is simulated', 'Chromium only; no real delivery, device/Safari/AT or customer acceptance', 'production untouched'] }, null, 2), { mode: 0o600 });
    if (browser) await browser.close(); if (f) await f.close();
  }
}
main().catch(e => { console.error(e); process.exitCode = 1; });
