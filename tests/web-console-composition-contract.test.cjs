'use strict';

// The new console layout primitives are the shared contract for the first
// migrated event pages. Keep copy/permissions/actions in their workspaces;
// centralize only header, section and loading/failure composition.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'apps/web');

function read(rel) {
  return fs.readFileSync(path.join(WEB, rel), 'utf8');
}

const targets = [
  'app/console/events/[id]/EventOverview.tsx',
  'app/console/events/[id]/participants/ParticipantList.tsx',
  'app/console/events/[id]/participants/import/ImportWizard.tsx',
  'app/console/events/[id]/content/ContentWorkspace.tsx',
  'app/console/events/[id]/messages/MessagingWorkspace.tsx',
];

test('console layout primitives expose stable, hook-free composition', () => {
  const header = read('app/console/console-ui/ConsolePageHeader.tsx');
  const section = read('app/console/console-ui/ConsoleSection.tsx');
  const state = read('app/console/console-ui/ConsoleStatePanel.tsx');

  for (const source of [header, section, state]) {
    assert.doesNotMatch(source, /\buse(?:State|Effect|Memo|Callback|Ref|Id)\s*\(/);
  }

  const headerOrder = [
    header.indexOf('className={styles.backLink}'),
    header.indexOf('<h1>{title}</h1>'),
    header.indexOf('className={styles.pageMeta}'),
    header.indexOf('className={styles.pageBadges}'),
    header.indexOf('className={styles.pageActions}'),
  ];
  assert.ok(headerOrder.every((position) => position >= 0));
  assert.deepEqual(headerOrder, [...headerOrder].sort((a, b) => a - b));

  assert.match(section, /<section className=\{classNames\} aria-labelledby=\{headingId\}>/);
  assert.match(section, /<h2 className=\{styles\.sectionTitle\} id=\{headingId\}>\{title\}<\/h2>/);
  assert.match(header, /formatConsoleEventMeta/);
  assert.match(header, /actions\?: ReactNode/);
  assert.match(section, /action\?: ReactNode/);
});

test('state panel unifies loading, alert and shell-aware retry', () => {
  const state = read('app/console/console-ui/ConsoleStatePanel.tsx');
  assert.match(state, /role=\{loading \? "status" : "alert"\}/);
  assert.match(state, /window\.dispatchEvent\(new CustomEvent\("eventouch:shell-reload"\)\)/);
  assert.match(state, /onRetry\(\)/);
  assert.match(state, />\s*다시 불러오기\s*</);
  assert.match(state, /actions\?: ReactNode/);
});

test('first event pages all compose from the common header, sections and state panel', () => {
  for (const target of targets) {
    const source = read(target);
    for (const component of ['ConsolePageHeader', 'ConsoleSection', 'ConsoleStatePanel']) {
      assert.match(source, new RegExp(`import ${component}\\b`), `${target} imports ${component}`);
      assert.match(source, new RegExp(`<${component}\\b`), `${target} renders ${component}`);
    }
    assert.match(source, /kind="loading"/u, `${target} uses the shared loading state`);
    assert.match(source, /kind="failed"/u, `${target} uses the shared failed state`);
    assert.doesNotMatch(source, /className="eyebrow"|className=\{[^}]*eyebrow/);
  }
});

test('event child pages use one header back link and keep action slots secondary', () => {
  const childPages = targets.slice(1);
  for (const target of childPages) {
    assert.match(read(target), /label:\s*"← 운영 현황"/u, `${target} has the common back link`);
  }
  assert.doesNotMatch(read(targets[0]), /label:\s*"← 운영 현황"/u);

  const content = read(targets[3]);
  assert.match(content, /action=\{\([\s\S]*?<button type="button" className="button button-secondary" onClick=\{openNoticeCreate\}>\s*공지 작성/u);
  assert.match(content, /title="프로그램 일정"[\s\S]*?action=\{\([\s\S]*?className="button button-secondary"[\s\S]*?일정 추가/u);

  const participants = read(targets[1]);
  assert.match(participants, /className="button button-secondary"[\s\S]*?changeStatus\(person, "APPROVED"\)/u);
  assert.doesNotMatch(participants, /changeStatus\(person, "APPROVED"\)[\s\S]{0,100}button-primary/u);
  assert.doesNotMatch(read(targets[0]), /button-primary/u, 'operations overview keeps zero primary actions');

  const messages = read(targets[4]);
  assert.equal((messages.match(/className="button button-primary"/gu) ?? []).length, 1);
  assert.doesNotMatch(content, />\s*운영 현황\s*<\/Link>/u);
  assert.doesNotMatch(participants, />\s*운영 현황으로\s*<\/Link>/u);
  assert.doesNotMatch(messages, />\s*운영 현황\s*<\/Link>/u);
});

test('thin participant route wrappers and overview do not add legacy eyebrows', () => {
  const paths = [
    'app/console/events/[id]/page.tsx',
    'app/console/events/[id]/participants/page.tsx',
    'app/console/events/[id]/participants/import/page.tsx',
  ];
  for (const target of paths) {
    assert.doesNotMatch(read(target), /eyebrow/u, `${target} has no eyebrow`);
  }
  assert.match(read(paths[0]), /<EventOverview eventId=\{id\} \/>/u);
  assert.match(read(paths[1]), /<ParticipantList eventId=\{id\} \/>/u);
  assert.match(read(paths[2]), /<ImportWizard eventId=\{id\} \/>/u);
});
