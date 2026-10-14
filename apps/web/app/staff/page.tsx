import StaffConsole from "./StaffConsole";

// Staff surface: assignment-scoped desk check-in and booth certification
// (slice 4a/4b plus the booth path). Every scan is validated server-side;
// this screen only transports the ticket the operator typed or scanned.
export default function StaffPage() {
  return (
    <main id="main-content" className="site-page staff-page">
      <header className="staff-header">
        <div><p className="eyebrow">스태프 업무</p><h1>현장 업무</h1></div>
      </header>
      <StaffConsole />
    </main>
  );
}
