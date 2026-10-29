// Fastify route boundary, fifth increment: the scoped console reads.
//
// server.js delegates exactly these requests here, and only in database
// mode — without a database those paths answer 503 on the legacy router,
// exactly like /api/bootstrap:
//
//   GET /api/console/directory          lightweight shell/directory read
//   GET /api/events/:id/bootstrap       single-event detail read
//
// Both are additive: GET /api/bootstrap and GET /api/events keep their
// historical behaviour untouched. Status, body, headers, error messages
// and field names stay identical to the hand-rolled bootstrap path:
// the session check runs first (GET carries no body), unknown shapes and
// anonymous callers answer exactly as before, and cache-control is set to
// no-store only after the session check, as before.
//
// Reads stay membership-gated: an event the caller cannot see answers 404
// ('행사를 찾을 수 없습니다'), the same as an unknown id, so membership
// cannot be probed. Stored membership grants ride through verbatim — an
// omitted grant was stored as ['all'] at assign time, an explicit []
// stays [] (read-only). No new isolation is invented: single-organisation
// reality is kept, and the STAFF projection stays minimal (assigned targets
// only, no tickets, phones, emails, global prizes or reports).
//
// Freshness matches bootstrap: each read runs one REPEATABLE READ, READ
// ONLY transaction (see server/state.js) and every answer carries
// `cache-control: no-store`. The directory never selects
// event_workspaces.payload — venue, pending/message-attention counts and
// the published card color are extracted in SQL as scalars.
//
// Requests whose path cannot be percent-decoded are not delegated at all
// (server.js keeps them on the legacy router, whose branch answers depend
// on request bodies); this app therefore always sees a decodable path.
//
// Like the other server TypeScript modules this runs without a build step
// (Node 24 type stripping) and is verified by `npm run server:typecheck`.

import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { decodedSegment, fail, failureFields } from "./legacy-http.ts";

export type ScopedReadsDeps = {
  /** Session lookup for the cookie the browser already holds. */
  /** Second arg is the raw request: the server wrapper copies the tab org headers onto the account. */
  sessionFromCookie: (cookieHeader: string | undefined, req?: unknown) => Promise<unknown | null>;
  /** Stamps the verified session org + revision on success responses. */
  stampOrgHeaders?: (reply: FastifyReply, account: unknown) => void;
  /** Lightweight directory for the shell and the event home. */
  loadDirectory: (account: unknown) => Promise<{ events?: unknown; activeEventId?: unknown }>;
  /** Single-event detail in the historical `{ state }` bootstrap shape. */
  loadEventBootstrap: (account: unknown, eventId: string) => Promise<unknown>;
  /** Same message rule as server/http.js: only explicit failures echo. */
  failureMessage: (error: unknown, fallback: string) => string;
};

const NOT_FOUND_API = "요청한 API를 찾을 수 없습니다";
const NOT_FOUND_EVENT = "행사를 찾을 수 없습니다";
const LOGIN_REQUIRED = "로그인이 필요합니다";
const NO_DATABASE = "데이터베이스를 사용할 수 없습니다";
const GENERIC_FAILURE = "요청을 처리하지 못했습니다";

/** Which requests this boundary owns; server.js delegates exactly these. */
export function scopedReadsPath(urlPath: string, method: string): boolean {
  if (method !== "GET") return false;
  const parts = urlPath.split("/").filter(Boolean);
  if (parts[0] !== "api") return false;
  if (parts[1] === "console" && parts.length === 3 && parts[2] === "directory") return true;
  if (parts[1] === "events" && parts.length === 4 && parts[3] === "bootstrap") return true;
  return false;
}

async function currentAccount(deps: ScopedReadsDeps, request: FastifyRequest): Promise<unknown> {
  const account = await deps.sessionFromCookie(request.headers.cookie, request);
  if (!account) throw Object.assign(new Error(LOGIN_REQUIRED), { status: 401 });
  return account;
}

function failWith(deps: ScopedReadsDeps, reply: FastifyReply, error: unknown, fallback: string) {
  const mapped = failureFields(error, fallback, deps.failureMessage);
  return fail(reply, mapped.status, mapped.message, mapped.field, mapped.code);
}

async function scopedReads(
  deps: ScopedReadsDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const urlPath = String(request.raw.url || "/").split("?")[0];
  const parts = urlPath.split("/").filter(Boolean);

  // Freshness matches the legacy /api/bootstrap branch: every answer on an
  // owned path is uncacheable, including 401/404/503.
  reply.header("cache-control", "no-store");

  if (parts[1] === "console" && parts.length === 3 && parts[2] === "directory") {
    if (!deps.loadDirectory) return fail(reply, 503, NO_DATABASE);
    try {
      const account = await currentAccount(deps, request);
      const directory = await deps.loadDirectory(account);
      deps.stampOrgHeaders?.(reply, account);
      return reply.send({ directory });
    } catch (error) {
      return failWith(deps, reply, error, GENERIC_FAILURE);
    }
  }

  if (parts[1] === "events" && parts.length === 4 && parts[3] === "bootstrap") {
    if (!deps.loadEventBootstrap) return fail(reply, 503, NO_DATABASE);
    try {
      const account = await currentAccount(deps, request);
      const eventId = decodedSegment(parts[2]);
      if (!eventId) return fail(reply, 404, NOT_FOUND_EVENT);
      const state = await deps.loadEventBootstrap(account, eventId);
      deps.stampOrgHeaders?.(reply, account);
      return reply.send({ state });
    } catch (error) {
      return failWith(deps, reply, error, GENERIC_FAILURE);
    }
  }

  return fail(reply, 404, NOT_FOUND_API);
}

export function buildScopedReadsApp(deps: ScopedReadsDeps): FastifyInstance {
  const app = fastify({
    logger: false,
    frameworkErrors: (_error, _request, reply) => {
      // Unreachable through server.js: undecodable paths stay on the legacy
      // router, so this only covers direct boundary use.
      const rawReply = reply as unknown as FastifyReply;
      rawReply.header("cache-control", "no-store");
      return rawReply.code(404).send({ error: NOT_FOUND_API });
    },
  });

  app.get("/api/*", async (request, reply) => scopedReads(deps, request, reply));
  return app;
}
