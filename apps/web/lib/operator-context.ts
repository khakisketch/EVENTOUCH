"use client";

import { beginOperatorReceipt, endOperatorReceipt, type OperatorReceiptPointer } from "./operator-receipts";
import { boothScheduleTime } from "./booth-availability";
import { fetchWithDeadline } from "./request-deadline";
import { cancellationProofMatches } from "./bulk-cancel-proof";

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
//   - Ambiguous outcomes (network loss, 5xx, 408/425/429, unreadable success bodies)
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
  authGeneration: number;
  userId: string | null;
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
    authGeneration,
    userId: authUserId,
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
    left.userId === right.userId &&
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

function receiptPointer(path: string, body: BodyInit | null | undefined, commandId: string | null, context: OperatorContext | null): OperatorReceiptPointer | null {
  if (!commandId || !context || typeof body !== "string") return null;
  let command = "";
  let eventId: string | null = null;
  const event = /^\/api\/events\/([^/]+)\/commands$/.exec(path);
  if (event) {
    try {
      eventId = decodeURIComponent(event[1]);
      const parsed = asRecord(JSON.parse(body));
      command = typeof parsed?.command === "string" ? parsed.command : typeof parsed?.name === "string" ? parsed.name : "";
    } catch { return null; }
  } else if (path === "/api/events") command = "event.create";
  else if (/^\/api\/events\/[^/]+\/duplicate$/.test(path)) command = "event.duplicate";
  else if (path === "/api/clients") command = "client.save";
  else if (path === "/api/auth/invitations") command = "invitation.create";
  else if (/^\/api\/auth\/accounts\/[^/]+\/password$/.test(path)) command = "account.password-reset";
  else if (/^\/api\/accounts\/[^/]+\/org-permissions$/.test(path)) command = "org.permissions.save";
  else if (/^\/api\/events\/[^/]+\/members$/.test(path)) command = "member.assign";
  else return null;
  return { userId: context.userId, organizationId: context.organizationId, eventId, commandId, command };
}

// A create response must belong to the original request and preserve the
// scheduled/simulated distinction; a 2xx alone does not establish this.
export function confirmsMessageCreate(commandId: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const message = asRecord(asRecord(value)?.message);
  if (!input || !message || message.id !== commandId || typeof message.status !== "string") return false;
  if (typeof input.scheduled === "string" && input.scheduled) return message.status === "SCHEDULED";
  if (input.simulate === true) return message.status === "SIMULATED";
  return ["NEEDS_CONNECTION", "SENDING", "ACCEPTED", "SENT", "PARTIAL", "FAILED"].includes(message.status);
}

// The reviewed command must prove the exact selected audience and content;
// an ID and a status alone can describe a different request with a reused ID.
export function confirmsReviewedMessageCreate(commandId: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload), result = asRecord(value), message = asRecord(result?.message);
  if (!input || !result || result.messageRequestVersion !== 1 || !message ||
      !confirmsMessageCreate(commandId, input, result) || !Array.isArray(input.ids) || !input.ids.length ||
      !input.ids.every((id) => typeof id === "string" && Boolean(id.trim())) ||
      !Array.isArray(input.expectedRecipientVersions) || input.expectedRecipientVersions.length !== input.ids.length ||
      !input.expectedRecipientVersions.every((version) => typeof version === "string" && /^[a-f0-9]{64}$/.test(version)) ||
      !Array.isArray(message.recipientIds) || JSON.stringify(message.recipientIds) !== JSON.stringify(input.ids.map((id: string) => id.trim().slice(0, 120))) ||
      typeof input.title !== "string" || message.title !== input.title.trim().slice(0, 100) ||
      typeof input.body !== "string" || message.body !== input.body.trim().slice(0, 2000) ||
      typeof input.channel !== "string" || message.channel !== input.channel.trim().toUpperCase() ||
      message.simulate !== (input.simulate === true)) return false;
  const scheduled = typeof input.scheduled === "string" ? input.scheduled.trim().slice(0, 64) : "";
  if (message.scheduled !== scheduled ||
      (scheduled && message.scheduleMode !== (typeof input.scheduleMode === "string" ? input.scheduleMode.trim().toUpperCase() : "MANUAL"))) return false;
  const templateId = typeof input.templateId === "string" ? input.templateId.trim().slice(0, 120) || null : null;
  if (message.templateId !== templateId) return false;
  if (message.channel === "MMS" && (typeof input.imageFileId !== "string" || asRecord(message.image)?.fileId !== input.imageFileId.trim().slice(0, 160))) return false;
  return true;
}

export function confirmsCharsetReviewedMessageCreate(commandId: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload), result = asRecord(value), message = asRecord(result?.message);
  if (!input || !result || result.messageCharsetPolicyVersion !== 1 || !message ||
      !confirmsReviewedMessageCreate(commandId, input, result)) return false;
  return message.channel !== "ALIMTALK" ||
    (typeof input.smsFallback === "boolean" && message.smsFallback === input.smsFallback);
}

export function confirmsProviderCheck(payload: unknown, value: unknown): boolean {
  const input = asRecord(payload), result = asRecord(value), proof = asRecord(result?.providerCheck), message = asRecord(result?.message);
  if (!input || !proof || !message || typeof input.id !== "string" || !input.id || message.id !== input.id || proof.id !== input.id ||
      typeof input.participantId !== "string" || !input.participantId || proof.participantId !== input.participantId ||
      !["ACCEPTED", "NOT_ACCEPTED"].includes(String(input.outcome)) || proof.outcome !== input.outcome ||
      !(input.expectedSubmissionId === null || (typeof input.expectedSubmissionId === "string" && input.expectedSubmissionId.length > 0)) ||
      proof.expectedSubmissionId !== input.expectedSubmissionId || !Array.isArray(message.deliveries)) return false;
  const matching = message.deliveries.map(asRecord).filter((delivery: Record<string, unknown> | null) => delivery?.participantId === input.participantId);
  if (matching.length !== 1) return false;
  const delivery = matching[0], reviewed = asRecord(delivery?.manualProviderReview);
  return delivery?.status === (input.outcome === "ACCEPTED" ? "ACCEPTED" : "FAILED") &&
    delivery?.genericProviderResult === input.outcome && reviewed?.outcome === input.outcome &&
    typeof reviewed?.actorId === "string" && Boolean(reviewed.actorId) && typeof reviewed?.at === "string" && Boolean(reviewed.at);
}

export function confirmsTemplateSave(payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const template = asRecord(asRecord(value)?.template);
  if (!input || !template || template.archived === true || typeof template.id !== "string" || !template.id ||
      typeof input.name !== "string" || template.name !== input.name.trim() ||
      typeof input.body !== "string" || template.body !== input.body.trim() ||
      typeof input.channel !== "string" || template.channel !== input.channel.trim().toUpperCase() ||
      !Object.hasOwn(template, "solapiTemplateId") || !(template.solapiTemplateId === null || typeof template.solapiTemplateId === "string") ||
      (typeof input.description === "string" && (typeof template.description === "string" ? template.description : "") !== input.description.trim()) ||
      (typeof input.id === "string" && input.id && template.id !== input.id)) return false;
  if (input.expectedVersion !== undefined && (!Number.isSafeInteger(input.expectedVersion) || template.version !== Number(input.expectedVersion) + 1)) return false;
  if (typeof input.solapiTemplateId === "string" && input.solapiTemplateId.trim()) return template.solapiTemplateId === input.solapiTemplateId.trim();
  // The existing API retains an old approval ID when an update submits an
  // empty value. A new template has no such prior value.
  return typeof input.id === "string" && Boolean(input.id) || template.solapiTemplateId === null;
}

export function confirmsTemplateArchive(payload: unknown, value: unknown, expected: unknown): boolean {
  const input = asRecord(payload);
  const template = asRecord(asRecord(value)?.template);
  const source = asRecord(expected);
  return Boolean(input && template && source && typeof input.archived === "boolean" &&
    Number.isSafeInteger(input.expectedVersion) && template.id === input.id && template.id === source.id &&
    template.archived === input.archived && template.version === Number(input.expectedVersion) + 1 &&
    template.name === source.name && template.body === source.body && (typeof template.channel === "string" ? template.channel : "SMS") === source.channel &&
    (template.solapiTemplateId || "") === (source.solapiTemplateId || ""));
}

// A successful HTTP status alone cannot identify a completed draw. Verify
// against the original request before forgetting the status-only pointer.
// No participant data or request body is added to browser storage.
export function confirmsDrawRun(payload: unknown, value: unknown, commandId?: string): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  const program = asRecord(result?.program);
  const count = input?.count;
  if (!input || !result || !program || typeof input.id !== "string" || program.id !== input.id ||
      typeof count !== "number" || !Number.isInteger(count) || count < 1 || count > 20 ||
      !Array.isArray(result.winners) || result.winners.length !== count ||
      !result.winners.every((winner: unknown) => {
        const item = asRecord(winner);
        return item && typeof item.name === "string" && (item.kind === "PERSON" || item.kind === "COMPANY");
      }) || !Array.isArray(program.winners) || program.winners.length < count ||
      typeof result.remaining !== "number" || !Number.isSafeInteger(result.remaining) || result.remaining < 0) return false;
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) ||
      program.revision !== Number(input.expectedRevision) + 1)) return false;
  if (input.showOnScreen !== true) return true;
  const display = asRecord(result.display);
  return display?.type === "draw" && (!commandId || (
    display.drawId === commandId && typeof program.moduleId === "string" && display.moduleId === program.moduleId
  ));
}

