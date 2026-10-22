'use strict';

// Task-first final refinements: rendered states for the four owned surfaces.
//
// Owned Next production build + task-local PostgreSQL schema + real API only
// (startAuditFixture). No deployment, retained data, live messaging, or
// product server change. The unknown-key and participant.import probe rows
// are prepended to the FIXTURE's own workspace audit jsonb through the
// harness database handle — the same fixture-injection standing the
// task-flow audit uses for synthetic FAILED history — so the UI mapping for
// keys no live command emits yet still renders against real data.
//
// Cases: team known labels non-raw + unknown raw-behind-details + bootstrap
// failure/retry; photos empty -> synthetic PNG persists + invalid format
// rejected; import invalid csv error + valid preview alignment with no
// commit; operations open/closed/wait badges with 44px targets. Captures go
// to the existing after/ path under states-* names (no overlap with the
// parent-owned final audit or journeys captures).
//
// DO NOT RUN until the refinements build is ready: the fixture asserts the
// production .next artifact. Parent owns the build and the final audit
// script; this file is states evidence only.

for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { startAuditFixture, resolveAuditDatabaseUrl } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const out = '/tmp/opencode/eventouch-captures/task-first-final/after';
const UI_TIMEOUT = 15000;

// Real 1x1 transparent PNG (70 bytes, valid IHDR), same standing as the
// console-boundaries audit: identical bytes, unique filename per upload.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function commandId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

