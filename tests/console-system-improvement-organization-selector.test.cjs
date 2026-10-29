'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('../apps/web/node_modules/typescript');
const compile = (file) => ts.transpileModule(fs.readFileSync(file, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const redirects = {};
vm.runInNewContext(compile('apps/web/app/auth-redirect.ts'), { exports: redirects, URLSearchParams });

function harness(fetcher, options = {}) {
  const exports = {}, requests = [], accepted = [], observed = [], renewed = [], navigations = [], events = [];
  let invalidations = 0;
  const context = options.context === null ? null : { organizationId: 'A', organizationName: '운영사 A', contextVersion: 1, role: 'AGENCY', userId: 'same-account', userName: '검증 사용자' };
  const fake = {
    exports, Response, AbortController, Event, URLSearchParams,
    window: { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {}, dispatchEvent(event) { events.push(event.type); }, location: { search: options.search ?? '', assign(value) { navigations.push(value); } } },
    require(name) {
      if (name === './operator-context') return {
        getOperatorContextSnapshot: () => ({ context }),
        operatorFetch: async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return fetcher(url, init); },
        acceptOperatorContext: (user) => accepted.push(user),
        observeSelectedOrganization: (user) => observed.push(user),
        renewPinnedOrganizationVersion: (user) => { renewed.push(user); return options.renewResult !== undefined ? options.renewResult : true; },
        listUncertainAttempts: () => (options.uncertain ?? []),
        refreshOperatorContext: async () => {},
      };
      if (name === './console-api') return { invalidateConsoleReads: () => { invalidations += 1; } };
      if (name === '../app/auth-redirect') return redirects;
      throw new Error(`unexpected dependency ${name}`);
    },
  };
  vm.runInNewContext(compile('apps/web/lib/organization-selection.ts'), fake);
  return { api: exports, requests, accepted, observed, renewed, navigations, events, invalidations: () => invalidations };
}
const attempt = { organizationId: 'B', organizationName: '운영사 B', commandId: 'same-selection-receipt', expectedContextVersion: 1, mode: 'switch' };
const switched = { user: { id: 'same-account', organizationId: 'B', organizationName: '운영사 B', role: 'STAFF', contextVersion: 2 } };

test('lost organization selection retries the same nonce, target, and expected version', async () => {
  let count = 0;
  const h = harness(async () => ++count === 1 ? Response.json({ error: 'fixture loss' }, { status: 503 }) : Response.json(switched));
  await h.api.selectOrganization(attempt);
  assert.equal(h.api.getOrganizationSelectionSnapshot().uncertain, true);
  assert.deepEqual(h.navigations, []);
  await h.api.selectOrganization();
  assert.equal(h.requests.length, 2);
  assert.deepEqual(h.requests[0].body, h.requests[1].body);
  assert.deepEqual(h.requests[1].body, { organizationId: 'B', commandId: 'same-selection-receipt', expectedContextVersion: 1 });
  assert.deepEqual(h.navigations, ['/staff']);
  assert.equal(h.accepted.length, 0, 'old A view must never pin B before document navigation');
  assert.equal(h.observed[0].organizationId, 'B');
  assert.ok(h.events.includes('eventouch:organization-confirmed-exit'));
});

test('explicit original-org recovery preserves the working view and only accepts that organization', async () => {
  const h = harness(async () => Response.json({ user: { organizationId: 'A', organizationName: '운영사 A', role: 'AGENCY', contextVersion: 3 } }));
  await h.api.selectOrganization({ ...attempt, organizationId: 'A', organizationName: '운영사 A', mode: 'restore', expectedContextVersion: 2 });
  assert.equal(h.accepted[0].organizationId, 'A');
  assert.equal(h.accepted[0].contextVersion, 3);
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.events, [], 'same-org receipt recovery cannot discard draft guards');
  assert.match(h.api.getOrganizationSelectionSnapshot().notice, /같은 요청/);
});

