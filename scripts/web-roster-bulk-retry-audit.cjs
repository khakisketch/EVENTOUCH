'use strict';
const { ensureRunTmpDir, defaultCaptureDir, runStamp } = require('./capture-dir.cjs');

// A real browser, isolated DB and committed-response loss exercise the bulk
// approval recovery path. No deployed app, production data or messages.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { startAuditFixture } = require('./audit-fixture.cjs');
const { launchBrowser } = require('./audit-browser.cjs');

async function runScenario(mode) {
  const fixture = await startAuditFixture({ loseFirstResponseFor: mode === 'lost' ? 'participant.status' : null });
  let browser;
  try {
    const { helpers, harness, eventId, manager, gateway } = fixture;
    const bootstrap = async () => {
      const result = await helpers.requestJson(harness.baseUrl, '/api/bootstrap', { cookie: manager.cookie });
      assert.equal(result.status, 200);
      return result.json.state.workspaces[eventId].participants;
    };
    const people = (await bootstrap()).slice(0, 3);
    assert.equal(people.length, 3);
    const seeded = await helpers.requestJson(harness.baseUrl, `/api/events/${eventId}/commands`, {
      method: 'POST', cookie: manager.cookie,
      body: { commandId: crypto.randomUUID(), command: 'participant.status', payload: { ids: people.map(person => person.id), status: 'PENDING' } },
    });
    assert.equal(seeded.status, 200);

    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.addCookies([{ name: 'etko_session', value: decodeURIComponent(manager.cookie.slice('etko_session='.length)), domain: '127.0.0.1', path: '/' }]);
    const page = await context.newPage();
    const attempts = [];
    page.on('request', request => {
      if (request.method() !== 'POST' || !request.url().endsWith('/commands')) return;
      const body = request.postDataJSON();
      if (body?.command === 'participant.status') attempts.push(body);
    });
    if (mode === 'malformed') {
      let injected = false;
      await page.route('**/commands', async route => {
        const body = route.request().postDataJSON();
        if (!injected && body?.command === 'participant.status') {
          injected = true;
          const actual = await route.fetch();
          assert.equal(actual.status(), 200, 'the API committed before the synthetic malformed response');
          await route.fulfill({ response: actual, status: 200, json: { participants: [] } });
        } else {
          await route.continue();
        }
      });
    }
    await page.goto(`${fixture.baseUrl}/console/events/${eventId}/participants`);
    const checkbox = person => page.getByRole('checkbox', { name: `${person.name} 선택`, exact: true });
    await checkbox(people[0]).check();
    await checkbox(people[1]).check();
    await page.locator('#roster-approve-selected').click();
    if (mode === 'lost') await gateway.waitForResponseLoss('participant.status');
    await page.getByText(mode === 'lost' ? '연결하지 못했습니다.' : '응답을 확인하지 못했습니다.', { exact: false }).first().waitFor();
    const committed = await bootstrap();
    assert.equal(committed.find(person => person.id === people[0].id).status, 'APPROVED');
    assert.equal(committed.find(person => person.id === people[1].id).status, 'APPROVED');

    if (mode === 'lost') {
      // Leaving discards the in-memory receipt. The guard must ask first and
      // respect a cancellation so the original retry remains accessible.
      let guardSeen = false;
      page.once('dialog', async dialog => { guardSeen = true; await dialog.dismiss(); });
      await page.getByRole('link', { name: '메시지', exact: true }).click();
      assert.equal(guardSeen, true, 'unconfirmed approval warns before leaving');
      assert.ok(page.url().includes('/participants'), 'cancel keeps the operator on the recovery screen');
    }

    // Changed selection must not alter the unconfirmed original request.
    await checkbox(people[0]).uncheck();
    await checkbox(people[2]).check();
    const retry = page.getByRole('button', { name: '같은 요청으로 다시 시도', exact: true });
    assert.equal(await retry.count(), 1, 'ambiguous bulk approval exposes its own exact-request retry');
    await retry.click();
    await page.getByText('2명을 승인했습니다.', { exact: false }).first().waitFor();
    assert.equal(attempts.length, 2);
    assert.deepEqual(attempts[1], attempts[0], 'retry replays original commandId and original target payload');
    const after = await bootstrap();
    assert.equal(after.find(person => person.id === people[2].id).status, 'PENDING', 'later selection was not approved by the old retry');
    assert.equal(await checkbox(people[2]).isChecked(), true, 'a new selection survives settling the old request');
    await context.close();
    process.stdout.write(`Bulk approval ${mode} response retry: passed\n`);
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}

async function main() {
  process.env.TMPDIR = ensureRunTmpDir(defaultCaptureDir(`roster-retry-run-${runStamp()}`));
  await runScenario('lost');
  await runScenario('malformed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
