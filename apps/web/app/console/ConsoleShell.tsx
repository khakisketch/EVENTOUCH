"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import SkipLink from "../SkipLink";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { loginHrefForLocation } from "../auth-redirect";
import { CONSOLE_PAGES, EVENT_HUBS, consoleHubForPage, consolePageHref, resolveConsolePage, type ConsoleHub, type ConsolePageId } from "./console-navigation";
import { BarsIcon } from "./console-ui/ConsoleIcons";
import { useConsoleLeaveConfirmation } from "./console-draft-guard";
import { consoleFetch, invalidateConsoleReads, subscribeConsoleFreshness } from "../../lib/console-api";
import freshnessStyles from "./console-ui/freshness.module.css";
import OrganizationSwitcher, { OrganizationContextNotice } from "../OrganizationSwitcher";
import { ensureOperatorContext, getOperatorContextSnapshot, isOrganizationContextBlock, isOrganizationSelectionRequired, resetOperatorContext } from "../../lib/operator-context";
import { useOperatorContextSnapshot } from "../../lib/use-operator-context";

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
    manualDue: number;
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

function TeamIcon() {
  return (
    <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <circle cx="9" cy="8" r="3" />
      <path d="M3 20.25c0-3.15 2.7-5.25 6-5.25s6 2.1 6 5.25M16 5.5a3 3 0 0 1 0 5.8M18 20.25c0-2.4-1-4.2-3-5" />
    </svg>
  );
}

