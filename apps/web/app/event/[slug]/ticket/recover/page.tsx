import RecoverForm from "./RecoverForm";
import VerificationUnavailable from "../../VerificationUnavailable";
import AttendeeIcon from "../../AttendeeIcons";
import { attendeeGroundStyle, loadAttendeeTheme } from "../../event-theme";
import { loadVerificationMode } from "../../../../../lib/verification-mode";
import { loadPublicRecoveryContact } from "../../../../../lib/public-recovery-contact";
import AttendeeSurface from "../../ui/AttendeeSurface";
import { attendeeLook } from "../../../../../lib/attendee-look";
import styles from "../ticket.module.css";

// Verified recovery entry: a code sent to the registered number reconnects
// this browser to the participant's ticket. No account, no password; the
// session the server sets authorizes reads only.
export default async function TicketRecoverPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, verificationMode] = await Promise.all([params, loadVerificationMode()]);
  const [theme, contact] = await Promise.all([
    loadAttendeeTheme(slug),
    verificationMode === "mock" || verificationMode === "none" ? loadPublicRecoveryContact(slug) : Promise.resolve(""),
  ]);
  const look = attendeeLook(theme.homeStyle, theme.accent);
  return (
    <AttendeeSurface as="main" id="main-content" tabIndex={-1} color={look.color} mode={look.mode} ground={look.ground} className={`site-page registration-page ${styles.ticketPage}`} style={attendeeGroundStyle(theme)}>
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <p className="eyebrow">내 티켓 찾기</p>
      </header>
      <section className={styles.sheet}>
        <span className={styles.messageIcon} data-tone="info"><AttendeeIcon name="ticket" size={26} /></span>
        <h1 className="registration-title">참가 정보 다시 연결</h1>
        <p className={styles.sheetLead}>신청할 때 입력한 연락처를 확인하면 티켓을 다시 연결할 수 있습니다.</p>
        {verificationMode === "mock" || verificationMode === "none" ? (
          <VerificationUnavailable slug={slug} mode={verificationMode} contact={contact} />
        ) : (
          <RecoverForm slug={slug} />
        )}
      </section>
    </AttendeeSurface>
  );
}
