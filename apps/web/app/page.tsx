"use client";

import { useEffect, useState, type CSSProperties } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import styles from "./landing.module.css";
import ProductPreview from "./ProductPreview";
import sec from "./landing-sections.module.css";
import LandingFlow, { type FlowScene } from "./LandingFlow";
import LandingPageDemo from "./LandingPageDemo";
import LandingCompare from "./LandingCompare";
import { LandingIcon } from "./LandingIcons";
import { CountUp, Reveal } from "./LandingMotion";
import { SUPPORT_EMAIL as CONTACT_EMAIL } from "../lib/support-contact";

// Service entry: signed-in operators return to their work surface, everyone
// else sees the public landing. Attendees enter through their event link.
// Inquiries stay email-only; there is no server-backed proposal form.
const INQUIRY_SUBJECT = "EVENTOUCH 도입 문의";
const INQUIRY_BODY =
  "행사 종류:\n일정:\n예상 규모(인원):\n연락처(성함/전화):\n궁금한 점:\n";

const INQUIRY_HREF =
  `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(INQUIRY_SUBJECT)}&body=${encodeURIComponent(INQUIRY_BODY)}`;

const FLOW_SCENES: readonly FlowScene[] = [
  {
    id: "before",
    phase: "행사 전",
    title: "모집 · 승인 · 안내",
    body: "신청 명단과 참가 상태를 살피고, 안내할 대상을 정합니다. 참가자 페이지와 참여 이벤트도 이때 준비합니다.",
    screens: "쓰는 화면 · 참가자 명단, 메시지, 참가자 페이지",
    stage: (
      <div className={sec.stageDuo}>
        <div className={sec.window}>
          <div className={sec.windowBar} aria-hidden="true"><i /><i /><i /><span>운영 현황</span></div>
          <ProductPreview variant="console" />
        </div>
        <div className={sec.phoneCrop}><ProductPreview variant="home" /></div>
      </div>
    ),
  },
  {
    id: "onsite",
    phase: "행사 현장",
    title: "체크인 · 참여",
    body: "배정된 스태프가 QR 또는 참가자 검색으로 입장을 처리하고, 운영자는 현장 모드에서 입장 상황을 한 화면으로 봅니다.",
    screens: "쓰는 화면 · 입장·스태프, 현장 모드",
    stage: (
      <div className={sec.stagePair}>
        <div className={sec.phoneCrop}><ProductPreview variant="ticket" /></div>
        <div className={sec.phoneCrop}><ProductPreview variant="staff" /></div>
      </div>
    ),
  },
  {
    id: "after",
    phase: "행사 후",
    title: "결과 · 보고서",
    body: "참가·입장·현장 기록을 모아 결과를 확인하고 보고서로 남깁니다.",
    screens: "쓰는 화면 · 결과 보고서",
    stage: (
      <div className={sec.stageSolo}>
        <div className={sec.window}>
          <div className={sec.windowBar} aria-hidden="true"><i /><i /><i /><span>결과 보고서</span></div>
          <ProductPreview variant="report" />
        </div>
      </div>
    ),
  },
];

const AUDIENCE = [
  { icon: "seminar", title: "컨퍼런스·세미나", text: "사전 등록부터 현장 입장까지 한 흐름으로 운영합니다." },
  { icon: "door", title: "입장 통제·사전 승인 행사", text: "QR·명단 검색으로 입장을 기록하고, 이미 입장한 티켓은 현장에서 바로 알려 줍니다." },
  { icon: "repeat", title: "반복 교육·설명회", text: "같은 틀을 복사해 매번 운영하고, 결과는 행사마다 따로 보관합니다." },
] as const;

const STEPS = [
  { icon: "mail", title: "도입 문의", text: "종류·일정·규모를 적어 보내면 맞는 운영 방식을 제안합니다." },
  { icon: "setup", title: "행사 세팅", text: "행사 생성·신청 항목·명단 준비를 함께 구성합니다." },
  { icon: "chart", title: "운영·정리", text: "현장 체크인부터 결과 보고서까지 한곳에서 운영합니다." },
] as const;

const ENTRY_BARS = [18, 46, 82, 64, 38, 52, 30] as const;

