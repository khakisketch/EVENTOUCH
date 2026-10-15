import RecoverForm from "./RecoverForm";

// Verified recovery entry: a code sent to the registered number reconnects
// this browser to the participant's ticket. No account, no password; the
// session the server sets authorizes reads only.
export default async function TicketRecoverPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <main id="main-content" className="site-page registration-page">
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <p className="eyebrow">내 티켓 찾기</p>
      </header>
      <h1 className="registration-title">참가 정보 다시 연결</h1>
      <p>신청할 때 입력한 연락처로 인증번호를 보내드립니다.</p>
      <RecoverForm slug={slug} />
      <footer className="public-page-footer">EVENTOUCH <span>내 티켓 찾기</span></footer>
    </main>
  );
}
