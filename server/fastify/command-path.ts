// Fastify route boundary, fourth increment: the participant command path.
//
// server.js delegates exactly these requests here, and only in database mode
// (the JSON fallback store keeps its legacy router):
//
//   POST /api/events/:slug/signup     attendee self-registration
//   POST /api/events/:id/commands     the event command dispatcher
//
// The dispatcher is the most sensitive surface in the product, so this slice
// ports its order exactly rather than restructuring it: body first, then the
// guest tiers (participant self-service, booth visit by ticket), then the
// operations executor behind a session and an authorize call, then the domain
// executor (guest commands without a session, the rest behind a session and
// a per-command authorize call), and finally the participant executor with
// the STAFF
// exception. Results keep the executor's own status and body; failures keep
// the legacy status/message/field mapping. commandId and assignmentId fall
// back to the payload exactly like the hand-rolled router.
//
// Like the other server TypeScript modules this runs without a build step
// (Node 24 type stripping) and is verified by `npm run server:typecheck`.

import fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { bearerToken, bodyOf, decodedSegment, fail, failureFields, readBody } from "./legacy-http.ts";

export type CommandResult = { status?: unknown; body?: unknown };

export type CommandExecutorInput = {
  eventId: string;
  commandId: unknown;
  command: string;
  payload: Record<string, unknown>;
  account?: unknown;
  assignmentId?: unknown;
  ticketToken?: string;
};

export type CommandPathDeps = {
  /** Participant executor; null without a database (not reachable via server.js). */
  participantCommands: {
    signup: (input: {
      slug: string;
      commandId: unknown;
      input: unknown;
      cookieHeader: string | undefined;
    }) => Promise<CommandResult & { session?: { token: string; expiresAt: string } | null }>;
    execute: (input: CommandExecutorInput) => Promise<CommandResult>;
  } | null;
  operationsCommands: {
    supports: (command: string) => boolean;
    execute: (input: CommandExecutorInput) => Promise<CommandResult>;
  } | null;
  domainCommands: {
    supports: (command: string) => boolean;
    isGuestCommand: (command: string) => boolean;
    execute: (input: CommandExecutorInput) => Promise<CommandResult>;
  } | null;
  access: {
    authorize: (input: {
      account: unknown;
      eventId: string;
      command: string;
      assignmentId?: unknown;
      targetId?: unknown;
    }) => Promise<unknown>;
  };
  sessionFromCookie: (cookieHeader: string | undefined) => Promise<unknown | null>;
  attendeeCookie: (token: string, maxAgeSeconds: number) => string;
  /** Same message rule as server/http.js: only explicit failures echo. */
  failureMessage: (error: unknown, fallback: string) => string;
};

const NO_DATABASE = "데이터베이스를 사용할 수 없습니다";
const NOT_FOUND_EVENT = "요청한 행사를 찾을 수 없습니다";
const LOGIN_REQUIRED = "로그인이 필요합니다";
const GENERIC_FAILURE = "요청을 처리하지 못했습니다";

/** Which requests this boundary owns; server.js delegates exactly these. */
export function commandPathPath(urlPath: string, method: string): boolean {
  if (method !== "POST") return false;
  const parts = urlPath.split("/").filter(Boolean);
  if (parts[0] !== "api" || parts[1] !== "events" || parts.length !== 4) return false;
  return parts[3] === "commands" || parts[3] === "signup";
}

// server/api.js text(): undefined and null become an empty string.
function text(value: unknown): string {
  return String(value === undefined || value === null ? "" : value).trim();
}

function resultStatus(result: CommandResult): Parameters<FastifyReply["code"]>[0] {
  const status = result.status;
  return (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : 200) as Parameters<FastifyReply["code"]>[0];
}

async function currentAccount(deps: CommandPathDeps, request: FastifyRequest): Promise<unknown> {
  const account = await deps.sessionFromCookie(request.headers.cookie);
  if (!account) throw Object.assign(new Error(LOGIN_REQUIRED), { status: 401 });
  return account;
}

function failWith(deps: CommandPathDeps, reply: FastifyReply, error: unknown, fallback: string) {
  const mapped = failureFields(error, fallback, deps.failureMessage);
  return fail(reply, mapped.status, mapped.message, mapped.field);
}

async function signup(deps: CommandPathDeps, parts: string[], request: FastifyRequest, reply: FastifyReply, body: unknown) {
  const slug = decodedSegment(parts[2]);
  if (!slug) return fail(reply, 404, NOT_FOUND_EVENT);
  reply.header("cache-control", "no-store");
  if (!deps.participantCommands) return fail(reply, 503, NO_DATABASE);
  try {
    const result = await deps.participantCommands.signup({
      slug,
      // The legacy expression read straight off the parsed body; null threw
      // there and surfaced as the generic 500 below, so no guard is added.
      commandId: (body as { commandId?: unknown }).commandId,
      input: body,
      cookieHeader: request.headers.cookie,
    });
    if (result.session) {
      const maxAge = Math.max(60, Math.floor((Date.parse(result.session.expiresAt) - Date.now()) / 1000));
      reply.header("set-cookie", deps.attendeeCookie(result.session.token, maxAge));
    }
    return reply.code(resultStatus(result)).send(result.body);
  } catch (error) {
    return failWith(deps, reply, error, GENERIC_FAILURE);
  }
}

