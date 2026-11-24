'use strict';

// Mobile task-density contract for the console workspaces pass: the phone
// viewport must reach the operator's first task quickly — search, analysis
// KPIs, preview status — instead of stacking every control into full-width
// rows. Static source assertions on purpose: they pin the seam without
// booting Next.js. Rendered verification (412/360/1280 captures, print,
// snapshot flows) happens outside the suite — main owns DB/browser/servers.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = path.join(__dirname, '..', 'apps', 'web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const PARTICIPANTS = 'app/console/events/[id]/participants/ParticipantList.tsx';
const PARTICIPANTS_CSS = 'app/console/events/[id]/participants/participants.module.css';
const ATTENDEE_PAGE_CSS = 'app/console/events/[id]/page/page.module.css';
const REPORTS = 'app/console/events/[id]/reports/ReportsWorkspace.tsx';
const REPORTS_CSS = 'app/console/events/[id]/reports/reports.module.css';

test('mobile-workspaces: roster search owns its row, advanced selects disclose', () => {
  const list = read(PARTICIPANTS);
  // Search is the primary every-visit control: full width on every viewport.
  assert.match(list, /data-toolbar-span="full"/u, 'search opts into its own toolbar row');
  // The advanced selects collapse behind one readable disclosure at
  // <=768px. Always rendered (no media-query JS, no hydration split): CSS
  // hides the toggle on desktop and the panel when closed on mobile.
  assert.match(list, /id="roster-filter-toggle"/u, 'disclosure has a stable selector');
  assert.match(list, /aria-expanded=\{filtersOpen\}/u, 'toggle reports its state');
  assert.match(list, /aria-controls="roster-advanced-filters"/u, 'toggle names its panel');
  assert.match(list, /id="roster-advanced-filters"/u, 'panel has a stable selector');
  assert.match(list, /data-open=\{filtersOpen \? "true" : "false"\}/u, 'panel state is CSS-driven');
  assert.match(list, /필터/u, 'toggle reads as 필터');
  assert.match(list, /개 적용 중/u, 'toggle carries the active count');
  // A pre-filtered deep link opens the disclosure so the operator sees why the list is narrow.
  // Status is not in the panel any more (2026-11-24): the pressed status tab shows it.
  assert.match(list, /if \(initial\.group \|\| initial\.attendance \|\| initial\.ticket\) \{\s*setFiltersOpen\(true\);/u, 'URL filters including ticket review default the disclosure open');
  // Filter values survive open/close; only the explicit reset clears them —
  // and the reset never touches the checkbox selection.
  const reset = list.match(/function clearRosterFilters\(\) \{[^}]*\}/u);
  assert.ok(reset, 'reset is one named function');
  for (const setter of ['setQuery', 'setStatusFilter', 'setGroupFilter', 'setAttendanceFilter', 'setTicketFilter']) {
    assert.match(reset[0], new RegExp(setter), `reset clears via ${setter}`);
  }
  assert.doesNotMatch(reset[0], /setSelectedIds/, 'reset clears ONLY filters, not the selection');
  assert.match(list, /id="roster-filter-reset"/u, 'reset has a stable selector');
  assert.match(list, /검색·필터 초기화/u, 'reset label says the search goes too');
});

