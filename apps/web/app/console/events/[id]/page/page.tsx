import ThemeWorkspace from "./ThemeWorkspace";

export default async function ConsoleAttendeePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page">
      <ThemeWorkspace eventId={id} />
    </section>
  );
}
