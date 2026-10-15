import StaffHub from "./StaffHub";

// Staff surface entry: the assignment hub lists only this account's active
// event work. Event-specific desk/booth work lives at
// /staff/events/[eventId]; every scan there is still validated server-side.
export default function StaffPage() {
  return (
    <main id="main-content" className="site-page staff-page">
      <header className="staff-header">
        <div><p className="eyebrow">스태프 업무</p><h1>내 업무</h1></div>
      </header>
      <StaffHub />
    </main>
  );
}
