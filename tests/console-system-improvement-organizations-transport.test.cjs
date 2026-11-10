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
for (const file of ["operator-receipts.ts", "booth-availability.ts", "bulk-cancel-proof.ts", "operator-context.ts", "console-api.ts"]) {
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
  const storage = new Map();
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
    Event,
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
      sessionStorage: {
        getItem: (key) => storage.has(key) ? storage.get(key) : null,
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
      },
      dispatchEvent: (event) => {
        for (const listener of windowListeners[event.type] || []) listener(event);
        return true;
      },
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
      if (spec === "./operator-receipts") return registry["operator-receipts"].exports;
      if (spec === "./booth-availability") return registry["booth-availability"].exports;
      if (spec === "./bulk-cancel-proof") return registry["bulk-cancel-proof"].exports;
      throw new Error(`unexpected require ${spec}`);
    };
    const factory = vm.runInContext(`(function(exports, require, module) { ${source} })`, sandbox);
    factory(module.exports, localRequire, module);
    registry[name] = module;
    return module.exports;
  }
  const receipts = load("operator-receipts", compiled["operator-receipts.ts"]);
  load("booth-availability", compiled["booth-availability.ts"]);
  load("bulk-cancel-proof", compiled["bulk-cancel-proof.ts"]);
  const operator = load("operator-context", compiled["operator-context.ts"]);
  const consoleApi = load("console-api", compiled["console-api.ts"]);
  return {
    operator,
    receipts,
    consoleApi,
    fetchCalls,
    setFetchImpl: (fn) => {
      fetchImpl = fn;
    },
    windowListeners,
    documentListeners,
    channels,
    denyReceiptStorage: () => {
      Object.defineProperty(sandbox.window, 'sessionStorage', { configurable: true, get() { throw new Error('storage denied'); } });
      Object.defineProperty(sandbox.window, 'localStorage', { configurable: true, get() { throw new Error('storage denied'); } });
    },
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

test('receipt tracking never waits for a stalled successful response body', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  let controller;
  const bodyStream = new ReadableStream({ start(c) { controller = c; } });
  world.setFetchImpl(async () => new Response(bodyStream, { status: 200 }));
  const request = world.operator.operatorFetch('/api/events/event-123/commands', {
    method: 'POST', body: JSON.stringify({ commandId: 'command-stalled-123', command: 'form.close', payload: {} }),
  });
  const response = await Promise.race([request, new Promise((_, reject) => setTimeout(() => reject(new Error('response was blocked on receipt parsing')), 250))]);
  assert.equal(response.status, 200);
  controller.enqueue(new TextEncoder().encode('{"registrationOpen":false}'));
  controller.close();
  await world.flush(5);
  assert.equal(world.receipts.operatorReceipts().length, 0, 'a readable successful response clears its pointer');
});

