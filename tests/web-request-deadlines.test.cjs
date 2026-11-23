'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const WEB = path.resolve(__dirname, '../apps/web');
const ts = require(path.join(WEB, 'node_modules/typescript'));
const IMPORT = 'app/console/events/[id]/participants/import/ImportWizard.tsx';
const ENGAGE = 'app/event/[slug]/engage/EngageClient.tsx';
const HOME = 'app/event/[slug]/home/HomeShell.tsx';
const STAFF = 'app/staff/StaffEventWork.tsx';
const LOGIN = 'app/login/LoginForm.tsx';
const read = (file) => fs.readFileSync(path.join(WEB, file), 'utf8');
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = async () => { for (let n = 0; n < 8; n++) await new Promise(setImmediate); };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function deferredResponse(gate, value, status = 200) {
  let cancelled = false;
  return new Response(new ReadableStream({
    start(controller) {
      gate.promise.then(() => {
        if (cancelled) return;
        if (value !== undefined) controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
        controller.close();
      });
    },
    cancel() { cancelled = true; },
  }), { status });
}

function clock() {
  let serial = 0;
  const timers = new Map();
  return {
    setTimeout(fn) { const id = ++serial; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
    expire() { const due = [...timers.values()]; timers.clear(); for (const fn of due) fn(); },
    size: () => timers.size,
  };
}

// Execute the production functions/effect callbacks, including their real
// parsers and request state machines. Only browser/network boundaries are fake.
function runtime(extra = {}) {
  const timer = clock();
  const storage = new Map();
  const sandbox = {
    console, URL, URLSearchParams, Headers, Response, Request, AbortController,
    DOMException, Event, Date, ReadableStream, TransformStream, crypto: webcrypto, structuredClone,
    setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
    window: {
      setTimeout: timer.setTimeout, clearTimeout: timer.clearTimeout,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
      location: { search: '', pathname: '/event/synthetic/engage', hash: '', origin: 'http://localhost' },
      history: { replaceState() {} },
      sessionStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    },
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    ...extra,
  };
  vm.createContext(sandbox);
  const modules = new Map();
  function compile(source) {
    return ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX } }).outputText;
  }
  function load(file) {
    const full = path.join(WEB, file);
    if (modules.has(full)) return modules.get(full);
    const exports = {};
    modules.set(full, exports);
    const factory = vm.runInContext(`(function(exports, require) { ${compile(read(file))}\n})`, sandbox);
    factory(exports, spec => {
      if (!spec.startsWith('.')) throw new Error(`Unexpected dependency ${spec}`);
      return load(path.relative(WEB, path.resolve(path.dirname(full), `${spec}.ts`)));
    });
    return exports;
  }
  function functions(file, names, constants = []) {
    const source = read(file);
    const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const found = new Map();
    function visit(node) {
      if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) found.set(node.name.text, node.getText(tree));
      if (ts.isVariableStatement(node)) {
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name) && constants.includes(decl.name.text)) found.set(decl.name.text, node.getText(tree));
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
    for (const name of [...names, ...constants]) assert.ok(found.has(name), `production declaration ${name}`);
    vm.runInContext(compile([...constants, ...names].map(n => found.get(n)).join('\n')), sandbox);
    return sandbox;
  }
  function effect(file, marker) {
    const tree = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let callback;
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect' && node.arguments[0]?.getText(tree).includes(marker)) callback = node.arguments[0].getText(tree);
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.ok(callback, `production effect ${marker}`);
    vm.runInContext(compile(`globalThis.startEffect = ${callback};`), sandbox);
    return sandbox.startEffect();
  }
  if (fs.existsSync(path.join(WEB, 'lib/request-deadline.ts'))) Object.assign(sandbox, load('lib/request-deadline.ts'));
  return { sandbox, timer, load, functions, effect };
}

function stateSetters(sandbox, names) {
  for (const name of names) sandbox[`set${name[0].toUpperCase()}${name.slice(1)}`] = value => {
    sandbox[name] = typeof value === 'function' ? value(sandbox[name]) : value;
  };
}

