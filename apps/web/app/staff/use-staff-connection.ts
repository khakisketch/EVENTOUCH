"use client";

import { useEffect, useState } from "react";

// Field connectivity for the staff screen (audit S3, 2026-11-24). This only
// informs the operator: it never blocks or alters a scan, so the idempotent
// retry and lost-response recovery paths stay exactly as they were.
export const STAFF_SLOW_AFTER_MS = 5000;

export const STAFF_OFFLINE_MESSAGE = "연결이 끊겼습니다. 연결을 확인하기 전에는 스캔하지 마세요.";
export const STAFF_SLOW_MESSAGE = "연결이 느립니다. 처리 결과를 확인하는 중이니 같은 티켓을 다시 스캔하지 말고 기다려 주세요.";

export function useStaffConnection(busy: boolean, slowAfterMs = STAFF_SLOW_AFTER_MS) {
  // Start online so server and first client render agree; the effect syncs.
  const [online, setOnline] = useState(true);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const sync = () => setOnline(typeof navigator === "undefined" || navigator.onLine !== false);
    sync();
    window.addEventListener("online", sync);
    window.addEventListener("offline", sync);
    return () => {
      window.removeEventListener("online", sync);
      window.removeEventListener("offline", sync);
    };
  }, []);

  useEffect(() => {
    if (!busy) { setSlow(false); return; }
    const timer = window.setTimeout(() => setSlow(true), slowAfterMs);
    return () => { window.clearTimeout(timer); setSlow(false); };
  }, [busy, slowAfterMs]);

  return { online, slow };
}
