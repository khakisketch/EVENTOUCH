// Operator organization transport: executes the real adapter logic in a vm
// sandbox (transpiled, mocked fetch/clock/channel) — no source-text
// assertions. Covers pinning, drift, headers, rebind blocking, guarded
// reads, wake/channel validation and the console-api shared-read behavior.
"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const LIB = path.resolve(__dirname, "..", "apps", "web", "lib");
// The app's own TypeScript build transpiles the modules under test; the
// logic below executes against that output, never against source text.
const ts = require(path.join(LIB, "..", "node_modules", "typescript"));
const compiled = {};
for (const file of ["operator-context.ts", "console-api.ts"]) {
  const source = fs.readFileSync(path.join(LIB, file), "utf8");
  compiled[file] = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const ORG_A = {
  id: "user-1",
  name: "소유자",
  role: "AGENCY",
  organizationId: "org-a",
  organizationName: "에이전시 갑",
  contextVersion: 3,
};
const ORG_B = { ...ORG_A, organizationId: "org-b", organizationName: "에이전시 을", contextVersion: 7 };

function meResponse(user, status = 200) {
  return new Response(JSON.stringify({ user }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// A fresh isolated tab per test: own module state, own fetch mock, own
// window/document/channel mocks.
function loadWorld() {
  const fetchCalls = [];
  let fetchImpl = async () => new Response(JSON.stringify({}), { status: 200 });
  const windowListeners = {};
  const documentListeners = {};
  const channels = [];
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    Headers,
    Response,
    Request,
    AbortController,
    JSON,
    Math,
    Object,
    Array,
    Promise,
    Date,
    Error,
    Map,
    Set,
    setTimeout,
    clearTimeout,
    fetch: (...args) => {
      fetchCalls.push(args);
      return fetchImpl(...args);
    },
    window: {
      addEventListener: (type, fn) => {
        (windowListeners[type] = windowListeners[type] || []).push(fn);
      },
      removeEventListener: () => {},
      setTimeout,
      clearTimeout,
    },
    document: {
      visibilityState: "visible",
      addEventListener: (type, fn) => {
        (documentListeners[type] = documentListeners[type] || []).push(fn);
      },
      removeEventListener: () => {},
    },
    BroadcastChannel: class {
      constructor(name) {
        this.name = name;
        this.posted = [];
        this.onmessage = null;
        channels.push(this);
      }
      postMessage(message) {
        this.posted.push(message);
      }
      close() {}
    },
  };
  vm.createContext(sandbox);
  const registry = {};
  function load(name, source) {
    const module = { exports: {} };
    const localRequire = (spec) => {
      if (spec === "./operator-context") return registry["operator-context"].exports;
      throw new Error(`unexpected require ${spec}`);
    };
    const factory = vm.runInContext(`(function(exports, require, module) { ${source} })`, sandbox);
    factory(module.exports, localRequire, module);
    registry[name] = module;
    return module.exports;
  }
  const operator = load("operator-context", compiled["operator-context.ts"]);
  const consoleApi = load("console-api", compiled["console-api.ts"]);
  return {
    operator,
    consoleApi,
    fetchCalls,
    setFetchImpl: (fn) => {
      fetchImpl = fn;
    },
    windowListeners,
    documentListeners,
    channels,
    fireWindow: (type) => {
      for (const fn of windowListeners[type] || []) fn();
    },
    flush: (turns = 5) => {
      let chain = Promise.resolve();
      for (let i = 0; i < turns; i++) chain = chain.then(() => new Promise((r) => setTimeout(r, 0)));
      return chain;
    },
  };
}

function headersOf(init) {
  const headers = new Headers(init?.headers);
  return {
    org: headers.get("x-eventouch-organization-id"),
    version: headers.get("x-eventouch-context-version"),
  };
}

async function rejectsWithCode(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected rejection, got success");
}

test("first observed view pins; a different view marks drift without switching", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  const pinned = await operator.ensureOperatorContext();
  assert.equal(pinned.organizationId, "org-a");
  assert.equal(pinned.contextVersion, 3);
  assert.equal(pinned.role, "AGENCY");
  assert.equal(pinned.userId, "user-1");
  assert.equal(pinned.userName, "소유자");
  let snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.changed, false);
  assert.equal(snapshot.error, null);

  world.setFetchImpl(async () => meResponse(ORG_B));
  await operator.refreshOperatorContext();
  snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.changed, true, "drift is surfaced");
  assert.equal(snapshot.context.organizationId, "org-a", "pinned view never moves silently");
  assert.equal(snapshot.observed.organizationId, "org-b", "newer view stored as observed");

  // Snapshot identity is stable until a mutation happens.
  assert.equal(operator.getOperatorContextSnapshot(), snapshot);
});

test("stale me responses never overwrite newer observed state", async () => {
  const world = loadWorld();
  const { operator } = world;
  let releaseA;
  const gateA = new Promise((resolve) => {
    releaseA = resolve;
  });
  let calls = 0;
  world.setFetchImpl(async () => {
    calls += 1;
    if (calls === 1) {
      await gateA;
      return meResponse(ORG_A);
    }
    return meResponse(ORG_B);
  });
  const first = operator.ensureOperatorContext();
  const second = (async () => {
    await world.flush(2);
    return operator.refreshOperatorContext();
  })();
  await world.flush(2);
  releaseA();
  await first;
  await second;
  await world.flush();
  const snapshot = operator.getOperatorContextSnapshot();
  // The second (B) request was initiated after the first: even though A
  // resolved last, B wins.
  assert.equal(snapshot.context.organizationId, "org-b");
  assert.equal(snapshot.changed, false);
});

test("private writes freeze headers at call time; exempt paths stay bare", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));

  const callerInit = {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commandId: "cmd-1", command: "notice.save", payload: {} }),
  };
  await operator.operatorFetch("/api/events/e1/commands", callerInit);
  const [, init] = world.fetchCalls[world.fetchCalls.length - 1];
  const sent = headersOf(init);
  assert.deepEqual(sent, { org: "org-a", version: "3" }, "frozen org headers are attached");
  // The frozen headers merge with (never replace or mutate) caller headers.
  assert.equal(new Headers(init.headers).get("content-type"), "application/json");
  assert.deepEqual(callerInit.headers, { "content-type": "application/json" }, "caller init untouched");

  for (const [url, initArg] of [
    ["/api/auth/login", { method: "POST", body: "{}" }],
    ["/api/auth/invitations/abc123", { method: "GET" }],
    ["/api/auth/invitations/abc123/accept", { method: "POST", body: "{}" }],
    ["/api/auth/organizations/select", { method: "POST", body: "{}" }],
    ["/api/events/e1/signup", { method: "POST", body: "{}" }],
    ["/api/public/events/s/verification/request", { method: "POST", body: "{}" }],
    [
      "/api/events/e1/commands",
      { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" },
    ],
  ]) {
    world.fetchCalls.length = 0;
    await operator.operatorFetch(url, initArg);
    const [, sent] = world.fetchCalls[world.fetchCalls.length - 1];
    assert.deepEqual(headersOf(sent), { org: null, version: null }, `${url} stays header-free`);
  }
});

test("drift blocks private writes before transmitting, except recovery paths", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();
  world.setFetchImpl(async () => meResponse(ORG_B));
  await operator.refreshOperatorContext();
  assert.equal(operator.getOperatorContextSnapshot().changed, true);

  const before = world.fetchCalls.length;
  const error = await rejectsWithCode(
    operator.operatorFetch("/api/events/e1/commands", { method: "POST", body: "{}" })
  );
  assert.equal(error.code, "ORGANIZATION_CONTEXT_CHANGED");
  assert.equal(world.fetchCalls.length, before, "blocked write never transmits");

  // Recovery reads still transmit.
  await operator.operatorFetch("/api/auth/me", { cache: "no-store" });
  await operator.operatorFetch("/api/auth/organizations/select", { method: "POST", body: "{}" });
  assert.ok(world.fetchCalls.length > before);
  // Guarded reads reject; organization endpoints stay readable.
  const readError = await rejectsWithCode(operator.operatorFetch("/api/events/e1/bootstrap"));
  assert.equal(readError.code, "ORGANIZATION_CONTEXT_CHANGED");
  await operator.operatorFetch("/api/auth/organizations", { cache: "no-store" });
});

