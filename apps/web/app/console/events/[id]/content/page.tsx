import ContentWorkspace from "./ContentWorkspace";

export default async function ConsoleContentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page content-page">
      <ContentWorkspace eventId={id} />
    </section>
  );
}
