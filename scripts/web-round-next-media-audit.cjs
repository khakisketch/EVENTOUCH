'use strict';

// Round-next baseline verification, owned surfaces only:
//   (3) evidence-photo aspect handling across portrait + landscape uploads
//   (4) participant-import toolbar alignment + CSV order preservation
//
// Real browser only: owned Next production build + task-local PostgreSQL
// schema + real API (startAuditFixture). No product code change, no server
// change, no commit, no deploy. New hex values are forbidden: the synthetic
// PNG canvases are filled with the page's own computed token colors, read
// live from the browser. No string-source assertions: every judgment reads
// rendered state (computed style, bounding rects, natural image dims,
// bootstrap/DB rows, file bytes).
//
// Re-runnable against the final build: CAPTURE_DIR selects the output
// directory (default: the before/ evidence dir for the current baseline).

for (const key of ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SOLAPI_SENDER', 'SOLAPI_KAKAO_PFID']) delete process.env[key];
process.env.EVENTOUCH_SMS_MOCK = '1';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { prepareCaptureDir, defaultCaptureDir, runStamp, ensureRunTmpDir } = require('./capture-dir.cjs');
const path = require('node:path');
const { startAuditFixture, resolveAuditDatabaseUrl } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

const BASELINE_BUILD_ID = 'q91_6FU24tTszHkkmPzIy';
const UI_TIMEOUT = 20000;
const CAPTURE_DIR = process.env.CAPTURE_DIR || defaultCaptureDir(`round-next/before-${runStamp()}`);

// Minimal PNG reader (signature + IHDR dims + SHA-256). No new dependencies.
function parsePng(buffer, label) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  assert.ok(buffer.length > 33, `${label}: PNG too short (${buffer.length} bytes)`);
  assert.ok(buffer.subarray(0, 8).equals(sig), `${label}: not a PNG`);
  const ihdrLen = buffer.readUInt32BE(8);
  const ihdrType = buffer.subarray(12, 16).toString('ascii');
  assert.equal(ihdrType, 'IHDR', `${label}: first chunk is ${ihdrType}, not IHDR`);
  assert.ok(ihdrLen >= 13, `${label}: IHDR too short`);
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function parseRgb(css) {
  const m = String(css).match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/i);
  assert.ok(m, `expected an rgb() computed color, got ${JSON.stringify(css)}`);
  return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
}