test("only the context-coded 409 marks drift; other 409s are authoritative", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  const coded = new Response(JSON.stringify({ error: "조직이 바뀌었습니다", code: "ORGANIZATION_CONTEXT_CHANGED" }), {
    status: 409,
  });
  world.setFetchImpl(async () => coded);
  const res = await operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-9", command: "notice.save", payload: {} }),
  });
  assert.equal(res.status, 409);
  assert.equal(operator.getOperatorContextSnapshot().changed, true);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1, "context-coded 409 preserves the pending mapping");

  // A received non-context 409 is authoritative: the mapping clears, never
  // replays, drift stays untouched.
  const world2 = loadWorld();
  world2.setFetchImpl(async () => meResponse(ORG_A));
  await world2.operator.ensureOperatorContext();
  const receiptBody = { error: "요청 식별자가 이미 다른 작업에 사용되었습니다" };
  world2.setFetchImpl(async () => new Response(JSON.stringify(receiptBody), { status: 409 }));
  const res2 = await world2.operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-9", command: "notice.save", payload: {} }),
  });
  assert.equal(res2.status, 409);
  assert.deepEqual(await res2.json(), receiptBody, "authoritative body passes through");
  assert.equal(world2.operator.getOperatorContextSnapshot().changed, false, "domain 409s never mark drift");
  assert.equal(world2.operator.getOperatorContextSnapshot().uncertainWrites, 0, "domain 409 clears the mapping");

  // Prior ambiguity resolved by an explicit domain 409: cleared, not kept.
  world2.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await world2.operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-x", command: "notice.save", payload: {} }),
  });
  assert.equal(world2.operator.getOperatorContextSnapshot().uncertainWrites, 1);
  world2.setFetchImpl(async () => new Response(JSON.stringify({ error: "conflict" }), { status: 409 }));
  await world2.operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-x", command: "notice.save", payload: {} }),
  });
  assert.equal(world2.operator.getOperatorContextSnapshot().uncertainWrites, 0, "explicit domain 409 resolves the pending mapping");
});

test("uncertain receipts replay identically; rebind across contexts stays blocked", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Ambiguous 500: single transmission, mapping retained, no auto-retry.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-7", command: "notice.save", payload: {} }),
  });
  assert.equal(world.fetchCalls.filter(([url]) => url.includes("/commands")).length, 1);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);

  // Same-context retry transmits with the same body and clears on success.
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-7", command: "notice.save", payload: {} }),
  });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0);

  // New ambiguous write, then the operator explicitly selects B: the view
  // marks drift but keeps the pinned A view and the frozen receipt, and the
  // retry of the A-frozen receipt is blocked before transmitting.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-8", command: "notice.save", payload: {} }),
  });
  operator.observeSelectedOrganization({ ...ORG_B });
  assert.equal(operator.getOperatorContextSnapshot().changed, true);
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a", "pinned view never moves");
  assert.equal(operator.getOperatorContextSnapshot().observed.organizationId, "org-b");
  const before = world.fetchCalls.length;
  const blocked = await rejectsWithCode(
    operator.operatorFetch("/api/events/e1/commands", {
      method: "POST",
      body: JSON.stringify({ commandId: "cmd-8", command: "notice.save", payload: {} }),
    })
  );
  assert.equal(blocked.code, "ORGANIZATION_CONTEXT_CHANGED");
  assert.equal(world.fetchCalls.length, before, "rebind never transmits");
});

test("explicit same-org return renews only the header version, payload fixed", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // A/v1 write goes ambiguous: receipt frozen to A/v1.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body = JSON.stringify({ commandId: "cmd-r", command: "notice.save", payload: {} });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);

  // Other tab switches to B (observed, never pinned): the A mapping is
  // kept and still counted while A stays pinned; the retry stays blocked
  // by drift until explicit recovery. (The B view itself only exists after
  // native navigation, where a fresh document seeds with none of A's pending.)
  operator.observeSelectedOrganization({ ...ORG_B });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1, "A mapping retained while A pinned");
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a", "pinned view never moves");
  const blockedInB = await rejectsWithCode(
    operator.operatorFetch("/api/events/e1/commands", { method: "POST", body })
  );
  assert.equal(blockedInB.code, "ORGANIZATION_CONTEXT_CHANGED");

  // Explicit user return to A/v5: same org renews the frozen version only.
  operator.acceptOperatorContext({ ...ORG_A, contextVersion: 5 });
  assert.equal(operator.getOperatorContextSnapshot().changed, false);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1, "A mapping survives for its org");
  const before = world.fetchCalls.length;
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(world.fetchCalls.length, before + 1, "renewed same-org retry transmits");
  const [, sent] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(sent), { org: "org-a", version: "5" }, "only the header version moved");
  assert.equal(sent.body, body, "commandId and payload byte-identical");
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0, "proven receipt clears");
});

test("observeSelectedOrganization records without pinning or renewing", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Ambiguous write frozen to A/v3.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body = JSON.stringify({ commandId: "cmd-o", command: "notice.save", payload: {} });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);

  // Explicit B selection: observed + changed + broadcast, pinned and
  // receipts untouched (no renewal, no silent install).
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 4 });
  const selected = operator.getOperatorContextSnapshot();
  assert.equal(selected.context.organizationId, "org-a", "pinned view stays A");
  assert.equal(selected.observed.organizationId, "org-b", "observed records B");
  assert.equal(selected.changed, true);
  assert.equal(selected.uncertainWrites, 1, "A receipt mapping kept, still counted for A");
  const posts = world.channels.flatMap((channel) => channel.posted);
  assert.equal(posts.length, 1, "selection broadcasts once");
  assert.equal(posts[0].type, "org-changed");

  // Same-org observation refreshes the observed view, never drift.
  operator.observeSelectedOrganization({ ...ORG_A });
  assert.equal(operator.getOperatorContextSnapshot().changed, true, "B drift still stands");
  assert.equal(operator.getOperatorContextSnapshot().observed.organizationId, "org-a", "observed follows the latest view");
  const world2 = loadWorld();
  world2.setFetchImpl(async () => meResponse(ORG_A));
  await world2.operator.ensureOperatorContext();
  world2.operator.observeSelectedOrganization({ ...ORG_A, contextVersion: 3 });
  assert.equal(world2.operator.getOperatorContextSnapshot().changed, false, "identical view is not drift");
  assert.equal(
    world2.channels.flatMap((channel) => channel.posted).length,
    0,
    "no broadcast without drift"
  );

  // Invalid selections never install.
  operator.observeSelectedOrganization({ nonsense: true });
  assert.equal(operator.getOperatorContextSnapshot().observed.organizationId, "org-a");
});

test("definitive 4xx clears uncertain counts; domain 409s resolve honestly", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  const body = JSON.stringify({ commandId: "cmd-d", command: "notice.save", payload: {} });
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);

  // A definitive validation rejection proves nothing was committed.
  world.setFetchImpl(async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0, "definitive 4xx drops the mapping");

  // A received 409 without the context code is authoritative (receipt
  // checked before business validation): the mapping clears, no auto-retry.
  // Theme version conflicts and invite link-unavailable behave the same.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);
  world.setFetchImpl(async () => new Response(JSON.stringify({ error: "in use" }), { status: 409 }));
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0, "domain 409 resolves the mapping");
  assert.equal(operator.getOperatorContextSnapshot().changed, false, "domain 409 never marks drift");
});

test("exempt writes never touch busy or uncertain counts", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await operator.operatorFetch("/api/auth/invitations/abc123/accept", { method: "POST", body: "{}" });
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0);
  await operator.operatorFetch("/api/auth/invitations/abc123", { method: "GET", cache: "no-store" });
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
  await operator.operatorFetch("/api/auth/organizations/select", { method: "POST", body: "{}" });
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0);
});

test("passive observations never renew frozen receipts", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body = JSON.stringify({ commandId: "cmd-p", command: "notice.save", payload: {} });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });

  // A passive me read reporting A/v9 (same org, newer version) marks drift
  // but never rewrites the frozen A/v3 receipt: the retry still transmits
  // the pinned v3 headers, and nothing auto-rebinds to the observed v9.
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse({ ...ORG_A, contextVersion: 3 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
  // Same-version observation: no drift, mapping untouched.
  await operator.refreshOperatorContext();
  assert.equal(operator.getOperatorContextSnapshot().changed, false);
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse({ ...ORG_A, contextVersion: 9 });
    return new Response(JSON.stringify({}), { status: 200 });
  });
  await operator.refreshOperatorContext();
  assert.equal(operator.getOperatorContextSnapshot().changed, true, "version drift marks changed");
  // Drift blocks even the same-org retry until explicit recovery.
  const blocked = await rejectsWithCode(
    operator.operatorFetch("/api/events/e1/commands", { method: "POST", body })
  );
  assert.equal(blocked.code, "ORGANIZATION_CONTEXT_CHANGED");
  // Explicit return to A/v9 renews the frozen version; the retry then
  // transmits pinned v9 headers with the identical body.
  operator.acceptOperatorContext({ ...ORG_A, contextVersion: 9 });
  const before = world.fetchCalls.length;
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(world.fetchCalls.length, before + 1, "renewed retry transmits after explicit accept");
  const [, sent] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(sent), { org: "org-a", version: "9" }, "explicit accept rebinds only the header version");
});

