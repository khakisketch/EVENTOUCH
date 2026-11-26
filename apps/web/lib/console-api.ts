"use client";

import {
  getOperatorContextSnapshot,
  isOrganizationContextBlock,
  operatorFetch,
  subscribeOperatorContext,
  supersededMeError,
} from "./operator-context";

// One browser-tab read coordinator. No persistent cache, no shared SSR state,
// no automatic write retries: receipt and recovery remain with the workspace.
// The only thing held beyond an in-flight read is a single-use "warm read"
// (see below): a read started a moment early by menu intent.
// Transport runs through the operator adapter, so org headers, drift
// blocking and /auth/me seeding apply; the shared-read dedupe, epoch and
// freshness behavior below are preserved exactly.
const pendingReads = new Map<string, Promise<Response>>();
let epoch = 0;
type FreshnessSource = "focus" | "write" | "other-tab";
export type ConsoleFreshness = { source: FreshnessSource };
const subscribers = new Set<(event: ConsoleFreshness) => void>();
let channel: BroadcastChannel | null = null;
let stopListening: (() => void) | null = null;

// Org drift drops shared reads without notifying freshness: in-flight
// pre-switch responses must not repopulate forms, and no reload is asked
// for (screens keep their cached/page state until explicit recovery).
// Invalidating only bumps the epoch and clears the map, so this subscription
// cannot loop: no fetch, no notify. Invalidation fires ONLY on real
// context identity/version/role or drift-flag transitions (primitive key,
// not object identity): busy/loading/uncertain counts and same-context
// observations must never drop a valid in-flight read, or a /auth/me read
// would see its own epoch bump and refetch itself in a loop.
let orgSubscribed = false;
let lastOrgKey: string | null = null;
function ensureOrgSubscribed(): void {
  if (orgSubscribed) return;
  orgSubscribed = true;
  lastOrgKey = orgKeyOf(getOperatorContextSnapshot());
  subscribeOperatorContext(() => {
    const key = orgKeyOf(getOperatorContextSnapshot());
    if (key === lastOrgKey) return;
    lastOrgKey = key;
    invalidateConsoleReads();
  });
}

function orgKeyOf(snapshot: {
  context: { organizationId: string; contextVersion: number; role: string } | null;
  changed: boolean;
}): string {
  const context = snapshot.context;
  return `${context?.organizationId ?? ""}|${context?.contextVersion ?? ""}|${context?.role ?? ""}|${snapshot.changed ? 1 : 0}`;
}

// Warm reads (2026-11-23). Moving between screens used to wait for the route
// payload and only then start the screen's data read, two round trips in a
// row. Pointing at (or touching) a menu link now starts that read a moment
// early and parks it here. It is NOT a cache: the first reader within the
// window takes it (it is removed on use), it only exists for a few seconds,
// and every invalidation below (a write, a freshness signal, an org change)
// drops it, exactly like an in-flight read.
const WARM_WINDOW_MS = 5000;
const warmReads = new Map<string, { request: Promise<Response>; epoch: number; at: number }>();

export function invalidateConsoleReads(): void {
  epoch += 1;
  pendingReads.clear();
  warmReads.clear();
}

function takeWarmRead(input: string): Promise<Response> | null {
  const entry = warmReads.get(input);
  if (!entry) return null;
  warmReads.delete(input);
  if (entry.epoch !== epoch || Date.now() - entry.at > WARM_WINDOW_MS) return null;
  return entry.request;
}

/** Start a shared read early. Only event bootstrap reads qualify; anything else is ignored. */
export function warmConsoleRead(input: string): void {
  if (typeof window === "undefined" || !/^\/api\/events\/[^/]+\/bootstrap(?:\?messageRecipientReview=1)?$/.test(input)) return;
  ensureOrgSubscribed();
  const current = warmReads.get(input);
  if (current && current.epoch === epoch && Date.now() - current.at <= WARM_WINDOW_MS) return;
  if (pendingReads.has(input)) return;
  const entry = { request: consoleFetch(input), epoch, at: Date.now() };
  warmReads.set(input, entry);
  // A failed or unreadable warm read is dropped so the screen reads for itself.
  entry.request.then(
    (response) => { if (!response.ok && warmReads.get(input) === entry) warmReads.delete(input); },
    () => { if (warmReads.get(input) === entry) warmReads.delete(input); },
  );
}

