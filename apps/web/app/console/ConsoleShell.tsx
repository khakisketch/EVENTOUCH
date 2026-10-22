"use client";

import { useEffect, useRef, useState } from "react";
import SkipLink from "../SkipLink";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { loginHrefForLocation } from "../auth-redirect";
import { CONSOLE_PAGES, EVENT_PAGE_IDS, consolePageHref, resolveConsolePage } from "./console-navigation";
import { useConsoleLeaveConfirmation } from "./console-draft-guard";

type JsonRecord = Record<string, unknown>;
type ShellData = {
  userName: string;
  role: string;
  roleLabel: string;
  canSeeEvents: boolean;
  canSeeClients: boolean;
  canManageTeam: boolean;
  canManageIntegrations: boolean;
  canManageEvidencePhotos: boolean;
  scopedEventId: string | null;
  currentEventFeatures: string[];
  currentEventName: string | null;
  canAccessCurrentEvent: boolean;
  currentEventMeta: {
    stage: string;
    date: string;
    venue: string;
    pending: number;
    messageAttention: number;
  } | null;
  triage: Array<{
    id: string;
    name: string;
    stage: string;
    date: string;
    venue: string;
    pending: number;
  }>;
};

function stageLabel(stage: string): string {
  switch (stage) {
    case "DRAFT": return "기획";
    case "READY": return "운영 준비";
    case "LIVE": return "진행 중";
    case "ENDED": return "종료";
    case "ARCHIVED": return "보관";
    default: return "단계 미정";
  }
}

function stageTone(stage: string): string {
  switch (stage) {
    case "LIVE": return "live";
    case "DRAFT":
    case "READY": return "planned";
    case "ENDED":
    case "ARCHIVED": return "ended";
    default: return "unknown";
  }
}

function isApprovalQueueRelevant(stage: string): boolean {
  return !["ENDED", "ARCHIVED"].includes(stage.toUpperCase());
}

function formatShortDate(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return "일정 미정";
  return `${match[1]}.${match[2]}.${match[3]}`;
}

function record(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function EventsIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <rect x="3.75" y="5.25" width="16.5" height="15" rx="2" />
      <path d="M8 3.75v3M16 3.75v3M3.75 9.25h16.5M8 13h3M8 16.5h3" />
    </svg>
  );
}

function ClientsIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M4 20.25h16M6.25 20V4.75h11.5V20M9 8h2M13 8h2M9 11.5h2M13 11.5h2M10 20v-4.25h4V20" />
    </svg>
  );
}

