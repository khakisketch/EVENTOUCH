// The one product-level contact: the landing inquiry, the help page and the
// terms and privacy pages all read it from here. It is the service's own
// address, never an event organizer's (an organizer's contact for attendees is
// the event's `participantContact`, see public-recovery-contact.ts).
export const SUPPORT_EMAIL = "contact@eventouch.co.kr";

export function supportMailto(subject?: string): string {
  return subject ? `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}` : `mailto:${SUPPORT_EMAIL}`;
}
