import ConsoleHome from "./ConsoleHome";

// Slice 6a of the frontend migration: the operator console, read-only first.
// The workspace home is the event list (no separate KPI dashboard); each
// event's overview owns its dashboard. Writes follow in later slices.
export default function ConsolePage() {
  return (
    <main>
      <p>행사 운영</p>
      <h1>행사</h1>
      <ConsoleHome />
    </main>
  );
}
