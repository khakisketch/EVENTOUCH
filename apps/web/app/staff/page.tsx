import StaffConsole from "./StaffConsole";

// Slice 4a: assignment-scoped desk check-in with manual ticket entry.
// Camera scanning follows as slice 4b. Every scan is validated server-side;
// this screen only transports the ticket the operator typed or scanned.
export default function StaffPage() {
  return (
    <main>
      <p>스태프 업무</p>
      <h1>체크인</h1>
      <StaffConsole />
    </main>
  );
}