// Do not retire a draw/vote operation's receipt merely because its response
// has a 2xx status. Compare the returned entity with the submitted operation.
export function confirmsDrawOperation(command: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result) return false;
  if (command === "team.save") {
    const team = asRecord(result.team);
    return Boolean(team && typeof team.id === "string" && team.id && typeof input.name === "string" &&
      team.name === input.name.trim() && (typeof input.id !== "string" || team.id === input.id) &&
      Number.isSafeInteger(team.order));
  }
  if (command === "draw.program.save") {
    const program = asRecord(result.program);
    if (!program || typeof program.id !== "string" || !program.id ||
        (typeof input.id === "string" && input.id !== program.id)) return false;
    return ["name", "quota", "moduleId", "status", "published", "eligibility", "eligibleGroups", "eligibleCompanies", "overlap", "prizeTiers"]
      .every((field) => !(field in input) || JSON.stringify(program[field]) === JSON.stringify(input[field]));
  }
  if (command === "vote.config.save" || command === "lucky.config.save" || command === "lucky.config.save-reviewed") {
    const target = asRecord(result[command === "vote.config.save" ? "voteConfig" : "luckyConfig"]);
    const fields = command === "vote.config.save" ? ["pickCount", "status", "resultsPublished"] : ["min", "max"];
    return Boolean(target && fields.every((field) => !(field in input) || target[field] === input[field]));
  }
  if (command === "roulette.config.save" || command === "roulette.config.save-reviewed") {
    const config = asRecord(result.rouletteConfig);
    if (command === "roulette.config.save-reviewed" && (!Number.isSafeInteger(input.expectedVersion) || result.rouletteConfigVersion !== Number(input.expectedVersion) + 1)) return false;
    if (!config || !Array.isArray(input.prizes) || !Array.isArray(config.prizes) ||
        config.status !== input.status || config.startsAt !== (input.startsAt || null) ||
        config.endsAt !== (input.endsAt || null) || config.prizes.length !== input.prizes.length) return false;
    return input.prizes.every((raw, index) => {
      const expected = asRecord(raw);
      const actual = asRecord((config.prizes as unknown[])[index]);
      return Boolean(expected && actual && actual.id === expected.id && actual.label === expected.label &&
        actual.quantity === expected.quantity && actual.weight === (expected.weight ?? null));
    });
  }
  if (command === "lucky.preassign" || command === "lucky.preassign-reviewed" || command === "lucky.preassign-range-reviewed") {
    const ids = Array.isArray(input.participantIds) ? input.participantIds : null;
    const range = asRecord(result.range);
    if (!ids || !ids.every((id) => typeof id === "string") || !Array.isArray(result.assigned) ||
        !Number.isSafeInteger(result.skipped) || Number(result.skipped) < 0 ||
        result.assigned.length + Number(result.skipped) !== new Set(ids).size ||
        !range || !Number.isSafeInteger(range.min) || !Number.isSafeInteger(range.max)) return false;
    if (command === "lucky.preassign-range-reviewed") {
      const expected = asRecord(input.expectedRange);
      if (!expected || range.min !== expected.min || range.max !== expected.max) return false;
    }
    const assigned = new Set<string>();
    const numbers = new Set<number>();
    return result.assigned.every((entry: unknown) => {
      const item = asRecord(entry);
      if (!item || typeof item.participantId !== "string" || !ids.includes(item.participantId) ||
          assigned.has(item.participantId) || !Number.isSafeInteger(item.number) ||
          Number(item.number) < Number(range.min) || Number(item.number) > Number(range.max) || numbers.has(Number(item.number))) return false;
      assigned.add(item.participantId); numbers.add(Number(item.number)); return true;
    });
  }
  if (command === "reward.assign") {
    const reward = asRecord(result.reward);
    return Boolean(reward && reward.id === input.id && reward.participantId === input.participantId && reward.status === "READY");
  }
  if (command === "vote.tally") {
    return Array.isArray(result.results) && Number.isSafeInteger(result.totalVotes) && Number(result.totalVotes) >= 0 &&
      typeof result.published === "boolean" && result.results.every((entry: unknown) => {
        const row = asRecord(entry);
        return Boolean(row && typeof row.teamId === "string" && row.teamId && typeof row.name === "string" &&
          Number.isSafeInteger(row.selections) && Number(row.selections) >= 0 && Number.isSafeInteger(row.rank) &&
          Number(row.rank) >= 1 && typeof row.tied === "boolean");
      });
  }
  return false;
}

export function confirmsProgramOperation(command: string, commandId: string, payload: unknown, value: unknown, expectedDrawId?: string): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result || typeof input.id !== "string" || !input.id) return false;
  if (command === "module.status") {
    const module = asRecord(result.module);
    return Boolean(module && module.id === input.id && module.status === input.status && module.published === (input.status !== "DRAFT"));
  }
  if (command === "module.reveal") return result.moduleId === input.id && result.revealed === true;
  if (command === "photo.moderate" || command === "post.moderate") {
    const item = asRecord(result[command === "photo.moderate" ? "photo" : "post"]);
    return Boolean(item && item.id === input.id && item.status === input.status);
  }
  if (command === "draw.run") {
    const draw = asRecord(result.draw);
    const count = input.count;
    return Boolean(draw && draw.id === commandId && draw.published === false && Number.isSafeInteger(count) && Number(count) > 0 &&
      Array.isArray(result.winners) && result.winners.length === count && Array.isArray(draw.winners) &&
      JSON.stringify(result.winners) === JSON.stringify(draw.winners) &&
      result.winners.every((value: unknown) => { const winner = asRecord(value); return Boolean(winner && typeof winner.id === "string" && winner.id && typeof winner.name === "string"); }) &&
      Number.isSafeInteger(result.poolCount) && Number(result.poolCount) >= Number(count) && draw.poolCount === result.poolCount);
  }
  if (command === "draw.publish") {
    const draw = asRecord(result.draw);
    const reviewedId = typeof input.expectedDrawId === "string" ? input.expectedDrawId : expectedDrawId;
    return Boolean(reviewedId && draw && draw.id === reviewedId && draw.published === true);
  }
  return false;
}

export function confirmsClientSave(payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const client = asRecord(asRecord(value)?.client);
  if (!input || !client || typeof client.id !== "string" || !client.id ||
      typeof input.name !== "string" || client.name !== input.name.trim()) return false;
  if (typeof input.id === "string" && input.id && client.id !== input.id.trim()) return false;
  return ["contact", "email", "logoFileId", "docFileId"].every((field) =>
    !Object.prototype.hasOwnProperty.call(input, field) ||
    (typeof input[field] === "string" && client[field] === input[field].trim()));
}

export function confirmsEventCreation(payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const event = asRecord(asRecord(value)?.event);
  if (!input || !event || typeof event.id !== "string" || !event.id ||
      typeof input.name !== "string" || event.name !== input.name.trim() ||
      typeof input.slug !== "string" || event.slug !== input.slug.trim()) return false;
  if (!["date", "start", "end"].every((field) => typeof input[field] !== "string" || event[field] === input[field].trim())) return false;
  if (typeof input.capacity === "number" && event.capacity !== input.capacity) return false;
  if (Object.prototype.hasOwnProperty.call(input, "clientId") && event.clientId !== input.clientId) return false;
  return typeof input.format !== "string" || event.format === input.format;
}

export function confirmsInvitation(payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  const invite = asRecord(result?.invitation);
  return Boolean(input && result && invite && typeof result.token === "string" && result.token &&
    typeof invite.id === "string" && invite.id && typeof input.email === "string" &&
    invite.email === input.email.trim().toLowerCase() && typeof input.name === "string" &&
    invite.name === input.name.trim() && invite.role === input.role && (invite.eventId ?? null) === (input.eventId ?? null));
}

export function confirmsParticipantImport(payload: unknown, value: unknown): boolean {
  const rows = asRecord(payload)?.rows;
  const people = asRecord(value)?.participants;
  if (!Array.isArray(rows) || !rows.length || !Array.isArray(people) || people.length !== rows.length) return false;
  const byPhone = new Map<string, Record<string, unknown>>();
  const ids = new Set<string>();
  for (const value of people) {
    const person = asRecord(value);
    if (!person || typeof person.id !== "string" || !person.id || typeof person.phone !== "string" ||
        ids.has(person.id) || byPhone.has(person.phone)) return false;
    ids.add(person.id);
    byPhone.set(person.phone, person);
  }
  const seen = new Set<string>();
  return rows.every((value) => {
    const row = asRecord(value);
    if (!row || typeof row.name !== "string" || typeof row.phone !== "string") return false;
    const phone = row.phone.replace(/\D/g, "");
    const person = byPhone.get(phone);
    if (!person || seen.has(phone) || person.name !== row.name.trim() ||
        (typeof row.email === "string" && person.email !== row.email.trim()) ||
        (typeof row.company === "string" && person.company !== row.company.trim())) return false;
    seen.add(phone);
    return true;
  });
}

