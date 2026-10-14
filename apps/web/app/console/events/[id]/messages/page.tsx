import MessagingWorkspace from "./MessagingWorkspace";

export default async function ConsoleMessagesPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page messaging-page">
      <MessagingWorkspace eventId={id} />
    </section>
  );
}
