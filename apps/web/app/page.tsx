"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

// Service entry: signed-in operators return to their work surface, everyone
// else gets the SaaS landing. Attendees never come through here; their
// invitation message links straight at their event. Inquiries are email-only:
// the proposal mock form was UI-only and never had server storage.
const CONTACT_EMAIL = "contact@eventouch.co.kr";

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
        <Link className="button" href="/login">로그인</Link>
      </header>
      <section className="home-hero">
        <p className="eyebrow">행사대행 운영 SaaS</p>
        <h1>행사를 끝까지 운영하는 하나의 워크스페이스</h1>
        <p className="home-description">모집·승인·안내부터 현장 체크인, 결과 보고서까지 한 곳에서 이어갑니다.</p>
        <Link className="event-link-card" href="/login">
          <span className="event-card-kicker">운영자·스태프</span>
          <span className="event-card-title">로그인하기</span>
          <span className="event-card-arrow" aria-hidden="true">↗</span>
        </Link>
        <p className="home-description">행사 참가자는 초대 메시지의 행사 링크로 바로 접속하세요.</p>
      </section>
      <section className="landing-section" aria-label="핵심 흐름">
        <h2>핵심 흐름</h2>
        <p className="landing-lead">행사 하나를 처음부터 끝까지 완주하는 세 흐름입니다.</p>
        <ul className="landing-grid">
          <li className="landing-card">
            <h3>모집·승인·안내</h3>
            <p>참가 신청을 받고 승인하며 문자·알림톡으로 안내합니다.</p>
          </li>
          <li className="landing-card">
            <h3>현장 운영</h3>
            <p>스태프를 배정하고 체크인·부스·전광판을 운영합니다.</p>
          </li>
          <li className="landing-card">
            <h3>결과·보고서</h3>
            <p>등록·입장·참여를 집계하고 보고서를 작성·공유합니다.</p>
          </li>
        </ul>
      </section>
      <section className="landing-section" aria-label="이용 대상">
        <h2>이용 대상</h2>
        <p className="landing-lead">역할마다 쓰는 화면이 다릅니다.</p>
        <ul className="audience-grid">
          <li className="landing-card">
            <h3>운영사</h3>
            <p>행사 기획·모집·정산 준비를 데스크톱 콘솔에서 총괄합니다.</p>
          </li>
          <li className="landing-card">
            <h3>현장 스태프</h3>
            <p>배정된 데스크·부스에서 모바일로 체크인합니다.</p>
          </li>
          <li className="landing-card">
            <h3>참가자</h3>
            <p>앱 설치 없이 신청하고 티켓 QR로 입장합니다.</p>
          </li>
          <li className="landing-card">
            <h3>행사장 출력</h3>
            <p>공지·프로그램·현장 안내를 대화면에 투영합니다.</p>
          </li>
        </ul>
      </section>
      <section className="landing-section" aria-label="도입 문의">
        <h2>도입 문의</h2>
        <p className="landing-lead">도입 문의는 이메일로 받습니다. 문의 폼은 두지 않습니다.</p>
        <a className="event-link-card" href={`mailto:${CONTACT_EMAIL}`}>
          <span className="event-card-kicker">이메일 문의</span>
          <span className="event-card-title">{CONTACT_EMAIL}</span>
          <span className="event-card-arrow" aria-hidden="true">↗</span>
        </a>
        <p className="landing-note">행사 종류·일정·예상 규모를 함께 적어 주시면 안내가 빠릅니다.</p>
      </section>
      <section className="landing-section" aria-label="약관 및 개인정보">
        <h2>약관·개인정보</h2>
        <p className="landing-lead">이용약관·개인정보처리방침 본문은 준비 중입니다. 먼저 지키는 원칙입니다.</p>
        <ul className="policy-list">
          <li>고객사 정보는 운영사의 내부 기록이며 고객사 포털·로그인을 제공하지 않습니다.</li>
          <li>입장 QR에는 무작위 티켓 토큰만 담고 개인정보를 싣지 않습니다.</li>
          <li>문자·알림톡 요금은 운영사 부담을 전제로 하며 청구 화면을 두지 않습니다.</li>
        </ul>
      </section>
      <footer className="home-footer">
        <span>EVENTOUCH <span>행사 운영 워크스페이스</span></span>
        <span><Link href="/login">운영자·스태프 로그인</Link> · 이용약관·개인정보처리방침 준비 중</span>
      </footer>
    </main>
  );
}
