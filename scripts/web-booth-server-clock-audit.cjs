'use strict';
// Synthetic accounts and a real API; browser clock offsets never change server time.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { source: axe } = require('axe-core');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { typeTicket, closeSheet, readCode, codeField } = require('./audit-staff-direction.cjs');

async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a private capture root');
  const out = prepareCaptureDir(path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'booth-server-clock'));
  process.env.TMPDIR = ensureRunTmpDir(out);
  const f = await startAuditFixture(); let browser;
  try {
    const db = f.harness.database;
    const read = async () => (await db.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [f.eventId])).rows[0].payload;
    let ws = await read();
    const person = ws.participants.find(item => item.status === 'APPROVED' && item.ticket);
    assert.ok(person);
    Object.assign(person, { inside: true, everIn: true, paymentStatus: 'FREE', revoked: false, ticketExpiresAt: new Date(Date.now() + 3 * 86400000).toISOString() });
    const now = Date.now();
    ws.stampMode = 'STAFF'; ws.visits = [];
    ws.booths = [
      { id: 'skew-booth', name: '합성 시각 부스', zone: 'A', status: 'OPEN', startsAt: new Date(now - 3600000).toISOString(), endsAt: new Date(now + 3600000).toISOString(), capacity: 0, limit: 1, used: 0 },
      { id: 'invalid-booth', name: '합성 시간 오류 부스', zone: 'A', status: 'OPEN', startsAt: '2026-11-06T09:00', endsAt: '', capacity: 0, limit: 1, used: 0 },
      { id: 'closed-booth', name: '합성 종료 부스', zone: 'A', status: 'CLOSED', startsAt: '', endsAt: '', capacity: 0, limit: 1, used: 0 },
    ];
    await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(ws)]);
    for (const id of ['skew-booth', 'invalid-booth', 'closed-booth']) await f.helpers.insertAssignment(db, {
      id: `clock-${id}`, accountId: f.staff.id, eventId: f.eventId, type: 'BOOTH', targetId: id,
    });
    const url = `${f.baseUrl}/api/events/${f.eventId}/commands`;
    const manager = await fetch(url, { method: 'POST', headers: { cookie: f.manager.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ commandId: crypto.randomUUID(), command: 'event.features', payload: { features: ['stamp'] } }) });
    assert.equal(manager.status, 200);
    const reset = async mode => {
      const current = await read(); current.stampMode = mode; current.visits = []; current.booths[0].used = 0;
      await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(current)]);
    };
    browser = await launchBrowser();
    const cases = [
      { role: 'staff', offset: 86400000, serverTime: 'valid' },
      { role: 'staff', offset: -86400000, serverTime: 'missing' },
      { role: 'guest', offset: -86400000, serverTime: 'valid' },
      { role: 'guest', offset: 86400000, serverTime: 'invalid' },
    ];
    for (const scenario of cases) {
      await reset(scenario.role === 'staff' ? 'STAFF' : 'SELF');
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
      if (scenario.role === 'staff') await context.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
      await context.addInitScript(({ offset, slug, ticket }) => {
        const original = Date.now; window.__clockOffset = offset; Date.now = () => original() + window.__clockOffset;
        if (ticket) sessionStorage.setItem(`eventouch.ticket.${slug}`, ticket);
      }, { offset: scenario.offset, slug: f.slug, ticket: scenario.role === 'guest' ? person.ticket : '' });
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      if (scenario.serverTime !== 'valid') {
        const pattern = scenario.role === 'staff' ? '**/api/bootstrap' : '**/api/public/events/*/ticket';
        await page.route(pattern, async route => {
          const response = await route.fetch();
          if (!response.ok()) return route.fulfill({ response });
          const json = await response.json();
          if (scenario.serverTime === 'missing') delete json.serverTimeMs;
          else json.serverTimeMs = 'invalid';
          return route.fulfill({ response, json });
        });
      }
      const expected = scenario.serverTime === 'valid' ? '운영 중' : '인증 시 시간 확인';
      let mask;
      if (scenario.role === 'staff') {
        await page.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
        await page.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
        const select = page.locator('#staff-booth'), option = select.locator('option[value="skew-booth"]');
        await option.waitFor({ state: 'attached' });
        await page.waitForFunction(({ expected }) => {
          const option = document.querySelector('#staff-booth option[value="skew-booth"]');
          return option && !option.disabled && (expected === '운영 중' ? !option.textContent.includes('인증 시 시간 확인') : option.textContent.includes(expected));
        }, { expected });
        assert.equal(await select.locator('option[value="invalid-booth"]').isDisabled(), true);
        assert.equal(await select.locator('option[value="closed-booth"]').isDisabled(), true);
        if (scenario.serverTime !== 'valid') await page.getByText('운영 시각을 확인할 수 없어 인증할 때 서버에서 확인합니다.', { exact: true }).waitFor();
        await select.selectOption('skew-booth');
        mask = page.locator('#staff-ticket');
        await typeTicket(page, person.ticket);
        await closeSheet(page);
        if (scenario.serverTime === 'valid') {
          await page.evaluate(() => { window.__clockOffset += 7200000; window.dispatchEvent(new Event('focus')); });
          await page.getByText('운영 시각을 확인할 수 없어 인증할 때 서버에서 확인합니다.', { exact: true }).waitFor();
          assert.equal(await readCode(page), person.ticket, 'clock adjustment keeps the typed ticket');
          await page.screenshot({ path: path.join(out, 'staff-clock-adjusted-390.png'), fullPage: true, mask: [mask] });
          await page.getByRole('button', { name: '부스 상태 다시 확인', exact: true }).click();
          await page.waitForFunction(() => !document.querySelector('#staff-booth option[value="skew-booth"]')?.textContent.includes('인증 시 시간 확인'));
          assert.equal(await readCode(page), person.ticket, 'refresh keeps the typed ticket');
        }
        await codeField(page);
        await page.locator('form').filter({ has: mask }).getByRole('button', { name: '부스 인증', exact: true }).click();
        await page.getByRole('button', { name: '다음 참가자', exact: true }).waitFor();
      } else {
        await page.goto(`${f.baseUrl}/event/${f.slug}/home?view=stamp`);
        const row = page.getByRole('listitem').filter({ hasText: '합성 시각 부스' });
        await row.getByText(expected, { exact: true }).waitFor();
        await page.getByRole('listitem').filter({ hasText: '합성 시간 오류 부스' }).getByText('운영 시간 확인 필요', { exact: true }).waitFor();
        if (scenario.serverTime !== 'valid') await row.getByText('운영 시각을 확인할 수 없어 인증할 때 서버에서 확인합니다.', { exact: true }).waitFor();
        await page.screenshot({ path: path.join(out, `guest-${scenario.serverTime}-ready-390.png`), fullPage: true });
        mask = page.getByLabel('부스 코드', { exact: true });
        await mask.fill(`ET:BOOTH:${f.eventId}:skew-booth`);
        await page.getByRole('button', { name: '인증하기', exact: true }).click();
        await page.getByText(/인증을 기록했습니다\./).waitFor();
      }
      assert.equal((await read()).visits.length, 1, `${scenario.role} ${scenario.serverTime} makes exactly one real visit`);
      await page.evaluate(axe);
      for (const width of [320, 390, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(v => ['serious', 'critical'].includes(v.impact)).map(v => v.id)), []);
        if (scenario.role === 'guest') {
          const schedule = page.getByRole('listitem').filter({ hasText: '합성 시각 부스' }).locator('p').filter({ hasText: '한국 시간' });
          assert.equal(await schedule.evaluate(node => {
            const text = node.firstChild;
            if (!text || text.nodeType !== Node.TEXT_NODE) return false;
            const value = text.textContent || '';
            let from = 0, seen = 0;
            while ((from = value.indexOf('시간', from)) !== -1) {
              const a = document.createRange(), b = document.createRange();
              a.setStart(text, from); a.setEnd(text, from + 1);
              b.setStart(text, from + 1); b.setEnd(text, from + 2);
              if (Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top) > 1) return false;
              from += 2; seen++;
            }
            return seen >= 2;
          }), true, `Korean words do not split at ${width}px`);
        }
        if (width === 390) await page.screenshot({ path: path.join(out, `${scenario.role}-${scenario.serverTime}-390.png`), fullPage: true, mask: [mask] });
      }
      await context.close();
    }
    // Delay a real bootstrap response across the start boundary. Its bounded
    // transit makes the exact instant ambiguous, so the UI may ask the server
    // rather than declaring an incorrect before/after state.
    await reset('STAFF');
    const delayedContext = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR' });
    await delayedContext.addCookies([{ ...cookieForContext(f, 'staff'), url: f.baseUrl }]);
    const delayedPage = await delayedContext.newPage();
    let delayedOnce = false;
    await delayedPage.route('**/api/bootstrap', async route => {
      if (delayedOnce) return route.continue();
      delayedOnce = true;
      const current = await read();
      current.booths[0].startsAt = new Date(Date.now() + 3000).toISOString();
      current.booths[0].endsAt = new Date(Date.now() + 3600000).toISOString();
      await db.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [f.eventId, JSON.stringify(current)]);
      const response = await route.fetch();
      await new Promise(resolve => setTimeout(resolve, 4000));
      return route.fulfill({ response });
    });
    await delayedPage.goto(`${f.baseUrl}/staff/events/${f.eventId}`);
    await delayedPage.getByRole('group', { name: '업무 종류' }).getByRole('button', { name: '부스 인증', exact: true }).click();
    const delayedOption = delayedPage.locator('#staff-booth option[value="skew-booth"]');
    await delayedOption.waitFor({ state: 'attached' });
    assert.match(await delayedOption.textContent(), /인증 시 시간 확인/, 'delayed response overlaps the start boundary');
    assert.equal(await delayedOption.isDisabled(), false);
    await delayedPage.locator('#staff-booth').selectOption('skew-booth');
    const delayedTicket = delayedPage.locator('#staff-ticket');
    await typeTicket(delayedPage, person.ticket);
    await delayedPage.locator('form').filter({ has: delayedTicket }).getByRole('button', { name: '부스 인증', exact: true }).click();
    await delayedPage.getByRole('button', { name: '다음 참가자', exact: true }).waitFor();
    assert.equal((await read()).visits.length, 1, 'server accepts a real visit after the boundary');
    await delayedContext.close();
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ synthetic: true, browserOffsetsHours: [24, -24], staffAndGuestRealVisits: true, deviceClockAdjustmentAndRefresh: true, delayedBoundaryIsUncertain: true, oldServerMissingTime: true, malformedTime: true, invalidAndClosedStillBlocked: true, viewportWidths: [320, 390, 1280], physicalDevices: false }, null, 2));
    console.log('서버 시각: 기기 ±24시간·누락/오류 응답·스태프/참가자 실제 인증 통과');
  } finally { await browser?.close(); await f.close(); }
}
main().catch(error => { console.error(String(error?.stack || error).replace(/https?:\/\/[^\s]+/g, '[url redacted]')); process.exitCode = 1; });
