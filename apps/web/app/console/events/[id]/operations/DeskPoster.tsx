"use client";

import QRCode from "react-qr-code";
import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ProductButton from "../../../../ui/ProductButton";
import styles from "./desk-poster.module.css";

// The sign for one entry desk: its QR opens the arrival page for that desk. The paper size is
// whatever the print dialog says; the layout scales to it (owner decision 2026-11-25).
function PosterSheet({ eventName, deskName, url, nametag }: { eventName: string; deskName: string; url: string; nametag: boolean }) {
  return (
    <>
      <p className={styles.desk}>{deskName}</p>
      <h1 className={styles.title}>입장 접수<br />여기를 찍으세요</h1>
      <div className={styles.qr}><QRCode value={url} size={320} level="Q" bgColor="#ffffff" fgColor="#16181c" title={`${deskName} 입장 접수 QR`} /></div>
      <p className={styles.event}>{eventName}</p>
      <ol className={styles.steps}>
        <li>카메라로 찍기</li>
        <li>도착 접수 누르기</li>
        <li>{nametag ? "명찰 받기" : "입장 확인 받기"}</li>
      </ol>
      <p className={styles.fine}>휴대폰이 어려우면 데스크에서 이름을 말씀해 주세요.</p>
    </>
  );
}

export default function DeskPoster({ eventName, slug, deskId, deskName, nametag, publicBase = null, trigger }: {
  eventName: string; slug: string; deskId: string; deskName: string; nametag: boolean; publicBase?: string | null;
  trigger: (open: () => void) => ReactNode;
}) {
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  function open() {
    setError("");
    const base = publicBase ?? window.location.origin;
    setUrl(new URL(`${base}/event/${encodeURIComponent(slug)}/arrive?desk=${encodeURIComponent(deskId)}`).href);
  }
  function print() {
    try {
      window.print();
    } catch {
      setError("인쇄 창을 열지 못했습니다. 브라우저 인쇄 기능을 확인한 뒤 다시 시도해 주세요.");
    }
  }
  return (
    <>
      {trigger(open)}
      {url ? (
        <ConsoleDialog title={`${deskName} 안내판`} description="용지 크기는 인쇄 창에서 고르세요." presentation="drawer" stickyChrome
          onClose={() => setUrl("")}
          footer={<ProductButton type="button" variant="primary" onClick={print}>인쇄하기</ProductButton>}>
          <section className={styles.preview} aria-label="안내판 미리보기">
            <PosterSheet eventName={eventName} deskName={deskName} url={url} nametag={nametag} />
          </section>
          <a className={styles.openLink} href={url} target="_blank" rel="noopener noreferrer">접수 화면 열어 보기</a>
          {error ? <p role="alert">{error}</p> : null}
        </ConsoleDialog>
      ) : null}
      {url ? createPortal(
        <article className={styles.printSheet}><PosterSheet eventName={eventName} deskName={deskName} url={url} nametag={nametag} /></article>,
        document.body
      ) : null}
    </>
  );
}
