'use strict';

// Isolated staff fallback: search, identity review, concurrent changes and
// lost-response recovery against the real API. All names are synthetic.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const axe = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { confirmInitialStaffDesk } = require('./audit-staff-direction.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');

async function main() {
  const out = prepareCaptureDir(process.env.EVENTOUCH_CAPTURE_ROOT);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture();
  let browser;
  try {
    const read = async () => (await fixture.harness.database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const command = async (name, payload) => {
      const res = await fixture.helpers.requestJson(fixture.harness.baseUrl, `/api/events/${fixture.eventId}/commands`, {
        method: 'POST', cookie: fixture.manager.cookie,
        body: { commandId: crypto.randomUUID(), command: name, payload },
      });
      assert.ok(res.status >= 200 && res.status < 300, `manager command failed: ${res.status}`);
      return res.json;
    };
    const created = [];
    for (let i = 1; i <= 12; i++) {
      const result = await command('participant.create', { name: '동명이인검증', company: `합성 소속 ${String(i).padStart(2, '0')}`, phone: `0109486${String(i + 1000).padStart(4, '0')}` });
      created.push(result.participant);
    }
    const handoffName = '현장인계검증';
    const handoffSameCompany = '합성 동일 소속';
    const handoffPhones = ['01094961000', '01094961001', '01094962003'];
    const handoffSame = [];
    for (let i = 0; i < 2; i++) {
      const result = await command('participant.create', { name: handoffName, company: handoffSameCompany, phone: handoffPhones[i] });
      handoffSame.push(result.participant);
    }
    const missingCompany = (await command('participant.create', { name: handoffName, company: '', phone: handoffPhones[2] })).participant;
    browser = await launchBrowser();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'ko-KR', reducedMotion: 'reduce' });
    await context.addCookies([{ ...cookieForContext(fixture, 'staff'), url: fixture.baseUrl }]);
    const open = async (clipboardMode) => {
      const page = await context.newPage(); page.setDefaultTimeout(12000);
      if (clipboardMode) await page.addInitScript((mode) => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
          writeText: async (value) => {
            window.__staffHandoffAttempted = value;
            if (mode === 'deny') throw new Error('clipboard denied');
            window.__staffHandoffClipboard = value;
          },
        } });
      }, clipboardMode);
      await page.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
      await confirmInitialStaffDesk(page);
      await page.getByRole('button', { name: '명단 찾기', exact: true }).click();
      await page.locator('#staff-manual-search').fill('동명이인검증');
      return page;
    };
    const page = await open();
    const results = page.getByRole('list', { name: '참가자 검색 결과' });
    assert.equal(await results.getByRole('listitem').count(), 10);
    const more = page.getByRole('button', { name: '2명 더 보기', exact: true });
    await more.focus(); await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('[aria-label="참가자 검색 결과"] > li').length === 12);
    assert.equal(await results.getByRole('listitem').count(), 12);
    await page.waitForFunction(() => document.activeElement?.id === 'staff-manual-result-10');
    const select = page.getByRole('button', { name: '동명이인검증 합성 소속 12 선택', exact: true });
    await select.focus(); await page.keyboard.press('Enter');
    const checkbox = page.getByLabel('이름·소속을 직접 확인했습니다');
    await checkbox.waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'staff-manual-identity-confirm');
    const bounds = await checkbox.boundingBox();
    assert.ok(bounds && bounds.y >= 0 && bounds.y + bounds.height <= 844, 'selection reveals its next action in the viewport');
    const panel = page.getByRole('region', { name: '선택한 참가자 확인' });
    const panelBounds = await panel.boundingBox();
    assert.ok(panelBounds && panelBounds.y >= 0 && panelBounds.y + panelBounds.height <= 844, 'the complete confirmation is visible');
    await page.setViewportSize({ width: 390, height: 600 });
    await select.click();
    await page.waitForFunction(() => document.activeElement?.id === 'staff-manual-identity-confirm');
    const shortPanel = await panel.boundingBox();
    assert.ok(shortPanel && shortPanel.y >= 0 && shortPanel.y + shortPanel.height <= 600, 'the complete confirmation is visible on a short screen');
    await page.setViewportSize({ width: 390, height: 844 });
    await select.click();
    await page.waitForFunction(() => document.activeElement?.id === 'staff-manual-identity-confirm');
    await page.screenshot({ path: path.join(out, 'selected-390.png') });
    await checkbox.check();
    await command('participant.create', { name: '동명이인검증', company: '합성 소속 12', phone: '01094869999' });
    const [response] = await Promise.all([
      page.waitForResponse(res => res.request().method() === 'POST' && res.request().postDataJSON()?.command === 'check.scan'),
      page.getByRole('button', { name: '확인한 참가자 입장 처리' }).click(),
    ]);
    assert.equal(response.status(), 409);
    assert.equal((await response.json()).code, 'MANUAL_IDENTITY_CHANGED');
    assert.equal((await read()).checks.filter(row => row.participantId === created[11].id).length, 0);
    await page.getByRole('button', { name: '참가자 명단 다시 확인' }).click();
    assert.equal(await page.locator('#staff-manual-search').inputValue(), '동명이인검증');
    const duplicateButtons = page.getByRole('button', { name: '동명이인검증 합성 소속 12 선택', exact: true });
    await page.waitForFunction(() => [...document.querySelectorAll('button')].filter(button => button.getAttribute('aria-label') === '동명이인검증 합성 소속 12 선택').length === 2);
    assert.equal(await duplicateButtons.count(), 2);
    assert.ok(await duplicateButtons.nth(0).isDisabled());
    assert.ok(await duplicateButtons.nth(1).isDisabled());

    const handoffPage = await open('capture');
    await handoffPage.locator('#staff-manual-search').fill(handoffName);
    const handoffRegion = handoffPage.getByRole('region', { name: '현장 책임자 확인 요청' });
    await handoffRegion.waitFor();
    const sameCompanyHandoff = handoffRegion.getByRole('button', { name: `${handoffName} ${handoffSameCompany} 책임자 확인 요청 복사`, exact: true });
    assert.equal(await sameCompanyHandoff.count(), 1, 'same-name and same-company records share one actionable handoff');
    await sameCompanyHandoff.click();
    await handoffPage.getByText('확인 요청을 복사했습니다. 현장 책임자에게 직접 전달하세요.', { exact: true }).waitFor();
    const copiedHandoff = await handoffPage.evaluate(() => window.__staffHandoffClipboard || '');
    assert.match(copiedHandoff, new RegExp(`행사: 감사 검증 행사`));
    assert.match(copiedHandoff, /업무 위치: 감사 입장 데스크 · 입장/);
    assert.match(copiedHandoff, new RegExp(`명단 확인 대상: ${handoffName} · ${handoffSameCompany}`));
    assert.match(copiedHandoff, /같은 이름 후보: 3명/);
    assert.match(copiedHandoff, /같은 이름·소속 후보: 2명/);
    assert.ok(copiedHandoff.includes(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`));
    assert.match(copiedHandoff, /검토 재발급/);
    assert.match(copiedHandoff, /새 QR·코드를 참가자에게 전달/);
    for (const privateValue of [...handoffSame.map(person => person.id), missingCompany.id, ...handoffPhones]) {
      assert.ok(!copiedHandoff.includes(privateValue), 'handoff contains no participant identifiers or phone numbers');
    }
    assert.ok(!copiedHandoff.includes('?'), 'the manager URL has no participant search or identifier query');
    await handoffPage.getByRole('button', { name: '책임자 확인 후 스캔 화면으로 돌아가기', exact: true }).click();
    await handoffPage.getByRole('button', { name: '명단 찾기', exact: true }).waitFor();

    const fallbackPage = await open('deny');
    await fallbackPage.locator('#staff-manual-search').fill(handoffName);
    const fallbackRegion = fallbackPage.getByRole('region', { name: '현장 책임자 확인 요청' });
    const handoffResults = fallbackPage.getByRole('list', { name: '참가자 검색 결과' });
    const duplicateHandoffSelections = handoffResults.getByRole('button', { name: `${handoffName} ${handoffSameCompany} 선택`, exact: true });
    assert.equal(await duplicateHandoffSelections.count(), 2);
    assert.ok(await duplicateHandoffSelections.nth(0).isDisabled());
    assert.ok(await duplicateHandoffSelections.nth(1).isDisabled());
    assert.ok(await handoffResults.getByRole('button', { name: `${handoffName} 소속 미입력 선택`, exact: true }).isDisabled());
    const missingCompanyHandoff = fallbackRegion.getByRole('button', { name: `${handoffName} 소속 미입력 책임자 확인 요청 복사`, exact: true });
    await missingCompanyHandoff.click();
    const fallback = fallbackPage.getByRole('textbox', { name: '책임자에게 전달할 확인 요청' });
    await fallback.waitFor();
    const fallbackText = await fallback.inputValue();
    assert.equal(fallbackText, await fallbackPage.evaluate(() => window.__staffHandoffAttempted || ''), 'fallback text matches the exact failed clipboard request');
    await fallbackPage.getByText('자동 복사를 할 수 없습니다. 아래 문구가 선택됐습니다. 직접 복사해 책임자에게 전달하세요.', { exact: true }).waitFor();
    assert.match(fallbackText, new RegExp(`명단 확인 대상: ${handoffName} · 소속 미입력`));
    assert.match(fallbackText, /같은 이름 후보: 3명/);
    assert.match(fallbackText, /같은 이름·소속 후보: 1명/);
    assert.ok(fallbackText.includes(`${fixture.baseUrl}/console/events/${fixture.eventId}/participants`));
    assert.equal(await fallback.evaluate(element => element.value.slice(element.selectionStart, element.selectionEnd)), fallbackText, 'clipboard denial focuses and selects the full fallback note');
    await fallbackPage.screenshot({ path: path.join(out, 'handoff-fallback-390.png') });
    await fallbackPage.evaluate(axe);
    for (const width of [320, 390, 768, 1280]) {
      await fallbackPage.setViewportSize({ width, height: 844 });
      assert.ok(await fallbackPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `handoff fallback has no horizontal overflow at ${width}px`);
      assert.deepEqual(await fallbackPage.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), [], `handoff fallback has no serious axe violations at ${width}px`);
    }
    await fallbackPage.getByRole('button', { name: '책임자 확인 후 스캔 화면으로 돌아가기', exact: true }).click();
    await fallbackPage.getByRole('button', { name: '명단 찾기', exact: true }).waitFor();
    const postHandoffWorkspace = await read();
    for (const person of [...handoffSame, missingCompany]) {
      assert.equal(postHandoffWorkspace.checks.filter(row => row.participantId === person.id).length, 0, 'handoff never creates an attendance check');
    }

    await page.evaluate(axe);
    for (const width of [320, 390, 768, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      assert.deepEqual(await page.evaluate(async () => (await window.axe.run()).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => item.id)), []);
    }
    const originals = (await read()).participants.filter(person => person.name.startsWith('감사 참가자')).slice(0, 2);
    assert.equal(originals.length, 2);
    const recovery = [];
    for (const [index, mode] of ['lost-before', 'lost-after'].entries()) {
      const person = originals[index];
      const retryPage = await context.newPage(); retryPage.setDefaultTimeout(12000);
      let intercept = true;
      const requests = [];
      await retryPage.route('**/api/events/*/commands', async route => {
        let body; try { body = route.request().postDataJSON(); } catch { return route.continue(); }
        if (body.command !== 'check.scan') return route.continue();
        requests.push(body);
        if (!intercept) return route.continue();
        intercept = false;
        if (mode === 'lost-after') {
          const applied = await route.fetch();
          assert.equal(applied.status(), 200);
        }
        return route.abort('failed');
      });
      await retryPage.goto(`${fixture.baseUrl}/staff/events/${fixture.eventId}`);
      await confirmInitialStaffDesk(retryPage);
      await retryPage.getByRole('button', { name: '명단 찾기', exact: true }).click();
      await retryPage.locator('#staff-manual-search').fill(person.name);
      await retryPage.getByRole('button', { name: `${person.name} ${person.company} 선택`, exact: true }).click();
      await retryPage.getByLabel('이름·소속을 직접 확인했습니다').check();
      await retryPage.getByRole('button', { name: '확인한 참가자 입장 처리' }).click();
      await retryPage.getByRole('button', { name: '같은 요청 재확인' }).waitFor();
      await command('participant.create', { name: person.name, company: person.company, phone: `0109498${String(index + 2000).padStart(4, '0')}` });
      const [replayed] = await Promise.all([
        retryPage.waitForResponse(res => res.request().method() === 'POST' && res.request().postDataJSON()?.command === 'check.scan'),
        retryPage.getByRole('button', { name: '같은 요청 재확인' }).click(),
      ]);
      const response = await replayed.json();
      const checks = (await read()).checks.filter(row => row.participantId === person.id).length;
      // The request contains identity and a command ID; compare without ever
      // printing it in a failing assertion.
      assert.ok(requests.length === 2 && JSON.stringify(requests[0]) === JSON.stringify(requests[1]), 'the original request is retried');
      if (mode === 'lost-before') {
        assert.equal(replayed.status(), 409);
        assert.equal(response.code, 'MANUAL_IDENTITY_CHANGED');
        assert.equal(checks, 0);
        await retryPage.getByRole('button', { name: '참가자 명단 다시 확인' }).waitFor();
        await retryPage.screenshot({ path: path.join(out, 'uncommitted-conflict-390.png') });
        await retryPage.getByRole('button', { name: '참가자 명단 다시 확인' }).click();
      } else {
        assert.equal(replayed.status(), 200);
        assert.equal(checks, 1);
        await retryPage.getByRole('button', { name: '다음 참가자' }).waitFor();
      }
      recovery.push({ mode, status: replayed.status(), checks, sameRequest: true });
      await retryPage.close();
    }
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ matches: 12, reachable: 12, staleStatus: 409, changedIdentityWrites: 0, duplicateDisabled: true, recovery, actualProvider: false }, null, 2), { mode: 0o600 });
    await context.close();
    console.log('[staff-manual-roster] search, identity guards, actionable handoff, clipboard fallback and return-to-scan passed');
  } finally { await browser?.close(); await fixture.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
