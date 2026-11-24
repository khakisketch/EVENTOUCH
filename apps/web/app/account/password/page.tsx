import { Suspense } from "react";
import styles from "../../auth-entry.module.css";
import PasswordChange from "./PasswordChange";

// The holder's own password change: signed-in only, global identity scope, no
// organization settings surface. It reuses the shared account frame (dark band
// over a white sheet) so it reads like /login and /account/email.
export default function AccountPasswordPage() {
  return (
    <main id="main-content" tabIndex={-1} className={`site-page auth-page account-password-page ${styles.entry}`}>
      <header className="auth-brand">
        <p className="auth-promise">모집부터 결과까지, 행사 운영을 한곳에서.</p>
        <span className="wordmark">EVENTOUCH<span>비밀번호 변경</span></span>
      </header>
      <section className="auth-card" aria-label="비밀번호 변경">
        <h1>비밀번호 변경</h1>
        <Suspense fallback={<p className="loading-state" role="status">로그인 상태를 확인하고 있습니다.</p>}>
          <PasswordChange />
        </Suspense>
      </section>
    </main>
  );
}
