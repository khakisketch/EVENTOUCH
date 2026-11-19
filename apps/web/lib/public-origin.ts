// The address attendees open on their own devices, from EVENTOUCH_PUBLIC_URL.
// Same rule as server/public-origin.js: http(s) only, no credentials, query or
// hash, and no trailing slash. Null means "not configured", and callers fall
// back to the address the operator is using.
export function configuredPublicBase(env: Record<string, string | undefined> = process.env): string | null {
  const raw = String(env.EVENTOUCH_PUBLIC_URL || "").trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !url.hostname) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return url.origin + url.pathname.replace(/\/+$/, "");
}
