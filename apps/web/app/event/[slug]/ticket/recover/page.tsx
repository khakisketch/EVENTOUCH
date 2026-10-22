import RecoverForm from "./RecoverForm";
import VerificationUnavailable from "../../VerificationUnavailable";
import { loadVerificationMode } from "../../../../../lib/verification-mode";

// Verified recovery entry: a code sent to the registered number reconnects
// this browser to the participant's ticket. No account, no password; the
// session the server sets authorizes reads only.
export default async function TicketRecoverPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const [{ slug }, verificationMode] = await Promise.all([params, loadVerificationMode()]);
  return (
    <main id="main-content" tabIndex={-1} className="site-page registration-page">
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <p className="eyebrow">내 티켓 찾기</p>
      </header>
      <h1 className="registration-title">참가 정보 다시 연결</h1>
      <p>신청할 때 입력한 연락처를 확인하면 티켓을 다시 연결할 수 있습니다.</p>
      {verificationMode === "mock" || verificationMode === "none" ? (
        <VerificationUnavailable slug={slug} mode={verificationMode} />
      ) : (
        <RecoverForm slug={slug} />
      )}
      <footer className="public-page-footer">EVENTOUCH <span>내 티켓 찾기</span></footer>
    </main>
  );
}
