import type { ReactNode } from "react";
import RichText from "../../ui/RichText";
import GuideIcon from "./GuideIcon";
import styles from "./public-event.module.css";

export type GuideNotice = {
  id: string;
  title: string;
  body: string;
  pinned?: boolean;
  /** Console preview only: the notice being edited. */
  editing?: boolean;
  /** Console preview only: a note under the body (for example "게시 전 · 초안 미리보기"). */
  footer?: ReactNode;
};

// The notices card of the event guide. Pinned notices lead; the sort is stable,
// so each group keeps its own order. Shared by the public guide and the console
// preview; `editingClassName` is the preview's outline for the notice being edited.
export default function GuideNoticeList({
  notices,
  imageSrc,
  editingClassName,
}: {
  notices: GuideNotice[];
  imageSrc: (fileId: string) => string;
  editingClassName?: string;
}) {
  const ordered = [...notices].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true));
  return (
    <div className={styles.card}>
      <ul className={styles.noticeList}>
        {ordered.map((notice) => (
          <li
            key={notice.id || "new"}
            data-pinned={notice.pinned || undefined}
            data-editing={notice.editing || undefined}
            className={notice.editing ? editingClassName : undefined}
          >
            <span className={styles.noticeIcon} aria-hidden="true"><GuideIcon type="notice" /></span>
            <div className={styles.noticeBody}>
              <h3>
                {notice.pinned ? <span className={styles.pin}>고정</span> : null}
                {notice.title}
              </h3>
              {notice.body ? <RichText source={notice.body} imageSrc={imageSrc} /> : null}
              {notice.footer}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
