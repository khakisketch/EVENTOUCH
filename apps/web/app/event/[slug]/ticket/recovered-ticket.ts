// A recovered bearer belongs to the tab that completed verification. Keep
// it out of URLs, and retain an in-memory handoff when storage is blocked.
import { storeTicket } from "../../../../lib/attendee-ticket-storage";

const pending = new Map<string, string>();

export function holdRecoveredTicket(slug: string, ticket: string): "stored" | "memory" {
  pending.set(slug, ticket);
  return storeTicket(slug, ticket) ? "stored" : "memory";
}

export function readRecoveredTicket(slug: string): string {
  return pending.get(slug) || "";
}

export function forgetRecoveredTicket(slug: string): void {
  pending.delete(slug);
}
