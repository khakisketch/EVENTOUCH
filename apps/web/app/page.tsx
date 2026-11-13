"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./landing.module.css";
import ProductPreview from "./ProductPreview";

// Service entry: signed-in operators return to their work surface, everyone
// else sees the public landing. Attendees enter through their event link.
// Inquiries stay email-only; there is no server-backed proposal form.
const CONTACT_EMAIL = "contact@eventouch.co.kr";
const INQUIRY_SUBJECT = "EVENTOUCH 도입 문의";
const INQUIRY_BODY =
  "행사 종류:\n일정:\n예상 규모(인원):\n연락처(성함/전화):\n궁금한 점:\n";

type HeroTab = {
  id: "console" | "ticket" | "report";
  label: string;
  caption: string;
  note: string;
};

const HERO_TABS: readonly HeroTab[] = [
  {
    id: "console",
    label: "운영 현황",
    caption: "운영 현황 · 파트너 컨퍼런스 데모",
    note: "화면 구성 예시 · 합성 데이터",
  },
  {
    id: "ticket",
    label: "모바일 티켓",
    caption: "참가자 모바일 티켓",
    note: "EVENTOUCH 데모 행사 · 샘플 QR",
  },
  {
    id: "report",
    label: "결과 보고서",
    caption: "결과 보고서 · 등록·입장 집계",
    note: "화면 구성 예시 · 합성 데이터",
  },
];
const INQUIRY_HREF =
  `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(INQUIRY_SUBJECT)}&body=${encodeURIComponent(INQUIRY_BODY)}`;

