// The attendee's ticket bearer for this tab. It lives in sessionStorage only
// (never in persistent storage, never in a URL), keyed by event slug. Every attendee screen
// (home, ticket, engage) reads the same key, so they share one identity per tab.
// When storage is blocked (private mode, quota) the callers keep the bearer in
// memory for the page load; these helpers only report that, they never throw.
export const TICKET_STORAGE_PREFIX = "eventouch.ticket.";

export function readStoredTicket(slug: string): string {
  try {
    return window.sessionStorage.getItem(TICKET_STORAGE_PREFIX + slug) || "";
  } catch {
    return "";
  }
}

/** True when the bearer was kept; false when storage refused it. */
export function storeTicket(slug: string, ticket: string): boolean {
  try {
    window.sessionStorage.setItem(TICKET_STORAGE_PREFIX + slug, ticket);
    return true;
  } catch {
    return false;
  }
}

export function clearStoredTicket(slug: string): void {
  try {
    window.sessionStorage.removeItem(TICKET_STORAGE_PREFIX + slug);
  } catch {
    // Nothing to clear.
  }
}
