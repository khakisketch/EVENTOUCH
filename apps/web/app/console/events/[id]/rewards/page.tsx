import RewardsWorkspace from "./RewardsWorkspace";

// Reward handout desk. Registration happens on the participant row; this
// screen owns fulfilment and cancellation under the same command path.
export default async function ConsoleRewardsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page">
      <RewardsWorkspace eventId={id} />
    </section>
  );
}
