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

export function invalidateConsoleReads(): void {
  epoch += 1;
  pendingReads.clear();
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
    input === "/api/console/directory" || /^\/api\/events\/[^/]+\/bootstrap$/.test(input);
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

export async function consoleFetch(input: string, init?: RequestInit): Promise<Response> {
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
