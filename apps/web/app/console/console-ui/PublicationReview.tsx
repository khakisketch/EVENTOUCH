"use client";

import type { ReactNode } from "react";
import ConsoleDialog from "./ConsoleDialog";
import styles from "./publication-review.module.css";

export type PublicationChange = { label: string; before: string; after: string };
export type PublicationDestination = { label: string; detail: string; href?: string; warning?: boolean };

/** Shared final review for saved content. The caller owns revisions and writes. */
export default function PublicationReview({ title, description, changes, destinations, busy, disabled, error, onConfirm, onClose, confirmLabel = "게시하기", children }: {
  title: string;
  description: string;
  changes: PublicationChange[];
  destinations: PublicationDestination[];
  busy: boolean;
  disabled?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
  confirmLabel?: string;
  children?: ReactNode;
}) {
  const changed = changes.filter(change => change.before !== change.after);
  const unchanged = changes.filter(change => change.before === change.after);
  const renderChange = (change: PublicationChange) => <div className={styles.change} key={change.label} data-changed={change.before !== change.after}>
    <dt>{change.label}</dt>
    <dd><span className={styles.mobileLabel}>현재 게시본</span>{change.before || "없음"}</dd>
    <dd><span className={styles.mobileLabel}>반영할 내용</span>{change.after || "없음"}</dd>
  </div>;
  return (
    <ConsoleDialog title={title} description={description ? <span className={styles.description}>{description}</span> : undefined} onClose={onClose} busy={busy} wide stickyChrome
      footer={<div className={styles.actions}>
        {error ? <p role="alert" className={styles.actionError}>{error}</p> : null}
        <button type="button" className="button button-secondary" disabled={busy} onClick={onClose}>돌아가기</button>
        <button type="button" className="button button-primary" disabled={busy || disabled} onClick={onConfirm}>{busy ? "반영 중…" : confirmLabel}</button>
      </div>}>
      <section aria-labelledby="publication-destinations" className={styles.destinations}>
        <h3 id="publication-destinations">반영 위치</h3>
        <ul>{destinations.map(destination => <li key={destination.label}>
          <strong>{destination.label}</strong>
          <p className={destination.warning ? styles.warning : undefined}>{destination.detail}</p>
          {destination.href ? <a href={destination.href} target="_blank" rel="noopener noreferrer">화면 열기 <span className="sr-only">({destination.label}, 새 창)</span></a> : null}
        </li>)}</ul>
      </section>
      <section aria-labelledby="publication-changes" className={styles.changes}>
        <h3 id="publication-changes">게시 전 비교</h3>
        {changes.length ? <div className={styles.legend} aria-hidden="true"><span>항목</span><span>현재 게시본</span><span>반영할 내용</span></div> : null}
        <dl>{changed.map(renderChange)}</dl>
        {unchanged.length ? <details className={styles.unchanged}>
          <summary>변경 없는 항목 {unchanged.length}개</summary>
          <dl>{unchanged.map(renderChange)}</dl>
        </details> : null}
      </section>
      {children}
    </ConsoleDialog>
  );
}