test("accept installs same-org recovery only; observe carries switches", async () => {
  const world = loadWorld();
  const { operator } = world;

  // Initial null seed is allowed: first explicit view installs.
  operator.acceptOperatorContext({ ...ORG_A });
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a");
  assert.equal(operator.getOperatorContextSnapshot().changed, false);
  const seededPosts = world.channels.flatMap((channel) => channel.posted).length;

  let notified = 0;
  const off = operator.subscribeOperatorContext(() => {
    notified += 1;
  });
  // Same-org recovery renews the version in place and broadcasts once.
  operator.acceptOperatorContext({ ...ORG_A, contextVersion: 8 });
  const snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.context.organizationId, "org-a");
  assert.equal(snapshot.context.contextVersion, 8);
  assert.equal(snapshot.observed.organizationId, "org-a");
  assert.equal(snapshot.changed, false);
  assert.ok(notified >= 1);
  const posts = world.channels.flatMap((channel) => channel.posted).slice(seededPosts);
  assert.equal(posts.length, 1, "exactly one explicit broadcast");
  assert.equal(posts[0].type, "org-changed");

  // A different org through accept is ignored: no install, no renewal, no
  // broadcast, no receipt touch. Switches go through observe + navigation.
  const announcedTotal = world.channels.flatMap((channel) => channel.posted).length;
  operator.acceptOperatorContext({ ...ORG_B, contextVersion: 9 });
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a", "pinned view never moves");
  assert.equal(operator.getOperatorContextSnapshot().context.contextVersion, 8, "version untouched");
  assert.equal(operator.getOperatorContextSnapshot().changed, false, "no drift manufactured");
  assert.equal(world.channels.flatMap((channel) => channel.posted).length, announcedTotal, "ignored accept stays silent");

  // Invalid payloads never install.
  operator.acceptOperatorContext({ nonsense: true });
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a");
  off();

  operator.resetOperatorContext();
  const cleared = operator.getOperatorContextSnapshot();
  assert.equal(cleared.context, null);
  assert.equal(cleared.observed, null);
  assert.equal(cleared.changed, false);
  assert.equal(cleared.uncertainWrites, 0);
});

test("focus wake and channel signal validate without switching forms", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();
  assert.ok(world.windowListeners.focus.length > 0, "wake is wired");

  world.setFetchImpl(async () => meResponse(ORG_B));
  world.fireWindow("focus");
  await world.flush();
  // The wake revalidated: drift is marked, pinned forms untouched.
  const snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.changed, true);
  assert.equal(snapshot.context.organizationId, "org-a");
  assert.equal(snapshot.observed.organizationId, "org-b");

  // Cross-tab switch signal revalidates the same way.
  operator.acceptOperatorContext({ ...ORG_A });
  const channel = world.channels.find((item) => item.name === "eventouch-operator-context");
  assert.ok(channel, "org channel exists");
  world.setFetchImpl(async () => meResponse(ORG_B));
  channel.onmessage({ data: { type: "org-changed", from: "other-tab", at: Date.now() } });
  await world.flush();
  const after = operator.getOperatorContextSnapshot();
  assert.equal(after.changed, true);
  assert.equal(after.context.organizationId, "org-a");
});

test("headers freeze at call time and busy counts track in flight", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl(() => gate.then(() => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  const pending = operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-f", command: "notice.save", payload: {} }),
  });
  await world.flush(2);
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 1);
  // Switching context mid-flight cannot rewrite the frozen headers.
  operator.acceptOperatorContext({ ...ORG_B });
  release();
  await pending;
  const [, sent] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(sent), { org: "org-a", version: "3" });
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
});

test("same-context me reads resolve bounded without self-invalidating", async () => {
  const world = loadWorld();
  const { operator, consoleApi } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();
  const baseMeCalls = world.fetchCalls.filter(([url]) => String(url).includes("/api/auth/me")).length;

  // Concurrent me reads share one network call; sequential repeats stay
  // bounded — same-context observations never epoch-bump their own read.
  const first = consoleApi.consoleFetch("/api/auth/me", { cache: "no-store" });
  const second = consoleApi.consoleFetch("/api/auth/me", { cache: "no-store" });
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal((await r1.json()).user.organizationId, "org-a");
  assert.equal((await r2.json()).user.organizationId, "org-a");
  const third = await consoleApi.consoleFetch("/api/auth/me", { cache: "no-store" });
  assert.equal((await third.json()).user.organizationId, "org-a");
  const meCalls = world.fetchCalls.filter(([url]) => String(url).includes("/api/auth/me")).length - baseMeCalls;
  assert.ok(meCalls <= 2, `me reads stay bounded, saw ${meCalls}`);
  assert.equal(operator.getOperatorContextSnapshot().changed, false);
});

test("unrelated busy state never cancels a valid in-flight read", async () => {
  const world = loadWorld();
  const { operator, consoleApi } = world;
  const dataResponse = () =>
    new Response(JSON.stringify({ state: { events: [] } }), {
      status: 200,
      headers: { "x-eventouch-organization-id": "org-a", "x-eventouch-context-version": "3" },
    });
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse(ORG_A);
    return dataResponse();
  });
  await operator.ensureOperatorContext();

  // Deferred shared read in flight while an unrelated write starts, stays
  // busy, and is still open: busy/loading emissions must not drop the GET.
  // Only the write's own completion invalidates (existing write logic).
  let releaseRead;
  const readGate = new Promise((resolve) => {
    releaseRead = resolve;
  });
  let releaseWrite;
  const writeGate = new Promise((resolve) => {
    releaseWrite = resolve;
  });
  world.setFetchImpl((url) => {
    if (String(url).includes("/api/auth/me")) return Promise.resolve(meResponse(ORG_A));
    if (String(url).includes("/commands")) return writeGate.then(() => dataResponse());
    return readGate.then(dataResponse);
  });
  const pendingRead = consoleApi.consoleFetch("/api/console/directory", { cache: "no-store" });
  await world.flush(2);
  const pendingWrite = operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-busy", command: "notice.save", payload: {} }),
  });
  await world.flush(2);
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 1);
  releaseRead();
  const resolved = await pendingRead;
  assert.equal(await resolved.json().then((data) => data.state.events.length), 0);
  const directoryCalls = world.fetchCalls.filter(([url]) => String(url).includes("/directory")).length;
  assert.equal(directoryCalls, 1, "busy write never refetches the valid read");
  releaseWrite();
  await pendingWrite;
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 0);
});

test("identical accepts and observations never drop shared reads", async () => {
  const world = loadWorld();
  const { operator, consoleApi } = world;
  const dataResponse = () =>
    new Response(JSON.stringify({ state: { events: [] } }), {
      status: 200,
      headers: { "x-eventouch-organization-id": "org-a", "x-eventouch-context-version": "3" },
    });
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse(ORG_A);
    return dataResponse();
  });
  await operator.ensureOperatorContext();

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl((url) => {
    if (String(url).includes("/api/auth/me")) return Promise.resolve(meResponse(ORG_A));
    return gate.then(dataResponse);
  });
  const pending = consoleApi.consoleFetch("/api/console/directory", { cache: "no-store" });
  await world.flush(2);
  // Identical accept: no-op, no generation, no invalidation.
  operator.acceptOperatorContext({ ...ORG_A });
  // Identical observation: observed refresh only, no generation.
  operator.observeSelectedOrganization({ ...ORG_A, contextVersion: 3 });
  // Same-context focus wake: revalidates but changes nothing.
  world.fireWindow("focus");
  await world.flush();
  release();
  const resolved = await pending;
  assert.equal(await resolved.json().then((data) => data.state.events.length), 0);
  const directoryCalls = world.fetchCalls.filter(([url]) => String(url).includes("/directory")).length;
  assert.equal(directoryCalls, 1, "stable values never refetch the valid read");
});

test("concurrent initial ensures share one bounded fetch", async () => {
  const world = loadWorld();
  const { operator } = world;
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl(() => gate.then(() => meResponse(ORG_A)));
  const first = operator.ensureOperatorContext();
  const second = operator.ensureOperatorContext();
  await world.flush(2);
  // Mount storms from shell, menu and staff collapse into one request.
  assert.equal(world.fetchCalls.filter(([url]) => String(url).includes("/auth/me")).length, 1);
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.organizationId, "org-a");
  assert.equal(b.organizationId, "org-a");
  assert.equal(operator.getOperatorContextSnapshot().loading, false);
});

test("delayed old me cannot re-mark a freshly restored view", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Slow me read returning stale B/v2, initiated before the explicit acts.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl(() => gate.then(() => meResponse({ ...ORG_B, contextVersion: 2 })));
  const slow = operator.refreshOperatorContext();
  await world.flush(1);
  // Explicit same-org return retires every older initiated me read.
  operator.acceptOperatorContext({ ...ORG_A, contextVersion: 5 });
  release();
  await slow;
  await world.flush();
  const snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.context.organizationId, "org-a");
  assert.equal(snapshot.context.contextVersion, 5);
  assert.equal(snapshot.observed.organizationId, "org-a");
  assert.equal(snapshot.changed, false, "delayed old org never re-marks the restored view");

  // Same for the observe path: a pre-selection slow me is retired too.
  let releaseOlder;
  const olderGate = new Promise((resolve) => {
    releaseOlder = resolve;
  });
  world.setFetchImpl(() => olderGate.then(() => meResponse({ ...ORG_A, contextVersion: 9 })));
  const slowOlder = operator.refreshOperatorContext();
  await world.flush(1);
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });
  releaseOlder();
  await slowOlder;
  await world.flush();
  const after = operator.getOperatorContextSnapshot();
  assert.equal(after.observed.organizationId, "org-b", "stale same-org me never clobbers the explicit selection");
  assert.equal(after.changed, true);
});

