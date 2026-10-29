import StaffEventWork from "../../StaffEventWork";
import workStyles from "../../staff-event-work.module.css";

// Event-specific field work: the assignment hub links here with an event id.
// The screen rechecks the assignment server-side on every load and scan.
// The page-local scope marker lets the staff module tighten shared chrome
// (header, workspace gaps) for this small-phone field screen only — globals
// stay untouched for every other page.
export default async function StaffEventPage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  return (
    <main id="main-content" tabIndex={-1} className={`site-page staff-page ${workStyles.eventWorkPage}`}>
      <header className="staff-header">
        <div><h1>현장 업무</h1></div>
      </header>
      <StaffEventWork eventId={eventId} />
    </main>
  );
}