for (const stale of ['epoch', 'cancelled']) test(`old login denial cannot overwrite fresh login after ${stale}`, async () => {
  const body = deferred();
  const redirects = [];
  let resets = 0;
  const world = runtime({
    fetch: async () => ({ ok: false, status: 403, json: () => body.promise }),
    loginEpochRef: { current: 0 }, safeRequested: null,
    router: { replace: value => redirects.push(value) },
    resetOperatorContext: () => { resets++; },
    chooseOrganizationHref: () => '/console?chooseOrganization=1',
    defaultHomeForRole: () => '/staff',
  });
  stateSetters(world.sandbox, ['checkingSession', 'sessionStale']);
  const stop = world.effect(LOGIN, 'async function restoreSession');
  await flush();
  if (stale === 'epoch') world.sandbox.loginEpochRef.current++;
  else stop();
  redirects.push('/staff');
  body.resolve({ code: 'NO_ORGANIZATION_MEMBERSHIP' });
  await flush();
  assert.deepEqual(redirects, ['/staff']);
  assert.equal(resets, 0, 'old denial must not clear the new operator context');
  stop();
});

test('CSV filename preserves mapping, quoting and physical row numbers across advisory MIME values', async () => {
  const results = [];
  for (const type of ['text/csv', 'text/plain', '', 'application/vnd.ms-excel']) {
    const world = runtime({ submittingRef: { current: false }, importLocked: false, fileReadingRef: { current: false }, fileReadIdRef: { current: 0 }, extraFields: [] });
    stateSetters(world.sandbox, ['readingFile', 'fileError', 'fileName', 'headers', 'dataRows', 'preview', 'phoneReviewed', 'errorsOpen', 'committed', 'fileKind', 'map', 'extraMap']);
    world.functions(IMPORT, ['readFile', 'previewFor', 'stripBom', 'parseCsv', 'parseTxt', 'normalizePhone', 'validateRows', 'detectColumns', 'detectExtraColumns', 'readAnswer', 'parseChecked', 'headerParts'], ['MAX_BYTES', 'MAX_ROWS', 'HEADER_WORDS', 'EMPTY_MAP', 'CHECKED_WORDS', 'UNCHECKED_WORDS']);
    const content = 'phone,name,company\r\n01000009999,"Synthetic, Name","Fixture\nCompany"\r\ninvalid,Bad,Other';
    await world.sandbox.readFile({ name: 'participants.CSV', type, size: content.length, text: async () => content });
    results.push(plain({ kind: world.sandbox.fileKind, map: world.sandbox.map, rows: world.sandbox.dataRows, preview: world.sandbox.preview, error: world.sandbox.fileError }));
  }
  assert.equal(results[0].kind, 'csv');
  assert.deepEqual(results[0].map, { name: '1', phone: '0', email: '', company: '2' });
  assert.deepEqual(results[0].preview.valid, [{ name: 'Synthetic, Name', phone: '01000009999', email: '', company: 'Fixture\nCompany', line: 2 }]);
  assert.equal(results[0].preview.errors[0].row, 4);
  for (const result of results.slice(1)) assert.deepEqual(result, results[0]);
});

function engageReadWorld(fetch) {
  const world = runtime({
    fetch, slug: 'synthetic', reloadTick: 0,
    liveSlugRef: { current: 'synthetic' }, ticketSlugRef: { current: 'synthetic' }, ticketRef: { current: 'bearer-original' },
    // Reopened 2026-11-23: the load effect now reads the background-refresh flag; these deadline tests are user-triggered reads.
    silentReloadRef: { current: false },
    ticketStorageAvailable: () => true, getAllowedTicketForTab: () => '', readStoredTicket: () => '', isTicketRejected: () => false,
    clearSessionForTab() {}, clearTicketRejected() {}, storeTicket: () => true, markTicketRejected() {}, clearStoredTicket() {}, allowSessionForTab() {},
    REJECTED_TICKET_BEARER: 'rejected', state: { kind: 'loading' },
    // The page reads the event's home color for its ground; the deadline tests do not care which.
    normalizeHomeStyle: () => ({ backgroundColor: '#B9DEF0' }),
    // Reopened 2026-11-19: the header also wears the published banner.
    readAttendeeTheme: () => ({}),
    questionTexts: { module: 'keep my unsent draft' },
  });
  stateSetters(world.sandbox, ['state', 'questionTexts']);
  // Reopened 2026-11-20: text/asRecord are the shared lib/json-guards, not engage-private copies.
  Object.assign(world.sandbox, world.load('lib/json-guards.ts'));
  world.functions(ENGAGE, ['parseModule']);
  return world;
}
const publicEvent = { event: { id: 'event-original', name: 'Synthetic Event' } };
const ticketData = { event: publicEvent.event, participant: { id: 'participant', name: 'Synthetic', status: 'APPROVED' }, workspace: { modules: [], questions: [], photos: [], posts: [] } };