test('unreadable success and a rejection after an ambiguous request retain only scope pointers', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const body = JSON.stringify({ commandId: 'command-unconfirmed-123', command: 'event.update', payload: { name: 'sensitive draft' } });
  world.setFetchImpl(async () => new Response('bad json', { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
  await world.flush(5);
  const first = world.receipts.operatorReceipts();
  assert.equal(first.length, 1);
  assert.equal(JSON.stringify(first).includes('sensitive draft'), false);
  world.setFetchImpl(async () => new Response('{"error":"revoked"}', { status: 403 }));
  await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
  assert.equal(world.receipts.operatorReceipts().length, 1, 'later rejection cannot erase a previously ambiguous outcome');
});

test('draw response confirmation matches the original request and requires an actual winner receipt', () => {
  const { operator } = loadWorld();
  const payload = { id: 'draw-1', count: 1 };
  const result = { winners: [{ kind: 'PERSON', name: '합성 참가자' }], program: { id: 'draw-1', winners: [{ kind: 'PERSON', name: '합성 참가자' }] }, remaining: 1 };
  assert.equal(operator.confirmsDrawRun(payload, result), true);
  assert.equal(operator.confirmsDrawRun(payload, { message: 'ok' }), false);
  assert.equal(operator.confirmsDrawRun(payload, { ...result, program: { ...result.program, id: 'other' } }), false);
  assert.equal(operator.confirmsDrawRun(payload, { ...result, winners: [] }), false);
  assert.equal(operator.confirmsDrawRun({ ...payload, showOnScreen: true }, result), false);
  assert.equal(operator.confirmsDrawRun({ ...payload, showOnScreen: true }, { ...result, display: { type: 'draw' } }), true);
  const stagePayload = { ...payload, showOnScreen: true };
  const stageResult = { ...result, program: { ...result.program, moduleId: 'module-1' }, display: { type: 'draw', moduleId: 'module-1', drawId: 'selected-draw' } };
  assert.equal(operator.confirmsDrawRun(stagePayload, stageResult, 'other-draw'), false);
  assert.equal(operator.confirmsDrawRun(stagePayload, stageResult, 'selected-draw'), true);
  assert.equal(operator.confirmsOperationsCommand('display.set', stageResult.display, { display: { ...stageResult.display, drawId: 'other-draw' } }), false);
  const reviewed = { ...payload, expectedRevision: 2 };
  assert.equal(operator.confirmsDrawRun(reviewed, result), false);
  assert.equal(operator.confirmsDrawRun(reviewed, { ...result, program: { ...result.program, revision: 4 } }), false);
  assert.equal(operator.confirmsDrawRun(reviewed, { ...result, program: { ...result.program, revision: 3 } }), true);
});

test('draw and voting receipts match each submitted operation and reject incomplete results', async () => {
  const world = loadWorld();
  const { operator } = world;
  world.setFetchImpl(async () => meResponse(ORG_A));
  await operator.ensureOperatorContext();
  const cases = [
    ['team.save', { name: '합성 팀' }, { team: { id: 'team-1', name: '합성 팀', order: 1 } }, { team: { id: 'team-1', name: '다른 팀', order: 1 } }],
    ['draw.program.save', { name: '합성 추첨', quota: 2, moduleId: 'module-1', eligibility: 'PERSON', eligibleGroups: [], eligibleCompanies: [], overlap: 'EVENT', prizeTiers: null },
      { program: { id: 'draw-1', name: '합성 추첨', quota: 2, moduleId: 'module-1', eligibility: 'PERSON', eligibleGroups: [], eligibleCompanies: [], overlap: 'EVENT', prizeTiers: null } },
      { program: { id: 'draw-1', name: '합성 추첨', quota: 3, moduleId: 'module-1', eligibility: 'PERSON', eligibleGroups: [], eligibleCompanies: [], overlap: 'EVENT', prizeTiers: null } }],
    ['vote.config.save', { pickCount: 1, status: 'OPEN', resultsPublished: false }, { voteConfig: { pickCount: 1, status: 'OPEN', resultsPublished: false } }, { voteConfig: { pickCount: 1, status: 'CLOSED', resultsPublished: false } }],
    ['lucky.config.save', { min: 1, max: 20 }, { luckyConfig: { min: 1, max: 20 } }, { luckyConfig: { min: 1, max: 21 } }],
    ['lucky.config.save-reviewed', { min: 1, max: 20, expectedRange: { min: 1, max: 10 } }, { luckyConfig: { min: 1, max: 20 } }, { luckyConfig: { min: 1, max: 21 } }],
    ['lucky.preassign', { participantIds: ['p-1', 'p-2'] }, { assigned: [{ participantId: 'p-1', number: 5 }], skipped: 1, range: { min: 1, max: 20 } }, { assigned: [{ participantId: 'p-3', number: 5 }], skipped: 1, range: { min: 1, max: 20 } }],
    ['lucky.preassign-reviewed', { participantIds: ['p-1', 'p-2'] }, { assigned: [{ participantId: 'p-1', number: 5 }], skipped: 1, range: { min: 1, max: 20 } }, { assigned: [{ participantId: 'p-3', number: 5 }], skipped: 1, range: { min: 1, max: 20 } }],
    ['lucky.preassign-range-reviewed', { participantIds: ['p-1', 'p-2'], expectedRange: { min: 1, max: 20 } }, { assigned: [{ participantId: 'p-1', number: 5 }], skipped: 1, range: { min: 1, max: 20 } }, { assigned: [{ participantId: 'p-1', number: 5 }], skipped: 1, range: { min: 1, max: 21 } }],
    ['roulette.config.save', { status: 'DRAFT', startsAt: '', endsAt: '', prizes: [{ id: 'prize-1', label: '합성 상품', quantity: 3 }] },
      { rouletteConfig: { status: 'DRAFT', startsAt: null, endsAt: null, prizes: [{ id: 'prize-1', label: '합성 상품', quantity: 3, weight: null }] } },
      { rouletteConfig: { status: 'DRAFT', startsAt: null, endsAt: null, prizes: [{ id: 'prize-1', label: '합성 상품', quantity: 4, weight: null }] } }],
    ['roulette.config.save-reviewed', { expectedVersion: 2, status: 'DRAFT', startsAt: '', endsAt: '', prizes: [{ id: 'prize-1', label: '합성 상품', quantity: 3 }] },
      { rouletteConfigVersion: 3, rouletteConfig: { status: 'DRAFT', startsAt: null, endsAt: null, prizes: [{ id: 'prize-1', label: '합성 상품', quantity: 3, weight: null }] } },
      { rouletteConfigVersion: 2, rouletteConfig: { status: 'DRAFT', startsAt: null, endsAt: null, prizes: [{ id: 'prize-1', label: '합성 상품', quantity: 3, weight: null }] } }],
    ['reward.assign', { id: 'reward-1', participantId: 'p-1' }, { reward: { id: 'reward-1', participantId: 'p-1', status: 'READY' } }, { reward: { id: 'reward-1', participantId: 'p-2', status: 'READY' } }],
    ['vote.tally', {}, { results: [{ teamId: 'team-1', name: '팀', selections: 0, rank: 1, tied: false }], totalVotes: 0, published: false }, { results: [{ teamId: 'team-1' }], totalVotes: 0, published: false }],
  ];
  for (const [index, [command, payload, valid, invalid]] of cases.entries()) {
    assert.equal(operator.confirmsDrawOperation(command, payload, valid), true, `${command} accepts matching fields`);
    assert.equal(operator.confirmsDrawOperation(command, payload, invalid), false, `${command} rejects unrelated fields`);
    const body = JSON.stringify({ commandId: `draw-operation-${index}`, command, payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(invalid), { status: 200 }));
    await operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${command} keeps the scoped pointer`);
    assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('합성'), false);
    world.setFetchImpl(async () => new Response(JSON.stringify(valid), { status: 200 }));
    await operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${command} clears a matching response`);
  }
});

test('template receipts require the submitted name, channel and message without storing them', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const payload = { name: ' 합성 안내 ', channel: 'SMS', body: ' 합성 본문 ', solapiTemplateId: '' };
  const valid = { template: { id: 'template-1', name: '합성 안내', channel: 'SMS', body: '합성 본문', solapiTemplateId: null } };
  const body = JSON.stringify({ commandId: 'template-receipt-123', command: 'template.save', payload });
  assert.equal(world.operator.confirmsTemplateSave(payload, valid), true);
  assert.equal(world.operator.confirmsTemplateSave(payload, { template: { ...valid.template, body: '다른 본문' } }), false);
  assert.equal(world.operator.confirmsTemplateSave({ ...payload, id: 'template-2' }, valid), false);
  assert.equal(world.operator.confirmsTemplateSave({ ...payload, channel: 'ALIMTALK', solapiTemplateId: 'approved-1' }, { template: { ...valid.template, channel: 'ALIMTALK', solapiTemplateId: 'other' } }), false);
  world.setFetchImpl(async () => new Response(JSON.stringify({ template: { ...valid.template, name: '다른 안내' } }), { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1);
  assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('합성'), false);
  world.setFetchImpl(async () => new Response(JSON.stringify(valid), { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 0);
});

test('program operations validate their target and draw receipt before clearing scoped pointers', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const id = 'program-operation-123';
  const cases = [
    ['module.status', { id: 'module-1', status: 'OPEN' }, { module: { id: 'module-1', status: 'OPEN', published: true } }, { module: { id: 'other', status: 'OPEN', published: true } }],
    ['module.reveal', { id: 'module-1' }, { moduleId: 'module-1', revealed: true }, { moduleId: 'other', revealed: true }],
    ['photo.moderate', { id: 'photo-1', status: 'HIDDEN' }, { photo: { id: 'photo-1', status: 'HIDDEN' } }, { photo: { id: 'photo-1', status: 'APPROVED' } }],
    ['post.moderate', { id: 'post-1', status: 'APPROVED' }, { post: { id: 'post-1', status: 'APPROVED' } }, { post: { id: 'other', status: 'APPROVED' } }],
    ['draw.run', { id: 'module-1', count: 1 }, { winners: [{ id: 'p1', name: '합성 참가자' }], poolCount: 3, draw: { id, winners: [{ id: 'p1', name: '합성 참가자' }], poolCount: 3, published: false } }, { winners: [], poolCount: 3, draw: { id, winners: [], poolCount: 3, published: false } }],
  ];
  for (const [command, payload, valid, invalid] of cases) {
    assert.equal(world.operator.confirmsProgramOperation(command, id, payload, valid), true, command);
    assert.equal(world.operator.confirmsProgramOperation(command, id, payload, invalid), false, command);
    const body = JSON.stringify({ commandId: id, command, payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body }); await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, command);
    world.setFetchImpl(async () => new Response(JSON.stringify(valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body }); await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, command);
  }
  const payload = { id: 'module-1' };
  assert.equal(world.operator.confirmsProgramOperation('draw.publish', id, payload, { draw: { id: 'draw-1', published: true } }, 'draw-1'), true);
  assert.equal(world.operator.confirmsProgramOperation('draw.publish', id, payload, { draw: { id: 'draw-2', published: true } }, 'draw-1'), false);
  const body = JSON.stringify({ commandId: id, command: 'draw.publish', payload });
  world.setFetchImpl(async () => new Response('{"draw":{"id":"draw-1","published":true}}', { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body }); await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1, 'publish has no module ID in its response; the screen must confirm its known draw');
  const guarded = JSON.stringify({ commandId: 'guarded-' + id, command: 'draw.publish', payload: { ...payload, expectedDrawId: 'draw-1' } });
  world.setFetchImpl(async () => new Response('{"draw":{"id":"draw-2","published":true}}', { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body: guarded }); await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 2, 'another result cannot resolve the guarded request');
  world.setFetchImpl(async () => new Response('{"draw":{"id":"draw-1","published":true}}', { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body: guarded }); await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1);
});

test('customer and event receipts require a response matching the submitted write', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const clientBody = JSON.stringify({ commandId: 'customer-unconfirmed-1', name: ' 합성 고객사 ', contact: '개인정보' });
  world.setFetchImpl(async () => new Response('{"message":"ok"}', { status: 200 }));
  await world.operator.operatorFetch('/api/clients', { method: 'POST', body: clientBody });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1);
  assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('개인정보'), false);
  world.setFetchImpl(async () => new Response('{"client":{"id":"client-1","name":"합성 고객사","contact":"개인정보"}}', { status: 200 }));
  await world.operator.operatorFetch('/api/clients', { method: 'POST', body: clientBody });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 0);

  const eventBody = JSON.stringify({ commandId: 'event-unconfirmed-1', name: '검증 행사', slug: 'audit-event' });
  world.setFetchImpl(async () => new Response('{"event":{"id":"wrong-event","name":"다른 행사","slug":"audit-event"}}', { status: 200 }));
  await world.operator.operatorFetch('/api/events', { method: 'POST', body: eventBody });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1, 'a different event must not clear the pointer');
  assert.equal(world.operator.confirmsClientSave({ id: 'client-1', name: '고객사', logoFileId: '' }, { client: { id: 'client-1', name: '고객사', logoFileId: 'still-linked' } }), false);
  assert.equal(world.operator.confirmsEventCreation({ name: '검증 행사', slug: 'audit-event' }, { event: { id: 'event-1', name: '검증 행사', slug: 'audit-event' } }), true);
});

