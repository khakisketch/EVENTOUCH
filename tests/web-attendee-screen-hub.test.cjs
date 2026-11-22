'use strict';

// 참가자 화면 허브 (2026-11-21, C안): 레일은 한 줄, 세 화면은 탭으로 묶이고
// 게시 상태 줄은 읽기 전용이다. 화면 안쪽·주소·게시 동작은 바뀌지 않는다.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { attendeeScreenStatuses, firstPendingTab, hasParticipationFeature } = require('../apps/web/lib/attendee-screen-status.ts');

const web = (file) => fs.readFileSync(path.join(__dirname, '..', 'apps', 'web', file), 'utf8');

const publishedPage = { pageExperience: { publishedAt: '2026-11-20T00:00:00Z', draftVersion: 3, publishedVersion: 3 } };

test('design status follows the screen: never published, differs from published, published', () => {
  const never = attendeeScreenStatuses({}, { pageExperience: { publishedAt: null, draftVersion: 1 } });
  assert.deepEqual([never[0].label, never[0].tone, never[0].pending], ['디자인 · 게시 전 초안', 'wait', 1]);
  const differs = attendeeScreenStatuses({}, { pageExperience: { publishedAt: 'x', draftVersion: 4, publishedVersion: 3 } });
  assert.equal(differs[0].label, '디자인 · 게시본과 다름');
  const same = attendeeScreenStatuses({}, publishedPage);
  assert.deepEqual([same[0].label, same[0].tone, same[0].pending], ['디자인 · 게시됨', 'ok', 0]);
});

test('content status counts unpublished and edited notices and programs', () => {
  const workspace = {
    ...publishedPage,
    notices: [
      { id: 'a', title: '입장', body: '동문', published: true, pinned: false, draft: { title: '입장', body: '동문', pinned: false } },
      { id: 'b', title: '주차', body: '', published: false, pinned: false },
      { id: 'c', title: '식사', body: '12시', published: true, pinned: false, draft: { title: '식사', body: '13시', pinned: false } },
    ],
    program: [{ id: 'p', title: '개회', date: '2027-01-16', start: '09:00', end: '10:00', place: '', description: '', published: true, draft: { title: '개회', date: '2027-01-16', start: '09:00', end: '10:00', place: '', description: '' } }],
  };
  const content = attendeeScreenStatuses({}, workspace)[1];
  assert.deepEqual([content.label, content.tone, content.pending], ['공지·안내 · 게시 전 2건', 'wait', 2]);
  const clean = attendeeScreenStatuses({}, { ...publishedPage, notices: [workspace.notices[0]], program: [] })[1];
  assert.deepEqual([clean.label, clean.tone], ['공지·안내 · 게시됨', 'ok']);
  const empty = attendeeScreenStatuses({}, { ...publishedPage, notices: [], program: [] })[1];
  assert.deepEqual([empty.label, empty.tone, empty.pending], ['공지·안내 · 등록 없음', 'neutral', 0]);
});

test('programs status appears only for events with a participation feature and never counts as pending', () => {
  const withoutFeature = attendeeScreenStatuses({ features: ['screen'] }, publishedPage);
  assert.deepEqual(withoutFeature.map((item) => item.tab), ['design', 'content']);
  assert.equal(hasParticipationFeature({ features: ['draw'] }), true);
  assert.equal(hasParticipationFeature({ features: ['screen'] }), false);

  // Reopened 2026-11-22: the programs line counts only modules of features that are on, so a module carries its type.
  const workspace = { ...publishedPage, notices: [], program: [], modules: [{ type: 'poll', status: 'OPEN' }] };
  const programs = attendeeScreenStatuses({ features: ['poll', 'draw'] }, workspace, ['DRAFT', 'DRAFT'])[2];
  assert.deepEqual([programs.label, programs.tone, programs.pending], ['참여 이벤트 · 준비 중 2건', 'neutral', 0]);
  const running = attendeeScreenStatuses({ features: ['poll'] }, workspace)[2];
  assert.equal(running.label, '참여 이벤트 · 진행 중 1건');
  const none = attendeeScreenStatuses({ features: ['poll'] }, { ...publishedPage, modules: [] })[2];
  assert.equal(none.label, '참여 이벤트 · 없음');
});

