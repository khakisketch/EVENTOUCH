"use client";

import ProductButton from "../../ui/ProductButton";

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
};

export default function ConsoleStatePanel({
  kind,
  message,
  onRetry,
  actions,
  shape,
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

  return (
    <section className={`${styles.statePanel} ${styles.stateFailed}`}>
      <p className={styles.stateMessage} role="alert">
        {message}
      </p>
      <div className={styles.stateActions}>
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
        {actions}
      </div>
    </section>
  );
}