test("refresh reports unselected without logging out", async () => {
  const world = loadWorld();
  const { operator } = world;
  const unselected = { id: "user-1", name: "소유자", role: null, organizationId: null, organizationName: null, contextVersion: null };
  world.setFetchImpl(async () => meResponse(unselected));
  await operator.refreshOperatorContext();
  await world.flush();
  assert.equal(operator.getOperatorContextSnapshot().context, null);
  assert.equal(operator.getOperatorContextSnapshot().error, "조직을 선택하세요");
  assert.equal(operator.isOrganizationSelectionRequired({ code: "ORGANIZATION_NOT_SELECTED" }), true);
});

test("revoked membership via 403 keeps the view and surfaces selection", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // An uncertain write is already in flight when membership is revoked.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-rev", command: "notice.save", payload: {} }),
  });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);

  // Manual refresh hits the authoritative 403: view and receipt kept,
  // observed cleared, drift marked, banner message set — not a logout.
  const revokedMe = () =>
    new Response(
      JSON.stringify({
        error: "소속이 없습니다",
        code: "NO_ORGANIZATION_MEMBERSHIP",
        user: { id: "user-1", name: "소유자", organizationId: null, role: null, contextVersion: null },
      }),
      { status: 403 }
    );
  world.setFetchImpl(async () => revokedMe());
  await operator.refreshOperatorContext();
  const drifted = operator.getOperatorContextSnapshot();
  assert.equal(drifted.context.organizationId, "org-a", "pinned view never cleared");
  assert.equal(drifted.observed, null, "observed cleared authoritatively");
  assert.equal(drifted.changed, true);
  assert.equal(drifted.error, "조직을 선택하세요", "selection banner, not a generic failure");
  assert.equal(drifted.uncertainWrites, 1, "frozen receipts retained for the explicit return");

  // Returning with a selected org clears the banner; the pending mapping
  // is still intact for its retry.
  world.setFetchImpl(async () => meResponse(ORG_A));
  operator.acceptOperatorContext({ ...ORG_A, contextVersion: 4 });
  assert.equal(operator.getOperatorContextSnapshot().error, null);
  assert.equal(operator.getOperatorContextSnapshot().changed, false);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);
});

test("initial 403 unselected rejects context without logging out", async () => {
  const world = loadWorld();
  const { operator } = world;
  const revokedMe = () =>
    new Response(
      JSON.stringify({
        error: "소속이 없습니다",
        code: "NO_ORGANIZATION_MEMBERSHIP",
        user: { id: "user-1", name: "소유자", organizationId: null, role: null, contextVersion: null },
      }),
      { status: 403 }
    );
  world.setFetchImpl(async () => revokedMe());
  const error = await rejectsWithCode(operator.ensureOperatorContext());
  assert.equal(error.code, "ORGANIZATION_NOT_SELECTED");
  assert.notEqual(error.status, 401, "selection is not a logout");
  assert.ok(operator.isOrganizationSelectionRequired(error));
  assert.equal(operator.getOperatorContextSnapshot().context, null);
  assert.equal(operator.getOperatorContextSnapshot().error, "조직을 선택하세요");
});

test("arbitrary 403 stays its own failure, never unselected or logged-out", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // No code, no identity: validateMe reports the failure truthfully and
  // touches nothing else.
  world.setFetchImpl(async () => new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }));
  await operator.refreshOperatorContext();
  const failed = operator.getOperatorContextSnapshot();
  assert.equal(failed.error, "조직 정보를 다시 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
  assert.equal(failed.context.organizationId, "org-a", "pinned view kept");
  assert.equal(failed.changed, false, "no drift manufactured");
  assert.notEqual(failed.observed, null, "observed untouched");

  // A network failure is the same: Korean truth, no session-loss reading.
  world.setFetchImpl(() => Promise.reject(new TypeError("fetch failed")));
  await operator.refreshOperatorContext();
  const down = operator.getOperatorContextSnapshot();
  assert.equal(down.error, "조직 정보를 다시 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
  assert.equal(down.context.organizationId, "org-a", "transport loss is not a logout");
});

test("stale unselected me never overwrites a newer pinned view", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Slow unselected 403 initiated first via the deduped refresh path...
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const unselectedMe = () =>
    new Response(
      JSON.stringify({ error: "소속이 없습니다", code: "NO_ORGANIZATION_MEMBERSHIP", user: { id: "user-1" } }),
      { status: 403 }
    );
  let calls = 0;
  world.setFetchImpl(async () => {
    calls += 1;
    if (calls === 1) {
      await gate;
      return unselectedMe();
    }
    return meResponse(ORG_A);
  });
  const slow = operator.refreshOperatorContext();
  await world.flush(2);
  // ...a newer same-context validation completes first through a genuinely
  // new raw /auth/me read (the deduped refresh path would join the gated
  // request instead of issuing a new one, so it cannot serve as the newer
  // stimulus here — production dedupe is intentionally left untouched).
  const fresh = await operator.operatorFetch("/api/auth/me", { cache: "no-store" });
  assert.equal(fresh.status, 200);
  await world.flush(2);
  // ...then the stale unselected response lands last and must be dropped.
  release();
  await slow;
  await world.flush();
  const snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.context.organizationId, "org-a");
  assert.equal(snapshot.changed, false, "stale unselected response dropped");
  assert.equal(snapshot.observed.organizationId, "org-a");
  assert.equal(snapshot.error, null);
});

test("manual refresh failure surfaces truthful error and keeps the view locked", async () => {  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Drift first so the changed lock is held, then a failing recheck.
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });
  assert.equal(operator.getOperatorContextSnapshot().changed, true);
  world.setFetchImpl(async () => new Response("down", { status: 503 }));
  await operator.refreshOperatorContext();
  const failed = operator.getOperatorContextSnapshot();
  assert.equal(failed.error, "조직 정보를 다시 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
  assert.equal(failed.context.organizationId, "org-a", "pinned view retained");
  assert.equal(failed.changed, true, "changed lock retained");
  assert.equal(failed.observed.organizationId, "org-b", "observed untouched");

  // A later successful refresh clears the error but never the lock.
  world.setFetchImpl(async () => meResponse(ORG_B));
  await operator.refreshOperatorContext();
  const recovered = operator.getOperatorContextSnapshot();
  assert.equal(recovered.error, null);
  assert.equal(recovered.changed, true, "recovery still needs the explicit path");
  assert.equal(recovered.context.organizationId, "org-a", "no silent switch on recheck");
});

test("guarded GET 409 with the context code preserves the body and marks drift", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  const coded = () =>
    new Response(JSON.stringify({ error: "조직이 바뀌었습니다", code: "ORGANIZATION_CONTEXT_CHANGED" }), {
      status: 409,
    });
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse(ORG_A);
    return coded();
  });
  const res = await operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" });
  // The original 409 body/status reach the caller untouched — never masked
  // into a generic error.
  assert.equal(res.status, 409);
  assert.equal((await res.json()).code, "ORGANIZATION_CONTEXT_CHANGED");
  assert.equal(operator.getOperatorContextSnapshot().changed, true, "coded 409 marks drift");
  await world.flush();
  const meCalls = world.fetchCalls.filter(([url]) => String(url).includes("/api/auth/me")).length;
  assert.ok(meCalls >= 2, "coded 409 kicks a revalidation");

  // Generic 401/500 stay exactly what they are: no drift, no revalidation.
  const world2 = loadWorld();
  world2.setFetchImpl(async () => meResponse(ORG_A));
  await world2.operator.ensureOperatorContext();
  world2.setFetchImpl(async () => new Response("no", { status: 401 }));
  const denied = await world2.operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" });
  assert.equal(denied.status, 401);
  assert.equal(world2.operator.getOperatorContextSnapshot().changed, false);
  world2.setFetchImpl(async () => new Response("boom", { status: 500 }));
  const broken = await world2.operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" });
  assert.equal(broken.status, 500);
  assert.equal(await broken.text(), "boom", "private error bodies pass through untouched");
  assert.equal(world2.operator.getOperatorContextSnapshot().changed, false);
});

