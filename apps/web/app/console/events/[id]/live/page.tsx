import ConsolePage from "../../../console-ui/ConsolePage";

// 현장 모드: the day-of control room. The workspace is filled in by the live-mode slice;
// until then the route resolves so the menu, titles and deep links are stable.
export default async function ConsoleLivePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <section className="console-page live-page">
      <ConsolePage pageId="live" eventId={id} eventName="">
        <p>현장 모드는 준비 중입니다.</p>
      </ConsolePage>
    </section>
  );
}
