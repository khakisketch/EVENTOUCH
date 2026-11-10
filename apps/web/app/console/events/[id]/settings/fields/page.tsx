import FieldsWorkspace from './FieldsWorkspace';

export default async function ApplicationFieldsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <section className="console-page"><FieldsWorkspace eventId={id} /></section>;
}
