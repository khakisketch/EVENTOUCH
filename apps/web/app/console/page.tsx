import ConsoleHome from "./ConsoleHome";

// Workspace home: cross-event priorities and directory. Each event's
// overview owns the event-specific operating dashboard.
export default function ConsolePage() {
  return (
    <section className="console-page console-home-page" aria-label="행사 워크스페이스">
      <ConsoleHome />
    </section>
  );
}
