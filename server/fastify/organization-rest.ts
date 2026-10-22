// Fastify route boundary, third increment: the organization-scope REST.
//
// server.js delegates exactly these requests here, and only in database
// mode — the JSON fallback store keeps its legacy router untouched:
//
//   GET  /api/events                        agency event list
//   POST /api/events                        event creation
//   POST /api/clients                       client save
//   POST /api/accounts/:id/org-permissions  organization permissions
//   POST /api/events/:id/members            event membership
//
// These are the organization-scope writes without an event command scope
// (they carry their own commandId receipts inside state.js), so they move
// before the command path. Status, body, headers, error messages and field
// names stay identical to the hand-rolled path, including the read order:
// the body is read before authentication, so a malformed body answers 400
// even for anonymous callers, and cache-control is set only after the
// session check, exactly as before.
//
// Requests whose path cannot be percent-decoded are not delegated at all
// (server.js keeps them on the legacy router, whose branch answers depend
// on request bodies); this app therefore always sees a decodable path.
//
// Like the other server TypeScript modules this runs without a build step
// (Node 24 type stripping) and is verified by `npm run server:typecheck`.

import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { bodyOf, decodedSegment, fail, failureFields, readBody } from "./legacy-http.ts";

export type OrganizationRestDeps = {
  /** Session lookup for the cookie the browser already holds. */
  sessionFromCookie: (cookieHeader: string | undefined) => Promise<unknown | null>;
  loadBootstrap: (account: unknown) => Promise<{ events?: unknown; activeEventId?: unknown }>;
  createEvent: (account: unknown, body: unknown) => Promise<{ event: unknown; replayed?: unknown }>;
  duplicateEvent: (
    account: unknown,
    sourceEventId: string,
    body: unknown
  ) => Promise<{ event: unknown; replayed?: unknown }>;
  saveClient: (account: unknown, body: unknown) => Promise<{ client: unknown; replayed?: unknown }>;
  saveOrgPermissions: (
    account: unknown,
    accountId: string | null,
    body: unknown
  ) => Promise<{ account: unknown; replayed?: unknown }>;
  assignMember: (
    account: unknown,
    eventId: string,
    body: unknown
  ) => Promise<{ membership: unknown; replayed?: unknown }>;
  /** Same message rule as server/http.js: only explicit failures echo. */
  failureMessage: (error: unknown, fallback: string) => string;
};

const NOT_FOUND_API = "요청한 API를 찾을 수 없습니다";
const LOGIN_REQUIRED = "로그인이 필요합니다";
const GENERIC_FAILURE = "요청을 처리하지 못했습니다";

/** Which requests this boundary owns; server.js delegates exactly these. */
export function organizationRestPath(urlPath: string, method: string): boolean {
  const parts = urlPath.split("/").filter(Boolean);
  if (parts[0] !== "api") return false;
  if (parts[1] === "events" && parts.length === 2) return method === "GET" || method === "POST";
  if (parts[1] === "events" && parts.length === 4 && parts[3] === "duplicate") return method === "POST";
  if (parts[1] === "events" && parts.length === 4 && parts[3] === "members") return method === "POST";
  if (parts[1] === "clients" && parts.length === 2) return method === "POST";
  if (parts[1] === "accounts" && parts.length === 4 && parts[3] === "org-permissions") return method === "POST";
  return false;
}

async function currentAccount(deps: OrganizationRestDeps, request: FastifyRequest): Promise<unknown> {
  const account = await deps.sessionFromCookie(request.headers.cookie);
  if (!account) throw Object.assign(new Error(LOGIN_REQUIRED), { status: 401 });
  return account;
}

function failWith(deps: OrganizationRestDeps, reply: FastifyReply, error: unknown, fallback: string) {
  const mapped = failureFields(error, fallback, deps.failureMessage);
  return fail(reply, mapped.status, mapped.message, mapped.field);
}