// Content authoring must not turn a partial success body into a new write.
// The response is checked against the actual submitted values, in memory.
export function confirmsContentCommand(command: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result) return false;
  if (command === "notice.save") {
    const root = asRecord(result.notice);
    const notice = input.mode === "draft" ? asRecord(root?.draft) : root;
    if (input.mode === "draft" && (!root || root.version !== Number(input.expectedVersion) + 1 || typeof root.published !== "boolean")) return false;
    return Boolean(notice && root && typeof root.id === "string" && root.id &&
      (typeof input.id !== "string" || root.id === input.id) &&
      typeof input.title === "string" && notice.title === input.title.trim() &&
      typeof input.body === "string" && notice.body === input.body.trim() &&
      (input.mode === "draft" || notice.published === (input.published === true)) && notice.pinned === (input.pinned === true));
  }
  if (command === "program.save") {
    const root = asRecord(result.program);
    const program = input.mode === "draft" ? asRecord(root?.draft) : root;
    if (input.mode === "draft" && (!root || root.version !== Number(input.expectedVersion) + 1 || typeof root.published !== "boolean")) return false;
    if (!program || !root || typeof root.id !== "string" || !root.id ||
        (typeof input.id === "string" && root.id !== input.id) ||
        typeof input.title !== "string" || program.title !== input.title.trim() ||
        (typeof input.date === "string" && input.date && program.date !== input.date.trim()) ||
        typeof input.start !== "string" || program.start !== input.start.trim() ||
        typeof input.end !== "string" || program.end !== input.end.trim() ||
        program.place !== (typeof input.place === "string" ? input.place.trim() : "") ||
        program.description !== (typeof input.description === "string" ? input.description.trim() : "") ||
        (input.mode !== "draft" && program.published !== (input.published === true))) return false;
    if (Object.hasOwn(input, "attachment")) {
      if (input.attachment === null) return program.attachment == null;
      return asRecord(program.attachment)?.fileId === asRecord(input.attachment)?.fileId &&
        typeof asRecord(input.attachment)?.fileId === "string";
    }
    return true;
  }
  if (["notice.publish", "program.publish", "venue.publish", "notice.publish-reviewed", "program.publish-reviewed", "venue.publish-reviewed"].includes(command)) {
    const kind = command.split(".")[0];
    if (command.endsWith("-reviewed")) {
      const expected = asRecord(input.expectedDestinations);
      const actual = asRecord(result.reviewedDestinations);
      const keys = kind === "notice" ? ["slug", "public", "home", "screen"] : ["slug", "public"];
      if (!expected || !actual || Object.keys(expected).length !== keys.length || Object.keys(actual).length !== keys.length ||
          keys.some(key => !Object.hasOwn(expected, key) || !Object.hasOwn(actual, key) || expected[key] !== actual[key]) ||
          typeof expected.slug !== "string" || !expected.slug || expected.slug.length > 120 ||
          typeof expected.public !== "boolean" || (kind === "notice" &&
            (typeof expected.home !== "boolean" || !["off", "available", "selected"].includes(String(expected.screen))))) return false;
    }
    const saved = asRecord(result[kind]);
    if (!saved || !Number.isSafeInteger(input.expectedVersion) || saved.version !== Number(input.expectedVersion) + 1 ||
        (kind !== "venue" && (saved.id !== input.id || typeof input.published !== "boolean" || saved.published !== input.published))) return false;
    const stringKeys = kind === "notice" ? ["title", "body"] : kind === "program" ? ["title", "date", "start", "end", "place", "description"] : ["name", "address", "directions", "contact", "description"];
    if (stringKeys.some(key => typeof saved[key] !== "string")) return false;
    if (kind === "notice" && typeof saved.pinned !== "boolean") return false;
    if (input.published === false) return true;
    const draft = asRecord(saved.draft);
    if (!draft || stringKeys.some(key => saved[key] !== draft[key])) return false;
    if (kind === "notice") return draft.pinned === saved.pinned;
    const asset = kind === "program" ? "attachment" : "map";
    if (draft[asset] == null) return saved[asset] == null;
    const before = asRecord(draft[asset]), after = asRecord(saved[asset]);
    if (!before || !after) return false;
    if (kind === "program") return typeof before.fileId === "string" && before.fileId === after.fileId;
    return typeof before.alt === "string" && before.alt === after.alt &&
      typeof asRecord(before.image)?.fileId === "string" && asRecord(before.image)?.fileId === asRecord(after.image)?.fileId;
  }
  if (command === "notice.delete" || command === "program.delete") return result.ok === true;
  if (command === "display.set") {
    const display = asRecord(result.display);
    return Boolean(display && display.type === input.type &&
      (typeof input.noticeId !== "string" || display.noticeId === input.noticeId) &&
      (typeof input.moduleId !== "string" || display.moduleId === input.moduleId) &&
      (typeof input.drawId !== "string" || display.drawId === input.drawId));
  }
  if (command === "venue.save") {
    const root = asRecord(result.venue);
    const venue = input.mode === "draft" ? asRecord(root?.draft) : root;
    if (input.mode === "draft" && (!root || root.version !== Number(input.expectedVersion) + 1)) return false;
    if (!venue || ["name", "address", "directions", "contact", "description"].some((key) =>
      typeof input[key] !== "string" || venue[key] !== (input[key] as string).trim())) return false;
    if (!Object.hasOwn(input, "map")) return true;
    if (input.map === null) return venue.map == null;
    const inputMap = asRecord(input.map);
    const savedMap = asRecord(venue.map);
    return Boolean(inputMap && savedMap && typeof inputMap.alt === "string" && savedMap.alt === inputMap.alt.trim() &&
      typeof asRecord(inputMap.image)?.fileId === "string" && asRecord(savedMap.image)?.fileId === asRecord(inputMap.image)?.fileId);
  }
  return false;
}

export function confirmsReportCommand(command: string, commandId: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const report = asRecord(asRecord(value)?.report);
  if (!input || !report || typeof report.id !== "string" || !report.id) return false;
  if (input.expectedAttendance !== undefined && (command === "report.create" || command === "report.successor" && input.source === "current")) {
    const expected = asRecord(input.expectedAttendance);
    const metrics = asRecord(asRecord(report.snapshot)?.metrics);
    if (!expected || !metrics || ["total", "approved", "checked", "inside"].some(key =>
      !Number.isSafeInteger(expected[key]) || expected[key] !== metrics[key])) return false;
  }
  if (command === "report.publish") return report.id === input.id && report.status === "PUBLISHED" &&
    (input.expectedVersion === undefined || Number(report.version) === input.expectedVersion);
  if (command === "report.successor") return report.id === commandId && report.parentId === input.id && report.status === "DRAFT" && Boolean(asRecord(report.snapshot));
  if (command !== "report.create" && command !== "report.update") return false;
  if (command === "report.update" && typeof input.expectedVersion === "number" &&
      Number(report.version) !== input.expectedVersion + 1) return false;
  if (report.id !== (command === "report.create" ? commandId : input.id) || report.status !== "DRAFT" ||
      typeof input.title !== "string" || report.title !== input.title.trim() ||
      typeof input.subtitle !== "string" || report.subtitle !== input.subtitle.trim() ||
      typeof input.coverNote !== "string" || report.coverNote !== input.coverNote.trim() ||
      typeof input.summary !== "string" || report.summary !== input.summary.trim() ||
      typeof input.color !== "string" || report.color !== input.color.toUpperCase() ||
      !Array.isArray(input.sections) || !Array.isArray(report.sections) ||
      JSON.stringify(input.sections) !== JSON.stringify(report.sections)) return false;
  return command !== "report.create" || Boolean(asRecord(report.snapshot));
}

