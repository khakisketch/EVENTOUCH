import { Suspense } from "react";
import styles from "../../auth-entry.module.css";
import EmailVerification from "./EmailVerification";

// The holder's own mailbox proof: signed-in only, global identity scope, no
// organization settings surface. The auth shell matches /login so keyboard,
// focus, and contrast behavior stay identical across entry points.
export default function AccountEmailPage() {
  return (
    <main id="main-content" tabIndex={-1} className={`site-page auth-page account-email-page ${styles.entry}`}>
      <header className="auth-brand">
        <p className="auth-promise">모집부터 결과까지, 행사 운영을 한곳에서.</p>
        <span className="wordmark">EVENTOUCH<span>내 계정 이메일 인증</span></span>
      </header>
      <section className="auth-card" aria-label="내 계정 이메일 인증">
        <h1>내 계정 이메일 인증</h1>
        <Suspense fallback={<p className="loading-state" role="status">인증 상태를 확인하고 있습니다.</p>}>
          <EmailVerification />
        </Suspense>
      </section>
    </main>
  );
}
