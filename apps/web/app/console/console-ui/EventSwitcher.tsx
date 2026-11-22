"use client";

// 행사 바꾸기, lives in the menu (owner decision 2026-11-21, board 9 of the mobile
// usability mockups): the current-event card of the desktop rail and of the phone
// drawer is the switch control, so event pages no longer carry a "다른 행사" button
// beside the title. The card is the trigger; the panel lists events grouped by
// stage, marks the current one, and opens the same menu page of the chosen event.
// The directory loads once, on first open (never from an effect keyed to load
// state), and a search field appears only when there are more than six events.

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "../../ui/ProductLink";
import { eventStageLabel } from "../../event-stage";
import { consoleFetch } from "../../../lib/console-api";
import { consolePageHref, type ConsolePageId } from "../console-navigation";
import styles from "./event-switcher.module.css";

type SwitchEvent = { id: string; name: string; date: string; stage: string };
type LoadState = { kind: "idle" } | { kind: "loading" } | { kind: "failed" } | { kind: "ready"; events: SwitchEvent[] };
type Group = { key: "live" | "wait" | "end" | "other"; label: string; events: SwitchEvent[] };

export const SEARCH_THRESHOLD = 6;

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

function parseEvents(payload: unknown): SwitchEvent[] {
  const directory = asRecord(asRecord(payload)?.directory);
  if (!Array.isArray(directory?.events)) return [];
  return directory.events.flatMap((item) => {
    const event = asRecord(item);
    if (typeof event?.id !== "string" || !event.id) return [];
    return [{
      id: event.id,
      name: typeof event.name === "string" && event.name.trim() ? event.name : event.id,
      date: typeof event.date === "string" ? event.date : "",
      stage: typeof event.stage === "string" ? event.stage : "",
    }];
  });
}

/** Stage → group the way operators talk about it: running, getting ready, over. */
export function stageGroupKey(stage: string): Group["key"] {
  const value = stage.toUpperCase();
  if (value === "LIVE") return "live";
  if (value === "DRAFT" || value === "READY") return "wait";
  if (value === "ENDED" || value === "ARCHIVED") return "end";
  return "other";
}

const GROUP_LABELS: Array<[Group["key"], string]> = [["live", "진행 중"], ["wait", "준비 중"], ["end", "종료"], ["other", "기타"]];

export function groupEvents(events: SwitchEvent[], eventId: string, query: string): Group[] {
  const needle = query.trim().toLowerCase();
  const visible = needle ? events.filter((event) => event.name.toLowerCase().includes(needle)) : events;
  return GROUP_LABELS.map(([key, label]) => ({
    key,
    label,
    events: visible.filter((event) => stageGroupKey(event.stage) === key)
      .sort((a, b) => Number(b.id === eventId) - Number(a.id === eventId)),
  })).filter((group) => group.events.length > 0);
}

type Props = {
  eventId: string;
  pageId: ConsolePageId;
  /** "rail": a popover beside the desktop rail. "drawer": opens inline inside the phone menu. */
  variant: "rail" | "drawer";
  /** The current-event card; it is the control itself. */
  children: ReactNode;
};

