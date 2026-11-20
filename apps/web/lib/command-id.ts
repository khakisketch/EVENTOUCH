// The request id of one browser-side write. The same id is replayed on a retry
// (that is what makes the write idempotent), so a caller mints it once per
// attempt and keeps it. The id can recover an issued ticket, so it must stay
// unpredictable even where crypto.randomUUID is missing (it only exists in
// secure contexts): the fallback is 128 random bits, never a clock or Math.random.
export function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `web-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
