import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

type Environment = Record<string, string | undefined>;
type RouteStats = { requests: number; errors: number; aborted: number; durationMs: number; maxDurationMs: number };

const routes: [RegExp, string][] = [
  [/^\/api\/(health|readyz|diagnostics)$/, "/api/$1"],
  [/^\/api\/auth\/invitations\/[^/]+$/, "/api/auth/invitations/:token"],
  [/^\/api\/auth\/(login|logout|me|setup|security|login-lockouts|invitations|password-reset)$/, "/api/auth/$1"],
  [/^\/api\/auth\/email\/(verify\/(request|confirm)|status)$/, "/api/auth/email/$1"],
  [/^\/api\/auth\/recovery\/(request|confirm)$/, "/api/auth/recovery/$1"],
  [/^\/api\/auth\/organizations(?:\/select)?$/, "/api/auth/organizations"],
  [/^\/api\/auth\/organizations\/[^/]+\/members\/[^/]+$/, "/api/auth/organizations/:orgId/members/:accountId"],
  [/^\/api\/auth\/dev\/quick-login$/, "/api/auth/dev/quick-login"],
  [/^\/api\/public\/events\/[^/]+\/files\/[^/]+$/, "/api/public/events/:slug/files/:fileId"],
  [/^\/api\/public\/events\/[^/]+(?:\/(ticket|session|verification|recover))?$/, "/api/public/events/:slug/$1"],
  [/^\/api\/public\/events\/[^/]+\/.+$/, "/api/public/events/:slug/:operation"],
  [/^\/api\/events\/[^/]+\/files(?:\/[^/]+)?$/, "/api/events/:eventId/files/:fileId"],
  [/^\/api\/events\/[^/]+\/(commands|signup|members|bootstrap|evidence-photos\.zip|attendee-photos\.zip)$/, "/api/events/:eventId/$1"],
  [/^\/api\/events\/[^/]+\/duplicate$/, "/api/events/:eventId/duplicate"],
  [/^\/api\/events\/[^/]+\/desks\/[^/]+\/arrivals$/, "/api/events/:eventId/desks/:deskId/arrivals"],
  [/^\/api\/events\/[^/]+\/command-receipts\/[^/]+$/, "/api/events/:eventId/command-receipts/:commandId"],
  [/^\/api\/command-receipts\/[^/]+$/, "/api/command-receipts/:commandId"],
  [/^\/api\/clients\/[^/]+\/files(?:\/[^/]+)?$/, "/api/clients/:clientId/files/:fileId"],
  [/^\/api\/accounts\/[^/]+\/org-permissions$/, "/api/accounts/:accountId/org-permissions"],
  [/^\/api\/console\/directory$/, "/api/console/directory"],
  [/^\/api\/(bootstrap|events|clients)$/, "/api/$1"],
  [/^\/sw\.js$/, "/sw.js"],
];

/** Never use a raw URL: query strings and path segments may be bearer secrets. */
export function requestRoute(url: string | undefined): string {
  const pathname = String(url || "").split("?")[0];
  for (const [pattern, template] of routes) {
    if (pattern.test(pathname)) return pathname.replace(pattern, template).replace(/\/$/, "");
  }
  return "/unmatched";
}

type Failures = { requestId: string; route: string; write: (line: string) => unknown; reported: boolean };
const failures = new WeakMap<IncomingMessage, Failures>();
const writeStderr = (line: string) => process.stderr.write(line);

// Names and codes are identifiers; anything else could carry typed data.
function identifier(value: unknown): string | null {
  const text = typeof value === "number" ? String(value) : value;
  return typeof text === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(text) ? text : null;
}

/**
 * One stderr line per request for an unexpected failure: never the message,
 * stack, parameters or URL. Errors carrying a status below 500 are expected
 * business answers and stay silent.
 */
export function reportUnexpectedError(request: IncomingMessage, error: unknown): void {
  const fields = (error && typeof error === "object" ? error : {}) as
    { status?: unknown; statusCode?: unknown; name?: unknown; code?: unknown };
  const status = fields.status ?? fields.statusCode;
  if (typeof status === "number" && status < 500) return;
  const known = failures.get(request);
  if (known?.reported) return;
  if (known) known.reported = true;
  const line = { type: "error", requestId: known?.requestId ?? null, route: known?.route ?? requestRoute(request.url),
    name: identifier(fields.name) ?? "unknown", code: identifier(fields.code) };
  try { (known?.write ?? writeStderr)(`${JSON.stringify(line)}\n`); } catch { /* logging cannot change a committed outcome */ }
}

/**
 * One stderr line for an unexpected failure outside an HTTP request (a
 * background job, a renewal on the response path). Same rule as
 * reportUnexpectedError: identifiers only, and errors that carry a status
 * below 500 are expected business answers and stay silent.
 */
export function reportBackgroundError(where: string, error: unknown): void {
  const fields = (error && typeof error === "object" ? error : {}) as
    { status?: unknown; statusCode?: unknown; name?: unknown; code?: unknown };
  const status = fields.status ?? fields.statusCode;
  if (typeof status === "number" && status < 500) return;
  const line = { type: "error", where: identifier(where) ?? "unknown",
    name: identifier(fields.name) ?? "unknown", code: identifier(fields.code) };
  try { writeStderr(`${JSON.stringify(line)}\n`); } catch { /* logging cannot change a committed outcome */ }
}

export function createRequestObservability({ env = process.env, write = writeStderr }:
  { env?: Environment; write?: (line: string) => unknown } = {}) {
  const startedAt = new Date().toISOString();
  const release = /^[A-Za-z0-9_.-]{1,64}$/.test(env.EVENTOUCH_BUILD_REVISION || "") ? env.EVENTOUCH_BUILD_REVISION : "unknown";
  const logging = env.EVENTOUCH_REQUEST_LOGS === "1" || (env.NODE_ENV === "production" && env.EVENTOUCH_REQUEST_LOGS !== "0");
  const metrics = new Map<string, RouteStats>();
  return {
    attach(request: IncomingMessage, response: ServerResponse) {
      const requestId = randomUUID();
      const started = performance.now();
      const route = requestRoute(request.url);
      const method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(request.method || "") ? request.method! : "OTHER";
      response.setHeader("x-request-id", requestId);
      failures.set(request, { requestId, route, write, reported: false });
      let recorded = false;
      const finish = () => {
        if (recorded) return;
        recorded = true;
        const durationMs = Math.round((performance.now() - started) * 100) / 100;
        const aborted = !response.writableFinished;
        const status = aborted ? 499 : response.statusCode;
        const key = `${method} ${route}`;
        const previous = metrics.get(key) || { requests: 0, errors: 0, aborted: 0, durationMs: 0, maxDurationMs: 0 };
        previous.requests += 1;
        previous.errors += status >= 500 ? 1 : 0;
        previous.aborted += aborted ? 1 : 0;
        previous.durationMs += durationMs;
        previous.maxDurationMs = Math.max(previous.maxDurationMs, durationMs);
        metrics.set(key, previous);
        if (logging) {
          try { write(`${JSON.stringify({ type: "http", requestId, method, route, status, durationMs })}\n`); } catch { /* logging cannot change a committed outcome */ }
        }
      };
      response.once("finish", finish);
      response.once("close", finish);
    },
    snapshot() {
      return {
        startedAt, release, logging,
        routes: [...metrics].map(([route, values]) => ({
          route, requests: values.requests, errors: values.errors, aborted: values.aborted,
          meanDurationMs: Math.round(values.durationMs / values.requests * 100) / 100,
          maxDurationMs: values.maxDurationMs,
        })),
      };
    },
  };
}