for (const stage of ['public-headers', 'public-body', 'ticket-headers', 'ticket-body']) test(`engage initial ${stage} deadline exposes retry and ignores late results`, async () => {
  const stalled = deferred();
  let recovering = false;
  const calls = [];
  const world = engageReadWorld(async (url, init) => {
    calls.push({ url, signal: init.signal });
    const ticket = url.endsWith('/ticket');
    const data = ticket ? ticketData : publicEvent;
    const targeted = stage.startsWith(ticket ? 'ticket-' : 'public-');
    if (recovering || !targeted) return json(data);
    if (stage.endsWith('headers')) return stalled.promise;
    return { ok: true, status: 200, json: () => stalled.promise };
  });
  const stop = world.effect(ENGAGE, 'async function load');
  await flush();
  world.timer.expire();
  await flush();
  assert.equal(world.sandbox.state.kind, 'failed', 'a stalled load must leave the loading state');
  assert.ok(calls.every(call => call.signal?.aborted), 'effect deadline aborts both initial read stages');
  if (calls.length === 2) assert.equal(calls[0].signal, calls[1].signal, 'both stages belong to one effect deadline');
  stalled.resolve(stage.endsWith('headers') ? json({ event: { name: 'Old Event' } }) : { event: { name: 'Old Event' } });
  await flush();
  assert.equal(world.sandbox.state.kind, 'failed', 'a late result must stay suppressed even before effect cleanup');
  stop();
  recovering = true;
  world.sandbox.state = { kind: 'loading' };
  const stopRetry = world.effect(ENGAGE, 'async function load');
  await flush();
  assert.equal(world.sandbox.state.kind, 'ready');
  assert.equal(world.sandbox.state.eventName, 'Synthetic Event');
  assert.equal(world.sandbox.state.eventName, 'Synthetic Event', 'late abandoned response cannot replace the retry');
  assert.equal(world.sandbox.questionTexts.module, 'keep my unsent draft');
  stopRetry();
  assert.equal(world.timer.size(), 0);
});

test('engage cleanup aborts the active read without showing a stale failure', async () => {
  const stalled = deferred();
  let signal;
  const world = engageReadWorld(async (_url, init) => { signal = init.signal; return stalled.promise; });
  const stop = world.effect(ENGAGE, 'async function load');
  await flush();
  stop();
  assert.ok(signal?.aborted);
  stalled.resolve(json(publicEvent));
  await flush();
  assert.equal(world.sandbox.state.kind, 'loading');
  assert.equal(world.timer.size(), 0);
});

function mutationWorld() {
  const calls = [];
  const stalled = deferred();
  const world = runtime({ fetch: async (url, init) => { calls.push({ url, init }); return stalled.promise; } });
  return { ...world, calls, stalled };
}

for (const transport of ['operatorFetch', 'consoleFetch']) for (const stage of ['headers', 'body', 'denial-body']) test(`${transport} ${stage} timeout retains uncertain identity and permits exact committed replay`, async () => {
  const world = mutationWorld();
  const operator = world.load('lib/operator-context.ts');
  const consoleApi = world.load('lib/console-api.ts');
  world.sandbox.fetch = async () => json({ user: { id: 'user', name: 'Synthetic', role: 'AGENCY', organizationId: 'org', organizationName: 'Fixture', contextVersion: 1 } });
  await operator.ensureOperatorContext();
  const body = deferred();
  const req = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId: 'command-original', command: 'check.correct', assignmentId: 'assignment', payload: { id: 'check', reason: 'original reason' } }) };
  const result = { check: { id: 'check', corrected: true, correction: { id: 'command-original' } } };
  const response = stage !== 'headers' ? deferredResponse(body, result, stage === 'denial-body' ? 403 : 200) : null;
  world.sandbox.fetch = async (url, init) => { world.calls.push({ url, init }); return stage === 'headers' ? world.stalled.promise : response; };
  const send = transport === 'operatorFetch' ? operator.operatorFetch : consoleApi.consoleFetch;
  let failure;
  const first = send('/api/events/event-original/commands', req).then(response => response.json()).then(() => { failure = 'unexpected success'; }, error => { failure = error; });
  await flush();
  world.timer.expire();
  await flush();
  assert.ok(failure && failure !== 'unexpected success', 'request and response body must both have a deadline');
  await first;
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);
  assert.ok(world.calls[0].init.signal.aborted);
  world.sandbox.fetch = async (url, init) => { world.calls.push({ url, init }); return json(result); };
  const replay = await send('/api/events/event-original/commands', req);
  assert.deepEqual(await replay.json(), result);
  assert.equal(world.calls[1].init.body, world.calls[0].init.body);
  assert.equal(world.calls[1].url, world.calls[0].url);
  assert.deepEqual([...world.calls[1].init.headers], [...world.calls[0].init.headers]);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0);
  body.resolve(); world.stalled.resolve(json(result));
  await flush();
});

