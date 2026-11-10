import Link from "next/link";

export default function VerificationUnavailable({
  slug,
  mode,
  contact = "",
}: {
  slug: string;
  mode: "mock" | "none";
  contact?: string;
}) {
  return (
    <section className="verification-unavailable" role="status">
      <p className="eyebrow">{mode === "mock" ? "모의 발송" : "문자 발송 설정"}</p>
      <h2>연락처 인증을 진행할 수 없습니다</h2>
      <p>
        {mode === "mock"
          ? "현재 인증 문자는 모의 발송 상태라 실제 문자로 전송되지 않습니다."
          : "인증번호 발송이 아직 준비되지 않았습니다."}
      </p>
      <p>이 화면에서는 참가 정보를 입력하거나 티켓을 연결하지 않았습니다.</p>
      <p>
        이 화면에서는 티켓을 다시 연결할 수 없습니다. 이미 신청했다면 신청을 완료한 브라우저 탭을 확인하세요.
        {contact ? ` 문의: ${contact}` : " 탭을 찾을 수 없다면 행사 초대 안내를 확인하거나 행사 주최 측에 문의하세요."}
      </p>
      <Link className="button button-secondary" href={`/event/${encodeURIComponent(slug)}`}>
        행사 안내 보기
      </Link>
    </section>
  );
}
