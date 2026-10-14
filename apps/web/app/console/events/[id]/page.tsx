import EventOverview from "./EventOverview";

// Per-event operating snapshot. Event stage writes stay in EventOverview and
// use the single idempotent event command path.
export default async function ConsoleEventPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page" aria-label="행사 운영 현황">
      <EventOverview eventId={id} />
    </section>
  );
}