test("revoked membership keeps the view and surfaces selection via me", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  const revokedBody = { error: "소속이 없습니다", code: "NO_ORGANIZATION_MEMBERSHIP", user: { id: "user-1", name: "소유자" } };
  // Write path: the original 403 body/status reach the caller untouched.
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) {
      return meResponse({ id: "user-1", name: "소유자", role: null, organizationId: null, organizationName: null, contextVersion: null });
    }
    return new Response(JSON.stringify(revokedBody), { status: 403 });
  });
  const writeRes = await operator.operatorFetch("/api/events/e1/commands", {
    method: "POST",
    body: JSON.stringify({ commandId: "cmd-rev", command: "notice.save", payload: {} }),
  });
  assert.equal(writeRes.status, 403);
  assert.deepEqual(await writeRes.json(), revokedBody, "identity body preserved, never masked");
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a", "pinned view kept");
  await world.flush();
  const afterWrite = operator.getOperatorContextSnapshot();
  assert.equal(afterWrite.observed, null, "authoritative me cleared the observed org");
  assert.equal(afterWrite.changed, true, "drift marked");
  assert.equal(afterWrite.error, "조직을 선택하세요", "banner message, not a generic error");

  // Read path behaves the same: original 403 passes through untouched.
  const world2 = loadWorld();
  world2.setFetchImpl(async () => meResponse(ORG_A));
  await world2.operator.ensureOperatorContext();
  world2.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) {
      return meResponse({ id: "user-1", name: "소유자", role: null, organizationId: null, organizationName: null, contextVersion: null });
    }
    return new Response(JSON.stringify(revokedBody), { status: 403 });
  });
  const readRes = await world2.operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" });
  assert.equal(readRes.status, 403);
  assert.deepEqual(await readRes.json(), revokedBody);
  assert.equal(world2.operator.getOperatorContextSnapshot().context.organizationId, "org-a", "no logout redirect semantics");
  await world2.flush();
  assert.equal(world2.operator.getOperatorContextSnapshot().observed, null);
  assert.equal(world2.operator.getOperatorContextSnapshot().error, "조직을 선택하세요");
});

test("console-api keeps shared reads and drops them on org change", async () => {
  const world = loadWorld();
  const { operator, consoleApi } = world;
  const dataResponse = (payload) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: {
        "x-eventouch-organization-id": "org-a",
        "x-eventouch-context-version": "3",
      },
    });
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse(ORG_A);
    return dataResponse({ state: { events: [] } });
  });
  await operator.ensureOperatorContext();

  // Parallel shared reads dedupe to one network call and both resolve.
  const first = consoleApi.consoleFetch("/api/console/directory", { cache: "no-store" });
  const second = consoleApi.consoleFetch("/api/console/directory", { cache: "no-store" });
  const [r1, r2] = await Promise.all([first, second]);
  assert.equal(await r1.json().then((data) => data.state.events.length), 0);
  assert.equal(await r2.json().then((data) => data.state.events.length), 0);
  const directoryCalls = world.fetchCalls.filter(([url]) => String(url).includes("/directory")).length;
  assert.equal(directoryCalls, 1, "in-flight read is shared");

  // A drifted in-flight read never populates: the epoch retry rejects.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl((url) => {
    if (String(url).includes("/api/auth/me")) return Promise.resolve(meResponse(ORG_A));
    return gate.then(() => dataResponse({ state: { events: ["stale"] } }));
  });
  const stale = consoleApi.consoleFetch("/api/console/directory", { cache: "no-store" });
  await world.flush(2);
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse(ORG_B);
    return new Response(JSON.stringify({}), { status: 200 });
  });
  await operator.refreshOperatorContext();
  release();
  const staleError = await rejectsWithCode(stale);
  assert.equal(staleError.code, "ORGANIZATION_CONTEXT_CHANGED");
});

test("unselected membership rejects context without logging out", async () => {
  const world = loadWorld();
  const { operator } = world;
  const unselected = { id: "user-1", name: "소유자", role: null, organizationId: null, organizationName: null, contextVersion: null };
  world.setFetchImpl(async () => meResponse(unselected));
  const error = await rejectsWithCode(operator.ensureOperatorContext());
  assert.equal(error.code, "ORGANIZATION_NOT_SELECTED");
  assert.notEqual(error.status, 401, "not a logout");
  assert.ok(operator.isOrganizationSelectionRequired(error));
  assert.equal(operator.getOperatorContextSnapshot().context, null, "nothing pinned");
  assert.equal(operator.getOperatorContextSnapshot().error, "조직을 선택하세요");

  // The explicit selector result seeds through the same accept path.
  operator.acceptOperatorContext({ ...ORG_A });
  const snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.context.organizationId, "org-a");
  assert.equal(snapshot.error, null);

  // Losing the selection server-side afterwards reads as drift, not logout.
  world.setFetchImpl(async () => meResponse(unselected));
  await operator.refreshOperatorContext();
  const drifted = operator.getOperatorContextSnapshot();
  assert.equal(drifted.changed, true);
  assert.equal(drifted.context.organizationId, "org-a", "pinned view preserved");
  assert.equal(drifted.observed, null);
});

test("org create and member writes are guarded private writes", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Neither endpoint is a select exemption: both carry frozen headers and
  // busy counts, like any other private write.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl(() => gate.then(() => new Response(JSON.stringify({ ok: true }), { status: 201 })));
  const pending = operator.operatorFetch("/api/auth/organizations", {
    method: "POST",
    body: JSON.stringify({ commandId: "org-1", name: "새 조직" }),
  });
  await world.flush(2);
  assert.equal(operator.getOperatorContextSnapshot().inFlightWrites, 1, "org create counts as in-flight");
  release();
  await pending;
  const [, createInit] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(createInit), { org: "org-a", version: "3" });

  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await operator.operatorFetch("/api/auth/organizations/org-a/members/user-2", {
    method: "POST",
    body: JSON.stringify({ commandId: "mem-1", active: true, expectedContextVersion: 3 }),
  });
  const [, memberInit] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(memberInit), { org: "org-a", version: "3" }, "member write carries the frozen context");

  // Drift blocks both before transmitting.
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });
  const before = world.fetchCalls.length;
  for (const [url, body] of [
    ["/api/auth/organizations", { commandId: "org-2", name: "또 다른 조직" }],
    ["/api/auth/organizations/org-a/members/user-3", { commandId: "mem-2", active: false }],
  ]) {
    const blocked = await rejectsWithCode(operator.operatorFetch(url, { method: "POST", body: JSON.stringify(body) }));
    assert.equal(blocked.code, "ORGANIZATION_CONTEXT_CHANGED");
  }
  assert.equal(world.fetchCalls.length, before, "guarded org writes never transmit after drift");
});

test("invite create and revoke are guarded org writes with frozen headers", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // The body may name its own expected version/role, but headers always
  // freeze from the pinned snapshot — never parsed out of the payload.
  const createBody = JSON.stringify({ commandId: "inv-c1", name: "신규", role: "MANAGER", expectedContextVersion: 99 });
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 201 }));
  await operator.operatorFetch("/api/auth/invitations", { method: "POST", body: createBody });
  const [, createInit] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(createInit), { org: "org-a", version: "3" }, "create carries frozen headers");
  assert.equal(createInit.body, createBody, "body byte-identical");

  const revokeBody = JSON.stringify({ commandId: "inv-r1", active: false });
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  await operator.operatorFetch("/api/auth/invitations/inv-1/revoke", { method: "POST", body: revokeBody });
  const [, revokeInit] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(revokeInit), { org: "org-a", version: "3" }, "revoke carries frozen headers");

  // Blocked pre-transmit once drifted, like any other private write.
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });
  const before = world.fetchCalls.length;
  for (const [url, body] of [
    ["/api/auth/invitations", JSON.stringify({ commandId: "inv-c2", name: "x" })],
    ["/api/auth/invitations/inv-2/revoke", JSON.stringify({ commandId: "inv-r2", active: false })],
  ]) {
    const blocked = await rejectsWithCode(operator.operatorFetch(url, { method: "POST", body }));
    assert.equal(blocked.code, "ORGANIZATION_CONTEXT_CHANGED");
  }
  assert.equal(world.fetchCalls.length, before, "guarded invite writes never transmit after drift");
});

test("auth help stays global public without proof", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });

  // Help delivers header-free with no validation even after drift.
  world.setFetchImpl(async () => new Response(JSON.stringify({ help: true }), { status: 200 }));
  const res = await operator.operatorFetch("/api/auth/help", { cache: "no-store" });
  assert.equal(res.status, 200);
  assert.equal(operator.getOperatorContextSnapshot().changed, true, "help read marks nothing new");
});

test("revoke-vs-role races stay server-owned: domain 409s pass through resolved", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Simultaneous revoke vs role change: the server owns the outcome. A link
  // already consumed answers INVITATION_LINK_UNAVAILABLE — authoritative,
  // known created (not unknown), mapping cleared, no drift manufactured.
  const linkBody = { error: "이미 사용된 초대입니다", code: "INVITATION_LINK_UNAVAILABLE" };
  world.setFetchImpl(async () => new Response(JSON.stringify(linkBody), { status: 409 }));
  const res = await operator.operatorFetch("/api/auth/invitations/inv-9/revoke", {
    method: "POST",
    body: JSON.stringify({ commandId: "inv-r9" }),
  });
  assert.equal(res.status, 409);
  assert.deepEqual(await res.json(), linkBody, "server verdict preserved verbatim");
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0);
  assert.equal(operator.getOperatorContextSnapshot().changed, false);
});

