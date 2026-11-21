import AttendeeScreenHub from "../AttendeeScreenHub";
import ThemeWorkspace from "./ThemeWorkspace";
import { configuredPublicBase } from "../../../../../lib/public-origin";

export default async function ConsoleAttendeePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <section className="console-page">
      <ThemeWorkspace eventId={id} publicBase={configuredPublicBase()} afterHeader={<AttendeeScreenHub eventId={id} active="design" />} />
    </section>
  );
}