test('invitation and password-reset pointers never store credentials and require the matching response', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const invitation = { commandId: 'invite-unconfirmed-1', name: '합성 이름', email: 'invite@example.invalid', role: 'MANAGER' };
  world.setFetchImpl(async () => new Response('{"message":"ok"}', { status: 200 }));
  await world.operator.operatorFetch('/api/auth/invitations', { method: 'POST', body: JSON.stringify(invitation) });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1);
  assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes(invitation.email), false);
  const issued = { token: 'one-time-secret', invitation: { id: 'inv-1', name: invitation.name, email: invitation.email, role: invitation.role, eventId: null } };
  world.setFetchImpl(async () => new Response(JSON.stringify(issued), { status: 201 }));
  await world.operator.operatorFetch('/api/auth/invitations', { method: 'POST', body: JSON.stringify(invitation) });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 0);

  const reset = { commandId: 'password-unconfirmed-1', password: 'synthetic-password-only' };
  world.setFetchImpl(async () => new Response('{"account":{"id":"different-user"}}', { status: 200 }));
  await world.operator.operatorFetch('/api/auth/accounts/target-user/password', { method: 'POST', body: JSON.stringify(reset) });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1);
  assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes(reset.password), false);
  world.setFetchImpl(async () => new Response('{"account":{"id":"target-user"}}', { status: 200 }));
  await world.operator.operatorFetch('/api/auth/accounts/target-user/password', { method: 'POST', body: JSON.stringify(reset) });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 0);

  const grant = { commandId: 'grant-unconfirmed-1', accountId: 'target-user', write: ['participants'], enabled: true };
  world.setFetchImpl(async () => new Response('{"membership":{"eventId":"event-1","accountId":"target-user","write":["all"]}}', { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-1/members', { method: 'POST', body: JSON.stringify(grant) });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 1, 'different grants cannot clear a pointer');
  world.setFetchImpl(async () => new Response('{"membership":{"eventId":"event-1","accountId":"target-user","write":["participants"]}}', { status: 200 }));
  await world.operator.operatorFetch('/api/events/event-1/members', { method: 'POST', body: JSON.stringify(grant) });
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 0);
});

test('in-flight status pointers remain available to another screen without exposing inputs', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  let finish;
  world.setFetchImpl(() => new Promise((resolve) => { finish = resolve; }));
  const request = world.operator.operatorFetch('/api/clients', { method: 'POST', body: JSON.stringify({ commandId: 'inflight-client-1', name: '합성 개인정보' }) });
  await world.flush();
  assert.equal(world.receipts.visibleOperatorReceipts().length, 0, 'the recovery panel hides active requests');
  assert.equal(world.receipts.operatorReceipts().length, 1, 'another task can still see the minimal active pointer');
  assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('합성 개인정보'), false);
  finish(new Response('{"client":{"id":"client-1","name":"합성 개인정보"}}', { status: 201 }));
  await request;
  await world.flush();
  assert.equal(world.receipts.operatorReceipts().length, 0);
});

test('local recovery hides only its presentation and reveals the pointer on leave', async () => {
  const world = loadWorld();
  const pointer = { userId: 'user-1', organizationId: 'org-1', eventId: 'event-1', commandId: 'import-managed-1', command: 'participant.import' };
  assert.equal(world.receipts.beginOperatorReceipt(pointer), false);
  world.receipts.endOperatorReceipt(pointer.commandId, false);
  assert.equal(world.receipts.visibleOperatorReceipts().length, 1);
  const releaseFirst = world.receipts.manageOperatorReceipt(pointer.commandId);
  const releaseSecond = world.receipts.manageOperatorReceipt(pointer.commandId);
  assert.equal(world.receipts.visibleOperatorReceipts().length, 0);
  assert.equal(world.receipts.operatorReceipts().length, 1, 'the status-only pointer is still saved');
  releaseFirst();
  assert.equal(world.receipts.visibleOperatorReceipts().length, 0, 'another mounted owner remains');
  releaseSecond();
  assert.equal(world.receipts.visibleOperatorReceipts().length, 1, 'leaving reveals the same pointer');
});

