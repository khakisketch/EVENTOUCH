"use client";

// "다른 행사" switcher beside the event name in the page context row.
// Loads the directory once, on first open, and links to the same menu page
// of the chosen event. Replaces going back to the event list just to change
// the live event (proposal A in design-review/event-switcher-options.html).

import { useEffect, useId, useRef, useState } from "react";
import Link from "../../ui/ProductLink";
import { eventStageLabel } from "../../event-stage";
import { consoleFetch } from "../../../lib/console-api";
import { consolePageHref, type ConsolePageId } from "../console-navigation";
import styles from "./event-switcher.module.css";

type SwitchEvent = { id: string; name: string; date: string; stage: string };
type LoadState = { kind: "idle" } | { kind: "loading" } | { kind: "failed" } | { kind: "ready"; events: SwitchEvent[] };

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

export default function EventSwitcher({ eventId, pageId }: { eventId: string; pageId: ConsolePageId }) {
  const [open, setOpen] = useState(false);
  const [load, setLoad] = useState<LoadState>({ kind: "idle" });
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
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

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && load.kind !== "ready" && load.kind !== "loading") void loadEvents();
  };

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [open]);

  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };

  return (
    <div ref={root} className={styles.root} onKeyDown={(event) => { if (event.key === "Escape" && open) { event.stopPropagation(); close(); } }}>
      <button ref={trigger} type="button" className={styles.trigger} aria-expanded={open} aria-controls={`${id}-panel`}
        onClick={toggle}>
        다른 행사
        <span aria-hidden="true" className={styles.chevron}>▾</span>
      </button>
      {open ? (
        <nav id={`${id}-panel`} aria-label="행사 바꾸기" className={styles.panel}>
          {load.kind === "loading" || load.kind === "idle" ? (
            <p className={styles.note} role="status">행사 목록을 불러오는 중입니다.</p>
          ) : load.kind === "failed" ? (
            <p className={styles.note} role="alert">
              행사 목록을 불러오지 못했습니다. <button type="button" className={styles.retry} onClick={() => void loadEvents()}>다시 시도</button>
            </p>
          ) : load.events.length === 0 ? (
            <p className={styles.note}>바꿀 수 있는 행사가 없습니다.</p>
          ) : (
            <ul className={styles.list}>
              {[...load.events].sort((a, b) => Number(b.id === eventId) - Number(a.id === eventId)).map((event) => {
                const current = event.id === eventId;
                const href = consolePageHref(pageId, event.id) ?? consolePageHref("overview", event.id) ?? "/console";
                return (
                  <li key={event.id}>
                    <Link className={styles.item} href={href} aria-current={current ? "true" : undefined} onClick={() => setOpen(false)}>
                      <span className={styles.itemName}>{event.name}</span>
                      <span className={styles.itemMeta}>
                        {eventStageLabel(event.stage)}{event.date ? ` · ${event.date.replace(/-/g, ".")}` : ""}
                      </span>
                      {current ? <span className={styles.current}>현재</span> : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
          <Link className={styles.all} href="/console">전체 행사 목록</Link>
        </nav>
      ) : null}
    </div>
  );
}