async function organizationRest(
  deps: OrganizationRestDeps,
  request: FastifyRequest,
  reply: FastifyReply
) {
  const urlPath = String(request.raw.url || "/").split("?")[0];
  const parts = urlPath.split("/").filter(Boolean);
  const method = request.method;

  // The body is read before anything else for write methods (legacy
  // readJsonBody ran ahead of the whole dispatch table).
  let body: unknown = {};
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    const parsed = bodyOf(request);
    if (!parsed.ok) return fail(reply, 400, parsed.error);
    body = parsed.body;
  }

  try {
    if (parts[1] === "events" && parts.length === 2 && method === "GET") {
      const account = await currentAccount(deps, request);
      const projection = await deps.loadBootstrap(account);
      reply.header("cache-control", "no-store");
      return reply.send({ events: projection.events, activeEventId: projection.activeEventId });
    }

    if (parts[1] === "events" && parts.length === 2 && method === "POST") {
      const account = await currentAccount(deps, request);
      reply.header("cache-control", "no-store");
      const result = await deps.createEvent(account, body);
      return reply.code(result.replayed ? 200 : 201).send({ event: result.event });
    }

    if (parts[1] === "events" && parts.length === 4 && parts[3] === "duplicate" && method === "POST") {
      const account = await currentAccount(deps, request);
      reply.header("cache-control", "no-store");
      const eventId = decodedSegment(parts[2]);
      if (!eventId) return fail(reply, 404, "요청한 행사를 찾을 수 없습니다");
      const result = await deps.duplicateEvent(account, eventId, body);
      return reply.code(result.replayed ? 200 : 201).send({ event: result.event });
    }

    if (parts[1] === "clients" && parts.length === 2 && method === "POST") {
      const account = await currentAccount(deps, request);
      reply.header("cache-control", "no-store");
      try {
        const result = await deps.saveClient(account, body);
        return reply.code(result.replayed ? 200 : 201).send({ client: result.client });
      } catch (error) {
        return failWith(deps, reply, error, "고객사 정보를 저장하지 못했습니다");
      }
    }

    if (parts[1] === "accounts" && parts[3] === "org-permissions" && parts.length === 4 && method === "POST") {
      const account = await currentAccount(deps, request);
      reply.header("cache-control", "no-store");
      try {
        const result = await deps.saveOrgPermissions(account, decodedSegment(parts[2]), body);
        return reply.code(result.replayed ? 200 : 201).send({ account: result.account });
      } catch (error) {
        return failWith(deps, reply, error, "조직 권한을 저장하지 못했습니다");
      }
    }

    if (parts[1] === "events" && parts.length === 4 && parts[3] === "members" && method === "POST") {
      const account = await currentAccount(deps, request);
      reply.header("cache-control", "no-store");
      const eventId = decodedSegment(parts[2]);
      if (!eventId) return fail(reply, 404, "요청한 행사를 찾을 수 없습니다");
      try {
        const result = await deps.assignMember(account, eventId, body);
        return reply.code(result.replayed ? 200 : 201).send({ membership: result.membership });
      } catch (error) {
        return failWith(deps, reply, error, "행사 권한을 저장하지 못했습니다");
      }
    }

    return fail(reply, 404, NOT_FOUND_API);
  } catch (error) {
    return failWith(deps, reply, error, GENERIC_FAILURE);
  }
}

export function buildOrganizationRestApp(deps: OrganizationRestDeps): FastifyInstance {
  const app = fastify({
    logger: false,
    frameworkErrors: (_error, _request, reply) => {
      // Unreachable through server.js: undecodable paths stay on the legacy
      // router, so this only covers direct boundary use. The framework
      // callback is typed with unresolved generics, so narrow the reply.
      const rawReply = reply as unknown as FastifyReply;
      return rawReply.code(404).send({ error: NOT_FOUND_API });
    },
  });

  // The legacy router never cared about the media type; '' matches requests
  // without a content-type header as well, which Fastify's JSON parser
  // would otherwise reject.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => {
    readBody(payload).then((result) => done(null, result));
  });

  app.get("/api/*", async (request, reply) => organizationRest(deps, request, reply));
  app.post("/api/*", async (request, reply) => organizationRest(deps, request, reply));
  return app;
}
