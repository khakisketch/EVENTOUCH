function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function isOverdueManualMessage(value: unknown, now = Date.now()): boolean {
  const message = record(value);
  if (message?.status !== "SCHEDULED" || typeof message.scheduled !== "string") return false;
  const scheduled = Date.parse(message.scheduled);
  return Number.isFinite(scheduled) && scheduled <= now;
}

export function messageNeedsAttention(value: unknown, now = Date.now()): boolean {
  const message = record(value);
  return ["FAILED", "PARTIAL", "NEEDS_CONNECTION"].includes(String(message?.status ?? "")) ||
    isOverdueManualMessage(value, now);
}
