"use client";

import ProductButton from "../../ui/ProductButton";

import { useEffect, useRef, useState } from "react";
import styles from "./console-ui.module.css";

/** Client navigation can change a fragment without firing the browser hashchange event. */
export function requestConsoleTask(id: string, focus = false) {
  window.dispatchEvent(new CustomEvent("eventouch:workspace-navigate", { detail: { id, focus } }));
}

export type ConsoleSectionNavItem = {
  /** Must match an existing section heading id on the page. */
  id: string;
  label: string;
  /** Encoded URL fragment for a tab with a separately addressable record. */
  fragment?: string;
  /** Optional visible grouping within a single persistent task list. */
  group?: string;
};

type ConsoleSectionNavProps = {
  items: readonly ConsoleSectionNavItem[];
  /** Persistent panels: switching never unmounts a form or pending request. */
  mode?: "anchors" | "tabs";
  initialId?: string;
  label?: string;
  /**
   * Id of the section currently in view. The matching link alone carries
   * `aria-current="location"` with a token-only active style (background
   * plus a non-color signal), so the current position reads once, in the
   * links themselves. Omitted by pages without section tracking, which
   * keep rendering a regular nav with no current marker.
   */
  activeId?: string;
  /**
   * Fired when the operator explicitly jumps through a link (mouse, touch,
   * or keyboard activation), once the target section resolves. Lets the
   * page name the jumped-to section at once instead of waiting for the
   * scroll spy, which cannot see headings parked outside its band.
   */
  onNavigate?: (id: string) => void;
};

/**
 * In-page jump links to existing section headings. Native anchors only,
 * not app navigation. Renders nothing when there are no items so empty
 * pages keep no dead space.
 *
 * Activating a link makes the target focusable and hands focus to it
 * directly, so the browser hands focus to the section it jumped to and the
 * next Tab continues inside it instead of back at the top of the page. The
 * fragment still changes, so a section can be copied and reopened.
 */