export default function Home() {
  const router = useRouter();
  const [copyStatus, setCopyStatus] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  const [heroTab, setHeroTab] = useState<HeroTab["id"]>("console");
  const [heroPaused, setHeroPaused] = useState(false);
  const activeHero = HERO_TABS.find((tab) => tab.id === heroTab) ?? HERO_TABS[0];

  useEffect(() => {
    if (heroPaused) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => {
      if (document.hidden) return;
      setHeroTab((prev) => {
        const index = HERO_TABS.findIndex((tab) => tab.id === prev);
        return HERO_TABS[(index + 1) % HERO_TABS.length].id;
      });
    }, 5000);
    return () => window.clearInterval(id);
  }, [heroPaused]);

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
        <a className={styles.headerCta} href={INQUIRY_HREF}>도입 문의</a>
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
              <a className={styles.secondaryAction} href="#product-screens">화면 구성 살펴보기 ↓</a>
            </div>
            <p className={styles.heroNote}>
              행사 종류·일정·규모를 적을 수 있게 준비합니다.
            </p>
          </div>

          <div
            className={styles.heroMedia}
            onMouseEnter={() => setHeroPaused(true)}
            onMouseLeave={() => setHeroPaused(false)}
            onFocus={() => setHeroPaused(true)}
            onBlur={() => setHeroPaused(false)}
          >
            <div className={styles.heroTabs} role="tablist" aria-label="핵심 화면 미리보기">
              {HERO_TABS.map((tab) => (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={tab.id === heroTab}
                  onClick={() => setHeroTab(tab.id)}
                >
                  {tab.label}
                </button>
              ))}
            </div>
            <figure className={styles.consoleEvidence} role="tabpanel" aria-label={activeHero.caption}>
              <div className={styles.windowBar} aria-hidden="true">
                <i />
                <i />
                <i />
                <span>{activeHero.caption}</span>
              </div>
              <ProductPreview variant={activeHero.id} />
              <figcaption>
                <strong>{activeHero.caption}</strong>
                <span>{activeHero.note}</span>
              </figcaption>
            </figure>
          </div>

          <ul className={styles.factStrip} aria-label="도입 전 핵심 사실">
            <li><a href="#faq-install">참가자 앱 설치 없음</a></li>
            <li><a href="#faq-sms">문자 발송 연결 확인</a></li>
            <li><a href="#faq-portal">고객사 포털 없음</a></li>
          </ul>
        </section>

        <section className={styles.proofSection} aria-label="운영 실적 예시">
          <ul className={styles.proofStats}>
            <li><strong>320+</strong><span>누적 운영 행사</span></li>
            <li><strong>86,000+</strong><span>누적 참가자</span></li>
            <li><strong>1곳</strong><span>모집부터 보고서까지</span></li>
          </ul>
          <p className={styles.proofNote}>예시 수치 · 실제 운영 실적은 도입 상담에서 공유합니다.</p>
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
              <p className={styles.fieldNote}>아래는 역할별 화면 구성 예시입니다. 티켓은 샘플이며 실제 입장에는 사용할 수 없습니다.</p>
            </div>
            <div
              className={styles.mobileEvidence}
              tabIndex={0}
              role="region"
              aria-label="역할별 화면 구성 예시. 좌우로 밀어 세 화면을 봅니다."
            >
              <figure className={styles.phoneFigure}>
                <div className={styles.phoneFrame}>
            <ProductPreview variant="home" />
                </div>
                <figcaption>
                  <strong>참가자 행사 안내</strong>
                  <span>파트너 컨퍼런스 데모 · 모바일 첫 화면</span>
                </figcaption>
              </figure>
              <figure className={styles.phoneFigure}>
                <div className={styles.phoneFrame}>
            <ProductPreview variant="ticket" />
                </div>
                <figcaption>
                  <strong>참가자 모바일 티켓</strong>
                  <span>EVENTOUCH 데모 행사 · 샘플 QR</span>
                </figcaption>
              </figure>
              <figure className={styles.phoneFigure}>
                <div className={styles.phoneFrame}>
            <ProductPreview variant="staff" />
                </div>
                <figcaption>
                  <strong>현장 스태프</strong>
                  <span>파트너 컨퍼런스 데모 · 데스크 선택 · QR 스캔</span>
                </figcaption>
              </figure>
            </div>
          </div>
        </section>

        <section className={styles.blockSection} aria-labelledby="audience-title">
          <h2 id="audience-title">이런 행사에 잘 맞습니다.</h2>
          <p className={styles.blockLead}>신청·입장·안내가 엇갈리기 시작하는 규모부터 진가를 발휘합니다.</p>
          <div className={styles.audienceGrid}>
            <article>
              <h3>컨퍼런스·세미나</h3>
              <p>100명 이상 참가자의 사전 등록부터 현장 입장까지 한 흐름으로 운영합니다.</p>
            </article>
            <article>
              <h3>입장 통제·사전 승인 행사</h3>
              <p>QR·명단 검색 체크인으로 입구 병목을 줄이고 중복 입장을 막습니다.</p>
            </article>
            <article>
              <h3>반복 교육·설명회</h3>
              <p>같은 틀을 복사해 매번 운영하고, 결과는 행사마다 따로 보관합니다.</p>
            </article>
            <article className={styles.audienceOff}>
              <h3>맞지 않는 경우</h3>
              <p>열 명 남짓한 내부 모임은 엑셀로 충분합니다. 그런 행사에는 권하지 않습니다.</p>
            </article>
          </div>
        </section>

        <section className={styles.blockSection} aria-labelledby="compare-title">
          <h2 id="compare-title">엑셀·종이 명단과 무엇이 다른가요.</h2>
          <p className={styles.blockLead}>행사 당일에 벌어지는 네 가지 일을 기준으로 비교했습니다.</p>
          <div className={styles.compareTable} role="table" aria-label="기존 방식과 EVENTOUCH 비교">
            <div className={styles.compareHead} role="row">
              <span role="columnheader">종이·엑셀 명단</span>
              <span role="columnheader">EVENTOUCH</span>
            </div>
            <div className={styles.compareRow} role="row">
              <span role="cell" className={styles.compareOld}>흩어진 파일, 누가 왔는지 나중에 정리</span>
              <span role="cell">승인·입장 상태가 한 명단에 실시간 반영</span>
            </div>
            <div className={styles.compareRow} role="row">
              <span role="cell" className={styles.compareOld}>종이 명단을 눈으로 대조</span>
              <span role="cell">QR·검색 체크인, 중복 입장 방지</span>
            </div>
            <div className={styles.compareRow} role="row">
              <span role="cell" className={styles.compareOld}>문자 보내고 전달 확인 불가</span>
              <span role="cell">예약·발송 결과·미확인 복구까지 기록</span>
            </div>
            <div className={styles.compareRow} role="row">
              <span role="cell" className={styles.compareOld}>행사 후 수기 집계</span>
              <span role="cell">입장률·결과 보고서가 생성 시점에 고정</span>
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
              <ProductPreview variant="report" />
              <figcaption>결과 보고서 · 등록·입장 집계 · 데모 데이터</figcaption>
              <p className={styles.reportCropNote}>보고서는 생성 시점의 기록을 고정해 보관합니다.</p>
            </figure>
          </div>
        </section>

        <section className={styles.blockSection} aria-labelledby="steps-title">
          <h2 id="steps-title">도입은 세 단계로 끝납니다.</h2>
          <p className={styles.blockLead}>첫 행사까지 평균 일주일. 운영 대행사가 직접 세팅을 돕습니다.</p>
          <ol className={styles.stepsList}>
            <li>
              <span className={styles.stepIndex} aria-hidden="true">1</span>
              <h3>도입 문의</h3>
              <p>종류·일정·규모를 적어 보내면 맞는 운영 방식을 제안합니다.</p>
            </li>
            <li>
              <span className={styles.stepIndex} aria-hidden="true">2</span>
              <h3>행사 세팅</h3>
              <p>행사 생성·신청 항목·명단 준비를 함께 구성합니다.</p>
            </li>
            <li>
              <span className={styles.stepIndex} aria-hidden="true">3</span>
              <h3>운영·정리</h3>
              <p>현장 체크인부터 결과 보고서까지 한곳에서 운영합니다.</p>
            </li>
          </ol>
        </section>

        <section className={styles.faqSection} id="faq" aria-labelledby="faq-title">
          <h2 id="faq-title">도입 전에 확인해 주세요.</h2>
          <details className={styles.faqItem} id="faq-install">
            <summary>참가자는 앱을 설치해야 하나요?</summary>
            <p>아니요. 행사별 링크에서 신청하고 모바일 웹 티켓으로 입장 정보를 확인합니다.</p>
          </details>
          <details className={styles.faqItem} id="faq-sms">
            <summary>문자·알림톡을 실제로 발송할 수 있나요?</summary>
            <p>실제 발송은 발송 연결과 발신번호가 준비된 경우에만 시도합니다. 알림톡에는 승인된 템플릿이 필요합니다. 모의 발송이나 미연동 상태에서는 실제로 전달되지 않으며, 처리 결과는 운영 화면에서 확인할 수 있습니다.</p>
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

      <div className={styles.mobileCta}>
        <a href={INQUIRY_HREF}>이메일로 도입 문의</a>
      </div>
    </div>
  );
}
