"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import Link from "next/link";
import { linearCloseProgress, readCloseReturn, type CloseLinearPage, type CloseSnapshot } from "../console-event-close";
import ConsoleFeedback from "./ConsoleFeedback";
import styles from "./console-ui.module.css";

export default function EventCloseReturn({ eventId, pageId, snapshot, noticeStatus, archiveControl, archiveOpen }: { eventId: string; pageId: string; snapshot?: CloseSnapshot; noticeStatus?: string; archiveControl?: ReactNode; archiveOpen?: boolean }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const nextRef = useRef<HTMLAnchorElement>(null);
  const previousStep = useRef<{ position: number; complete: boolean } | null>(null);
  const [hash, setHash] = useState("");
  useEffect(() => {
    const readHash = () => setHash(window.location.hash);
    readHash();
    window.addEventListener("hashchange", readHash);
    return () => window.removeEventListener("hashchange", readHash);
  }, [pathname]);
  const href = readCloseReturn(params.get("closeReturn"), eventId);
  const selectedReport = href ? new URL(href, "https://eventouch.invalid").searchParams.get("closeReport") : null;
  const progress = href && snapshot ? linearCloseProgress(eventId, pageId as CloseLinearPage, snapshot, selectedReport, params.get("closeStep"), hash, noticeStatus, archiveOpen) : null;
  const position = progress?.position;
  const complete = progress?.complete;
  useEffect(() => {
    const previous = previousStep.current;
    previousStep.current = position !== undefined && complete !== undefined ? { position, complete } : null;
    if (!previous || !complete || previous.complete && previous.position === position) return;
    window.dispatchEvent(new Event("eventouch:shell-reload"));
    // Completion of the last item, not every save/filter refresh, hands focus
    // to the newly relevant next control without a hub navigation.
    const frame = requestAnimationFrame(() => {
      nextRef.current?.focus({ preventScroll: true });
      nextRef.current?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
  }, [position, complete]);
  if (!href) return null;
  const refreshShell = () => window.dispatchEvent(new Event("eventouch:shell-reload"));
  return (
    <ConsoleFeedback kind="info">
      <div className={styles.closeReturn} data-close-progress>
        <div><strong>{progress ? `마감 ${progress.position}/7 · ${progress.label}${progress.complete ? progress.position === 6 ? " · 안내 기록 확인" : " · 완료" : ""}` : "행사 마감 경로"}</strong>
          <p>{progress?.detail || "현재 화면의 상태가 준비되면 다음 단계를 표시합니다."}</p>
          {progress?.warnings.length ? <p role="note">미충족 전제: {progress.warnings.join(" · ")}. 이동은 막지 않습니다.</p> : null}
        </div>
        {archiveControl && progress && [6, 7].includes(progress.position) && snapshot?.stage !== "ARCHIVED" ? archiveControl : progress?.next ? progress.next.localStage ? (
          <a ref={nextRef} className="button button-secondary" href={progress.next.href} data-close-linear-next onClick={() => {
            const details = document.querySelector<HTMLDetailsElement>('details[data-settings-collapse="stage"]');
            if (details) details.open = true;
            const heading = document.getElementById("settings-stage");
            heading?.setAttribute("tabindex", "-1");
            heading?.focus({ preventScroll: true });
            heading?.scrollIntoView({ block: "start" });
            setHash("#settings-stage");
          }}>다음: {progress.next.label}</a>
        ) : <Link ref={nextRef} className="button button-secondary" href={progress.next.href} data-close-linear-next onNavigate={refreshShell}>다음: {progress.next.label}</Link> : null}
        <p className={styles.closeOptional}>허브 복귀는 상태 확인용 선택입니다. 다음 단계로 바로 이어갈 수 있습니다.</p>
        <Link className="button button-secondary" href={href} prefetch={false} data-close-back
          onNavigate={() => window.dispatchEvent(new Event("eventouch:shell-reload"))}>마감으로 돌아가기</Link>
      </div>
    </ConsoleFeedback>
  );
}
