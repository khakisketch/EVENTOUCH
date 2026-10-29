"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./landing.module.css";

// Service entry: signed-in operators return to their work surface, everyone
// else sees the public landing. Attendees enter through their event link.
// Inquiries stay email-only; there is no server-backed proposal form.
const CONTACT_EMAIL = "contact@eventouch.co.kr";
const INQUIRY_SUBJECT = "EVENTOUCH 도입 문의";
const INQUIRY_BODY = "행사 종류:\n일정:\n예상 규모(인원):\n문의 내용:\n";
const INQUIRY_HREF =
  `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(INQUIRY_SUBJECT)}&body=${encodeURIComponent(INQUIRY_BODY)}`;

export default function Home() {
  const router = useRouter();
  const [copyStatus, setCopyStatus] = useState<{ message: string; tone: "success" | "error" } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeoutId = window.setTimeout(() => controller.abort(), 4000);

    async function restoreSession() {
      try {
        const res = await fetch("/api/auth/me", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!res.ok) return;

        const data = (await res.json().catch(() => null)) as {
          user?: { role?: unknown } | null;
        } | null;
        if (cancelled) return;

        const role = data?.user?.role;
        if (!role) return;
        router.replace(role === "STAFF" ? "/staff" : "/console");
      } catch {
        // This is a public entry surface: keep it usable if session lookup fails.
      } finally {
        window.clearTimeout(timeoutId);
      }
    }

    void restoreSession();
    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [router]);

  async function copyContactEmail() {
    try {
      await navigator.clipboard.writeText(CONTACT_EMAIL);
      setCopyStatus({ message: "이메일 주소를 복사했습니다.", tone: "success" });
    } catch {
      setCopyStatus({ message: "복사할 수 없습니다. 이메일 주소를 직접 선택해 복사해 주세요.", tone: "error" });
    }
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link className={styles.brand} href="/">
          <span className={styles.brandName}>EVENTOUCH</span>
          <span className={styles.brandDescription}>행사 운영 워크스페이스</span>
        </Link>
        <nav className={styles.siteNav} aria-label="페이지 메뉴">
          <a href="#journey">운영 흐름</a>
          <a href="#product-screens">역할별 화면</a>
          <a href="#report">결과 보고</a>
          <a href="#faq">확인 사항</a>
        </nav>
        <Link className={styles.loginLink} href="/login">운영자·스태프 로그인</Link>
      </header>

      <main id="main-content" tabIndex={-1}>
        <section className={styles.hero} aria-labelledby="home-title">
          <div className={styles.heroCopy}>
            <h1 className={styles.heroTitle} id="home-title">
              <span>행사 운영을</span>
              <span>모집부터 결과까지</span>
              <span>한 흐름으로.</span>
            </h1>
            <p className={styles.heroDescription}>
              참가자 모집·승인부터 현장 체크인과 결과 보고서까지, 한곳에서 이어갑니다.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryAction} href={INQUIRY_HREF}>
                이메일로 도입 문의
                <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
                  <path d="M4 10h11M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              <a className={styles.secondaryAction} href="#product-screens">실제 화면 먼저 보기 ↓</a>
            </div>
            <p className={styles.heroNote}>
              행사 종류·일정·규모를 적을 수 있게 준비합니다.
            </p>
          </div>

          <figure className={styles.consoleEvidence}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src="/evidence/ev-console.png"
              alt="파트너 컨퍼런스 데모의 운영 현황 화면. 승인 대기, 현재·누적 입장과 입장률을 확인합니다."
              width="1016"
              height="470"
              fetchPriority="high"
            />
            <figcaption>
              <strong>운영 현황 · 파트너 컨퍼런스 데모</strong>
              <span>실제 제품 화면 · 데모 행사 데이터</span>
            </figcaption>
          </figure>

          <ul className={styles.factStrip} aria-label="도입 전 핵심 사실">
            <li><a href="#faq-install">참가자 앱 설치 없음</a></li>
            <li><a href="#faq-sms">문자 발송은 현재 모의 발송</a></li>
            <li><a href="#faq-portal">고객사 포털 없음</a></li>
          </ul>
        </section>

        <section className={styles.flowSection} id="journey" aria-labelledby="flow-title">
          <div className={styles.sectionHeading}>
            <h2 id="flow-title">한 행사의 세 시점이 이어집니다.</h2>
            <p>행사 전 준비, 현장 진행, 행사 후 정리. 필요한 화면과 역할은 달라도 업무의 맥락은 이어집니다.</p>
          </div>
          <ol className={styles.flowLedger}>
            <li className={styles.flowRow}>
              <span className={styles.flowIndex} aria-hidden="true">01</span>
              <div className={styles.flowBody}>
                <p className={styles.flowPhase}>행사 전</p>
                <h3>모집 · 승인 · 안내</h3>
                <p>신청 명단과 참가 상태를 살피고, 안내할 대상을 정합니다.</p>
                <p className={styles.flowScreens}>쓰는 화면 · 참가자 명단, 메시지</p>
              </div>
            </li>
            <li className={styles.flowRow}>
              <span className={styles.flowIndex} aria-hidden="true">02</span>
              <div className={styles.flowBody}>
                <p className={styles.flowPhase}>행사 현장</p>
                <h3>체크인 · 참여</h3>
                <p>배정된 스태프가 QR 또는 참가자 검색으로 입장을 처리합니다.</p>
                <p className={styles.flowScreens}>쓰는 화면 · 스태프 체크인, 부스 인증</p>
              </div>
            </li>
            <li className={styles.flowRow}>
              <span className={styles.flowIndex} aria-hidden="true">03</span>
              <div className={styles.flowBody}>
                <p className={styles.flowPhase}>행사 후</p>
                <h3>결과 · 보고서</h3>
                <p>참가·입장·현장 기록을 모아 결과를 확인하고 보고서를 관리합니다.</p>
                <p className={styles.flowScreens}>쓰는 화면 · 결과 분석, 보고서</p>
              </div>
            </li>
          </ol>
        </section>

        <section className={styles.fieldSection} id="product-screens" aria-labelledby="field-title">
          <div className={styles.fieldLayout}>
            <div className={styles.fieldCopy}>
              <h2 id="field-title">운영자는 콘솔에서, 현장은 모바일에서.</h2>
              <p>운영사는 데스크톱 콘솔에서 흐름을 관리하고, 참가자와 스태프는 각자의 역할에 맞는 모바일 웹 화면을 사용합니다.</p>
              <p>참가자는 행사 링크에서 앱 설치 없이 신청하고, 스태프는 배정 데스크에서 QR·검색으로 입장 처리합니다.</p>
              <p className={styles.fieldNote}>아래는 같은 데모의 실제 제품 화면입니다. 티켓은 샘플이며 실제 입장에는 사용할 수 없습니다.</p>
            </div>
            <div
              className={styles.mobileEvidence}
              tabIndex={0}
              role="region"
              aria-label="역할별 실제 화면. 좌우로 밀어 세 화면을 봅니다."
            >
              <figure className={styles.phoneFigure}>
                <div className={styles.phoneFrame}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/evidence/ev-attendee-event.png"
                    alt="파트너 컨퍼런스 데모의 참가자 홈. 모바일 티켓, 공지사항과 참여 프로그램으로 이동하는 메뉴를 보여줍니다."
                    width="390"
                    height="844"
                    loading="lazy"
                  />
                </div>
                <figcaption>
                  <strong>참가자 행사 안내</strong>
                  <span>파트너 컨퍼런스 데모 · 모바일 첫 화면</span>
                </figcaption>
              </figure>
              <figure className={styles.phoneFigure}>
                <div className={styles.phoneFrame}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/evidence/ev-ticket.png"
                    alt="EVENTOUCH 데모 행사의 모바일 티켓. 참가 확정 상태와 입장 QR 안내, 참여 프로그램 보기를 보여줍니다. 샘플 QR이며 실제 입장에는 사용할 수 없습니다."
                    width="390"
                    height="844"
                    loading="lazy"
                  />
                </div>
                <figcaption>
                  <strong>참가자 모바일 티켓</strong>
                  <span>EVENTOUCH 데모 행사 · 샘플 QR</span>
                </figcaption>
              </figure>
              <figure className={styles.phoneFigure}>
                <div className={styles.phoneFrame}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src="/evidence/ev-staff.png"
                    alt="파트너 컨퍼런스 데모 현장 스태프 화면. 데스크를 선택하고 티켓 코드를 입력하거나 카메라로 스캔해 체크인합니다."
                    width="390"
                    height="844"
                    loading="lazy"
                  />
                </div>
                <figcaption>
                  <strong>현장 스태프</strong>
                  <span>파트너 컨퍼런스 데모 · 데스크 선택 · QR 스캔</span>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className={styles.reportSection} id="report" aria-labelledby="report-title">
          <div className={styles.reportLayout}>
            <div className={styles.reportCopy}>
              <h2 id="report-title">행사가 끝나면, 기록을 결과로.</h2>
              <p>등록·입장·부스·참여 기록을 확인하고 보고서를 관리합니다.</p>
              <p className={styles.reportProof}>결과 분석 · 파트너 컨퍼런스 데모 데이터</p>
            </div>
            <figure className={styles.reportEvidence}>
              <picture>
                <source media="(max-width: 768px)" srcSet="/landing/ev-report-mobile.png" />
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/evidence/ev-report.png"
                  alt="파트너 컨퍼런스 데모의 결과 보고서 화면. 행사 마감 상태, 저장된 보고서와 등록·입장 지표를 보여줍니다."
                  width="1280"
                  height="1108"
                  loading="lazy"
                />
              </picture>
              <figcaption>결과 보고서 · 등록·입장 집계 · 데모 데이터</figcaption>
              <p className={styles.reportCropNote}>작은 화면에서는 보고서 목록과 등록·입장 지표를 발췌해 보여줍니다.</p>
            </figure>
          </div>
        </section>

        <section className={styles.faqSection} id="faq" aria-labelledby="faq-title">
          <h2 id="faq-title">도입 전에 확인해 주세요.</h2>
          <details className={styles.faqItem} id="faq-install">
            <summary>참가자는 앱을 설치해야 하나요?</summary>
            <p>아니요. 행사별 링크에서 신청하고 모바일 웹 티켓으로 입장 정보를 확인합니다.</p>
          </details>
          <details className={styles.faqItem} id="faq-sms">
            <summary>문자·알림톡을 실제로 발송할 수 있나요?</summary>
            <p>현재는 모의 발송으로 동작합니다. 실발송 자격증명·발신번호·승인 템플릿이 준비되기 전에는 실제 발송되지 않습니다.</p>
          </details>
          <details className={styles.faqItem} id="faq-portal">
            <summary>고객사 담당자도 로그인해 사용할 수 있나요?</summary>
            <p>고객사 포털은 제공하지 않습니다. 고객사 정보는 행사 운영사가 내부 기록으로 관리합니다.</p>
          </details>
        </section>

        <section className={styles.contactSection} id="contact" aria-labelledby="contact-title">
          <div>
            <h2 id="contact-title">다음 행사의 운영 흐름을 함께 살펴보세요.</h2>
            <p>행사 종류와 일정, 예상 규모를 알려주시면 도입 상담으로 이어집니다.</p>
            <div className={styles.contactDetails}>
              <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              <button type="button" onClick={() => void copyContactEmail()}>
                이메일 주소 복사
              </button>
              <p className={styles.copyStatus} data-tone={copyStatus?.tone} role="status" aria-live="polite">
                {copyStatus?.message}
              </p>
            </div>
          </div>
          <a className={styles.primaryAction} href={INQUIRY_HREF}>
            이메일로 도입 문의
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
              <path d="M4 10h11M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </a>
        </section>
      </main>

      <footer className={styles.footer}>
        <span>EVENTOUCH · 행사 운영 워크스페이스</span>
        <span><Link href="/login">운영자·스태프 로그인</Link> · 이용약관·개인정보처리방침 준비 중</span>
      </footer>
    </div>
  );
}