test('roster receipt confirmation requires the original participant, group and reward results', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const scenarios = [
    { command: 'participant.create', payload: { name: '합성 참가자', phone: '010-5555-1234' }, valid: { participant: { id: 'p-1', name: '합성 참가자', phone: '01055551234' } }, invalid: { participant: { name: '합성 참가자' } } },
    { command: 'participant.status', payload: { ids: ['p-1', 'p-2'], status: 'APPROVED' }, valid: { participants: [{ id: 'p-1', status: 'APPROVED' }, { id: 'p-2', status: 'APPROVED' }] }, invalid: { participants: [{ id: 'p-1', status: 'APPROVED' }] } },
    { command: 'group.assign', payload: { ids: ['p-1', 'p-2'], group: 'VIP' }, valid: { group: 'VIP', participantIds: ['p-2', 'p-1'] }, invalid: { group: 'VIP', participantIds: ['p-1'] } },
    { command: 'reward.create', payload: { participantId: 'p-1', name: '합성 경품', method: 'ONSITE' }, valid: { reward: { id: 'roster-receipt-3', participantId: 'p-1', name: '합성 경품', method: 'ONSITE' } }, invalid: { reward: { id: 'wrong', participantId: 'p-1' } } },
    { command: 'participant.import', payload: { rows: [{ name: '합성 1', phone: '01055550001' }, { name: '합성 2', phone: '01055550002' }] }, valid: { participants: [{ id: 'p-2', name: '합성 2', phone: '01055550002' }, { id: 'p-1', name: '합성 1', phone: '01055550001' }] }, invalid: { participants: [{ id: 'p-1', name: '합성 1', phone: '01055550001' }] } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `roster-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} retains an unverified result`);
    assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('010-5555-1234'), false);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts a matching result`);
  }
});

test('staff booth receipt remains recoverable until response identifies the requested visit and booth', async () => {
  for (const invalid of [
    {name:'합성 참가자',booth:'합성 부스'},
    {name:'합성 참가자',booth:'합성 부스',visitId:'another-command',boothId:'booth-a',participantId:'p-1'},
    {name:'합성 참가자',booth:'합성 부스',visitId:'booth-command-123',boothId:'booth-b',participantId:'p-1'},
    {name:'합성 참가자',booth:'합성 부스',visitId:'booth-command-123',boothId:'booth-a',participantId:''},
  ]) {
    const world=loadWorld();
    world.setFetchImpl(async()=>meResponse(ORG_A));
    await world.operator.ensureOperatorContext();
    const body=JSON.stringify({commandId:'booth-command-123',command:'booth.visit',assignmentId:'assignment-a',
      payload:{boothId:'booth-a',ticket:'synthetic-private-ticket'}});
    world.setFetchImpl(async()=>new Response(JSON.stringify(invalid),{status:201}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body});
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length,1);
    assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('synthetic-private-ticket'),false);
    world.setFetchImpl(async()=>new Response(JSON.stringify({name:'합성 참가자',booth:'합성 부스',
      visitId:'booth-command-123',boothId:'booth-a',participantId:'p-1'}),{status:200}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body});
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length,0);
  }
});

test('reward receipts stay recoverable until matching target and complete lookup are confirmed', async () => {
  const cases = [
    { command:'reward.lookup', payload:{participantId:'p-1',verificationId:'prior-1'},
      valid:{rewardRequestVersion:1,rewardVerificationId:'reward-command-123',participant:{id:'p-1',name:'합성 참가자'},rewards:[{id:'gift-1',name:'합성 경품',status:'READY',method:'ONSITE'}]},
      invalid:[{participant:{id:'p-1',name:'합성 참가자'},rewards:[]},
        {rewardRequestVersion:1,rewardVerificationId:'wrong',participant:{id:'p-1',name:'합성 참가자'},rewards:[]},
        {rewardRequestVersion:1,rewardVerificationId:'reward-command-123',participant:{id:'p-2',name:'다른 참가자'},rewards:[]},
        {rewardRequestVersion:1,rewardVerificationId:'reward-command-123',participant:{id:'p-1',name:'합성 참가자'},rewards:[{name:'합성 경품'}]}] },
    { command:'reward.collect', payload:{id:'gift-1',verificationId:'prior-1',expectedParticipantId:'p-1'},
      valid:{rewardRequestVersion:1,reward:{id:'gift-1',participantId:'p-1',status:'RECEIVED'}},
      invalid:[{reward:{id:'gift-1',participantId:'p-1',status:'RECEIVED'}},
        {rewardRequestVersion:1,reward:{id:'gift-1',participantId:'p-2',status:'RECEIVED'}},
        {rewardRequestVersion:1,reward:{id:'gift-2',participantId:'p-1',status:'RECEIVED'}}] },
  ];
  for(const item of cases) for(const invalid of item.invalid) {
    const world=loadWorld(); world.setFetchImpl(async()=>meResponse(ORG_A)); await world.operator.ensureOperatorContext();
    const body=JSON.stringify({commandId:'reward-command-123',command:item.command,assignmentId:'desk-a',payload:item.payload});
    world.setFetchImpl(async()=>new Response(JSON.stringify(invalid),{status:200}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body}); await world.flush();
    assert.equal(world.receipts.operatorReceipts().length,1,'unproven response must not clear the pointer');
    world.setFetchImpl(async()=>new Response(JSON.stringify(item.valid),{status:200}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body}); await world.flush();
    assert.equal(world.receipts.operatorReceipts().length,0,'matching response can acknowledge the pointer');
  }
});

test('bulk cancellation remains pending until the roster has refreshed', async () => {
  const world=loadWorld(); world.setFetchImpl(async()=>meResponse(ORG_A)); await world.operator.ensureOperatorContext();
  const body=JSON.stringify({commandId:'bulk-cancel-command-123',command:'participant.bulk-cancel',payload:{ids:['p-1']}});
  for (const result of [
    {participants:[{id:'p-1',status:'CANCELLED'}]},
    {participants:[{id:'p-2',status:'CANCELLED'}]},
    {status:'APPLIED',command:'participant.bulk-cancel'},
  ]) {
    world.setFetchImpl(async()=>new Response(JSON.stringify(result),{status:200}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body}); await world.flush();
    assert.equal(world.receipts.operatorReceipts().length,1,'only the roster can acknowledge the reviewed target after refresh');
  }
  world.setFetchImpl(async()=>new Response(JSON.stringify({status:'APPLIED',command:'participant.bulk-cancel'}),{status:200,headers:{'x-eventouch-organization-id':'org-a','x-eventouch-context-version':'3'}}));
  await world.operator.operatorFetch('/api/events/event-123/command-receipts/bulk-cancel-command-123',{cache:'no-store'});
  assert.equal(world.receipts.operatorReceipts().length,1,'a status-only read never clears the target-free pointer');
  assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('p-1'),false,'participant ids are not stored in the pointer');
  const recovery=fs.readFileSync(path.join(__dirname,'../apps/web/app/ui/OperatorReceiptRecovery.tsx'),'utf8');
  assert.match(recovery,/"participant\.bulk-cancel":\s*"신청 일괄 취소"/);
});

test('generic replay never settles unproven cancellation, ticket effects or reward target', async () => {
  const targets=[{id:'p-1',status:'APPROVED',inside:false,paidPaymentIds:[]}];
  const basics={name:'합성 행사',slug:'synthetic',date:'2027-06-01',start:'09:00',end:'18:00',capacity:50,expectedBasics:{date:'2027-01-01'}};
  const campaign={ids:['p-1'],expectedRecipientVersions:['a'.repeat(64)],title:'합성 안내',body:'안내 문구',channel:'SMS',simulate:true};
  const campaignMessage={id:'target-command-123',recipientIds:['p-1'],title:'합성 안내',body:'안내 문구',channel:'SMS',simulate:true,status:'SIMULATED',scheduled:'',templateId:null};
  const check={id:'campaign-1',participantId:'p-1',outcome:'NOT_ACCEPTED',expectedSubmissionId:'submission-1'};
  const checkMessage={id:'campaign-1',status:'FAILED',deliveries:[{participantId:'p-1',status:'FAILED',genericProviderResult:'NOT_ACCEPTED',manualProviderReview:{outcome:'NOT_ACCEPTED',actorId:'user-1',at:'2026-11-07T00:00:00Z'}}]};
  const pagePublished={intro:'합성 페이지',accent:'#E76D26',showAnnouncements:true,showSchedule:true,showVenue:true,showPrograms:true,
    homeStyle:{backgroundColor:'#B9DEF0',heroTitle:null,heroSubtitle:'',heroLayout:'centered',titleScale:'standard',imageFocus:'center',textAlign:'center',textTone:'light',overlay:'none'},
    homeMenus:{order:[],hidden:[],programs:[]},keyvisual:null};
  const cases=[
    {command:'check.reviewed-exit',payload:{participantId:'p-1',entryId:'entry-1'},
      valid:{exitReview:{participantId:'p-1',entryId:'entry-1',exitId:'target-command-123',action:'OUT'}},
      wrong:{exitReview:{participantId:'p-2',entryId:'entry-1',exitId:'target-command-123',action:'OUT'}}},
    {command:'check.reconcile',payload:{participantId:'p-1',checkId:'entry-1',action:'IN'},
      valid:{reconciliation:{id:'target-command-123',participantId:'p-1',checkId:'entry-1',action:'IN',inside:true,everIn:true}},
      wrong:{reconciliation:{id:'target-command-123',participantId:'p-2',checkId:'entry-1',action:'IN',inside:true,everIn:true}}},
    {command:'event.basics.save',payload:basics,
      valid:{event:{...basics,id:'event-123'},ticketPolicyVersion:1,ticketImpact:{extended:2,review:1}},
      wrong:{event:{...basics,id:'event-123'}}},
    {command:'attendee.page.publish-reviewed',payload:{expectedDraftVersion:2,expectedDestinations:{slug:'event-123',public:false}},
      valid:{draftVersion:2,publishedVersion:2,published:pagePublished,reviewedDestinations:{slug:'event-123',public:false}},
      wrong:{draftVersion:2,publishedVersion:2,published:pagePublished,reviewedDestinations:{slug:'event-123',public:true}}},
    {command:'attendee.page.publish-reviewed',payload:{expectedDraftVersion:2,expectedDestinations:{slug:'event-123',public:false}},
      valid:{draftVersion:2,publishedVersion:2,published:pagePublished,reviewedDestinations:{slug:'event-123',public:false}},
      wrong:{draftVersion:2,publishedVersion:2,published:{...pagePublished,homeMenus:{}},reviewedDestinations:{slug:'event-123',public:false}}},
    {command:'message.create-reviewed',payload:campaign,valid:{messageRequestVersion:1,message:campaignMessage},wrong:{messageRequestVersion:1,message:{...campaignMessage,recipientIds:['p-2']}}},
    {command:'message.record-provider-check',payload:check,valid:{message:checkMessage,providerCheck:check},wrong:{message:checkMessage,providerCheck:{...check,participantId:'p-2'}}},
    {command:'participant.bulk-cancel',payload:{ids:['p-1'],status:'CANCELLED',expectedCancellations:targets,requireRosterRefresh:true},
      valid:{cancellationReview:{status:'CANCELLED',targets},participants:[{id:'p-1',status:'CANCELLED'}]},
      wrong:{cancellationReview:{status:'CANCELLED',targets:[{...targets[0],id:'p-2'}]},participants:[{id:'p-2',status:'CANCELLED'}]}},
    {command:'reward.lookup',payload:{participantId:'p-1',verificationId:'prior-1'},
      valid:{rewardRequestVersion:1,rewardVerificationId:'target-command-123',participant:{id:'p-1',name:'합성 참가자'},rewards:[]},
      wrong:{rewardRequestVersion:1,rewardVerificationId:'target-command-123',participant:{id:'p-2',name:'다른 참가자'},rewards:[]}},
    {command:'reward.collect',payload:{id:'gift-1',verificationId:'prior-1',expectedParticipantId:'p-1'},
      valid:{rewardRequestVersion:1,reward:{id:'gift-1',participantId:'p-1',status:'RECEIVED'}},
      wrong:{rewardRequestVersion:1,reward:{id:'gift-1',participantId:'p-2',status:'RECEIVED'}}},
  ];
  for (const item of cases) {
    const world=loadWorld(); world.setFetchImpl(async()=>meResponse(ORG_A)); await world.operator.ensureOperatorContext();
    const body=JSON.stringify({commandId:'target-command-123',command:item.command,assignmentId:'desk-a',payload:item.payload});
    world.setFetchImpl(async()=>new Response('temporary',{status:500}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body});
    const key=world.operator.listUncertainAttempts()[0].key;
    for (const [status,result] of [[200,item.wrong],[400,{field:'command'}],[403,{code:'FORBIDDEN'}],[409,{code:'RECEIPT_MISMATCH'}]]) {
      world.setFetchImpl(async()=>new Response(JSON.stringify(result),{status}));
      await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body}); await world.flush();
      assert.equal(world.operator.listUncertainAttempts().length,1,`${item.command} ordinary retry ${status} remains unresolved`);
      assert.equal(world.receipts.operatorReceipts().length,1);
    }
    for (const [status,result] of [[200,{}],[200,item.wrong],[400,{field:'command'}],[403,{code:'FORBIDDEN'}],[409,{code:'RECEIPT_MISMATCH'}]]) {
      world.setFetchImpl(async()=>new Response(JSON.stringify(result),{status}));
      assert.equal((await world.operator.replayUncertainAttempt(key)).settled,false,`${item.command} ${status} remains unresolved`);
      assert.equal(world.operator.listUncertainAttempts().length,1);
      assert.equal(world.receipts.operatorReceipts().length,1);
    }
    world.setFetchImpl(async()=>new Response(JSON.stringify(item.valid),{status:200}));
    assert.equal((await world.operator.replayUncertainAttempt(key)).settled,true,`${item.command} exact target may settle generic replay`);
    assert.equal(world.receipts.operatorReceipts().length,1,'the work surface still owns refresh and pointer');
  }
});

test('page publication guard conflicts settle an ambiguous retry but unrelated rejections do not', async () => {
  for (const conflict of [{code:'PAGE_PUBLICATION_CONTEXT_CHANGED',field:'expectedDestinations'}, {field:'expectedDraftVersion'}]) {
    const world=loadWorld(); world.setFetchImpl(async()=>meResponse(ORG_A)); await world.operator.ensureOperatorContext();
    const body=JSON.stringify({commandId:'page-guard-command',command:'attendee.page.publish-reviewed',payload:{expectedDraftVersion:2,expectedDestinations:{slug:'event-123',public:false}}});
    world.setFetchImpl(async()=>new Response('temporary',{status:500}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body});
    const key=world.operator.listUncertainAttempts()[0].key;
    world.setFetchImpl(async()=>new Response(JSON.stringify({code:'FORBIDDEN'}),{status:403}));
    assert.equal((await world.operator.replayUncertainAttempt(key)).settled,false);
    world.setFetchImpl(async()=>new Response(JSON.stringify(conflict),{status:409}));
    assert.equal((await world.operator.replayUncertainAttempt(key)).settled,true);
    assert.equal(world.operator.listUncertainAttempts().length,0);
    assert.equal(world.receipts.operatorReceipts().length,1,'the screen owns the scoped pointer until it handles the conflict');
  }
});

test('reviewed message creation proves recipient, content, schedule and image without changing legacy receipts', () => {
  const {operator}=loadWorld();
  const payload={ids:['p-1'],expectedRecipientVersions:['b'.repeat(64)],title:'합성',body:'본문',channel:'MMS',simulate:false,imageFileId:'image-1',scheduled:'2027-11-10T00:00:00Z',scheduleMode:'MANUAL',templateId:'template-1'};
  const message={id:'send-id-123',recipientIds:['p-1'],title:'합성',body:'본문',channel:'MMS',simulate:false,image:{fileId:'image-1'},scheduled:payload.scheduled,scheduleMode:'MANUAL',templateId:'template-1',status:'SCHEDULED'};
  const response={messageRequestVersion:1,message};
  const confirm=value=>operator.confirmsReviewedMessageCreate('send-id-123',payload,value);
  assert.equal(confirm(response),true);
  for(const wrong of [
    {message}, {messageRequestVersion:1,message:{...message,recipientIds:['p-2']}},
    {messageRequestVersion:1,message:{...message,body:'다른 본문'}}, {messageRequestVersion:1,message:{...message,title:'다른 제목'}},
    {messageRequestVersion:1,message:{...message,channel:'SMS'}}, {messageRequestVersion:1,message:{...message,image:{fileId:'image-2'}}},
    {messageRequestVersion:1,message:{...message,scheduled:'2027-11-11T00:00:00Z'}},
    {messageRequestVersion:1,message:{...message,templateId:'template-2'}}, {messageRequestVersion:1,message:{...message,simulate:true}},
  ]) assert.equal(confirm(wrong),false);
  assert.equal(operator.confirmsMessageCreate('send-id-123',payload,{message}),true,'old stored receipts retain their compatibility rule');
});

test('reviewed event retries preserve in-memory uncertainty when all browser storage is denied', async () => {
  const world=loadWorld(); world.setFetchImpl(async()=>meResponse(ORG_A)); await world.operator.ensureOperatorContext();
  world.denyReceiptStorage();
  const payload={name:'합성 행사',slug:'synthetic',date:'2027-06-01',start:'09:00',end:'18:00',capacity:50,expectedBasics:{date:'2027-01-01'}};
  const body=JSON.stringify({commandId:'event-basics-storage-denied-123',command:'event.basics.save',payload});
  world.setFetchImpl(async()=>new Response('temporary',{status:500}));
  await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body});
  assert.equal(world.operator.listUncertainAttempts().length,1);
  for (const [status,result] of [[400,{field:'command'}],[403,{code:'FORBIDDEN'}],[409,{code:'RECEIPT_MISMATCH'}],[200,{event:{...payload,id:'event-123'}}]]) {
    world.setFetchImpl(async()=>new Response(JSON.stringify(result),{status}));
    await world.operator.operatorFetch('/api/events/event-123/commands',{method:'POST',body}); await world.flush();
    assert.equal(world.operator.listUncertainAttempts().length,1,`${status} without original proof must remain uncertain`);
  }
  const key=world.operator.listUncertainAttempts()[0].key;
  world.setFetchImpl(async()=>new Response(JSON.stringify({event:{...payload,id:'event-123'},ticketPolicyVersion:1,ticketImpact:{extended:1,review:0}}),{status:200}));
  assert.equal((await world.operator.replayUncertainAttempt(key)).settled,true);
  assert.equal(world.operator.listUncertainAttempts().length,0);
});


test('rate limit and too-early responses retain status pointers until the same request is resolved', async () => {
  for (const status of [425, 429]) {
    const world = loadWorld();
    world.setFetchImpl(async () => meResponse(ORG_A));
    await world.operator.ensureOperatorContext();
    const body = JSON.stringify({ commandId: `limit-client-${status}`, name: '합성 고객사' });
    world.setFetchImpl(async () => new Response('{"error":"retry"}', { status }));
    await world.operator.operatorFetch('/api/clients', { method: 'POST', body });
    assert.equal(world.receipts.operatorReceipts().length, 1);
    world.setFetchImpl(async () => new Response('{"client":{"id":"client-1","name":"합성 고객사"}}', { status: 201 }));
    await world.operator.operatorFetch('/api/clients', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0);
  }
});

test('content receipts require the saved values and reject unrelated success bodies', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const scenarios = [
    { command: 'notice.save', payload: { title: '합성 공지', body: '내용', published: true, pinned: false }, valid: { notice: { id: 'n1', title: '합성 공지', body: '내용', published: true, pinned: false } }, invalid: { notice: { id: 'n1', title: '다른 공지' } } },
    { command: 'program.save', payload: { id: 'p1', title: '합성 일정', date: '2027-01-01', start: '09:00', end: '10:00', place: '', description: '', published: false }, valid: { program: { id: 'p1', title: '합성 일정', date: '2027-01-01', start: '09:00', end: '10:00', place: '', description: '', published: false } }, invalid: { program: { id: 'p2' } } },
    { command: 'venue.save', payload: { name: '장소', address: '', directions: '', contact: '', description: '', map: null }, valid: { venue: { name: '장소', address: '', directions: '', contact: '', description: '' } }, invalid: { venue: { name: '장소' } } },
    { command: 'notice.delete', payload: { id: 'n1' }, valid: { ok: true }, invalid: { ok: false } },
    { command: 'display.set', payload: { type: 'notice', noticeId: 'n1' }, valid: { display: { type: 'notice', noticeId: 'n1' } }, invalid: { display: { type: 'notice', noticeId: 'n2' } } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `content-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} retains an unverified response`);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts matching saved values`);
  }
});

