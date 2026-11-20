import { readStoredTicket } from './attendee-ticket-storage';

// A rejected ticket must not silently become another attendee's shared
// browser session after a reload or navigation. This marker contains no
// ticket, participant information, or other credential.
const REJECTED_PREFIX = 'eventouch.ticket-rejected.';
// Keep the explicitly selected ticket only in the current tab's document
// memory if storage cannot retain it. Never follow a mutable shared cookie
// on subsequent routes: another tab may have switched its participant.
const allowedSessions = new Map<string, string>();
export function allowSessionForTab(slug: string, ticket: string): void { if (ticket) allowedSessions.set(slug, ticket); }
export function getAllowedTicketForTab(slug: string): string { return allowedSessions.get(slug) || ''; }
export function clearSessionForTab(slug: string): void { allowedSessions.delete(slug); }

export function markTicketRejected(slug: string): void {
  clearSessionForTab(slug);
  try { window.sessionStorage.setItem(REJECTED_PREFIX + slug, '1'); } catch { /* restricted storage */ }
  const query = new URLSearchParams(window.location.search);
  query.delete('session');
  query.set('ticket-error', '1');
  window.history.replaceState(null, '', `${window.location.pathname}?${query.toString()}${window.location.hash}`);
}

export function isTicketRejected(slug: string): boolean {
  try { return window.sessionStorage.getItem(REJECTED_PREFIX + slug) === '1'; } catch { return false; }
}

// Only a navigation hint. The ticket page verifies the bearer after the click.
export function hasTicketInThisTab(slug: string): boolean {
  if (!slug || isTicketRejected(slug)) return false;
  if (getAllowedTicketForTab(slug)) return true;
  return Boolean(readStoredTicket(slug)) && ticketStorageAvailable(slug);
}

export function clearTicketRejected(slug: string): void {
  try { window.sessionStorage.removeItem(REJECTED_PREFIX + slug); } catch { /* restricted storage */ }
}

export function ticketStorageAvailable(slug: string): boolean {
  try {
    // Probe at least the space needed for this event's rejection marker.
    // A nearly full store must not allow a small probe yet fail the marker,
    // then silently restore a different identity on the next route.
    const key = `${REJECTED_PREFIX}${slug}.probe`;
    window.sessionStorage.setItem(key, '1');
    window.sessionStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export const REJECTED_TICKET_BEARER = '!eventouch-rejected-ticket!';
