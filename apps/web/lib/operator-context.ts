"use client";

// Operator organization context: multi-org membership transport for the
// console (and staff) operator surfaces.
//
// Server contract (main owns the routes; this module never invents one):
//   GET  /api/auth/me                  -> { user: { id, name, role,
//                                            organizationId, organizationName,
//                                            contextVersion, ... } }
//   GET  /api/auth/organizations        -> { organizations: [{ id, name, role }],
//                                           activeOrganizationId, contextVersion }
//   POST /api/auth/organizations/select { organizationId, commandId,
//                                          expectedContextVersion }
//                                        -> { user, activeOrganizationId,
//                                             contextVersion } (same
//                                           commandId+body replays)
// Private org writes require the request headers
// x-eventouch-organization-id and x-eventouch-context-version. A request that
// arrives with a missing or mismatched context answers 409 with code
// ORGANIZATION_CONTEXT_CHANGED. Auth login/logout/setup/invitations/org
// select carry their own server validation, and public attendee/signup
// traffic (ticket bearer, /api/public/*, */signup) is never context guarded.
//
// Role is always the CURRENT org effective role: every pinned value below is
// scoped to (organizationId, contextVersion), never global.
//
// Pinning policy (the whole point of this module):
//   - The first successfully observed view context is PINNED. A newer,
//     different context sets changed=true and is stored as observed, but the
//     pinned context is never silently replaced: rendered forms keep reading
//     the pinned view until explicit UI recovery.
//   - Only acceptOperatorContext (called after an explicit, successful
//     SAME-org recovery, or the initial null seed) renews the pinned view
//     in place and clears view flags. Uncertain receipt mappings survive
//     on purpose (see the rebind policy below). A different org is NEVER
//     installed here: observeSelectedOrganization records it as observed +
//     changed and the caller navigates natively, so the fresh document
//     seeds the new org on its own.
//   - Stale /auth/me responses (slower race losers) never overwrite newer
//     observed state: every me request carries a local sequence number and
//     losers are dropped.
//
// Write policy:
//   - The request context (org headers) is frozen from the pinned snapshot
//     at call time. Payloads are never mutated: the idempotency key stays in
//     the body (commandId) or, for file uploads, in the query string.
//   - Every transmitted guarded write freezes its FULL attempt (method, url,
//     body, headers including the org/version stamp) bound to the original
//     org. The frozen copy — never a rebuilt request — is what an explicit
//     on-demand "미확인 요청 확인" replays, byte for byte.
//   - Ambiguous outcomes (network loss, 5xx, 408, unreadable success bodies)
//     keep an uncertain receipt mapping keyed by commandId (or a local key
//     when the call carries no id). The adapter never auto-replays: only an
//     explicit per-receipt check does. Any RECEIVED non-context 409 is an
//     AUTHORITATIVE outcome — the server checks the command receipt before
//     business validation, so the same payload cannot still be an ambiguous
//     network outcome: the mapping is cleared and never replayed
//     automatically. Theme version conflicts and the invite
//     link-unavailable receipts behave the same. Only the context code
//     preserves the mapping (see below).
//   - Once contextChanged, every private write is blocked BEFORE transmitting
//     (nothing reaches the server) until explicit recovery. A retry that
//     names a commandId whose frozen receipt context no longer matches the
//     pinned context is blocked too — except after an explicit same-org
//     accept, which renews the version (see below).
//   - A 409 whose body carries code ORGANIZATION_CONTEXT_CHANGED marks the
//     context changed, drops shared reads, revalidates, and still returns
//     the original 409 body/status untouched (generic 401/500s are never
//     masked: only the explicit code marks drift).
//   - A 403/409 carrying NO_ORGANIZATION_MEMBERSHIP (identity body) only
//     kicks a revalidation and returns the response untouched: the pinned
//     view is never cleared here and there is no login redirect —
//     authoritative /auth/me decides (observed null + drift + selection
//     banner when it confirms no org). The rejection itself proves nothing
//     was committed, so no uncertain mapping is kept.
//   - Receipt renewal happens ONLY inside acceptOperatorContext (and the
//     same-org version renewal below) and ONLY for entries of the accepted
//     org: their contextVersion AND their frozen header refresh to the new
//     one (method, url, body stay fixed; never the body's expectedVersion,
//     org, or id fields). Passive observations, wakes, and cross-tab signals
//     never rebind.
//
// Read policy:
//   - Guarded private reads (everything under /api/ except the auth
//     organization endpoints, /api/health, and guest/public traffic) are
//     rejected locally once contextChanged, so a query read that landed in
//     org B can never repopulate org A forms after drift. Cached/page state
//     is preserved: rejection is an error the screens already render, not a
//     silent swap.
//   - Guarded private GET responses carry proof-of-transaction headers
//     (x-eventouch-organization-id + x-eventouch-context-version). Before
//     delivering, the read checks frozen request context, current pinned
//     context, and the snapshot generation (a read launched before a local
//     context change never delivers after). Mismatched responses are
//     discarded, drift is marked, and /auth/me revalidates; a missing
//     header on a 2xx fails closed the same way while the server
//     implementation lands. Error responses pass through untouched.
//     Unpinned first-view reads deliver unverified (pinning follows via me).
//   - Focus/tab wake and the cross-tab org-switch signal revalidate through
//     GET /api/auth/me (bounded, sequence-guarded). Validation updates
//     observed/changed only; rendered forms never switch silently.
//   - Authenticated-but-unselected me (org null, multi-membership — or a
//     403 carrying exactly NO_ORGANIZATION_MEMBERSHIP with a verified
//     user.id identity): never a logout — ensure rejects with
//     ORGANIZATION_NOT_SELECTED for the explicit selector, and reads stay
//     unverified until one pins. Any other 403 is just its own failure;
//     network loss never reads as session loss.
//
// Snapshots are stable object identities rebuilt only on mutation, so a
// later useSyncExternalStore subscriber never spins.

export type OperatorContext = {
  organizationId: string;
  organizationName: string;
  contextVersion: number;
  role: string;
  userId: string;
  userName: string;
};

export type OperatorContextSnapshot = {
  context: OperatorContext | null;
  observed: OperatorContext | null;
  changed: boolean;
  loading: boolean;
  error: string | null;
  inFlightWrites: number;
  uncertainWrites: number;
};

export const ORGANIZATION_CONTEXT_CHANGED = "ORGANIZATION_CONTEXT_CHANGED";
// Authenticated but without a selected org (multi-membership, nothing
// chosen): seedable, never a logout. Parent shows the explicit selector.
export const ORGANIZATION_NOT_SELECTED = "ORGANIZATION_NOT_SELECTED";
// A successful /auth/me that a newer validation already retired: never
// delivered as authority. Quiet by design — the newer operation owns the
// answer, so this only asks the caller to re-read, never to recover.
export const ME_SUPERSEDED = "ME_SUPERSEDED";