test('report receipts match the exact version and saved fields', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const fields = { title: '합성 보고서', subtitle: '', coverNote: '', summary: '요약', color: '#E76D26', sections: ['overview'] };
  const scenarios = [
    { command: 'report.create', payload: fields, valid: { report: { ...fields, id: 'report-receipt-0', status: 'DRAFT', snapshot: {} } }, invalid: { report: { id: 'other', status: 'DRAFT' } } },
    { command: 'report.update', payload: { ...fields, id: 'existing' }, valid: { report: { ...fields, id: 'existing', status: 'DRAFT' } }, invalid: { report: { ...fields, id: 'other', status: 'DRAFT' } } },
    { command: 'report.publish', payload: { id: 'existing' }, valid: { report: { id: 'existing', status: 'PUBLISHED' } }, invalid: { report: { id: 'existing', status: 'DRAFT' } } },
    { command: 'report.successor', payload: { id: 'existing', source: 'current' }, valid: { report: { id: 'report-receipt-3', parentId: 'existing', status: 'DRAFT', snapshot: {} } }, invalid: { report: { id: 'report-receipt-3', parentId: 'other', status: 'DRAFT', snapshot: {} } } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `report-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} retains an unverified response`);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts the matching result`);
  }
});

test('question and grading receipts require the original target and decision', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const scenarios = [
    { command: 'module.save', payload: { title: '합성 투표', type: 'poll', options: ['첫째', '둘째'] }, valid: { module: { id: 'm1', title: '합성 투표', type: 'poll', options: ['첫째', '둘째'] } }, invalid: { module: { id: 'm1', title: '합성 투표', type: 'poll', options: ['첫째'] } } },
    { command: 'question.manage', payload: { id: 'q1', answer: '답변', approved: true, expectedText: '질문' }, valid: { question: { id: 'q1', answer: '답변', approved: true, text: '질문' } }, invalid: { question: { id: 'q2', answer: '답변', approved: true, text: '질문' } } },
    { command: 'question.edit.approve', payload: { id: 'q1', expectedNewText: '수정안' }, valid: { question: { id: 'q1', approved: true, text: '수정안' } }, invalid: { question: { id: 'q1', approved: true, text: '기존' } } },
    { command: 'question.edit.reject', payload: { id: 'q1', expectedText: '기존', expectedAnswer: '답변', expectedEditId: 'edit1', expectedNewText: '수정안', reason: '사유' }, valid: { question: { id: 'q1', approved: true, text: '기존', answer: '답변', editRejection: { id: 'edit1', text: '수정안', reason: '사유' } } }, invalid: { question: { id: 'q1', approved: true, text: '기존' } } },
    { command: 'response.grade', payload: { responseId: 'r1', expectedGradeVersion: 1 }, valid: { responseId: 'r1', gradeVersion: 2 }, invalid: { responseId: 'r1', gradeVersion: 1 } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `qa-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} retains an unverified response`);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts the matching result`);
  }
});

