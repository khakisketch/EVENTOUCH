// Fastify route boundary, second increment: the public reads.
//
// The HTTP layer migrates route by route. health.ts took GET /api/health;
// this module owns the three read shapes under GET /api/public/* that the
// attendee web, the ticket screen and the venue display share:
//
//   GET /api/public/events/:slug            public event projection
//   GET /api/public/events/:slug/ticket     ticket by bearer or browser session
//   GET /api/public/events/:slug/files/:id  attendee-visible file bytes
//
// server.js delegates exactly these GET requests to this app. Writes under
// /api/public (verification codes, guest photo uploads) stay on the legacy
// router until their own slice moves. Status, body and headers match the
// hand-rolled path, including the legacy fall-through answers for unknown
// shapes, malformed percent-encoding (where Fastify would otherwise answer
// its own 400) and the no-database 503.
//
// Like the other server TypeScript modules this runs without a build step
// (Node 24 type stripping) and is verified by `npm run server:typecheck`.

import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createReadStream } from "node:fs";
import { bearerToken, decodedSegment, errorStatus } from "./legacy-http.ts";

export type PublicEventReader = {
  loadPublicEvent: (slug: string) => Promise<unknown | null>;
  loadTicket: (slug: string, token: string) => Promise<unknown | null>;
  loadSessionTicket: (slug: string, grants: unknown) => Promise<unknown | null>;
};

export type PublicFile = {
  absolutePath: string;
  type: string;
  size: number;
};

export type PublicReadsDeps = {
  /** Public projections; null without a database (legacy 503 answer). */
  events: PublicEventReader | null;
  /** Attendee session reader for the same-browser ticket fallback. */
  resolveSession: ((cookieHeader: string | undefined) => Promise<{ grants?: unknown } | null>) | null;
  /** Public file reader for attendee-visible images; null without a database. */
  readPublicFile: ((input: { slug: string | null; fileId: string | null }) => Promise<PublicFile>) | null;
  /** Same message rule as server/http.js: only explicit failures echo. */
  failureMessage: (error: unknown, fallback: string) => string;
};

const NOT_FOUND_API = "요청한 API를 찾을 수 없습니다";
const NOT_FOUND_EVENT = "요청한 행사를 찾을 수 없습니다";
const NOT_FOUND_TICKET = "티켓 링크를 확인할 수 없습니다";
const NOT_FOUND_FILE = "파일을 찾을 수 없습니다";
const FILE_READ_FAILURE = "파일을 읽지 못했습니다";
const NO_DATABASE = "데이터베이스를 사용할 수 없습니다";
const GENERIC_FAILURE = "요청을 처리하지 못했습니다";

// The legacy file-read branch echoed an explicit failure's own message and
// hid unexpected internals behind the Korean fallback.
function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

// GET /api/public/* that matches no read shape, with or without a database.
function fallThrough(deps: PublicReadsDeps, reply: FastifyReply) {
  if (!deps.events) return reply.code(503).send({ error: NO_DATABASE });
  return reply.code(404).send({ error: NOT_FOUND_API });
}

// Malformed percent-encoding: the legacy router parsed segments itself, so a
// bad escape still landed in a normal branch. Replay that branch decision
// from the raw path instead of Fastify's framework 400. The onRequest hook
// never ran here, so no-store is set explicitly.
function malformedUrl(deps: PublicReadsDeps, request: FastifyRequest, reply: FastifyReply) {
  reply.header("cache-control", "no-store");
  const urlPath = String(request.raw.url || "/").split("?")[0];
  const parts = urlPath.split("/").filter(Boolean);
  if (!deps.events) return reply.code(503).send({ error: NO_DATABASE });
  if (parts[2] === "events" && parts[4] === "files" && parts.length === 6 && deps.readPublicFile) {
    // A slug or file id that cannot decode never resolved to a file.
    return reply.code(404).send({ error: NOT_FOUND_FILE });
  }
  if (parts[2] === "events" && (parts.length === 4 || (parts.length === 5 && parts[4] === "ticket"))) {
    return reply.code(404).send({ error: NOT_FOUND_EVENT });
  }
  return reply.code(404).send({ error: NOT_FOUND_API });
}

async function publicRead(deps: PublicReadsDeps, request: FastifyRequest, reply: FastifyReply) {
  const events = deps.events;
  const urlPath = String(request.raw.url || "/").split("?")[0];
  const parts = urlPath.split("/").filter(Boolean);
  if (!events) return reply.code(503).send({ error: NO_DATABASE });

  if (parts[2] === "events" && parts[4] === "files" && parts.length === 6) {
    if (!deps.readPublicFile) return reply.code(404).send({ error: NOT_FOUND_API });
    try {
      const file = await deps.readPublicFile({
        slug: decodedSegment(parts[3]),
        fileId: decodedSegment(parts[5]),
      });
      reply
        .code(200)
        .header("content-type", file.type)
        .header("content-length", file.size)
        .header("x-content-type-options", "nosniff");
      return reply.send(createReadStream(file.absolutePath).on("error", () => reply.raw.destroy()));
    } catch (error) {
      const status = errorStatus(error);
      return reply.code(status).send({ error: status === 500 ? FILE_READ_FAILURE : errorMessage(error, NOT_FOUND_FILE) });
    }
  }

  const eventShape = parts[2] === "events" && (parts.length === 4 || (parts.length === 5 && parts[4] === "ticket"));
  if (!eventShape) return fallThrough(deps, reply);

  const slug = decodedSegment(parts[3]);
  if (!slug) return reply.code(404).send({ error: NOT_FOUND_EVENT });

  try {
    if (parts.length === 4) {
      const projection = await events.loadPublicEvent(slug);
      if (!projection) return reply.code(404).send({ error: NOT_FOUND_EVENT });
      return reply.send(projection);
    }
    const ticket = await events.loadTicket(slug, bearerToken(request.headers.authorization));
    if (!ticket && deps.resolveSession) {
      try {
        const session = await deps.resolveSession(request.headers.cookie);
        if (session) {
          const granted = await events.loadSessionTicket(slug, session.grants);
          if (granted) return reply.send(granted);
        }
      } catch {
        // The session fallback is best-effort; the bearer answer below stands.
      }
    }
    if (!ticket) return reply.code(404).send({ error: NOT_FOUND_TICKET });
    return reply.send(ticket);
  } catch (error) {
    return reply.code(errorStatus(error)).send({ error: deps.failureMessage(error, GENERIC_FAILURE) });
  }
}

export function buildPublicReadsApp(deps: PublicReadsDeps): FastifyInstance {
  const app = fastify({
    logger: false,
    frameworkErrors: (error, request, reply) => {
      // The framework callback is typed with unresolved generics, so the raw
      // request/reply narrow to the boundary's own concrete types here.
      const rawRequest = request as unknown as FastifyRequest;
      const rawReply = reply as unknown as FastifyReply;
      if (error.code === "FST_ERR_BAD_URL") return malformedUrl(deps, rawRequest, rawReply);
      return rawReply.code(500).send({ error: GENERIC_FAILURE });
    },
  });

  // Legacy parity: every /api/public response is uncacheable.
  app.addHook("onRequest", async (_request, reply) => {
    reply.header("cache-control", "no-store");
  });

  app.get("/api/public", async (_request, reply) => fallThrough(deps, reply));
  app.get("/api/public/*", async (request, reply) => publicRead(deps, request, reply));
  return app;
}