async function commands(deps: CommandPathDeps, parts: string[], request: FastifyRequest, reply: FastifyReply, body: unknown) {
  reply.header("cache-control", "no-store");
  if (!deps.participantCommands) return fail(reply, 503, NO_DATABASE);
  const eventId = decodedSegment(parts[2]);
  if (!eventId) return fail(reply, 404, NOT_FOUND_EVENT);

  // The legacy expressions read straight off the parsed body; a body of null
  // threw there and kept failing with the generic 500 below, so no guard is
  // added ahead of them.
  const record = body as { command?: unknown; name?: unknown; payload?: unknown; commandId?: unknown; assignmentId?: unknown };
  const command = text(record.command || record.name);
  const payload = record.payload && typeof record.payload === "object" && !Array.isArray(record.payload)
    ? (record.payload as Record<string, unknown>)
    : {};
  const commandId = record.commandId || payload.commandId;
  const assignmentId = record.assignmentId || payload.assignmentId;

  if (command === "participant.self-update" || command === "participant.cancel") {
    const result = await deps.participantCommands.execute({
      eventId,
      commandId,
      command,
      payload,
      ticketToken: bearerToken(request.headers.authorization),
    });
    return reply.code(resultStatus(result)).send(result.body);
  }

  const guestTicketToken = bearerToken(request.headers.authorization);
  if (command === "booth.visit" && guestTicketToken) {
    if (!deps.operationsCommands) return fail(reply, 503, NO_DATABASE);
    const result = await deps.operationsCommands.execute({
      eventId,
      commandId,
      command,
      payload,
      account: null,
      ticketToken: guestTicketToken,
    });
    return reply.code(resultStatus(result)).send(result.body);
  }

  if (deps.operationsCommands && deps.operationsCommands.supports(command)) {
    const account = await currentAccount(deps, request);
    const targetId = command === "check.scan"
      ? payload.deskId || payload.targetId
      : command === "booth.visit"
        ? payload.boothId || payload.targetId
        : payload.targetId;
    await deps.access.authorize({ account, eventId, command, assignmentId, targetId });
    const result = await deps.operationsCommands.execute({
      eventId,
      commandId,
      command,
      payload,
      account,
      assignmentId,
    });
    return reply.code(resultStatus(result)).send(result.body);
  }

  if (deps.domainCommands && deps.domainCommands.supports(command)) {
    if (deps.domainCommands.isGuestCommand(command)) {
      const result = await deps.domainCommands.execute({
        eventId,
        commandId,
        command,
        payload,
        account: null,
        ticketToken: guestTicketToken,
      });
      return reply.code(resultStatus(result)).send(result.body);
    }
    const account = await currentAccount(deps, request);
    await deps.access.authorize({ account, eventId, command });
    const result = await deps.domainCommands.execute({ eventId, commandId, command, payload, account });
    return reply.code(resultStatus(result)).send(result.body);
  }

  const account = await currentAccount(deps, request);
  if (String((account as { role?: unknown }).role).toUpperCase() === "STAFF") {
    if (command !== "participant.create") throw Object.assign(new Error("권한을 확인하세요"), { status: 403 });
    await deps.access.authorize({ account, eventId, command: "participants.read", assignmentId });
  } else {
    await deps.access.authorize({ account, eventId, command: "participants.write" });
  }
  const result = await deps.participantCommands.execute({
    eventId,
    commandId,
    command,
    payload,
    account,
    assignmentId,
  });
  return reply.code(resultStatus(result)).send(result.body);
}

async function commandPath(deps: CommandPathDeps, request: FastifyRequest, reply: FastifyReply) {
  const urlPath = String(request.raw.url || "/").split("?")[0];
  const parts = urlPath.split("/").filter(Boolean);

  // The body is read before the dispatch table, exactly like the legacy
  // router; a malformed body answers 400 before any session check.
  const parsed = bodyOf(request);
  if (!parsed.ok) return fail(reply, 400, parsed.error);

  try {
    if (parts[3] === "signup") return await signup(deps, parts, request, reply, parsed.body);
    if (parts[3] === "commands") return await commands(deps, parts, request, reply, parsed.body);
    return fail(reply, 404, "요청한 API를 찾을 수 없습니다");
  } catch (error) {
    return failWith(deps, reply, error, GENERIC_FAILURE);
  }
}

export function buildCommandPathApp(deps: CommandPathDeps): FastifyInstance {
  const app = fastify({
    logger: false,
    frameworkErrors: (_error, _request, reply) => {
      // Unreachable through server.js: undecodable paths stay on the legacy
      // router. The framework callback is typed with unresolved generics, so
      // narrow the reply.
      const rawReply = reply as unknown as FastifyReply;
      return rawReply.code(404).send({ error: "요청한 API를 찾을 수 없습니다" });
    },
  });

  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", (_request, payload, done) => {
    readBody(payload).then((result) => done(null, result));
  });

  app.post("/api/*", async (request, reply) => commandPath(deps, request, reply));
  return app;
}
