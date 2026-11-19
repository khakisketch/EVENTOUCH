import LiveWorkspace from "./LiveWorkspace";

// 현장 모드: the day-of control room. A dark view-and-control surface over the
// event's schedule, participation events, venue display and reward handover;
// every write is an existing command with its existing gates.
export default async function ConsoleLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <section className="console-page live-page">
      <LiveWorkspace eventId={id} />
    </section>
  );
}
