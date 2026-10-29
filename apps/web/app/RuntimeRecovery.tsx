"use client";

import { useEffect, useRef, useState } from "react";
import { isChunkLoadingError } from "../lib/runtime-recovery";
import styles from "./runtime-recovery.module.css";

export default function RuntimeRecovery({ error, retry, standalone = false, title, message, back }: {
  error: unknown;
  retry?: () => void;
  standalone?: boolean;
  title?: string;
  message?: string;
  back?: { href: string; label: string };
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const requestGate = useRef(false);
  const [pending, setPending] = useState(false);
  const [retryFailed, setRetryFailed] = useState(false);
  const chunkFailed = isChunkLoadingError(error);
  const nativeRecovery = standalone || chunkFailed || !retry;
  // An arbitrary client throw can imitate a numeric server digest (including
  // a phone number). This boundary has no trustworthy provenance for it, so
  // it never exposes exception properties as a diagnostic reference.

  useEffect(() => { headingRef.current?.focus(); }, []);

  function retrySegment() {
    if (requestGate.current || !retry) return;
    requestGate.current = true;
    setPending(true);
    try {
      // Next 16.4 retry re-fetches + resets; reset alone cannot recover a
      // failed Server Component. No automatic retry or command replay.
      retry();
    } catch {
      requestGate.current = false;
      setPending(false);
      setRetryFailed(true);
    }
  }

  function reloadDocument() {
    if (requestGate.current) return;
    requestGate.current = true;
    setPending(true);
    // Explicit button only. A new document clears rejected chunk imports;
    // unlike router hooks this also works outside AppRouterContext.
    window.location.reload();
  }

  return (
    <main id="main-content" className={styles.shell} tabIndex={-1}>
      <h1 ref={headingRef} tabIndex={-1} className={styles.heading}>
        {chunkFailed ? "화면 파일을 불러오지 못했습니다" : title ?? "화면을 불러오다 문제가 생겼습니다"}
      </h1>
      <p className={styles.message} role="alert">
        {chunkFailed
          ? "연결 상태를 확인한 뒤 화면을 새로 불러오세요."
          : message ?? "화면을 표시하지 못했습니다. 다시 시도하거나 처음으로 돌아갈 수 있습니다."}
      </p>
      <p className={styles.note}>입력 중이던 내용은 유지되지 않을 수 있습니다. 자동으로 새로고침하지 않습니다.</p>
      {retryFailed ? <p className={styles.message} role="alert">다시 시도하지 못했습니다. 화면을 새로 불러오세요.</p> : null}
      <div className={styles.actions} aria-busy={pending}>
        {!nativeRecovery ? (
          <button type="button" className={`${styles.action} ${styles.primary}`} disabled={pending} onClick={retrySegment}>
            {pending ? "다시 불러오는 중…" : "다시 시도"}
          </button>
        ) : null}
        <button type="button" className={`${styles.action}${nativeRecovery ? ` ${styles.primary}` : ""}`} disabled={pending} onClick={reloadDocument}>
          {pending && nativeRecovery ? "다시 불러오는 중…" : "화면 새로 불러오기"}
        </button>
        <a className={styles.returnLink} href={back?.href ?? "/"}>{back?.label ?? "처음으로"}</a>
      </div>
    </main>
  );
}
