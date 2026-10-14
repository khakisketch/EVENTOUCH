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
      <main id="main-content" className="site-page console-page participants-page">
        <header className="console-page-header">
          <span className="compact-wordmark">EVENTOUCH</span>
          <p className="eyebrow">참가자 관리</p>
        </header>
        <ParticipantList eventId={id} />
        <footer className="console-footer">EVENTOUCH <span>운영 워크스페이스</span></footer>
    </main>
  );
}
