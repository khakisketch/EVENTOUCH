'use strict';

// 참가자 화면 허브 (2026-11-21, C안): 레일은 한 줄, 세 화면은 탭으로 묶이고
// 게시 상태 줄은 읽기 전용이다. 화면 안쪽·주소·게시 동작은 바뀌지 않는다.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { attendeeScreenStatuses, firstPendingTab, hasParticipationFeature, isNeverPublished } = require('../apps/web/lib/attendee-screen-status.ts');

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

// Reopened 2026-11-24 (H1): a notice that was never published is saved work (임시 저장), and one
// that was published and then taken down (게시 내림) is a deliberate choice. Neither is "게시 전".
// What waits for a publish review is a published item whose saved draft differs.
test('content status counts only published items with an unpublished edit; 임시 저장 is shown apart', () => {
  const workspace = {
    ...publishedPage,
    notices: [
      { id: 'a', title: '입장', body: '동문', published: true, pinned: false, draft: { title: '입장', body: '동문', pinned: false } },
      { id: 'b', title: '주차', body: '', published: false, pinned: false },
      { id: 'c', title: '식사', body: '12시', published: true, pinned: false, draft: { title: '식사', body: '13시', pinned: false } },
      { id: 'd', title: '내린 공지', body: '', published: false, publishedAt: '2026-11-20T00:00:00Z', pinned: false, draft: { title: '내린 공지', body: '고침', pinned: false } },
    ],
    program: [{ id: 'p', title: '개회', date: '2027-01-16', start: '09:00', end: '10:00', place: '', description: '', published: true, draft: { title: '개회', date: '2027-01-16', start: '09:00', end: '10:00', place: '', description: '' } }],
  };
  const content = attendeeScreenStatuses({}, workspace)[1];
  assert.deepEqual([content.label, content.tone, content.pending, content.drafts], ['공지·안내 · 게시 전 1건 · 임시 저장 1건', 'wait', 1, 1]);
  assert.equal(isNeverPublished(workspace.notices[1]), true);
  assert.equal(isNeverPublished(workspace.notices[3]), false, 'a taken-down notice was published once');
  assert.equal(isNeverPublished(workspace.notices[0]), false);
  const onlyDrafts = attendeeScreenStatuses({}, { ...publishedPage, notices: [workspace.notices[1]], program: [] })[1];
  assert.deepEqual([onlyDrafts.label, onlyDrafts.tone, onlyDrafts.pending], ['공지·안내 · 임시 저장 1건', 'neutral', 0]);
  const takenDown = attendeeScreenStatuses({}, { ...publishedPage, notices: [workspace.notices[3]], program: [] })[1];
  assert.equal(takenDown.pending, 0, 'a deliberate 게시 내림 never waits');
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
  const edited = { id: 'b', title: 't', body: '', published: true, draft: { title: 't', body: '고침', pinned: false } };
  const waiting = attendeeScreenStatuses({}, { pageExperience: { publishedAt: null }, notices: [edited], program: [] });
  // Reopened 2026-11-22: tabCount is what the linked tab itself holds (count stays the hub-wide total).
  assert.deepEqual(firstPendingTab(waiting), { tab: 'design', count: 2, tabCount: 1 });
  const onlyContent = attendeeScreenStatuses({}, { ...publishedPage, notices: [edited], program: [] });
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

test('reopened 2026-11-24: the review link works on the screen that is already open, and says where the waiting items are', () => {
  const hub = web('app/console/events/[id]/AttendeeScreenHub.tsx');
  // Same address means no navigation: the hub tells the open screen instead.
  assert.match(hub, /export const HUB_REVIEW_EVENT = "eventouch:attendee-hub-review";/);
  assert.match(hub, /if \(!pending \|\| pending\.tab !== active\) return;\s*event\.preventDefault\(\);\s*window\.dispatchEvent\(new CustomEvent<HubReviewDetail>\(HUB_REVIEW_EVENT/);
  assert.equal((hub.match(/onClick=\{reviewClick\}/g) || []).length, 2, 'the phone line and the desktop button both use it');
  // From another tab the text names the tab, so 참여 이벤트 never reads "nothing to review" beside "게시 전 1건".
  assert.match(hub, /\$\{pendingTab\.label\}에 게시 전 \$\{pending\.tabCount\}건/);
  const content = web('app/console/events/[id]/content/ContentWorkspace.tsx');
  assert.match(content, /window\.addEventListener\(HUB_REVIEW_EVENT, fromHub\)/);
  assert.match(content, /data-highlight=\{highlight \? "true" : undefined\}/);
  const theme = web('app/console/events/[id]/page/ThemeWorkspace.tsx');
  assert.match(theme, /window\.addEventListener\(HUB_REVIEW_EVENT, onHubReview\)/);
  const programs = web('app/console/events/[id]/programs/ProgramsWorkspace.tsx');
  assert.match(programs, /참가자가 올린 질문·사진·글 중 검토할 항목이 없습니다/, 'the moderation line speaks only for this tab');
});

test('reopened 2026-11-24: the editor says what is true about reaching attendees; a status says why an item is not live', () => {
  const content = web('app/console/events/[id]/content/ContentWorkspace.tsx');
  assert.doesNotMatch(content, /게시 전까지 참가자에게는 보이지 않습니다\./, 'the old line was also shown for an item that is already published');
  assert.match(content, /현재 게시된 내용입니다\. 수정한 뒤 다시 게시하면 반영됩니다\./);
  assert.match(content, /live: "게시 중", edit: "게시 대기", draft: "임시 저장", off: "게시 내림"/);
  assert.match(content, /function contentStatusOf/);
  // A success banner belongs to the tab it was raised in.
  assert.match(content, /setTab\(next\);\s*setPreviewScreen\(next\);\s*\/\/ A success banner[^\n]*\n\s*setNotice\(null\);/);
});

test('reopened 2026-11-24: hub frame keeps tab rows still; day labels are M월 D일 (요일)', () => {
  const css = web('app/console/events/[id]/attendee-screen-hub.module.css');
  assert.match(css, /\.frame > header\s*\{[^}]*min-height/s);
  for (const file of ['page/ThemeWorkspace.tsx', 'content/ContentWorkspace.tsx', 'programs/ProgramsWorkspace.tsx']) {
    assert.match(web(`app/console/events/[id]/${file}`), /className=\{hubStyles\.frame\}/, `${file} uses the shared header frame`);
  }
  const { formatDay, formatDayTime } = require('../apps/web/lib/screen-hub-date.ts');
  const now = new Date(2026, 10, 24, 12);
  assert.equal(formatDay('2026-11-28', now), '11월 28일 (토)');
  assert.equal(formatDay('2027-01-16', now), '2027년 1월 16일 (토)');
  assert.equal(formatDay('not a date', now), 'not a date');
  assert.equal(formatDay('2027-02-30', now), '2027-02-30', 'an impossible day is shown as typed');
  assert.equal(formatDayTime(new Date(2026, 10, 24, 15, 7).toISOString(), now), '11월 24일 (화) 오후 3:07');
  assert.equal(formatDayTime(new Date(2026, 10, 24, 0, 5).toISOString(), now), '11월 24일 (화) 오전 12:05');
});

test('reopened 2026-11-24: banner pictures are shrunk in the browser instead of refused at 600KB', () => {
  const theme = web('app/console/events/[id]/page/ThemeWorkspace.tsx');
  assert.match(theme, /import \{ fitImage \} from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/image-fit";/);
  assert.match(theme, /fitted = await fitImage\(file\);/);
  assert.doesNotMatch(theme, /배너 이미지는 600KB 이하로 올려주세요/);
  assert.match(theme, /사진을 자동으로 줄여 올렸습니다/);
});
