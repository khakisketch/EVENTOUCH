import OperationsWorkspace from "./OperationsWorkspace";

// Slice 6d: on-site preparation — desks, booths and staff assignments.
// The LIVE transition requires at least one desk and one active desk
// assignment, so this screen is where an operator makes that true.
export default async function ConsoleOperationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page operations-page">
      <OperationsWorkspace eventId={id} />
    </section>
  );
}
