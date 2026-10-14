import StaffLoginForm from "./StaffLoginForm";

// Slice 4 of the frontend migration: staff check-in. Login first; the
// session cookie is same-origin (HttpOnly, Path=/), so later API calls
// through the /api rewrite carry it without any token handling here.
export default function StaffLoginPage() {
  return (
      <main id="main-content" className="site-page auth-page staff-login-page">
        <header className="auth-brand">
          <span className="wordmark">EVENTOUCH<span>스태프 업무</span></span>
        </header>
        <section className="auth-card">
        <h1>로그인</h1>
        <StaffLoginForm />
        </section>
      </main>
  );
}