function honorSignal<T>(promise: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return promise;
  const aborted = () => signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  if (signal.aborted) {
    // The read still settles later; swallow its outcome so an abandoned
    // reader cannot raise an unhandled rejection.
    promise.catch(() => {});
    return Promise.reject(aborted());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function notify(source: FreshnessSource): void {
  invalidateConsoleReads();
  for (const listener of subscribers) listener({ source });
}

export function subscribeConsoleFreshness(listener: (event: ConsoleFreshness) => void): () => void {
  subscribers.add(listener);
  if (!stopListening && typeof window !== "undefined") {
    let lastWake = Date.now();
    const wake = () => {
      if (document.visibilityState === "hidden" || Date.now() - lastWake < 15000) return;
      lastWake = Date.now();
      notify("focus");
    };
    window.addEventListener("focus", wake);
    document.addEventListener("visibilitychange", wake);
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel("eventouch-console-freshness");
      channel.onmessage = () => notify("other-tab");
    }
    stopListening = () => {
      window.removeEventListener("focus", wake);
      document.removeEventListener("visibilitychange", wake);
      channel?.close();
      channel = null;
      stopListening = null;
    };
  }
  return () => {
    subscribers.delete(listener);
    if (!subscribers.size) stopListening?.();
  };
}

function isSharedRead(input: string): boolean {
  return input === "/api/bootstrap" || input === "/api/auth/me" ||
    input === "/api/console/directory" || /^\/api\/events\/[^/]+\/bootstrap(?:\?messageRecipientReview=1)?$/.test(input);
}

// The shared /auth/me delivers selected authority ONLY when the parsed
// body matches the unchanged pinned view (user, org, version, role). A
// body proving a different authority — stale or drifted — is quietly
// rejected instead of being parsed as the current role by Team/Settings
// and the other shared-me consumers. Seeding (no pinned view yet),
// unreadable bodies, and non-2xx answers pass through untouched: raw
// non-2xx stays available for explicit recovery, and only the adapter
// observer judges state. Never auto-retried here: a genuinely drifted
// answer would mismatch forever, so the caller re-reads on demand.
async function checkSharedMeAuthority(response: Response): Promise<Response> {
  if (!response.ok) return response;
  const pinnedView = getOperatorContextSnapshot().context;
  if (!pinnedView) return response;
  let user: unknown = null;
  try {
    const data: unknown = await response.clone().json();
    user =
      typeof data === "object" && data !== null && !Array.isArray(data)
        ? (data as Record<string, unknown>).user ?? null
        : null;
  } catch {
    return response;
  }
  if (typeof user !== "object" || user === null || Array.isArray(user)) return response;
  const record = user as Record<string, unknown>;
  const same =
    record.id === pinnedView.userId &&
    record.organizationId === pinnedView.organizationId &&
    record.contextVersion === pinnedView.contextVersion &&
    record.role === pinnedView.role;
  if (same) return response;
  throw supersededMeError();
}

// A 401 from a console read or write means the sign-in ended while the screen
// was open. Each screen already shows its own recovery text, but nothing moved
// the operator back to the login screen, so every retry failed the same way.
// One shell-level signal does that with the current address kept as the return
// path. The login and session endpoints are excluded: their 401 is an answer
// the caller handles, not an ended session.
export const SESSION_EXPIRED_EVENT = "eventouch:session-expired";

function reportEndedSession(input: string, response: Response): Response {
  if (response.status !== 401 || typeof window === "undefined") return response;
  if (/^\/api\/auth\/(login|logout|me|setup|organizations)/.test(input)) return response;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
  return response;
}

export async function consoleFetch(input: string, init?: RequestInit): Promise<Response> {
  return reportEndedSession(input, await consoleFetchResponse(input, init));
}

async function consoleFetchResponse(input: string, init?: RequestInit): Promise<Response> {
  ensureOrgSubscribed();
  const method = (init?.method ?? "GET").toUpperCase();
  if (typeof window === "undefined") return fetch(input, init);
  if (method !== "GET" && method !== "HEAD") {
    invalidateConsoleReads();
    let transmitted = true;
    try {
      return await operatorFetch(input, init);
    } catch (error) {
      // A locally blocked write (org drift, frozen receipt rebind) never
      // reached the server: no freshness signal for a non-transmission.
      if (isOrganizationContextBlock(error)) transmitted = false;
      throw error;
    } finally {
      if (transmitted) {
        // Also invalidate uncertain responses: the server may already have
        // committed. A freshness signal never repeats the command itself.
        notify("write");
        channel?.postMessage({ changed: true });
      }
    }
  }
  const warm = takeWarmRead(input);
  if (warm) return honorSignal(warm.then((response) => response.clone()), init?.signal);
  if (!isSharedRead(input) || init?.signal) return operatorFetch(input, init);
  let request = pendingReads.get(input);
  if (!request) {
    const version = epoch;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    request = operatorFetch(input, { ...init, cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        // An older read cannot repopulate a screen after a committed write
        // or an org switch (the adapter rejects post-drift reads, so the
        // retry below surfaces the drift error instead of stale data).
        if (version !== epoch) return consoleFetch(input, init);
        if (input === "/api/auth/me") return checkSharedMeAuthority(response);
        return response;
      })
      .finally(() => {
        window.clearTimeout(timeout);
        if (pendingReads.get(input) === request) pendingReads.delete(input);
      });
    pendingReads.set(input, request);
  }
  return (await request).clone();
}
