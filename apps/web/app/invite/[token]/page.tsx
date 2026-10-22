import { notFound } from "next/navigation";
import InviteAccept from "./InviteAccept";

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

// Invitation links carry a single-use bearer by design; the page reads only
// its public metadata and never persists the token.
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{40,128}$/.test(token)) notFound();
  const res = await fetch(
    `${apiBase()}/api/auth/invitations/${encodeURIComponent(token)}`,
    { cache: "no-store" }
  );
  if (!res.ok) notFound();
  const data = (await res.json().catch(() => null)) as {
    invitation?: {
      name?: unknown;
      email?: unknown;
      role?: unknown;
      eventId?: unknown;
      status?: unknown;
      expiresAt?: unknown;
    } | null;
  } | null;
  const invitation = data?.invitation;
  if (
    !invitation ||
    typeof invitation.name !== "string" ||
    typeof invitation.email !== "string"
  ) {
    notFound();
  }
  return (
    <main id="main-content" tabIndex={-1} className="site-page auth-page">
      <InviteAccept
        token={token}
        invitation={{
          name: invitation.name,
          email: invitation.email,
          role: typeof invitation.role === "string" ? invitation.role : "",
          eventId: typeof invitation.eventId === "string" ? invitation.eventId : null,
          status: typeof invitation.status === "string" ? invitation.status : "",
          expiresAt: typeof invitation.expiresAt === "string" ? invitation.expiresAt : "",
        }}
      />
    </main>
  );
}
