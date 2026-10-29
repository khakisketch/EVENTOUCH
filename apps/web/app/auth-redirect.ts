// Shared operator entry guard: where may /login send the user back?
// Only local product paths are allowed; external, protocol-relative,
// backslash, API and login-loop destinations are rejected. Server authority
// still applies on arrival: each destination rechecks role and assignment.

// __SAFE_NEXT_PATH_BEGIN__
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
    next.startsWith("/screen/")
  ) {
    return next;
  }
  if (next.startsWith("/invite/")) {
    // Invitation bearer links only: the exact /invite/<token> path with the
    // server token alphabet. Encoded tricks, traversal, extra segments and
    // query/hash tails are rejected — login return must not smuggle them.
    return /^[A-Za-z0-9_-]{40,128}$/.test(next.slice("/invite/".length)) ? next : null;
  }
  return null;
}
// __SAFE_NEXT_PATH_END__

export function loginHref(next: unknown): string {
  const safe = safeNextPath(next);
  return safe ? `/login?next=${encodeURIComponent(safe)}` : "/login";
}

export function loginHrefForLocation(pathname: string, search = ""): string {
  const current = `${pathname}${search}`;
  return loginHref(safeNextPath(current) ?? current);
}

// Authenticated but org-unselected (multi-membership without an active
// org): the explicit org picker owns the next step, never another login.
// A safe requested invite link survives as its return so the join flow can
// resume after selection; every other destination is dropped.
export function chooseOrganizationHref(next?: unknown): string {
  const base = "/console?chooseOrganization=1";
  const safe = safeNextPath(next);
  if (safe && safe.startsWith("/invite/")) return `${base}&next=${encodeURIComponent(safe)}`;
  return base;
}
