import SettingsWorkspace from "./SettingsWorkspace";

// Slice 6e: event settings — basics, intake, feature toggles, stage.
// Attendee page editing lives only in ../page (ThemeWorkspace); settings
// keeps a status link there. Everything posts through the single command
// path; server validation and the forward-only stage rules stay authoritative.
export default async function ConsoleSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page settings-page">
      <SettingsWorkspace eventId={id} />
    </section>
  );
}
