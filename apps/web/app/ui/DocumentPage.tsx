import type { ReactNode } from "react";
import Link from "next/link";
import { SUPPORT_EMAIL, supportMailto } from "../../lib/support-contact";
import styles from "./document-page.module.css";

// The plain reading frame shared by /help, /terms and /privacy: a brand row,
// an optional "draft" band, a title, a contents list and sections in a column
// about 40 em wide (roughly 65 Latin characters). Server-rendered, no state.
// The same frame carries the draft notice so no document can drop it by
// accident: the legal texts pass `draft`.
export const DRAFT_NOTICE = "법무 검토 전 초안입니다. 시행일은 정해지지 않았습니다.";

export type DocumentSection = { id: string; title: string; body: ReactNode };

const DOCUMENTS = [
  { key: "help", href: "/help", label: "도움말" },
  { key: "terms", href: "/terms", label: "이용약관" },
  { key: "privacy", href: "/privacy", label: "개인정보처리방침" },
] as const;

export type DocumentKey = (typeof DOCUMENTS)[number]["key"];

export default function DocumentPage({
  current,
  title,
  lead,
  draft = false,
  sections,
}: {
  current: DocumentKey;
  title: string;
  lead: ReactNode;
  draft?: boolean;
  sections: readonly DocumentSection[];
}) {
  return (
    <div className={styles.page}>
      <header className={styles.top}>
        <Link className={styles.brand} href="/">EVENTOUCH</Link>
        <nav className={styles.docNav} aria-label="서비스 안내 문서">
          {DOCUMENTS.map((item) => (
            <Link key={item.key} href={item.href} aria-current={item.key === current ? "page" : undefined}>{item.label}</Link>
          ))}
        </nav>
      </header>
      <main id="main-content" tabIndex={-1} className={styles.main}>
        {draft ? <p className={styles.draft} role="note"><strong>초안</strong> {DRAFT_NOTICE}</p> : null}
        <h1 className={styles.title}>{title}</h1>
        <div className={styles.lead}>{lead}</div>
        <div className={styles.layout}>
          <nav className={styles.toc} aria-label="목차">
            <h2 className={styles.tocTitle}>목차</h2>
            <ol>
              {sections.map((section) => (
                <li key={section.id}><a href={`#${section.id}`}>{section.title}</a></li>
              ))}
            </ol>
          </nav>
          <article className={styles.body}>
            {sections.map((section) => (
              <section key={section.id} id={section.id} aria-labelledby={`${section.id}-title`} className={styles.section}>
                <h2 id={`${section.id}-title`}>{section.title}</h2>
                {section.body}
              </section>
            ))}
          </article>
        </div>
      </main>
      <footer className={styles.foot}>
        <span>문의 <a href={supportMailto()}>{SUPPORT_EMAIL}</a></span>
        <Link href="/">EVENTOUCH 소개로</Link>
      </footer>
    </div>
  );
}

// Building blocks the three documents share, so their pages carry content only.

/** Label and value rows: `<Facts items={[{ term, body }]} />`. */
export function Facts({ items }: { items: readonly { term: string; body: ReactNode }[] }) {
  return (
    <dl className={styles.facts}>
      {items.map((item) => (
        <div key={item.term}>
          <dt>{item.term}</dt>
          <dd>{item.body}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A quiet aside: what is not decided, or what a reader should check. */
export function Note({ children }: { children: ReactNode }) {
  return <div className={styles.note}>{children}</div>;
}

/** One question that opens in place (native disclosure, no script). */
export function Faq({ question, children }: { question: string; children: ReactNode }) {
  return (
    <details className={styles.faq}>
      <summary>{question}</summary>
      <div>{children}</div>
    </details>
  );
}