for (const stage of ['headers', 'body', 'rejection-body']) test(`import ${stage} timeout releases submission gate and retries frozen rows and command ID`, async () => {
  const world = mutationWorld();
  const s = world.sandbox;
  const operator = world.load('lib/operator-context.ts');
  s.consoleFetch = world.load('lib/console-api.ts').consoleFetch;
  s.confirmsParticipantImport = operator.confirmsParticipantImport;
  s.isOrganizationContextBlock = operator.isOrganizationContextBlock;
  Object.assign(s, { eventId: 'event-original', preview: { valid: [{ name: 'Synthetic', phone: '01000009999', email: '', company: '' }], phoneReview: [] }, submittingRef: { current: false }, pendingImportRef: { current: null }, checkingImport: false, otherImportReceipt: false, fileReadingRef: { current: false }, phoneReviewed: false, importUncertain: false, companyFixes: {}, companySuggestions: [] });
  stateSetters(s, ['committing', 'commitError', 'importUncertain', 'committed', 'headers', 'dataRows', 'preview', 'fileKind', 'fileName']);
  world.functions(IMPORT, ['commit', 'randomCommandId']);
  const body = deferred();
  if (stage !== 'headers') s.fetch = async (url, init) => { world.calls.push({ url, init }); return deferredResponse(body, undefined, stage === 'rejection-body' ? 403 : 200); };
  const first = s.commit();
  await flush(); world.timer.expire(); await flush();
  assert.equal(s.committing, false);
  assert.equal(s.submittingRef.current, false);
  assert.equal(s.importUncertain, true);
  const original = s.pendingImportRef.current;
  assert.ok(original?.uncertain);
  s.fetch = async (url, init) => { world.calls.push({ url, init }); return json({ participants: [{ id: 'participant', ...original.rows[0] }] }); };
  await s.commit();
  assert.equal(world.calls[1].init.body, world.calls[0].init.body);
  assert.equal(s.committed, 1);
  assert.equal(s.pendingImportRef.current, null);
  body.resolve(); world.stalled.resolve(json({ participants: [] })); await first;
});

for (const stage of ['headers', 'body', 'rejection-body']) test(`staff correction ${stage} timeout unlocks only the same-request retry`, async () => {
  const world = mutationWorld();
  const s = world.sandbox;
  s.operatorFetch = world.load('lib/operator-context.ts').operatorFetch;
  Object.assign(s, world.load('app/staff/correction-retry.ts'));
  Object.assign(s, { pendingScanRef: { current: null }, receiptRefreshRef: { current: false }, rewardRequestRef: { current: null }, correctingRef: { current: false }, correcting: false, pendingCorrectRef: { current: null }, correctUnknown: false, rewardCollectUncertain: false, receiptLock: false, rewardLookupLoading: false, rewardCollectingId: null, orgChanged: false, assignmentStale: false, correctableCheck: { id: 'check' }, assignment: { id: 'assignment-original' }, correctReason: 'original reason', activeScope: { eventId: 'event-original' }, clearRewardPanel() {}, forgetOperatorReceipt() {}, load: async () => {} });
  stateSetters(s, ['correcting', 'correctNotice', 'correctUnknown', 'correctReason', 'result', 'lastScan', 'sheet']);
  world.functions(STAFF, ['correctLatest']);
  const body = deferred();
  if (stage !== 'headers') s.fetch = async (url, init) => { world.calls.push({ url, init }); return deferredResponse(body, undefined, stage === 'rejection-body' ? 403 : 200); };
  const first = s.correctLatest({ preventDefault() {} });
  await flush(); world.timer.expire(); await flush();
  assert.equal(s.correctingRef.current, false);
  assert.equal(s.correcting, false);
  assert.equal(s.correctUnknown, true);
  const pending = s.pendingCorrectRef.current;
  assert.ok(pending);
  assert.equal(s.isCorrectionLocked(s.correcting, s.correctUnknown), true);
  s.activeScope = { eventId: 'different-event' }; s.assignment = { id: 'different-assignment' }; s.correctReason = 'edited reason';
  s.fetch = async (url, init) => { world.calls.push({ url, init }); return json({ check: { id: 'check', corrected: true, correction: { id: pending.commandId } } }); };
  await s.correctLatest({ preventDefault() {} }, true);
  assert.equal(world.calls[1].url, world.calls[0].url);
  assert.equal(world.calls[1].init.body, world.calls[0].init.body);
  assert.equal(s.pendingCorrectRef.current, null);
  assert.equal(s.correctUnknown, false);
  body.resolve(); world.stalled.resolve(json({})); await first;
});

