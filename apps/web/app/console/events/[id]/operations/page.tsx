import OperationsWorkspace from "./OperationsWorkspace";
import { configuredPublicBase } from "../../../../../lib/public-origin";

// Slice 6d: on-site preparation — desks, booths and staff assignments.
// The LIVE transition requires one running entry desk, so this screen is where an
// operator makes that true.
export default async function ConsoleOperationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page operations-page">
      <OperationsWorkspace eventId={id} publicBase={configuredPublicBase()} />
    </section>
  );
}