export default function Home() {
  const router = useRouter();
  const [copyStatus, setCopyStatus] = useState<{ message: string; tone: "success" | "error" } | null>(null);
  // The address is filled in after mount so the edge email filter never sees
  // a bare address in server HTML (it rewrites visible addresses and breaks
  // hydration). Copying uses the same constant from JS, which it ignores.
  const [emailShown, setEmailShown] = useState(false);
  useEffect(() => { setEmailShown(true); }, []);

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
        <Link className={styles.loginLink} href="/login">로그인</Link>
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
              QR 입장, 실시간 현황, 결과 보고서까지.
            </p>
            <div className={styles.heroActions}>
              <a className={styles.primaryAction} href={INQUIRY_HREF}>
                이메일로 도입 문의
                <svg aria-hidden="true" viewBox="0 0 20 20" fill="none">
                  <path d="M4 10h11M10 4l6 6-6 6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </a>
              <a className={styles.secondaryAction} href="#journey">한 행사의 흐름 보기 ↓</a>
            </div>
          </div>

          {/* One still scene instead of three rotating tabs: the operator's live count with the
              attendee's ticket laid over it. Nothing moves on its own. */}
          <div className={styles.heroMedia}>
            <div className={styles.heroScene}>
              <section className={styles.consoleEvidence} aria-label="운영자 화면 구성 예시">
                <div className={styles.windowBar} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <span>운영 현황</span>
                </div>
                <ProductPreview variant="live" />
              </section>
              <div className={styles.heroPhone}><ProductPreview variant="ticket" /></div>
            </div>
            <p className={styles.heroSample}>화면 구성 예시 · 합성 데이터</p>
          </div>

          <ul className={styles.factStrip} aria-label="도입 전 확인">
            <li className={styles.factLabel}>도입 전 확인</li>
            <li><a href="#faq-install">참가자 앱 설치 없이 링크로 신청·티켓</a></li>
            <li><a href="#faq-sms">문자·알림톡은 발송 연결 후 실제 발송</a></li>
            <li><a href="#faq-portal">고객사 포털은 제공하지 않음</a></li>
          </ul>
        </section>

        <section className={sec.section} id="journey" aria-labelledby="flow-title">
          <Reveal className={sec.heading}>
            <p className={sec.eyebrow}>운영 흐름</p>
            <h2 id="flow-title">한 행사의 세 시점이 이어집니다.</h2>
            <p>행사 전 준비, 현장 진행, 행사 후 정리. 필요한 화면과 역할은 달라도 업무의 맥락은 이어집니다. 운영자는 콘솔에서, 스태프는 모바일 웹 현장 화면에서, 참가자는 행사 링크에서 일합니다.</p>
          </Reveal>
          <Reveal delay={120}>
            <LandingFlow scenes={FLOW_SCENES} />
          </Reveal>
        </section>

        <section className={`${sec.section} ${sec.bandTint}`} id="attendee-page" aria-labelledby="demo-title">
          <Reveal className={sec.heading}>
            <p className={sec.eyebrow}>참가자 페이지</p>
            <h2 id="demo-title">행사마다 다른 얼굴, 링크는 하나.</h2>
            <p>참가자는 행사 링크에서 앱 설치 없이 신청하고 티켓과 참여 화면까지 이어갑니다. 구성과 색은 관리자에서 행사마다 고릅니다. 직접 눌러 바꿔 보세요.</p>
          </Reveal>
          <Reveal delay={120}>
            <LandingPageDemo />
          </Reveal>
        </section>

        <section className={sec.section} aria-labelledby="compare-title">
          <Reveal className={sec.heading}>
            <p className={sec.eyebrow}>기존 방식과 비교</p>
            <h2 id="compare-title">엑셀·종이 명단과 무엇이 다른가요.</h2>
            <p>행사 당일에 벌어지는 네 가지 일을 기준으로 비교했습니다. 위의 전환을 눌러 보세요.</p>
          </Reveal>
          <Reveal delay={120}>
            <LandingCompare />
          </Reveal>
        </section>

        <section className={sec.section} aria-labelledby="audience-title">
          <Reveal className={sec.heading}>
            <p className={sec.eyebrow}>이런 행사에</p>
            <h2 id="audience-title">신청·입장·안내가 엇갈리기 시작하는 규모부터.</h2>
          </Reveal>
          <ul className={sec.audience}>
            {AUDIENCE.map((item, i) => (
              <li key={item.title}>
                <Reveal className={sec.audienceCard} delay={i * 90}>
                  <span className={sec.audienceIcon}><LandingIcon name={item.icon} size={22} /></span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </Reveal>
              </li>
            ))}
            <li>
              <Reveal className={`${sec.audienceCard} ${sec.audienceOff}`} delay={270}>
                <h3>맞지 않는 경우</h3>
                <p>열 명 남짓한 내부 모임은 엑셀로 충분합니다. 그런 행사에는 권하지 않습니다.</p>
              </Reveal>
            </li>
          </ul>
        </section>

        <section className={`${sec.section} ${sec.bandMuted}`} id="report" aria-labelledby="report-title">
          <div className={sec.report}>
            <Reveal className={sec.reportCopy}>
              <p className={sec.eyebrow}>결과 보고</p>
              <h2 id="report-title">행사가 끝나면, 기록을 결과로.</h2>
              <p>등록·입장·부스·참여 기록을 한곳에서 확인하고 보고서로 남깁니다.</p>
              <ul className={sec.checks}>
                <li><LandingIcon name="check" size={18} />등록·입장 집계가 행사 중에도 계속 쌓입니다.</li>
                <li><LandingIcon name="check" size={18} />보고서는 생성 시점의 기록을 고정해 보관합니다.</li>
                <li><LandingIcon name="check" size={18} />결과 보고서에서 바로 확인하고, PPTX 파일이나 인쇄·PDF로 내보냅니다.</li>
              </ul>
            </Reveal>
            <Reveal className={sec.reportCard} delay={140}>
              <p className={sec.reportKicker}>결과 분석 · 입장 집계</p>
              <div className={sec.reportNumbers}>
                <div><span>등록</span><strong><CountUp to={269} suffix="명" /></strong></div>
                <div><span>누적 입장</span><strong><CountUp to={221} suffix="명" /></strong></div>
                <div><span>입장률</span><strong><CountUp to={82} suffix="%" /></strong></div>
              </div>
              <div className={sec.reportRate} aria-hidden="true"><i /></div>
              <div className={sec.bars} aria-hidden="true">
                {ENTRY_BARS.map((height, i) => <i key={i} style={{ "--bar": `${height}%`, "--i": i } as CSSProperties} />)}
              </div>
              <p className={sec.reportAxis} aria-hidden="true"><span>09시</span><span>시간대별 입장</span><span>15시</span></p>
              <p className={sec.reportNote}>화면 구성 예시 · 합성 데이터</p>
            </Reveal>
          </div>
        </section>

        <section className={sec.section} aria-labelledby="steps-title">
          <Reveal className={sec.heading}>
            <p className={sec.eyebrow}>도입 절차</p>
            <h2 id="steps-title">도입은 세 단계로 진행합니다.</h2>
            <p>행사 종류와 일정을 먼저 듣고, 행사 세팅은 함께 구성합니다.</p>
          </Reveal>
          <ol className={sec.steps}>
            {STEPS.map((item, i) => (
              <li key={item.title}>
                <Reveal className={sec.stepCard} delay={i * 110}>
                  <span className={sec.stepNode}><LandingIcon name={item.icon} size={22} /><b>{i + 1}</b></span>
                  <h3>{item.title}</h3>
                  <p>{item.text}</p>
                </Reveal>
              </li>
            ))}
          </ol>
        </section>

        <section className={`${sec.section} ${sec.faq}`} id="faq" aria-labelledby="faq-title">
          <Reveal className={sec.faqIntro}>
            <p className={sec.eyebrow}>확인 사항</p>
            <h2 id="faq-title">도입 전에 확인해 주세요.</h2>
            <p>가장 많이 묻는 세 가지를 먼저 답해 둡니다.</p>
          </Reveal>
          <Reveal className={sec.faqList} delay={100}>
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
              <p>고객사 포털은 제공하지 않습니다. 고객사 정보는 행사를 운영하는 조직이 내부 기록으로 관리합니다.</p>
            </details>
          </Reveal>
        </section>

        <section className={`${styles.contactSection} ${sec.contact}`} id="contact" aria-labelledby="contact-title">
          <Reveal className={sec.contactCopy}>
            <h2 id="contact-title">다음 행사의 운영 흐름을 함께 살펴보세요.</h2>
            <p>행사 종류와 일정, 예상 규모를 알려주시면 도입 상담으로 이어집니다.</p>
            <div className={styles.contactDetails}>
              <span>{emailShown ? CONTACT_EMAIL : ""}</span>
              <button type="button" onClick={() => void copyContactEmail()}>
                이메일 주소 복사
              </button>
              <p className={styles.copyStatus} data-tone={copyStatus?.tone} role="status" aria-live="polite">
                {copyStatus?.message}
              </p>
            </div>
          </Reveal>
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
        <nav className={styles.footerLinks} aria-label="서비스 안내">
          <Link href="/login">로그인</Link>
          <Link href="/help">도움말·문의</Link>
          <Link href="/terms">이용약관</Link>
          <Link href="/privacy">개인정보처리방침</Link>
        </nav>
      </footer>

      <nav className={styles.mobileCta} aria-label="모바일 도입 문의">
        <a href={INQUIRY_HREF}>이메일로 도입 문의</a>
      </nav>
    </div>
  );
}
