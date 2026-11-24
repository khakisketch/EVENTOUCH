import { Suspense } from "react";
import LoginForm from "./LoginForm";
import styles from "./login-entry.module.css";
import { loginCopy } from "./login-copy";

// Shared operator entry: staff and operators sign in here. The optional
// ?next= destination is validated client-side and rechecked by each target
// screen against the server-owned role and assignment.
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const resolved = await searchParams;
  const rawNext = Array.isArray(resolved.next) ? resolved.next[0] : resolved.next;
  const copy = loginCopy(rawNext);
  return (
    <main id="main-content" tabIndex={-1} className={`site-page auth-page login-page ${styles.stage}`}>
      <header className="auth-brand">
        <p className="auth-promise">{copy.promise}</p>
        <span className="wordmark">EVENTOUCH<span>{copy.bandLabel}</span></span>
      </header>
      <section className="auth-card" aria-label={copy.sectionLabel}>
        <h1>{copy.title}</h1>
        <Suspense fallback={<p className="loading-state" role="status">로그인 화면을 불러오고 있습니다.</p>}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}
