import HomeShell from "./HomeShell";

// Attendee landing shell for the mobile event experience. Five tabs share one
// route: personal QR check-in, event notices, personal lucky number, mobile
// roulette, and ranked voting. The ticket bearer stays tab-scoped in
// sessionStorage exactly as on the ticket screen; no new persistent keys.
export default async function HomePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <HomeShell slug={slug} />;
}
