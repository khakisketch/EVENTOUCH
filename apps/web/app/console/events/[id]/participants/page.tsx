import ParticipantList from "./ParticipantList";

// Slice 6b of the frontend migration: operator participant management.
// Status changes go through participant.status under the operator session;
// the server re-checks role and membership, so the UI gate below is display
// only and never a permission decision.
export default async function ConsoleParticipantsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page participants-page">
      <header className="console-page-header">
        <p className="eyebrow">참가자 관리</p>
      </header>
      <ParticipantList eventId={id} />
    </section>
  );
}
