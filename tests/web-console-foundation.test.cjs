'use strict';

// Shared console foundation contract: the navigation registry and the
// reusable frame (page, toolbar, sections, actions, feedback, section nav,
// dialog) that parallel page migrations build on. These assertions pin the
// exact cross-page API; domain copy and workspace behavior stay in the
// page workspaces and their own tests.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');
const UI = path.join(WEB, 'app/console/console-ui');

function readWeb(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

function readUi(name) {
  return fs.readFileSync(path.join(UI, name), 'utf8');
}

function quotedList(block) {
  return [...block.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

const HOOK_CALL = /\buse(?:State|Effect|Memo|Callback|Ref|Id)\s*\(/u;

test('navigation registry covers all sixteen menu pages as metadata only', () => {
  const nav = readWeb('app/console/console-navigation.ts');

  const unionBlock = nav.match(/export type ConsolePageId =([\s\S]*?);/u);
  assert.ok(unionBlock, 'ConsolePageId union is exported');
  assert.deepEqual(quotedList(unionBlock[1]), [
    'events', 'clients', 'team', 'overview', 'participants', 'participantImport',
    'messages', 'operations', 'programs', 'draws', 'photos', 'content',
    'attendeePage', 'rewards', 'settings', 'reports',
  ]);

  const labels = {
    events: '행사', clients: '고객사', team: '팀·권한', overview: '운영 현황',
    participants: '참가자', participantImport: '명단 가져오기', messages: '메시지',
    operations: '현장 운영', programs: '참여 프로그램', draws: '추첨·투표',
    photos: '현장 사진', content: '콘텐츠', attendeePage: '참가자 페이지',
    rewards: '경품', settings: '행사 설정', reports: '결과 보고서',
  };
  for (const [id, label] of Object.entries(labels)) {
    const scope = ['events', 'clients', 'team'].includes(id) ? 'organization' : 'event';
    assert.match(nav, new RegExp(`${id}: \\{ label: "${label}", title: "[^"]+", scope: "${scope}"`, 'u'), `${id} maps label/title/scope`);
  }

  assert.doesNotMatch(nav, /^import /mu, 'registry stays a pure module');
  assert.doesNotMatch(nav, /\/api\//u, 'registry holds routes, not data fetching');
});

test('navigation exposes rail order, root ids and existing routes', () => {
  const nav = readWeb('app/console/console-navigation.ts');

  const eventIds = nav.match(/export const EVENT_PAGE_IDS: readonly ConsolePageId\[\] = \[([\s\S]*?)\];/u);
  assert.ok(eventIds, 'EVENT_PAGE_IDS is exported');
  assert.deepEqual(quotedList(eventIds[1]), [
    'overview', 'participants', 'messages', 'content', 'attendeePage',
    'operations', 'programs', 'draws', 'rewards', 'photos', 'reports', 'settings',
  ]);

  const mainIds = nav.match(/export const MAIN_PAGE_IDS: readonly ConsolePageId\[\] = \[([\s\S]*?)\];/u);
  assert.ok(mainIds, 'MAIN_PAGE_IDS is exported');
  assert.deepEqual(quotedList(mainIds[1]), ['events', 'clients']);

  assert.match(nav, /export function consolePageHref\(pageId: ConsolePageId, eventId\?: string\): string \| undefined/u);
  assert.match(nav, /if \(!id\) return undefined;/u, 'event pages without an id yield no link');
  assert.match(nav, /encodeURIComponent\(id\)/u);
  for (const route of [
    '"/console"', '"/console/clients"', '"/console/team"',
    '`${base}/participants/import`', '`${base}/messages`', '`${base}/operations`',
    '`${base}/programs`', '`${base}/draws`', '`${base}/photos`',
    '`${base}/content`', '`${base}/page`', '`${base}/rewards`',
    '`${base}/settings`', '`${base}/reports`',
  ]) {
    assert.ok(nav.includes(route), `href covers ${route}`);
  }
  assert.match(nav, /case "overview":\s*\n\s*return base;/u);

  assert.match(nav, /export function resolveConsolePage\(pathname: string\): ConsolePageResolution \| null/u);
  assert.match(nav, /split\(\/\[\?#\]\//u, 'query strings and hashes are ignored');
  assert.match(nav, /decodeURIComponent\(eventMatch\[1\]\)/u);
  assert.match(nav, /if \(segments\.length === 1\)/u, 'single-segment routes classify exactly');
  assert.match(nav, /segments\.length === 2 && segments\[0\] === "participants" && segments\[1\] === "import"/u, 'only the known import child classifies');
  assert.match(nav, /case "page":\s*\n\s*return \{ pageId: "attendeePage", eventId \};/u);
  assert.match(nav, /participantImport → participants/u, 'rail parent is caller-derived');
  assert.doesNotMatch(nav, /startsWith\("import\/"\)/u, 'no prefix matching like import-bogus');
});

test('console frame shares one title, context link and body rhythm', () => {
  const page = readUi('ConsolePage.tsx');

  for (const prop of [
    'pageId: ConsolePageId;', 'eventId?: string;', 'eventName?: string;',
    'meta?: ReactNode;', 'badges?: ReactNode;', 'headerActions?: ReactNode;', 'toolbar?: ReactNode;',
    'feedback?: ReactNode;', 'sectionNav?: ReactNode;',
    'children: ReactNode;', 'className?: string;',
  ]) {
    assert.ok(page.includes(prop), `ConsolePage exposes ${prop}`);
  }
  assert.doesNotMatch(page, /width\?:/u, 'pages choose no arbitrary width');
  assert.doesNotMatch(page, HOOK_CALL, 'frame stays hook-free');
  assert.doesNotMatch(page, /\bback=\{/u, 'no repeated back row; the rail owns navigation (Suspense fallback is not a back prop)');

  assert.match(page, /CONSOLE_PAGES\[pageId\]/u, 'menu title comes from the registry');
  assert.match(page, /title=\{page\.title\}/u);
  assert.match(page, /badges=\{badges\}/u, 'shared header state passes through to the header badges slot');
  assert.match(page, /consolePageHref\("overview", eventId\)/u, 'context links to the overview');
  assert.match(page, /`행사 \/ \$\{trimmedName\}`/u);
  assert.match(page, /className=\{styles\.contextLink\}/u);
  assert.match(page, /<div className=\{styles\.pageFlow\}>\{children\}<\/div>/u, 'body shares one gap');
  assert.match(page, /import Link from "next\/link";/u);

  const css = readUi('console-ui.module.css');
  assert.match(css, /\.page\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*var\(--web-content-max\)[^}]*margin-inline:\s*auto;/su);
});

test('toolbar, section nav and form actions render only what they are given', () => {
  const toolbar = readUi('ConsoleToolbar.tsx');
  for (const prop of ['filters?: ReactNode;', 'actions?: ReactNode;', 'selection?: ReactNode;', 'children?: ReactNode;']) {
    assert.ok(toolbar.includes(prop), `ConsoleToolbar exposes ${prop}`);
  }
  assert.match(toolbar, /if \(!filters && !actions && !selection && !children\) return null;/u, 'no placeholder rows');
  assert.match(toolbar, /\{selection \? <div className=\{styles\.toolbarSelection\}>/u, 'selection owns a conditional row');
  assert.match(toolbar, /<div className=\{styles\.toolbarFilters\}>/u);
  assert.match(toolbar, /<div className=\{styles\.toolbarActions\}>/u);
  assert.doesNotMatch(toolbar, HOOK_CALL);

  const nav = readUi('ConsoleSectionNav.tsx');
  assert.match(nav, /items: readonly ConsoleSectionNavItem\[\];/u);
  assert.match(nav, /if \(!items\.length\) return null;/u, 'empty nav keeps no dead space');
  assert.match(nav, /href=\{`#\$\{item\.id\}`\}/u, 'native anchors to existing heading ids');
  assert.match(nav, /aria-label=\{label \?\? "섹션 바로가기"\}/u);
  assert.doesNotMatch(nav, HOOK_CALL);

  const actions = readUi('ConsoleFormActions.tsx');
  assert.match(actions, /children: ReactNode;/u);
  assert.match(actions, /note\?: ReactNode;/u);
  assert.match(actions, /align\?: "end" \| "between";/u);
  assert.match(actions, /align = "end"/u);
  assert.match(actions, /styles\.formActionsBetween/u);
  assert.doesNotMatch(actions, /onSubmit|fetch\(|commandId/u, 'layout only: no write semantics');
  assert.doesNotMatch(actions, HOOK_CALL);
});

test('feedback and section surfaces reuse tokens with stable semantics', () => {
  const feedback = readUi('ConsoleFeedback.tsx');
  assert.match(feedback, /"success" \| "error" \| "warning" \| "info"/u);
  assert.match(feedback, /role=\{kind === "error" \? "alert" : "status"\}/u);
  assert.match(feedback, /id\?: string;/u);
  assert.doesNotMatch(feedback, HOOK_CALL);

  const css = readUi('console-ui.module.css');
  for (const [kind, token] of [
    ['Success', '--success-soft'], ['Error', '--danger-soft'],
    ['Warning', '--warning-soft'], ['Info', '--info-soft'],
  ]) {
    assert.match(css, new RegExp(`\\.feedback${kind}\\s*\\{[^}]*${token}`, 'su'), `feedback ${kind} reuses its token`);
  }

  const section = readUi('ConsoleSection.tsx');
  assert.match(section, /surface\?: "plain" \| "panel";/u);
  assert.match(section, /width\?: "full" \| "form";/u);
  assert.match(section, /surface = "plain"/u);
  assert.match(section, /width = "full"/u);
  assert.match(section, /<div className=\{styles\.sectionBody\}>\{children\}<\/div>/u);
  assert.doesNotMatch(section, HOOK_CALL);
  assert.match(css, /\.sectionPanel\s*\{[^}]*padding:\s*var\(--s5\)[^}]*background:\s*var\(--paper\)/su);
  assert.match(css, /\.sectionForm\s*>\s*\.sectionBody\s*\{[^}]*max-width:\s*var\(--web-reading-max\)/su);

  const header = readUi('ConsolePageHeader.tsx');
  assert.match(header, /context\?: ReactNode;/u);
  const order = [
    header.indexOf('styles.pageContext'),
    header.indexOf('className={styles.backLink}'),
    header.indexOf('<h1>{title}</h1>'),
  ];
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'context precedes the existing header order');
  assert.doesNotMatch(header, HOOK_CALL);
});

test('dialog owns chrome only, with safe focus handling and busy gating', () => {
  const dialog = readUi('ConsoleDialog.tsx');

  assert.match(dialog, /"use client";/u);
  for (const prop of [
    'title: string;', 'titleId?: string;', 'description?: ReactNode;',
    'descriptionId?: string;',
    'onClose: () => void;', 'busy?: boolean;', 'canClose?: () => boolean;',
    'initialFocusRef?: RefObject<HTMLElement | null>;',
    'children: ReactNode;', 'footer?: ReactNode;', 'wide?: boolean;',
  ]) {
    assert.ok(dialog.includes(prop), `ConsoleDialog exposes ${prop}`);
  }

  assert.match(dialog, /role="dialog"\s+aria-modal="true"\s+aria-labelledby=\{headingId\}/u);
  assert.match(dialog, /aria-describedby=\{description \? descriptionElementId : undefined\}/u, 'safety copy stays associated');
  assert.match(dialog, /descriptionId \?\? `\$\{headingId\}-description`/u, 'deterministic description id');
  assert.match(dialog, /id=\{descriptionElementId\}/u);
  assert.match(dialog, /tabIndex=\{-1\}/u);
  assert.match(dialog, /isVisible\(/u, 'tab trap skips hidden controls');
  assert.match(dialog, /if \(!items\.length\) \{/u, 'empty tabbable set still traps');
  assert.match(dialog, /const outside = active === dialog \|\| !\(active instanceof Node && dialog\.contains\(active\)\);/u, 'container and outside focus wrap');
  assert.match(dialog, /function requestClose\(\) \{/u, 'one guarded close path');
  assert.match(dialog, /if \(busyRef\.current\) return;/u, 'Escape and backdrop wait while busy');
  assert.match(dialog, /if \(canCloseRef\.current && !canCloseRef\.current\(\)\) return;/u, 'synchronous dismissal gate');
  assert.match(dialog, /requestCloseRef\.current\(\);/u, 'Escape uses the guarded path');
  assert.match(dialog, /if \(event\.target === event\.currentTarget\) requestClose\(\);/u, 'backdrop uses the guarded path');
  assert.match(dialog, /!requested\.matches\(":disabled"\)/u, 'initial focus skips disabled controls');
  assert.match(dialog, /document\.body\.style\.overflow = "hidden";/u);
  assert.match(dialog, /document\.body\.style\.overflow = previousOverflow;/u);
  assert.match(dialog, /previouslyFocused && previouslyFocused\.isConnected/u, 'focus restores only when connected');
  assert.match(dialog, /className=\{wide \? `dialog \$\{styles\.dialogWide\}` : "dialog"\}/u);
  assert.match(dialog, /<div className="dialog-actions">\{footer\}<\/div>/u);
  assert.doesNotMatch(dialog, /useState\s*\(/u, 'no form state');
  assert.doesNotMatch(dialog, /commandId/i, 'no idempotency ownership');
});

test('shared body patterns export stable classes without duplicating controls', () => {
  const css = readUi('console-ui.module.css');
  for (const name of [
    'formStack', 'formGrid', 'field', 'checkRow', 'collection',
    'recordRow', 'recordMain', 'recordMeta', 'recordActions',
    'empty', 'tableWrap',
  ]) {
    assert.match(css, new RegExp(`\\.${name}\\s*\\{`, 'u'), `.${name} is exported`);
  }

  assert.doesNotMatch(css, /^\.button[\s,{]/mu, 'no local .button class to mismatch the global one');
  assert.doesNotMatch(css, /(^|\s)(input|select|textarea|button)\s*\{/mu, 'controls keep their global height and color rules');

  for (const name of ['pageFlow', 'pageHeader', 'section', 'statePanel']) {
    assert.match(css, new RegExp(`\\.${name}\\s*\\{`, 'u'), `existing .${name} export stays compatible`);
  }
  const header = readUi('ConsolePageHeader.tsx');
  assert.match(header, /formatConsoleEventMeta/u);
  assert.match(header, /actions\?: ReactNode;/u);
  const section = readUi('ConsoleSection.tsx');
  assert.match(section, /density\?: "default" \| "compact";/u);
  assert.match(section, /divider\?: boolean;/u);

  assert.match(css, /@media \(max-width: 768px\)/u);
  assert.match(css, /@media \(max-width: 1024px\)/u);
  assert.match(css, /@media \(max-width: 768px\)\s*\{[^}]*\.pageHeader/su, 'header stacks with toolbar/forms/records at 768');
  assert.doesNotMatch(css, /max-width:\s*680px/u, 'no orphan 680px header breakpoint');

  for (const name of [
    'toolbar', 'sectionNav', 'formActions', 'pageContext',
    'pageActions', 'sectionAction', 'recordActions',
  ]) {
    assert.match(css, new RegExp(`@media print\\s*\\{[\\s\\S]*?\\.${name}`, 'u'), `.${name} hides in print`);
  }
  assert.match(css, /@media print[\s\S]*?:global\(\.dialog-backdrop\)/u, 'mounted dialogs stay out of printed pages');
  assert.doesNotMatch(css, /\.sectionBody\s*\{[^}]*display:\s*none/su, 'section bodies always print');
  assert.doesNotMatch(css, /\.tableWrap\s*\{[^}]*display:\s*none/su, 'tables always print');
});

test('toolbar responsive composition keeps actions on the first control row', () => {
  const css = readUi('console-ui.module.css');

  assert.match(css, /\.toolbarMain\s*\{[^}]*align-items:\s*flex-start/su, 'actions ride the first row, never float centered');
  assert.match(css, /\.toolbarFilters\s*>\s*\*\s*\{[^}]*flex:\s*1 1 200px/su, 'filters wrap from a readable neutral basis');
  assert.doesNotMatch(css, /\.toolbarFilters\s*>\s*:first-child/u, 'a positional assumption must not squeeze a later search');
  assert.match(css, /@media \(max-width: 1024px\)\s*\{[^}]*\.toolbarFilters\s*\{[^}]*flex-basis:\s*100%/su, 'full-row filters kept at 1024');
  assert.match(css, /\.toolbarFilters\s*>\s*\[data-toolbar-span="full"\]\s*\{[^}]*flex-basis:\s*100%/su, 'callers explicitly identify full-row filters');
  assert.match(css, /\.toolbarSelection\s*\{[^}]*min-height:\s*44px/su, 'selection row keeps touch height');
  assert.doesNotMatch(css, /\.toolbar\w*\s*\{[^}]*[{;]\s*height:/su, 'no fixed control heights in toolbar rules');
  assert.doesNotMatch(css, /(^|[\s{;])width:\s*\d+px/um, 'no per-page magic pixel widths');
});