export function confirmsAttendeePageCommand(command: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result || !Number.isSafeInteger(input.expectedDraftVersion) || Number(input.expectedDraftVersion) < 0) return false;
  const expected = Number(input.expectedDraftVersion);
  if (command === "attendee.page.publish" || command === "attendee.page.publish-reviewed") {
    if (command === "attendee.page.publish-reviewed") {
      const reviewed = asRecord(input.expectedDestinations), confirmed = asRecord(result.reviewedDestinations);
      const published = asRecord(result.published);
      const style = asRecord(published?.homeStyle), menus = asRecord(published?.homeMenus);
      if (!reviewed || !confirmed || typeof reviewed.slug !== "string" || !reviewed.slug || typeof reviewed.public !== "boolean" ||
          confirmed.slug !== reviewed.slug || confirmed.public !== reviewed.public || !published ||
          typeof published.intro !== "string" || typeof published.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(published.accent) ||
          !["showAnnouncements", "showSchedule", "showVenue", "showPrograms"].every(key => typeof published[key] === "boolean") ||
          !style || typeof style.backgroundColor !== "string" || !/^#[0-9a-f]{6}$/i.test(style.backgroundColor) ||
          !(style.heroTitle === null || typeof style.heroTitle === "string") || typeof style.heroSubtitle !== "string" ||
          !["centered", "bottom-overlay", "image-only"].includes(String(style.heroLayout)) ||
          !["standard", "large"].includes(String(style.titleScale)) || !["center", "top", "bottom"].includes(String(style.imageFocus)) ||
          !["left", "center", "right"].includes(String(style.textAlign)) || !["light", "dark"].includes(String(style.textTone)) ||
          !["none", "soft", "strong"].includes(String(style.overlay)) || !menus ||
          !["order", "hidden", "programs"].every(key => Array.isArray(menus[key]) && (menus[key] as unknown[]).every(value => typeof value === "string")) ||
          !Object.hasOwn(published, "keyvisual") || !(published.keyvisual === null || asRecord(published.keyvisual))) return false;
    }
    return result.publishedVersion === expected && result.draftVersion === expected && Boolean(asRecord(result.published));
  }
  if (command !== "attendee.page.save" || result.draftVersion !== expected + 1) return false;
  const draft = asRecord(result.draft);
  if (!draft || typeof input.intro !== "string" || draft.intro !== input.intro.trim().slice(0, 160) ||
      typeof input.accent !== "string" || draft.accent !== input.accent.toUpperCase()) return false;
  for (const key of ["showAnnouncements", "showSchedule", "showVenue", "showPrograms"]) {
    if (draft[key] !== (input[key] === true)) return false;
  }
  if (Object.hasOwn(input, "homeStyle")) {
    const supplied = asRecord(input.homeStyle), saved = asRecord(draft.homeStyle);
    if (!supplied || !saved) return false;
    for (const [key, value] of Object.entries(supplied)) {
      if (saved[key] !== (/color/i.test(key) && typeof value === "string" ? value.trim().toUpperCase() : value)) return false;
    }
  }
  if (Object.hasOwn(input, "homeMenus")) {
    const supplied = asRecord(input.homeMenus), saved = asRecord(draft.homeMenus);
    if (!supplied || !saved || !["order", "hidden", "programs"].every((key) =>
      Array.isArray(supplied[key]) && Array.isArray(saved[key]) && JSON.stringify(supplied[key]) === JSON.stringify(saved[key]))) return false;
  }
  for (const [key, clear] of [["keyvisual", "clearKeyvisual"], ["logo", "clearLogo"]]) {
    if (input[clear] === true && draft[key] !== null) return false;
    if (Object.hasOwn(input, key) && input[key] !== null && asRecord(input[key])?.fileId !== asRecord(draft[key])?.fileId) return false;
    if (Object.hasOwn(input, key) && input[key] === null && draft[key] !== null) return false;
  }
  return true;
}

export function confirmsSettingsCommand(command: string, eventId: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result) return false;
  if (command === "event.update" || command === "event.basics.save") {
    const event = asRecord(result.event);
    if (!event || event.id !== eventId) return false;
    const fields: Array<[string, number]> = [["name", 100], ["slug", 50], ["date", 10], ["start", 5], ["end", 5]];
    if (!fields.every(([key, max]) => typeof input[key] === "string" && event[key] === (input[key] as string).trim().slice(0, max))) return false;
    if (typeof input.capacity !== "number" || event.capacity !== input.capacity) return false;
    if (typeof input.clientId === "string" && input.clientId && event.clientId !== input.clientId) return false;
    if (typeof input.format === "string" && (input.format ? event.format !== input.format : event.format != null)) return false;
    if (command === "event.basics.save") {
      const expected = asRecord(input.expectedBasics);
      if (!expected || typeof expected.date !== "string" || result.ticketPolicyVersion !== 1 ||
          !Object.hasOwn(result, "ticketImpact")) return false;
      const impact = result.ticketImpact;
      if (impact === null) {
        if (typeof input.date !== "string" || input.date > expected.date || !/^\d{4}-\d{2}-\d{2}$/.test(expected.date)) return false;
      } else {
        const counts = asRecord(impact);
        if (!counts || !Number.isSafeInteger(counts.extended) || Number(counts.extended) < 0 ||
            !Number.isSafeInteger(counts.review) || Number(counts.review) < 0) return false;
      }
    }
    // Workspace price and policy flags are not in this response. The receipt
    // proves the transaction; the caller reloads those values from bootstrap.
    return true;
  }
  if (command === "event.features") return Array.isArray(input.features) && Array.isArray(result.features) &&
    input.features.every((item) => typeof item === "string") && JSON.stringify([...new Set(input.features)]) === JSON.stringify(result.features);
  if (command === "form.publish") {
    if (!Number.isSafeInteger(result.publishedVersion) || Number(result.publishedVersion) <= 0) return false;
    // Old retained requests predate consent review metadata; preserve their
    // original proof rule for replaying their existing receipts.
    if (input.expectedConsentVersion === undefined && input.expectedConsentText === undefined) {
      return input.expectedFormVersion === undefined || result.publishedVersion === (Number(input.expectedFormVersion) || 1);
    }
    if (!Number.isSafeInteger(input.expectedFormVersion) || Number(input.expectedFormVersion) < 0 ||
        !Number.isSafeInteger(input.expectedConsentVersion) || Number(input.expectedConsentVersion) < 1 ||
        typeof input.expectedConsentText !== "string" ||
        result.reviewedFormVersion !== input.expectedFormVersion || result.reviewedConsentVersion !== input.expectedConsentVersion ||
        !Number.isSafeInteger(result.reviewedPublishedVersion) || Number(result.reviewedPublishedVersion) < 0 ||
        typeof result.reviewedConsentText !== "string" || typeof result.consentText !== "string" ||
        typeof result.consentChanged !== "boolean") return false;
    const priorText = input.expectedConsentText.trim().slice(0, 3000);
    if (result.reviewedConsentText !== priorText) return false;
    const targetText = input.consentText === undefined ? priorText :
      typeof input.consentText === "string" ? input.consentText.trim().slice(0, 3000) : null;
    if (targetText === null || result.consentText !== targetText) return false;
    const changed = targetText !== priorText;
    const expectedVersion = changed
      ? Math.max(Number(input.expectedFormVersion), Number(result.reviewedPublishedVersion)) + 1
      : Number(input.expectedFormVersion) || 1;
    return result.consentChanged === changed && result.publishedVersion === expectedVersion &&
      result.consentVersion === Number(input.expectedConsentVersion) + (changed ? 1 : 0);
  }
  if (command === "form.close") return result.registrationOpen === false;
  if (command === "contact.save") {
    // 서버가 저장한 값(응답의 participantContact 또는 workspace.participantContact)이 있으면 요청과 같아야 한다.
    // 응답이 값을 싣지 않으면 요청 영수증이 확인된 것으로 본다(값은 다시 불러온 bootstrap이 확정한다).
    if (typeof input.participantContact !== "string") return false;
    const wanted = input.participantContact.replace(/\s+/g, " ").trim().slice(0, 200);
    const nested = asRecord(result.workspace);
    const stored = typeof result.participantContact === "string" ? result.participantContact
      : typeof nested?.participantContact === "string" ? nested.participantContact : null;
    return stored === null || stored === wanted;
  }
  if (command === "event.stage") {
    const event = asRecord(result.event);
    return Boolean(event && event.id === eventId && typeof input.stage === "string" && event.stage === input.stage.trim().toUpperCase());
  }
  return false;
}

export function confirmsFieldCommand(command: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result || typeof input.id !== "string" || !input.id) return false;
  if (command === "field.save") {
    const field = asRecord(result.field);
    return Boolean(field && field.id === input.id && typeof input.label === "string" && field.label === input.label.trim() &&
      field.type === input.type && field.required === input.required && Array.isArray(input.options) && Array.isArray(field.options) &&
      JSON.stringify(field.options) === JSON.stringify(input.type === "select" ? input.options : []));
  }
  if (command === "field.move" || command === "field.delete") {
    return Array.isArray(input.expectedOrder) && Array.isArray(result.fields) &&
      JSON.stringify(result.fields.map((value: unknown) => asRecord(value)?.id)) === JSON.stringify(input.expectedOrder);
  }
  return false;
}

