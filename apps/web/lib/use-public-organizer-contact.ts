"use client";

import { useEffect, useState } from "react";
import { publicRecoveryContact } from "./public-recovery-contact";

// Attendee screens that say "ask the organizer" (a ticket that cannot be
// reconnected by text message) should show the organizer's real contact, but
// several of them stand where no public event read was kept (a ticket that was
// not found, a failed load). This reads the same public event data the event
// page uses, once, and only when the screen is about to send the attendee to
// the organizer. A failed or older response gives "", which the callers word
// as the plain "행사 주최 측에 문의하세요." — never an invented contact.
export function usePublicOrganizerContact(slug: string, enabled: boolean): string {
  const [loaded, setLoaded] = useState<{ slug: string; contact: string } | null>(null);

  useEffect(() => {
    if (!enabled || !slug) return;
    let cancelled = false;
    const controller = new AbortController();
    async function load() {
      try {
        const res = await fetch(`/api/public/events/${encodeURIComponent(slug)}`, { cache: "no-store", signal: controller.signal });
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as { event?: { features?: unknown }; workspace?: unknown } | null;
        if (cancelled || !data) return;
        setLoaded({ slug, contact: publicRecoveryContact(data.workspace, data.event?.features) });
      } catch {
        // Keep the plain wording.
      }
    }
    void load();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, enabled]);

  return enabled && loaded?.slug === slug ? loaded.contact : "";
}
