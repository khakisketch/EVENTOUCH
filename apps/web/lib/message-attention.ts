function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function hasValidScheduledInstant(value: string): boolean {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?(?:Z|([+-])(\d{2}):?(\d{2}))$/i.exec(value);
  if (!match || (match[6] && (Number(match[6]) > 14 || Number(match[7]) > 59 || (Number(match[6]) === 14 && Number(match[7]) !== 0)))) return false;
  const second = match[3] || "00";
  const calendar = new Date(`${match[1]}T${match[2]}:${second}Z`);
  return Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 19) === `${match[1]}T${match[2]}:${second}` && Number.isFinite(Date.parse(value));
}

export function isOverdueManualMessage(value: unknown, now = Date.now()): boolean {
  const message = record(value);
  if (message?.status !== "SCHEDULED" || typeof message.scheduled !== "string") return false;
  if (!hasValidScheduledInstant(message.scheduled)) return false;
  const scheduled = Date.parse(message.scheduled);
  return Number.isFinite(scheduled) && scheduled <= now;
}

export function messageNeedsAttention(value: unknown, now = Date.now(), blocked = false): boolean {
  const message = record(value);
  if (!message) return false;
  const submission = record(message.providerSubmission);
  const deliveries = Array.isArray(message.deliveries) ? message.deliveries : [];
  return blocked || message.submissionUnconfirmed === true || message.genericSubmissionUnconfirmed === true ||
    (typeof submission?.id === "string" && submission.id !== "") ||
    (message.status === "SENDING" && deliveries.some((item) => record(item)?.resultMatchUnconfirmed === true)) ||
    (message.status === "SCHEDULED" && !hasValidScheduledInstant(typeof message.scheduled === "string" ? message.scheduled : "")) ||
    ["FAILED", "PARTIAL", "NEEDS_CONNECTION"].includes(String(message.status ?? "")) ||
    (message?.status === "ACCEPTED" && Array.isArray(message.deliveries) && message.deliveries.some((item) => record(item)?.status === "FAILED")) ||
    isOverdueManualMessage(value, now);
}