export function confirmsOperationsCommand(command: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result) return false;
  if (command === "display.set") return confirmsContentCommand(command, input, result);
  if (command === "desk.save" || command === "desk.set-open") {
    const desk = asRecord(result.desk);
    if (!desk || typeof desk.id !== "string" || !desk.id ||
        (typeof input.id === "string" && desk.id !== input.id)) return false;
    if (command === "desk.set-open") {
      if (typeof input.open !== "boolean" || desk.open !== input.open) return false;
      if (input.expectedDesk === undefined) return true;
      const expected = asRecord(input.expectedDesk);
      if (!expected || !(typeof expected.name === "string" || expected.name === null) ||
          !(typeof expected.action === "string" || expected.action === null) || typeof expected.mode !== "string" ||
          typeof expected.open !== "boolean") return false;
      return Object.hasOwn(desk, "name") && Object.hasOwn(desk, "action") && Object.hasOwn(desk, "mode") &&
        desk.name === expected.name && desk.action === expected.action && desk.mode === expected.mode;
    }
    const expectedDesk = asRecord(input.expectedDesk);
    if (input.expectedDesk !== undefined) {
      if (!expectedDesk || !(typeof expectedDesk.action === "string" || expectedDesk.action === null) || typeof expectedDesk.open !== "boolean" ||
          typeof input.action !== "string") return false;
      const targetOpen = expectedDesk.action !== input.action.trim().toUpperCase() && input.keepOpen !== true ? false : expectedDesk.open;
      if (desk.open !== targetOpen) return false;
    }
    return typeof input.name === "string" && desk.name === input.name.trim().slice(0, 60) &&
      typeof input.action === "string" && desk.action === input.action.trim().toUpperCase() &&
      typeof input.mode === "string" && desk.mode === input.mode.trim().toLowerCase();
  }
  if (command === "booth.save") {
    const booth = asRecord(result.booth);
    if (input.expectedBooth !== undefined) {
      const expected = asRecord(input.expectedBooth);
      if (!booth || !expected || typeof expected.startsAt !== "string" || typeof expected.endsAt !== "string" ||
          !Object.hasOwn(booth, "startsAt") || !Object.hasOwn(booth, "endsAt") ||
          !(typeof booth.startsAt === "string" || booth.startsAt === null) ||
          !(typeof booth.endsAt === "string" || booth.endsAt === null)) return false;
      const sameTime = (a: string, b: string) => {
        if (a === b) return true;
        const first = boothScheduleTime(a), second = boothScheduleTime(b);
        return first !== null && second !== null && Number.isFinite(first) && Number.isFinite(second) && first === second;
      };
      // Omitted times preserve the reviewed value; explicitly supplied
      // times, including an empty string, are changes to verify instead.
      const targetTime = (key: "startsAt" | "endsAt") => Object.hasOwn(input, key)
        ? String(input[key] ?? "").trim().slice(0, 64) : expected[key] as string;
      if (!sameTime(targetTime("startsAt"), booth.startsAt ?? "") || !sameTime(targetTime("endsAt"), booth.endsAt ?? "")) return false;
    }
    return Boolean(booth && typeof booth.id === "string" && booth.id &&
      (typeof input.id !== "string" || booth.id === input.id) &&
      typeof input.name === "string" && booth.name === input.name.trim().slice(0, 60) &&
      typeof input.zone === "string" && booth.zone === input.zone.trim().slice(0, 120) &&
      typeof input.status === "string" && booth.status === input.status.trim().toUpperCase() &&
      Number.isInteger(input.capacity) && booth.capacity === input.capacity &&
      Number.isInteger(input.limit) && booth.limit === input.limit);
  }
  if (command === "staff.assign") {
    const assignment = asRecord(result.assignment);
    return Boolean(assignment && typeof assignment.id === "string" && assignment.id &&
      assignment.accountId === input.accountId && assignment.type === input.type && assignment.targetId === input.targetId);
  }
  if (command === "staff.unassign") return result.ok === true && typeof input.id === "string";
  if (command === "booth.mode") return result.stampMode === input.mode && input.acknowledge === true;
  if (command === "booth.mode-reviewed") return result.stampMode === input.mode && result.previousMode === input.expectedMode && input.acknowledge === true;
  if (["booth.map.save", "booth.map.publish", "booth.map.unpublish"].includes(command)) {
    const map = asRecord(result.boothMap);
    if (!map) return false;
    if (command === "booth.map.unpublish") return map.published === null;
    const saved = asRecord(command === "booth.map.save" ? map.draft : map.published);
    if (!saved || !Number.isSafeInteger(input.expectedDraftVersion) ||
        saved.version !== Number(input.expectedDraftVersion) + (command === "booth.map.save" ? 1 : 0) ||
        typeof asRecord(saved.image)?.fileId !== "string" || !Array.isArray(saved.points)) return false;
    if (command === "booth.map.publish") return true;
    return asRecord(saved.image)?.fileId === input.fileId && Array.isArray(input.points) &&
      saved.points.length === input.points.length && input.points.every((value: unknown, index: number) => {
        const requested = asRecord(value), actual = asRecord((saved.points as unknown[])[index]);
        return requested && actual && requested.boothId === actual.boothId && requested.x === actual.x && requested.y === actual.y;
      });
  }
  return false;
}

export function confirmsQuestionManagement(payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const question = asRecord(asRecord(value)?.question);
  return Boolean(input && question && typeof input.id === "string" && question.id === input.id &&
    typeof input.answer === "string" && question.answer === input.answer.trim() &&
    typeof input.expectedText === "string" && question.text === input.expectedText &&
    question.approved === (input.approved === true));
}

export function confirmsModuleSave(payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const module = asRecord(asRecord(value)?.module);
  if (!input || !module || typeof module.id !== "string" || !module.id ||
      (typeof input.id === "string" && module.id !== input.id) ||
      typeof input.title !== "string" || module.title !== input.title.trim() ||
      typeof input.type !== "string" || module.type !== input.type.trim().toLowerCase()) return false;
  for (const key of ["options", "questions"]) {
    if (!Object.hasOwn(input, key)) continue;
    if (!Array.isArray(input[key]) || !Array.isArray(module[key])) return false;
    const expected = (input[key] as unknown[]).map((item) => typeof item === "string" ? item.trim().slice(0, 200) : "").filter(Boolean);
    if (JSON.stringify(module[key]) !== JSON.stringify(expected)) return false;
  }
  return !Object.hasOwn(input, "answer") || (typeof input.answer === "string" && module.answer === input.answer.trim());
}

export function confirmsEvidenceCommand(command: string, commandId: string, payload: unknown, value: unknown): boolean {
  const input = asRecord(payload);
  const result = asRecord(value);
  if (!input || !result) return false;
  if (command === "evidence.photo.remove") return result.ok === true && result.id === input.id;
  const photo = asRecord(result.photo);
  if (!photo || typeof photo.id !== "string" || photo.section !== input.section) return false;
  if (command === "evidence.photo.move") return photo.id === input.id;
  if (command === "evidence.photo.add") return photo.id === commandId &&
    typeof asRecord(input.image)?.fileId === "string" && asRecord(photo.image)?.fileId === asRecord(input.image)?.fileId;
  return false;
}

