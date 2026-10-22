"use client";

import { useEffect, useState } from "react";

export type ClientVerificationMode = "solapi" | "mock" | "none" | "unknown";

// Attendee screens that offer "내 티켓 찾기" must know whether a recovery
// code can actually arrive. The mode rides on the existing public
// /api/health response (same `verification` field the server-side pages
// read); no new contract is introduced. Until the mode resolves the links
// stay visible: hiding a working path on a failed health read would be
// worse than showing a link that turns out to be unavailable.
export function useVerificationMode(): ClientVerificationMode {
  const [mode, setMode] = useState<ClientVerificationMode>("unknown");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/health", { cache: "no-store" });
        const data = (await res.json().catch(() => null)) as {
          verification?: unknown;
        } | null;
        if (cancelled) return;
        const value = data?.verification;
        if (value === "solapi" || value === "mock" || value === "none") {
          setMode(value);
        } else {
          setMode("unknown");
        }
      } catch {
        if (!cancelled) setMode("unknown");
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  return mode;
}

// Recovery codes travel by real SMS only. In mock (logged to the server
// console) and none (no transport) modes no code can reach the attendee,
// so every "내 티켓 찾기" entry must step aside for device + operator
// guidance instead of leading to a dead-end recover screen.
export function isRecoveryBlocked(mode: ClientVerificationMode): boolean {
  return mode === "mock" || mode === "none";
}
