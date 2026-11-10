"use client";

import { useEffect, useId, useRef, useState } from "react";
import { createPortal, flushSync } from "react-dom";
import styles from "./name-tag-print.module.css";

export type NameTagIdentity = {
  name: string;
  company: string;
  eventName: string;
  context?: string;
};

const PAPER = {
  a4: "A4 · 잘라 쓰는 네임택",
  label90: "라벨 90 × 60 mm",
  label100: "라벨 100 × 70 mm",
} as const;
type Paper = keyof typeof PAPER;
const PAPER_PREFERENCE = "eventouch.nametag-paper";

function isPaper(value: string | null): value is Paper {
  return value !== null && Object.hasOwn(PAPER, value);
}

export default function NameTagPrint({ identity, onClose, resolveIdentity }: {
  identity: NameTagIdentity;
  onClose?: () => void;
  resolveIdentity?: (signal: AbortSignal) => Promise<NameTagIdentity>;
}) {
  const [paper, setPaper] = useState<Paper>("a4");
  const [fits, setFits] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");
  const [checking, setChecking] = useState(Boolean(resolveIdentity));
  const [verified, setVerified] = useState<NameTagIdentity | null>(resolveIdentity ? null : identity);
  const verifiedRef = useRef<NameTagIdentity | null>(resolveIdentity ? null : identity);
  const resolverRef = useRef(resolveIdentity);
  resolverRef.current = resolveIdentity;
  const requestRef = useRef<AbortController | null>(null);
  const paperId = useId();
  const previewRef = useRef<HTMLElement>(null);
  const artworkRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  const focusOnOpen = Boolean(onClose);

  // A staff label must not fall back to an old roster when the latest read
  // fails. The name and check-in result remain outside this component.
  useEffect(() => {
    if (resolverRef.current) void verify(false);
    return () => { requestRef.current?.abort(); requestRef.current = null; };
    // A new preview is mounted for each scan; the latest resolver is kept in a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (focusOnOpen) previewRef.current?.focus();
  }, [focusOnOpen]);

  useEffect(() => {
    if (resolverRef.current) return;
    verifiedRef.current = identity;
    setVerified(identity);
  }, [identity.name, identity.company, identity.eventName, identity.context]);

  useEffect(() => {
    try {
      const saved = sessionStorage.getItem(PAPER_PREFERENCE);
      if (isPaper(saved)) setPaper(saved);
    } catch {
      // The default remains usable with storage disabled.
    }
  }, []);

  useEffect(() => {
    const artwork = artworkRef.current;
    const text = textRef.current;
    if (!artwork || !text) return;
    function measure() {
      if (!artwork || !artwork.clientWidth) return;
      setFits(paper === "a4" || (artwork.scrollHeight <= artwork.clientHeight + 1 && artwork.scrollWidth <= artwork.clientWidth + 1));
    }
    const observer = new ResizeObserver(measure);
    observer.observe(artwork);
    observer.observe(text);
    measure();
    return () => observer.disconnect();
  }, [paper, verified?.name, verified?.company, verified?.eventName, verified?.context]);

  useEffect(() => {
    const finishPrint = () => {
      document.body.classList.remove("nametag-printing");
      setPrinting(false);
    };
    window.addEventListener("afterprint", finishPrint);
    return () => {
      window.removeEventListener("afterprint", finishPrint);
      document.body.classList.remove("nametag-printing");
    };
  }, []);

  function openPrint() {
    if (printing || !fits) return;
    setError("");
    // Mount the isolated output before opening the native print dialog. Each
    // attempt re-arms it, including after cancelling or printing once.
    flushSync(() => setPrinting(true));
    document.body.classList.add("nametag-printing");
    try {
      window.print();
    } catch {
      document.body.classList.remove("nametag-printing");
      setPrinting(false);
      setError("인쇄 창을 열지 못했습니다. 이 브라우저의 인쇄 기능을 확인한 뒤 다시 시도하세요.");
    }
  }

  async function verify(thenPrint: boolean) {
    const resolver = resolverRef.current;
    if (!resolver || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setChecking(true);
    setError("");
    try {
      const latest = await resolver(controller.signal);
      if (controller.signal.aborted || requestRef.current !== controller) return;
      const changed = JSON.stringify(latest) !== JSON.stringify(verifiedRef.current);
      verifiedRef.current = latest;
      setVerified(latest);
      if (thenPrint && changed) {
        setError("참가자 정보가 바뀌었습니다. 미리보기를 확인한 뒤 다시 인쇄해 주세요.");
      } else if (thenPrint) {
        openPrint();
      }
    } catch (failure) {
      if (controller.signal.aborted || requestRef.current !== controller) return;
      verifiedRef.current = null;
      setVerified(null);
      setError(failure instanceof Error ? failure.message : "최신 참가자 정보를 확인하지 못했습니다. 다시 확인해 주세요.");
    } finally {
      if (requestRef.current === controller) { requestRef.current = null; setChecking(false); }
    }
  }

  function print() {
    if (checking || printing || !fits || !verified) return;
    if (resolverRef.current) void verify(true);
    else openPrint();
  }

  const labelText = (
    <>
      <p className={styles.event}>{verified?.eventName}</p>
      <p className={styles.name} data-long={(verified?.name.length || 0) > 14 || undefined}>{verified?.name}</p>
      {verified?.company ? <p className={styles.company} data-long={verified.company.length > 38 || undefined}>{verified.company}</p> : null}
      {verified?.context ? <p className={styles.context}>{verified.context}</p> : null}
    </>
  );

  return (
    <section className={styles.preview} aria-label="네임택 미리보기" ref={previewRef} tabIndex={-1} data-paper={paper}>
      {onClose ? <h3 className={styles.title}>네임택 미리보기</h3> : null}
      <div className={styles.paperChoice}>
        <label htmlFor={paperId}>용지 규격</label>
        <select id={paperId} value={paper} onChange={(event) => {
          const next = event.target.value;
          if (!isPaper(next)) return;
          setPaper(next);
          try { sessionStorage.setItem(PAPER_PREFERENCE, next); } catch { /* optional preference */ }
          setError("");
        }}>
          {Object.entries(PAPER).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </div>
      {verified ? <div className={styles.artworkFrame}>
        <div className={styles.artwork} ref={artworkRef}>
          <div className={styles.artworkText} ref={textRef}>{labelText}</div>
        </div>
      </div> : null}
      {checking ? <p className={styles.help} role="status">최신 참가자 정보를 확인하고 있습니다.</p> : null}
      <p className={styles.help}>인쇄 창에서 같은 용지 규격과 100% 배율을 확인하세요.</p>
      {!fits ? <p className={styles.warning} role="status">문구가 라벨에 모두 들어가지 않습니다. 큰 라벨이나 A4를 선택하세요.</p> : null}
      {error ? <p className={styles.warning} role="alert">{error}</p> : null}
      <div className={styles.actions}>
        {resolveIdentity && !verified && !checking ? <button type="button" className="button button-secondary" onClick={() => void verify(false)}>최신 정보 다시 확인</button> : null}
        <button type="button" className="button button-primary" disabled={!verified || !fits || printing || checking} onClick={print}>인쇄하기</button>
        {onClose ? <button type="button" className="button button-secondary" onClick={onClose}>닫기</button> : null}
      </div>
      {printing ? createPortal(
        <div className={styles.printRoot} data-paper={paper} data-nametag-output="">
          <div className={styles.artworkFrame}>
            <div className={styles.artwork}><div className={styles.artworkText}>{labelText}</div></div>
          </div>
        </div>,
        document.body
      ) : null}
    </section>
  );
}
