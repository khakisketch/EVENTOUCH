import EventOverview from "./EventOverview";

// Slice 6a: the per-event operations overview, read-only. Order follows the
// decided console IA: header (schedule, venue, stage, intake) → key metrics
// → what needs doing now → recent in/out. Writes follow in later slices.
export default async function ConsoleEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
      <main id="main-content" className="site-page console-page overview-page">
        <header className="console-page-header">
          <span className="compact-wordmark">EVENTOUCH</span>
          <p className="eyebrow">운영 현황</p>
        </header>
        <EventOverview eventId={id} />
        <footer className="console-footer">EVENTOUCH <span>운영 워크스페이스</span></footer>
    </main>
  );
}
