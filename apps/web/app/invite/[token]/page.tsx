import Link from "next/link";
import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import styles from "../../auth-entry.module.css";
import InviteAccept from "./InviteAccept";
import { loginHref } from "../../auth-redirect";

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

function InviteFrame({ children }: { children: ReactNode }) {
  return (
    <main id="main-content" tabIndex={-1} className={`site-page auth-page invite-page ${styles.entry}`}>
      <header className="auth-brand">
        <p className="auth-promise">모집부터 결과까지, 행사 운영을 한곳에서.</p>
        <Link className="wordmark" href="/">EVENTOUCH<span aria-hidden="true">팀 초대 수락</span></Link>
      </header>
      {children}
    </main>
  );
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
  // Expired and already-handled links are named, not lumped into the
  // generic missing page: 410 means the link aged out, 409 means it was
  // already accepted, revoked, or stored with an unknown role.
  if (res.status === 410) {
    return (
      <InviteFrame>
        <section className="auth-card invite-card" aria-label="팀 초대 수락">
          <h1>초대 링크가 만료되었습니다</h1>
          <p>초대 유효 기간이 지났습니다. 운영자에게 새 초대를 요청하세요.</p>
          <p>
            <Link className="button button-secondary" href={loginHref(`/invite/${token}`)}>로그인으로</Link>
          </p>
        </section>
      </InviteFrame>
    );
  }
  if (res.status === 409) {
    return (
      <InviteFrame>
        <section className="auth-card invite-card" aria-label="팀 초대 수락">
          <h1>이미 처리된 초대입니다</h1>
          <p>이 초대는 이미 수락되었거나 철회되었습니다. 로그인 후 소속을 확인하세요.</p>
          <p>
            <Link className="button button-secondary" href={loginHref(`/invite/${token}`)}>로그인으로</Link>
          </p>
        </section>
      </InviteFrame>
    );
  }
  if (!res.ok) notFound();
  const data = (await res.json().catch(() => null)) as {
    invitation?: {
      name?: unknown;
      email?: unknown;
      role?: unknown;
      eventId?: unknown;
      status?: unknown;
      expiresAt?: unknown;
      requiresSignIn?: unknown;
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
    <InviteFrame>
      <InviteAccept
        token={token}
        invitation={{
          name: invitation.name,
          email: invitation.email,
          role: typeof invitation.role === "string" ? invitation.role : "",
          eventId: typeof invitation.eventId === "string" ? invitation.eventId : null,
          status: typeof invitation.status === "string" ? invitation.status : "",
          expiresAt: typeof invitation.expiresAt === "string" ? invitation.expiresAt : "",
          requiresSignIn: invitation.requiresSignIn === true,
        }}
      />
    </InviteFrame>
  );
}