test('the one-click review targets the first tab with something waiting', () => {
  const waiting = attendeeScreenStatuses({}, { pageExperience: { publishedAt: null }, notices: [{ id: 'b', title: 't', published: false }], program: [] });
  // Reopened 2026-11-22: tabCount is what the linked tab itself holds (count stays the hub-wide total).
  assert.deepEqual(firstPendingTab(waiting), { tab: 'design', count: 2, tabCount: 1 });
  const onlyContent = attendeeScreenStatuses({}, { ...publishedPage, notices: [{ id: 'b', title: 't', published: false }], program: [] });
  // source: the 공지·안내 sub-tab that holds it (the hub links straight to it).
  assert.deepEqual(firstPendingTab(onlyContent), { tab: 'content', count: 1, tabCount: 1, source: 'notice' });
  assert.equal(firstPendingTab(attendeeScreenStatuses({}, publishedPage)), null);
});

test('the hub frames the three existing screens without touching them', () => {
  for (const [dir, tab, workspace] of [['page', 'design', 'ThemeWorkspace'], ['content', 'content', 'ContentWorkspace'], ['programs', 'programs', 'ProgramsWorkspace']]) {
    const page = web(`app/console/events/[id]/${dir}/page.tsx`);
    // Reopened 2026-11-21: the hub moved from above the screen to under its
    // title, handed to the workspace as `afterHeader`; the workspace only
    // forwards it to ConsolePage.
    assert.match(page, new RegExp(`afterHeader=\\{<AttendeeScreenHub eventId=\\{id\\} active="${tab}" />\\}`), `${dir} hands the hub to its workspace under the title`);
    assert.match(page, new RegExp(`<${workspace} `), `${dir} keeps its own workspace`);
    const source = web(`app/console/events/[id]/${dir}/${workspace}.tsx`);
    assert.match(source, /afterHeader\?: ReactNode/, `${workspace} accepts afterHeader`);
    assert.doesNotMatch(source, /<ConsolePage(?![^>]*afterHeader=\{afterHeader\})[^>]*eventId=\{eventId\}/, `${workspace} forwards afterHeader to every ConsolePage`);
  }
  const frame = web('app/console/console-ui/ConsolePage.tsx');
  assert.match(frame, /\{afterHeader \?\? null\}/, 'the frame renders afterHeader right below the header');
  const hub = web('app/console/events/[id]/AttendeeScreenHub.tsx');
  // Read-only: the hub reads bootstrap and links; it never sends a command.
  assert.match(hub, /\/bootstrap/);
  assert.doesNotMatch(hub, /\/commands|method: "(POST|PUT|PATCH|DELETE)"/u);
  // Plain same-tab links keep the console draft guard in charge of unsaved screens.
  assert.match(hub, /import Link from "next\/link"/);
  assert.match(hub, /aria-current=\{tab === active \? "page" : undefined\}/);
});

test('the rail shows one 참가자 화면 item; routes and page metadata stay', () => {
  const nav = web('app/console/console-navigation.ts');
  assert.match(nav, /attendeePage: \{ label: "참가자 페이지"/u, 'page metadata is unchanged');
  assert.match(nav, /content: \{ label: "공지·안내"/u);
  assert.match(nav, /programs: \{ label: "참여 이벤트"/u);
  assert.match(nav, /RAIL_LABELS[^=]*= \{ attendeePage: "참가자 화면" \}/u);
  assert.match(nav, /if \(pageId === "content" \|\| pageId === "programs"\) return "attendeePage";/u);
  assert.match(nav, /return `\$\{base\}\/programs`/u);
  assert.match(nav, /return `\$\{base\}\/content`/u);
});