test('restore with a changed actual role renews only the version and never navigates', async () => {
  const changed = { user: { id: 'same-account', organizationId: 'A', organizationName: '운영사 A', role: 'STAFF', contextVersion: 4 } };
  const h = harness(async () => Response.json(changed), { uncertain: [{ key: 'cmd-role', organizationId: 'A' }] });
  await h.api.selectOrganization({ ...attempt, organizationId: 'A', organizationName: '운영사 A', mode: 'restore', expectedContextVersion: 2 });
  assert.equal(h.accepted.length, 0, 'a changed role never accepts the old view');
  assert.equal(h.observed.length, 0, 'a changed role never installs a new view before the explicit move');
  assert.equal(h.renewed.length, 1, 'only the header version renews');
  assert.equal(h.renewed[0].role, 'STAFF', 'the actual server role drives the renewal');
  assert.equal(h.renewed[0].contextVersion, 4);
  assert.deepEqual(h.navigations, [], 'no guessed home and no auto exit while receipts are pending');
  assert.deepEqual(h.events, [], 'no draft-guard exit without navigation');
  assert.match(h.api.getOrganizationSelectionSnapshot().notice, /미확인 요청/);
});

test('restore with a changed actual role and no pending receipts still never navigates', async () => {
  const changed = { user: { id: 'same-account', organizationId: 'A', organizationName: '운영사 A', role: 'MANAGER', contextVersion: 5 } };
  const h = harness(async () => Response.json(changed));
  await h.api.selectOrganization({ ...attempt, organizationId: 'A', organizationName: '운영사 A', mode: 'restore', expectedContextVersion: 2 });
  assert.equal(h.accepted.length, 0);
  assert.equal(h.observed.length, 0);
  assert.equal(h.renewed.length, 1);
  assert.deepEqual(h.navigations, [], 'the explicit role check owns the move home');
  assert.match(h.api.getOrganizationSelectionSnapshot().notice, /현재 역할을 다시 확인/);
  assert.doesNotMatch(h.api.getOrganizationSelectionSnapshot().notice, /미확인 요청/);
});

test('an inactive membership is an explicit error, not a login or automatic fallback switch', async () => {
  const h = harness(async () => Response.json({ error: 'private fixture details' }, { status: 403 }));
  await h.api.selectOrganization(attempt);
  assert.equal(h.api.getOrganizationSelectionSnapshot().attempt, null);
  assert.match(h.api.getOrganizationSelectionSnapshot().error, /활성 소속/);
  assert.doesNotMatch(h.api.getOrganizationSelectionSnapshot().error, /private fixture/);
  assert.deepEqual(h.navigations, []);
});

test('synchronous duplicate selection cannot transmit a second command', async () => {
  let release;
  const h = harness(() => new Promise((resolve) => { release = resolve; }));
  const first = h.api.selectOrganization(attempt);
  await h.api.selectOrganization({ ...attempt, commandId: 'different-key' });
  assert.equal(h.requests.length, 1);
  release(Response.json(switched));
  await first;
});

test('selection refuses missing or invalid CAS versions before transmission', async () => {
  for (const version of [undefined, null, '1', -1, 1.5, NaN, Infinity]) {
    const h = harness(async () => { throw new Error('must not transmit invalid selection'); });
    await h.api.selectOrganization({ ...attempt, expectedContextVersion: version });
    assert.equal(h.requests.length, 0, `invalid version ${String(version)}`);
    assert.equal(h.api.getOrganizationSelectionSnapshot().uncertain, false);
    assert.match(h.api.getOrganizationSelectionSnapshot().error, /접속 정보를 확인하지 못했습니다/);
  }
});

test('definitive selection conflict clears only its attempt and never navigates to a guessed home', async () => {
  const h = harness(async () => Response.json({ code: 'ORGANIZATION_CONTEXT_CHANGED' }, { status: 409 }));
  await h.api.selectOrganization(attempt);
  assert.equal(h.api.getOrganizationSelectionSnapshot().attempt, null);
  assert.equal(h.api.getOrganizationSelectionSnapshot().uncertain, false);
  assert.match(h.api.getOrganizationSelectionSnapshot().error, /다른 탭/);
  assert.deepEqual(h.navigations, []);
  assert.deepEqual(h.accepted, []);
});

test('authenticated unselected identity selects explicitly and returns only to a validated invite', async () => {
  const token = 'safe_'.repeat(9);
  const h = harness(async () => Response.json(switched), { context: null, search: `?chooseOrganization=1&next=${encodeURIComponent('/invite/' + token)}` });
  await h.api.selectOrganization(attempt);
  assert.deepEqual(h.navigations, ['/invite/' + token]);
  for (const unsafe of ['https://evil.test', '//evil.test', '/console/events/old-org', '/invite/short', '/invite/' + token + '?next=https://evil.test', '/invite/%2F%2Fevil.test']) {
    assert.equal(h.api.organizationSelectionDestination('STAFF', `?next=${encodeURIComponent(unsafe)}`), '/staff');
  }
});

