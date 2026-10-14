import TeamWorkspace from "./TeamWorkspace";

// Team and permission screen: organization member list with owner-only
// password resets. Invitation issuance stays in the legacy console until
// its slice migrates; this screen never invents members.
export default function TeamPage() {
  return (
    <section className="console-page" aria-label="팀 관리">
      <TeamWorkspace />
    </section>
  );
}
