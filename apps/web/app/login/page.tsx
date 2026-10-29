import { Suspense } from "react";
import LoginForm from "./LoginForm";

// Shared operator entry: staff and operators sign in here. The optional
// ?next= destination is validated client-side and rechecked by each target
// screen against the server-owned role and assignment.
export default function LoginPage() {
  return (
    <main id="main-content" tabIndex={-1} className="site-page auth-page login-page">
      <header className="auth-brand">
        <p className="auth-promise">모집부터 결과까지, 행사 운영을 한곳에서.</p>
        <span className="wordmark">EVENTOUCH<span>운영 로그인</span></span>
      </header>
      <section className="auth-card" aria-label="운영 로그인">
        <h1>로그인</h1>
        <Suspense fallback={<p className="loading-state" role="status">로그인 화면을 불러오고 있습니다.</p>}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  );
}
