import { Suspense } from "react";
import styles from "../auth-entry.module.css";
import RecoverForm from "./RecoverForm";

// Logged-out password reset by verified email. The auth shell (skip link,
// main region, card) matches /login so keyboard, focus, and contrast behavior
// stay identical across the operator entry points.
export default function RecoverPage() {
  return (
    <main id="main-content" tabIndex={-1} className={`site-page auth-page recover-page ${styles.entry}`}>
      <header className="auth-brand">
        <p className="auth-promise">모집부터 결과까지, 행사 운영을 한곳에서.</p>
        <span className="wordmark">EVENTOUCH<span>비밀번호 재설정</span></span>
      </header>
      <section className="auth-card" aria-label="비밀번호 재설정">
        <h1>비밀번호 재설정</h1>
        <Suspense fallback={<p className="loading-state" role="status">재설정 화면을 불러오고 있습니다.</p>}>
          <RecoverForm />
        </Suspense>
      </section>
    </main>
  );
}
