import ImportWizard from "./ImportWizard";

// Participant import: CSV/TXT file, column mapping, server-checked preview,
// then participant.import under the operator session. Same 1MB/1,000-row
// limits as the legacy flow; the server re-checks duplicates and capacity.
export default async function ConsoleParticipantImportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page participants-page">
      <ImportWizard eventId={id} />
    </section>
  );
}