test('evidence photo receipts match the exact image, section and target', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const scenarios = [
    { command: 'evidence.photo.add', payload: { section: 'SPACE', image: { fileId: 'file-1' } }, valid: { photo: { id: 'evidence-receipt-0', section: 'SPACE', image: { fileId: 'file-1' } } }, invalid: { photo: { id: 'evidence-receipt-0', section: 'SPACE', image: { fileId: 'other' } } } },
    { command: 'evidence.photo.move', payload: { id: 'photo-1', section: 'STAGE' }, valid: { photo: { id: 'photo-1', section: 'STAGE' } }, invalid: { photo: { id: 'photo-2', section: 'STAGE' } } },
    { command: 'evidence.photo.remove', payload: { id: 'photo-1' }, valid: { ok: true, id: 'photo-1' }, invalid: { ok: true, id: 'photo-2' } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `evidence-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} retains an unverified response`);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts the matching result`);
  }
});

test('message receipts retain incomplete or unrelated acknowledgements without storing content', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const scenarios = [
    { command: 'message.create', payload: { body: '비공개 합성 본문', ids: ['p1'], simulate: true }, invalid: { message: { id: 'message-receipt-0', status: 'SENT' } }, valid: { message: { id: 'message-receipt-0', status: 'SIMULATED' } } },
    { command: 'message.retry', payload: { id: 'campaign-1' }, invalid: { message: { id: 'other', status: 'SENDING' } }, valid: { message: { id: 'campaign-1', status: 'SENDING' } } },
    { command: 'message.cancel', payload: { id: 'campaign-1' }, invalid: { message: { id: 'campaign-1', status: 'SCHEDULED' } }, valid: { message: { id: 'campaign-1', status: 'CANCELLED' } } },
    { command: 'message.sync', payload: { id: 'campaign-1' }, invalid: { message: { status: 'SENDING' } }, valid: { message: { id: 'campaign-1', status: 'SENDING' } } },
    { command: 'message.sync', payload: { id: 'campaign-1' }, invalid: { message: { id: 'other-sending', status: 'SENDING' } }, valid: { message: { id: 'campaign-1', status: 'SENDING' } } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `message-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} retains an unverified response`);
    assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('비공개 합성 본문'), false);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts a matching result`);
  }
});