for (const stage of ['headers', 'body', 'rejection-body']) test(`engage command ${stage} timeout preserves draft and exact replay`, async () => {
  const world = mutationWorld(); const s = world.sandbox;
  Object.assign(s, world.load('lib/guest-command-result.ts'));
  Object.assign(s, { slug: 'synthetic', liveSlugRef: { current: 'synthetic' }, ticketRef: { current: 'bearer-original' }, inFlightRef: { current: null }, requestEpochRef: { current: {} }, commandIdsRef: { current: {} }, pendingCommandsRef: { current: {} }, pendingPhotosRef: { current: {} }, state: { kind: 'ready', eventName: 'Synthetic', participantId: 'participant', participantName: 'Synthetic' }, rememberReceipt() {}, forgetReceipt() {}, pendingRevision: 0, reloadTick: 0, pollChoices: { module: 'original draft' }, quizAnswers: {}, questionTexts: { other: 'untouched draft' }, draftContentBaselinesRef: { current: { poll: { version: 1 } } } });
  stateSetters(s, ['submitting', 'formError', 'notice', 'pendingRevision', 'reloadTick', 'pollChoices', 'quizAnswers', 'questionTexts', 'draftContentBaselines']);
  // Reopened 2026-11-20: the request id is the shared lib/command-id.
  Object.assign(s, world.load('lib/command-id.ts'));
  world.functions(ENGAGE, ['submitGuestForm', 'postGuestCommand', 'beginRequest', 'isCurrentRequest', 'finishRequest', 'commandIdFor', 'isRetryableStatus', 'hasPendingRecord', 'clearSubmittedDraft', 'clearResponseBaseline']);
  const body = deferred();
  if (stage !== 'headers') s.fetch = async (url, init) => { world.calls.push({ url, init }); return deferredResponse(body, undefined, stage === 'rejection-body' ? 403 : 200); };
  const first = s.submitGuestForm('event-original', 'poll', 'response.submit', { moduleId: 'module', answer: s.pollChoices.module }, 'success');
  await flush(); world.timer.expire(); await flush();
  assert.equal(s.inFlightRef.current, null);
  assert.equal(s.submitting, null);
  assert.equal(s.formError.uncertain, true);
  const pending = s.pendingCommandsRef.current.poll;
  assert.ok(pending);
  assert.equal(s.pollChoices.module, 'original draft', 'timeout preserves the actual answer draft');
  assert.equal(s.draftContentBaselinesRef.current.poll.version, 1);
  s.pollChoices.module = 'newer unsent draft';
  s.fetch = async (url, init) => { world.calls.push({ url, init }); return json({ response: { id: pending.commandId, moduleId: 'module', answer: 'original draft' } }); };
  await s.submitGuestForm('different-event', 'poll', 'response.submit', { moduleId: 'different', answer: 'edited draft' }, 'success');
  assert.equal(world.calls[1].url, world.calls[0].url);
  assert.equal(world.calls[1].init.body, world.calls[0].init.body);
  assert.equal(s.pendingCommandsRef.current.poll, undefined);
  assert.equal(s.pollChoices.module, 'newer unsent draft', 'confirming an older answer must not clear a newer draft');
  assert.equal(s.questionTexts.other, 'untouched draft');
  assert.equal(s.draftContentBaselinesRef.current.poll, undefined);
  body.resolve(); world.stalled.resolve(json({})); await first;
});

