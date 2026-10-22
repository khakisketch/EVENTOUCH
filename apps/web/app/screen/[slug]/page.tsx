import DisplayBoard from "./DisplayBoard";

// Public venue board. The client polls the safe public projection, honors the
// operator's published display selection, and keeps its last good frame during
// transient network failures.
export default async function ScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
      <main id="main-content" tabIndex={-1} className="display-page">
      <DisplayBoard slug={slug} />
    </main>
  );
}