test('floor operation receipts match the original desk, booth, assignment and map', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const scenarios = [
    { command: 'desk.save', payload: { name: '합성 데스크', action: 'IN', mode: 'desk' }, invalid: { desk: { id: 'd1', name: '다른 데스크', action: 'IN', mode: 'desk' } }, valid: { desk: { id: 'd1', name: '합성 데스크', action: 'IN', mode: 'desk' } } },
    { command: 'desk.save', payload: { id: 'd1', name: '합성 데스크', action: 'IN', mode: 'desk', open: false, expectedDesk: { name: '이전', action: 'IN', mode: 'desk', open: false } }, invalid: { desk: { id: 'd1', name: '합성 데스크', action: 'IN', mode: 'desk', open: true } }, valid: { desk: { id: 'd1', name: '합성 데스크', action: 'IN', mode: 'desk', open: false } } },
    { command: 'desk.save', payload: { id: 'd1', name: '합성 데스크', action: 'OUT', mode: 'desk', open: true, confirmDirectionChange: true, expectedDesk: { name: '이전', action: 'IN', mode: 'desk', open: true } }, invalid: { desk: { id: 'd1', name: '합성 데스크', action: 'OUT', mode: 'desk', open: true } }, valid: { desk: { id: 'd1', name: '합성 데스크', action: 'OUT', mode: 'desk', open: false } } },
    { command: 'desk.save', payload: { id: 'd1', name: '복구 데스크', action: 'IN', mode: 'desk', open: true, confirmDirectionChange: true, expectedDesk: { name: null, action: null, mode: 'desk', open: true } }, invalid: { desk: { id: 'd1', name: '복구 데스크', action: 'IN', mode: 'desk', open: true } }, valid: { desk: { id: 'd1', name: '복구 데스크', action: 'IN', mode: 'desk', open: false } } },
    { command: 'desk.set-open', payload: { id: 'd1', open: false }, invalid: { desk: { id: 'd1', open: true } }, valid: { desk: { id: 'd1', open: false } } },
    { command: 'desk.set-open', payload: { id: 'd1', open: true, expectedOpen: false, expectedDesk: { name: '입장', action: 'IN', mode: 'desk', open: false } }, invalid: { desk: { id: 'd1', open: true } }, valid: { desk: { id: 'd1', name: '입장', action: 'IN', mode: 'desk', open: true } } },
    { command: 'desk.set-open', payload: { id: 'd1', open: true, expectedOpen: false, expectedDesk: { name: '입장', action: 'IN', mode: 'desk', open: false } }, invalid: { desk: { id: 'd1', name: '입장', action: 'OUT', mode: 'desk', open: true } }, valid: { desk: { id: 'd1', name: '입장', action: 'IN', mode: 'desk', open: true } } },
    { command: 'desk.set-open', payload: { id: 'd1', open: false, expectedOpen: true, expectedDesk: { name: null, action: null, mode: 'desk', open: true } }, invalid: { desk: { id: 'd1', mode: 'desk', open: false } }, valid: { desk: { id: 'd1', name: null, action: null, mode: 'desk', open: false } } },
    { command: 'booth.save', payload: { name: '합성 부스', zone: 'A', status: 'WAITING', capacity: 0, limit: 1 }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'B', status: 'WAITING', capacity: 0, limit: 1 } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'WAITING', capacity: 0, limit: 1 } } },
    // The current editor omits both schedule fields; a successful response
    // must still prove that the reviewed values were retained. A different
    // offset denoting the same instant is an equivalent result.
    { command: 'booth.save', payload: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, expectedBooth: { name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' } }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z' } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T09:00:00+09:00', endsAt: '2027-01-01T09:00:00+09:00' } } },
    { command: 'booth.save', payload: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, expectedBooth: { name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' } }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '', endsAt: '2027-01-01T00:00:00.000Z' } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' } } },
    // Explicit schedule changes/clears compare against the submitted values,
    // while the other omitted time is still compared to its original value.
    { command: 'booth.save', payload: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '', expectedBooth: { name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' } }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '', endsAt: '2027-01-01T00:00:00.000Z' } } },
    { command: 'booth.save', payload: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, endsAt: '2028-01-01T00:00:00.000Z', expectedBooth: { name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' } }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2027-01-01T00:00:00.000Z' } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-01-01T00:00:00.000Z', endsAt: '2028-01-01T09:00:00+09:00' } } },
    { command: 'booth.save', payload: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, expectedBooth: { name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '잘못된 시작', endsAt: '잘못된 종료' } }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '', endsAt: '잘못된 종료' } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '잘못된 시작', endsAt: '잘못된 종료' } } },
    { command: 'booth.save', payload: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, expectedBooth: { name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-02-31T09:00:00+09:00', endsAt: '' } }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-03-03T00:00:00Z', endsAt: '' } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '2026-02-31T09:00:00+09:00', endsAt: '' } } },
    // Old stored rows may use null to mean no schedule. The explicit null is
    // valid proof of that preserved value; a truncated response is not.
    { command: 'booth.save', payload: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, expectedBooth: { name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: '', endsAt: '' } }, invalid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: null } }, valid: { booth: { id: 'b1', name: '합성 부스', zone: 'A', status: 'OPEN', capacity: 10, limit: 1, startsAt: null, endsAt: null } } },
    { command: 'staff.assign', payload: { accountId: 's1', type: 'DESK', targetId: 'd1' }, invalid: { assignment: { id: 'a1', accountId: 's1', type: 'DESK', targetId: 'd2' } }, valid: { assignment: { id: 'a1', accountId: 's1', type: 'DESK', targetId: 'd1' } } },
    { command: 'staff.unassign', payload: { id: 'a1' }, invalid: { ok: false }, valid: { ok: true } },
    { command: 'booth.mode', payload: { mode: 'STAFF', acknowledge: true }, invalid: { stampMode: 'SELF' }, valid: { stampMode: 'STAFF' } },
    { command: 'booth.mode-reviewed', payload: { expectedMode: 'STAFF', mode: 'SELF', acknowledge: true }, invalid: { stampMode: 'SELF', previousMode: 'SELF' }, valid: { stampMode: 'SELF', previousMode: 'STAFF' } },
    { command: 'booth.map.save', payload: { expectedDraftVersion: 1, fileId: 'file1', points: [{ boothId: 'b1', x: 0.2, y: 0.5 }] }, invalid: { boothMap: { draft: { version: 2, image: { fileId: 'file1' }, points: [] } } }, valid: { boothMap: { draft: { version: 2, image: { fileId: 'file1' }, points: [{ boothId: 'b1', x: 0.2, y: 0.5 }] } } } },
    { command: 'booth.map.publish', payload: { expectedDraftVersion: 2 }, invalid: { boothMap: { published: { version: 1, image: { fileId: 'file1' }, points: [] } } }, valid: { boothMap: { published: { version: 2, image: { fileId: 'file1' }, points: [] } } } },
    { command: 'booth.map.unpublish', payload: { expectedPublishedVersion: 2 }, invalid: { boothMap: { published: {} } }, valid: { boothMap: { published: null } } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `floor-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} retains an unverified response`);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts a matching response`);
  }
});

test('settings receipts reject unrelated event, feature and stage results', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const basics = { name: '합성 행사', slug: 'synthetic', date: '2027-01-16', start: '09:00', end: '18:00', capacity: 50, clientId: 'client-1', format: 'offline' };
  const scenarios = [
    { command: 'event.update', payload: basics, invalid: { event: { ...basics, id: 'event-123', name: '다른 행사' } }, valid: { event: { ...basics, id: 'event-123' } } },
    { command: 'event.features', payload: { features: ['qa', 'poll'] }, invalid: { features: ['qa'] }, valid: { features: ['qa', 'poll'] } },
    { command: 'event.stage', payload: { stage: 'READY' }, invalid: { event: { id: 'event-123', stage: 'LIVE' } }, valid: { event: { id: 'event-123', stage: 'READY' } } },
    { command: 'form.publish', payload: { consentText: '합성 동의' }, invalid: { publishedVersion: 0 }, valid: { publishedVersion: 2 } },
    { command: 'form.close', payload: {}, invalid: { registrationOpen: true }, valid: { registrationOpen: false } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `settings-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} keeps an unverified response`);
    assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('합성'), false);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts the matching response`);
  }
});

