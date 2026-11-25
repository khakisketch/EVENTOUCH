import type { ReactNode } from "react";
import RegisterForm from "./RegisterForm";
import styles from "./register.module.css";
import ProductLink from "../../../ui/ProductLink";
import VerificationUnavailable from "../VerificationUnavailable";
import { loadVerificationMode } from "../../../../lib/verification-mode";
import type { VerificationMode } from "../../../../lib/verification-mode";
import { parseRegisterData } from "./register-data";
import type { RegisterData } from "./register-data";
import EventBanner from "../EventBanner";
import EventFacts from "../EventFacts";
import { attendeeGroundStyle } from "../event-theme";
import type { AttendeeTheme } from "../event-theme";
import TabTicketChoice from "../TabTicketChoice";
import AttendeeSurface from "../ui/AttendeeSurface";
import AttendeeStateMessage from "../ui/AttendeeStateMessage";
import { attendeeLook } from "../../../../lib/attendee-look";
import { organizerContactLine } from "../attendee-guidance";
import { mayHaveTicket, signupAvailability } from "../signup-availability";
export type { PublishedField } from "./register-data";

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

async function loadRegisterData(slug: string): Promise<RegisterData | null> {
  const res = await fetch(`${apiBase()}/api/public/events/${encodeURIComponent(slug)}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`행사 정보를 불러오지 못했습니다 (${res.status})`);
  const result = parseRegisterData(await res.json());
  if (!result) throw new Error("행사 정보를 확인하지 못했습니다");
  return result;
}

// The application is a sheet on the event's own ground: the published banner
// carries the event name, then when and where, then the form.
function Shell({
  slug,
  data,
  theme,
  state = false,
  children,
}: {
  slug: string;
  data: RegisterData;
  theme: AttendeeTheme;
  state?: boolean;
  children: ReactNode;
}) {
  const look = attendeeLook(theme.homeStyle, theme.accent);
  return (
    <AttendeeSurface as="main" id="main-content" tabIndex={-1} color={look.color} mode={look.mode} ground={look.ground} className={`site-page registration-page${state ? " registration-state" : ""} ${styles.page}`} style={attendeeGroundStyle(theme)}>
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <p className={styles.pageContext}>참가 신청</p>
      </header>
      {!state ? <p className={styles.backLink}><ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>← 행사 안내로</ProductLink></p> : null}
      <section className={styles.sheet}>
        <EventBanner theme={theme} title={data.name} titleAs="h1" kicker={<span>참가 신청</span>} className={styles.sheetBanner} />
        <div className={`${styles.sheetBody}${state ? ` ${styles.sheetBodyEnd}` : ""}`}>
          <EventFacts slug={slug} context={data.eventContext} />
          {children}
        </div>
      </section>
    </AttendeeSurface>
  );
}

export default async function RegisterPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams?: Promise<{ desk?: string | string[] }>;
}) {
  const { slug } = await params;
  // "?desk=" comes from a desk poster: the signup then arrives at that desk.
  const desk = (await searchParams)?.desk;
  const deskId = typeof desk === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(desk) ? desk : undefined;
  let data: RegisterData | null = null;
  let verificationMode: VerificationMode = "unknown";
  try {
    [data, verificationMode] = await Promise.all([
      loadRegisterData(slug),
      loadVerificationMode(),
    ]);
  } catch {
    throw new Error("행사 정보를 불러오지 못했습니다");
  }
  if (!data) {
    return (
      <main id="main-content" tabIndex={-1} className={`site-page registration-page registration-state ${styles.page}`}>
        <h1>신청할 수 없는 행사입니다</h1>
        <p>행사 주소를 확인하세요.</p>
      </main>
    );
  }
  const theme = data.theme;
  // One reason per line: not open, closed, full and ended each say so, with
  // their own next step. A full event that takes approvals still takes a
  // waiting-list application, so its form opens with that said first.
  const availability = signupAvailability({
    stage: data.stage,
    registrationOpen: data.registrationOpen,
    full: data.full,
    approvalRequired: data.approvalRequired,
  });
  if (availability.kind !== "open") {
    const recoveryUnavailable = verificationMode === "mock" || verificationMode === "none";
    // Someone with a ticket may land here; someone before the intake opens cannot have one.
    const askAboutTicket = mayHaveTicket(availability.kind);
    const recoverLink = askAboutTicket && !recoveryUnavailable;
    const ticketHref = `/event/${encodeURIComponent(slug)}/ticket`;
    return (
      <Shell slug={slug} data={data} theme={theme} state>
        <AttendeeStateMessage kind="info" title={availability.title}>{availability.next}</AttendeeStateMessage>
        <div className={styles.stateActions}>
          <TabTicketChoice
            slug={slug}
            whenPresent={(
              <ProductLink className={askAboutTicket ? "button button-primary" : "button button-secondary"} href={ticketHref} prefetch={false}>
                내 티켓 열기
              </ProductLink>
            )}
          >
            {recoverLink ? (
              <ProductLink className="button button-primary" href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>
                이미 신청했다면 내 티켓 찾기
              </ProductLink>
            ) : askAboutTicket ? (
              <>
                <p role="note">이 행사는 문자로 티켓을 다시 연결할 수 없습니다. 신청한 기기의 같은 브라우저에서 열어 보세요. {organizerContactLine(data.recoveryContact)}</p>
                <ProductLink className="button button-primary" href={ticketHref} prefetch={false}>
                  이 브라우저에서 내 티켓 열기
                </ProductLink>
              </>
            ) : null}
          </TabTicketChoice>
          <ProductLink className={askAboutTicket ? "button button-secondary" : "button button-primary"} href={`/event/${encodeURIComponent(slug)}`}>
            행사 안내로
          </ProductLink>
        </div>
      </Shell>
    );
  }
  if (data.verificationRequired && (verificationMode === "mock" || verificationMode === "none")) {
    return (
      <Shell slug={slug} data={data} theme={theme} state>
        <TabTicketChoice
          slug={slug}
          whenPresent={(
            <div className={styles.stateActions}>
              <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/ticket`} prefetch={false}>
                내 티켓 열기
              </ProductLink>
            </div>
          )}
        >
          <VerificationUnavailable slug={slug} mode={verificationMode} contact={data.recoveryContact} />
        </TabTicketChoice>
      </Shell>
    );
  }
  return (
    <Shell slug={slug} data={data} theme={theme}>
      {availability.waitlist ? <AttendeeStateMessage kind="info" title={availability.title} className={styles.waitlistNotice}>{availability.next}</AttendeeStateMessage> : null}
      <TabTicketChoice
        slug={slug}
        whenPresent={(
          <p className={styles.ticketChoice}>
            <span>이미 신청하셨어요</span>
            <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/ticket`} prefetch={false}>
              내 티켓 열기
            </ProductLink>
          </p>
        )}
      />
      <RegisterForm
        slug={slug}
        deskId={deskId}
        fields={data.fields}
        consentText={data.consentText}
        consentVersion={data.consentVersion}
        formVersion={data.publishedVersion}
        verificationRequired={data.verificationRequired}
        approvalRequired={data.approvalRequired}
        paymentPending={data.paymentPending}
        waitlist={availability.waitlist}
        recoveryBlocked={verificationMode === "none" || verificationMode === "mock"}
        recoveryContact={data.recoveryContact}
      />
    </Shell>
  );
}
