// A recovered bearer belongs to the tab that completed verification. Keep
// it out of URLs, and retain an in-memory handoff when storage is blocked.
const pending = new Map<string, string>();
const prefix = "eventouch.ticket.";

export function holdRecoveredTicket(slug: string, ticket: string): "stored" | "memory" {
  pending.set(slug, ticket);
  try {
    window.sessionStorage.setItem(prefix + slug, ticket);
    return "stored";
  } catch {
    return "memory";
  }
}

export function readRecoveredTicket(slug: string): string {
  return pending.get(slug) || "";
}

export function forgetRecoveredTicket(slug: string): void {
  pending.delete(slug);
}