export function isSupersededMe(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).code === ME_SUPERSEDED
  );
}

export function supersededMeError(): Error {
  return Object.assign(new Error("최신 조직 정보를 확인하는 중입니다. 잠시 후 다시 시도하세요."), {
    code: ME_SUPERSEDED,
  });
}

const CONTEXT_VERSION_HEADER = "x-eventouch-context-version";
const ORGANIZATION_ID_HEADER = "x-eventouch-organization-id";
const ORGANIZATION_CHANNEL = "eventouch-operator-context";
const VALIDATE_TIMEOUT_MS = 10000;
const WAKE_VALIDATE_MIN_INTERVAL_MS = 10000;
const UNCERTAIN_ENTRY_CAP = 50;

type FrozenAttempt = {
  method: string;
  url: string;
  path: string;
  command: string | null;
  body: BodyInit | null | undefined;
  headers: Record<string, string>;
};

type UncertainEntry = {
  organizationId: string;
  organizationName: string;
  contextVersion: number;
  at: number;
  command: string | null;
  path: string;
  attempt: FrozenAttempt;
  // Generation that last (re)granted this entry: the initial freeze or the
  // latest explicit same-org renewal. Any drift/observation after that point
  // bumps contextGen and revokes the replay grant until the next explicit
  // renewal — a stale observed snapshot can never veto a renewed entry.
  renewedGen: number;
};

function describeAttemptBody(body: BodyInit | null | undefined): string | null {
  if (typeof body !== "string") return null;
  try {
    const record = asRecord(JSON.parse(body));
    const direct = record && typeof record.command === "string" ? record.command : null;
    if (direct) return direct;
    const nested = asRecord(record?.payload);
    if (nested && typeof nested.command === "string") return nested.command;
    return null;
  } catch {
    return null;
  }
}

function freezeAttempt(
  url: string,
  init: RequestInit | undefined,
  headers: Headers,
  organizationId: string,
  organizationName: string,
  contextVersion: number
): FrozenAttempt {
  const frozen: Record<string, string> = {};
  try {
    headers.forEach((value, key) => {
      frozen[key] = value;
    });
  } catch {
    // Best-effort snapshot only; the entry still records the mapping.
  }
  let path = url;
  try {
    path = new URL(url, "http://operator-context.local").pathname;
  } catch {
    // Keep the raw url when it cannot be parsed.
  }
  return {
    method: (init?.method ?? "GET").toUpperCase(),
    url,
    path,
    command: describeAttemptBody(init?.body as BodyInit | null | undefined),
    body: (init?.body ?? null) as BodyInit | null | undefined,
    headers: frozen,
  };
}

function contextError(message: string): Error {
  return Object.assign(new Error(message), {
    code: ORGANIZATION_CONTEXT_CHANGED,
    status: 409,
  });
}

export function isOrganizationContextBlock(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).code === ORGANIZATION_CONTEXT_CHANGED
  );
}

export function isOrganizationSelectionRequired(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as Record<string, unknown>).code === ORGANIZATION_NOT_SELECTED
  );
}

function selectionError(): Error {
  return Object.assign(new Error("조직을 선택하세요"), {
    code: ORGANIZATION_NOT_SELECTED,
    status: 409,
  });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function toVersion(value: unknown): number | null {
  const num = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
  return Number.isFinite(num) ? num : null;
}

// ONLY the explicit organization-switch success path may install this.
// Returns null for anything that is not a usable pinned view.
function contextFromUser(user: unknown): OperatorContext | null {
  const record = asRecord(user);
  if (!record) return null;
  const organizationId = text(record.organizationId);
  const contextVersion = toVersion(record.contextVersion);
  if (!organizationId || contextVersion === null) return null;
  return {
    organizationId,
    organizationName: text(record.organizationName),
    contextVersion,
    role: text(record.role),
    userId: text(record.id),
    userName: text(record.name),
  };
}

function sameContext(left: OperatorContext, right: OperatorContext): boolean {
  return (
    left.organizationId === right.organizationId &&
    left.contextVersion === right.contextVersion &&
    left.role === right.role
  );
}

function pathOf(input: string): string | null {
  try {
    return new URL(input, "http://operator-context.local").pathname;
  } catch {
    return null;
  }
}

function hasAuthorizationHeader(init?: RequestInit): boolean {
  const headers = init?.headers;
  if (!headers) return false;
  try {
    const merged = new Headers(headers as HeadersInit);
    return merged.has("authorization");
  } catch {
    return false;
  }
}

// Endpoints with their own server validation (or no operator session at
// all): never context-guarded, never header-stamped, never blocked.
// Invitations are split deliberately: creating and revoking are private
// organization administration (guarded like any other write); ONLY the
// public token metadata read and the token accept (self verification,
// possibly signed-in already) stay exempt.
// Account recovery is global identity traffic on the holder's own account
// (email verification + anonymous recovery): never org-guarded, never
// header-stamped, never blocked on drift — same as the invitation accept.
function isContextExempt(path: string, method: string): boolean {
  if (path === "/api/auth/login") return true;
  if (path === "/api/auth/logout") return true;
  if (path === "/api/auth/setup-state") return true;
  if (path === "/api/auth/setup") return true;
  if (path === "/api/auth/organizations/select") return true;
  if (/^\/api\/auth\/(email|recovery)\//.test(path)) return true;
  if (method === "GET" && /^\/api\/auth\/invitations\/[^/]+$/.test(path)) return true;
  if (method === "POST" && /^\/api\/auth\/invitations\/[^/]+\/accept$/.test(path)) return true;
  if (path.startsWith("/api/public/")) return true;
  if (/^\/api\/events\/[^/]+\/signup$/.test(path)) return true;
  return false;
}

// Reads that must keep working after drift: validation, recovery, the
// public help page, and the health probe. Everything else under /api/ is
// guarded. /api/auth/help is global public by explicit contract: always
// allowed, never proof-checked. The own-account email status read rides the
// same global-identity shape (it is also context-exempt above).
function isAlwaysAllowedRead(path: string): boolean {
  if (path === "/api/auth/me") return true;
  if (path === "/api/auth/email/status") return true;
  if (path === "/api/auth/organizations") return true;
  if (path === "/api/auth/organizations/select") return true;
  if (path === "/api/auth/help") return true;
  if (path === "/api/health") return true;
  if (path.startsWith("/api/public/")) return true;
  if (/^\/api\/events\/[^/]+\/signup$/.test(path)) return true;
  return false;
}

function extractCommandId(url: string, body: BodyInit | null | undefined): string | null {
  try {
    const queryId = new URL(url, "http://operator-context.local").searchParams.get("commandId");
    if (queryId) return queryId;
  } catch {
    // Fall through to the body probe.
  }
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      const record = asRecord(parsed);
      if (record && typeof record.commandId === "string" && record.commandId) return record.commandId;
      const payload = asRecord(record?.payload);
      if (payload && typeof payload.commandId === "string" && payload.commandId) {
        return payload.commandId;
      }
    } catch {
      // Not JSON: no id to map, the call still freezes headers + counts.
    }
  }
  return null;
}

