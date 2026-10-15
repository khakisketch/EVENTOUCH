// Shared operator entry guard: where may /login send the user back?
// Only local product paths are allowed; external, protocol-relative,
// backslash, API and login-loop destinations are rejected. Server authority
// still applies on arrival: each destination rechecks role and assignment.

export function safeNextPath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const next = value.trim();
  if (!next.startsWith("/")) return null;
  if (next.startsWith("//")) return null;
  if (next.includes("\\")) return null;
  if (/[\s<>"]/.test(next)) return null;
  if (next.length > 500) return null;
  if (
    next === "/login" ||
    next.startsWith("/login?") ||
    next.startsWith("/login#") ||
    next === "/staff/login" ||
    next.startsWith("/staff/login?") ||
    next.startsWith("/staff/login#")
  ) {
    return null;
  }
  if (next === "/api" || next.startsWith("/api/")) return null;
  if (next === "/") return "/";
  if (next === "/console" || next.startsWith("/console/")) return next;
  if (next === "/staff" || next.startsWith("/staff/")) {
    // The legacy login itself is rejected above; remaining staff paths are
    // the assignment hub and event work.
    return next;
  }
  if (
    next.startsWith("/event/") ||
    next.startsWith("/screen/") ||
    next.startsWith("/invite/")
  ) {
    return next;
  }
  return null;
}

export function loginHref(next: unknown): string {
  const safe = safeNextPath(next);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}

export function loginHrefForLocation(pathname: string, search = ""): string {
  const current = `${pathname}${search}`;
  return loginHref(safeNextPath(current) ?? current);
}