test('form publication proves the reviewed consent and exact resulting version while accepting old receipts', () => {
  const world = loadWorld();
  const confirm = (payload, result) => world.operator.confirmsSettingsCommand('form.publish', 'event-123', payload, result);
  const legacy = { consentText: '기존 요청', expectedFormVersion: 4 };
  assert.equal(confirm(legacy, { publishedVersion: 4 }), true, 'a stored pre-upgrade receipt remains readable');
  assert.equal(confirm(legacy, { publishedVersion: 5 }), false, 'an unrelated legacy response is not proof');
  const payload = { consentText: '새 동의', expectedFormVersion: 4, expectedConsentVersion: 2, expectedConsentText: '이전 동의' };
  const valid = { publishedVersion: 5, reviewedFormVersion: 4, reviewedPublishedVersion: 4,
    reviewedConsentVersion: 2, reviewedConsentText: '이전 동의', consentText: '새 동의', consentVersion: 3, consentChanged: true };
  assert.equal(confirm(payload, valid), true);
  for (const invalid of [
    { publishedVersion: 4 },
    { ...valid, consentText: '다른 동의' },
    { ...valid, reviewedConsentText: '다른 이전 동의' },
    { ...valid, reviewedFormVersion: 3 },
    { ...valid, reviewedConsentVersion: 1 },
    { ...valid, consentVersion: 2 },
    { ...valid, publishedVersion: 6 },
    { ...valid, consentChanged: false },
  ]) assert.equal(confirm(payload, invalid), false, 'a mismatched or incomplete result cannot settle the request');
  const legacyGap = { ...valid, reviewedPublishedVersion: 9, publishedVersion: 10 };
  assert.equal(confirm(payload, legacyGap), true, 'an older draft advances beyond the current publication');
  const unchangedPayload = { ...payload, consentText: '이전 동의' };
  const unchanged = { ...valid, consentText: '이전 동의', consentChanged: false, consentVersion: 2, publishedVersion: 4 };
  assert.equal(confirm(unchangedPayload, unchanged), true);
  assert.equal(confirm(unchangedPayload, { ...unchanged, publishedVersion: 5 }), false);
});

test('participant page receipts require the submitted draft, image and version', async () => {
  const world = loadWorld();
  world.setFetchImpl(async () => meResponse(ORG_A));
  await world.operator.ensureOperatorContext();
  const menus = { order: ['notice', 'lucky', 'roulette', 'vote', 'stamp'], hidden: ['vote'], programs: [] };
  const payload = { expectedDraftVersion: 2, intro: '합성 소개', accent: '#E76D26', showAnnouncements: true,
    showSchedule: true, showVenue: false, showPrograms: true, homeStyle: { heroTitle: '합성 문구', backgroundColor: '#B9DEF0' },
    homeMenus: menus, keyvisual: { fileId: 'image-1' } };
  const draft = { ...payload, keyvisual: { fileId: 'image-1', name: 'banner.png' } };
  const reviewedDraft = { ...draft, homeStyle: { ...draft.homeStyle, heroSubtitle: '', heroLayout: 'centered', titleScale: 'standard', imageFocus: 'center', textAlign: 'center', textTone: 'light', overlay: 'none' } };
  const scenarios = [
    { command: 'attendee.page.save', payload, invalid: { draftVersion: 3, draft: { ...draft, intro: '다른 소개' } }, valid: { draftVersion: 3, draft } },
    { command: 'attendee.page.save', payload, invalid: { draftVersion: 3, draft: { ...draft, keyvisual: { fileId: 'image-2' } } }, valid: { draftVersion: 3, draft } },
    { command: 'attendee.page.save', payload, invalid: { draftVersion: 4, draft }, valid: { draftVersion: 3, draft } },
    { command: 'attendee.page.save', payload, invalid: { draftVersion: 3, draft: { ...draft, homeMenus: { ...menus, hidden: [] } } }, valid: { draftVersion: 3, draft } },
    { command: 'attendee.page.publish', payload: { expectedDraftVersion: 2 }, invalid: { publishedVersion: 1, draftVersion: 2, published: draft }, valid: { publishedVersion: 2, draftVersion: 2, published: draft } },
    { command: 'attendee.page.publish-reviewed', payload: { expectedDraftVersion: 2, expectedDestinations: { slug: 'event-123', public: false } }, invalid: { publishedVersion: 2, draftVersion: 2, published: reviewedDraft, reviewedDestinations: { slug: 'event-123', public: true } }, valid: { publishedVersion: 2, draftVersion: 2, published: reviewedDraft, reviewedDestinations: { slug: 'event-123', public: false } } },
    { command: 'attendee.page.publish-reviewed', payload: { expectedDraftVersion: 2, expectedDestinations: { slug: 'event-123', public: true } }, invalid: { publishedVersion: 2, draftVersion: 2, published: reviewedDraft }, valid: { publishedVersion: 2, draftVersion: 2, published: reviewedDraft, reviewedDestinations: { slug: 'event-123', public: true } } },
    { command: 'attendee.page.publish-reviewed', payload: { expectedDraftVersion: 2, expectedDestinations: { slug: 'event-123', public: true } }, invalid: { publishedVersion: 2, draftVersion: 2, published: { ...reviewedDraft, homeMenus: {} }, reviewedDestinations: { slug: 'event-123', public: true } }, valid: { publishedVersion: 2, draftVersion: 2, published: reviewedDraft, reviewedDestinations: { slug: 'event-123', public: true } } },
    { command: 'attendee.page.publish-reviewed', payload: { expectedDraftVersion: 2, expectedDestinations: { slug: 'event-123', public: true } }, invalid: { publishedVersion: 2, draftVersion: 2, published: { ...reviewedDraft, homeStyle: {} }, reviewedDestinations: { slug: 'event-123', public: true } }, valid: { publishedVersion: 2, draftVersion: 2, published: reviewedDraft, reviewedDestinations: { slug: 'event-123', public: true } } },
  ];
  for (const [index, scenario] of scenarios.entries()) {
    const body = JSON.stringify({ commandId: `page-receipt-${index}`, command: scenario.command, payload: scenario.payload });
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.invalid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    assert.equal(world.receipts.operatorReceipts().length, 1, `${scenario.command} keeps an unrelated response`);
    assert.equal(JSON.stringify(world.receipts.operatorReceipts()).includes('합성'), false);
    world.setFetchImpl(async () => new Response(JSON.stringify(scenario.valid), { status: 200 }));
    await world.operator.operatorFetch('/api/events/event-123/commands', { method: 'POST', body });
    await world.flush();
    if (scenario.command === 'attendee.page.publish' || scenario.command === 'attendee.page.publish-reviewed') {
      assert.equal(world.operator.confirmsAttendeePageCommand(scenario.command, scenario.payload, scenario.valid), true);
      assert.equal(world.receipts.operatorReceipts().length, 1, 'the editor must verify the published content before clearing');
      world.operator.acknowledgeOperatorReceipt(`page-receipt-${index}`);
      world.receipts.forgetOperatorReceipt(`page-receipt-${index}`);
    } else {
      assert.equal(world.receipts.operatorReceipts().length, 0, `${scenario.command} accepts the matching version and fields`);
    }
  }
});
