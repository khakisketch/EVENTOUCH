// Shared pure helpers for the server command executors.
//
// domain.js, participants.js and operations.js each defined their own copies
// of these functions. The copies were behaviorally identical, which meant a
// contract change (id format, ticket hashing, bearer parsing) had to be made
// in three places. This module is the single owner; the executors keep their
// own authorize/lock/receipt logic, which genuinely differs per path.
//
// TypeScript runs here without a build step: Node 24 strips erasable types
// when this file is required with its extension (require("./shared.ts")),
// and `npm run server:typecheck` verifies it. Only erasable syntax is
// allowed (no enums, namespaces, or parameter properties) so the runtime
// and the checked source stay the same file.

import { createHash, randomUUID } from "node:crypto";

export type StatusError = Error & { status?: number; field?: string; code?: string };

export function failure(status: number, message: string, field?: string, code?: string): StatusError {
  const error: StatusError = new Error(message);
  error.status = status;
  if (field) error.field = field;
  if (code) error.code = code;
  return error;
}

export function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function list<T>(value: T[] | unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

export function clean(value: unknown, max = 500): string {
  return String(value === undefined || value === null ? "" : value).trim().slice(0, max);
}

export function commandIdentifier(value: unknown): string {
  const id = clean(value, 128);
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(id)) throw failure(400, "요청 식별자를 확인하세요", "commandId");
  return id;
}

export function nextId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function hashTicket(token: unknown): string | null {
  return token ? createHash("sha256").update(String(token)).digest("hex") : null;
}

export const ticketHash = hashTicket;

export type TicketHolder = {
  ticket?: unknown;
  [key: string]: unknown;
};

export function findTicket<T extends TicketHolder>(
  workspace: { participants?: unknown } | null | undefined,
  token: unknown
): T | null {
  const participants = workspace ? (workspace as { participants?: unknown }).participants : undefined;
  return list<T>(participants).find((person) => person !== null && (person as TicketHolder).ticket === token) || null;
}

export function ticketCode(value: unknown): string {
  const raw = clean(value, 2048);
  if (!raw.includes("ticket=")) return raw;
  try {
    const query = raw.slice(raw.indexOf("?") + 1);
    return new URLSearchParams(query).get("ticket") || raw;
  } catch {
    return raw;
  }
}
