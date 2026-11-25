import { Suspense } from "react";
import EntryHome from "./EntryHome";
import { configuredPublicBase } from "../../../../../lib/public-origin";

// 입장 관리: the receiving screen itself, with desk, booth and staff setup behind it.
export default async function ConsoleOperationsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page operations-page">
      <Suspense fallback={null}>
        <EntryHome eventId={id} publicBase={configuredPublicBase()} />
      </Suspense>
    </section>
  );
}