function confirmsReceiptBody(pointer: OperatorReceiptPointer, body: BodyInit | null | undefined, value: unknown, path: string): boolean {
  const result = asRecord(value);
  if (!result || !Object.keys(result).length) return false;
  if (pointer.command === "invitation.create") {
    if (typeof body !== "string") return false;
    try { return confirmsInvitation(JSON.parse(body), result); } catch { return false; }
  }
  if (pointer.command === "account.password-reset") {
    const match = /^\/api\/auth\/accounts\/([^/]+)\/password$/.exec(path);
    if (!match) return false;
    try { return asRecord(result.account)?.id === decodeURIComponent(match[1]); } catch { return false; }
  }
  if (pointer.command === "member.assign") {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(JSON.parse(body));
      if (input?.enabled === false) return result.membership === null;
      const membership = asRecord(result.membership);
      const event = /^\/api\/events\/([^/]+)\/members$/.exec(path);
      return Boolean(input && membership && typeof input.accountId === "string" && membership.accountId === input.accountId &&
        event && membership.eventId === decodeURIComponent(event[1]) && Array.isArray(input.write) && Array.isArray(membership.write) &&
        JSON.stringify([...input.write].sort()) === JSON.stringify([...membership.write].sort()));
    } catch { return false; }
  }
  if (pointer.command === "client.save" || pointer.command === "event.create" || pointer.command === "event.duplicate") {
    if (typeof body !== "string") return false;
    try {
      const payload = JSON.parse(body);
      return pointer.command === "client.save" ? confirmsClientSave(payload, result) : confirmsEventCreation(payload, result);
    } catch { return false; }
  }
  if (["notice.save", "notice.publish", "notice.publish-reviewed", "notice.delete", "program.save", "program.publish", "program.publish-reviewed", "program.delete", "venue.save", "venue.publish", "venue.publish-reviewed", "display.set"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try { return confirmsContentCommand(pointer.command, asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (["report.create", "report.update", "report.publish", "report.successor"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try { return confirmsReportCommand(pointer.command, pointer.commandId, asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (["question.manage", "question.edit.approve", "question.edit.reject", "response.grade"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      if (!input) return false;
      if (pointer.command === "question.manage") return confirmsQuestionManagement(input, result);
      if (pointer.command === "response.grade") return result.responseId === input.responseId && Number.isSafeInteger(result.gradeVersion) && Number(result.gradeVersion) > Number(input.expectedGradeVersion);
      const question = asRecord(result.question);
      if (!question || question.id !== input.id || question.approved !== true || question.pendingEdit) return false;
      if (pointer.command === "question.edit.approve") return question.text === input.expectedNewText;
      const rejection = asRecord(question.editRejection);
      return Boolean(question.text === input.expectedText && question.answer === input.expectedAnswer && rejection &&
        rejection.id === input.expectedEditId && rejection.text === input.expectedNewText && rejection.reason === input.reason);
    } catch { return false; }
  }
  if (pointer.command === "module.save") {
    if (typeof body !== "string") return false;
    try { return confirmsModuleSave(asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (["evidence.photo.add", "evidence.photo.move", "evidence.photo.remove"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try { return confirmsEvidenceCommand(pointer.command, pointer.commandId, asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (["desk.save", "desk.set-open", "booth.save", "booth.mode", "booth.mode-reviewed", "booth.map.save", "booth.map.publish", "booth.map.unpublish", "staff.assign", "staff.unassign"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try { return confirmsOperationsCommand(pointer.command, asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (["event.update", "event.basics.save", "event.features", "form.publish", "form.close", "event.stage", "contact.save"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    const match = /^\/api\/events\/([^/]+)\/commands$/.exec(path);
    if (!match) return false;
    try { return confirmsSettingsCommand(pointer.command, decodeURIComponent(match[1]), asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (["field.save", "field.move", "field.delete"].includes(pointer.command)) {
    // The field editor validates the command response and then refreshes the
    // draft before releasing this pointer. A failed refresh must survive reload.
    return false;
  }
  // The participant projection intentionally contains only published answer
  // fields. The editing screen confirms draft-only answers in a fresh scoped
  // bootstrap before acknowledging its receipt.
  // 개인정보 삭제의 응답은 개인정보 없이 { participant: { id, erased: true } }만 싣는다.
  if (pointer.command === "participant.erase") {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      const erased = asRecord(result.participant);
      return Boolean(input && erased && typeof input.id === "string" && erased.id === input.id && erased.erased === true);
    } catch { return false; }
  }
  if (pointer.command === "participant.update") return false;
  // The reward desk keeps its pointer until it has refreshed the current
  // list. A plausible or incomplete response alone must not release a lock.
  if (["reward.fulfill", "reward.cancel"].includes(pointer.command)) return false;
  if (["attendee.page.save", "attendee.page.publish", "attendee.page.publish-reviewed"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    // Publishing carries only a version; the editor owns the submitted
    // draft snapshot and must compare the returned content before it can
    // explicitly acknowledge the receipt.
    if (pointer.command === "attendee.page.publish" || pointer.command === "attendee.page.publish-reviewed") return false;
    try { return confirmsAttendeePageCommand(pointer.command, asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (pointer.command === "template.save") {
    if (typeof body !== "string") return false;
    try { return confirmsTemplateSave(asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  // The library owns archive/restore recovery until its list is refreshed.
  if (pointer.command === "template.archive") return false;
  if (pointer.command === "ticket.reissue-reviewed") {
    if (typeof body !== "string" || !pointer.eventId) return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      const participant = asRecord(result.participant);
      const prefix = `ET:${pointer.eventId}:T-`;
      const ticket = participant?.ticket;
      if (!input || !participant || typeof input.id !== "string" || participant.id !== input.id ||
          !Number.isSafeInteger(input.expectedTicketRevision) || Number(input.expectedTicketRevision) < 0 ||
          result.ticketRevision !== Number(input.expectedTicketRevision) + 1 || typeof ticket !== "string" ||
          !ticket.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(ticket.slice(prefix.length))) return false;
      if (typeof result.ticketPublicBase === "string") {
        const base = new URL(result.ticketPublicBase);
        if (!/^https?:$/.test(base.protocol) || base.username || base.password || base.search || base.hash) return false;
      }
      return true;
    } catch { return false; }
  }
  if (["message.create", "message.create-reviewed", "message.create-charset-reviewed", "message.record-provider-check", "message.retry", "message.retry-charset-reviewed", "message.cancel", "message.sync"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      const message = asRecord(result.message);
      if (!input || !message || typeof message.id !== "string" || !message.id ||
          typeof message.status !== "string" || !message.status) return false;
      if (pointer.command === "message.create") return confirmsMessageCreate(pointer.commandId, input, result);
      if (pointer.command === "message.create-reviewed") return confirmsReviewedMessageCreate(pointer.commandId, input, result);
      if (pointer.command === "message.create-charset-reviewed") return confirmsCharsetReviewedMessageCreate(pointer.commandId, input, result);
      if (pointer.command === "message.retry-charset-reviewed") return result.messageCharsetPolicyVersion === 1 && message.id === input.id;
      if (pointer.command === "message.record-provider-check") return confirmsProviderCheck(input, result);
      if (pointer.command === "message.sync" && !Object.hasOwn(input, "id")) return true;
      return message.id === input.id && (pointer.command !== "message.cancel" || message.status === "CANCELLED");
    } catch { return false; }
  }
  // Cancellation is acknowledged by the roster only after its authoritative
  // refresh; even a successful command body cannot prove the displayed list.
  if (["participant.bulk-cancel", "participant.resolve-cancellation-conflict", "check.reviewed-exit", "check.reconcile"].includes(pointer.command)) return false;
  if (["participant.create", "participant.import", "participant.status", "group.assign", "reward.create"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      if (!input) return false;
      if (pointer.command === "participant.create") {
        const person = asRecord(result.participant);
        return Boolean(person && typeof person.id === "string" && person.id && typeof input.name === "string" &&
          person.name === input.name.trim() && typeof input.phone === "string" && person.phone === input.phone.replace(/\D/g, ""));
      }
      if (pointer.command === "participant.import") {
        return confirmsParticipantImport(input, result);
      }
      if (pointer.command === "participant.status") {
        // Bulk cancellation keeps its pointer until the roster itself has
        // refreshed; the command response alone does not prove that display.
        if (input.requireRosterRefresh === true) return false;
        const ids = Array.isArray(input.ids) ? input.ids : [input.id];
        const participants = result.participants;
        return typeof input.status === "string" && ids.length > 0 && ids.every((id) => typeof id === "string") &&
          Array.isArray(participants) && participants.length === ids.length && ids.every((id) =>
            participants.some((entry: unknown) => { const person = asRecord(entry); return person?.id === id && person.status === (input.status as string).trim().toUpperCase(); }));
      }
      if (pointer.command === "group.assign") {
        return typeof input.group === "string" && result.group === input.group.trim() && Array.isArray(input.ids) &&
          Array.isArray(result.participantIds) && JSON.stringify([...input.ids].sort()) === JSON.stringify([...result.participantIds].sort());
      }
      const reward = asRecord(result.reward);
      return Boolean(reward && reward.id === pointer.commandId && reward.participantId === input.participantId &&
        typeof input.name === "string" && reward.name === input.name.trim() && reward.method === input.method);
    } catch { return false; }
  }
  if (pointer.command === "check.scan") {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      // A manual roster selection must also match the selected person and
      // desk direction. Only the staff screen holds that direction snapshot,
      // so it acknowledges this pointer after validating and refreshing.
      if (typeof input?.participantId === "string" && input.participantId) return false;
      if (!input || (Object.hasOwn(input, "expectedAction") && result.action !== input.expectedAction)) return false;
    } catch { return false; }
    return result.checkId === pointer.commandId && typeof result.name === "string" &&
      typeof result.id === "string" && Boolean(result.id) && (result.action === "IN" || result.action === "OUT");
  }
  if (pointer.command === "booth.visit") {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      const boothId = input?.boothId || input?.targetId;
      return typeof boothId === "string" && Boolean(boothId) && result.boothId === boothId.trim().slice(0, 120) &&
        result.visitId === pointer.commandId && typeof result.participantId === "string" && Boolean(result.participantId) &&
        typeof result.name === "string" && typeof result.booth === "string";
    } catch { return false; }
  }
  if (pointer.command === "check.correct") {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      const check = asRecord(result.check);
      return typeof input?.id === "string" && check?.id === input.id && check.corrected === true && asRecord(check.correction)?.id === pointer.commandId;
    } catch { return false; }
  }
  if (pointer.command === "reward.collect" || pointer.command === "reward.lookup") {
    if (typeof body !== "string") return false;
    try {
      const input = asRecord(asRecord(JSON.parse(body))?.payload);
      if (!input) return false;
      if (pointer.command === "reward.collect") {
        const reward = asRecord(result.reward);
        return result.rewardRequestVersion === 1 && typeof input.id === "string" && reward?.id === input.id && reward.status === "RECEIVED" &&
          typeof input.expectedParticipantId === "string" && Boolean(input.expectedParticipantId) && reward.participantId === input.expectedParticipantId;
      }
      const participant = asRecord(result.participant);
      const seen = new Set<string>();
      return result.rewardRequestVersion === 1 && result.rewardVerificationId === pointer.commandId &&
        typeof participant?.id === "string" && Boolean(participant.id) && typeof participant.name === "string" && Boolean(participant.name) && Array.isArray(result.rewards) &&
        result.rewards.every((value: unknown) => { const row = asRecord(value); if (typeof row?.id !== "string" || !row.id || seen.has(row.id) || typeof row.name !== "string" || !row.name || typeof row.status !== "string" || typeof row.method !== "string") return false; seen.add(row.id); return true; }) &&
        (typeof input.participantId !== "string" || participant.id === input.participantId);
    } catch { return false; }
  }
  if (["team.save", "draw.program.save", "vote.config.save", "vote.tally", "lucky.config.save", "lucky.config.save-reviewed", "lucky.preassign", "lucky.preassign-reviewed", "lucky.preassign-range-reviewed", "roulette.config.save", "roulette.config.save-reviewed", "reward.assign"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try { return confirmsDrawOperation(pointer.command, asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (["module.status", "module.reveal", "draw.run", "draw.publish", "photo.moderate", "post.moderate"].includes(pointer.command)) {
    if (typeof body !== "string") return false;
    try { return confirmsProgramOperation(pointer.command, pointer.commandId, asRecord(JSON.parse(body))?.payload, result); } catch { return false; }
  }
  if (pointer.command !== "draw.program.run") return true;
  if (typeof body !== "string") return false;
  try { return confirmsDrawRun(asRecord(JSON.parse(body))?.payload, result, pointer.commandId); } catch { return false; }
}

// --- module state (one tab, no persistence: reloads re-pin from /auth/me) ---

let pinned: OperatorContext | null = null;
let observed: OperatorContext | null = null;
let changed = false;
let loading = false;
let lastError: string | null = null;
let inFlightWrites = 0;
const uncertain = new Map<string, UncertainEntry>();
// Authentication lifetime is separate from contextGen: a same-user org/version
// recovery may renew attempts, but logout or another user must retire them.
let authGeneration = 0;
let authUserId: string | null = null;
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
    observeAuthUser(text(asRecord(user)?.id));
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
  observeAuthUser(candidate.userId);
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
  if (
    candidate.organizationId !== pinned.organizationId ||
    candidate.userId !== pinned.userId ||
    candidate.userId !== authUserId
  ) return false;
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
// - 5xx/408/425/429/network failure: kept as uncertain (may retry explicitly).
// - definitive 4xx (incl. non-context 409s): settled, mapping cleared.
// - context-coded 409: kept, drift marked, shared reads invalidated.
// - Membership revocation: kept? No — revoked means definitively not
//   committed: the mapping clears, and the authoritative /auth/me decides.
export async function replayUncertainAttempt(key: string): Promise<UncertainReplayResult> {
  const entry = uncertain.get(key);
  if (!entry || !entry.attempt) return { status: null, settled: true };
  const targetSensitive = ["participant.bulk-cancel", "participant.resolve-cancellation-conflict", "check.reviewed-exit", "check.reconcile", "event.basics.save", "attendee.page.publish-reviewed", "message.create-reviewed", "message.create-charset-reviewed", "message.retry-charset-reviewed", "message.record-provider-check", "reward.lookup", "reward.collect"].includes(entry.command ?? "");
  const current = pinned;
  if (
    !current || current.organizationId !== entry.organizationId ||
    current.userId !== entry.attempt.userId || !isCurrentAttempt(entry.attempt)
  ) {
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
    const response = await fetchWithDeadline(entry.attempt.url, {
      method: entry.attempt.method,
      headers: entry.attempt.headers,
      body: entry.attempt.body ?? undefined,
    });
    requireCurrentAttempt(entry.attempt);
    const contextDenied = response.status === 409 && (await peekContextCode(response));
    requireCurrentAttempt(entry.attempt);
    if (contextDenied) {
      markContextChanged();
      kickRevalidation();
      return { status: response.status, settled: false };
    }
    if (!response.ok) {
      if (targetSensitive) {
        // A later rejection cannot disprove a prior committed request.
        // Only named locked guards checked after receipt lookup prove that
        // this particular request did not commit.
        const body = await response.clone().json().catch(() => null) as { code?: unknown; field?: unknown } | null;
        requireCurrentAttempt(entry.attempt);
        if (!(response.status === 409 && ((entry.command === "participant.bulk-cancel" && body?.code === "CANCELLATION_REVIEW_CHANGED") ||
            (entry.command === "participant.resolve-cancellation-conflict" && ["CANCELLATION_CONFLICT_REVIEW_CHANGED", "CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE"].includes(String(body?.code ?? ""))) ||
            (entry.command === "check.reconcile" && body?.code === "ATTENDANCE_RECONCILIATION_CHANGED") ||
            (entry.command === "event.basics.save" && body?.code === "EVENT_BASICS_CHANGED") ||
            (entry.command === "attendee.page.publish-reviewed" && (body?.code === "PAGE_PUBLICATION_CONTEXT_CHANGED" || body?.field === "expectedDraftVersion")) ||
            (["message.create-reviewed", "message.create-charset-reviewed"].includes(entry.command ?? "") && body?.field === "expectedRecipientVersions") ||
            (entry.command === "message.record-provider-check" && body?.code === "PROVIDER_CHECK_CHANGED")))) {
          return { status: response.status, settled: false };
        }
      }
      const membershipDenied = (response.status === 403 || response.status === 409) &&
        (await peekMembershipCode(response));
      requireCurrentAttempt(entry.attempt);
      if (membershipDenied) {
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
      requireCurrentAttempt(entry.attempt);
      if (data && typeof data === "object") {
        if (entry.command === "check.reviewed-exit") {
          try {
            const submitted = typeof entry.attempt.body === "string" ? asRecord(JSON.parse(entry.attempt.body)) : null;
            const payload = asRecord(submitted?.payload), result = asRecord(asRecord(data)?.exitReview);
            if (!payload || !result || result.participantId !== payload.participantId || result.entryId !== payload.entryId ||
                result.exitId !== key || result.action !== "OUT") return { status: response.status, settled: false };
          } catch { return { status: response.status, settled: false }; }
        }
        if (entry.command === "check.reconcile") {
          try {
            const submitted = typeof entry.attempt.body === "string" ? asRecord(JSON.parse(entry.attempt.body)) : null;
            const payload = asRecord(submitted?.payload), result = asRecord(asRecord(data)?.reconciliation);
            if (!payload || !result || result.participantId !== payload.participantId || result.checkId !== payload.checkId ||
                result.id !== key || result.action !== payload.action || result.inside !== (payload.action === "IN") || result.everIn !== true) return { status: response.status, settled: false };
          } catch { return { status: response.status, settled: false }; }
        }
        if (entry.command === "participant.bulk-cancel") {
          try {
            const submitted = typeof entry.attempt.body === "string" ? asRecord(JSON.parse(entry.attempt.body)) : null;
            if (!cancellationProofMatches(submitted?.payload, data)) return { status: response.status, settled: false };
          } catch { return { status: response.status, settled: false }; }
          // The persisted pointer is intentionally separate; the roster must
          // still perform its authoritative refresh before acknowledging it.
        }
        if (entry.command === "participant.resolve-cancellation-conflict") {
          try {
            const submitted = typeof entry.attempt.body === "string" ? asRecord(JSON.parse(entry.attempt.body)) : null;
            const payload = asRecord(submitted?.payload), result = asRecord(asRecord(data)?.review);
            if (!payload || !result || result.participantId !== payload.id || result.resolutionId !== key || result.ticketRevoked !== true) return { status: response.status, settled: false };
          } catch { return { status: response.status, settled: false }; }
        }
        if (entry.command === "attendee.page.publish-reviewed") {
          try {
            const submitted = typeof entry.attempt.body === "string" ? asRecord(JSON.parse(entry.attempt.body)) : null;
            if (!confirmsAttendeePageCommand(entry.command, submitted?.payload, data)) return { status: response.status, settled: false };
          } catch { return { status: response.status, settled: false }; }
        }
        if (entry.command && ["reward.lookup", "reward.collect", "event.basics.save", "message.create-reviewed", "message.create-charset-reviewed", "message.retry-charset-reviewed", "message.record-provider-check"].includes(entry.command)) {
          const pointer: OperatorReceiptPointer = { userId: current.userId, organizationId: entry.organizationId, eventId: null, commandId: key, command: entry.command };
          if (!confirmsReceiptBody(pointer, entry.attempt.body, data, entry.path)) return { status: response.status, settled: false };
        }
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
    if (isCurrentAttempt(entry.attempt)) {
      inFlightWrites = Math.max(0, inFlightWrites - 1);
      emit();
    }
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
  observeAuthUser(candidate.userId);
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
  // Even a visually clean reset retires callbacks from an earlier login.
  authGeneration += 1;
  authUserId = null;
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
  inFlightWrites = 0;
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

function observeAuthUser(userId: string): void {
  if (!userId || userId === authUserId) return;
  authGeneration += 1;
  authUserId = userId;
  uncertain.clear();
  inFlightWrites = 0;
}

function isCurrentAttempt(attempt: FrozenAttempt): boolean {
  return attempt.authGeneration === authGeneration && attempt.userId === authUserId;
}

function requireCurrentAttempt(attempt: FrozenAttempt): void {
  if (!isCurrentAttempt(attempt)) {
    throw contextError("로그인 정보가 바뀐 뒤라 이전 요청을 멈췄습니다. 현재 작업자 정보를 확인하세요.");
  }
}

function rememberUncertain(
  commandId: string | null,
  snapshot: { organizationId: string; organizationName: string; contextVersion: number },
  attempt: FrozenAttempt
): void {
  if (!isCurrentAttempt(attempt)) return;
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
  // 4xx (except 408/425/429 and 409 conflict) proves the server saw and
  // rejected this exact request: nothing was committed, so nothing stays
  // uncertain. 409-without-code is handled separately (sibling attempt).
  return status >= 400 && status < 500 && ![408, 409, 425, 429].includes(status);
}

function resolveUncertain(commandId: string | null, attempt?: FrozenAttempt): void {
  if (attempt && !isCurrentAttempt(attempt)) return;
  if (commandId && uncertain.delete(commandId)) emit();
}

// Called only after a scope-checked status GET confirms the same command.
export function acknowledgeOperatorReceipt(commandId: string): void {
  resolveUncertain(commandId);
}

// Explicitly abandoning a request drops only the local frozen attempt; it
// does not cancel a file or other server-side write that may already exist.
export function abandonOperatorAttempt(commandId: string): void {
  resolveUncertain(commandId);
}

async function peekContextCode(response: Response): Promise<boolean> {
  // No readable verdict means no authoritative rejection; let all parse/read failures escape.
  const data: unknown = await response.clone().json();
  const record = asRecord(data);
  if (!record) return false;
  if (record.code === ORGANIZATION_CONTEXT_CHANGED) return true;
  if (record.errorCode === ORGANIZATION_CONTEXT_CHANGED) return true;
  const nested = asRecord(record.error);
  if (nested && nested.code === ORGANIZATION_CONTEXT_CHANGED) return true;
  return false;
}

async function peekMembershipCode(response: Response): Promise<boolean> {
  // Known server contract only: 403 NO_ORGANIZATION_MEMBERSHIP, identity
  // user body. No other code is inferred here.
  // No readable verdict means no authoritative rejection; let all parse/read failures escape.
  const data: unknown = await response.clone().json();
  const record = asRecord(data);
  if (!record) return false;
  if (record.code === "NO_ORGANIZATION_MEMBERSHIP") return true;
  if (record.errorCode === "NO_ORGANIZATION_MEMBERSHIP") return true;
  const nested = asRecord(record.error);
  if (nested && nested.code === "NO_ORGANIZATION_MEMBERSHIP") return true;
  return false;
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
    // Keep own-validation endpoints and guest payloads untouched, but bound
    // their complete response just like guarded operator writes.
    return fetchWithDeadline(url, init);
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
      (!isCurrentAttempt(prior.attempt) || prior.attempt.userId !== pinned.userId ||
        prior.organizationId !== pinned.organizationId || prior.contextVersion !== pinned.contextVersion)
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
  const receipt = typeof window !== "undefined" ? receiptPointer(path, init?.body, commandId, pinned) : null;
  const receiptPrior = receipt ? beginOperatorReceipt(receipt) : null;
  // Storage can be denied while the in-memory original request survives.
  // A retry is still uncertain even if no persistent pointer could be made.
  const targetSensitiveRetry = (receiptPrior === true || Boolean(commandId && uncertain.has(commandId))) &&
    ["participant.bulk-cancel", "participant.resolve-cancellation-conflict", "check.reviewed-exit", "check.reconcile", "event.basics.save", "attendee.page.publish-reviewed", "message.create-reviewed", "message.create-charset-reviewed", "message.retry-charset-reviewed", "message.record-provider-check", "reward.lookup", "reward.collect", "ticket.reissue-reviewed"].includes(receipt?.command ?? "");
  let forgetReceipt = false;
  let receiptDeferred = false;
  try {
    const response = await fetchWithDeadline(url, { ...init, headers }, () => {
      if (frozenSnapshot) rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
    });
    requireCurrentAttempt(frozenAttempt);
    const contextDenied = response.status === 409 && (await peekContextCode(response));
    requireCurrentAttempt(frozenAttempt);
    if (contextDenied) {
      if (commandId && frozenSnapshot) {
        rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
      }
      markContextChanged();
      kickRevalidation();
      return response;
    }
    if (!response.ok) {
      if (targetSensitiveRetry) {
        const body = await response.clone().json().catch(() => null) as { code?: unknown; field?: unknown } | null;
        requireCurrentAttempt(frozenAttempt);
        if (!(response.status === 409 && ((receipt?.command === "participant.bulk-cancel" && body?.code === "CANCELLATION_REVIEW_CHANGED") ||
            (receipt?.command === "participant.resolve-cancellation-conflict" && ["CANCELLATION_CONFLICT_REVIEW_CHANGED", "CANCELLATION_CONFLICT_REVIEW_UNAVAILABLE"].includes(String(body?.code ?? ""))) ||
            (receipt?.command === "check.reconcile" && body?.code === "ATTENDANCE_RECONCILIATION_CHANGED") ||
            (receipt?.command === "event.basics.save" && body?.code === "EVENT_BASICS_CHANGED") ||
            (receipt?.command === "attendee.page.publish-reviewed" && (body?.code === "PAGE_PUBLICATION_CONTEXT_CHANGED" || body?.field === "expectedDraftVersion")) ||
            (receipt?.command === "ticket.reissue-reviewed" && ["TICKET_RESULT_SUPERSEDED", "TICKET_REVISION_CHANGED", "TICKET_STATUS_CONFLICT"].includes(String(body?.code ?? ""))) ||
            (["message.create-reviewed", "message.create-charset-reviewed"].includes(receipt?.command ?? "") && body?.field === "expectedRecipientVersions") ||
            (receipt?.command === "message.record-provider-check" && body?.code === "PROVIDER_CHECK_CHANGED")))) {
          if (frozenSnapshot) rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
          return response;
        }
      }
      const membershipDenied = (response.status === 403 || response.status === 409) &&
        (await peekMembershipCode(response));
      requireCurrentAttempt(frozenAttempt);
      if (membershipDenied) {
        // Revoked membership with identity body: keep the pinned view and
        // the original status/body intact — revalidate and let authoritative
        // /auth/me decide (observed null + drift + selection banner on
        // no-org). Never a login redirect from here. The rejection itself
        // proves nothing was committed, so no uncertain mapping is kept.
        kickRevalidation();
        resolveUncertain(commandId, frozenAttempt);
        if (receiptPrior === false) forgetReceipt = true;
        return response;
      }
      // A received non-context 409 is an AUTHORITATIVE outcome: the server
      // checks the command receipt before business validation, so the same
      // payload cannot still be an ambiguous network outcome. Clear the
      // mapping, never auto-retry. Theme version conflicts and the invite
      // link-unavailable receipt behave the same — the UI already cleared
      // its own pending slot honestly. Only 5xx/408/425/429/network stay uncertain.
      if (response.status === 409 || isDefinitiveRejection(response.status)) {
        resolveUncertain(commandId, frozenAttempt);
        if (receiptPrior === false) forgetReceipt = true;
        return response;
      }
      if (frozenSnapshot) {
        rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
      }
      return response;
    }
    // An empty or unreadable 2xx body does not prove that the application
    // received a usable result. Retain its pointer for a read-only lookup.
    // A ticket response contains a bearer link that can disappear on reload.
    // The ticket dialog owns its pointer until the operator finishes with
    // the link, including after a successful response or receipt replay.
    if (receipt && receiptPrior !== null && receipt.command !== "ticket.reissue-reviewed") {
      // Never hold the caller's Response hostage to an incomplete clone:
      // publish the pointer after a bounded wait if the body stalls.
      try {
        const clone = response.clone();
        let finished = false;
        const finishReceipt = (forget: boolean) => {
          if (finished) return;
          finished = true;
          window.clearTimeout(timer);
          if (forget && targetSensitiveRetry) resolveUncertain(commandId, frozenAttempt);
          endOperatorReceipt(receipt.commandId, forget);
        };
        const timer = window.setTimeout(() => finishReceipt(false), 5000);
        receiptDeferred = true;
        void clone.json().then((result: unknown) => {
          finishReceipt(confirmsReceiptBody(receipt, init?.body, result, path));
        }).catch(() => finishReceipt(false));
      } catch { /* The finalizer exposes an unreadable result. */ }
    }
    if (!targetSensitiveRetry) resolveUncertain(commandId, frozenAttempt);
    return response;
  } catch (error) {
    // Transport failure: outcome unknown, keep the receipt mapping.
    if (frozenSnapshot) {
      rememberUncertain(commandId, frozenSnapshot, frozenAttempt);
    }
    throw error;
  } finally {
    if (receipt && receiptPrior !== null && !receiptDeferred) endOperatorReceipt(receipt.commandId, forgetReceipt);
    if (isCurrentAttempt(frozenAttempt)) {
      inFlightWrites = Math.max(0, inFlightWrites - 1);
      emit();
    }
  }
}
