'use strict';

// Synthetic operator -> real API -> PostgreSQL -> independent attendee UI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axeSource = require('axe-core').source;
const { prepareCaptureDir, ensureRunTmpDir } = require('./capture-dir.cjs');
const { launchBrowser } = require('./audit-browser.cjs');
const { startAuditFixture, cookieForContext } = require('./audit-fixture.cjs');
let phase = 'setup';
async function main() {
  if (!process.env.EVENTOUCH_CAPTURE_ROOT) throw new Error('Set a new private EVENTOUCH_CAPTURE_ROOT');
  const out = path.join(process.env.EVENTOUCH_CAPTURE_ROOT, 'home-menus');
  prepareCaptureDir(out);
  process.env.TMPDIR = ensureRunTmpDir(out);
  const fixture = await startAuditFixture({ loseFirstResponseFor: ['attendee.page.save'] });
  let browser;
  const errors = [];
  const pages = [];
  try {
    const { database } = fixture.harness;
    const event = (await database.query('SELECT payload FROM events WHERE id=$1', [fixture.eventId])).rows[0].payload;
    event.features = ['draw', 'poll', 'stamp', 'qa', 'venue'];
    await database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [fixture.eventId, JSON.stringify(event)]);
    const readWorkspace = async () => (await database.query('SELECT payload FROM event_workspaces WHERE event_id=$1', [fixture.eventId])).rows[0].payload;
    const workspace = await readWorkspace();
    workspace.modules = [
      { id: 'public-questions', type: 'qa', title: '무대 질문', status: 'OPEN', published: true },
      { id: 'public-audience', type: 'qa', title: '관객 질문', status: 'OPEN', published: true },
      { id: 'private-questions', type: 'qa', title: '미게시 질문', status: 'DRAFT', published: false },
      { id: 'disabled-survey', type: 'survey', title: '꺼진 설문', status: 'OPEN', published: true },
    ];
    const fields = { intro: '행사 소개', accent: '#E76D26', showAnnouncements: true, showSchedule: true, showVenue: true, showPrograms: true, homeStyle: { backgroundColor: '#B9DEF0', heroTitle: '보존할 행사 디자인' } };
    workspace.pageExperience = { draft: { ...fields }, published: { ...fields }, draftVersion: 1, publishedVersion: 1, publishedAt: '2026-10-01T00:00:00.000Z' };
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(workspace)]);
    browser = await launchBrowser();
    const manager = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await manager.addCookies([{ ...cookieForContext(fixture, 'manager'), url: fixture.baseUrl }]);
    const editor = await manager.newPage(); pages.push(editor);
    const stale = await manager.newPage(); pages.push(stale);
    const attendee = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); pages.push(attendee);
    for (const page of pages) page.on('pageerror', error => errors.push(error.message));
    await editor.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/page`, { waitUntil: 'networkidle' });
    await editor.getByRole('button', { name: '초안 저장', exact: true }).waitFor();
    await stale.goto(`${fixture.baseUrl}/console/events/${fixture.eventId}/page`, { waitUntil: 'networkidle' });
    await stale.getByRole('button', { name: /^홈 메뉴/ }).click();
    await stale.getByRole('checkbox', { name: '부스 인증', exact: true }).uncheck();
    await attendee.goto(`${fixture.baseUrl}/event/${fixture.slug}/home`, { waitUntil: 'networkidle' });
    const attendeeMenu = attendee.getByRole('navigation', { name: '참가 메뉴' });
    await attendeeMenu.getByRole('button', { name: '공지사항', exact: true }).waitFor();
    await attendee.screenshot({ path: path.join(out, 'before-attendee-390.png'), fullPage: true });
    await editor.screenshot({ path: path.join(out, 'before-editor-1280.png'), fullPage: true });

    phase = 'editor changes and preview';
    await editor.getByRole('button', { name: /^홈 메뉴/ }).click();
    const config = editor.locator('fieldset').filter({ has: editor.getByText('메뉴 표시와 순서', { exact: true }) });
    await config.getByRole('checkbox', { name: '공지사항', exact: true }).uncheck();
    await config.getByRole('button', { name: '순위 투표 위로 이동' }).click();
    await config.getByRole('checkbox', { name: '무대 질문', exact: true }).check();
    await config.getByRole('checkbox', { name: '관객 질문', exact: true }).check();
    await config.getByRole('button', { name: '관객 질문 위로 이동' }).click();
    assert.equal(await config.getByRole('checkbox', { name: /미게시 질문/ }).isDisabled(), true);
    assert.equal(await config.getByRole('checkbox', { name: /꺼진 설문/ }).isDisabled(), true);
    const programRows = await config.getByRole('heading', { name: '개별 참여 콘텐츠', exact: true }).locator('..').locator('ol > li').allTextContents();
    assert.match(programRows[0], /관객 질문/); assert.match(programRows[1], /무대 질문/);
    await editor.getByLabel('참가자 티켓').selectOption('no');
    const preview = editor.getByRole('region', { name: /홈 디자인 미리보기/ });
    assert.equal(await preview.getByRole('button', { name: '공지사항', exact: true }).count(), 0);
    assert.equal(await preview.getByRole('button', { name: /모바일 티켓/ }).count(), 1);
    assert.equal(await preview.getByRole('button', { name: /내 신청 정보/ }).count(), 1);
    assert.ok((await preview.getByText('티켓 필요').count()) > 0);
    const previewLinks = await preview.getByRole('navigation', { name: '행사 안내와 참여' }).locator('button').allTextContents();
    assert.ok(previewLinks.findIndex(item => item.includes('관객 질문')) < previewLinks.findIndex(item => item.includes('무대 질문')));
    await editor.locator('summary', { hasText: '저장 전 변경 내용 확인' }).click();
    assert.ok((await editor.getByText(/관객 질문 → 무대 질문/).count()) > 0, 'change review uses visible names in order');
    await editor.screenshot({ path: path.join(out, 'after-editor-1280.png'), fullPage: true });
    await editor.getByRole('button', { name: '게시본', exact: true }).click();
    assert.equal(await preview.getByRole('button', { name: '공지사항', exact: true }).count(), 1, 'published preview remains unchanged');
    await editor.getByRole('button', { name: '편집 중', exact: true }).click();
    assert.equal(await attendeeMenu.getByRole('button', { name: '공지사항', exact: true }).count(), 1, 'unsaved edits are private');

    phase = 'commit response loss and retry';
    const save = editor.getByRole('button', { name: '초안 저장', exact: true });
    await save.click();
    await fixture.gateway.waitForResponseLoss('attendee.page.save');
    await editor.getByRole('alert').filter({ hasText: /응답|연결|저장/ }).waitFor();
    const reply = editor.waitForResponse(response => {
      try { return response.request().method() === 'POST' && response.request().postDataJSON().command === 'attendee.page.save'; } catch { return false; }
    });
    await save.click();
    assert.equal((await reply).status(), 200);
    await editor.waitForLoadState('networkidle');
    const saves = fixture.gateway.commands.filter(call => call.command === 'attendee.page.save');
    assert.equal(saves.length, 2); assert.equal(saves[0].commandId, saves[1].commandId);
    const saved = await readWorkspace();
    assert.equal(saved.pageExperience.draftVersion, 2);
    assert.deepEqual(saved.pageExperience.draft.homeMenus.programs, ['public-audience', 'public-questions']);
    assert.equal(saved.pageExperience.draft.homeStyle.heroTitle, '보존할 행사 디자인');
    const staleResponse = stale.waitForResponse(response => {
      try { return response.request().method() === 'POST' && response.request().postDataJSON().command === 'attendee.page.save'; } catch { return false; }
    });
    await stale.getByRole('button', { name: '초안 저장', exact: true }).click();
    assert.equal((await staleResponse).status(), 409, 'stale menu draft is not saved over the newer draft');
    await stale.getByRole('button', { name: '최신 초안 확인', exact: true }).click();
    await stale.getByRole('button', { name: '내 변경을 최신 초안에 적용', exact: true }).click();
    const merge = stale.getByRole('group', { name: '실행 확인', exact: true });
    assert.match(await merge.innerText(), /둘 다 바꾼 항목.*홈 메뉴/s);
    await merge.getByRole('button', { name: '내 변경 유지하기', exact: true }).click();
    assert.equal(await stale.getByRole('checkbox', { name: '부스 인증', exact: true }).isChecked(), false, 'local menu edits survive conflict review');
    assert.equal((await readWorkspace()).pageExperience.draftVersion, 2, 'conflict review does not save');
    await attendee.reload({ waitUntil: 'networkidle' });
    assert.equal(await attendeeMenu.getByRole('button', { name: '공지사항', exact: true }).count(), 1, 'saved draft remains private');

    phase = 'publish and attendee navigation';
    await editor.getByRole('button', { name: '게시 검토', exact: true }).click();
    const publish = editor.waitForResponse(response => {
      try { return response.request().method() === 'POST' && response.request().postDataJSON().command === 'attendee.page.publish-reviewed'; } catch { return false; }
    });
    await editor.getByRole('dialog', { name: '참가자 페이지 게시 검토', exact: true }).getByRole('button', { name: '게시하기', exact: true }).click();
    assert.equal((await publish).status(), 200);
    await attendee.reload({ waitUntil: 'networkidle' });
    await attendee.getByRole('button', { name: /모바일 티켓/ }).waitFor();
    assert.equal(await attendeeMenu.getByRole('button', { name: '공지사항', exact: true }).count(), 0);
    const menuText = await attendeeMenu.locator('button').allTextContents();
    assert.ok(menuText.findIndex(item => item.includes('순위 투표')) < menuText.findIndex(item => item.includes('룰렛 이벤트')));
    const more = attendee.getByRole('navigation', { name: '행사 안내와 참여' });
    assert.equal(await attendee.getByRole('button', { name: /내 신청 정보/ }).count(), 1);
    const links = await more.locator('a').allTextContents();
    assert.ok(links.findIndex(item => item.includes('관객 질문')) < links.findIndex(item => item.includes('무대 질문')));
    assert.equal(await more.getByText('미게시 질문').count(), 0);
    assert.equal(await more.getByText('꺼진 설문').count(), 0);
    await attendee.screenshot({ path: path.join(out, 'after-attendee-390.png'), fullPage: true });
    for (const width of [320, 390]) {
      await editor.setViewportSize({ width, height: 844 });
      await editor.screenshot({ path: path.join(out, `editor-${width}.png`), fullPage: true });
      assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `editor overflow at ${width}`);
      const undersized = await config.locator('button:visible').evaluateAll(buttons => buttons.filter(button => {
        const r = button.getBoundingClientRect(); return r.width < 44 || r.height < 44;
      }).map(button => button.getAttribute('aria-label')));
      assert.deepEqual(undersized, [], `move actions support touch at ${width}`);
      await attendee.setViewportSize({ width, height: 844 });
      assert.equal(await attendee.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `home overflow at ${width}`);
    }
    await editor.setViewportSize({ width: 1280, height: 900 });
    for (const [page, name] of [[editor, 'editor'], [attendee, 'attendee']]) {
      await page.evaluate(axeSource);
      const issues = await page.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] } })).violations.filter(item => ['serious', 'critical'].includes(item.impact)).map(item => ({ id: item.id, targets: item.nodes.map(node => node.target) })));
      assert.deepEqual(issues, [], `${name}: serious/critical accessibility`);
    }
    const person = (await readWorkspace()).participants[0];
    await attendee.goto(`${fixture.baseUrl}/event/${fixture.slug}/home?ticket=${encodeURIComponent(person.ticket)}`, { waitUntil: 'networkidle' });
    await attendee.getByRole('link', { name: /관객 질문/ }).click();
    await attendee.getByRole('heading', { name: '관객 질문', exact: true }).waitFor();
    assert.equal(new URL(attendee.url()).searchParams.get('program'), 'public-audience');
    assert.equal(await attendee.locator('#engage-public-audience').evaluate(el => el.closest('details').open), true);
    assert.equal(await attendee.evaluate(() => document.activeElement.id), 'engage-public-audience');
    assert.deepEqual(errors, []);
    const published = await readWorkspace();
    assert.equal(published.pageExperience.published.homeStyle.heroTitle, '보존할 행사 디자인');
    assert.deepEqual(published.pageExperience.published.homeMenus.programs, ['public-audience', 'public-questions']);
    phase = 'publication and feature guard';
    published.modules.find(item => item.id === 'public-audience').published = false;
    await database.query('UPDATE event_workspaces SET payload=$2::jsonb WHERE event_id=$1', [fixture.eventId, JSON.stringify(published)]);
    await attendee.goto(`${fixture.baseUrl}/event/${fixture.slug}/home`, { waitUntil: 'networkidle' });
    assert.equal(await attendee.getByRole('link', { name: /관객 질문/ }).count(), 0, 'unpublished selected program is removed');
    assert.equal(await attendee.getByRole('link', { name: /무대 질문/ }).count(), 1);
    event.features = event.features.filter(feature => feature !== 'qa');
    await database.query('UPDATE events SET payload=$2::jsonb WHERE id=$1', [fixture.eventId, JSON.stringify(event)]);
    await attendee.reload({ waitUntil: 'networkidle' });
    assert.equal(await attendee.getByRole('link', { name: /무대 질문/ }).count(), 0, 'disabled program feature is removed');
    const publicBody = await (await attendee.request.get(`${fixture.baseUrl}/api/public/events/${fixture.slug}`)).text();
    assert.equal(publicBody.includes('private-questions'), false);
    assert.equal(publicBody.includes('public-audience'), false);
    fs.writeFileSync(path.join(out, 'verification.json'), JSON.stringify({ outcome: 'passed', realApi: true, lostSaveResponseIdempotent: true, previewAndPublishedMatch: true, hiddenAndDisabledExcluded: true, selectedProgramFocus: true, syntheticDataOnly: true, screenshots: out }, null, 2), { mode: 0o600 });
    console.log('Home menus: draft, publish, loss recovery, program navigation, mobile and accessibility passed');
  } catch (error) {
    for (let index = 0; index < pages.length; index += 1) await pages[index].screenshot({ path: path.join(out, `failure-${index}.png`), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    if (browser) await browser.close();
    await fixture.close();
  }
}
main().catch(error => { console.error(`Failed phase: ${phase}`, error); process.exitCode = 1; });