export default function ConsoleSectionNav({ items, label, activeId, onNavigate, mode = "anchors", initialId }: ConsoleSectionNavProps) {
  const navRef = useRef<HTMLElement>(null);
  const [selected, setSelected] = useState(initialId ?? items[0]?.id);
  const navigateRef = useRef(onNavigate);
  navigateRef.current = onNavigate;
  const ids = items.map((item) => item.id).join("|");
  const activateRef = useRef<(id: string) => void>(() => {});
  const grouped = mode === "tabs" && items.length > 0 && items.every((item) => item.group);
  const [verticalTabs, setVerticalTabs] = useState(false);

  useEffect(() => {
    if (!grouped) return;
    const query = window.matchMedia("(min-width: 1024px)");
    const update = () => setVerticalTabs(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [grouped]);

  useEffect(() => {
    if (mode !== "tabs") return;
    const root = navRef.current?.closest("[data-console-page]");
    if (!root) return;
    const panels = new Map<string, HTMLElement>();
    let active = initialId ?? ids.split("|")[0];
    let knownHash: string | undefined;
    function activate(id: string) {
      if (!panels.has(id)) return;
      active = id;
      for (const [key, panel] of panels) {
        panel.hidden = key !== id;
        panel.setAttribute("role", "tabpanel");
        panel.id = `${key}-panel`;

      }
      setSelected(id);
    }
    activateRef.current = activate;
    function fromHash() {
      knownHash = location.hash;
      let hash = "";
      try { hash = decodeURIComponent(location.hash.slice(1)); } catch { return; }
      const repeated = hash.split("#");
      if (repeated.length > 1 && repeated.every((part) => part === repeated[0]) && panels.has(repeated[0])) hash = repeated[0];
      const target = hash ? document.getElementById(hash) : null;
      const section = target?.closest<HTMLElement>("[data-workspace-section]");
      // The reports screen addresses one selected report as #report-<id>
      // (no real element carries that literal id); without a matching
      // data-workspace-section ancestor, fall back to its one content panel.
      const id = section?.dataset.workspaceSection ?? (/^report-/.test(hash) && panels.has("reports-list") ? "reports-list" : undefined);
      if (id && panels.has(id)) activate(id);
    }
    function register() {
      let newPanel = false;
      for (const id of ids.split("|")) {
        const section = document.getElementById(id)?.closest<HTMLElement>("[data-workspace-section]");
        if (section && root?.contains(section)) {
          if (panels.get(id) !== section) newPanel = true;
          panels.set(id, section);
        }
      }
      activate(panels.has(active) ? active : [...panels.keys()][0]);
      if (newPanel || knownHash !== location.hash) fromHash();
    }
    register();
    // Conditional detail panels can appear after a report is selected.
    const observer = new MutationObserver(register);
    observer.observe(root, { childList: true, subtree: true });
    window.addEventListener("hashchange", fromHash);
    window.addEventListener("popstate", fromHash);
    const onTaskNavigate = (event: Event) => {
      const request = (event as CustomEvent<{ id?: unknown; focus?: boolean }>).detail;
      if (typeof request?.id !== "string" || !panels.has(request.id)) return;
      activate(request.id);
      if (request.focus) {
        const heading = document.getElementById(request.id);
        heading?.setAttribute("tabindex", "-1");
        heading?.focus({ preventScroll: true });
        heading?.scrollIntoView({ block: "start" });
      }
    };
    window.addEventListener("eventouch:workspace-navigate", onTaskNavigate);
    const onInvalid = (event: Event) => {
      const section = (event.target as HTMLElement)?.closest<HTMLElement>("[data-workspace-section]");
      if (section?.dataset.workspaceSection) activate(section.dataset.workspaceSection);
    };
    root.addEventListener("invalid", onInvalid, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("hashchange", fromHash);
      window.removeEventListener("popstate", fromHash);
      window.removeEventListener("eventouch:workspace-navigate", onTaskNavigate);
      root.removeEventListener("invalid", onInvalid, true);
      for (const panel of panels.values()) {
        panel.hidden = false;
        panel.removeAttribute("role");

        panel.removeAttribute("id");
      }
    };
  }, [mode, ids, initialId]);

  if (!items.length) return null;
  if (mode === "tabs") {
    const groups = grouped ? items.reduce<{ label: string; items: ConsoleSectionNavItem[] }[]>((result, item) => {
      const current = result[result.length - 1];
      if (current?.label === item.group) current.items.push(item);
      else result.push({ label: item.group!, items: [item] });
      return result;
    }, []) : [];
    const renderTab = (item: ConsoleSectionNavItem, index: number, groupId?: string) => (
      <ProductButton type="button" key={item.id} role="tab" id={`${item.id}-tab`}
        className={styles.sectionNavLink} aria-controls={`${item.id}-panel`} aria-selected={selected === item.id} aria-describedby={groupId}
        tabIndex={selected === item.id ? 0 : -1}
        onKeyDown={(event) => {
          const forward = event.key === "ArrowRight" || (grouped && verticalTabs && event.key === "ArrowDown");
          const backward = event.key === "ArrowLeft" || (grouped && verticalTabs && event.key === "ArrowUp");
          const next = forward ? (index + 1) % items.length : backward ? (index + items.length - 1) % items.length : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : -1;
          if (next < 0) return;
          event.preventDefault();
          document.getElementById(`${items[next].id}-tab`)?.focus();
          document.getElementById(`${items[next].id}-tab`)?.click();
        }}
        onClick={() => {
          activateRef.current(item.id);
          navigateRef.current?.(item.id);
          history.replaceState(history.state, "", `#${item.fragment ?? item.id}`);
        }}>{item.label}</ProductButton>
    );
    return <nav ref={navRef} className={styles.sectionNav} aria-label={label ?? "작업 선택"}>
      <div className={`${styles.sectionNavList}${grouped ? ` ${styles.groupedTaskList}` : ""}`} role="tablist" aria-label={label ?? "작업 선택"} aria-orientation={grouped ? (verticalTabs ? "vertical" : "horizontal") : undefined}>
        {grouped ? groups.map((group) => {
          const groupId = `${group.items[0].id}-group`;
          return <div key={group.label} className={styles.taskGroup} role="presentation" data-task-group={group.label}>
            <span id={groupId} className={styles.taskGroupLabel}>{group.label}</span>
            <div className={styles.taskGroupItems} role="presentation">{group.items.map((item) => renderTab(item, items.indexOf(item), groupId))}</div>
          </div>;
        }) : items.map((item, index) => renderTab(item, index))}
      </div>
    </nav>;
  }

  return (
    <nav className={`${styles.sectionNav} ${styles.anchorNav}`} aria-label={label ?? "섹션 바로가기"}>
      <ul className={styles.sectionNavList}>
        {items.map((item) => {
          const isActive = activeId !== undefined && item.id === activeId;
          return (
          <li key={item.id}>
            <a
              className={styles.sectionNavLink}
              href={`#${item.id}`}
              data-skip-to={item.id}
              aria-current={isActive ? "location" : undefined}
              onClick={() => {
                // The anchor still navigates (the fragment stays copyable),
                // but the target is made focusable first and focus is handed
                // over directly, so the next Tab continues inside the jumped
                // section instead of back at the top of the page. Focus moves
                // without scrolling first; the explicit scroll lands the
                // viewport on the section even where the browser would not
                // scroll a programmatic focus on its own.
                const target = document.getElementById(item.id);
                if (!target) return;
                // The operator chose this section explicitly: report it at
                // once so the page can name it instead of waiting for the
                // scroll spy, which may never see this heading cross its band.
                onNavigate?.(item.id);
                if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
                if (target instanceof HTMLElement) target.focus({ preventScroll: true });
                target.scrollIntoView({ block: "start" });
              }}
            >
              {item.label}
            </a>
          </li>
          );
        })}
      </ul>
    </nav>
  );
}
