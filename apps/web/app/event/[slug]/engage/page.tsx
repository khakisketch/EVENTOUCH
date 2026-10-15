import EngageClient from "./EngageClient";

// Attendee entry to the published engagement programs (poll, quiz, survey,
// Q&A, photo, board, draw results). Reads the public projection only; every
// submission goes through the guest command path with the tab-kept ticket
// bearer. Without a ticket the screen explains and links to the ticket.
export default async function EngagePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <EngageClient slug={slug} />;
}
