"use client";

import { useEffect, useRef, useState, type MouseEvent, type SubmitEvent } from "react";
import { SUPPORT_EMAIL, supportMailto } from "../lib/support-contact";
import styles from "./landing-inquiry.module.css";

// The landing's inquiry dialog (owner request 2026-11-25). There is no inquiry server yet, so
// nothing is stored or sent by this site and nothing claims to be received: submitting opens the
// visitor's own mail app with the answers filled in, and the dialog says that pressing send there
// is what delivers it. Replace `deliver` when a server path exists (it then needs a consent step).
export const EVENT_KINDS = ["컨퍼런스·세미나", "입장 통제 행사", "교육·설명회", "그 밖의 행사"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

const SIZES = ["50명 이하", "50~200명", "200~500명", "500명 이상"] as const;
const SUBJECT = "EVENTOUCH 도입 문의";

function composeBody(data: FormData) {
  const value = (key: string) => String(data.get(key) ?? "").trim() || "-";
  return [
    `행사 종류: ${value("kind")}`,
    `일정: ${value("when")}`,
    `예상 인원: ${value("size")}`,
    `이름: ${value("name")}`,
    `회사·기관: ${value("company")}`,
    `회신받을 연락처: ${value("contact")}`,
    "",
    "궁금한 점:",
    value("message"),
  ].join("\n");
}

function mailHref(body: string) {
  return `${supportMailto(SUBJECT)}&body=${encodeURIComponent(body)}`;
}

export default function LandingInquiry({ open, kind, onClose }: { open: boolean; kind: EventKind | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosenKind, setChosenKind] = useState<string>("");
  const [body, setBody] = useState<string | null>(null);
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);

  useEffect(() => {
    const el = dialog.current;
    if (!el) return;
    if (open && !el.open) {
      if (kind) setChosenKind(kind);
      setBody(null);
      setCopied(null);
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open, kind]);

  // The page behind stays where it is while the dialog is open.
  useEffect(() => {
    if (!open) return;
    const root = document.documentElement;
    const previous = root.style.overflow;
    root.style.overflow = "hidden";
    return () => { root.style.overflow = previous; };
  }, [open]);

  function deliver(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const composed = composeBody(new FormData(event.currentTarget));
    setBody(composed);
    setCopied(null);
    window.location.href = mailHref(composed);
  }

  async function copyBody() {
    try {
      await navigator.clipboard.writeText(`받는 사람: ${SUPPORT_EMAIL}\n제목: ${SUBJECT}\n\n${body ?? ""}`);
      setCopied("done");
    } catch {
      setCopied("failed");
    }
  }

  // A press on the dimmed backdrop lands on the dialog element itself.
  function onBackdrop(event: MouseEvent<HTMLDialogElement>) {
    if (event.target === dialog.current) onClose();
  }

  return (
    <dialog ref={dialog} className={styles.dialog} aria-labelledby="inquiry-title" onClose={onClose} onClick={onBackdrop}>
      <div className={styles.sheet}>
        <div className={styles.head}>
          <div>
            <h2 id="inquiry-title">도입 문의</h2>
            <p>몇 가지만 적어 주시면 맞는 운영 방식을 제안합니다.</p>
          </div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="문의 창 닫기">
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M5 5l10 10M15 5L5 15" /></svg>
          </button>
        </div>

        {/* The form stays mounted after sending so "내용 고치기" keeps what was typed. */}
        <form className={styles.form} onSubmit={deliver} hidden={body !== null}>
          <fieldset className={styles.group}>
            <legend>행사 종류</legend>
            <div className={styles.chips}>
              {EVENT_KINDS.map((item) => (
                <label key={item}>
                  <input type="radio" name="kind" value={item} checked={chosenKind === item} onChange={() => setChosenKind(item)} />
                  <span>{item}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className={styles.group}>
            <legend>예상 인원</legend>
            <div className={styles.chips}>
              {SIZES.map((item) => (
                <label key={item}>
                  <input type="radio" name="size" value={item} />
                  <span>{item}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <label className={styles.field}>
            <span>일정</span>
            <input name="when" type="text" placeholder="예: 3월 둘째 주, 하루" maxLength={80} />
          </label>
          <div className={styles.pair}>
            <label className={styles.field}>
              <span>이름 <em>필수</em></span>
              <input name="name" type="text" autoComplete="name" required maxLength={40} />
            </label>
            <label className={styles.field}>
              <span>회사·기관</span>
              <input name="company" type="text" autoComplete="organization" maxLength={60} />
            </label>
          </div>
          <label className={styles.field}>
            <span>회신받을 연락처 <em>필수</em></span>
            <input name="contact" type="text" autoComplete="email" required maxLength={80} placeholder="이메일 또는 휴대폰 번호" />
          </label>
          <label className={styles.field}>
            <span>궁금한 점</span>
            <textarea name="message" rows={2} maxLength={600} />
          </label>
          <button type="submit" className={styles.submit}>문의 메일 작성하기</button>
          <p className={styles.note}>메일 앱이 열리고, 거기서 보내기를 눌러야 전달됩니다. 입력한 내용은 이 사이트에 저장되지 않습니다.</p>
        </form>

        {body !== null ? (
          <div className={styles.done} role="status">
            <h3>메일 앱에서 보내기를 눌러 주세요.</h3>
            <p>작성한 내용을 담은 메일을 열었습니다. 열리지 않으면 아래 내용을 복사해 <strong>{SUPPORT_EMAIL}</strong>로 보내 주세요.</p>
            <pre tabIndex={0} role="region" aria-label="작성한 문의 내용">{body}</pre>
            <div className={styles.doneActions}>
              <a className={styles.submit} href={mailHref(body)}>메일 앱 다시 열기</a>
              <button type="button" className={styles.plain} onClick={() => void copyBody()}>작성 내용 복사</button>
              <button type="button" className={styles.plain} onClick={() => setBody(null)}>내용 고치기</button>
            </div>
            {copied ? <p className={styles.note}>{copied === "done" ? "받는 사람과 내용을 복사했습니다." : "복사하지 못했습니다. 위 내용을 직접 선택해 복사해 주세요."}</p> : null}
          </div>
        ) : null}
      </div>
    </dialog>
  );
}
