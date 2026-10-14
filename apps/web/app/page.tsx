import Link from "next/link";

// Slice 1 of the frontend migration: public, read-only event pages.
// The legacy vanilla app at :8776 stays the product until each slice passes
// E2E/a11y/mobile and takes over deliberately. Nothing here writes.
export default function Home() {
  return (
    <main id="main-content" className="site-page home-page">
      <header className="home-header">
        <span className="wordmark">EVENTOUCH<span>행사 운영 워크스페이스</span></span>
        <span className="header-mark" aria-hidden="true">E</span>
      </header>
      <section className="home-hero">
        <p className="eyebrow">행사 운영 워크스페이스</p>
        <h1>EVENTOUCH</h1>
        <p className="home-description">행사 공개 페이지를 새 앱에서 확인합니다.</p>
        <Link className="event-link-card" href="/event/partner-demo">
          <span className="event-card-kicker">공개 행사</span>
          <span className="event-card-title">파트너 컨퍼런스 · 데모</span>
          <span className="event-card-arrow" aria-hidden="true">↗</span>
        </Link>
      </section>
      <footer className="home-footer">EVENTOUCH <span>행사 운영 워크스페이스</span></footer>
    </main>
  );
}