test("invitation accept stays exempt as own-verification traffic", async () => {  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });

  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const before = world.fetchCalls.length;
  await operator.operatorFetch("/api/auth/invitations/token-1/accept", {
    method: "POST",
    body: JSON.stringify({ commandId: "inv-1", password: "x".repeat(12) }),
  });
  assert.equal(world.fetchCalls.length, before + 1, "accept transmits despite drift");
  const [, sent] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(sent), { org: null, version: null }, "accept carries no org headers");
});

test("guarded reads validate proof-of-transaction response headers", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  const guarded = (headers) =>
    new Response(JSON.stringify({ state: {} }), {
      status: 200,
      headers: { "content-type": "application/json", ...headers },
    });
  // Matching headers deliver.
  world.setFetchImpl(async () => guarded({
    "x-eventouch-organization-id": "org-a",
    "x-eventouch-context-version": "3",
  }));
  const delivered = await operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" });
  assert.equal(delivered.status, 200);
  assert.equal(operator.getOperatorContextSnapshot().changed, false);

  // Mismatched org discards, marks drift, and kicks a bounded me revalidation.
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse(ORG_B);
    return guarded({
      "x-eventouch-organization-id": "org-b",
      "x-eventouch-context-version": "7",
    });
  });
  const mismatched = await rejectsWithCode(operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" }));
  assert.equal(mismatched.code, "ORGANIZATION_CONTEXT_CHANGED");
  const drifted = operator.getOperatorContextSnapshot();
  assert.equal(drifted.changed, true, "mismatch marks drift");
  await world.flush();
  assert.equal(operator.getOperatorContextSnapshot().observed.organizationId, "org-b", "revalidation observed the header org");
  const meCalls = world.fetchCalls.filter(([url]) => String(url).includes("/api/auth/me")).length;
  assert.ok(meCalls >= 1, "mismatch kicks a revalidation");

  // Missing headers on a 2xx fail closed the same way.
  const world2 = loadWorld();
  world2.setFetchImpl(async () => meResponse(ORG_A));
  await world2.operator.ensureOperatorContext();
  world2.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) return meResponse(ORG_A);
    return new Response(JSON.stringify({ state: {} }), { status: 200 });
  });
  const missing = await rejectsWithCode(world2.operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" }));
  assert.equal(missing.code, "ORGANIZATION_CONTEXT_CHANGED");
  assert.equal(world2.operator.getOperatorContextSnapshot().changed, true, "unverified reads fail closed");
  await world2.flush();
  const meAfterMissing = world2.fetchCalls.filter(([url]) => String(url).includes("/api/auth/me")).length;
  assert.ok(meAfterMissing >= 2, "fail-closed kicks a bounded revalidation");

  // Error responses pass through untouched: no header check hides a 500.
  // (Fresh view: the missing-header drift above already blocks this world.)
  const world3 = loadWorld();
  world3.setFetchImpl(async () => meResponse(ORG_A));
  await world3.operator.ensureOperatorContext();
  world3.setFetchImpl(async () => new Response("boom", { status: 500 }));
  const failed = await world3.operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" });
  assert.equal(failed.status, 500);
});

test("pre-drift reads never deliver after the context moves", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  const matching = () =>
    new Response(JSON.stringify({ state: {} }), {
      status: 200,
      headers: { "x-eventouch-organization-id": "org-a", "x-eventouch-context-version": "3" },
    });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl(() => gate.then(matching));
  const pending = operator.operatorFetch("/api/events/e1/bootstrap", { cache: "no-store" });
  await world.flush(2);
  // Same-org explicit renewal moves the generation mid-flight.
  operator.acceptOperatorContext({ ...ORG_A, contextVersion: 9 });
  release();
  const stale = await rejectsWithCode(pending);
  assert.equal(stale.code, "ORGANIZATION_CONTEXT_CHANGED", "pre-renewal read cannot deliver after");
  assert.equal(operator.getOperatorContextSnapshot().changed, false, "quiet discard never re-marks the renewed view");

  // Auth organization endpoints and health stay readable without headers.
  world.setFetchImpl(async () => new Response(JSON.stringify({ organizations: [] }), { status: 200 }));
  const directory = await operator.operatorFetch("/api/auth/organizations", { cache: "no-store" });
  assert.equal(directory.status, 200);
});

test("refresh failure alone never locks a fresh view", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // A 503 recheck on a fresh view: truthful error, nothing else moves.
  world.setFetchImpl(async () => new Response("down", { status: 503 }));
  await operator.refreshOperatorContext();
  const failed = operator.getOperatorContextSnapshot();
  assert.equal(failed.error, "조직 정보를 다시 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요.");
  assert.equal(failed.context.organizationId, "org-a", "pinned view retained");
  assert.equal(failed.changed, false, "a failed recheck alone never engages the lock");
  assert.equal(failed.observed.organizationId, "org-a", "observed untouched");
  assert.equal(failed.uncertainWrites, 0);
});

test("noteCommittedOperatorRoleChange locks immediately without assuming the new role", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Ambiguous self-adjacent receipt stays intact across the mark.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body = JSON.stringify({ commandId: "cmd-self", command: "notice.save", payload: {} });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);

  // Slow pre-commit me returning a different org: retired by the mark.
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  world.setFetchImpl(() => gate.then(() => meResponse(ORG_B)));
  const slow = operator.refreshOperatorContext();
  await world.flush(1);
  operator.noteCommittedOperatorRoleChange();
  const marked = operator.getOperatorContextSnapshot();
  assert.equal(marked.changed, true, "the lock engages synchronously");
  assert.equal(marked.context.organizationId, "org-a", "pinned view retained");
  assert.equal(marked.context.contextVersion, 3, "no version assumed");
  assert.equal(marked.context.role, "AGENCY", "no new authority recorded");
  assert.equal(marked.uncertainWrites, 1, "frozen receipts retained");
  const announced = world.channels.flatMap((channel) => channel.posted).length;
  assert.equal(announced, 1, "one explicit broadcast");
  release();
  await slow;
  await world.flush();
  const after = operator.getOperatorContextSnapshot();
  assert.equal(after.observed.organizationId, "org-a", "delayed pre-commit read never installs");
  assert.equal(after.changed, true, "the mark survives the stale read");
  assert.equal(after.context.role, "AGENCY", "still no assumed role");

  // A second mark is stable: no new generation, no extra broadcast.
  operator.noteCommittedOperatorRoleChange();
  assert.equal(world.channels.flatMap((channel) => channel.posted).length, 1, "repeat mark stays silent");

  // The following 503 recheck keeps the lock with a truthful error.
  world.setFetchImpl(async () => new Response("down", { status: 503 }));
  await operator.refreshOperatorContext();
  const down = operator.getOperatorContextSnapshot();
  assert.equal(down.changed, true, "lock retained");
  assert.equal(down.context.organizationId, "org-a");
});