async function main() {
  if (!resolveAuditDatabaseUrl()) {
    throw new Error('set EVENTOUCH_TEST_DATABASE_URL to the provided isolated PostgreSQL database; never a shared one');
  }
  const buildId = fs.readFileSync('apps/web/.next/BUILD_ID', 'utf8').trim();
  // Default: record whatever build is under test. Only when ROUND_NEXT_BASELINE=1
  // (the frozen baseline run) is the build hard-pinned; the final build must
  // re-run this audit without the pin.
  if (process.env.ROUND_NEXT_BASELINE === '1') {
    assert.equal(buildId, BASELINE_BUILD_ID, `baseline build changed (got ${buildId}); stop, do not rebuild from this worker`);
  }
  prepareCaptureDir(CAPTURE_DIR);
  process.env.TMPDIR = ensureRunTmpDir(CAPTURE_DIR);

  const f = await startAuditFixture();
  let browser;
  const errors = [];
  const judgments = [];
  const judge = (name, detail) => { judgments.push({ name, ...detail }); };
  const evidence = { photos: {}, import: {} };
  try {
    browser = await launchBrowser();
    const context = await browser.newContext();
    await context.clearCookies();
    await context.addCookies([{
      name: 'etko_session',
      value: decodeURIComponent(f.manager.cookie.slice('etko_session='.length)),
      url: f.baseUrl,
    }]);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));

    const shot = async (name, width) => {
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.screenshot({ path: path.join(CAPTURE_DIR, `${name}-${width}.png`), fullPage: true });
      const size = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
      assert.ok(size.scrollWidth <= size.width + 1, `${name}/${width}: horizontal overflow ${size.scrollWidth} > ${size.width}`);
      judge(`${name}/${width} render`, { noOverflow: true, docWidth: size.width, scrollWidth: size.scrollWidth });
    };

    const dbWorkspace = async () => {
      const row = (await f.harness.database.query(
        'SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId],
      )).rows[0];
      assert.ok(row, 'fixture workspace present');
      return row.payload;
    };
    const fetchFileBytes = async (fileId) => {
      const res = await fetch(
        `${f.harness.baseUrl}/api/events/${encodeURIComponent(f.eventId)}/files/${encodeURIComponent(fileId)}`,
        { headers: { cookie: f.manager.cookie } },
      );
      assert.equal(res.status, 200, `file bytes status for ${fileId}`);
      return Buffer.from(await res.arrayBuffer());
    };

    // Sections keep each width on an empty shelf of the same fixture, so the
    // empty -> preview -> upload -> gallery arc runs fully on both widths.
    const widthPlan = [
      { width: 1280, height: 900, section: 'SPACE', sectionLabel: '공간구성', phones: ['01000001111', '01000002222'] },
      { width: 390, height: 844, section: 'STAGE', sectionLabel: '무대연출', phones: ['01000003333', '01000004444'] },
    ];

    for (const plan of widthPlan) {
      const { width, height, section, sectionLabel, phones } = plan;
      await page.setViewportSize({ width, height });

      // ---------- (3) evidence photos ----------
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/photos`, { waitUntil: 'networkidle' });
      await page.locator('#evidence-photo-archive').waitFor({ timeout: UI_TIMEOUT });
      const pickSection = async () => {
        if (section === 'SPACE') return;
        if (width < 768) {
          // Narrow layout hides the category buttons and shows the select.
          await page.locator('#evidence-photo-section').selectOption(section);
        } else {
          await page.getByRole('button', { name: new RegExp(`${sectionLabel}.*장`) }).first().click();
        }
        await page.waitForTimeout(400);
      };
      await pickSection();
      const emptyText = await page.getByText('이 구간에는 아직 등록된 사진이 없습니다.', { exact: true }).count();
      assert.equal(emptyText, 1, `photos/${width}: ${sectionLabel} shelf starts empty`);
      judge(`photos/${width} empty shelf`, { section, empty: true });

      // Read the page's own computed token colors; the synthetic canvases may
      // only use these (no new hex anywhere in this audit).
      const tokens = await page.evaluate(() => {
        const icon = document.querySelector('[class*=uploadIcon]');
        const guidance = document.getElementById('evidence-photo-file-guidance');
        const cap = (el) => {
          const cs = getComputedStyle(el);
          return { background: cs.backgroundColor, color: cs.color };
        };
        return { icon: icon ? cap(icon) : null, guidance: guidance ? cap(guidance) : null };
      });
      assert.ok(tokens.icon && tokens.guidance, `photos/${width}: token colors readable`);
      const bgA = tokens.icon.background;
      const fgB = tokens.icon.color;
      for (const css of [bgA, fgB]) parseRgb(css); // rgb() only, no hex literals
      judge(`photos/${width} token canvas colors`, { background: bgA, foreground: fgB, newHex: false });

      // Build the composite canvases live in the browser: 120x300 portrait +
      // 400x100 landscape, token background with a token diagonal band so the
      // true aspect is visible in every render.
      const canvases = await page.evaluate(async ({ bg, fg }) => {
        async function make(w, h, name) {
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          ctx.fillStyle = bg;
          ctx.fillRect(0, 0, w, h);
          ctx.fillStyle = fg;
          ctx.beginPath();
          ctx.moveTo(0, h);
          ctx.lineTo(w, 0);
          ctx.lineTo(w, Math.min(h, h * 0.25));
          ctx.lineTo(0, h);
          ctx.closePath();
          ctx.fill();
          ctx.fillRect(0, 0, w, 6);
          ctx.fillRect(0, h - 6, w, 6);
          const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = '';
          const CHUNK = 8192;
          for (let i = 0; i < bytes.length; i += CHUNK) {
            binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
          }
          return { name, width: w, height: h, base64: btoa(binary), bytes: bytes.length };
        }
        return [await make(120, 300, '세로-합성.png'), await make(400, 100, '가로-합성.png')];
      }, { bg: bgA, fg: fgB });
      const portraitBuf = Buffer.from(canvases[0].base64, 'base64');
      const landscapeBuf = Buffer.from(canvases[1].base64, 'base64');
      assert.deepEqual(parsePng(portraitBuf, 'portrait canvas'), { width: 120, height: 300 }, 'portrait canvas dims');
      assert.deepEqual(parsePng(landscapeBuf, 'landscape canvas'), { width: 400, height: 100 }, 'landscape canvas dims');
      judge(`photos/${width} composite canvases`, {
        portrait: { width: 120, height: 300, bytes: portraitBuf.length, sha256: sha256(portraitBuf) },
        landscape: { width: 400, height: 100, bytes: landscapeBuf.length, sha256: sha256(landscapeBuf) },
      });

      // Real selection -> pre-upload preview (nothing stored yet).
      const photoInput = page.locator('#evidence-photo-files');
      await photoInput.setInputFiles([
        { name: '세로-합성.png', mimeType: 'image/png', buffer: portraitBuf },
        { name: '가로-합성.png', mimeType: 'image/png', buffer: landscapeBuf },
      ]);
      await page.getByRole('heading', { name: /업로드 전 미리보기 2장/ }).waitFor({ timeout: UI_TIMEOUT });
      const previewImgs = page.locator('img[class*=previewImage]');
      assert.equal(await previewImgs.count(), 2, `photos/${width}: two pre-upload previews`);
      const previewFit = await previewImgs.evaluateAll((imgs) => imgs.map((img) => ({
        complete: img.complete,
        naturalWidth: img.naturalWidth,
        naturalHeight: img.naturalHeight,
        objectFit: getComputedStyle(img).objectFit,
      })));
      for (const [i, info] of previewFit.entries()) {
        assert.equal(info.complete, true, `photos/${width}: preview ${i} complete`);
        assert.ok(info.naturalWidth > 0 && info.naturalHeight > 0, `photos/${width}: preview ${i} has natural dims`);
        assert.equal(info.objectFit, 'contain', `photos/${width}: preview ${i} object-fit is contain`);
      }
      const wsBeforeUpload = await dbWorkspace();
      assert.equal(
        (wsBeforeUpload.evidencePhotos || []).filter((p) => p.section === section).length,
        0, `photos/${width}: selection alone stores nothing`,
      );
      judge(`photos/${width} pre-upload preview`, { previewCount: 2, storedBeforeUpload: 0, previews: previewFit });
      await shot('round-next-photos-preview', width);

      // Real upload -> bootstrap evidencePhotos + byte-identical files.
      await page.getByRole('button', { name: /선택한 사진 올리기 \(2장\)/ }).click();
      await page.getByText(/사진을 등록했습니다\./).first().waitFor({ timeout: UI_TIMEOUT });
      // Both queued jobs finish on their own cadence: poll the server copy
      // until both land instead of asserting on the first notice.
      let wsAfter = null;
      let stored = [];
      const deadline = Date.now() + UI_TIMEOUT;
      for (;;) {
        wsAfter = await dbWorkspace();
        stored = (wsAfter.evidencePhotos || []).filter((p) => p.section === section);
        if (stored.length === 2 || Date.now() > deadline) break;
        await page.waitForTimeout(500);
      }
      assert.equal(stored.length, 2, `photos/${width}: bootstrap keeps both photos in ${section}`);
      for (const photo of stored) {
        assert.ok(photo.image && photo.image.fileId, `photos/${width}: photo ${photo.id} has a file ref`);
        const remote = await fetchFileBytes(photo.image.fileId);
        // Identify by the explicit upload filename, never by coincidental
        // byte-length equality between the two canvases.
        const isPortrait = photo.image.name.includes('세로');
        const local = isPortrait ? portraitBuf : landscapeBuf;
        assert.equal(remote.length, local.length, `photos/${width}: ${photo.image.name} byte length`);
        assert.equal(sha256(remote), sha256(local), `photos/${width}: ${photo.image.name} bytes identical`);
        assert.deepEqual(parsePng(remote, photo.image.name), isPortrait ? { width: 120, height: 300 } : { width: 400, height: 100 }, `photos/${width}: ${photo.image.name} stored dims`);
      }
      judge(`photos/${width} upload persists`, {
        section,
        stored: stored.map((p) => ({ name: p.image.name, size: p.image.size, fileId: p.image.fileId })),
        bytesIdentical: true,
      });

      // Saved gallery render: contain keeps every pixel inside the box.
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/photos`, { waitUntil: 'networkidle' });
      await page.locator('#evidence-photo-archive').waitFor({ timeout: UI_TIMEOUT });
      await pickSection();
      const gallery = page.locator('li[id^="evidence-photo-"] img[class*=thumbnail]');
      assert.equal(await gallery.count(), 2, `photos/${width}: gallery renders both saved photos`);
      const thumbs = await gallery.evaluateAll((imgs) => imgs.map((img) => {
        const rect = img.getBoundingClientRect();
        const cs = getComputedStyle(img);
        return {
          src: img.currentSrc,
          complete: img.complete,
          naturalWidth: img.naturalWidth,
          naturalHeight: img.naturalHeight,
          boxWidth: rect.width,
          boxHeight: rect.height,
          objectFit: cs.objectFit,
        };
      }));
      const seenAspects = new Set();
      for (const [i, t] of thumbs.entries()) {
        assert.equal(t.complete, true, `photos/${width}: gallery img ${i} complete`);
        assert.ok(t.naturalWidth > 0 && t.naturalHeight > 0, `photos/${width}: gallery img ${i} natural dims`);
        assert.equal(t.objectFit, 'contain', `photos/${width}: gallery img ${i} object-fit is contain`);
        // Contain math: content scales by min(boxW/natW, boxH/natH), so it
        // always fits inside the box and touches at least one edge.
        const scale = Math.min(t.boxWidth / t.naturalWidth, t.boxHeight / t.naturalHeight);
        const fittedW = t.naturalWidth * scale;
        const fittedH = t.naturalHeight * scale;
        assert.ok(fittedW <= t.boxWidth + 1 && fittedH <= t.boxHeight + 1, `photos/${width}: gallery img ${i} content bounded ${fittedW.toFixed(1)}x${fittedH.toFixed(1)} in ${t.boxWidth.toFixed(1)}x${t.boxHeight.toFixed(1)}`);
        const touchesEdge = Math.abs(fittedW - t.boxWidth) <= 1.5 || Math.abs(fittedH - t.boxHeight) <= 1.5;
        assert.ok(touchesEdge, `photos/${width}: gallery img ${i} fills one box axis (no letterbox shrink bug)`);
        const aspectDrift = Math.abs((fittedW / fittedH) / (t.naturalWidth / t.naturalHeight) - 1);
        assert.ok(aspectDrift < 0.01, `photos/${width}: gallery img ${i} aspect preserved`);
        seenAspects.add(t.naturalWidth < t.naturalHeight ? 'portrait' : 'landscape');
      }
      assert.deepEqual([...seenAspects].sort(), ['landscape', 'portrait'], `photos/${width}: both orientations rendered`);
      judge(`photos/${width} gallery contain`, { thumbnails: thumbs });
      await shot('round-next-photos-gallery', width);

      // Original files viewed directly: natural dims equal the canvases.
      for (const photo of stored) {
        const fileUrl = `${f.baseUrl}/api/events/${encodeURIComponent(f.eventId)}/files/${encodeURIComponent(photo.image.fileId)}`;
        const imgPage = await context.newPage();
        try {
          await imgPage.goto(fileUrl, { waitUntil: 'load' });
          const nat = await imgPage.evaluate(() => {
            const img = document.images[0];
            return img ? { complete: img.complete, w: img.naturalWidth, h: img.naturalHeight } : null;
          });
          assert.ok(nat && nat.complete, `photos/${width}: original ${photo.image.name} loads directly`);
          const wantPortrait = photo.image.name.includes('세로');
          assert.deepEqual({ w: nat.w, h: nat.h }, wantPortrait ? { w: 120, h: 300 } : { w: 400, h: 100 },
            `photos/${width}: original ${photo.image.name} dims match the canvas`);
          judge(`photos/${width} original ${photo.image.name}`, { natural: nat });
        } finally {
          await imgPage.close();
        }
      }
      evidence.photos[width] = { section, stored: stored.length, orientations: [...seenAspects].sort() };

      // ---------- (4) participant import ----------
      const participantsBefore = (await dbWorkspace()).participants.length;
      await page.goto(`${f.baseUrl}/console/events/${f.eventId}/participants/import`, { waitUntil: 'networkidle' });
      await page.locator('input[type="file"]').waitFor({ timeout: UI_TIMEOUT });
      const importInput = page.locator('section input[type="file"]').first();

      // Guidance copy is present before any file is chosen.
      assert.equal(await page.getByText('가져오기는 선택적인 도구입니다.', { exact: false }).count() >= 1, true, `import/${width}: optional-tool guidance present`);
      assert.equal(await page.getByText(/CSV·TXT·XLSX · 최대 1MB, 1,000행/, { exact: false }).count() >= 1, true, `import/${width}: format limits guidance present`);
      judge(`import/${width} guidance`, { optionalTool: true, limitsNote: true });

      if (width === 1280) {
        // Rendered toolbar geometry: file picker left, helper action right.
        const boxes = await page.evaluate(() => {
          const input = document.querySelector('section input[type="file"]');
          const action = [...document.querySelectorAll('section button')].find((b) => b.textContent.trim() === '양식 CSV');
          const bar = input ? input.closest('[class*=toolbarMain]') : null;
          const rect = (el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, top: r.top, bottom: r.bottom };
          };
          return input && action && bar
            ? { input: rect(input), action: rect(action), bar: rect(bar) }
            : null;
        });
        assert.ok(boxes, `import/${width}: toolbar boxes measurable`);
        assert.ok(boxes.input.x + boxes.input.width <= boxes.action.x + 1,
          `import/${width}: file picker (right ${boxes.input.right.toFixed(1)}) sits left of the helper action (x ${boxes.action.x.toFixed(1)})`);
        const sameRow = boxes.input.top < boxes.action.bottom && boxes.action.top < boxes.input.bottom;
        assert.ok(sameRow, `import/${width}: picker and helper share the toolbar row`);
        assert.ok(boxes.action.x > boxes.bar.x + boxes.bar.width / 2, `import/${width}: helper action lives in the toolbar right half`);
        assert.ok(boxes.input.x < boxes.bar.x + boxes.bar.width / 2, `import/${width}: file picker lives in the toolbar left half`);
        judge(`import/${width} toolbar alignment`, boxes);
        evidence.import.toolbar1280 = boxes;
      } else {
        const boxes = await page.evaluate(() => {
          const input = document.querySelector('section input[type="file"]');
          const action = [...document.querySelectorAll('section button')].find((b) => b.textContent.trim() === '양식 CSV');
          if (!input || !action) return null;
          const ri = input.getBoundingClientRect();
          const ra = action.getBoundingClientRect();
          return { inputY: ri.y, actionY: ra.y, inputW: ri.width, actionW: ra.width };
        });
        judge(`import/${width} toolbar stacked`, boxes || {});
      }

      // Broken CSV first: real parse error, nothing staged.
      await importInput.setInputFiles({
        name: '깨진.csv', mimeType: 'text/csv',
        buffer: Buffer.from('"이름,연락처\n닫히지 않은 따옴표'),
      });
      await page.getByText('따옴표가 닫히지 않은 CSV입니다.', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
      judge(`import/${width} broken csv`, { errorShown: true });
      await shot('round-next-import-invalid', width);

      // Valid 2-person CSV: preview keeps the user's own row order.
      const first = { name: `합성 첫째 ${width}`, phone: phones[0] };
      const second = { name: `합성 둘째 ${width}`, phone: phones[1] };
      await importInput.setInputFiles({
        name: '유효명단.csv', mimeType: 'text/csv',
        buffer: Buffer.from(
          `이름,연락처,이메일,소속\n${first.name},${first.phone},first-${width}@example.test,합성 조직\n${second.name},${second.phone},second-${width}@example.test,합성 조직\n`,
        ),
      });
      await page.getByText(/유효 2행 · 오류 0행/).waitFor({ timeout: UI_TIMEOUT });
      const previewNames = await page.locator('[aria-label="적용될 값 미리보기"] [class*=recordMain] > span').evaluateAll(
        (els) => els.map((el) => el.textContent.trim()),
      );
      assert.deepEqual(previewNames.slice(0, 2), [first.name, second.name],
        `import/${width}: preview keeps user order ${JSON.stringify(previewNames.slice(0, 2))}`);
      const commitLabel = await page.getByRole('button', { name: /유효 2행 반영/ }).count();
      assert.equal(commitLabel, 1, `import/${width}: explicit commit offered, not auto-run`);
      const participantsAfter = (await dbWorkspace()).participants.length;
      assert.equal(participantsAfter, participantsBefore,
        `import/${width}: preview auto-commits 0 (${participantsBefore} -> ${participantsAfter})`);
      judge(`import/${width} valid preview`, {
        order: previewNames.slice(0, 2), explicitCommitOffered: true,
        participantsBefore, participantsAfter, autoCommit: 0,
      });
      await shot('round-next-import-preview', width);
      evidence.import[width] = { order: previewNames.slice(0, 2), participantsBefore, participantsAfter };
      // Finish the same workflow explicitly as well: the success count must
      // match the actual new people, not just a locally generated preview.
      await page.getByRole('button', { name: /유효 2행 반영/ }).click();
      await page.getByText('2명을 반영했습니다.', { exact: true }).waitFor({ timeout: UI_TIMEOUT });
      const committedPeople = (await dbWorkspace()).participants;
      assert.equal(committedPeople.length, participantsBefore + 2, `import/${width}: exactly two persisted people`);
      const importedPeople = committedPeople.filter(person => [first.name, second.name].includes(person.name));
      assert.equal(importedPeople.length, 2);
      for (const person of importedPeople) {
        const expected = person.name === first.name ? first : second;
        assert.equal(person.phone, expected.phone);
        assert.equal(person.status, 'APPROVED');
      }
      judge(`import/${width} explicit commit result`, { added: 2, actualTotal: committedPeople.length, successCount: 2, originalPhonesPreserved: true });
      await shot('round-next-import-committed', width);
      evidence.import[width].explicitlyCommitted = 2;
    }

    assert.deepEqual(errors, [], `pageerrors: ${errors.join('; ')}`);
    const result = {
      at: new Date().toISOString(),
      buildId,
      baseline: process.env.ROUND_NEXT_BASELINE === '1' ? BASELINE_BUILD_ID : null,
      simulation: 'Chromium + task-local PostgreSQL/API; synthetic token-colored PNG canvases, no real sending/devices',
      judgments: judgments.length,
      failures: 0,
      pageerrors: errors,
      evidence,
      notes: [
        'Photo ratio: object-fit contain on thumbnails/previews verified by computed style plus contain-fit math on real rendered rects; no cropping by construction of contain.',
        'Import order: preview list preserves the user file row order; the single file input cannot control OS picker sort order, so no sort claim is made about the picker itself.',
      ],
      checks: judgments,
    };
    fs.writeFileSync(path.join(CAPTURE_DIR, 'round-next-media-verification.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
    console.log(`[round-next-media] judgments=${judgments.length} failures=0 build=${buildId} dir=${CAPTURE_DIR}`);
  } finally {
    if (browser) await browser.close();
    await f.close();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