for (const stage of ['headers', 'body', 'rejection-body']) test(`home command ${stage} timeout releases busy state and preserves exact vote replay`, async () => {
  const world = mutationWorld(); const s = world.sandbox;
  Object.assign(s, { slug: 'synthetic', ticketRef: { current: 'bearer-original' }, commandIdsRef: { current: {} }, currentCommandIdsRef: { current: {} }, pendingCommandsRef: { current: {} }, state: { kind: 'ready', eventId: 'event-original', ticketToken: 'bearer-original', teams: [] }, activeWrites: 0, completedCommands: {}, rememberReceipt() {}, forgetReceipt() {}, isCurrentRequestContext: () => true, recoveredCommandMessage: () => 'confirmed', refresh() {} });
  stateSetters(s, ['activeWrites', 'completedCommands', 'pendingCommands', 'recoveringCommandKey', 'state']);
  // Reopened 2026-11-20: the request id and the JSON guards are shared lib modules.
  Object.assign(s, world.load('lib/command-id.ts'), world.load('lib/json-guards.ts'));
  world.functions(HOME, ['postGuestCommand', 'sendGuestCommand', 'retryPendingCommand', 'updatePendingCommand', 'commandIdFor']);
  const body = deferred();
  if (stage !== 'headers') s.fetch = async (url, init) => { world.calls.push({ url, init }); return deferredResponse(body, undefined, stage === 'rejection-body' ? 403 : 200); };
  let failure;
  const first = s.postGuestCommand('event-original', 'vote', 'vote.ranked', { picks: [{ teamId: 'team-original', rank: 1 }] }).catch(error => { failure = error; });
  await flush(); world.timer.expire(); await flush();
  assert.equal(s.activeWrites, 0);
  assert.equal(failure?.kind, 'uncertain');
  assert.ok(s.pendingCommandsRef.current['synthetic:vote']);
  s.ticketRef.current = 'different-bearer';
  s.fetch = async (url, init) => { world.calls.push({ url, init }); return json({ vote: { picks: [{ teamId: 'team-original', rank: 1 }] } }); };
  await s.retryPendingCommand('synthetic:vote');
  assert.equal(world.calls[1].init.body, world.calls[0].init.body);
  assert.deepEqual(world.calls[1].init.headers, world.calls[0].init.headers);
  assert.equal(s.pendingCommandsRef.current['synthetic:vote'], undefined);
  assert.equal(s.state.voteSubmitted, true);
  body.resolve(); world.stalled.resolve(json({})); await first;
});

for (const stage of ['headers', 'body']) test(`caller cancellation bounds ${stage} and every cloned body reader`, async () => {
  const world = mutationWorld();
  const controller = new AbortController();
  let signal;
  const body = deferred();
  world.sandbox.fetch = async (_url, init) => {
    signal = init.signal;
    return stage === 'headers' ? world.stalled.promise : deferredResponse(body, { ok: true });
  };
  let finished;
  let clones;
  const pending = world.sandbox.fetchWithDeadline('/api/events/event/commands', { method: 'POST', signal: controller.signal }).then(response => {
    const clone = response.clone();
    clones = Promise.allSettled([response.json(), clone.json()]);
    return clones;
  }).then(value => { finished = value; }, error => { finished = error; });
  await flush();
  controller.abort();
  await flush();
  assert.equal(signal.aborted, true);
  if (stage === 'headers') assert.equal(finished?.name, 'AbortError');
  else assert.ok(finished.every(result => result.status === 'rejected' && result.reason.name === 'AbortError'));
  assert.equal(world.timer.size(), 0);
  body.resolve(); world.stalled.resolve(json({ ok: true }));
  await pending;
});

test('pre-aborted mutation never reaches fetch or creates an unhandled rejection', async () => {
  const world = mutationWorld();
  const controller = new AbortController(); controller.abort();
  await assert.rejects(world.sandbox.fetchWithDeadline('/api/events/event/commands', { method: 'POST', signal: controller.signal }), { name: 'AbortError' });
  await flush();
  assert.equal(world.calls.length, 0);
  assert.equal(world.timer.size(), 0);
});