test('mobile-workspaces: roster selects keep their accessible names inside the panel', () => {
  const list = read(PARTICIPANTS);
  // Audit locators stay valid: the same label ids and aria wiring, now nested
  // in the disclosure panel (open it first on narrow screens).
  for (const name of ['search', 'group', 'attendance', 'ticket']) {
    assert.match(list, new RegExp(`id="roster-${name}-label"`, 'u'), `${name} label id stays`);
    assert.match(list, new RegExp(`aria-labelledby="roster-${name}-label"`, 'u'), `${name} wiring stays`);
  }
  assert.match(list, /filters=\{/u, 'toolbar keeps its filters slot');
  assert.match(list, /actions=\{/u, 'toolbar keeps its actions slot');
  assert.match(list, /styles\.selectionWorkbench\}[\s\S]*?anySelected && canAssignGroup/u, 'selection actions stay conditional and adjacent to the list');
  assert.match(list, /id="roster-send-message"/u, 'message handoff selector stays');
});

test('mobile-workspaces: roster disclosure CSS hides without focus traps', () => {
  const css = read(PARTICIPANTS_CSS);
  assert.match(css, /\.filterToggle\s*\{[^}]*display:\s*inline-flex/su, 'B workbench discloses optional filters at every width');
  assert.match(css, /\.advancedFilters\s*\{[^}]*display:\s*contents/su, 'panel joins the desktop toolbar row');
  assert.match(css, /\.advancedFilters\[data-open="false"\]\s*\{[^}]*display:\s*none/su, 'closed panel collapses on mobile');
  assert.match(css, /\.advancedFilters\[data-open="true"\]/su, 'open panel lays out on mobile');
  assert.match(css, /@media \(max-width:\s*768px\)/u, 'disclosure follows the shared 768 breakpoint');
  // Closing while a select holds focus returns focus to the toggle instead
  // of stranding keyboard users on a display:none control.
  assert.match(read(PARTICIPANTS), /advancedFiltersRef\.current\?\.contains\(active\)/u, 'close recovers focus from the panel');
});

test('mobile-workspaces: CSV and import ride one compact secondary pair', () => {
  const list = read(PARTICIPANTS);
  // Support utilities, not the every-visit primary: paired inline, both
  // secondary, never a tall full-width primary ahead of the list.
  assert.match(list, /data-toolbar-inline/u, 'utilities opt into the paired inline group');
  assert.match(list, /CSV 내보내기 · 검색·필터 결과 \$\{visiblePeople\.length\}명/u, 'export accessible name retains its exact filtered count');
  assert.match(list, /participantExportFilename\(state\.eventName, "csv"\)/u, 'download target stays');
  assert.match(list, /<ImportWizard eventId=\{eventId\}/u, 'import route stays');
  assert.match(list, /명단 가져오기/u, 'import action stays and matches its destination');
  assert.doesNotMatch(list, /button-primary" href=\{`\/console\/events\/\$\{encodeURIComponent\(eventId\)\}\/participants\/import`\}/u, 'import is no longer a full-width primary');
  assert.match(list, /canMutateStatus \? <ProductButton type="button" variant="ghost" onClick=\{\(\) => setImportOpen\(true\)\}/u, 'import stays gated and opens a quiet modal action');
});

// Reopened 2026-11-20 (디자인 시스템 적용): the old preview header / live mark rules were dead
// layout leftovers and are gone; the phone's mobile contract is the studio stage collapsing
// and the editor's panels wrapping Korean without squishing.
test('mobile-workspaces: attendee page editor wraps without squishing Korean', () => {
  const css = read(ATTENDEE_PAGE_CSS);
  assert.doesNotMatch(css, /\.previewHeader|\.liveMark|\.statePill/u, 'dead preview-header and bespoke pill rules are removed');
  assert.match(css, /\.conflictPanel \.panelTitle, \.conflictPanel p \{[^}]*word-break:\s*keep-all/su, 'conflict copy keeps Korean syllables whole');
  assert.match(css, /@media \(max-width: 680px\)[\s\S]*\.conflictPanel \{ flex-direction: column; \}/u, 'conflict actions stack under the copy on phones');
  assert.match(css, /\.saveBar \.versionSummary \{[^}]*flex-wrap:\s*nowrap/su, 'the save bar status stays one row');
});

test('mobile-workspaces: analysis header folds refresh and stamp beside the KPIs', () => {
  const reports = read(REPORTS);
  // 새로고침 stays beside the 결과 분석 h3 inside the rail's analysis box —
  // a secondary slot action, never a new stacked 44px body row. 2026-11-15:
  // 결과 분석 is no longer its own ConsoleSection/tab (always visible in the
  // rail now), so its identity moved from headingId to a plain id.
  assert.match(reports, /id="reports-analysis" data-workspace-section="reports-analysis"/u, 'analysis section stays');
  // 2026-11-10: 동일한 새로고침 버튼의 접근 이름을 화면에 맞게 구체화했다(시각 변화 없음).
  assert.match(reports, /<ConsoleRefreshButton label="결과 분석 새로고침"/u, 'refresh action stays');
  // The frozen basis stamp moves into the description next to the header
  // instead of stacking its own row above the KPIs; the explanation persists.
  assert.match(reports, /누적 입장은 한 번 이상 입장한 참가자 기준/u, 'explanation persists');
  assert.match(reports, /조회 기준 시각/u, 'stamp phrase persists');
  assert.match(reports, /styles\.stamp/u, 'stamp rides the compact header style');
  assert.doesNotMatch(reports, /<p className=\{styles\.help\}>조회 기준 시각/u, 'stamp no longer stacks a body row');
  // The redesign moves the create action from a separate toolbar into the
  // report-list header. It remains a real, permission-gated action; the
  // toolbar's former DOM placement was a presentation-only contract.
  const reportList = reports.slice(reports.indexOf('headingId="reports-list"'), reports.indexOf('</ConsoleSection>', reports.indexOf('headingId="reports-list"')));
  assert.match(reportList, /action=\{\(/u, 'create lives in the report section header');
  assert.match(reportList, /disabled=\{writeLocked \|\| !reportSourcesAvailable\}/u, 'create respects permission, archive lock, and source availability');
  assert.match(reportList, /onClick=\{openReportCreate\}/u, 'create opens the existing protected form');
  assert.match(reportList, />\s*보고서 만들기\s*</u, 'create action stays obvious');
  // Print/snapshot output is untouched: no DOM-cloning changes.
  assert.match(reports, /cloneNode\(true\)/u, 'print still clones the rendered article');
  assert.match(reports, /EVENTOUCH · 결과 보고서/u, 'print eyebrow stays');
  assert.match(reports, /headingId="reports-list"/u, 'frozen list section stays');
  const css = read(REPORTS_CSS);
  assert.match(css, /\.metricGrid\s*\{[^}]*repeat\(auto-fit, minmax\(140px, 1fr\)\)/su, 'KPI grid keeps its tracks');
  assert.match(css, /@media \(max-width:\s*768px\)[\s\S]*?\.metricCard\s*\{[^}]*padding:\s*var\(--s3\)/u, 'phone density tightens rhythm, not type');
});
