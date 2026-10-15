"use client";

import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

type ConsoleStatePanelProps = {
  kind: "loading" | "failed";
  message: string;
  onRetry: () => void;
  actions?: ReactNode;
};

export default function ConsoleStatePanel({
  kind,
  message,
  onRetry,
  actions,
}: ConsoleStatePanelProps) {
  const loading = kind === "loading";

  return (
    <section
      className={`${styles.statePanel} ${loading ? styles.stateLoading : styles.stateFailed}`}
      aria-busy={loading}
    >
      <p className={styles.stateMessage} role={loading ? "status" : "alert"}>
        {message}
      </p>
      {!loading ? (
        <div className={styles.stateActions}>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => {
              window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
              onRetry();
            }}
          >
            다시 불러오기
          </button>
          {actions}
        </div>
      ) : null}
    </section>
  );
}