test("same-org role change with uncertain receipts: renew grants frozen replays only", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Ambiguous writes frozen to A/v3 (two receipts to cover every replay path).
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body = JSON.stringify({ commandId: "cmd-role", command: "notice.save", payload: { title: "x" } });
  const body2 = JSON.stringify({ commandId: "cmd-role-2", command: "notice.save", payload: { title: "y" } });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body: body2 });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 2);

  // Another owner changes the actor role: passive observation marks drift
  // (same org, new version, new role). The pinned workspace stays mounted.
  world.setFetchImpl(async () => meResponse({ ...ORG_A, contextVersion: 9, role: "STAFF" }));
  await operator.refreshOperatorContext();
  const drifted = operator.getOperatorContextSnapshot();
  assert.equal(drifted.changed, true);
  assert.equal(drifted.context.role, "AGENCY", "pinned workspace keeps its role");
  assert.equal(drifted.observed.role, "STAFF");
  const blocked = await rejectsWithCode(
    operator.operatorFetch("/api/events/e1/commands", { method: "POST", body })
  );
  assert.equal(blocked.code, "ORGANIZATION_CONTEXT_CHANGED", "ordinary new intent stays blocked");

  // Explicit same-org return renews ONLY the header version: pinned identity
  // keeps its role, the lock stays, and the exact frozen replay is granted.
  assert.equal(operator.renewPinnedOrganizationVersion({ ...ORG_A, contextVersion: 9, role: "STAFF" }), true);
  const renewed = operator.getOperatorContextSnapshot();
  assert.equal(renewed.context.role, "AGENCY", "no role adopt on renewal");
  assert.equal(renewed.context.contextVersion, 9, "only the version moved");
  assert.equal(renewed.changed, true, "workspace stays locked, no auto exit");
  assert.equal(renewed.uncertainWrites, 2, "receipts retained");
  const listed = operator.listUncertainAttempts();
  assert.equal(listed.length, 2);
  assert.equal(listed[0].organizationId, "org-a");
  assert.equal(listed[0].command, "notice.save", "label only, no payload leak");

  // A 5xx replay keeps the mapping under the same key: still ambiguous.
  const commandCalls = () => world.fetchCalls.filter(([url]) => String(url).includes("/commands")).length;
  const before = commandCalls();
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const kept = await operator.replayUncertainAttempt(listed[0].key);
  assert.equal(kept.settled, false);
  assert.equal(kept.status, 500, "generic status only");
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 2);

  // A context-coded 409 keeps the mapping too and keeps the lock marked.
  world.setFetchImpl(async () => new Response(
    JSON.stringify({ error: "조직이 바뀌었습니다", code: "ORGANIZATION_CONTEXT_CHANGED" }), { status: 409 }));
  const contextKept = await operator.replayUncertainAttempt(listed[0].key);
  assert.equal(contextKept.settled, false);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 2);
  assert.equal(operator.getOperatorContextSnapshot().changed, true);

  // The exact frozen replay transmits byte-identical payloads with only the
  // header version renewed; a proven 200 settles the mapping.
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const replayed = await operator.replayUncertainAttempt(listed[0].key);
  assert.equal(replayed.settled, true);
  assert.equal(replayed.status, 200, "generic status only");
  assert.equal(commandCalls(), before + 3, "exactly one transmission per explicit replay");
  const [, sent] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.deepEqual(headersOf(sent), { org: "org-a", version: "9" }, "only the header version renewed");
  assert.equal(sent.body, body, "commandId and payload byte-identical");
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 1);

  // A definitive 4xx settles the remaining mapping: nothing was committed.
  world.setFetchImpl(async () => new Response(JSON.stringify({ error: "bad" }), { status: 400 }));
  const settled = await operator.replayUncertainAttempt(listed[1].key);
  assert.equal(settled.settled, true);
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0, "proven rejection clears");

  // All receipts resolved: still no auto exit — the lock needs the explicit
  // role-home path.
  assert.equal(operator.getOperatorContextSnapshot().changed, true, "no auto exit when receipts clear");
});

test("later drift invalidates the renewed replay grant", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body = JSON.stringify({ commandId: "cmd-grant", command: "notice.save", payload: {} });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });
  world.setFetchImpl(async () => meResponse({ ...ORG_A, contextVersion: 9, role: "STAFF" }));
  await operator.refreshOperatorContext();
  assert.equal(operator.renewPinnedOrganizationVersion({ ...ORG_A, contextVersion: 9, role: "STAFF" }), true);

  // A further switch to another org revokes the grant even though the pinned
  // workspace is still the entry's org.
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });
  const key = operator.listUncertainAttempts()[0].key;
  const before = world.fetchCalls.length;
  const revoked = await rejectsWithCode(operator.replayUncertainAttempt(key));
  assert.equal(revoked.code, "ORGANIZATION_CONTEXT_CHANGED");
  assert.equal(world.fetchCalls.length, before, "invalidated grant never transmits");
  assert.equal(operator.listUncertainAttempts().length, 1, "mapping retained for the explicit return");
});

test("stale same-org observed after renew never vetoes the renewed grant", async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  // Freeze one receipt at the pinned version.
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body = JSON.stringify({ commandId: "cmd-stale-obs", command: "notice.save", payload: {} });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body });

  // The browser sequence: the role change is observed at the CURRENT
  // version (not the future one), then the explicit restore renews forward.
  world.setFetchImpl(async () => meResponse({ ...ORG_A, contextVersion: 3, role: "STAFF" }));
  await operator.refreshOperatorContext();
  assert.equal(operator.getOperatorContextSnapshot().changed, true);
  assert.equal(operator.renewPinnedOrganizationVersion({ ...ORG_A, contextVersion: 4, role: "STAFF" }), true);

  // The pre-restore observed snapshot (v3) must not veto the renewed (v4)
  // entry: the replay transmits with only the header version renewed.
  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const before = world.fetchCalls.length;
  const replayed = await operator.replayUncertainAttempt(operator.listUncertainAttempts()[0].key);
  assert.equal(replayed.settled, true);
  assert.equal(world.fetchCalls.length, before + 1, "stale observed never blocks the renewed replay");
  const [, sent] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.equal(sent.body, body, "commandId and payload byte-identical");
  assert.equal(operator.listUncertainAttempts()[0]?.replayable ?? true, true, "replayable entries expose an active control");

  // A genuinely NEWER observation after the renew revokes the grant again.
  // (Clear the lock first through an explicit same-org accept so the second
  // freeze transmits; ordinary intents stay blocked while changed.)
  operator.acceptOperatorContext({ ...ORG_A, contextVersion: 4 });
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  const body2 = JSON.stringify({ commandId: "cmd-stale-obs-2", command: "notice.save", payload: {} });
  await operator.operatorFetch("/api/events/e1/commands", { method: "POST", body: body2 });
  world.setFetchImpl(async () => meResponse({ ...ORG_A, contextVersion: 4, role: "STAFF" }));
  await operator.refreshOperatorContext();
  assert.equal(operator.renewPinnedOrganizationVersion({ ...ORG_A, contextVersion: 5, role: "STAFF" }), true);
  world.setFetchImpl(async () => meResponse({ ...ORG_A, contextVersion: 6, role: "STAFF" }));
  await operator.refreshOperatorContext();
  const callsBefore = world.fetchCalls.length;
  const revoked = await rejectsWithCode(operator.replayUncertainAttempt(operator.listUncertainAttempts()[0].key));
  assert.equal(revoked.code, "ORGANIZATION_CONTEXT_CHANGED");
  assert.equal(world.fetchCalls.length, callsBefore, "newer drift never transmits");
});

test("file upload query commandId is captured and replayed with its body", async () => {

  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  const payload = new Blob(["bytes"], { type: "application/octet-stream" });
  world.setFetchImpl(async () => new Response("oops", { status: 500 }));
  await operator.operatorFetch("/api/events/e1/files?commandId=up-1", { method: "POST", body: payload });
  const listed = operator.listUncertainAttempts();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].key, "up-1", "query commandId keys the receipt");
  assert.equal(listed[0].path, "/api/events/e1/files");

  world.setFetchImpl(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const result = await operator.replayUncertainAttempt("up-1");
  assert.equal(result.settled, true);
  assert.equal(result.status, 200);
  const [url, sent] = world.fetchCalls[world.fetchCalls.length - 1];
  assert.ok(String(url).includes("commandId=up-1"), "frozen url includes the query key");
  assert.deepEqual(headersOf(sent), { org: "org-a", version: "3" });
  assert.equal(operator.getOperatorContextSnapshot().uncertainWrites, 0);
});

test("non-me reads racing the initial me never retire its seed", async () => {
  const world = loadWorld();
  const { operator } = world;
  let releaseMe;
  const meGate = new Promise((resolve) => {
    releaseMe = resolve;
  });
  let meCalls = 0;
  const proofA = () =>
    new Response(JSON.stringify({ state: { events: ["a"] } }), {
      status: 200,
      headers: { "x-eventouch-organization-id": "org-a", "x-eventouch-context-version": "3" },
    });
  world.setFetchImpl(async (url) => {
    const target = String(url);
    if (target.includes("/api/auth/me")) {
      meCalls += 1;
      if (meCalls === 1) {
        await meGate;
        return meResponse(ORG_A);
      }
      return meResponse(ORG_B);
    }
    if (target.includes("/api/auth/organizations")) {
      return new Response(JSON.stringify({ organizations: [], contextVersion: 3 }), { status: 200 });
    }
    return proofA();
  });
  const initial = operator.ensureOperatorContext();
  await world.flush(2);
  // Mount storm while the initial me is still pending: org list and a
  // guarded directory read begin. Neither may consume a me sequence.
  const orgs = operator.operatorFetch("/api/auth/organizations", { cache: "no-store" });
  const dir = operator.operatorFetch("/api/console/directory", { cache: "no-store" });
  await world.flush(2);
  releaseMe();
  const pinned = await initial;
  assert.equal(pinned.organizationId, "org-a", "initial me seeds despite racing reads");
  const orgRes = await orgs;
  assert.equal(orgRes.status, 200);
  const dirRes = await dir;
  assert.equal(dirRes.status, 200, "matching proof delivers against the joined pin");
  assert.deepEqual(await dirRes.json(), { state: { events: ["a"] } });
  await world.flush(2);
  const snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.context.organizationId, "org-a");
  assert.equal(snapshot.changed, false);
  assert.equal(snapshot.error, null);
  assert.equal(meCalls, 1, "racing reads issue no extra me requests");
  // Only a genuinely newer /auth/me retires the seed.
  const fresh = await operator.operatorFetch("/api/auth/me", { cache: "no-store" });
  assert.equal(fresh.status, 200);
  await world.flush(2);
  const after = operator.getOperatorContextSnapshot();
  assert.equal(after.changed, true, "newer me still marks drift");
  assert.equal(after.observed.organizationId, "org-b");
  assert.equal(after.context.organizationId, "org-a", "pinned view still never moves silently");
  assert.equal(meCalls, 2);
});