test('selector exposes only real membership choices and freezes unknown selection/create inputs', () => {
  const source = fs.readFileSync('apps/web/app/OrganizationSwitcher.tsx', 'utf8');
  assert.match(source, /state\.organizations\.length > 1 \|\| \(!state\.activeOrganizationId/);
  assert.match(source, /disabled=\{pending \|\| blockedWrites\}/);
  assert.match(source, /mode: restoring \? "restore" : "switch"/);
  assert.match(source, /const roleTransition = restoring && target\.role !== live\.context\?\.role/);
  assert.match(source, /\(!restoring \|\| roleTransition\) && confirmLeave && !confirmLeave\(\)/);
  assert.match(source, /createAttempt\.current \?\?/);
  assert.match(source, /disabled=\{createBusy \|\| createUnknown\}/);
  assert.match(source, /소속 운영사를 확인하고 있습니다/);
  assert.match(source, /활성 운영사 소속이 없습니다/);
  assert.match(source, /새 운영사는 발송 미연동 상태/);
  assert.doesNotMatch(source, /setInterval|router\.replace|router\.push/);
});

// ---- OrganizationContextNotice rendered recovery (SSR mock, no events) ----
// Pattern follows console-system-improvement-errors.test.cjs: transpile the
// TSX, stub every import, renderToStaticMarkup. react itself is stubbed
// only to pin useSyncExternalStore to the fixture selection (SSR would
// otherwise always see the empty server snapshot); all other hooks are real.

const noticeSource = fs.readFileSync('apps/web/app/OrganizationSwitcher.tsx', 'utf8');
function renderNotice({ contextSnapshot, selectionSnapshot, uncertain = [] }) {
  const RealReact = require('../apps/web/node_modules/react');
  const { renderToStaticMarkup } = require('../apps/web/node_modules/react-dom/server');
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(noticeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports: module.exports, module,
    require(name) {
      if (name === 'react') return { ...RealReact, useSyncExternalStore: () => selectionSnapshot };
      if (name === 'react/jsx-runtime') return require('../apps/web/node_modules/react/jsx-runtime');
      if (name === '../lib/use-operator-context') return { useOperatorContextSnapshot: () => contextSnapshot };
      if (name === '../lib/operator-context') return {
        ensureOperatorContext: async () => {},
        getOperatorContextSnapshot: () => contextSnapshot,
        isOrganizationContextBlock: () => false,
        listUncertainAttempts: () => uncertain,
        operatorFetch: async () => { throw new Error('no network in render'); },
        refreshOperatorContext: async () => {},
        replayUncertainAttempt: async () => ({ status: null, settled: true }),
      };
      if (name === '../lib/organization-selection') return {
        getOrganizationSelectionSnapshot: () => selectionSnapshot,
        subscribeOrganizationSelection: () => () => {},
        selectOrganization: async () => {},
        organizationSelectionDestination: (role) => (role === 'STAFF' ? '/staff' : '/console'),
      };
      if (name === './console/console-draft-guard') return {
        UNCONFIRMED_WRITE_CLOSE_MESSAGE: 'unconfirmed',
        useConsoleDraftGuard: () => {},
        useConsoleDraftGuardAvailable: () => false,
      };
      if (name.endsWith('.module.css')) return { default: new Proxy({}, { get: (_, key) => String(key) }) };
      throw new Error(`Unexpected switcher dependency ${name}`);
    },
  });
  return renderToStaticMarkup(RealReact.createElement(module.exports.OrganizationContextNotice, {}));
}

const pinnedA = { organizationId: 'A', organizationName: '운영사 A', contextVersion: 2, role: 'AGENCY', userId: 'u-1', userName: '검증 사용자' };
const observedAStaff = { ...pinnedA, role: 'STAFF', contextVersion: 3 };
const calmContext = { context: pinnedA, observed: pinnedA, changed: false, loading: false, error: null, inFlightWrites: 0, uncertainWrites: 0 };
const emptySelection = { attempt: null, busy: false, uncertain: false, error: null, notice: null };

