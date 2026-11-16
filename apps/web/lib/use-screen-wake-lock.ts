"use client";

import { useEffect } from "react";

// Keeps the screen awake while `active`. Unsupported or refused requests are
// ignored: the screen may dim, and nothing else depends on the lock.
export function useScreenWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let lock: WakeLockSentinel | null = null;
    let cancelled = false;
    const acquire = async () => {
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) void next.release(); else lock = next;
      } catch {
        // Unsupported or refused.
      }
    };
    const onVisible = () => { if (!document.hidden && (!lock || lock.released)) void acquire(); };
    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (lock) void lock.release().catch(() => {});
    };
  }, [active]);
}
