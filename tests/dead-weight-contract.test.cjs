'use strict';

// Dead-weight contract: unreferenced CSS rules and unexecuted manual browser
// snippets stay removed. These are static source assertions on purpose: they
// pin the removal without booting browsers or databases. Each item below was
// verified dead before removal — sole importer has no `styles.*` reference,
// no test pins the export, and no dynamic `styles[...]` access builds it.
// (`tableWrap` is deliberately NOT here: web-console-foundation pins it as a
// stable shared export. Dynamic classes such as bannerAlign/bannerOverlay and
// importStepCurrent/importStepDone are NOT here either: importers build them
// at runtime.)

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

test('retired-manual-browser-snippets-stay-gone', () => {
  assert.equal(exists('tests/browser'), false, 'tests/browser must stay removed');
  for (const name of [
    'event-checkin-taskflow', 'event-list-mobile-redesign',
    'event-operations-overview', 'eventouch-ui-micro-polish',
    'mobile-admin-toast-edge-layout', 'mobile-admin-toast-layout',
  ]) {
    assert.equal(
      exists(path.join('tests', 'browser', `${name}.js`)), false, `${name} must stay removed`,
    );
  }
});

test('event-overview-keeps-live-metrics-drops-dead-chip-kit', () => {
  const css = read('apps/web/app/console/events/[id]/event-overview.module.css');
  for (const name of [
    'metricSection', 'metricTrend', 'statusChip', 'actionChip', 'metricRow', 'metricItem',
  ]) {
    assert.doesNotMatch(css, new RegExp(`\\.${name}[\\s.{:]`, 'u'), `.${name} stays removed`);
  }
  assert.doesNotMatch(css, /\.metricCard\.primary\s*\{/u, '.metricCard.primary stays removed');
  // The live contract stays: the importer still renders these.
  const view = read('apps/web/app/console/events/[id]/EventOverview.tsx');
  for (const name of ['metricCard', 'metricGrid', 'metricValue', 'metricLabel', 'metricDetail']) {
    assert.match(view, new RegExp(`styles\\.${name}`, 'u'), `EventOverview still renders ${name}`);
  }
  assert.match(css, /\.metricCard\s*\{/u, '.metricCard stays exported');
});

test('participant-list-keeps-roster-drops-dead-toolbar-dialog-kit', () => {
  const css = read('apps/web/app/console/events/[id]/participants/participants.module.css');
  for (const name of [
    'participantsContent', 'participantToolbar', 'participantCount',
    'participantSelection', 'stateSuccess', 'stateError',
    'dialogBackdrop', 'dialogActions',
  ]) {
    assert.doesNotMatch(css, new RegExp(`\\.${name}[\\s.{:]`, 'u'), `.${name} stays removed`);
  }
  assert.doesNotMatch(css, /^\.dialog\s*\{/mu, 'module .dialog stays removed (the global .dialog owns dialogs)');
  const list = read('apps/web/app/console/events/[id]/participants/ParticipantList.tsx');
  for (const name of ['participantList', 'participantRow', 'rosterHead', 'emptyState']) {
    assert.match(list, new RegExp(`styles\\.${name}`, 'u'), `ParticipantList still renders ${name}`);
  }
});

test('draws-drops-foreign-module-copies-programs-drops-dead-selector', () => {
  const draws = read('apps/web/app/console/events/[id]/draws/draws.module.css');
  assert.doesNotMatch(draws, /\.moduleTop\s*\{/u, 'draws .moduleTop stays removed');
  assert.doesNotMatch(draws, /\.photoArchiveTools/u, 'draws .photoArchiveTools stays removed');
  // Those classes live in programs.module.css and are still rendered there.
  const programsView = read('apps/web/app/console/events/[id]/programs/ProgramsWorkspace.tsx');
  assert.match(programsView, /styles\.moduleTop/u, 'ProgramsWorkspace still renders moduleTop');
  assert.match(programsView, /styles\.photoArchiveTools/u, 'ProgramsWorkspace still renders photoArchiveTools');
  const programs = read('apps/web/app/console/events/[id]/programs/programs.module.css');
  assert.doesNotMatch(programs, /\.actions\s+\.button/u, 'programs .actions selector stays removed');
  assert.match(programs, /\.moduleActions\s+\.button/u, 'programs keeps the live .moduleActions selector');
});

test('home-drops-unused-hint-title-console-drops-unused-primary', () => {
  const home = read('apps/web/app/event/[slug]/home/home.module.css');
  for (const name of ['luckyTitle', 'luckyHint', 'voteHint']) {
    assert.doesNotMatch(home, new RegExp(`\\.${name}\\s*\\{`, 'u'), `.${name} stays removed`);
  }
  assert.match(home, /\.luckyPanel\s*\{/u, '.luckyPanel stays exported');
  assert.match(home, /\.voteTitle\s*\{/u, '.voteTitle stays exported');
  const consoleHome = read('apps/web/app/console/console-home.module.css');
  assert.doesNotMatch(consoleHome, /\.metric-primary/u, 'console-home .metric-primary stays removed');
  assert.match(consoleHome, /\.eventCardTop\s*\{/u, '.eventCardTop stays exported');
  const globals = read('apps/web/app/globals.css');
  assert.doesNotMatch(globals, /\.metric-card\.metric-primary/u, 'globals .metric-card.metric-primary stays removed');
  assert.doesNotMatch(globals, /\.metric-card\s*\{/u, 'globals .metric-card base stays removed');
});
