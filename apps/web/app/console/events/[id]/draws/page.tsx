import DrawsWorkspace from "./DrawsWorkspace";

export default async function ConsoleDrawsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page draws-page">
      <DrawsWorkspace eventId={id} />
    </section>
  );
}
