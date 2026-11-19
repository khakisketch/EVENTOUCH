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
  return (
    <main id="main-content" tabIndex={-1} className={`site-page registration-page${state ? " registration-state" : ""} ${styles.page}`} style={attendeeGroundStyle(theme)}>
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
    </main>
  );
}

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
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
  if (!data.registrationOpen || data.stage === "ENDED") {
    const recoveryUnavailable = verificationMode === "mock" || verificationMode === "none";
    return (
      <Shell slug={slug} data={data} theme={theme} state>
        <p className={styles.stateNote}>현재 신청을 받지 않습니다.</p>
        <div className={styles.stateActions}>
          <TabTicketChoice
            slug={slug}
            whenPresent={(
              <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}/ticket`} prefetch={false}>
                내 티켓 열기
              </ProductLink>
            )}
          >
            {recoveryUnavailable ? (
              <p role="note">이 행사는 문자로 티켓을 다시 연결할 수 없습니다. 신청을 완료한 브라우저 탭을 확인하세요. {data.recoveryContact ? `문의: ${data.recoveryContact}` : "탭을 찾을 수 없다면 행사 초대 안내를 확인하거나 행사 주최 측에 문의하세요."}</p>
            ) : (
              <ProductLink className="button button-primary" href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>
                이미 신청했다면 내 티켓 찾기
              </ProductLink>
            )}
          </TabTicketChoice>
          <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>
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
      <TabTicketChoice
        slug={slug}
        whenPresent={(
          <p className={styles.ticketChoice}>
            <ProductLink variant="ghost" href={`/event/${encodeURIComponent(slug)}/ticket`} prefetch={false}>
              내 티켓 열기
            </ProductLink>
          </p>
        )}
      />
      <RegisterForm
        slug={slug}
        fields={data.fields}
        consentText={data.consentText}
        consentVersion={data.consentVersion}
        formVersion={data.publishedVersion}
        verificationRequired={data.verificationRequired}
        approvalRequired={data.approvalRequired}
        paymentPending={data.paymentPending}
        recoveryBlocked={verificationMode === "none" || verificationMode === "mock"}
        recoveryContact={data.recoveryContact}
      />
    </Shell>
  );
}
