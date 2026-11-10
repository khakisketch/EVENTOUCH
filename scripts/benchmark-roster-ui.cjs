'use strict';
// Bounded synthetic browser sample, not an operational SLO or a load test.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
function summary(samples) {
  const values = [...samples].sort((a, b) => a - b);
  return { samples: values.length, medianMs: Number(values[Math.floor(values.length / 2)].toFixed(1)), maxMs: Number(values.at(-1).toFixed(1)) };
}
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'roster-performance');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const { database } = fixture.harness;
    const workspace = (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const template = workspace.participants.find((person) => person.status === 'APPROVED');
    assert.ok(template);
    workspace.participants = Array.from({ length: 2500 }, (_, index) => ({
      ...template, id: `perf-person-${index}`, name: `합성 참가자 ${String(index).padStart(5, '0')}`,
      phone: `010${String(10000000 + index)}`, email: `person-${index}@example.invalid`,
      ticket: `perf-ticket-${index}`,
    }));
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const page = await context.newPage();
    const loads = [];
    for (let sample = 0; sample < 6; sample += 1) {
      const start = performance.now();
      await page.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`, { waitUntil: 'domcontentloaded' });
      await page.locator('.participant-count').filter({ hasText: '전체 2500명' }).first().waitFor();
      await page.getByText('합성 참가자 00000', { exact: true }).first().waitFor();
      if (sample) loads.push(performance.now() - start);
    }
    const filters = [];
    for (let sample = 0; sample < 6; sample += 1) {
      const target = `합성 참가자 ${String(2490 + sample).padStart(5, '0')}`;
      const start = performance.now();
      await page.locator('#roster-search').fill(target);
      await page.getByText(target, { exact: true }).first().waitFor();
      assert.match(await page.locator('.participant-count').innerText(), /1명 \/ 전체 2500명/);
      if (sample) filters.push(performance.now() - start);
    }
    const result = { synthetic: true, participants: 2500, viewport: '1280x900', warmups: 1,
      pageToVisible: summary(loads), fillToFilteredRow: summary(filters), includesBrowserAndApi: true };
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(result));
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