test("unpinned private reads prove against the initial pin, never launch ignorance", async () => {
  const proofA = () =>
    new Response(JSON.stringify({ state: { events: ["a"] } }), {
      status: 200,
      headers: { "x-eventouch-organization-id": "org-a", "x-eventouch-context-version": "3" },
    });

  // A read launched before any pin returns old-A proof after me pins B:
  // the stale proof is rejected, the fresh pin stands.
  {
    const world = loadWorld();
    const { operator } = world;
    let releaseDir;
    const dirGate = new Promise((resolve) => {
      releaseDir = resolve;
    });
    world.setFetchImpl(async (url) => {
      if (String(url).includes("/api/auth/me")) return meResponse(ORG_B);
      if (String(url).includes("/directory")) return dirGate.then(proofA);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const pending = operator.operatorFetch("/api/console/directory", { cache: "no-store" });
    await world.flush(2);
    releaseDir();
    const rejected = await rejectsWithCode(pending);
    assert.equal(rejected.code, "ORGANIZATION_CONTEXT_CHANGED", "stale proof never populates the fresh pin");
    await world.flush(2);
    const snap = operator.getOperatorContextSnapshot();
    assert.equal(snap.context.organizationId, "org-b", "initial me still seeded");
    assert.equal(snap.observed.organizationId, "org-b");
    assert.equal(snap.changed, true, "unverifiable skew fails closed");
  }

  // Matching proof delivers against the joined initial pin.
  {
    const world = loadWorld();
    const { operator } = world;
    let releaseDir;
    const dirGate = new Promise((resolve) => {
      releaseDir = resolve;
    });
    world.setFetchImpl(async (url) => {
      if (String(url).includes("/api/auth/me")) return meResponse(ORG_A);
      if (String(url).includes("/directory")) return dirGate.then(proofA);
      return new Response(JSON.stringify({}), { status: 200 });
    });
    const pending = operator.operatorFetch("/api/console/directory", { cache: "no-store" });
    await world.flush(2);
    releaseDir();
    const delivered = await pending;
    assert.equal(delivered.status, 200);
    assert.deepEqual(await delivered.json(), { state: { events: ["a"] } });
    await world.flush();
    assert.equal(operator.getOperatorContextSnapshot().changed, false);
    assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a");
  }

  // Me failing (503) rejects the unverified read truthfully: its own
  // status, never a manufactured context block, and no pin at all.
  {
    const world = loadWorld();
    const { operator } = world;
    world.setFetchImpl(async (url) => {
      if (String(url).includes("/api/auth/me")) return new Response("down", { status: 503 });
      return proofA();
    });
    const pending = operator.operatorFetch("/api/console/directory", { cache: "no-store" });
    const failed = await rejectsWithCode(pending);
    assert.equal(failed.status, 503, "truthful me failure, not false context");
    assert.equal(operator.isOrganizationContextBlock(failed), false);
    await world.flush();
    const snap = operator.getOperatorContextSnapshot();
    assert.equal(snap.context, null, "nothing pinned on failure");
    assert.equal(snap.changed, false, "no drift manufactured");
  }
});

test("retired initial ensure joins the winning validation instead of failing", async () => {
  const world = loadWorld();
  const { operator } = world;
  let releaseEnsure;
  let releaseValidate;
  const ensureGate = new Promise((resolve) => {
    releaseEnsure = resolve;
  });
  const validateGate = new Promise((resolve) => {
    releaseValidate = resolve;
  });
  let meCalls = 0;
  world.setFetchImpl(async (url) => {
    if (!String(url).includes("/api/auth/me")) return new Response(JSON.stringify({}), { status: 200 });
    meCalls += 1;
    if (meCalls === 1) {
      await ensureGate;
      return meResponse(ORG_A);
    }
    await validateGate;
    return meResponse(ORG_B);
  });
  const initial = operator.ensureOperatorContext();
  await world.flush(2);
  const recheck = operator.refreshOperatorContext();
  await world.flush(2);
  // The retired ensure response arrives FIRST, while the winning validation
  // is still pending: no generic failure — ensure joins the bounded winner.
  releaseEnsure();
  await world.flush(3);
  let settled = false;
  void initial.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    }
  );
  await world.flush(1);
  assert.equal(settled, false, "ensure waits for the winning validation, never fails retired");
  releaseValidate();
  const pinned = await initial;
  await recheck;
  await world.flush(2);
  assert.equal(pinned.organizationId, "org-b", "ensure resolves the actual winning outcome");
  const snapshot = operator.getOperatorContextSnapshot();
  assert.equal(snapshot.context.organizationId, "org-b");
  assert.equal(snapshot.changed, false);
  assert.equal(snapshot.error, null);
});

test("shared me authority never delivers a superseded body", async () => {
  const world = loadWorld();
  const { operator, consoleApi } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();

  let releaseSlow;
  const slowGate = new Promise((resolve) => {
    releaseSlow = resolve;
  });
  let meCalls = 0;
  world.setFetchImpl(async (url) => {
    if (!String(url).includes("/api/auth/me")) return new Response(JSON.stringify({}), { status: 200 });
    meCalls += 1;
    if (meCalls === 1) {
      await slowGate;
      return meResponse(ORG_A);
    }
    return meResponse(ORG_B);
  });
  // Slow shared authority read in flight while a newer me lands first.
  const shared = consoleApi.consoleFetch("/api/auth/me", { cache: "no-store" });
  await world.flush(2);
  const fresh = await operator.operatorFetch("/api/auth/me", { cache: "no-store" });
  assert.equal(fresh.status, 200);
  await world.flush(2);
  assert.equal(operator.getOperatorContextSnapshot().observed.organizationId, "org-b");
  // The stale shared read must never deliver its old-A body as authority.
  releaseSlow();
  const stale = await rejectsWithCode(shared);
  assert.equal(operator.isSupersededMe(stale), true, "superseded me rejected quietly, never delivered");
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a", "pinned retained");
  assert.equal(operator.getOperatorContextSnapshot().changed, true);
  // A fresh shared read proving a different authority than pinned is fenced
  // the same way: only the unchanged pinned authority delivers.
  const foreign = await rejectsWithCode(consoleApi.consoleFetch("/api/auth/me", { cache: "no-store" }));
  assert.equal(operator.isSupersededMe(foreign), true);
  // Matching authority still delivers.
  world.setFetchImpl(async () => meResponse(ORG_A));
  const matching = await consoleApi.consoleFetch("/api/auth/me", { cache: "no-store" });
  assert.equal(matching.status, 200);
  assert.equal((await matching.json()).user.organizationId, "org-a");
});

test("unpinned reads resolving after pin-then-drift discard quietly", async () => {
  const world = loadWorld();
  const { operator } = world;
  let releaseDir;
  const dirGate = new Promise((resolve) => {
    releaseDir = resolve;
  });
  const proofA = () =>
    new Response(JSON.stringify({ state: { events: ["a"] } }), {
      status: 200,
      headers: { "x-eventouch-organization-id": "org-a", "x-eventouch-context-version": "3" },
    });
  let meCalls = 0;
  world.setFetchImpl(async (url) => {
    if (String(url).includes("/api/auth/me")) {
      meCalls += 1;
      return meResponse(ORG_A);
    }
    if (String(url).includes("/directory")) return dirGate.then(proofA);
    return new Response(JSON.stringify({}), { status: 200 });
  });
  // Launched with no pinned view; resolves only after pin A then drift A→B.
  const pending = operator.operatorFetch("/api/console/directory", { cache: "no-store" });
  await world.flush(2);
  await operator.ensureOperatorContext();
  assert.equal(operator.getOperatorContextSnapshot().context.organizationId, "org-a");
  operator.observeSelectedOrganization({ ...ORG_B, contextVersion: 7 });
  assert.equal(operator.getOperatorContextSnapshot().changed, true);
  const meBefore = meCalls;
  releaseDir();
  const quiet = await rejectsWithCode(pending);
  assert.equal(quiet.code, "ORGANIZATION_CONTEXT_CHANGED");
  assert.equal(quiet.message, "읽은 뒤 화면이 바뀌었습니다. 다시 시도하세요.");
  await world.flush(3);
  assert.equal(meCalls, meBefore, "quiet discard kicks no revalidation loop");
  const snap = operator.getOperatorContextSnapshot();
  assert.equal(snap.context.organizationId, "org-a", "pinned retained");
  assert.equal(snap.observed.organizationId, "org-b", "drift untouched");
  assert.equal(snap.changed, true);
});