export default function ConsoleShell({ children }: { children: React.ReactNode }) {
  const organization = useOperatorContextSnapshot();
  const pathname = usePathname() ?? "/console";
  const router = useRouter();
  const confirmLeave = useConsoleLeaveConfirmation();
  const currentPage = resolveConsolePage(pathname);
  const eventId = currentPage?.eventId ?? null;
  const currentPageId = currentPage?.pageId;
  const isHome = currentPage?.pageId === "events";
  const isClients = currentPage?.pageId === "clients";
  const isTeam = currentPage?.pageId === "team";
  const isEventPath = Boolean(eventId);
  const eventBasePath = eventId ? consolePageHref("overview", eventId) ?? "" : "";

  const [shellData, setShellData] = useState<ShellData | null>(null);
  const [shellTick, setShellTick] = useState(0);
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [pageRevision, setPageRevision] = useState(0);
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
  const menuFocusPendingRef = useRef(false);
  const globalFocusPendingRef = useRef(false);

  useEffect(() => {
    setPortalReady(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadShellData() {
      try {
        const workingContext = await ensureOperatorContext();
        if (getOperatorContextSnapshot().changed) return;
        // Staff keep their assigned-desk hub as the default home, but an
        // explicitly opened event workspace stays readable: every screen
        // degrades to its server-scoped read-only state through the same
        // per-screen gates (the roster names this for non-writers). Only the
        // event-less console home bounces staff back to /staff.
        if (workingContext.role === "STAFF" && !eventId) { router.replace("/staff"); return; }
        const bootstrapResponse = await consoleFetch("/api/console/directory", { cache: "no-store" });
        if (cancelled) return;
        if (bootstrapResponse.status === 401) {
          router.replace(
            loginHrefForLocation(
              typeof window !== "undefined" ? window.location.pathname : pathname,
              typeof window !== "undefined" ? window.location.search : ""
            )
          );
          return;
        }
        const bootstrapPayload: unknown = await bootstrapResponse.json().catch(() => null);
        const state = record(record(bootstrapPayload)?.directory);
        const user = record(state?.viewer);
        if (!bootstrapResponse.ok || !user) {
          if (!cancelled) setShellError(true);
          return;
        }

        const userId = workingContext.userId;
        const role = workingContext.role;
        if (!bootstrapResponse.ok || !state) {
          // Navigation/permission context is unusable; the shell says so.
          if (!cancelled) setShellError(true);
          return;
        }
        const accounts = Array.isArray(state?.accounts)
          ? state.accounts.map(record).filter((item): item is JsonRecord => item !== null)
          : [];
        const account = accounts.find((item) => item.id === userId);
        const rawOrgPermissions = account?.orgPermissions ?? user.orgPermissions;
        const orgPermissions = Array.isArray(rawOrgPermissions)
          ? rawOrgPermissions.filter((value): value is string => typeof value === "string")
          : [];
        const isOrganizationOwner = role === "AGENCY" || account?.orgOwner === true || user.orgOwner === true;
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
        const pendingOf = (eventId: string): number => {
          const event = events.find((item) => item.id === eventId);
          return typeof event?.pending === "number" ? event.pending : 0;
        };
        const messageAttentionOf = (eventId: string): number => {
          const event = events.find((item) => item.id === eventId);
          return typeof event?.messageAttention === "number" ? event.messageAttention : 0;
        };
        const venueOf = (eventId: string): string => {
          return text(events.find((item) => item.id === eventId)?.venue);
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
              manualDue: typeof currentEvent.manualDue === "number" ? currentEvent.manualDue : 0,
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
            userName: workingContext.userName.trim() || "운영자",
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
      } catch (error) {
        if (isOrganizationSelectionRequired(error)) {
          if (!cancelled) { setShellError(false); setShellData(null); }
          return;
        }
        if (isOrganizationContextBlock(error)) return;
        if (typeof error === "object" && error !== null && "status" in error && error.status === 401) {
          router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
          return;
        }
        // The routed screen owns its data error; the shell advertises its
        // own degraded state and offers a retry instead of hiding silently.
        if (!cancelled) setShellError(true);
      }
    }
    loadShellData();
    return () => {
      cancelled = true;
    };
  }, [eventId, router, shellTick, organization.context?.contextVersion]);

  useEffect(() => {
    // Screens that own a retry (e.g. the event home) notify the shell so a
    // recovered connection restores navigation together with page content.
    const reload = () => setShellTick((tick) => tick + 1);
    window.addEventListener("eventouch:shell-reload", reload);
    return () => window.removeEventListener("eventouch:shell-reload", reload);
  }, []);

  useEffect(() => subscribeConsoleFreshness(({ source }) => {
    setShellTick((tick) => tick + 1);
    if (source !== "write") setUpdateAvailable(true);
  }), []);

  useEffect(() => setUpdateAvailable(false), [pathname]);

  const userName = shellData?.userName ?? "운영자";
  const canSeeEvents = shellData?.canSeeEvents ?? false;
  const canSeeClients = shellData?.canSeeClients ?? false;
  const canManageTeam = shellData?.canManageTeam ?? false;
  const canManageIntegrations = shellData?.canManageIntegrations ?? false;
  // The top "메뉴" trigger only exists when at least one permitted
  // destination exists. An event is a destination too: an event-scoped
  // operator without the organization roots still needs the event hubs.
  // Loading or denied states render no trigger and no fallback access: the
  // gates inside the link renderers stay authoritative.
  const showGlobalTrigger = canSeeEvents || canSeeClients || Boolean(eventId && shellData?.canAccessCurrentEvent);
  const showCurrentEvent = Boolean(
    isEventPath && shellData?.scopedEventId === eventId && shellData?.canAccessCurrentEvent && shellData.currentEventName
  );
  // This is a display gate only; server reads and command authorization remain authoritative.
  const showOperatorNavBadges = Boolean(
    shellData && ["AGENCY", "MANAGER"].includes(shellData.role)
  );
  const eventMeta = shellData?.currentEventMeta ?? null;
  const eventFeatures = shellData?.currentEventFeatures ?? [];
  const showPendingApprovalBadge = Boolean(
    showOperatorNavBadges && eventMeta && eventMeta.pending > 0 && isApprovalQueueRelevant(eventMeta.stage)
  );
  const showMessageAttentionBadge = Boolean(
    showOperatorNavBadges && eventMeta && eventMeta.messageAttention > 0
  );
  const showManualDueBadge = Boolean(showOperatorNavBadges && eventMeta && eventMeta.manualDue > 0);
  const activeHubId = currentPageId ? consoleHubForPage(currentPageId)?.id : undefined;

  useEffect(() => {
    if (!currentPage) return;
    const name = showCurrentEvent ? shellData?.currentEventName : null;
    document.title = [CONSOLE_PAGES[currentPage.pageId].title, name, "EVENTOUCH"].filter(Boolean).join(" · ");
  }, [currentPage?.pageId, showCurrentEvent, shellData?.currentEventName]);

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
    const width = Math.min(320, window.innerWidth - gutter * 2);
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
      if (document.activeElement?.matches("input, select, textarea")) return;
      const items = Array.from(
        operatorMenuRef.current?.querySelectorAll<HTMLElement>(
          '.operator-menu-item:not(:disabled)'
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
    const observer = new ResizeObserver(updateOperatorMenuPosition);
    if (operatorMenuRef.current) observer.observe(operatorMenuRef.current);
    return () => {
      window.removeEventListener("resize", updateOperatorMenuPosition);
      window.removeEventListener("scroll", updateOperatorMenuPosition, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      observer.disconnect();
    };
  }, [operatorMenuOpen]);

  useEffect(() => {
    if (!operatorMenuOpen || !operatorMenuPosition || !menuFocusPendingRef.current) return;
    menuFocusPendingRef.current = false;
    const frame = window.requestAnimationFrame(() => {
      operatorMenuRef.current
        ?.querySelector<HTMLElement>('select:not(:disabled), input:not(:disabled), button:not(:disabled), a[href]')
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
          "a[href]"
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
        ?.querySelector<HTMLElement>("a[href]")
        ?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [globalMenuOpen]);

  async function logout() {
    if (logoutPending || !confirmLeave()) return;
    setLogoutError(null);
    setLogoutPending(true);
    try {
      const response = await consoleFetch("/api/auth/logout", { method: "POST" });
      if (!response.ok) {
        setLogoutError("로그아웃하지 못했습니다. 다시 시도하세요.");
        return;
      }
      resetOperatorContext();
      invalidateConsoleReads();
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

  function renderTeamLink(id: string, label?: string) {
    return canManageTeam ? (
      <Link
        id={id}
        className={`console-nav-item console-nav-root-item${isTeam ? " active" : ""}`}
        href={consolePageHref("team")!}
        aria-current={isTeam ? "page" : undefined}
      >
        <TeamIcon />
        <span>{label ?? CONSOLE_PAGES.team.label}</span>
      </Link>
    ) : null;
  }

  function pageHref(pageId: ConsolePageId): string | undefined {
    if (!eventId) return undefined;
    if (pageId === "participants") {
      return showPendingApprovalBadge
        ? `${eventBasePath}/participants?status=PENDING`
        : `${eventBasePath}/participants`;
    }
    if (pageId === "messages") {
      return showMessageAttentionBadge || showManualDueBadge
        ? `${eventBasePath}/messages?attention=1#history-heading`
        : `${eventBasePath}/messages`;
    }
    return consolePageHref(pageId, eventId);
  }

  function isPageVisible(pageId: ConsolePageId): boolean {
    if (pageId === "photos" && !shellData?.canManageEvidencePhotos) return false;
    if (pageId === "rewards" && !eventFeatures.includes("reward")) return false;
    if (pageId === "draws" && !eventFeatures.some((feature) => feature === "draw" || feature === "poll")) return false;
    if (pageId === "programs" && !eventFeatures.some((feature) =>
      ["poll", "quiz", "qa", "draw", "survey", "stamp", "photo", "board"].includes(feature))) return false;
    return true;
  }

  function visiblePagesForHub(hub: ConsoleHub): ConsolePageId[] {
    return hub.pageIds.filter(isPageVisible);
  }

  function hubHref(hub: ConsoleHub, pages: ConsolePageId[]): string | undefined {
    if (!eventId) return undefined;
    const pageId = pages.includes(hub.defaultPageId) ? hub.defaultPageId : pages[0];
    return pageId ? consolePageHref(pageId, eventId) : undefined;
  }

  function renderPageBadges(pageId: ConsolePageId) {
    if (pageId === "participants" && showPendingApprovalBadge) {
      return (
        <span className="nav-badge" role="img" aria-label={`승인 대기 ${eventMeta?.pending ?? 0}건`}>
          {eventMeta?.pending}
        </span>
      );
    }
    if (pageId === "messages") {
      return (
        <>
          {showMessageAttentionBadge ? (
            <span className="nav-badge" role="img" aria-label={`발송 확인 ${eventMeta?.messageAttention ?? 0}건`}>
              {eventMeta?.messageAttention}
            </span>
          ) : null}
          {showManualDueBadge ? (
            <span
              className="nav-badge nav-badge-manual"
              role="img"
              aria-label={`${eventMeta?.stage === "ARCHIVED" ? "예약 확인" : "실행할 예약"} ${eventMeta?.manualDue ?? 0}건`}
              title="예약 시각이 지난 수동 예약입니다. 자동 발송되지 않습니다."
            >
              예약 {eventMeta?.manualDue}
            </span>
          ) : null}
        </>
      );
    }
    return null;
  }

  function renderEventHubs() {
    return EVENT_HUBS.map((hub) => {
      const pages = visiblePagesForHub(hub);
      if (!pages.length) return null;
      const href = hubHref(hub, pages);
      if (!href) return null;
      const hubActive = activeHubId === hub.id;
      const hasSubnav = pages.length > 1;
      const currentSubpage = currentPageId && pages.includes(currentPageId) ? currentPageId : null;
      const headerIsCurrent = !hasSubnav && currentSubpage !== null;
      const hubBadge = hub.id === "participants" && showPendingApprovalBadge && (!hubActive || !hasSubnav)
        ? (
          <span className="nav-badge" role="img" aria-label={`승인 대기 ${eventMeta?.pending ?? 0}건`}>
            {eventMeta?.pending}
          </span>
        )
        : null;
      return (
        <Fragment key={hub.id}>
          <Link
            className={`console-nav-item console-hub-item${headerIsCurrent ? " active" : ""}`}
            data-active={hubActive && hasSubnav ? "true" : undefined}
            href={href}
            aria-current={headerIsCurrent ? "page" : undefined}
          >
            <span>{hub.label}</span>
            {hubBadge}
            {hasSubnav ? (
              <svg className="console-hub-chevron" aria-hidden="true" focusable="false" viewBox="0 0 12 12">
                <path d="M3 4.5 6 7.5 9 4.5" />
              </svg>
            ) : null}
          </Link>
          {hasSubnav && hubActive ? (
            <div className="console-hub-subnav">
              {pages.map((pageId) => {
                const pageLink = pageHref(pageId);
                if (!pageLink) return null;
                const active = currentPageId === pageId;
                return (
                  <Link
                    key={pageId}
                    className={`console-nav-item console-hub-subitem${active ? " active" : ""}`}
                    href={pageLink}
                    aria-current={active ? "page" : undefined}
                  >
                    <span>{CONSOLE_PAGES[pageId].label}</span>
                    {renderPageBadges(pageId)}
                  </Link>
                );
              })}
            </div>
          ) : null}
        </Fragment>
      );
    });
  }

  /**
   * Phone menu: the complete event map, hubs as section labels and every
   * visible page as a 44px row. Unlike the rail (which expands only the hub
   * the operator is in) the menu is opened to jump anywhere, so nothing is
   * hidden behind another tap. Hub labels are not links: the row below
   * already names the same destination, and two links to one page read as a
   * duplicate.
   */
  function renderMobileEventMenu() {
    if (!showCurrentEvent || !eventId) return null;
    const date = eventMeta?.date ?? "";
    const facts = [
      /^\d{4}-\d{2}-\d{2}$/.test(date) ? formatShortDate(date) : "",
      eventMeta?.venue ?? "",
    ].filter(Boolean).join(" · ");
    const meta = [stageLabel(eventMeta?.stage ?? ""), facts].filter(Boolean).join(" · ");
    return (
      <div className="console-menu-event">
        <p className="console-menu-section-label">현재 행사</p>
        <p className="console-menu-event-name">{shellData?.currentEventName}</p>
        <p className="console-menu-event-meta">{meta}</p>
        <div className="console-menu-hubs">
          {EVENT_HUBS.map((hub) => {
            const pages = visiblePagesForHub(hub);
            if (!pages.length) return null;
            return (
              <div key={hub.id} className="console-menu-hub-group">
                <p
                  className="console-menu-hub"
                  data-active={activeHubId === hub.id ? "true" : undefined}
                >
                  {hub.label}
                </p>
                <div className="console-menu-subnav">
                  {pages.map((pageId) => {
                    const pageLink = pageHref(pageId);
                    if (!pageLink) return null;
                    const active = currentPageId === pageId;
                    return (
                      <Link
                        key={pageId}
                        className="console-menu-subitem"
                        href={pageLink}
                        aria-current={active ? "page" : undefined}
                      >
                        <span>{CONSOLE_PAGES[pageId].label}</span>
                        {renderPageBadges(pageId)}
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  function renderEventBranch(eventsLinkId: string) {
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
          <div className="console-hub-list">{renderEventHubs()}</div>
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
          role="dialog"
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
          <div className="operator-organization-panel"><OrganizationSwitcher confirmLeave={confirmLeave} /></div>
          <Link className="operator-menu-item" href="/account/email">
            <span>내 계정 이메일 인증</span>
          </Link>
          {canManageTeam ? (
            <Link
              className="operator-menu-item"
              href={consolePageHref("team")!}
            >
              <span>{CONSOLE_PAGES.team.label}</span>
            </Link>
          ) : null}
          {canManageIntegrations ? (
            <button type="button" className="operator-menu-item" disabled>
              <span>서비스 연동</span><span className="operator-menu-status">준비 중</span>
            </button>
          ) : null}
          {(canManageTeam || canManageIntegrations) ? (
            <div className="operator-menu-divider" aria-hidden="true" />
          ) : null}
          <button
            type="button"
            className="operator-menu-item operator-menu-logout"
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
              aria-label="메뉴"
              aria-expanded={globalMenuOpen}
              aria-controls="console-global-menu"
              onClick={handleGlobalMenuTrigger}
            >
              <BarsIcon className="console-global-trigger-bars" />
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
              {renderMobileEventMenu()}
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
          aria-haspopup="dialog"
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
          {renderTeamLink("workspace-team-link")}
        </nav>

        <div className="sidebar-bottom">
          <button
            ref={operatorTriggerRef}
            type="button"
            className="operator-block operator-menu-trigger"
            aria-haspopup="dialog"
            aria-expanded={operatorMenuOpen}
            aria-controls="operator-menu"
            onClick={handleOperatorMenuTrigger}
          >
            <span className="operator-avatar" aria-hidden="true">{avatar}</span>
            <span className="operator-identity">
              <strong>{userName}</strong>
              <small>{organization.context?.organizationName ?? "운영사"} · {shellData?.roleLabel ?? "역할 확인 중"}</small>
            </span>
            <span className="operator-menu-caret" aria-hidden="true" />
          </button>
        </div>
      </aside>

      {menuItems}

      <div className="console-content-shell">
        <main id="main-content" className="console-main" tabIndex={-1}>
          <OrganizationContextNotice confirmLeave={confirmLeave} />
          {!organization.context ? <section className={freshnessStyles.selectionRequired}>
            <h1>작업할 운영사를 선택하세요</h1>
            <p>소속 운영사와 그곳에서 맡은 역할을 확인한 뒤 이동합니다.</p>
            <OrganizationSwitcher />
          </section> : <>
          {shellError ? (
            <div className="console-shell-error" role="alert">
              <span>내비게이션 정보를 불러오지 못했습니다. 화면 일부가 제한되어 보일 수 있습니다.</span>
              <button type="button" className="button button-secondary" onClick={() => setShellTick((tick) => tick + 1)}>
                다시 시도
              </button>
            </div>
          ) : null}
          {updateAvailable && !organization.changed && !["participants", "overview", "events"].includes(currentPage?.pageId ?? "") ? (
            <div className={freshnessStyles.notice} role="status">
              <span>다른 작업의 변경이 있을 수 있습니다. 작성 중인 입력은 그대로 유지했습니다.</span>
              <button type="button" className="button button-secondary" onClick={() => {
                if (!confirmLeave()) return;
                invalidateConsoleReads();
                setPageRevision((value) => value + 1);
                setUpdateAvailable(false);
              }}>최신 내용 불러오기</button>
            </div>
          ) : null}
          <fieldset disabled={organization.changed} className={freshnessStyles.contextLock}>
            <legend className="sr-only">{organization.context.organizationName} 작업 화면{organization.changed ? " · 문맥 변경으로 잠김" : ""}</legend>
            <div key={`${eventId ?? "organization"}:${pageRevision}`} className="console-route-content">{children}</div>
          </fieldset>
          </>}
        </main>
      </div>
    </div>
  );
}
