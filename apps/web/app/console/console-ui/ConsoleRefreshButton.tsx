"use client";

import ProductButton from "../../ui/ProductButton";

import { useState } from "react";
import { RefreshIcon } from "./ConsoleIcons";
import styles from "./console-ui.module.css";

type ConsoleRefreshButtonProps = {
  label: string;
  onRefresh: () => void | Promise<unknown>;
  busy?: boolean;
  disabled?: boolean;
};

export default function ConsoleRefreshButton({
  label, onRefresh, busy = false, disabled = false,
}: ConsoleRefreshButtonProps) {
  const [pending, setPending] = useState(false);
  const refreshing = busy || pending;

  async function activate() {
    if (refreshing || disabled) return;
    setPending(true);
    try {
      await onRefresh();
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <ProductButton
        type="button"
        className={`button button-quiet console-icon-button ${styles.refreshTool}`}
        aria-label={label}
        title={label}
        busy={refreshing}
        aria-disabled={refreshing || undefined}
        disabled={disabled}
        onClick={() => void activate()}
      >
        <RefreshIcon />
      </ProductButton>
      <span className="sr-only" role="status">{refreshing ? "새로고침 중" : ""}</span>
    </>
  );
}