for (const stage of ['headers', 'body', 'denial-body']) test(`explicit adapter replay ${stage} timeout never settles the frozen original`, async () => {
  const world = mutationWorld();
  const operator = world.load('lib/operator-context.ts');
  world.sandbox.fetch = async () => json({ user: { id: 'user', name: 'Synthetic', role: 'AGENCY', organizationId: 'org', organizationName: 'Fixture', contextVersion: 1 } });
  await operator.ensureOperatorContext();
  const req = { method: 'POST', body: JSON.stringify({ commandId: 'replay-original', command: 'check.correct', assignmentId: 'assignment-original', payload: { id: 'check-original', reason: 'original reason' } }) };
  world.sandbox.fetch = async () => { throw new Error('response lost after commit'); };
  await assert.rejects(operator.operatorFetch('/api/events/event-original/commands', req));
  const body = deferred();
  world.sandbox.fetch = async (url, init) => {
    world.calls.push({ url, init });
    return stage === 'headers' ? world.stalled.promise : deferredResponse(body, {}, stage === 'denial-body' ? 403 : 200);
  };
  let result;
  const retry = operator.replayUncertainAttempt('replay-original').then(value => { result = value; });
  await flush(); world.timer.expire(); await flush();
  assert.equal(result?.settled, false);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
  assert.equal(world.calls[0].init.body, req.body);
  body.resolve(); world.stalled.resolve(json({}));
  await retry;
});

test('current org-less session still routes to organization selection after its denial body', async () => {
  const redirects = []; let resets = 0;
  const world = runtime({
    fetch: async () => json({ code: 'NO_ORGANIZATION_MEMBERSHIP' }, 403),
    loginEpochRef: { current: 0 }, safeRequested: null,
    router: { replace: value => redirects.push(value) },
    resetOperatorContext: () => { resets++; },
    chooseOrganizationHref: () => '/console?chooseOrganization=1',
  });
  stateSetters(world.sandbox, ['checkingSession', 'sessionStale']);
  const stop = world.effect(LOGIN, 'async function restoreSession');
  await flush();
  assert.deepEqual(redirects, ['/console?chooseOrganization=1']);
  assert.equal(resets, 1);
  stop();
});

test('engage refresh timeout preserves existing drafts through same-context recovery', async () => {
  let retrying = false;
  const world = engageReadWorld(async () => retrying ? json(ticketData) : new Promise(() => {}));
  world.sandbox.state = { kind: 'ready', eventId: 'event-original', participantId: 'participant' };
  const stop = world.effect(ENGAGE, 'async function load');
  await flush(); world.timer.expire(); await flush();
  assert.equal(world.sandbox.state.kind, 'failed');
  assert.equal(world.sandbox.questionTexts.module, 'keep my unsent draft');
  stop();
  retrying = true;
  world.sandbox.state = { kind: 'loading' };
  const stopRetry = world.effect(ENGAGE, 'async function load');
  await flush();
  assert.equal(world.sandbox.state.kind, 'ready');
  assert.equal(world.sandbox.questionTexts.module, 'keep my unsent draft');
  stopRetry();
});

const operatorUser = { id: 'user-a', name: 'Synthetic A', role: 'AGENCY', organizationId: 'org', organizationName: 'Fixture', contextVersion: 1 };
const operatorRequest = commandId => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ commandId, command: 'check.correct', assignmentId: 'assignment-original', payload: { id: 'check-original', reason: 'private original reason' } }) });

for (const userId of ['user-a', 'user-b']) test(`reset retires an old delivered body callback before ${userId} logs in`, async () => {
  const world = mutationWorld();
  const operator = world.load('lib/operator-context.ts');
  operator.acceptOperatorContext(operatorUser);
  const gate = deferred();
  const request = operatorRequest('retired-body');
  world.sandbox.fetch = async (url, init) => {
    world.calls.push({ url, init });
    return deferredResponse(gate, { check: { id: 'check-original', corrected: true } });
  };
  let response;
  const sent = operator.operatorFetch('/api/events/event-original/commands', request).then(value => { response = value; });
  await flush();
  assert.equal(response?.status, 200, 'headers return while the original body is still stalled');
  await sent;
  const body = response.json().catch(error => error);
  operator.resetOperatorContext();
  operator.acceptOperatorContext({ ...operatorUser, id: userId });
  world.timer.expire();
  await flush();
  assert.equal((await body).name, 'AbortError');
  assert.equal(operator.getOperatorContextSnapshot().context.userId, userId);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0, 'retired callbacks cannot restore a cleared private request');
  assert.deepEqual(plain(operator.listUncertainAttempts()), []);
  const before = world.calls.length;
  await operator.replayUncertainAttempt('retired-body');
  assert.equal(world.calls.length, before, 'the retired private body is never transmitted under the new session');
  gate.resolve();
});

