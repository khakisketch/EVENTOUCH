"use client";

import ProductButton from "../../ui/ProductButton";
import ProductLink from "../../ui/ProductLink";

import type { ReactNode } from "react";
import ConsoleSkeleton, { type ConsoleSkeletonShape } from "./ConsoleSkeleton";
import skeletonStyles from "./console-skeleton.module.css";
import styles from "./console-ui.module.css";

type ConsoleStatePanelProps = {
  kind: "loading" | "failed";
  message: string;
  onRetry: () => void;
  actions?: ReactNode;
  /** Loading only: the screen shape the skeleton imitates (default: a list). */
  shape?: ConsoleSkeletonShape;
  /**
   * Failed only. A missing or forbidden event cannot be fixed by loading it
   * again, so those two offer the event list instead of a retry. Omitted, the
   * reason is read from the message the callers already pass.
   */
  reason?: "notFound" | "forbidden" | "error";
};

function reasonOf(message: string): "notFound" | "forbidden" | "error" {
  const missing = /찾을 수 없/.test(message);
  const forbidden = /접근 권한|권한이 없/.test(message);
  if (missing && forbidden) return "forbidden";
  if (missing) return "notFound";
  if (forbidden) return "forbidden";
  return "error";
}

export default function ConsoleStatePanel({
  kind,
  message,
  onRetry,
  actions,
  shape,
  reason,
}: ConsoleStatePanelProps) {
  const loading = kind === "loading";

  // Loading draws the shape of the screen instead of one line of text, so the
  // page does not jump when data arrives. The message stays for assistive
  // technology, and appears for everyone if the load turns out to be slow.
  if (loading) {
    return (
      <section className={skeletonStyles.page} aria-busy="true">
        <p className={skeletonStyles.visuallyHidden} role="status">
          {message}
        </p>
        <ConsoleSkeleton shape={shape} />
        <p className={skeletonStyles.hint} aria-hidden="true">
          {message}
        </p>
      </section>
    );
  }

  const cause = reason ?? reasonOf(message);
  const gone = cause === "notFound" || cause === "forbidden";
  return (
    <section className={`${styles.statePanel} ${styles.stateFailed}`}>
      <p className={styles.stateMessage} role="alert">
        {message}
      </p>
      {gone ? (
        <p className={styles.stateHint}>
          {cause === "notFound"
            ? "주소를 다시 확인하거나 행사 목록에서 고르세요."
            : "담당 행사로 지정되어야 볼 수 있습니다. 필요하면 조직 소유자에게 요청하세요."}
        </p>
      ) : null}
      <div className={styles.stateActions}>
        {gone ? (
          <ProductLink className="button button-secondary" href="/console">
            행사 목록으로
          </ProductLink>
        ) : (
          <ProductButton
            type="button"
            className="button button-secondary"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
              onRetry();
            }}
          >
            다시 불러오기
          </ProductButton>
        )}
        {actions}
      </div>
    </section>
  );
}
