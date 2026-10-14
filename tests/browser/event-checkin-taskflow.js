// Checkin task-flow verification (actual fixture; no successful writes — only a rejected bogus ticket).
// playwright-cli -s=eventouch-joint run-code --filename=tests/browser/event-checkin-taskflow.js
async page => {
  const baseUrl = 'http://100.116.163.1:46771';
  const root = '/tmp/opencode/eventouch-captures/event-checkin';
  const failures = [];
  const check = (condition, message) => { if (!condition) failures.push(message); };
  const capture = name => page.screenshot({ path: `${root}/${name}.png`, scale: 'css', type: 'png' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${baseUrl}/?__event_checkin_verify=1#/console/events/map-event/checkin`);
  await page.waitForFunction(() => document.querySelector('.admin-shell') || document.querySelector('#dev-quick-login'));
  if (!await page.locator('.admin-shell').count()) await page.getByRole('button', { name: '빠른 로그인' }).click();
  await page.waitForFunction(() => location.hash.includes('/checkin') && window.ET);
  await page.reload();
  await page.waitForFunction(() => location.hash.includes('/checkin') && window.ET);
  await page.waitForSelector('.checkin-page');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);
  const baselineChecks = await page.evaluate(() => window.ET.work().checks.length);

  // 1. Scan work must start in the first screen: camera CTA + code + name search visible.
  const first = await page.evaluate(() => {
    const q = s => document.querySelector(s);
    const b = n => { if (!n) return null; const r = n.getBoundingClientRect(); return { y: Math.round(r.y), bottom: Math.round(r.bottom), h: Math.round(r.height) }; };
    const scanBtns = [...document.querySelectorAll('.checkin-page button, .checkin-page [type="submit"]')].map(n => n.innerText.trim());
    return {
      viewport: innerHeight,
      camera: b([...document.querySelectorAll('.checkin-page button')].find(n => /QR 스캔|스캔/.test(n.innerText))),
      codeInput: b(q('.checkin-page input[name="ticket"]')),
      nameInput: b(q('#desk-search')),
      deskSelect: b(q('.checkin-page select[name="desk"]')),
      deskLabel: q('.checkin-page .field-scan-panel label')?.innerText || '',
      registerBtns: [...document.querySelectorAll('.checkin-page [data-action="new-person"]')].map(n => ({ text: n.innerText.trim(), cls: n.className, box: b(n) })),
      tabs: [...document.querySelectorAll('.checkin-page .tabs a')].map(n => n.innerText.trim()),
      scanBtns,
    };
  });
  check(first.camera && first.camera.bottom <= first.viewport, `Camera scan CTA must sit in the first screen (bottom=${first.camera?.bottom}).`);
  check(first.camera && first.camera.h >= 44, 'Camera scan CTA must be a large unmistakable target.');
  check(first.codeInput && first.codeInput.y < first.viewport, 'Ticket-code fallback must be reachable without deep scroll.');
  check(first.nameInput && first.nameInput.y >= 0 && first.nameInput.bottom <= first.viewport, `Name-search fallback must be fully visible in the first screen (y=${first.nameInput?.y}, bottom=${first.nameInput?.bottom}, viewport=${first.viewport}).`);
  check(/모드|입장|퇴장|데스크/.test(first.deskLabel), `Desk select must state mode and direction (got "${first.deskLabel}").`);
  check(first.registerBtns.length === 1 && !/primary/.test(first.registerBtns[0].cls), `현장 등록 must be a single separated quiet action (got ${JSON.stringify(first.registerBtns.map(r=>r.cls))}).`);
  check(first.registerBtns[0] && first.registerBtns[0].box.y > (first.camera?.bottom || 0), '현장 등록 must sit below the scan work, never above it.');
  check(first.tabs.length >= 3, `Onsite tabs must stay intact (got ${first.tabs.join('/')}).`);
  await capture('after-390-top');

  // 2. Taps to scan readiness: zero — the CTA is already on screen.
  check(first.camera && first.camera.y >= 0, 'Scan readiness must require zero taps after entry.');

  // 3. Rejected bogus ticket must surface failure feedback with a next action (no data change).
  await page.locator('.checkin-page input[name="ticket"]').fill('WRONG-CODE-0000');
  await page.locator('.checkin-page').evaluate(node => {
    const form = node.querySelector('form[data-form="desk-scan"]');
    form?.requestSubmit(form.querySelector('[type="submit"]'));
  });
  await page.waitForSelector('.field-scan-result-region .status-block', { timeout: 15000 }).catch(() => null);
  const feedback = await page.evaluate(() => ({
    present: !!document.querySelector('.field-scan-result-region .status-block'),
    failure: !!document.querySelector('.field-scan-result-region .status-block.failure'),
    text: document.querySelector('.field-scan-result-region .status-block')?.innerText.slice(0, 120) || '',
    nextAction: [...document.querySelectorAll('.field-scan-result-region button')].map(n => n.innerText.trim()),
  }));
  check(feedback.present && feedback.failure, `Bogus ticket must render failure feedback (got "${feedback.text}").`);
  check(feedback.nextAction.length > 0, 'Failure feedback must offer a next action.');
  await capture('after-390-feedback');
  // Test-only cleanup: the rejected submit leaves the draft-dirty flag that arms beforeunload.
  await page.evaluate(() => { document.querySelectorAll('.checkin-page form[data-dirty="true"]').forEach(f => { f.dataset.dirty = 'false'; }); });

  // 4. No successful write may have occurred: record count must be unchanged.
  const counts = await page.evaluate(() => ({ checks: window.ET.work().checks.length }));
  check(counts.checks === baselineChecks, `Record count must be unchanged by the rejected ticket (was ${baselineChecks}, got ${counts.checks}).`);
  await page.locator('.field-scan-result-region button').first().click().catch(() => {});
  await page.waitForTimeout(200);

  // 5. Small targets + no overflow at key widths.
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: width >= 1024 ? 900 : 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(150);
    const layout = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      small: [...document.querySelectorAll('.checkin-page button, .checkin-page a[href], .checkin-page input, .checkin-page select, .checkin-page summary')].filter(el => { const r = el.getBoundingClientRect(); return (r.width < 44 || r.height < 44) && r.width > 0 && r.height > 0; }).length,
    }));
    check(layout.scrollWidth <= width + 1, `${width}px checkin must not overflow (scrollWidth=${layout.scrollWidth}).`);
    check(layout.small === 0, `${width}px checkin controls must stay usable (small=${layout.small}).`);
    if (width === 320) await capture('after-320');
    if (width === 1280) await capture('after-1280');
  }

  if (failures.length) throw new Error(`Checkin task-flow failures:\n- ${failures.join('\n- ')}`);
  return { result: 'pass', viewports: [320, 390, 768, 1280], checks: failures.length };
}
