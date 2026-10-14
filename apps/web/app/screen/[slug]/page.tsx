import DisplayBoard from "./DisplayBoard";

// Slice 5 of the frontend migration: the venue board. Public, no session,
// polls the public projection on the legacy 5-second cadence and cycles
// published notices, program and venue info.
//
// Deliberate scope: this board does not yet honor the operator's display.set
// selection, because the public projection does not carry display config
// (it is hardcoded to idle server-side). Honoring the selection needs a
// public display-config contract first; until then the legacy screen keeps
// serving operator-driven output and this board is additive.
export default async function ScreenPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main>
      <DisplayBoard slug={slug} />
    </main>
  );
}
