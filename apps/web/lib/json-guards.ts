// Narrowing helpers for parsed JSON (public projections, command results).
// A wrong shape reads as empty, never as a throw: the caller decides what an
// empty value means.

/** The string itself, or the fallback for anything else. Not trimmed. */
export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

/** A plain object, or null for null, arrays and primitives. */
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