export default function ConsoleShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() ?? "/console";
  const router = useRouter();
  const confirmLeave = useConsoleLeaveConfirmation();
  const currentPage = resolveConsolePage(pathname);
  const eventId = currentPage?.eventId ?? null;
  const activePageId = currentPage?.pageId === "participantImport" ? "participants" : currentPage?.pageId;
  const isHome = currentPage?.pageId === "events";
  const isClients = currentPage?.pageId === "clients";
  const isEventPath = Boolean(eventId);
  const eventBasePath = eventId ? consolePageHref("overview", eventId) ?? "" : "";

  const [shellData, setShellData] = useState<ShellData | null>(null);
  const [shellTick, setShellTick] = useState(0);
  // Visible when the shell's own navigation/permission data could not load:
  // pages keep their own errors, but the rail must not silently pretend.
  const [shellError, setShellError] = useState(false);
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const [operatorMenuPosition, setOperatorMenuPosition] = useState<CSSProperties | null>(null);
  const [globalMenuOpen, setGlobalMenuOpen] = useState(false);
  const [portalReady, setPortalReady] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const operatorTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileOperatorTriggerRef = useRef<HTMLButtonElement>(null);
  const lastOperatorTriggerRef = useRef<HTMLButtonElement>(null);
  const operatorMenuRef = useRef<HTMLDivElement>(null);
  const globalTriggerRef = useRef<HTMLButtonElement>(null);
  const globalMenuRef = useRef<HTMLElement>(null);
  const mobileEventBranchRef = useRef<HTMLDivElement>(null);
  const menuFocusPendingRef = useRef(false);
  const globalFocusPendingRef = useRef(false);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadShellData() {
      try {
        const [meResponse, bootstrapResponse] = await Promise.all([
          fetch("/api/auth/me", { cache: "no-store" }),
          fetch("/api/bootstrap", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (meResponse.status === 401 || bootstrapResponse.status === 401) {
          router.replace(
            loginHrefForLocation(
              typeof window !== "undefined" ? window.location.pathname : pathname,
              typeof window !== "undefined" ? window.location.search : ""
            )
          );
          return;
        }
        const [mePayload, bootstrapPayload] = await Promise.all([
          meResponse.json().catch(() => null) as Promise<unknown>,
          bootstrapResponse.json().catch(() => null) as Promise<unknown>,
        ]);
        const user = record(record(mePayload)?.user);
        if (!meResponse.ok || !user) {
          if (!cancelled) setShellError(true);
          return;
        }

        const userId = text(user.id);
        const role = text(user.role);
        const state = record(record(bootstrapPayload)?.state);
        if (!bootstrapResponse.ok || !state) {
          // Navigation/permission context is unusable; the shell says so.
          if (!cancelled) setShellError(true);
          return;
        }
        const accounts = Array.isArray(state?.accounts)
          ? state.accounts.map(record).filter((item): item is JsonRecord => item !== null)
          : [];
        const account = accounts.find((item) => item.id === userId);
        const orgPermissions = Array.isArray(account?.orgPermissions)
          ? account.orgPermissions.filter((value): value is string => typeof value === "string")
          : [];
        const isOrganizationOwner = role === "AGENCY" || account?.orgOwner === true;
        const hasOrgPermission = (permission: string) =>
          isOrganizationOwner || orgPermissions.includes(permission);
        const memberships = Array.isArray(state?.memberships)
          ? state.memberships.map(record).filter((item): item is JsonRecord => item !== null)
          : [];
        const events = Array.isArray(state?.events)
          ? state.events.map(record).filter((item): item is JsonRecord => item !== null)
          : [];
        const currentEvent = eventId
          ? events.find((item) => item.id === eventId)
          : undefined;
        const hasCurrentMembership = memberships.some(
          (item) => item.accountId === userId && item.eventId === eventId
        );
        const canAccessCurrentEvent = Boolean(currentEvent) &&
          (isOrganizationOwner || (role === "MANAGER" && hasCurrentMembership));
        // Sidebar switching needs the same signals as the home cards: stage,
        // date, venue, and pending approvals. The server already scopes both
        // lists to what this account may see.
        const workspaces = record(state?.workspaces) ?? {};
        const pendingOf = (eventId: string): number => {
          const workspace = record(workspaces[eventId]);
          const people = workspace ? workspace.participants : undefined;
          if (!Array.isArray(people)) return 0;
          let pending = 0;
          for (const item of people) {
            const person = record(item);
            if (person && person.status === "PENDING") pending += 1;
          }
          return pending;
        };
        const messageAttentionOf = (eventId: string): number => {
          const workspace = record(workspaces[eventId]);
          const campaigns = workspace?.messages;
          if (!Array.isArray(campaigns)) return 0;
          return campaigns.reduce((count, item) => {
            const status = text(record(item)?.status);
            return ["FAILED", "PARTIAL", "NEEDS_CONNECTION"].includes(status)
              ? count + 1
              : count;
          }, 0);
        };
        const venueOf = (eventId: string): string => {
          const workspace = record(workspaces[eventId]);
          const venue = workspace ? record(workspace.venue) : null;
          return venue ? text(venue.name) : "";
        };
        const summarize = (item: JsonRecord) => ({
          id: text(item.id),
          name: text(item.name).trim() || text(item.id),
          stage: text(item.stage),
          date: text(item.date),
          venue: venueOf(text(item.id)),
          pending: pendingOf(text(item.id)),
        });
        const currentEventMeta = currentEvent
          ? {
              ...summarize(currentEvent),
              messageAttention: messageAttentionOf(text(currentEvent.id)),
            }
          : null;
        // Triage, not a directory: events that need hands (pending approvals)
        // or are live now, current one excluded, most pending first.
        const triage = events
          .filter((item) => text(item.id) && text(item.id) !== eventId)
          .map(summarize)
          .filter((item) =>
            item.stage === "LIVE" ||
            (item.pending > 0 && isApprovalQueueRelevant(item.stage))
          )
          .sort((a, b) =>
            b.pending - a.pending ||
            (a.date || "9999").localeCompare(b.date || "9999") ||
            a.name.localeCompare(b.name, "ko-KR")
          )
          .slice(0, 5);
        const roleLabel = role === "STAFF"
          ? "현장 스태프"
          : role === "MANAGER"
            ? "운영사 구성원"
            : role === "AGENCY"
              ? "조직 소유자"
              : "운영자";

        if (!cancelled) {
          setShellError(false);
          setShellData({
            userName: text(user.name).trim() || "운영자",
            role,
            roleLabel,
            canSeeEvents:
              isOrganizationOwner || role === "MANAGER" ||
              orgPermissions.includes("events.view") || orgPermissions.includes("events.all"),
            canSeeClients: hasOrgPermission("clients.manage"),
            canManageTeam: hasOrgPermission("team.manage"),
            canManageIntegrations: hasOrgPermission("integrations.manage"),
            canManageEvidencePhotos: role === "AGENCY" || (role === "MANAGER" && hasCurrentMembership),
            scopedEventId: eventId,
            currentEventFeatures: Array.isArray(currentEvent?.features)
              ? currentEvent.features.filter((value): value is string => typeof value === "string")
              : [],
            currentEventName: currentEvent ? text(currentEvent.name).trim() || "선택한 행사" : null,
            canAccessCurrentEvent,
            currentEventMeta,
            triage,
          });
        }
      } catch {
        // The routed screen owns its data error; the shell advertises its
        // own degraded state and offers a retry instead of hiding silently.
        if (!cancelled) setShellError(true);
      }
    }
    loadShellData();
    return () => {
      cancelled = true;
    };
  }, [eventId, router, shellTick]);

  useEffect(() => {
    // Screens that own a retry (e.g. the event home) notify the shell so a
    // recovered connection restores navigation together with page content.
    const reload = () => setShellTick((tick) => tick + 1);
    window.addEventListener("eventouch:shell-reload", reload);
    return () => window.removeEventListener("eventouch:shell-reload", reload);
  }, []);

  const userName = shellData?.userName ?? "운영자";
  const canSeeEvents = shellData?.canSeeEvents ?? false;
  const canSeeClients = shellData?.canSeeClients ?? false;
  const canManageTeam = shellData?.canManageTeam ?? false;
  const canManageIntegrations = shellData?.canManageIntegrations ?? false;
  // The top "메뉴" trigger only exists when at least one permitted
  // destination exists. Loading or denied states render no trigger and no
  // fallback access: the gates inside the link renderers stay authoritative.
  const showGlobalTrigger = canSeeEvents || canSeeClients;
  const showCurrentEvent = Boolean(
    isEventPath && shellData?.scopedEventId === eventId && shellData?.canAccessCurrentEvent && shellData.currentEventName
  );
  // This is a display gate only; server reads and command authorization remain authoritative.
  const showOperatorNavBadges = Boolean(
    shellData && ["AGENCY", "MANAGER"].includes(shellData.role)
  );

  useEffect(() => {
    if (!currentPage) return;
    const name = showCurrentEvent ? shellData?.currentEventName : null;
    document.title = [CONSOLE_PAGES[currentPage.pageId].title, name, "EVENTOUCH"].filter(Boolean).join(" · ");
  }, [currentPage?.pageId, showCurrentEvent, shellData?.currentEventName]);

  useEffect(() => {
    if (!showCurrentEvent) return;
    const branch = mobileEventBranchRef.current;
    if (!branch) return;

    const revealCurrentDestination = () => {
      if (!window.matchMedia("(max-width: 768px)").matches) return;
      const activeLink = branch.querySelector<HTMLElement>(".console-subnav-item.active");
      if (!activeLink) return;

      const branchBounds = branch.getBoundingClientRect();
      const activeBounds = activeLink.getBoundingClientRect();
      const inset = 8;
      let nextScrollLeft = branch.scrollLeft;
      if (activeBounds.left < branchBounds.left + inset) {
        nextScrollLeft -= branchBounds.left + inset - activeBounds.left;
      } else if (activeBounds.right > branchBounds.right - inset) {
        nextScrollLeft += activeBounds.right - (branchBounds.right - inset);
      }

      branch.scrollLeft = Math.max(
        0,
        Math.min(branch.scrollWidth - branch.clientWidth, nextScrollLeft)
      );
    };

    const frame = window.requestAnimationFrame(revealCurrentDestination);
    window.addEventListener("resize", revealCurrentDestination);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", revealCurrentDestination);
    };
  }, [pathname, showCurrentEvent]);

  function getVisibleOperatorTrigger() {
    const mobileTrigger = mobileOperatorTriggerRef.current;
    if (mobileTrigger?.getClientRects().length) return mobileTrigger;
    return operatorTriggerRef.current;
  }

  function closeOperatorMenu(restoreFocus = false) {
    menuFocusPendingRef.current = false;
    setOperatorMenuOpen(false);
    setOperatorMenuPosition(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        const lastTrigger = lastOperatorTriggerRef.current;
        const visibleLastTrigger = lastTrigger?.getClientRects().length ? lastTrigger : null;
        (visibleLastTrigger ?? getVisibleOperatorTrigger())?.focus();
      });
    }
  }

  // Top global menu (mobile "메뉴"): a non-modal disclosure, not a dialog.
  // No focus trap; Tab keeps its normal order. Escape restores focus to the
  // trigger, an outside pointer closes without stealing the target's focus.
  function closeGlobalMenu(restoreFocus = false) {
    globalFocusPendingRef.current = false;
    setGlobalMenuOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => {
        const trigger = globalTriggerRef.current;
        if (trigger?.getClientRects().length) trigger.focus();
      });
    }
  }

  function updateOperatorMenuPosition() {
    const trigger = getVisibleOperatorTrigger();
    const menu = operatorMenuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const maxHeight = Math.max(120, window.innerHeight - gutter * 4);
    const menuHeight = Math.min(menu.scrollHeight, maxHeight);
    const isMobileShell = window.matchMedia("(max-width: 768px)").matches;
    const width = isMobileShell
      ? Math.min(320, window.innerWidth - gutter * 2)
      : Math.min(rect.width, window.innerWidth - gutter * 2);
    const left = isMobileShell
      ? window.innerWidth - width - gutter
      : Math.min(Math.max(gutter, rect.left), window.innerWidth - width - gutter);
    const spaceAbove = rect.top - gutter;
    const spaceBelow = window.innerHeight - rect.bottom - gutter;
    const openBelow = spaceBelow >= menuHeight + gutter || spaceBelow >= spaceAbove;
    const top = openBelow
      ? rect.bottom + gutter
      : rect.top - menuHeight - gutter;
    setOperatorMenuPosition({
      position: "fixed",
      top: Math.max(gutter, top),
      left,
      width,
      maxHeight,
    });
  }

  useEffect(() => {
    if (!operatorMenuOpen) return;
    updateOperatorMenuPosition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const isOperatorTrigger =
        target instanceof Node &&
        (operatorTriggerRef.current?.contains(target) || mobileOperatorTriggerRef.current?.contains(target));
      // Moving to the top "메뉴" trigger hands focus to the global menu:
      // close here without pulling focus back to the account trigger, so
      // the global menu's first link ends focused instead of racing it.
      const isGlobalTrigger =
        target instanceof Node && globalTriggerRef.current?.contains(target);
      if (
        target instanceof Node &&
        !operatorMenuRef.current?.contains(target) &&
        !isOperatorTrigger
      ) {
        closeOperatorMenu(isGlobalTrigger ? false : true);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeOperatorMenu(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (!operatorMenuRef.current?.contains(document.activeElement)) return;
      const items = Array.from(
        operatorMenuRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"]:not(:disabled)'
        ) ?? []
      );
      if (!items.length) return;
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    window.addEventListener("resize", updateOperatorMenuPosition);
    window.addEventListener("scroll", updateOperatorMenuPosition, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", updateOperatorMenuPosition);
      window.removeEventListener("scroll", updateOperatorMenuPosition, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [operatorMenuOpen]);

  useEffect(() => {
    if (!operatorMenuOpen || !operatorMenuPosition || !menuFocusPendingRef.current) return;
    menuFocusPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      operatorMenuRef.current
        ?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [operatorMenuOpen, operatorMenuPosition]);

  useEffect(() => {
    // The menu closes on arrival, never on click: when the draft guard
    // cancels a leave, the pathname is unchanged so the menu, its focus and
    // the link state stay exactly as they were.
    globalFocusPendingRef.current = false;
    setGlobalMenuOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!globalMenuOpen) return;
    const onResize = () => {
      // The trigger only exists at phone widths; leaving that range closes
      // the popup without reaching for a trigger that is no longer visible.
      if (window.matchMedia("(min-width: 769px)").matches) {
        globalFocusPendingRef.current = false;
        setGlobalMenuOpen(false);
      }
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [globalMenuOpen]);

  useEffect(() => {
    if (!globalMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof Node &&
        !globalMenuRef.current?.contains(target) &&
        !globalTriggerRef.current?.contains(target)
      ) {
        globalFocusPendingRef.current = false;
        setGlobalMenuOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeGlobalMenu(true);
        return;
      }
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      if (!globalMenuRef.current?.contains(document.activeElement)) return;
      const items = Array.from(
        globalMenuRef.current?.querySelectorAll<HTMLElement>(
          "a.console-nav-item"
        ) ?? []
      );
      if (!items.length) return;
      event.preventDefault();
      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[nextIndex]?.focus();
    };
    const onFocusIn = (event: FocusEvent) => {
      // Non-modal: Tab keeps its normal order and leaves the popup, which
      // must not linger over the form underneath. Only Escape restores
      // focus to the trigger; leaving never does.
      const target = event.target;
      if (
        target instanceof Node &&
        !globalMenuRef.current?.contains(target) &&
        !globalTriggerRef.current?.contains(target)
      ) {
        globalFocusPendingRef.current = false;
        setGlobalMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [globalMenuOpen]);

  useEffect(() => {
    if (!globalMenuOpen || !globalFocusPendingRef.current) return;
    globalFocusPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      globalMenuRef.current
        ?.querySelector<HTMLElement>("a.console-nav-item")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [globalMenuOpen]);

  async function logout() {
    if (logoutPending || !confirmLeave()) return;
    setLogoutError(null);
    setLogoutPending(true);
    try {
      const response = await fetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        setLogoutError("로그아웃하지 못했습니다. 다시 시도하세요.");
        return;
      }
      router.replace("/login");
      router.refresh();
    } catch {
      setLogoutError("연결을 확인한 뒤 다시 로그아웃하세요.");
    } finally {
      setLogoutPending(false);
    }
  }

  function handleOperatorMenuTrigger(event: React.MouseEvent<HTMLButtonElement>) {
    lastOperatorTriggerRef.current = event.currentTarget;
    setLogoutError(null);
    // The two popups are mutually exclusive.
    globalFocusPendingRef.current = false;
    setGlobalMenuOpen(false);
    if (operatorMenuOpen) {
      closeOperatorMenu();
    } else {
      menuFocusPendingRef.current = true;
      setOperatorMenuOpen(true);
    }
  }

  function handleGlobalMenuTrigger() {
    if (globalMenuOpen) {
      closeGlobalMenu();
    } else {
      // The two popups are mutually exclusive.
      menuFocusPendingRef.current = false;
      setOperatorMenuOpen(false);
      setOperatorMenuPosition(null);
      globalFocusPendingRef.current = true;
      setGlobalMenuOpen(true);
    }
  }

  function handleGlobalMenuNavigate(event: React.MouseEvent<HTMLElement>) {
    // Capture precedes Next Link's bubble onClick, which marks navigation
    // defaultPrevented before a parent bubble handler can see it. Handle
    // ONLY the already-here destination; different paths stay untouched for
    // the shared draft guard and pathname effect regardless of React's
    // delegated/native capture ordering. A cancelled leave keeps the menu,
    // focus and input intact.
    //
    // Bounded to the already-here destination only, for a normal unmodified
    // primary click.
    if (
      event.defaultPrevented || event.button !== 0 ||
      event.metaKey || event.ctrlKey || event.shiftKey || event.altKey
    ) return;
    const target = event.target instanceof Element ? event.target : null;
    const maybeLink = target?.closest("a[href]");
    if (!(maybeLink instanceof HTMLAnchorElement)) return;
    const link = maybeLink;
    if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
    let url: URL;
    try {
      url = new URL(link.getAttribute("href") ?? link.href, window.location.href);
    } catch {
      return;
    }
    if (url.origin !== window.location.origin) return;
    if (url.pathname !== window.location.pathname) return;
    // Same destination: no navigation will arrive to close the menu, so
    // close here and stay put without a same-page scroll reset.
    event.preventDefault();
    closeGlobalMenu(true);
  }

  function renderEventsLink(id: string, label?: string) {
    return canSeeEvents ? (
      <Link
        id={id}
        className={`console-nav-item console-nav-root-item${isHome ? " active" : isEventPath ? " active-path" : ""}`}
        href={consolePageHref("events")!}
        aria-current={isHome ? "page" : isEventPath ? "location" : undefined}
      >
        <EventsIcon />
        <span>{label ?? CONSOLE_PAGES.events.label}</span>
      </Link>
    ) : null;
  }

  function renderClientsLink(id: string, label?: string) {
    return canSeeClients ? (
      <Link
        id={id}
        className={`console-nav-item console-nav-root-item${isClients ? " active" : ""}`}
        href={consolePageHref("clients")!}
        aria-current={isClients ? "page" : undefined}
      >
        <ClientsIcon />
        <span>{label ?? CONSOLE_PAGES.clients.label}</span>
      </Link>
    ) : null;
  }

  function renderEventBranch(eventsLinkId: string, mobile = false) {
    // Mobile keeps the compact in-row switcher; the triage list lives on
    // desktop where the sidebar has room. Switching happens on /console home.
    if (mobile) {
      // The old bottom bar (and its link id) is gone, so this group carries
      // its own always-present label instead of a dangling labelledby ref.
      // The parent nav's "현재 행사 메뉴" label stays as the outer landmark.
      return showCurrentEvent && eventId ? (
        <div
          ref={mobileEventBranchRef}
          className="nav-event-branch"
          role="group"
          aria-label="현재 행사 업무"
        >
          <div className="nav-current-event">
            <strong title={shellData?.currentEventName ?? undefined}>{shellData?.currentEventName}</strong>
            <Link className="nav-event-switch" href="/console">목록에서 전환</Link>
          </div>
          {renderEventSubnav()}
        </div>
      ) : null;
    }
    return showCurrentEvent && eventId ? (
      <>
        <div
          className="nav-event-branch"
          role="group"
          aria-labelledby={eventsLinkId}
        >
          {shellData?.currentEventMeta ? (
            <div className="nav-event-card">
              <span className="nav-event-head">
                <span className={`nav-stage-dot nav-stage-${stageTone(shellData.currentEventMeta.stage)}`} aria-hidden="true" />
                <strong title={shellData?.currentEventName ?? undefined}>{shellData?.currentEventName}</strong>
                <span className="sr-only">{stageLabel(shellData.currentEventMeta.stage)}</span>
              </span>
              <span className="nav-event-meta">
                {[formatShortDate(shellData.currentEventMeta.date), shellData.currentEventMeta.venue].filter(Boolean).join(" · ")}
              </span>
            </div>
          ) : (
            <div className="nav-current-event">
              <strong title={shellData?.currentEventName ?? undefined}>{shellData?.currentEventName}</strong>
            </div>
          )}
          {renderEventSubnav()}
        </div>
        {shellData && shellData.triage.length ? (
          <div className="nav-triage" role="group" aria-label="손봐야 할 행사">
            <p className="nav-section-label">손봐야 할 행사</p>
            {shellData.triage.map((item) => (
              <Link
                key={item.id}
                className="nav-event-pick"
                href={`/console/events/${encodeURIComponent(item.id)}`}
              >
                <span className={`nav-stage-dot nav-stage-${stageTone(item.stage)}`} aria-hidden="true" />
                <span className="nav-event-text">
                  <strong>{item.name}</strong>
                  <small>{[formatShortDate(item.date), item.venue].filter(Boolean).join(" · ") || stageLabel(item.stage)}</small>
                </span>
                {showOperatorNavBadges && item.pending > 0 ? (
                  <span className="nav-badge" role="img" aria-label={`승인 대기 ${item.pending}건`}>{item.pending}</span>
                ) : null}
              </Link>
            ))}
          </div>
        ) : null}
      </>
    ) : null;
  }

  function renderEventSubnav() {
    const eventMeta = shellData?.currentEventMeta;
    const showPendingApprovalBadge = Boolean(
      showOperatorNavBadges && eventMeta && eventMeta.pending > 0 &&
      isApprovalQueueRelevant(eventMeta.stage)
    );
    const showMessageAttentionBadge = Boolean(
      showOperatorNavBadges && eventMeta && eventMeta.messageAttention > 0
    );
    const participantsHref = showPendingApprovalBadge
      ? `${eventBasePath}/participants?status=PENDING`
      : `${eventBasePath}/participants`;
    const messagesHref = showMessageAttentionBadge
      ? `${eventBasePath}/messages?attention=1#history-heading`
      : `${eventBasePath}/messages`;

    const features = shellData?.currentEventFeatures ?? [];
    return EVENT_PAGE_IDS.map((pageId) => {
      if (pageId === "photos" && !shellData?.canManageEvidencePhotos) return null;
      if (pageId === "rewards" && !features.includes("reward")) return null;
      if (pageId === "draws" && !features.some((feature) => feature === "draw" || feature === "poll")) return null;
      if (pageId === "programs" && !features.some((feature) =>
        ["poll", "quiz", "qa", "draw", "survey", "stamp", "photo", "board"].includes(feature))) return null;
      const href = pageId === "participants" ? participantsHref
        : pageId === "messages" ? messagesHref
        : consolePageHref(pageId, eventId ?? undefined);
      if (!href) return null;
      const active = activePageId === pageId;
      return (
        <Link key={pageId} className={`console-nav-item console-subnav-item${active ? " active" : ""}`}
          href={href} aria-current={active ? "page" : undefined}>
          {CONSOLE_PAGES[pageId].label}
          {pageId === "participants" && showPendingApprovalBadge ? (
            <span className="nav-badge" role="img" aria-label={`승인 대기 ${eventMeta?.pending ?? 0}건`}>{eventMeta?.pending}</span>
          ) : null}
          {pageId === "messages" && showMessageAttentionBadge ? (
            <span className="nav-badge" role="img" aria-label={`발송 확인 ${eventMeta?.messageAttention ?? 0}건`}>{eventMeta?.messageAttention}</span>
          ) : null}
        </Link>
      );
    });
  }

  const organizationPermissionSummary = shellData
    ? [
        canSeeEvents ? "행사" : null,
        canSeeClients ? "고객사" : null,
        canManageTeam ? "팀·권한" : null,
        canManageIntegrations ? "서비스 연동" : null,
      ].filter((label): label is string => label !== null).join(" · ") || "조직 메뉴 권한 없음"
    : "확인 중";

  const menuItems = portalReady
    ? createPortal(
        <div
          ref={operatorMenuRef}
          id="operator-menu"
          className="operator-menu"
          role="menu"
          aria-label="운영자 메뉴"
          hidden={!operatorMenuOpen}
          style={operatorMenuOpen ? operatorMenuPosition ?? { visibility: "hidden" } : undefined}
        >
          <div className="operator-menu-profile" role="group" aria-label="계정 정보">
            <div className="operator-menu-profile-heading">
              <span className="operator-avatar operator-menu-profile-avatar" aria-hidden="true">{Array.from(userName.trim())[0] || "운"}</span>
              <div className="operator-menu-profile-identity">
                <strong>{userName}</strong>
                <span>{shellData?.roleLabel ?? "운영자"}</span>
              </div>
            </div>
            <p className="operator-menu-permissions">
              <strong>조직 메뉴 권한</strong>
              <span>{organizationPermissionSummary}</span>
            </p>
          </div>
          {canManageTeam ? (
            <Link
              className="operator-menu-item"
              role="menuitem"
              href={consolePageHref("team")!}
            >
              <span>{CONSOLE_PAGES.team.label}</span>
            </Link>
          ) : null}
          {canManageIntegrations ? (
            <button type="button" className="operator-menu-item" role="menuitem" disabled>
              <span>서비스 연동</span><span className="operator-menu-status">준비 중</span>
            </button>
          ) : null}
          {(canManageTeam || canManageIntegrations) ? (
            <div className="operator-menu-divider" aria-hidden="true" />
          ) : null}
          <button
            type="button"
            className="operator-menu-item operator-menu-logout"
            role="menuitem"
            onClick={logout}
            disabled={logoutPending}
          >
            <span>{logoutPending ? "로그아웃 중…" : "로그아웃"}</span>
          </button>
          {logoutError ? <p className="operator-menu-error" role="alert">{logoutError}</p> : null}
        </div>,
        document.body
      )
    : null;

  const avatar = Array.from(userName.trim())[0] || "운";

  return (
    <div className="console-shell">
      <SkipLink />
      <aside className="console-sidebar" aria-label="운영 콘솔">
        {showGlobalTrigger ? (
          <div className="console-global-nav">
            <button
              ref={globalTriggerRef}
              type="button"
              className="console-global-trigger"
              aria-expanded={globalMenuOpen}
              aria-controls="console-global-menu"
              onClick={handleGlobalMenuTrigger}
            >
              <span>메뉴</span>
              <svg className="console-global-trigger-chevron" aria-hidden="true" focusable="false" viewBox="0 0 12 12">
                <path d="M3 4.5 6 7.5 9 4.5" />
              </svg>
            </button>
            <nav
              ref={globalMenuRef}
              id="console-global-menu"
              className="console-global-menu"
              aria-label="주요 메뉴"
              hidden={!globalMenuOpen}
              onClickCapture={handleGlobalMenuNavigate}
            >
              {renderEventsLink("workspace-events-link-global", "행사 목록")}
              {renderClientsLink("workspace-clients-link-global")}
            </nav>
          </div>
        ) : null}
        <Link className="console-brand" href="/console">
          <span className="console-wordmark">EVENTOUCH</span>
        </Link>

        <button
          ref={mobileOperatorTriggerRef}
          type="button"
          className="operator-block operator-menu-trigger operator-mobile-trigger"
          aria-label={`계정 메뉴, ${userName}, ${shellData?.roleLabel ?? "역할 확인 중"}`}
          aria-haspopup="menu"
          aria-expanded={operatorMenuOpen}
          aria-controls="operator-menu"
          onClick={handleOperatorMenuTrigger}
        >
          <span className="operator-avatar" aria-hidden="true">{avatar}</span>
        </button>

        <nav className="side-nav desktop-side-nav" aria-label="주요 메뉴">
          {renderEventsLink("workspace-events-link")}
          {renderEventBranch("workspace-events-link")}
          {renderClientsLink("workspace-clients-link")}
        </nav>

        <nav className="side-nav mobile-event-nav" aria-label="현재 행사 메뉴">
          {renderEventBranch("workspace-events-link", true)}
        </nav>

        <div className="sidebar-bottom">
          <button
            ref={operatorTriggerRef}
            type="button"
            className="operator-block operator-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={operatorMenuOpen}
            aria-controls="operator-menu"
            onClick={handleOperatorMenuTrigger}
          >
            <span className="operator-avatar" aria-hidden="true">{avatar}</span>
            <span className="operator-identity">
              <strong>{userName}</strong>
            </span>
            <span className="operator-menu-caret" aria-hidden="true" />
          </button>
        </div>
      </aside>

      {menuItems}

      <div className="console-content-shell">
        <main id="main-content" className="console-main" tabIndex={-1}>
          {shellError ? (
            <div className="console-shell-error" role="alert">
              <span>내비게이션 정보를 불러오지 못했습니다. 화면 일부가 제한되어 보일 수 있습니다.</span>
              <button type="button" className="button button-secondary" onClick={() => setShellTick((tick) => tick + 1)}>
                다시 시도
              </button>
            </div>
          ) : null}
          <div key={eventId ?? "organization"} className="console-route-content">{children}</div>
        </main>
      </div>
    </div>
  );
}
