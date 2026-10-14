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
    <main>
      <p>내 티켓</p>
      <TicketView slug={slug} />
    </main>
  );
}
