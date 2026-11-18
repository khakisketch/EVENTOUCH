"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./public-event.module.css";

export default function AddressCopyButton({ address }: { address: string }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState("");
  const [manualFallback, setManualFallback] = useState(false);

  useEffect(() => {
    if (!manualFallback) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [manualFallback]);

  async function copyAddress() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(address);
      setManualFallback(false);
      setStatus("주소를 복사했습니다.");
    } catch {
      setManualFallback(true);
      setStatus("자동 복사에 실패했습니다. 선택된 주소를 복사해 사용하세요.");
    }
  }

  return (
    <span className={styles.addressCopy}>
      {manualFallback ? (
        <input
          ref={inputRef}
          className={styles.addressValue}
          type="text"
          readOnly
          value={address}
          aria-label="복사할 행사장 주소"
          onFocus={(event) => event.currentTarget.select()}
          onClick={(event) => event.currentTarget.select()}
        />
      ) : <span className={styles.address}>{address}</span>}
      <button className={styles.addressButton} type="button" onClick={() => void copyAddress()}>
        주소 복사
      </button>
      {status ? <span className={styles.addressStatus} role="status" aria-live="polite">{status}</span> : null}
    </span>
  );
}