for (const replacement of ['accept', 'observe']) test(`same-org ${replacement} of another user retires private frozen attempts`, async () => {
  const world = mutationWorld();
  const operator = world.load('lib/operator-context.ts');
  operator.acceptOperatorContext(operatorUser);
  world.sandbox.fetch = async () => { throw new Error('response lost'); };
  await assert.rejects(operator.operatorFetch('/api/events/event-original/commands', operatorRequest('private-a')));
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);
  const other = { ...operatorUser, id: 'user-b', name: 'Synthetic B' };
  if (replacement === 'accept') operator.acceptOperatorContext(other);
  else {
    world.sandbox.fetch = async () => json({ user: other });
    await operator.refreshOperatorContext();
  }
  const before = world.calls.length;
  world.sandbox.fetch = async (url, init) => { world.calls.push({ url, init }); return json({ ok: true }); };
  assert.deepEqual(plain(operator.listUncertainAttempts()), [], 'same org and version do not make private attempts transferable');
  await operator.replayUncertainAttempt('private-a');
  assert.equal(world.calls.length, before, 'another identity cannot replay the previous user payload');
});

test('same-org version renewal cannot grant another user the original replay', async () => {
  const world = mutationWorld();
  const operator = world.load('lib/operator-context.ts');
  operator.acceptOperatorContext(operatorUser);
  world.sandbox.fetch = async () => { throw new Error('response lost'); };
  const request = operatorRequest('same-user-renewal');
  await assert.rejects(operator.operatorFetch('/api/events/event-original/commands', request));
  assert.equal(operator.renewPinnedOrganizationVersion({ ...operatorUser, id: 'user-b', contextVersion: 2 }), false);
  assert.equal(operator.getOperatorContextSnapshot().context.contextVersion, 1);
  assert.equal(operator.renewPinnedOrganizationVersion({ ...operatorUser, contextVersion: 2 }), true);
  world.sandbox.fetch = async (url, init) => { world.calls.push({ url, init }); return json({ ok: true }); };
  assert.equal((await operator.replayUncertainAttempt('same-user-renewal')).settled, true);
  assert.equal(world.calls[0].init.body, request.body, 'same-user recovery keeps the exact private payload');
  assert.equal(new Headers(world.calls[0].init.headers).get('x-eventouch-context-version'), '2');
});

for (const mode of ['initial', 'retry', 'replay']) for (const status of [403, 409]) for (const fault of ['TypeError', 'malformed JSON']) test(`${mode} ${status} ${fault} denial remains uncertain until a readable verdict`, async () => {
  const world = mutationWorld();
  const operator = world.load('lib/operator-context.ts');
  operator.acceptOperatorContext(operatorUser);
  const request = operatorRequest('unreadable-denial');
  if (mode !== 'initial') {
    world.sandbox.fetch = async () => { throw new Error('response lost after commit'); };
    await assert.rejects(operator.operatorFetch('/api/events/event-original/commands', request));
  }
  let breakBody;
  world.sandbox.fetch = async (url, init) => {
    world.calls.push({ url, init });
    if (fault === 'malformed JSON') return new Response('{"code":', { status });
    return new Response(new ReadableStream({ start(controller) { breakBody = () => controller.error(new TypeError('terminated')); } }), { status });
  };
  let result;
  const attempt = mode === 'replay'
    ? operator.replayUncertainAttempt('unreadable-denial').then(value => { result = value; })
    : operator.operatorFetch('/api/events/event-original/commands', request).then(response => response.json()).catch(error => { result = error; });
  await flush();
  breakBody?.();
  await attempt;
  await flush();
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1, 'an unreadable denial is not proof of rejection');
  assert.equal(operator.listUncertainAttempts()[0]?.key, 'unreadable-denial');
  if (mode === 'replay') assert.equal(result?.settled, false, 'an adapter replay cannot claim an unreadable denial settled');
  else assert.equal(result?.name, fault === 'TypeError' ? 'TypeError' : 'SyntaxError');
  world.sandbox.fetch = async (url, init) => { world.calls.push({ url, init }); return json({ ok: true }); };
  assert.equal((await operator.replayUncertainAttempt('unreadable-denial')).settled, true);
  assert.equal(world.calls.at(-1).init.body, request.body, 'the original ID and payload survive until explicit recovery');
  assert.equal(world.calls.at(-1).url, '/api/events/event-original/commands');
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0);
  assert.equal(world.timer.size(), 0);
});