test('notice renders no warning region once drift clears, plain restored notice stays', () => {
  const html = renderNotice({
    contextSnapshot: calmContext,
    selectionSnapshot: { ...emptySelection, notice: '운영사 A에 다시 연결했습니다. 남아 있는 요청은 같은 요청으로 결과를 확인하세요.' },
  });
  assert.match(html, /운영사 A에 다시 연결했습니다/);
  assert.doesNotMatch(html, /role="region"/);
  assert.doesNotMatch(html, /운영사 문맥이 바뀌었습니다/);
  assert.doesNotMatch(html, /<button/);
});

test('notice renders nothing when clean and quiet', () => {
  const html = renderNotice({ contextSnapshot: calmContext, selectionSnapshot: emptySelection });
  assert.equal(html, '');
  assert.doesNotMatch(html, /role="region"|운영사 문맥/);
});

test('drifted same-org role change with pending receipts keeps the lock and names recovery', () => {
  const html = renderNotice({
    contextSnapshot: { ...calmContext, observed: observedAStaff, changed: true, uncertainWrites: 1 },
    selectionSnapshot: emptySelection,
    uncertain: [{ key: 'cmd-secret-9', organizationId: 'A', organizationName: '운영사 A', command: 'notice.save', method: 'POST', path: '/api/events/e1/commands', replayable: true }],
  });
  assert.match(html, /role="region"/);
  assert.match(html, /운영사 문맥이 바뀌었습니다/);
  assert.match(html, /미확인 요청 복구 연결/);
  assert.doesNotMatch(html, /변경된 역할의 홈으로 이동/);
  assert.match(html, /현재 역할 다시 확인/);
  assert.match(html, /같은 요청으로 결과 확인/);
  assert.match(html, /공지 저장/);
  assert.equal(html.includes('cmd-secret-9'), false, 'no raw receipt key in output');
});

test('unreplayable entries name the reason instead of an active retry control', () => {
  const html = renderNotice({
    contextSnapshot: { ...calmContext, observed: observedAStaff, changed: true, uncertainWrites: 1 },
    selectionSnapshot: emptySelection,
    uncertain: [{ key: 'cmd-secret-9', organizationId: 'A', organizationName: '운영사 A', command: 'notice.save', method: 'POST', path: '/api/events/e1/commands', replayable: false }],
  });
  assert.match(html, /role="region"/);
  assert.doesNotMatch(html, /같은 요청으로 결과 확인/);
  assert.match(html, /재전송할 요청 본문이 없어/);
  assert.equal(html.includes('cmd-secret-9'), false, 'no raw receipt key in output');
});

test('drifted role change without pending keeps the home path', () => {
  const html = renderNotice({
    contextSnapshot: { ...calmContext, observed: observedAStaff, changed: true },
    selectionSnapshot: emptySelection,
  });
  assert.match(html, /role="region"/);
  assert.match(html, /변경된 역할의 홈으로 이동/);
  assert.doesNotMatch(html, /미확인 요청 복구 연결/);
});

test('restore never navigates off a list; role home names the actual fresh target', () => {
  const restoreBlock = noticeSource.slice(noticeSource.indexOf('async function restore('), noticeSource.indexOf('async function checkUncertain('));
  assert.match(restoreBlock, /await recheckRole\(\);/);
  assert.match(restoreBlock, /selectOrganization/);
  assert.match(restoreBlock, /복구해도 현재 화면은 유지되고 이동하지 않습니다/);
  assert.doesNotMatch(restoreBlock, /location\.assign/);
  const roleBlock = noticeSource.slice(noticeSource.indexOf('async function recheckRole('), noticeSource.indexOf('function goToObserved('));
  assert.match(roleBlock, /userId && !actualOrg && !actualRole/);
  assert.match(roleBlock, /현재 역할을 확인하지 못했습니다\(HTTP 200\)/);
  assert.match(roleBlock, /현재 소속은 /);
  assert.match(roleBlock, /actualOrgName/);
  assert.match(roleBlock, /roleLabel\(actualRole\)/);
  assert.match(roleBlock, /\/api\/auth\/organizations\/select/);
  assert.match(roleBlock, /expectedContextVersion: freshSessionRev/);
  assert.match(roleBlock, /다시 묶지 못했습니다/);
  assert.match(noticeSource, /Object\.entries\(resolvedSummaries\)/);
  assert.match(noticeSource, /확인됨 · /);
  assert.doesNotMatch(noticeSource, />\{item\.key\}</);
});