async function main() {
  if (!resolveAuditDatabaseUrl()) {
    throw new Error('set a task-local EVENTOUCH_A11Y_DATABASE_URL (or MOBILE/TEST) to an isolated PostgreSQL database; never a shared one');
  }
  fs.mkdirSync(out, { recursive: true });
  const f = await startAuditFixture();
  let browser;
  const errors = [];
  const counts = { labels: 0, badges: 0, targets: 0, wraps: 0, states: 0 };
  const photoGuidance = {};
  const contactWraps = [];
  let importFileInput1280 = null;
  let interactions = 0;
  const api = async (command, payload) => {
    const r = await f.helpers.requestJson(f.harness.baseUrl, `/api/events/${f.eventId}/commands`, {
      cookie: f.manager.cookie, method: 'POST', body: { commandId: commandId('states'), command, payload },
    });
    assert.ok(r.status >= 200 && r.status < 300, `seed ${command}: ${r.status} ${JSON.stringify(r.json)}`);
    return r.json;
  };
  try {
    // Real commands behind the asserted audit rows. participant.import emits
    // no audit entry (participants path), so its label is probed with a
    // fixture-injected row below, like the unknown key.
    await api('event.features', { features: ['draw', 'poll', 'reward', 'screen', 'venue', 'stamp'] });
    const drawModule = (await api('module.save', { title: '기념 추첨 무대', type: 'draw' })).module;
    await api('draw.program.save', { name: '기념 추첨', moduleId: drawModule.id, quota: 1, eligibility: 'PERSON', status: 'DRAFT' });
    await api('booth.mode', { mode: 'STAFF', acknowledge: true });
    const closedDesk = (await api('desk.save', { name: '감사 보조 데스크', action: 'OUT', mode: 'desk', open: true })).desk;
    await api('desk.set-open', { id: closedDesk.id, open: false });
    await api('booth.save', { name: '대기 체험 부스', zone: '동문', status: 'WAITING', capacity: 0, limit: 1 });
    await api('booth.save', { name: '진행 체험 부스', zone: '서문', status: 'OPEN', capacity: 50, limit: 2 });
    await api('booth.save', { name: '종료 체험 부스', zone: '북문', status: 'CLOSED', capacity: 0, limit: 1 });

    // Fixture-only audit probes in the fixture's own workspace: a
    // forward-compat participant.import row (no live command emits one) and
    // an unknown technical key. Product code is untouched.
    const probeRows = [
      { id: `states-probe-${f.suffix}-import`, type: 'participant.import', actor: f.manager.id, at: new Date().toISOString(), detail: '2행', eventId: f.eventId },
      { id: `states-probe-${f.suffix}-shadow`, type: 'fixture.shadow-check', actor: f.manager.id, at: new Date().toISOString(), detail: '', eventId: f.eventId },
    ];
    {
      const row = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0];
      const payload = row.payload;
      payload.audit = [...probeRows, ...(Array.isArray(payload.audit) ? payload.audit : [])];
      await f.harness.database.query('UPDATE event_workspaces SET payload=$2 WHERE event_id=$1', [f.eventId, JSON.stringify(payload)]);
    }
    // Wrap datasets, fixture-local and dropped with the schema: a second
    // long-hash local part (the observed 9a0884f… shape) plus an overlong
    // domain that must wrap without ever overflowing.
    const wrapProbeAccounts = [
      { id: `states-wrap-hash-${f.suffix}`, name: '줄바꿈 검증 담당', email: `audit-owner-9a0884f0d5e342bba250f44b7388f69a-${f.suffix}@example.test` },
      { id: `states-wrap-domain-${f.suffix}`, name: '긴 도메인 검증 담당', email: `states-wrap-probe-${f.suffix}@extraordinarily-long-subdomain-name-that-forces-overflow-check.example.test` },
    ];
    for (const account of wrapProbeAccounts) {
      await f.helpers.insertAccount(f.harness.database, { id: account.id, role: 'MANAGER', name: account.name, email: account.email });
    }

    browser = await launchBrowser();
    const context = await browser.newContext();
    const setAuth = async (cookie) => {
      await context.clearCookies();
      if (cookie) await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(cookie.slice('etko_session='.length)), url: f.baseUrl }]);
    };
    const owner = await f.helpers.sessionCookie(f.harness, `audit-owner-${f.suffix}`);
    await setAuth(owner);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const act = async (fn) => { interactions += 1; await fn(); };
    const shot = async (name, width) => {
      // Anchor full-page captures at the top: a sticky nav mid-scroll would
      // otherwise bake into the middle of the stitched image.
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(out, `${name}-${width}.png`), fullPage: true });
      const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(size.scrollWidth <= size.width, `${name}/${width} overflow`);
      counts.states += 1;
    };
    const gotoTeam = async () => {
      await page.goto(`${f.baseUrl}/console/team`, { waitUntil: 'networkidle' });
      await page.locator('#team-members').waitFor({ timeout: UI_TIMEOUT });
    };
    // Seeded history exceeds the first activity page (8 rows, max 20
    // loaded): reveal older entries through the real 더 보기 control before
    // asserting their labels. Bounded: at most two expansions cover all 20.
    const expandActivityFor = async (text) => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if ((await page.getByText(text, { exact: false }).count()) > 0) return;
        const more = page.locator('#team-activity-more');
        if ((await more.count()) === 0) return;
        await act(() => more.click());
        await page.waitForTimeout(500);
      }
    };

    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
      await setAuth(owner);

      // --- Team: known labels render Korean, never raw keys. ---
      await gotoTeam();
      for (const [label, raw] of [
        ['추첨 프로그램 설정 저장', 'draw.program.save'],
        ['부스 인증 방식 변경', 'booth.mode'],
        ['참가자 명단 가져오기', 'participant.import'],
      ]) {
        await expandActivityFor(label);
        await act(() => page.getByText(label, { exact: false }).first().waitFor({ timeout: UI_TIMEOUT }));
        counts.labels += 1;
        assert.equal(await page.getByText(raw, { exact: false }).count(), 0, `${raw} must not render raw`);
      }
      // --- Team: unknown key reads as recorded work; raw hides until disclosed. ---
      const unknownRow = page.locator('li', { hasText: '기록된 작업' }).first();
      await act(() => unknownRow.waitFor({ timeout: UI_TIMEOUT }));
      const rawCode = unknownRow.locator('code');
      assert.ok(!(await rawCode.isVisible()), 'raw key hides until the disclosure opens');
      await act(() => unknownRow.locator('summary').click());
      await act(() => rawCode.waitFor({ state: 'visible', timeout: UI_TIMEOUT }));
      assert.match(await rawCode.textContent(), /fixture\.shadow-check/);
      counts.labels += 1;
      await shot('states-team-labels', width);

      // --- Team: contact wrap invariants via per-character line rects. ---
      // Owner plus the long-hash probe must wrap only at safe points with
      // @domain on one line; the overlong-domain probe must never overflow.
      async function wrapReport(needle) {
        return page.evaluate((target) => {
          const el = [...document.querySelectorAll('[class*=memberContact]')]
            .find((node) => node.textContent.includes(target));
          if (!el) return { found: false };
          const containerWidth = el.getBoundingClientRect().width;
          const flat = [];
          const range = document.createRange();
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          let node = walker.nextNode();
          while (node) {
            for (let offset = 0; offset < node.length; offset += 1) {
              range.setStart(node, offset);
              range.setEnd(node, offset + 1);
              const rect = range.getClientRects()[0];
              flat.push({ ch: node.data[offset], top: rect ? Math.round(rect.top) : null });
            }
            node = walker.nextNode();
          }
          const lines = [];
          for (const item of flat) {
            const last = lines[lines.length - 1];
            if (!last || last.top !== item.top) lines.push({ top: item.top, chars: '' });
            lines[lines.length - 1].chars += item.ch;
          }
          // A normal address may wrap AFTER a local-part delimiter or BEFORE
          // its atomic @domain. Do not mistake the latter for a mid-token
          // split, and do not use estimated character widths as an escape.
          const violations = lines.slice(0, -1).filter((line, index) =>
            !/[-_]$/.test(line.chars) && !lines[index + 1].chars.startsWith('@')
          ).map((line) => line.chars);
          const full = flat.map((item) => item.ch).join('');
          const domainStart = full.lastIndexOf('@');
          const domainTops = new Set(flat.slice(domainStart < 0 ? 0 : domainStart).map((item) => item.top));
          return {
            found: true,
            containerWidth,
            lines: lines.map((line) => line.chars),
            violations,
            domainAtomic: domainStart >= 0 ? domainTops.size === 1 : null,
            overflow: el.scrollWidth > el.clientWidth + 1,
          };
        }, needle);
      }
      for (const needle of [`audit-owner-${f.suffix}`, '9a0884f0d5e342bba250f44b7388f69a']) {
        const wrap = await wrapReport(needle);
        assert.ok(wrap.found, `${needle}: contact row present for wrap measurement`);
        assert.deepEqual(wrap.violations, [], `${needle}: wraps only at safe points: ${JSON.stringify(wrap.lines)}`);
        assert.equal(wrap.domainAtomic, true, `${needle}: @domain stays on one line`);
        contactWraps.push({ width, ...wrap });
        counts.wraps += 1;
      }
      const domainWrap = await wrapReport('extraordinarily-long-subdomain');
      assert.ok(domainWrap.found, 'overlong-domain contact row present');
      assert.equal(domainWrap.overflow, false, 'overlong domain wraps without overflowing');
      contactWraps.push({ width, overlongDomain: true, ...domainWrap });
      counts.wraps += 1;

      // --- Photos: empty on first sight, then a real synthetic PNG persists. ---
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/photos`, { waitUntil: 'networkidle' });
      await page.locator('#evidence-photo-archive').waitFor({ timeout: UI_TIMEOUT });
      const photoInput = page.locator('#evidence-photo-files');
      if ((await page.getByText('이 구간에는 아직 등록된 사진이 없습니다.', { exact: true }).count()) > 0) {
        counts.states += 1;
        await shot('states-photos-empty', width);
        await act(() => photoInput.setInputFiles({ name: '현장-공간.png', mimeType: 'image/png', buffer: Buffer.from(TINY_PNG_BASE64, 'base64') }));
        await act(() => page.getByRole('button', { name: /선택한 사진 올리기 \(1장\)/ }).click());
        await act(() => page.getByText(/사진을 등록했습니다\./).waitFor({ timeout: UI_TIMEOUT }));
        const storedPhotos = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.evidencePhotos;
        assert.equal(storedPhotos.length, 1, 'uploaded photo persists in the fixture workspace');
        assert.equal(storedPhotos[0].section, 'SPACE');
        counts.states += 1;
        await shot('states-photos-uploaded', width);
      } else {
        // An earlier pass already uploaded: the archive persists instead.
        await act(() => page.locator('ul[class*=photoGrid] li').first().waitFor({ timeout: UI_TIMEOUT }));
        const storedPhotos = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.evidencePhotos;
        assert.ok(storedPhotos.length >= 1, 'uploaded photo persists across widths');
        counts.states += 1;
        await shot('states-photos-persisted', width);
      }
      // Upload guidance width for before/after comparison with the baseline
      // worker: full explanation width is the proportion fix being measured.
      const guidance = await page.evaluate(() => {
        const g = document.getElementById('evidence-photo-file-guidance');
        const area = g ? g.closest('section') : null;
        if (!g || !area) return null;
        return {
          width: Math.round(g.getBoundingClientRect().width),
          areaWidth: Math.round(area.getBoundingClientRect().width),
        };
      });
      assert.ok(guidance, 'upload guidance measurable for before/after');
      photoGuidance[width] = guidance;
      // --- Photos: invalid format is rejected as a problem state. ---
      await act(() => photoInput.setInputFiles({ name: '메모.txt', mimeType: 'text/plain', buffer: Buffer.from('not an image') }));
      await act(() => page.getByText('PNG, JPEG, WebP 이미지만 올릴 수 있습니다.', { exact: true }).waitFor({ timeout: UI_TIMEOUT }));
      counts.states += 1;
      await shot('states-photos-invalid', width);

      // --- Import: invalid csv errors; valid csv previews aligned, uncommitted. ---
      const participantsBefore = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.participants.length;
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants/import`, { waitUntil: 'networkidle' });
      await page.locator('input[type="file"]').waitFor({ timeout: UI_TIMEOUT });
      const importInput = page.locator('input[type="file"]');
      await act(() => importInput.setInputFiles({ name: '깨진.csv', mimeType: 'text/csv', buffer: Buffer.from('"이름,연락처\n닫히지 않은 따옴표') }));
      await act(() => page.getByText('따옴표가 닫히지 않은 CSV입니다.', { exact: true }).waitFor({ timeout: UI_TIMEOUT }));
      counts.states += 1;
      await shot('states-import-invalid', width);
      await act(() => importInput.setInputFiles({ name: '추가명단.csv', mimeType: 'text/csv', buffer: Buffer.from('이름,연락처\n추가 검증,01000009999\n') }));
      await act(() => page.getByText(/유효 1행 · 오류 0행/).waitFor({ timeout: UI_TIMEOUT }));
      if (width === 1280) {
        const fileBox = await importInput.boundingBox();
        const templateBox = await page.getByRole('button', { name: '양식 CSV', exact: true }).boundingBox();
        assert.ok(fileBox && templateBox, 'file row boxes measurable');
        assert.ok(fileBox.x + fileBox.width <= templateBox.x + 1, 'file picker aligns left of the template action');
        importFileInput1280 = fileBox;
      }
      const participantsAfter = (await f.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload.participants.length;
      assert.equal(participantsAfter, participantsBefore, 'preview must not commit on its own');
      counts.states += 1;
      await shot('states-import-preview', width);

      // --- Operations: explicit state badges with tones; 44px targets. ---
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/operations`, { waitUntil: 'networkidle' });
      await page.locator('#ops-desks').waitFor({ timeout: UI_TIMEOUT });
      for (const [text, tone] of [['가동 중', 'good'], ['중지됨', 'muted'], ['대기', 'wait'], ['진행', 'good'], ['종료', 'muted']]) {
        const badge = page.locator('section span[data-tone]').filter({ hasText: text }).first();
        await act(() => badge.waitFor({ timeout: UI_TIMEOUT }));
        assert.equal(await badge.getAttribute('data-tone'), tone, `${text} carries tone ${tone}`);
        counts.badges += 1;
      }
      const smallTargets = await page.locator('#ops-desks, #ops-booths, #ops-staff').evaluateAll((roots) => {
        const bad = [];
        for (const root of roots) {
          const section = root.closest('section') || root;
          for (const el of section.querySelectorAll('button, a, select, input, summary')) {
            // Screen-reader-only file inputs and fully hidden nodes are not
            // touch targets; only rendered controls keep the 44px floor.
            if (el.classList.contains('sr-only') || el.getAttribute('aria-hidden') === 'true') continue;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) continue;
            if (rect.height < 44) bad.push(`${el.tagName}.${el.className} ${Math.round(rect.height)}px`);
          }
        }
        return bad;
      });
      assert.deepEqual(smallTargets, [], `operations targets keep 44px: ${smallTargets.join('; ')}`);
      counts.targets += 1;
      await shot('states-ops-badges', width);
    }

    // --- Team: bootstrap failure degrades to retry, then recovers. ---
    await page.setViewportSize({ width: 1280, height: 900 });
    await setAuth(owner);
    let abortedOnce = false;
    await page.route('**/api/bootstrap', (route) => {
      if (!abortedOnce) { abortedOnce = true; route.abort(); } else route.continue();
    });
    await page.goto(`${f.baseUrl}/console/team`, { waitUntil: 'networkidle' });
    await act(() => page.getByRole('button', { name: '다시 불러오기', exact: true }).waitFor({ timeout: UI_TIMEOUT }));
    counts.states += 1;
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: path.join(out, 'states-team-retry-1280.png'), fullPage: true });
    await page.unrouteAll({ behavior: 'wait' });
    await act(() => page.getByRole('button', { name: '다시 불러오기', exact: true }).click());
    await act(() => page.locator('#team-members').waitFor({ timeout: UI_TIMEOUT }));
    counts.states += 1;

    assert.deepEqual(errors, []);
    // Local script bound only: product usability caps are untouched and unraised.
    assert.ok(interactions <= 80, `interaction bound exceeded: ${interactions}`);
    fs.writeFileSync(path.join(out, 'states-verification.json'), JSON.stringify({
      at: new Date().toISOString(),
      buildId: fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim(),
      roles: ['AGENCY'],
      simulation: 'Chromium and task-local PostgreSQL/API; synthetic PNG, no real sending/devices',
      counts,
      interactions,
      capsRaised: false,
      photoGuidance,
      contactWraps,
      importFileInput1280,
      errors,
    }, null, 2));
    console.log(`[task-first-final-states] labels=${counts.labels} badges=${counts.badges} targets=${counts.targets} wraps=${counts.wraps} states=${counts.states} interactions=${interactions}`);
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
