"use client";

import QRCode from "react-qr-code";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ProductButton from "../../../../ui/ProductButton";
import styles from "./attendee-guide-qr.module.css";

export default function AttendeeGuideQr({ eventName, slug }: { eventName: string; slug: string }) {
  const [origin, setOrigin] = useState("");
  const [copyMessage, setCopyMessage] = useState("");
  const addressRef = useRef<HTMLInputElement>(null);
  const publicUrl = origin ? new URL(`/event/${encodeURIComponent(slug)}`, origin).href : "";

  async function copyAddress() {
    if (!publicUrl) return;
    setCopyMessage("");
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard is unavailable");
      await navigator.clipboard.writeText(publicUrl);
      setCopyMessage("행사 안내 주소를 복사했습니다.");
    } catch {
      addressRef.current?.focus();
      addressRef.current?.select();
      setCopyMessage("주소를 자동 복사하지 못했습니다. 선택된 주소를 직접 복사해 주세요.");
    }
  }

  function printGuide() {
    try {
      window.print();
    } catch {
      setCopyMessage("인쇄 창을 열지 못했습니다. 브라우저 인쇄 기능을 확인한 뒤 다시 시도해 주세요.");
    }
  }

  return (
    <>
      <ProductButton
        type="button"
        variant="ghost"
        onClick={() => {
          setCopyMessage("");
          setOrigin(window.location.origin);
        }}
        aria-haspopup="dialog"
        aria-expanded={Boolean(publicUrl)}
      >
        행사 안내 QR
      </ProductButton>
      {publicUrl ? (
        <ConsoleDialog
          title="행사 안내 QR"
          titleId="attendee-guide-qr-title"
          description="입구에 안내판을 붙이면 참가자가 휴대폰으로 행사 안내를 열 수 있습니다."
          presentation="drawer"
          stickyChrome
          onClose={() => setOrigin("")}
          footer={(
            <div className={styles.actions}>
              <ProductButton type="button" variant="primary" onClick={printGuide}>
                A4 안내판 인쇄
              </ProductButton>
              <ProductButton type="button" variant="ghost" onClick={() => void copyAddress()}>
                주소 복사
              </ProductButton>
            </div>
          )}
        >
          <section className={styles.preview} aria-label="행사 안내 QR 미리보기">
            <h3 className={styles.eventName}>{eventName}</h3>
            <div className={styles.qrFrame}>
              <QRCode
                value={publicUrl}
                size={256}
                level="Q"
                bgColor="#ffffff"
                fgColor="#16181c"
                title={`${eventName} 행사 안내 QR`}
              />
            </div>
            <label className={styles.addressLabel} htmlFor="attendee-guide-public-url">공개 행사 안내 주소</label>
            <input
              ref={addressRef}
              id="attendee-guide-public-url"
              className={styles.address}
              type="url"
              value={publicUrl}
              readOnly
              onFocus={(event) => event.currentTarget.select()}
              aria-describedby="attendee-guide-url-status"
            />
            <a className={styles.openLink} href={publicUrl} target="_blank" rel="noopener noreferrer">
              행사 안내 페이지 열기
            </a>
            <p id="attendee-guide-url-status" className={styles.copyMessage} role="status" aria-live="polite">
              {copyMessage}
            </p>
          </section>
        </ConsoleDialog>
      ) : null}
      {publicUrl ? createPortal(
        <article className={styles.printSheet}>
          <header>
            <h1>{eventName}</h1>
            <p>휴대폰 카메라로 QR을 스캔해 행사 안내를 확인하세요.</p>
          </header>
          <div className={styles.printQrFrame}>
            <QRCode value={publicUrl} size={320} level="Q" title={`${eventName} 행사 안내 QR`} />
          </div>
          <p>{publicUrl}</p>
        </article>,
        document.body
      ) : null}
    </>
  );
}
