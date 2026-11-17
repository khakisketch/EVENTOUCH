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
const { createRequire } = require('node:module');
const webRequire = createRequire(path.join(__dirname, '../apps/web/package.json'));
const postcss = webRequire('postcss');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');
const UI = path.join(WEB, 'app/console/console-ui');

function readWeb(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

function readUi(name) {
  return fs.readFileSync(path.join(UI, name), 'utf8');
}

// Match exact selectors in their actual media scope, never the first media block.
function cssDeclarations(css, selector, media = null) {
  const matches = [];
  postcss.parse(css).walkRules((rule) => {
    if (!rule.selectors.includes(selector)) return;
    const scopes = [];
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule') scopes.unshift(parent.name + ' ' + parent.params);
    }
    const expected = selector === '.console-main'
      ? media ? ['layer eventouch-legacy', 'media ' + media] : ['layer eventouch-legacy']
      : media ? ['media ' + media] : [];
    if (JSON.stringify(scopes) === JSON.stringify(expected)) matches.push(rule);
  });
  assert.equal(matches.length, 1, selector + ' has one rule in ' + (media ?? 'the base scope'));
  return Object.fromEntries(matches[0].nodes.filter((node) => node.type === 'decl').map((node) => [node.prop, node.value]));
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

  // The rail names the participants destination apart from its hub: the
  // hub reads "참가자", the page reads "참가자 명단".
  const labels = {
    events: '행사', clients: '고객사', team: '팀·권한', overview: '운영 현황',
    participants: '참가자 명단', participantImport: '명단 가져오기', messages: '메시지',
    operations: '현장 운영', programs: '참여 콘텐츠', draws: '추첨·투표',
    photos: '현장 사진', content: '공지·안내', attendeePage: '참가자 페이지',
    rewards: '경품 지급 현황', settings: '행사 설정', reports: '결과 보고서',
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

  // One ordering authority: the flat page list derives from the hubs, and
  // participantImport rides the participants hub so the rail can name it.
  assert.match(nav, /export const EVENT_PAGE_IDS: readonly ConsolePageId\[\] = EVENT_HUBS\.flatMap\(\(hub\) => hub\.pageIds\);/u, 'hubs own the order');
  for (const pages of [
    'pageIds: ["overview", "participants", "messages"]',
    'pageIds: ["operations", "draws", "rewards", "photos"]',
    'pageIds: ["attendeePage", "content", "programs", "settings"]',
    'pageIds: ["reports"]',
  ]) assert.ok(nav.includes(pages), `work group keeps ${pages}`);
  const hubOrder = ['"today"', '"onsite"', '"prepare"', '"results"'].map((id) => nav.indexOf(`{ id: ${id}`));
  assert.ok(hubOrder.every((position) => position >= 0));
  assert.deepEqual(hubOrder, [...hubOrder].sort((a, b) => a - b));

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
  assert.match(page, /title=\{title \?\? page\.title\}/u, 'nested task title falls back to the registered menu title');
  assert.match(page, /badges=\{badges\}/u, 'shared header state passes through to the header badges slot');
  assert.match(page, /consolePageHref\("overview", eventId\)/u, 'context links to the overview');
  assert.match(page, /`행사 \/ \$\{trimmedName\}`/u);
  assert.match(page, /className=\{styles\.contextLink\}/u);
  assert.match(page, /<div className=\{styles\.pageFlow\}>\{children\}<\/div>/u, 'body shares one gap');
  assert.match(page, /import Link from "\.\.\/\.\.\/ui\/ProductLink";/u);

  const css = readUi('console-ui.module.css');
  const frame = cssDeclarations(css, '.page');
  assert.equal(frame.width, '100%');
  assert.equal(frame['max-width'], 'var(--web-content-max)');
  assert.equal(frame['min-width'], '0');
  assert.equal(frame['margin-inline'], '0', 'bounded workspace aligns with its rail-side content edge, not the viewport center');
  assert.equal(cssDeclarations(readWeb('app/globals.css'), '.console-main').background, 'var(--workspace-ground)');
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
  assert.match(nav, /mode === "tabs"/u);
  assert.match(nav, /role="tablist"/u);

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
  assert.match(feedback, /<ProductNotice kind=\{kind\} id=\{id\}>\{children\}<\/ProductNotice>/u);
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
  // Self-contained panels lift onto paper; a form caps the whole editing
  // unit, so its heading and controls share the same bounded workspace.
  const panel = cssDeclarations(css, '.sectionPanel');
  assert.equal(panel.padding, 'var(--s5)');
  assert.equal(panel.border, '1px solid var(--line)');
  assert.equal(panel['border-radius'], 'var(--radius-card)');
  assert.equal(panel.background, 'var(--paper)');
  const form = cssDeclarations(css, '.sectionForm');
  assert.equal(form.width, '100%');
  assert.equal(form['max-width'], 'var(--web-reading-max)');
  assert.equal(cssDeclarations(css, '.sectionForm > :global(.astryx-section) > .sectionBody')['max-width'], 'none');
  assert.equal(cssDeclarations(css, '.sectionPanel', '(max-width: 768px)').padding, 'var(--s4)');

  const header = readUi('ConsolePageHeader.tsx');
  assert.match(header, /context\?: ReactNode;/u);
  const order = [
    header.indexOf('className={styles.backLink}'),
    header.indexOf('styles.pageContext'),
    header.indexOf('<Heading level={1}>{title}</Heading>'),
  ];
  assert.ok(order.every((position) => position >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'optional back stays first; event context precedes its task title');
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

  assert.match(dialog, /role="dialog"\s+aria-modal=\{docked \? undefined : true\}\s+aria-labelledby=\{headingId\}/u);
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
  assert.match(dialog, /if \(!docked && event\.target === event\.currentTarget\) requestClose\(\);/u, 'backdrop uses the guarded path');
  assert.match(dialog, /!requested\.matches\(":disabled"\)/u, 'initial focus skips disabled controls');
  assert.match(dialog, /document\.body\.style\.overflow = "hidden";/u);
  assert.match(dialog, /document\.body\.style\.overflow = previousOverflow;/u);
  assert.match(dialog, /previouslyFocused && previouslyFocused\.isConnected/u, 'focus restores only when connected');
  assert.match(dialog, /className=\{docked \? styles\.inspectorPanel : drawer \? `dialog \$\{styles\.drawerPanel\}` : stage \? `dialog \$\{styles\.stagePanel\}` : wide \? `dialog \$\{styles\.dialogWide\}` : "dialog"\}/u);
  assert.match(dialog, /presentation\?: "modal" \| "inspector" \| "drawer" \| "stage";/u, 'drawer and stage are modal presentations: same trap, Escape and scroll lock');
  assert.match(dialog, /<div className="dialog-actions">\{footer\}<\/div>/u);
  assert.match(dialog, /useSyncExternalStore\(subscribeWideViewport/u, 'responsive presentation uses the current viewport snapshot');
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
  const mobileHeader = cssDeclarations(css, '.pageHeader', '(max-width: 768px)');
  assert.equal(mobileHeader['column-gap'], 'var(--s3)');
  assert.equal(mobileHeader['padding-bottom'], 'var(--s4)');
  for (const selector of ['.pageHeader:has(.pageActions > :nth-child(2))', '.pageHeader:has(.pageActions > :global(.console-header-group))']) {
    const rule = cssDeclarations(css, selector, '(max-width: 768px)');
    assert.equal(rule['grid-template-columns'], 'minmax(0, 1fr)');
    assert.equal(rule['grid-template-areas'], '"back" "context" "title" "meta" "badges" "actions"');
  }
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
