import EvidencePhotosWorkspace from "./EvidencePhotosWorkspace";

export default async function ConsoleEvidencePhotosPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page" aria-label="현장 사진 관리">
      <EvidencePhotosWorkspace key={id} eventId={id} />
    </section>
  );
}
