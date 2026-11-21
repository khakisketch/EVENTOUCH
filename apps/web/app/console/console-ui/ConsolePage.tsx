import { VStack } from "@astryxdesign/core/VStack";
import { Suspense, type ReactNode } from "react";
import Link from "../../ui/ProductLink";
import { CONSOLE_PAGES, consolePageHref, type ConsolePageId } from "../console-navigation";
import ConsolePageHeader from "./ConsolePageHeader";
import styles from "./console-ui.module.css";
import EventCloseReturn from "./EventCloseReturn";
import type { CloseSnapshot } from "../console-event-close";

type ConsolePageProps = {
  pageId: ConsolePageId;
  /** A nested task may keep its parent menu active while naming its own page. */
  title?: string;
  parentContext?: { href: string; label: string };
  eventId?: string;
  eventName?: string;
  meta?: ReactNode;
  /** Shared header state (stage/intake/D-day); pass-through to the header badges slot. */
  badges?: ReactNode;
  /** Page-level actions such as creation; contextual writes stay with their task. */
  headerActions?: ReactNode;
  /** A frame element that belongs under the title, e.g. the 참가자 화면 tab row. */
  afterHeader?: ReactNode;
  toolbar?: ReactNode;
  feedback?: ReactNode;
  sectionNav?: ReactNode;
  /** Optional local task index beside the page body on wide screens. */
  sectionLayout?: "stack" | "sidebar";
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
  title,
  parentContext,
  eventId,
  eventName,
  meta,
  badges,
  headerActions,
  afterHeader,
  toolbar,
  feedback,
  sectionNav,
  sectionLayout = "stack",
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
    <>
      <Link className={styles.contextLink} href={overviewHref}>
        {trimmedName ? `행사 / ${trimmedName}` : "행사"}
      </Link>
      {parentContext ? <> <span aria-hidden="true"> / </span> <Link className={styles.contextLink} href={parentContext.href}>{parentContext.label}</Link></> : null}
    </>
  ) : null;

  const classNames = [styles.page, className].filter(Boolean).join(" ");

  return (
    <VStack gap={5} className={classNames} data-console-page={pageId}>
      <ConsolePageHeader
        title={title ?? page.title}
        context={context}
        meta={meta}
        badges={badges}
        actions={headerActions}
      />
      {afterHeader ?? null}
      {eventId && ["settings", "participants", "programs", "draws", "messages"].includes(pageId) ? (
        <Suspense fallback={null}><EventCloseReturn eventId={eventId} pageId={pageId} snapshot={closeSnapshot} noticeStatus={closeNoticeStatus} archiveControl={closeArchiveControl} archiveOpen={closeArchiveOpen} /></Suspense>
      ) : null}
      {toolbar ?? null}
      {feedback ?? null}
      {sectionLayout === "sidebar" ? (
        <div className={styles.pageWithIndex}>
          {sectionNav ?? null}
          <div className={styles.pageFlow}>{children}</div>
        </div>
      ) : (
        <>
          {sectionNav ?? null}
          <div className={styles.pageFlow}>{children}</div>
        </>
      )}
    </VStack>
  );
}
