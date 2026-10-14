import ConsoleHome from "./ConsoleHome";

// Slice 6a of the frontend migration: the operator console, read-only first.
// The workspace home is the event list (no separate KPI dashboard); each
// event's overview owns its dashboard. Writes follow in later slices.
export default function ConsolePage() {
  return (
      <main id="main-content" className="site-page console-page console-home-page">
        <header className="console-page-header">
          <span className="compact-wordmark">EVENTOUCH</span>
          <p className="eyebrow">행사 운영</p>
        </header>
        <h1>행사</h1>
        <ConsoleHome />
        <footer className="console-footer">EVENTOUCH <span>운영 워크스페이스</span></footer>
    </main>
  );
}
