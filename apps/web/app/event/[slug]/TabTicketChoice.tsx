"use client";

import { useEffect, useState, type ReactNode } from "react";
import { hasTicketInThisTab } from "../../../lib/attendee-ticket-identity";

export default function TabTicketChoice({ slug, whenPresent, children }: {
  slug: string;
  whenPresent: ReactNode;
  children?: ReactNode;
}) {
  const [ticketEvent, setTicketEvent] = useState<string | null>(null);
  useEffect(() => {
    function refresh() {
      setTicketEvent(hasTicketInThisTab(slug) ? slug : null);
    }
    function onVisible() {
      if (document.visibilityState === "visible") refresh();
    }
    refresh();
    window.addEventListener("pageshow", refresh);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("pageshow", refresh);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [slug]);
  return ticketEvent === slug ? whenPresent : children;
}
