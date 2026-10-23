"use client";

import { useEffect, useState } from "react";
import { closeHandoffHref, readCloseReturn } from "./console-event-close";

// Related links retain the same explicit return intent, without introducing
// a persisted workflow or changing the destination's normal query filters.
export function useEventCloseHandoff(eventId: string) {
  const [returnHref, setReturnHref] = useState<string | null>(null);
  useEffect(() => {
    setReturnHref(readCloseReturn(new URLSearchParams(window.location.search).get("closeReturn"), eventId));
  }, [eventId]);
  return (target: string) => returnHref
    ? closeHandoffHref(target, eventId, new URL(returnHref, "https://eventouch.invalid").searchParams.get("closeReport"))
    : target;
}
