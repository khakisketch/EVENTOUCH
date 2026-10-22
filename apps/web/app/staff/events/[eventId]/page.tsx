import StaffEventWork from "../../StaffEventWork";

// Event-specific field work: the assignment hub links here with an event id.
// The screen rechecks the assignment server-side on every load and scan.
export default async function StaffEventPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return (
    <main id="main-content" tabIndex={-1} className="site-page staff-page">
      <header className="staff-header">
        <div><p className="eyebrow">스태프 업무</p><h1>현장 업무</h1></div>
      </header>
      <StaffEventWork eventId={eventId} />
    </main>
  );
}
