import ReportsWorkspace from "./ReportsWorkspace";

// Event results: live analysis computed from the same workspace the server
// snapshots, plus snapshot reports (create/edit/publish/new version) through
// the idempotent event command path.
export default async function ConsoleReportsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page" aria-label="결과 보고서">
      <ReportsWorkspace eventId={id} />
    </section>
  );
}
