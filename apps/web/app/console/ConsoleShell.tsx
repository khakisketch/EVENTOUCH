"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { loginHrefForLocation } from "../auth-redirect";

type JsonRecord = Record<string, unknown>;
type ShellData = {
  userName: string;
  role: string;
  roleLabel: string;
  canSeeEvents: boolean;
  canSeeClients: boolean;
  canManageTeam: boolean;
  canManageIntegrations: boolean;
  currentEventName: string | null;
  canAccessCurrentEvent: boolean;
  currentEventMeta: {
    stage: string;
    date: string;
    venue: string;
    pending: number;
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
  const eventMatch = pathname.match(/^\/console\/events\/([^/]+)/);
  let eventId: string | null = null;
  try {
    eventId = eventMatch ? decodeURIComponent(eventMatch[1]) : null;
  } catch {
    eventId = null;
  }
  const isHome = pathname === "/console";
  const isClients = pathname === "/console/clients";
  const isEventPath = Boolean(eventId);
  const eventBasePath = eventId ? `/console/events/${encodeURIComponent(eventId)}` : "";
  const isOverview = Boolean(eventBasePath && pathname === eventBasePath);
  const isParticipants = Boolean(eventBasePath && pathname.startsWith(`${eventBasePath}/participants`));
  const isMessages = Boolean(eventBasePath && pathname.startsWith(`${eventBasePath}/messages`));
  const isOperations = Boolean(eventBasePath && pathname.startsWith(`${eventBasePath}/operations`));
  const isPrograms = Boolean(eventBasePath && pathname.startsWith(`${eventBasePath}/programs`));
  const isSettings = Boolean(eventBasePath && pathname.startsWith(`${eventBasePath}/settings`));
  const isReports = Boolean(eventBasePath && pathname.startsWith(`${eventBasePath}/reports`));

  const [shellData, setShellData] = useState<ShellData | null>(null);
  const [shellTick, setShellTick] = useState(0);
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const [operatorMenuPosition, setOperatorMenuPosition] = useState<CSSProperties | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const operatorTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileOperatorTriggerRef = useRef<HTMLButtonElement>(null);
  const lastOperatorTriggerRef = useRef<HTMLButtonElement>(null);
  const operatorMenuRef = useRef<HTMLDivElement>(null);
  const mobileEventBranchRef = useRef<HTMLDivElement>(null);
  const menuFocusPendingRef = useRef(false);

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
        if (!meResponse.ok || !user) return;

        const userId = text(user.id);
        const role = text(user.role);
        const state = record(record(bootstrapPayload)?.state);
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
        const currentEventMeta = currentEvent ? summarize(currentEvent) : null;
        // Triage, not a directory: events that need hands (pending approvals)
        // or are live now, current one excluded, most pending first.
        const triage = events
          .filter((item) => text(item.id) && text(item.id) !== eventId)
          .map(summarize)
          .filter((item) => item.pending > 0 || item.stage === "LIVE")
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
            currentEventName: currentEvent ? text(currentEvent.name).trim() || "선택한 행사" : null,
            canAccessCurrentEvent,
            currentEventMeta,
            triage,
          });
        }
      } catch {
        // The routed screen owns its data error; keep the shell usable with safe defaults.
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
  const showCurrentEvent = Boolean(
    isEventPath && shellData?.canAccessCurrentEvent && shellData.currentEventName
  );

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
      if (
        target instanceof Node &&
        !operatorMenuRef.current?.contains(target) &&
        !isOperatorTrigger
      ) {
        closeOperatorMenu(true);
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

  async function logout() {
    if (logoutPending) return;
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
    if (operatorMenuOpen) {
      closeOperatorMenu();
    } else {
      menuFocusPendingRef.current = true;
      setOperatorMenuOpen(true);
    }
  }

  function renderEventsLink(id: string) {
    return canSeeEvents ? (
      <Link
        id={id}
        className={`console-nav-item console-nav-root-item${isHome ? " active" : isEventPath ? " active-path" : ""}`}
        href="/console"
        aria-current={isHome ? "page" : isEventPath ? "location" : undefined}
      >
        <EventsIcon />
        <span>행사</span>
      </Link>
    ) : null;
  }

  function renderClientsLink(id: string) {
    return canSeeClients ? (
      <Link
        id={id}
        className={`console-nav-item console-nav-root-item${isClients ? " active" : ""}`}
        href="/console/clients"
        aria-current={isClients ? "page" : undefined}
      >
        <ClientsIcon />
        <span>고객사</span>
      </Link>
    ) : null;
  }

  function renderEventBranch(eventsLinkId: string, mobile = false) {
    // Mobile keeps the compact in-row switcher; the triage list lives on
    // desktop where the sidebar has room. Switching happens on /console home.
    if (mobile) {
      return showCurrentEvent && eventId ? (
        <div
          ref={mobileEventBranchRef}
          className="nav-event-branch"
          role="group"
          aria-labelledby={eventsLinkId}
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
                {shellData.currentEventMeta.pending > 0 ? ` · 승인 ${shellData.currentEventMeta.pending} 남음` : ""}
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
                {item.pending > 0 ? (
                  <span className="nav-badge" aria-label={`승인 대기 ${item.pending}건`}>{item.pending}</span>
                ) : null}
              </Link>
            ))}
          </div>
        ) : null}
      </>
    ) : null;
  }

  function renderEventSubnav() {
    return (
      <>
        <Link
          className={`console-nav-item console-subnav-item${isOverview ? " active" : ""}`}
          href={eventBasePath}
          aria-current={isOverview ? "page" : undefined}
        >
          운영 현황
        </Link>
        <Link
          className={`console-nav-item console-subnav-item${isParticipants ? " active" : ""}`}
          href={`${eventBasePath}/participants`}
          aria-current={isParticipants ? "page" : undefined}
        >
          참가자
        </Link>
        <Link
          className={`console-nav-item console-subnav-item${isMessages ? " active" : ""}`}
          href={`${eventBasePath}/messages`}
          aria-current={isMessages ? "page" : undefined}
        >
          메시지
        </Link>
        <Link
          className={`console-nav-item console-subnav-item${isOperations ? " active" : ""}`}
          href={`${eventBasePath}/operations`}
          aria-current={isOperations ? "page" : undefined}
        >
          현장 운영
        </Link>
        <Link
          className={`console-nav-item console-subnav-item${isPrograms ? " active" : ""}`}
          href={`${eventBasePath}/programs`}
          aria-current={isPrograms ? "page" : undefined}
        >
          참여 프로그램
        </Link>
        <Link
          className={`console-nav-item console-subnav-item${isSettings ? " active" : ""}`}
          href={`${eventBasePath}/settings`}
          aria-current={isSettings ? "page" : undefined}
        >
          행사 설정
        </Link>
        <Link
          className={`console-nav-item console-subnav-item${isReports ? " active" : ""}`}
          href={`${eventBasePath}/reports`}
          aria-current={isReports ? "page" : undefined}
        >
          결과 보고서
        </Link>
      </>
    );
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
              href="/console/team"
            >
              <span>팀·권한</span>
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
      <aside className="console-sidebar" aria-label="운영 콘솔">
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
          {renderEventBranch("workspace-events-link-mobile", true)}
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
          {children}
        </main>
      </div>

      <nav
        className={`side-nav mobile-primary-nav${Number(canSeeEvents) + Number(canSeeClients) === 1 ? " side-nav-single-root" : ""}`}
        aria-label="주요 메뉴"
      >
        {renderEventsLink("workspace-events-link-mobile")}
        {renderClientsLink("workspace-clients-link-mobile")}
      </nav>
    </div>
  );
}