export default function EventSwitcher({ eventId, pageId, variant, children }: Props) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const [query, setQuery] = useState("");
  const [anchor, setAnchor] = useState<CSSProperties | undefined>(undefined);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);

  // Load on open, not in an effect keyed to load state: a state change must
  // never abort the request it was waiting for. A failed load retries on reopen.
  const loadEvents = async () => {
    setLoad({ kind: "loading" });
    try {
      const response = await consoleFetch("/api/console/directory", { cache: "no-store" });
      const events = response.ok ? parseEvents(await response.json().catch(() => null)) : null;
      setLoad(events ? { kind: "ready", events } : { kind: "failed" });
    } catch {
      setLoad({ kind: "failed" });
    }
  };

  // The rail scrolls and clips, so the popover is positioned from the card instead of inside it.
  const anchorFromCard = (): CSSProperties | undefined => {
    if (!trigger.current) return undefined;
    const rect = trigger.current.getBoundingClientRect();
    const rail = trigger.current.closest("aside")?.getBoundingClientRect();
    return { top: Math.max(8, rect.top), left: Math.max(rect.right, rail?.right ?? 0) + 8, maxHeight: `calc(100vh - ${Math.max(8, rect.top) + 16}px)` };
  };

  const toggle = () => {
    const next = !open;
    if (next && variant === "rail") setAnchor(anchorFromCard());
    setOpen(next);
    if (next && load.kind !== "ready" && load.kind !== "loading") void loadEvents();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target as Node;
      if (root.current && !root.current.contains(target) && !panelRef.current?.contains(target)) setOpen(false);
    };
    const onViewport = () => { if (variant === "rail") setOpen(false); };
    // The popover is anchored to the card, so a scroll outside the panel (the page, or the
    // rail itself) moves the card and the popover follows it; once the card has left the
    // screen there is nothing to anchor to and the popover closes. Following instead of
    // closing also survives a smooth scroll still running when the popover opens.
    let frame = 0;
    const follow = () => {
      frame = 0;
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect || rect.bottom <= 0 || rect.top >= window.innerHeight) { setOpen(false); return; }
      setAnchor(anchorFromCard());
    };
    const onScroll = (event: Event) => {
      const target = event.target;
      if (variant !== "rail" || (target instanceof Node && panelRef.current?.contains(target))) return;
      if (!frame) frame = window.requestAnimationFrame(follow);
    };
    document.addEventListener("pointerdown", onPointer);
    window.addEventListener("resize", onViewport);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("resize", onViewport);
      window.removeEventListener("scroll", onScroll, true);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [open, variant]);

  // Escape and choosing an event close through here so keyboard focus returns to the
  // card instead of falling to <body> when the focused link unmounts. An outside click
  // does not: focus belongs to whatever the pointer landed on.
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  const events = load.kind === "ready" ? load.events : [];
  const searchable = events.length > SEARCH_THRESHOLD;
  const groups = groupEvents(events, eventId, searchable ? query : "");

  const panel = (
        <nav ref={panelRef} id={`${id}-panel`} aria-label="행사 바꾸기" className={styles.panel} data-variant={variant} style={variant === "rail" ? anchor : undefined}>
          {load.kind === "loading" || load.kind === "idle" ? (
            <p className={styles.note} role="status">행사 목록을 불러오는 중입니다.</p>
          ) : load.kind === "failed" ? (
            <p className={styles.note} role="alert">
              행사 목록을 불러오지 못했습니다. <button type="button" className={styles.retry} onClick={() => void loadEvents()}>다시 시도</button>
            </p>
          ) : load.events.length === 0 ? (
            <p className={styles.note}>바꿀 수 있는 행사가 없습니다.</p>
          ) : (
            <>
              {searchable ? (
                <label className={styles.search}>
                  <span className="sr-only">행사 이름으로 찾기</span>
                  <input type="search" placeholder="행사 이름으로 찾기" value={query} onChange={(event) => setQuery(event.target.value)} />
                </label>
              ) : null}
              <div className={styles.groups}>
                {groups.length === 0 ? <p className={styles.note} role="status">찾는 행사가 없습니다.</p> : null}
                {groups.map((group) => (
                  <section key={group.key} aria-label={group.label} className={styles.group}>
                    <p className={styles.groupLabel}>{group.label}</p>
                    <ul className={styles.list}>
                      {group.events.map((event) => {
                        const current = event.id === eventId;
                        const href = consolePageHref(pageId, event.id) ?? consolePageHref("overview", event.id) ?? "/console";
                        return (
                          <li key={event.id}>
                            <Link className={styles.item} href={href} aria-current={current ? "true" : undefined} onClick={close}>
                              <span className={styles.itemText}>
                                <span className={styles.itemName}>{event.name}</span>
                                <span className={styles.itemMeta}>{event.date ? event.date.replace(/-/g, ".") : "일정 미정"}</span>
                              </span>
                              <span className={styles.pill} data-tone={group.key}>{eventStageLabel(event.stage)}</span>
                              {current ? <span className={styles.check} role="img" aria-label="현재 행사" /> : null}
                            </Link>
                          </li>
                        );
                      })}
                    </ul>
                  </section>
                ))}
              </div>
            </>
          )}
          <Link className={styles.all} href="/console">전체 행사 목록</Link>
        </nav>
  );

  return (
    <div ref={root} className={styles.root} data-variant={variant}
      onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
      <button ref={trigger} type="button" className={styles.trigger} aria-expanded={open} aria-controls={`${id}-panel`} onClick={toggle}>
        <span className={styles.triggerBody}>{children}</span>
        <span className="sr-only">행사 바꾸기</span>
        <span aria-hidden="true" className={styles.chevron} />
      </button>
      {open ? (variant === "rail" && typeof document !== "undefined" ? createPortal(panel, document.body) : panel) : null}
    </div>
  );
}