// --- module state (one tab, no persistence: reloads re-pin from /auth/me) ---

let pinned: OperatorContext | null = null;
let observed: OperatorContext | null = null;
let changed = false;
let loading = false;
let lastError: string | null = null;
let inFlightWrites = 0;
const uncertain = new Map<string, UncertainEntry>();
let meSeq = 0;
let lastCompletedMeSeq = 0;
let lastValidateAt = 0;
let validateInFlight: Promise<OperatorContext | null> | null = null;
let ensureInFlight: Promise<OperatorContext> | null = null;
// lastCompletedMeSeq is the highest me sequence number COMPLETED (response
// processed); a response is fresh only if its seq beats both counters: no
// newer request was initiated after it AND no newer response completed.
// lastMeUnselected is true when the latest processed me was authenticated
// but without a selected org, so ensure/refresh report "select an org"
// instead of misreading the empty view as logged-out or as a failure.
let lastMeUnselected = false;
// Bumped only when the pinned/observed view or drift flag moves — never for
// busy counts or errors. In-flight guarded reads freeze this generation at
// request time; a read that resolves after it moved is discarded, so a query
// launched under A can never populate forms after the view changed.
let contextGen = 0;
let mismatchValidateAt = 0;
const MISMATCH_VALIDATE_MIN_INTERVAL_MS = 10000;
let snapshotCache: OperatorContextSnapshot | null = null;
let wakeWired = false;
let channel: BroadcastChannel | null = null;
const TAB_ID = `tab-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
const listeners = new Set<() => void>();

function rebuildSnapshot(): void {
  snapshotCache = {
    context: pinned,
    observed,
    changed,
    loading,
    error: lastError,
    inFlightWrites,
    // Only the pinned org's receipts count here: a global count would let
    // another org's pending receipts haunt (or block returning from) this
    // view. Other orgs' frozen entries still exist and still block their
    // own retries; they surface again when their org is pinned.
    uncertainWrites: pinnedUncertainCount(),
  };
}

function pinnedUncertainCount(): number {
  if (!pinned) return uncertain.size;
  let count = 0;
  for (const entry of uncertain.values()) {
    if (entry.organizationId === pinned.organizationId) count += 1;
  }
  return count;
}

function emit(): void {
  rebuildSnapshot();
  listeners.forEach((listener) => {
    try {
      listener();
    } catch {
      // A failing subscriber must never break sibling screens or the write
      // that triggered the notification.
    }
  });
}

export function subscribeOperatorContext(listener: () => void): () => void {
  ensureWakeWired();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getOperatorContextSnapshot(): OperatorContextSnapshot {
  if (!snapshotCache) rebuildSnapshot();
  return snapshotCache as OperatorContextSnapshot;
}

export function broadcastOrganizationChange(): void {
  try {
    if (typeof BroadcastChannel === "undefined") return;
    if (!channel) channel = new BroadcastChannel(ORGANIZATION_CHANNEL);
    channel.postMessage({ type: "org-changed", from: TAB_ID, at: Date.now() });
  } catch {
    // Cross-tab signalling is best-effort; the local state already changed.
  }
}

function noteObserved(candidate: OperatorContext | null): void {
  // Passive observations never install: a newer, different context marks
  // drift and waits as observed; the pinned view only moves on explicit
  // accept. (First-view pinning happens in the seed paths, not here.)
  if (!candidate || !pinned || sameContext(pinned, candidate)) return;
  if (observed && sameContext(observed, candidate)) return;
  observed = candidate;
  if (!changed) {
    changed = true;
  }
  contextGen += 1;
  emit();
}

async function fetchMe(signal?: AbortSignal): Promise<Response> {
  const transport =
    typeof fetch === "function"
      ? fetch
      : Promise.reject(new Error("fetch is not available"));
  return (await transport)("/api/auth/me", {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
}

// Every me request takes its sequence number at INITIATION time, so a slow
// race loser can never overwrite newer observed state when it lands later.
async function fetchMeTracked(signal?: AbortSignal): Promise<{ response: Response; seq: number }> {
  const seq = ++meSeq;
  const response = await fetchMe(signal);
  return { response, seq };
}

async function observeMeOnce(response: Response | null, seq: number): Promise<boolean> {
  if (!response || response.status === 204) return false;
  // A 403 is only ever evidence when it carries the exact unselected
  // contract (code + verified identity object). Anything else stays
  // untouched here: the caller decides how to surface it. Raw non-2xx
  // answers are never fenced as superseded: exact 403 identity bodies and
  // 503s must stay available to explicit recovery untouched.
  if (!response.ok && !(response.status === 403 && (await peekUnselectedMe(response)))) return false;
  try {
    const data: unknown = await response.clone().json();
    // A response is fresh only if no newer me request was initiated after
    // it AND no newer response completed first. Both counters only grow.
    // Stale losers report superseded so raw consumers never act on them.
    if (seq < meSeq || seq <= lastCompletedMeSeq) return true;
    lastCompletedMeSeq = seq;
    const user = asRecord(data)?.user;
    const candidate = contextFromUser(user);
    if (!candidate) {
      lastMeUnselected = true;
      // Authenticated but nothing selected: never a logout, never a silent
      // install. Without a pinned view the UI offers the explicit selector;
      // with one, the server-side loss of context reads as drift — and the
      // banner needs the selection message, not a generic error.
      if (pinned) {
        observed = null;
        lastError = SELECTION_MESSAGE;
        markContextChanged();
      } else if (lastError !== SELECTION_MESSAGE) {
        lastError = SELECTION_MESSAGE;
        emit();
      }
      return false;
    }
    if (lastError === SELECTION_MESSAGE) lastError = null;
    lastMeUnselected = false;
    if (!pinned) {
      pinned = candidate;
      observed = candidate;
      changed = false;
      lastError = null;
      contextGen += 1;
      emit();
      return false;
    }
    noteObserved(candidate);
    return false;
  } catch {
    // An unreadable me body changes nothing: keep the pinned view.
    return false;
  }
}

// Recognized unselected proof only: exact NO_ORGANIZATION_MEMBERSHIP code
// on a 403 plus a verified identity object (user.id string). Arbitrary
// 403s and unreadable bodies never read as "no org selected" and network
// failures never read as session loss.
async function peekUnselectedMe(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const data: unknown = await response.clone().json();
    const record = asRecord(data);
    if (!record) return false;
    const codeHit =
      record.code === "NO_ORGANIZATION_MEMBERSHIP" ||
      record.errorCode === "NO_ORGANIZATION_MEMBERSHIP" ||
      asRecord(record.error)?.code === "NO_ORGANIZATION_MEMBERSHIP";
    if (!codeHit) return false;
    const user = asRecord(record.user);
    return !!user && typeof user.id === "string" && user.id !== "";
  } catch {
    return false;
  }
}

async function validateMe(): Promise<OperatorContext | null> {
  if (typeof window === "undefined") return pinned;
  if (validateInFlight) return validateInFlight;
  const task = (async (): Promise<OperatorContext | null> => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS);
    try {
      const { response, seq } = await fetchMeTracked(controller.signal);
      if (response.status === 401) {
        // Logged out elsewhere: keep the pinned forms (never silently
        // switch or clear them); the next write surfaces the real 401.
        // A dead session carries no selection meaning either.
        lastMeUnselected = false;
        return pinned;
      }
      if (!response.ok && !(response.status === 403 && (await peekUnselectedMe(response)))) {
        // 503 and friends: never silently claim the recheck succeeded, and
        // never clear the pinned view. Manual refresh surfaces this.
        // An arbitrary 403 keeps its status here too — it is not evidence
        // of anything beyond its own failure.
        throw transportError(response.status, undefined);
      }
      // Await the observation so explicit callers (refresh/recovery) see the
      // settled view; passive observations stay fire-and-forget.
      await observeMeOnce(response, seq);
      lastValidateAt = Date.now();
      return pinned;
    } catch (error) {
      throw transportError(0, error);
    } finally {
      window.clearTimeout(timer);
      validateInFlight = null;
    }
  })();
  validateInFlight = task;
  return task;
}

// Network-class failures speak Korean: an aborted, unreachable, or
// otherwise failed check must never surface an English TypeError as the
// "recheck" result. Known status/code errors pass through untouched.
function transportError(status: number, cause: unknown): Error {
  if (
    cause instanceof Error &&
    (typeof (cause as { status?: unknown }).status === "number" ||
      typeof (cause as { code?: unknown }).code === "string")
  ) {
    return cause;
  }
  return Object.assign(
    new Error("조직 정보를 다시 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요."),
    { status, cause }
  );
}

function ensureWakeWired(): void {
  if (wakeWired) return;
  if (typeof window === "undefined" || typeof document === "undefined") return;
  wakeWired = true;
  const wake = () => {
    if (document.visibilityState === "hidden") return;
    if (Date.now() - lastValidateAt < WAKE_VALIDATE_MIN_INTERVAL_MS) return;
    // Background wake: failures stay silent here (no banner, no throw);
    // manual refresh surfaces them instead.
    void validateMe().catch(() => {});
  };
  window.addEventListener("focus", wake);
  document.addEventListener("visibilitychange", wake);
  if (typeof BroadcastChannel !== "undefined") {
    try {
      channel = new BroadcastChannel(ORGANIZATION_CHANNEL);
      channel.onmessage = (event: MessageEvent) => {
        const data = asRecord(event?.data);
        if (!data || data.type !== "org-changed" || data.from === TAB_ID) return;
        // Another tab switched: revalidate, never silently adopt.
        lastValidateAt = 0;
        void validateMe().catch(() => {});
      };
    } catch {
      channel = null;
    }
  }
}

export async function ensureOperatorContext(): Promise<OperatorContext> {
  ensureWakeWired();
  if (pinned) return pinned;
  // Shell, menu and staff may ask at once on mount: one bounded in-flight
  // promise, so a slow older twin cannot throw selection-required (or seed)
  // while the latest request is still pending.
  if (ensureInFlight) return ensureInFlight;
  const task = (async (): Promise<OperatorContext> => {
    if (typeof window !== "undefined") {
      loading = true;
      lastError = null;
      emit();
    }
    try {
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer =
        controller && typeof window !== "undefined"
          ? window.setTimeout(() => controller.abort(), VALIDATE_TIMEOUT_MS)
          : null;
      try {
        const { response, seq } = await fetchMeTracked(controller?.signal ?? undefined);
        if (response.status === 401) {
          throw Object.assign(new Error("로그인이 필요합니다"), { status: 401 });
        }
        if (!response.ok && !(response.status === 403 && (await peekUnselectedMe(response)))) {
          throw Object.assign(new Error("작업자 정보를 불러오지 못했습니다"), {
            status: response.status,
          });
        }
        await observeMeOnce(response, seq);
        if (!pinned) {
          // Our own response may have been retired by a newer validation
          // that is still determining the initial outcome (ensure and
          // validate keep SEPARATE in-flight promises): join that bounded
          // operation instead of failing on a retired observer. Resolves
          // the ACTUAL outcome — selected, unselected, or error — never a
          // stale unchanged state. Newer-me retirement is preserved (our
          // response stays dropped); validation never awaits ensure, so no
          // cycle is possible.
          const newer = validateInFlight;
          if (newer) {
            try {
              await newer;
            } catch (error) {
              throw error instanceof Error ? error : new Error("작업자 정보를 불러오지 못했습니다");
            }
            if (pinned) {
              lastError = null;
              return pinned;
            }
          }
          // Authenticated but unselected (or unreadable body): never a
          // logout. The explicit selector owns recovery.
          if (!lastMeUnselected) {
            lastError = "작업자 정보를 불러오지 못했습니다";
          }
          throw lastMeUnselected ? selectionError() : new Error(lastError ?? "작업자 정보를 불러오지 못했습니다");
        }
        lastError = null;
        return pinned;
      } finally {
        if (timer && typeof window !== "undefined") window.clearTimeout(timer);
      }
    } catch (error) {
      if (!lastError) {
        lastError = error instanceof Error ? error.message : "작업자 정보를 불러오지 못했습니다";
      }
      throw error instanceof Error ? error : new Error(lastError);
    } finally {
      loading = false;
      emit();
    }
  })();
  ensureInFlight = task;
  try {
    return await task;
  } finally {
    if (ensureInFlight === task) ensureInFlight = null;
  }
}

export async function refreshOperatorContext(): Promise<void> {
  ensureWakeWired();
  loading = true;
  lastError = null;
  emit();
  try {
    await validateMe();
    // An unselected me is authoritative: the explicit selector owns
    // recovery, so the banner stays instead of reporting a false success.
    if (lastMeUnselected) {
      lastError = SELECTION_MESSAGE;
    } else {
      lastError = null;
    }
  } catch (error) {
    lastError = error instanceof Error ? error.message : "작업자 정보를 불러오지 못했습니다";
  } finally {
    loading = false;
    emit();
  }
}

// ONLY explicit same-org recovery may install this (plus the initial null
// seed): after the server confirms the same pinned org at a new version —
// the operator's explicit return — the pinned view renews in place, the
// view stays, and pending refs keep their commandId and payload while their
// frozen contextVersion moves to the new one. A different organizationId
// while a view is pinned is IGNORED here (no silent cross-org install, no
// receipt touch, no broadcast): the different-org switch path is
// observeSelectedOrganization below, followed by a native navigation whose
// fresh document seeds the new org on its own. An identical accept (same
// identity, no drift) is a no-op: stable values must not mint a new
// generation or rebroadcast.
export function acceptOperatorContext(user: unknown): void {
  const candidate = contextFromUser(user);
  if (!candidate) return;
  if (pinned && candidate.organizationId !== pinned.organizationId) return;
  if (pinned && !changed && sameContext(pinned, candidate)) return;
  // Explicit user action retires every older initiated me read: a delayed
  // B/v2 response must never re-mark a freshly restored A/v3 as changed.
  lastCompletedMeSeq = meSeq;
  // The generation moves before the renewal below so the renewed entries
  // record the post-bump generation: only a LATER drift revokes the grant.
  contextGen += 1;
  for (const entry of uncertain.values()) {
    if (entry.organizationId === candidate.organizationId) {
      renewFrozenEntry(entry, candidate.contextVersion, contextGen);
    }
  }
  pinned = candidate;
  observed = candidate;
  changed = false;
  loading = false;
  lastError = null;
  lastMeUnselected = false;
  emit();
  broadcastOrganizationChange();
}

// Refresh exactly one frozen mapping to a new version: the stored header
// moves, method/url/body stay byte-identical. Never the body's
// expectedContextVersion/org/id fields — renewal is headers-only. The grant
// generation is recorded by the caller after its generation bump, so a stale
// observed snapshot can never veto the renewed entry.
function renewFrozenEntry(entry: UncertainEntry, contextVersion: number, renewedGen: number): void {
  entry.contextVersion = contextVersion;
  entry.renewedGen = renewedGen;
  if (entry.attempt) {
    entry.attempt.headers[CONTEXT_VERSION_HEADER] = String(contextVersion);
  }
}

export type UncertainAttemptInfo = {
  key: string;
  organizationId: string;
  organizationName: string;
  command: string | null;
  method: string;
  path: string;
  // Defensive only: current writers always freeze the full attempt, but a
  // replayable control must never show active when there is nothing to send.
  replayable: boolean;
};

// Snapshot-safe view of pending receipts: org target + command label only.
// No URLs with query strings, no headers, no bodies, no tokens.
export function listUncertainAttempts(): UncertainAttemptInfo[] {
  const out: UncertainAttemptInfo[] = [];
  for (const [key, entry] of uncertain) {
    out.push({
      key,
      organizationId: entry.organizationId,
      organizationName: entry.organizationName,
      command: entry.command,
      method: entry.attempt?.method ?? "POST",
      path: entry.attempt?.path ?? "",
      replayable: Boolean(entry.attempt),
    });
  }
  return out;
}

// Same-org version renewal WITHOUT adopting a new view: used when an
// explicit same-org selection confirms a newer context version while
// receipts are still pending (e.g. a role change with unconfirmed writes).
// Only the version moves — pinned identity, drafts, guards, and the changed
// lock stay exactly as they are. Returns false when there is nothing safe
// to renew (no pinned view or a different org).
export function renewPinnedOrganizationVersion(user: unknown): boolean {
  const candidate = contextFromUser(user);
  if (!candidate || !pinned) return false;
  if (candidate.organizationId !== pinned.organizationId) return false;
  pinned = { ...pinned, contextVersion: candidate.contextVersion };
  // The generation moves before the renewal below so the renewed entries
  // record the post-bump generation: a stale same-org observed snapshot
  // left over from before the restore can never veto the renewed grant —
  // only a LATER drift does.
  contextGen += 1;
  for (const entry of uncertain.values()) {
    if (entry.organizationId === candidate.organizationId) {
      renewFrozenEntry(entry, candidate.contextVersion, contextGen);
    }
  }
  emit();
  broadcastOrganizationChange();
  return true;
}

export type UncertainReplayResult = {
  status: number | null;
  settled: boolean;
};

// Explicit on-demand recheck of one frozen receipt. Replays the frozen
// attempt byte-for-byte through a guarded transport: blocked before
// transmitting unless the pinned view is the entry's original org, dropped
// silently when there is nothing pending, and never auto-retried.
// - 2xx with a parseable JSON object body: settled, mapping cleared. Only
//   then may the UI show the generic HTTP-200 confirmation.
// - 5xx/408/network failure: kept as uncertain (may retry explicitly).
// - definitive 4xx (incl. non-context 409s): settled, mapping cleared.
// - context-coded 409: kept, drift marked, shared reads invalidated.
// - Membership revocation: kept? No — revoked means definitively not
//   committed: the mapping clears, and the authoritative /auth/me decides.
export async function replayUncertainAttempt(key: string): Promise<UncertainReplayResult> {
  const entry = uncertain.get(key);
  if (!entry || !entry.attempt) return { status: null, settled: true };
  const current = pinned;
  if (!current || current.organizationId !== entry.organizationId) {
    throw contextError(
      "이전 조직에서 결과가 확인되지 않은 요청입니다. 조직을 확인하고 같은 요청으로 다시 시도하세요."
    );
  }
  if (
    changed &&
    entry.renewedGen !== contextGen
  ) {
    // The grant is bound to the renewal generation: any drift or
    // observation AFTER the entry was (re)granted — another org observed,
    // or a newer version of the same org — invalidates it, even though the
    // pinned workspace is still the entry's org. Only an explicit same-org
    // renewal re-grants. A stale same-org observed snapshot left over from
    // before the renewal never vetoes the renewed entry.
    throw contextError(
      "이전 조직에서 결과가 확인되지 않은 요청입니다. 조직을 확인하고 같은 요청으로 다시 시도하세요."
    );
  }
  inFlightWrites += 1;
  emit();
  try {
    const response = await fetch(entry.attempt.url, {
      method: entry.attempt.method,
      headers: entry.attempt.headers,
      body: entry.attempt.body ?? undefined,
    });
    if (response.status === 409 && (await peekContextCode(response))) {
      markContextChanged();
      kickRevalidation();
      return { status: response.status, settled: false };
    }
    if (!response.ok) {
      if (
        (response.status === 403 || response.status === 409) &&
        (await peekMembershipCode(response))
      ) {
        kickRevalidation();
        uncertain.delete(key);
        emit();
        return { status: response.status, settled: true };
      }
      if (response.status === 409 || isDefinitiveRejection(response.status)) {
        if (uncertain.delete(key)) emit();
        return { status: response.status, settled: true };
      }
      return { status: response.status, settled: false };
    }
    try {
      const data: unknown = await response.clone().json();
      if (data && typeof data === "object") {
        if (uncertain.delete(key)) emit();
        return { status: response.status, settled: true };
      }
    } catch {
      // Unreadable body: keep the mapping, let the next explicit check decide.
    }
    return { status: response.status, settled: false };
  } catch (error) {
    if (isOrganizationContextBlock(error)) throw error;
    return { status: null, settled: false };
  } finally {
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    emit();
  }
}

// Records an explicitly SELECTED different org without pinning it: stores
// the new view as observed, marks changed, broadcasts, and drops shared
// reads (via the console-api subscription) — but never installs the pinned
// view and never renews frozen receipts. The caller navigates natively
// afterwards (role home), and the fresh document seeds the new org on its
// own first read. This keeps an old-A form from issuing org-level writes
// under B in the gap between switch success and full navigation.
export function observeSelectedOrganization(user: unknown): void {
  const candidate = contextFromUser(user);
  if (!candidate) return;
  if (pinned && sameContext(pinned, candidate)) {
    // Identical view: refresh the observed slot silently, no drift, no
    // broadcast, no generation — stable values stay stable.
    if (observed && sameContext(observed, candidate)) return;
    observed = candidate;
    lastCompletedMeSeq = meSeq;
    emit();
    return;
  }
  const prevObserved = observed;
  observed = candidate;
  const becameChanged = !changed;
  changed = true;
  // Explicit user action retires every older initiated me read.
  lastCompletedMeSeq = meSeq;
  // A genuinely newer observation always moves the generation — even when
  // the view is already marked changed — so renewed replay grants made
  // before it are revoked until the next explicit renewal.
  if (becameChanged || !prevObserved || !sameContext(prevObserved, candidate)) contextGen += 1;
  emit();
  if (becameChanged) broadcastOrganizationChange();
}

// A self role write just committed (proven by its own response), but the
// next screen stays unverified until a fresh authoritative read decides it.
// Marks drift IMMEDIATELY — retaining pinned forms, frozen receipts and
// guards — without assuming the requested role, clearing anything, or
// recording any new authority. The caller follows with
// invalidateConsoleReads + refreshOperatorContext; the central notice owns
// the explicit fresh-me recheck outside the locked workspace. A later 503 on
// that recheck alone never locks or unlocks: the validateMe failure path is
// untouched, so only this explicit mark engages the lock without waiting
// for focus, timers, or another tab.
export function noteCommittedOperatorRoleChange(): void {
  if (!pinned) return;
  // Explicit local act retires every older initiated me read: a delayed
  // pre-commit response must never unmark the freshly departed view.
  lastCompletedMeSeq = meSeq;
  if (changed) return;
  changed = true;
  contextGen += 1;
  emit();
  broadcastOrganizationChange();
}

export function resetOperatorContext(): void {
  // Logout/teardown path: drop the pinned view and flags, clear ambiguous
  // mappings, and tell other tabs to revalidate (they keep their forms and
  // surface the dead session through their existing failures). Already
  // clean state is a no-op: stable values must not mint a generation.
  if (
    !pinned &&
    !observed &&
    !changed &&
    !loading &&
    lastError === null &&
    uncertain.size === 0 &&
    inFlightWrites === 0
  ) {
    return;
  }
  pinned = null;
  observed = null;
  changed = false;
  loading = false;
  lastError = null;
  uncertain.clear();
  // Retire every older initiated me read: nothing initiated before this
  // teardown may pin or mark afterwards.
  lastCompletedMeSeq = meSeq;
  lastMeUnselected = false;
  contextGen += 1;
  emit();
  broadcastOrganizationChange();
}

const SELECTION_MESSAGE = "조직을 선택하세요";

function markContextChanged(): void {
  if (!changed) {
    changed = true;
    contextGen += 1;
    emit();
  }
}

function rememberUncertain(
  commandId: string | null,
  snapshot: { organizationId: string; organizationName: string; contextVersion: number },
  attempt: FrozenAttempt
): void {
  const key = commandId ?? `noid-${Date.now().toString(36)}-${uncertain.size}`;
  uncertain.set(key, {
    organizationId: snapshot.organizationId,
    organizationName: snapshot.organizationName,
    contextVersion: snapshot.contextVersion,
    at: Date.now(),
    command: attempt.command,
    path: attempt.path,
    attempt,
    renewedGen: contextGen,
  });
  while (uncertain.size > UNCERTAIN_ENTRY_CAP) {
    const oldest = uncertain.keys().next();
    if (oldest.done) break;
    uncertain.delete(oldest.value);
  }
  emit();
}

function isDefinitiveRejection(status: number): boolean {
  // 4xx (except 408 timeout and 409 conflict) proves the server saw and
  // rejected this exact request: nothing was committed, so nothing stays
  // uncertain. 409-without-code is handled separately (sibling attempt).
  return status >= 400 && status < 500 && status !== 408 && status !== 409;
}

function resolveUncertain(commandId: string | null): void {
  if (commandId && uncertain.delete(commandId)) emit();
}

async function peekContextCode(response: Response): Promise<boolean> {
  try {
    const data: unknown = await response.clone().json();
    const record = asRecord(data);
    if (!record) return false;
    if (record.code === ORGANIZATION_CONTEXT_CHANGED) return true;
    if (record.errorCode === ORGANIZATION_CONTEXT_CHANGED) return true;
    const nested = asRecord(record.error);
    if (nested && nested.code === ORGANIZATION_CONTEXT_CHANGED) return true;
    return false;
  } catch {
    return false;
  }
}

async function peekMembershipCode(response: Response): Promise<boolean> {
  // Known server contract only: 403 NO_ORGANIZATION_MEMBERSHIP, identity
  // user body. No other code is inferred here.
  try {
    const data: unknown = await response.clone().json();
    const record = asRecord(data);
    if (!record) return false;
    if (record.code === "NO_ORGANIZATION_MEMBERSHIP") return true;
    if (record.errorCode === "NO_ORGANIZATION_MEMBERSHIP") return true;
    const nested = asRecord(record.error);
    if (nested && nested.code === "NO_ORGANIZATION_MEMBERSHIP") return true;
    return false;
  } catch {
    return false;
  }
}

// Guarded private GETs carry proof-of-transaction response headers. The
// read validates frozen request context, current pinned context, snapshot
// generation, and the response headers before delivering anything:
//   - unpinned first-view read: launch-time ignorance proves nothing. If a
//     view pinned while the read was in flight, the actual proof headers
//     are enforced against it (a stale org-A proof under a fresh org-B pin
//     is rejected, never delivered). If nothing pinned yet, the read joins
//     the bounded deduped initial load (no extra request) and enforces its
//     answer; a failed load rejects truthfully, never as false context.
//   - generation moved (drift/switch/accept/reset since request): discard,
//     the frozen view is gone.
//   - frozen or current pinned mismatch: discard, the view moved mid-flight.
//   - headers missing on a 2xx: unverified, fail closed (server follow-up
//     pending) — discard, mark drift, kick a bounded revalidation.
//   - headers present but mismatched: discard, mark drift, revalidate.
//   - In-flight reads freeze request context plus the snapshot generation.
//     A read resolving after the view moved never delivers; when the
//     current view is still the same pinned org (or gone), the discard is
//     quiet — no new drift, no revalidation. Only a genuinely foreign
//     context marks drift.
//   - Auth organization endpoints, health, and public traffic deliver
//     untouched (validation covers guarded private data reads only).
// Error responses pass through untouched: their status already speaks, and
// swallowing a 401/500 into a drift error would hide the real failure.
async function validateGuardedRead(
  response: Response,
  frozen: { frozenGen: number; frozenOrgId: string | null; frozenVersion: number | undefined }
): Promise<Response> {
  if (!response.ok) return response;
  if (frozen.frozenOrgId === null || frozen.frozenVersion === undefined) {
    const midFlight = pinned;
    if (midFlight) {
      // A view pinned after launch — but already drifted, torn down, or
      // recovered since: the launch-time ignorance cannot prove anything
      // against the moved view. Discard quietly (no re-mark, no
      // revalidation loop); the pinned-request branch already rejects
      // generation moves the same way.
      if (changed) {
        return Promise.reject(contextError("읽은 뒤 화면이 바뀌었습니다. 다시 시도하세요."));
      }
      // A view pinned after launch: enforce the actual proof against it.
      return validateProofHeaders(response, midFlight);
    }
    // Nothing pinned yet: join the bounded deduped initial load rather than
    // delivering on ignorance. No extra request beyond the mount storm, no
    // auto-select, no cookie change. ensureOperatorContext returns the pinned
    // view or throws its truthful failure (503, selection-required): either
    // way nothing false is manufactured here. Server-side rendering keeps
    // the old deliver path (no window, no session mount).
    if (typeof window === "undefined") return response;
    await ensureOperatorContext();
    // Drift, teardown, or recovery may have invalidated the read while the
    // initial load ran: an already-changed view discards quietly.
    if (changed) {
      return Promise.reject(contextError("읽은 뒤 화면이 바뀌었습니다. 다시 시도하세요."));
    }
    const seeded = pinned;
    if (!seeded) {
      // Unreachable: ensure returns a pinned view or throws. Fail closed.
      markContextChanged();
      kickRevalidation();
      return Promise.reject(contextError("응답에서 조직 정보를 확인할 수 없습니다. 조직을 확인하고 다시 시도하세요."));
    }
    return validateProofHeaders(response, seeded);
  }
  const current = pinned;
  const moved =
    frozen.frozenGen !== contextGen ||
    !current ||
    current.organizationId !== frozen.frozenOrgId ||
    current.contextVersion !== frozen.frozenVersion;
  if (moved) {
    // Launched before the view moved: never deliver. When the current view
    // is already known safe (same pinned org — e.g. an explicit same-org
    // renewal landed mid-flight) or gone (logout teardown), discard quietly
    // WITHOUT marking drift again or revalidating. Only a genuinely foreign
    // context marks drift.
    if (!current || current.organizationId === frozen.frozenOrgId) {
      return Promise.reject(contextError("읽은 뒤 화면이 바뀌었습니다. 다시 시도하세요."));
    }
    markContextChanged();
    kickRevalidation();
    return Promise.reject(
      contextError("다른 조직으로 전환된 뒤라 읽기를 멈췄습니다. 조직을 확인하고 다시 시도하세요.")
    );
  }
  let headerOrg: string | null = null;
  let headerVersion: number | null = null;
  try {
    headerOrg = response.headers.get(ORGANIZATION_ID_HEADER);
    headerVersion = toVersion(response.headers.get(CONTEXT_VERSION_HEADER));
  } catch {
    headerOrg = null;
    headerVersion = null;
  }
  return validateProofHeaders(response, current);
}

// Enforces actual proof-of-transaction headers against a known view. Both
// failure modes mark drift and kick a bounded revalidation; the original
// coded/generic status already passed through above, so only 2xx arrive.
async function validateProofHeaders(response: Response, current: OperatorContext): Promise<Response> {
  let headerOrg: string | null = null;
  let headerVersion: number | null = null;
  try {
    headerOrg = response.headers.get(ORGANIZATION_ID_HEADER);
    headerVersion = toVersion(response.headers.get(CONTEXT_VERSION_HEADER));
  } catch {
    headerOrg = null;
    headerVersion = null;
  }
  if (headerOrg === null || headerVersion === null) {
    markContextChanged();
    kickRevalidation();
    return Promise.reject(contextError("응답에서 조직 정보를 확인할 수 없습니다. 조직을 확인하고 다시 시도하세요."));
  }
  if (headerOrg !== current.organizationId || headerVersion !== current.contextVersion) {
    markContextChanged();
    kickRevalidation();
    return Promise.reject(contextError("다른 조직의 응답이라 버렸습니다. 조직을 확인하고 다시 시도하세요."));
  }
  return response;
}

function kickRevalidation(): void {
  if (typeof window === "undefined") return;
  if (Date.now() - mismatchValidateAt < MISMATCH_VALIDATE_MIN_INTERVAL_MS) return;
  mismatchValidateAt = Date.now();
  // Fire-and-forget by design: background wakes never surface, and never
  // reject unhandled. Manual refresh awaits validateMe directly instead.
  void validateMe().catch(() => {});
}

// Shared operator transport. Reads flow through with their init untouched
// (consoleFetch keeps its own dedupe/timeout on top); private writes get the
// frozen org headers, busy/uncertain bookkeeping, and drift protection.
// Guest traffic (ticket bearer), auth-owned endpoints and public
// attendee/signup paths bypass everything and hit the network directly —
// except that /auth/me responses still seed the pinned view.
export async function operatorFetch(input: string, init?: RequestInit): Promise<Response> {
  ensureWakeWired();
  const url = typeof input === "string" ? input : String((input as { url?: unknown }).url ?? input);
  const path = pathOf(url);
  if (path === null || !path.startsWith("/api/")) {
    return fetch(url, init);
  }
  const method = (init?.method ?? "GET").toUpperCase();
  const isWrite = method !== "GET" && method !== "HEAD";
  const guest = hasAuthorizationHeader(init);
  const exempt = guest || isContextExempt(path, method);

  if (!isWrite) {
    if (changed && !exempt && !isAlwaysAllowedRead(path)) {
      // A post-drift read must never repopulate the old forms.
      throw contextError(
        "다른 조직으로 전환된 뒤라 읽기를 멈췄습니다. 조직을 확인하고 다시 시도하세요."
      );
    }
    // Freeze the read context at request time: generation, org, version.
    const frozenGen = contextGen;
    const frozenOrgId = pinned?.organizationId ?? null;
    const frozenVersion = pinned?.contextVersion;
    // Error statuses never reach header validation: their status already
    // speaks. But two coded failures still inform the context without ever
    // masking the original body/status for the caller:
    // - an explicit context-change 409 marks drift and revalidates;
    // - a revoked-membership 403 (identity body) only kicks a revalidation.
    //   The pinned view is never cleared here and there is no login
    //   redirect: authoritative /auth/me decides (observed null + drift +
    //   selection banner when it confirms no org).
    const { response, seq } = await (async () => {
      if (path === "/api/auth/me") {
        // ONLY validation reads consume sequence numbers, with the caller's
        // init (signal/cache) passed through untouched: every other GET
        // leaves meSeq alone, so a mount storm (org list, directory,
        // bootstrap) racing the initial me can never retire its seed. Only a
        // genuinely newer /auth/me retires an older one (observeMeOnce).
        const next = ++meSeq;
        const fetched = await fetch(url, init);
        return { response: fetched, seq: next };
      }
      const fetched = await fetch(url, init);
      return { response: fetched, seq: -1 };
    })();
    if (path === "/api/auth/me") {
      // Await the observation so explicit recovery sees the settled view. A
      // SUPERSEDED success (a newer validation owns the answer) is quietly
      // rejected after joining the newer bounded operation — the stale body
      // must never reach role consumers as authority. Raw non-2xx answers
      // pass through untouched, and a direct raw me stays available for
      // explicit role recovery: a fresh (newest) read while drifted still
      // observes and delivers the new authority.
      const superseded = await observeMeOnce(response, seq);
      if (superseded && response.ok) {
        const newer = validateInFlight ?? ensureInFlight;
        if (newer) {
          try {
            await newer;
          } catch {
            // The quiet rejection below already asks for a re-read.
          }
        }
        throw supersededMeError();
      }
      return response;
    }
    if (!response.ok && !exempt && !isAlwaysAllowedRead(path)) {
      if (response.status === 409 && (await peekContextCode(response))) {
        markContextChanged();
        kickRevalidation();
        return response;
      }
      if (
        (response.status === 403 || response.status === 409) &&
        (await peekMembershipCode(response))
      ) {
        kickRevalidation();
        return response;
      }
    }
    // Auth organization endpoints, health, and public traffic deliver
    // untouched: validation covers guarded private data reads only, and
    // /auth/me seeds through the observer above.
    if (exempt || isAlwaysAllowedRead(path)) return response;
    return validateGuardedRead(response, { frozenGen, frozenOrgId, frozenVersion });
  }

  if (exempt) {
    // Own-validation endpoints and guest traffic transmit untouched.
    return fetch(url, init);
  }

  if (changed) {
    // Block BEFORE transmitting: nothing from the old context may reach the
    // server once drift is known, until explicit UI recovery.
    throw contextError(
      "다른 조직으로 전환된 뒤라 저장을 멈췄습니다. 조직을 확인하고 다시 시도하세요."
    );
  }

  // Freeze the request context at call time from the pinned snapshot. No
  // payload mutation: headers carry the frozen org, the body stays byte
  // identical for receipt replays.
  const frozenOrgId = pinned?.organizationId ?? "";
  const frozenVersion = pinned?.contextVersion;
  const headers = new Headers(init?.headers as HeadersInit | undefined);
  if (frozenOrgId && frozenVersion !== undefined) {
    headers.set(ORGANIZATION_ID_HEADER, frozenOrgId);
    headers.set(CONTEXT_VERSION_HEADER, String(frozenVersion));
  }
  const commandId = extractCommandId(url, init?.body as BodyInit | null | undefined);

  // Receipt-version rebind is approved ONLY as an explicit same-org return:
  // a retry naming an uncertain commandId whose frozen context no longer
  // matches the pinned view stays blocked until acceptOperatorContext
  // renews it (same org) — never rebound passively, never across orgs.
  if (commandId && pinned) {
    const prior = uncertain.get(commandId);
    if (
      prior &&
      (prior.organizationId !== pinned.organizationId || prior.contextVersion !== pinned.contextVersion)
    ) {
      throw contextError(
        "이전 조직에서 결과가 확인되지 않은 요청입니다. 조직을 확인하고 같은 요청으로 다시 시도하세요."
      );
    }
  }

  inFlightWrites += 1;
  emit();
  // The frozen attempt travels with the uncertain mapping: an explicit
  // on-demand check replays exactly this method/url/body/headers.
  const frozenAttempt = freezeAttempt(
    url,
    init,
    headers,
    frozenOrgId,
    pinned?.organizationName ?? "",
    frozenVersion ?? -1
  );
  const frozenSnapshot =
    frozenOrgId && frozenVersion !== undefined
      ? { organizationId: frozenOrgId, organizationName: pinned?.organizationName ?? "", contextVersion: frozenVersion }
      : null;
  try {
    const response = await fetch(url, { ...init, headers });
    if (response.status === 409 && (await peekContextCode(response))) {
      if (commandId && frozenSnapshot) {
        rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
      }
      markContextChanged();
      kickRevalidation();
      return response;
    }
    if (!response.ok) {
      if (
        (response.status === 403 || response.status === 409) &&
        (await peekMembershipCode(response))
      ) {
        // Revoked membership with identity body: keep the pinned view and
        // the original status/body intact — revalidate and let authoritative
        // /auth/me decide (observed null + drift + selection banner on
        // no-org). Never a login redirect from here. The rejection itself
        // proves nothing was committed, so no uncertain mapping is kept.
        kickRevalidation();
        resolveUncertain(commandId);
        return response;
      }
      // A received non-context 409 is an AUTHORITATIVE outcome: the server
      // checks the command receipt before business validation, so the same
      // payload cannot still be an ambiguous network outcome. Clear the
      // mapping, never auto-retry. Theme version conflicts and the invite
      // link-unavailable receipt behave the same — the UI already cleared
      // its own pending slot honestly. Only 5xx/408/network stay uncertain.
      if (response.status === 409 || isDefinitiveRejection(response.status)) {
        resolveUncertain(commandId);
        return response;
      }
      if (frozenSnapshot) {
        rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
      }
      return response;
    }
    resolveUncertain(commandId);
    return response;
  } catch (error) {
    // Transport failure: outcome unknown, keep the receipt mapping.
    if (frozenSnapshot) {
      rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
    }
    throw error;
  } finally {
    inFlightWrites = Math.max(0, inFlightWrites - 1);
    emit();
  }
}
