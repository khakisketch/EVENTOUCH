"use client";

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

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
};

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
  const isSettings = Boolean(eventBasePath && pathname.startsWith(`${eventBasePath}/settings`));

  const [shellData, setShellData] = useState<ShellData | null>(null);
  const [shellTick, setShellTick] = useState(0);
  const [operatorMenuOpen, setOperatorMenuOpen] = useState(false);
  const [operatorMenuPosition, setOperatorMenuPosition] = useState<CSSProperties | null>(null);
  const [portalReady, setPortalReady] = useState(false);
  const [logoutPending, setLogoutPending] = useState(false);
  const [logoutError, setLogoutError] = useState<string | null>(null);
  const operatorTriggerRef = useRef<HTMLButtonElement>(null);
  const operatorMenuRef = useRef<HTMLDivElement>(null);
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
          router.replace("/staff/login");
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
  const roleLabel = shellData?.roleLabel ?? "운영 워크스페이스";
  const canSeeEvents = shellData?.canSeeEvents ?? false;
  const canSeeClients = shellData?.canSeeClients ?? false;
  const canManageTeam = shellData?.canManageTeam ?? false;
  const canManageIntegrations = shellData?.canManageIntegrations ?? false;
  const showCurrentEvent = Boolean(
    isEventPath && shellData?.canAccessCurrentEvent && shellData.currentEventName
  );
  const topbarLabel = isHome
    ? "행사"
    : isClients
      ? "고객사"
      : showCurrentEvent
        ? shellData?.currentEventName ?? "행사 운영"
        : isEventPath
          ? "행사 운영"
          : "운영 워크스페이스";

  function closeOperatorMenu(restoreFocus = false) {
    menuFocusPendingRef.current = false;
    setOperatorMenuOpen(false);
    setOperatorMenuPosition(null);
    if (restoreFocus) {
      window.requestAnimationFrame(() => operatorTriggerRef.current?.focus());
    }
  }

  function updateOperatorMenuPosition() {
    const trigger = operatorTriggerRef.current;
    const menu = operatorMenuRef.current;
    if (!trigger || !menu) return;
    const rect = trigger.getBoundingClientRect();
    const gutter = 8;
    const maxHeight = Math.max(120, window.innerHeight - gutter * 4);
    const menuHeight = Math.min(menu.scrollHeight, maxHeight);
    const width = Math.min(rect.width, window.innerWidth - gutter * 2);
    const left = Math.min(Math.max(gutter, rect.left), window.innerWidth - width - gutter);
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
      if (
        target instanceof Node &&
        !operatorMenuRef.current?.contains(target) &&
        !operatorTriggerRef.current?.contains(target)
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
      router.replace("/staff/login");
      router.refresh();
    } catch {
      setLogoutError("연결을 확인한 뒤 다시 로그아웃하세요.");
    } finally {
      setLogoutPending(false);
    }
  }

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
          {canManageTeam ? (
            <button type="button" className="operator-menu-item" role="menuitem" disabled>
              <span>팀·권한</span><span className="operator-menu-status">준비 중</span>
            </button>
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
          <span className="console-tagline">행사 운영</span>
        </Link>

        <nav className="side-nav" aria-label="주요 메뉴">
          {canSeeEvents ? (
            <Link
              id="workspace-events-link"
              className={`console-nav-item${isHome ? " active" : isEventPath ? " active-path" : ""}`}
              href="/console"
              aria-current={isHome ? "page" : undefined}
            >
              <EventsIcon />
              <span>행사</span>
            </Link>
          ) : null}
          {showCurrentEvent && eventId ? (
            <div className="nav-event-branch" role="group" aria-labelledby="workspace-events-link">
              <div className="nav-current-event">
                <strong title={shellData?.currentEventName ?? undefined}>{shellData?.currentEventName}</strong>
                <Link className="nav-event-switch" href="/console">목록에서 전환</Link>
              </div>
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
                className={`console-nav-item console-subnav-item${isSettings ? " active" : ""}`}
                href={`${eventBasePath}/settings`}
                aria-current={isSettings ? "page" : undefined}
              >
                행사 설정
              </Link>
            </div>
          ) : null}
          {canSeeClients ? (
            <Link
              className={`console-nav-item${isClients ? " active" : ""}`}
              href="/console/clients"
              aria-current={isClients ? "page" : undefined}
            >
              <ClientsIcon />
              <span>고객사</span>
            </Link>
          ) : null}
        </nav>

        <div className="sidebar-bottom">
          <button
            ref={operatorTriggerRef}
            type="button"
            className="operator-block operator-menu-trigger"
            aria-haspopup="menu"
            aria-expanded={operatorMenuOpen}
            aria-controls="operator-menu"
            onClick={() => {
              setLogoutError(null);
              if (operatorMenuOpen) {
                closeOperatorMenu();
              } else {
                menuFocusPendingRef.current = true;
                setOperatorMenuOpen(true);
              }
            }}
          >
            <span className="operator-avatar" aria-hidden="true">{avatar}</span>
            <span className="operator-identity">
              <strong>{userName}</strong>
              <small>{roleLabel}</small>
            </span>
            <span className="operator-menu-caret" aria-hidden="true" />
          </button>
        </div>
      </aside>

      {menuItems}

      <div className="console-content-shell">
        <header className="console-topbar">
          <p className="console-breadcrumb">{topbarLabel}</p>
        </header>
        <main id="main-content" className="console-main" tabIndex={-1}>
          {children}
        </main>
        <footer className="console-footer">
          EVENTOUCH <span>운영 워크스페이스</span>
        </footer>
      </div>
    </div>
  );
}
