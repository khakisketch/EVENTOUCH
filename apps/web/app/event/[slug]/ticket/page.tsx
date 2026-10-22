import TicketView from "./TicketView";

// Slice 3 of the frontend migration: the issued ticket. The bearer arrives
// in the address once (from registration) and the client component consumes
// it immediately, keeps it in memory, and cleans the address. Ticket state
// always comes from the server; this page never trusts the link alone.
export default async function TicketPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
      <main id="main-content" tabIndex={-1} className="site-page ticket-page">
        <header className="public-page-header">
          <span className="compact-wordmark">EVENTOUCH</span>
          <p className="eyebrow">내 티켓</p>
        </header>
        <TicketView slug={slug} />
        <footer className="public-page-footer">EVENTOUCH <span>내 티켓</span></footer>
      </main>
  );
}
