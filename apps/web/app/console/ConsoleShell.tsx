"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

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
  const isHome = pathname === "/console";
  const isClients = pathname === "/console/clients";
  const isEventPath = pathname.startsWith("/console/events/");

  return (
    <div className="console-shell">
      <aside className="console-sidebar" aria-label="운영 워크스페이스">
        <Link className="console-brand" href="/console">
          <span className="console-wordmark">EVENTOUCH</span>
          <span className="console-tagline">행사 운영</span>
        </Link>

        <nav className="side-nav" aria-label="주요 메뉴">
          <Link
            className={`console-nav-item${isHome ? " active" : isEventPath ? " active-path" : ""}`}
            href="/console"
            aria-current={isHome ? "page" : undefined}
          >
            <EventsIcon />
            <span>행사</span>
          </Link>
          <Link
            className={`console-nav-item${isClients ? " active" : ""}`}
            href="/console/clients"
            aria-current={isClients ? "page" : undefined}
          >
            <ClientsIcon />
            <span>고객사</span>
          </Link>
        </nav>

        <div className="sidebar-bottom">
          <div className="operator-block">
            <span className="operator-avatar" aria-hidden="true">운</span>
            <span className="operator-identity">
              <strong>운영자</strong>
              <small>운영 워크스페이스</small>
            </span>
          </div>
        </div>
      </aside>

      <div className="console-content-shell">
        <header className="console-topbar">
          <p className="console-breadcrumb">운영 워크스페이스</p>
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
