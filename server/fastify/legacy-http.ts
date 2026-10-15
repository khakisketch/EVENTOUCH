// Helpers shared by the Fastify route boundaries that must stay byte- and
// behavior-compatible with the hand-rolled router in server/api.js.
//
// The public reads, organization REST and command path each need the same
// segment decoding, bearer parsing, legacy body reading (1MB cap, drain, the
// three messages) and the same status/message/field mapping. Those rules
// live here once; each boundary module owns only its routes and dispatch
// order.
//
// Like the other server TypeScript modules this runs without a build step
// (Node 24 type stripping) and is verified by `npm run server:typecheck`.

import type { FastifyReply, FastifyRequest } from "fastify";

export const MAX_BODY_BYTES = 1024 * 1024;

export type BodyResult = { ok: true; body: unknown } | { ok: false; error: string };

// Same rule as the legacy router: a malformed percent-escape decodes to
// null instead of throwing, and each branch has its own answer for that.
export function decodedSegment(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export function bearerToken(header: string | undefined): string {
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ""));
  return match ? match[1] : "";
}

// server/http.js readJsonBody, kept byte-for-byte: a single 1MB cap with the
// rest of the request drained, an empty body as {}, and its own three error
// messages. Streaming here keeps the memory profile of the legacy path.
export function readBody(stream: NodeJS.ReadableStream): Promise<BodyResult> {
  return new Promise((resolve) => {
    let size = 0;
    let tooBig = false;
    const chunks: Buffer[] = [];
    stream.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooBig = true;
        chunks.length = 0;
        (stream as NodeJS.ReadableStream & { resume: () => void }).resume();
        return;
      }
      chunks.push(chunk);
    });
    stream.on("end", () => {
      if (tooBig) {
        resolve({ ok: false, error: "요청이 너무 큽니다" });
        return;
      }
      try {
        resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") });
      } catch {
        resolve({ ok: false, error: "요청 형식을 확인하세요" });
      }
    });
    stream.on("error", () => resolve({ ok: false, error: "요청을 읽지 못했습니다" }));
  });
}

// The parser stores its result as the request body; a request without a body
// never ran the parser and reads as {} like an empty legacy body.
export function bodyOf(request: FastifyRequest): BodyResult {
  const value = request.body as BodyResult | undefined;
  return value && typeof value === "object" && "ok" in value ? value : { ok: true, body: {} };
}

export function errorStatus(error: unknown): Parameters<FastifyReply["code"]>[0] {
  const value = error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;
  return (typeof value === "number" && Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500) as Parameters<FastifyReply["code"]>[0];
}

export type FailureFields = {
  status: Parameters<FastifyReply["code"]>[0];
  message: string;
  field: string | null;
};

export function failureFields(
  error: unknown,
  fallback: string,
  failureMessage: (error: unknown, fallback: string) => string
): FailureFields {
  const field = error && typeof error === "object" ? (error as { field?: unknown }).field : undefined;
  return {
    status: errorStatus(error),
    message: failureMessage(error, fallback),
    field: typeof field === "string" && field ? field : null,
  };
}

// server/api.js err(): the field rides along only when it is set.
export function fail(
  reply: FastifyReply,
  status: Parameters<FastifyReply["code"]>[0],
  message: string,
  field?: string | null
) {
  const body: Record<string, unknown> = { error: message };
  if (field) body.field = field;
  return reply.code(status).send(body);
}
