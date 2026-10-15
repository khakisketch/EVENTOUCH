"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Service entry: signed-in operators return to their work surface, everyone
// else gets the one door that matters (the shared login). Attendees never
// come through here; their invitation message links straight at their event.
export default function Home() {
  const router = useRouter();
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function restore() {
      try {
        const res = await fetch("/api/auth/me", { cache: "no-store" });
        if (cancelled) return;
        if (!res.ok) return;
        const data = (await res.json().catch(() => null)) as {
          user?: { role?: unknown } | null;
        } | null;
        const role = data?.user?.role;
        if (!role) return;
        router.replace(role === "STAFF" ? "/staff" : "/console");
      } catch {
        // Stay on the entry; the login screen owns the failure.
      } finally {
        if (!cancelled) setChecking(false);
      }
    }
    restore();
    return () => {
      cancelled = true;
    };
  }, [router]);

  if (checking) {
    return (
      <main id="main-content" className="site-page home-page">
        <p className="loading-state" role="status">확인하고 있습니다.</p>
      </main>
    );
  }

  return (
    <main id="main-content" className="site-page home-page">
      <header className="home-header">
        <span className="wordmark">EVENTOUCH<span>행사 운영 워크스페이스</span></span>
        <span className="header-mark" aria-hidden="true">E</span>
      </header>
      <section className="home-hero">
        <p className="eyebrow">행사대행 운영</p>
        <h1>행사를 끝까지 운영합니다</h1>
        <p className="home-description">모집·승인·안내부터 현장 체크인, 결과 보고서까지 한 곳에서 이어갑니다.</p>
        <Link className="event-link-card" href="/login">
          <span className="event-card-kicker">운영자·스태프</span>
          <span className="event-card-title">로그인하기</span>
          <span className="event-card-arrow" aria-hidden="true">↗</span>
        </Link>
        <p className="home-description">행사 참가자는 초대 메시지의 행사 링크로 바로 접속하세요.</p>
      </section>
      <footer className="home-footer">EVENTOUCH <span>행사 운영 워크스페이스</span></footer>
    </main>
  );
}
