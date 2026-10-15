import ProgramsWorkspace from "./ProgramsWorkspace";

export default async function ConsoleProgramsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page programs-page">
      <ProgramsWorkspace eventId={id} />
    </section>
  );
}
