import { Suspense, type ReactNode } from "react";
import Link from "next/link";
import { CONSOLE_PAGES, consolePageHref, type ConsolePageId } from "../console-navigation";
import ConsolePageHeader from "./ConsolePageHeader";
import styles from "./console-ui.module.css";
import EventCloseReturn from "./EventCloseReturn";
import type { CloseSnapshot } from "../console-event-close";

type ConsolePageProps = {
  pageId: ConsolePageId;
  eventId?: string;
  eventName?: string;
  meta?: ReactNode;
  /** Shared header state (stage/intake/D-day); pass-through to the header badges slot. */
  badges?: ReactNode;
  /** Supplementary secondary actions only; primary actions live in the toolbar or form area. */
  headerActions?: ReactNode;
  toolbar?: ReactNode;
  feedback?: ReactNode;
  sectionNav?: ReactNode;
  children: ReactNode;
  className?: string;
  closeSnapshot?: CloseSnapshot;
  closeNoticeStatus?: string;
  closeArchiveControl?: ReactNode;
  closeArchiveOpen?: boolean;
};

/**
 * Shared menu-page frame: one title from the registry, one small event
 * context link, one body rhythm. Domain bodies differ inside; the chrome
 * around them does not.
 *
 * Event pages show `행사 / {eventName}` below the H1, linked to the event
 * overview. There is no repeated giant event H1 and no back row: the rail
 * already owns event navigation. Organization pages render no context row.
 *
 * Hook-free: title and href resolution are pure registry lookups.
 */
export default function ConsolePage({
  pageId,
  eventId,
  eventName,
  meta,
  badges,
  headerActions,
  toolbar,
  feedback,
  sectionNav,
  children,
  className,
  closeSnapshot,
  closeNoticeStatus,
  closeArchiveControl,
  closeArchiveOpen,
}: ConsolePageProps) {
  const page = CONSOLE_PAGES[pageId];
  const overviewHref =
    page.scope === "event" && eventId?.trim()
      ? consolePageHref("overview", eventId)
      : undefined;
  const trimmedName = eventName?.trim();
  const context = overviewHref ? (
    <Link className={styles.contextLink} href={overviewHref}>
      {trimmedName ? `행사 / ${trimmedName}` : "행사"}
    </Link>
  ) : null;

  const classNames = [styles.page, className].filter(Boolean).join(" ");

  return (
    <div className={classNames}>
      <ConsolePageHeader
        title={page.title}
        context={context}
        meta={meta}
        badges={badges}
        actions={headerActions}
      />
      {eventId && ["settings", "participants", "programs", "draws", "messages"].includes(pageId) ? (
        <Suspense fallback={null}><EventCloseReturn eventId={eventId} pageId={pageId} snapshot={closeSnapshot} noticeStatus={closeNoticeStatus} archiveControl={closeArchiveControl} archiveOpen={closeArchiveOpen} /></Suspense>
      ) : null}
      {toolbar ?? null}
      {feedback ?? null}
      {sectionNav ?? null}
      <div className={styles.pageFlow}>{children}</div>
    </div>
  );
}
