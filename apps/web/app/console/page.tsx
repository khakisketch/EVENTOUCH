import ConsoleHome from "./ConsoleHome";

// Slice 6a of the frontend migration: the operator console, read-only first.
// The workspace home is the event list (no separate KPI dashboard); each
// event's overview owns its dashboard. Writes follow in later slices.
export default function ConsolePage() {
  return (
    <section className="console-page console-home-page">
      <header className="console-page-header">
        <h1>행사</h1>
      </header>
      <ConsoleHome />
    </section>
  );
}
