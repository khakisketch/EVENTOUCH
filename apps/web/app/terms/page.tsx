import type { Metadata } from "next";
import Link from "next/link";
import DocumentPage, { Note, type DocumentSection } from "../ui/DocumentPage";
import { SUPPORT_EMAIL, supportMailto } from "../../lib/support-contact";

export const metadata: Metadata = {
  title: "이용약관 · EVENTOUCH",
  description: "EVENTOUCH 이용약관 초안입니다. 법무 검토 전이며 시행일은 정해지지 않았습니다.",
};

// A DRAFT, not a final legal text. It describes what the service does and who
// is responsible for what, using only behavior the product has (see
// docs/CONTRACT-SCOPE.md and docs/INTEGRATIONS.md). Anything that needs a legal
// decision (liability limits, governing law, effective date) says so instead
// of inventing wording.
const SECTIONS: readonly DocumentSection[] = [
  {
    id: "purpose",
    title: "목적과 용어",
    body: (
      <>
        <p>이 약관은 행사 운영 서비스 EVENTOUCH(이하 &ldquo;서비스&rdquo;)를 이용하는 조건과 서로의 책임을 정합니다.</p>
        <ul>
          <li><strong>조직</strong>: 서비스에서 행사를 만들고 운영하는 단체입니다. 행사의 주최 측이 되며, 이 문서에서는 &ldquo;주최 측&rdquo;이라고도 합니다.</li>
          <li><strong>운영자와 스태프</strong>: 조직이 초대해 서비스에 로그인하는 사람입니다.</li>
          <li><strong>참가자</strong>: 행사에 신청하거나 참여하는 사람입니다. 참가자는 계정을 만들지 않고 행사 주소로 신청합니다.</li>
        </ul>
      </>
    ),
  },
  {
    id: "service",
    title: "서비스가 하는 일",
    body: (
      <>
        <p>서비스는 조직이 다음을 할 수 있게 돕습니다.</p>
        <ul>
          <li>행사 만들기, 참가 신청 받기, 참가자 명단 관리</li>
          <li>티켓과 QR로 입장·퇴장 기록하기</li>
          <li>참가자 화면 꾸미기와 퀴즈, 투표, 추첨 같은 참여 콘텐츠 운영</li>
          <li>안내 문자와 알림톡 발송(발송 서비스가 연결된 경우)</li>
          <li>행사 결과 보고서, 현장 사진 정리</li>
        </ul>
        <p>서비스는 환불을 직접 해 주지 않습니다. 유료로 신청한 참가자가 취소하면 환불 요청으로 기록되며, 실제 환불은 서비스 밖에서 주최 측이 처리해야 합니다.</p>
      </>
    ),
  },
  {
    id: "accounts",
    title: "계정",
    body: (
      <>
        <ul>
          <li>운영자와 스태프 계정은 조직의 초대로 만들어집니다. 누구나 스스로 가입하는 방식이 아닙니다.</li>
          <li>계정 이용자는 비밀번호를 안전하게 관리해야 하고, 다른 사람에게 알려 주지 않아야 합니다. 행사장 공용 태블릿은 조직이 지정한 스태프 계정으로 씁니다.</li>
          <li>로그인에 여러 번 실패하면 계정과 접속 주소별로 잠시 로그인이 제한됩니다.</li>
          <li>조직의 소유자는 구성원의 권한을 정하고 계정 사용을 중지할 수 있습니다.</li>
        </ul>
      </>
    ),
  },
  {
    id: "organization",
    title: "조직의 책임",
    body: (
      <>
        <p>참가자의 개인정보는 행사의 주최 측이 수집하고 이용 목적을 정합니다. 그래서 조직은 다음을 지켜야 합니다.</p>
        <ul>
          <li>신청서의 정보 수집 동의 안내를 읽고 실제 이용 목적, 보유 기간, 문의처와 맞는지 확인합니다. 서비스가 제공하는 기본 동의 안내는 예시이며, 행사에 맞는지는 주최 측이 판단합니다.</li>
          <li>참가자가 연락할 수 있는 참가자 문의처를 적어 둡니다.</li>
          <li>참가자가 열람, 정정, 삭제를 요청하면 주최 측이 처리합니다.</li>
          <li>문자 발송 대상과 내용이 관련 법령과 참가자의 동의 범위에 맞는지 확인한 뒤 보냅니다.</li>
          <li>개인정보 보호법 등 관련 법령을 지킵니다.</li>
        </ul>
      </>
    ),
  },
  {
    id: "role",
    title: "EVENTOUCH의 역할",
    body: (
      <>
        <p>EVENTOUCH는 조직이 서비스에 입력한 정보와 참가자가 신청서에 적은 정보를 조직의 위탁을 받아 저장하고 처리하는 수탁자입니다.</p>
        <p>어떤 정보를 어떻게 처리하는지는 <Link href="/privacy">개인정보처리방침</Link>에 적었습니다.</p>
        <Note>
          <p>위탁 계약의 세부(처리 범위, 재위탁, 계약이 끝났을 때의 반환과 파기)는 법무 검토에서 정합니다. 이 초안에는 아직 적지 않았습니다.</p>
        </Note>
      </>
    ),
  },
  {
    id: "messages",
    title: "문자와 알림톡",
    body: (
      <>
        <ul>
          <li>실제 발송은 조직이 발송 서비스(Solapi)의 계정과 발신번호를 연결해야 가능합니다. 연결되지 않은 상태에서는 실제 문자가 가지 않고 모의 발송 기록만 남습니다.</li>
          <li>발송 요청이 공급사에 접수된 것과 받는 사람에게 도착한 것은 다릅니다. 서비스는 도착 여부를 보장하지 않으며, 확인된 상태만 구분해 보여 줍니다.</li>
          <li>문자 요금은 행사 대행사가 부담합니다. 서비스에는 결제 기능이 없습니다.</li>
        </ul>
      </>
    ),
  },
  {
    id: "conduct",
    title: "하지 말아야 할 일",
    body: (
      <ul>
        <li>다른 사람의 계정이나 티켓을 허락 없이 쓰는 일</li>
        <li>서비스를 비정상적으로 반복 호출하거나 제한을 우회하는 일</li>
        <li>동의받지 않은 사람의 정보를 입력하거나, 받은 정보를 행사 운영 외의 목적으로 쓰는 일</li>
        <li>서비스의 보안을 시험하거나 침해하는 일</li>
      </ul>
    ),
  },
  {
    id: "changes",
    title: "서비스 변경과 약관 변경",
    body: (
      <>
        <p>서비스의 기능은 바뀔 수 있습니다. 약관을 바꾸면 이 페이지에 게시합니다.</p>
        <Note>
          <p>변경을 알리는 시점과 방법, 시행일은 아직 정해지지 않았습니다.</p>
        </Note>
      </>
    ),
  },
  {
    id: "legal",
    title: "책임의 범위와 분쟁",
    body: (
      <Note>
        <p>손해배상 책임의 범위, 서비스 중단 시의 처리, 준거법과 관할 법원은 법무 검토를 거쳐 정합니다. 이 초안에는 아직 적지 않았습니다.</p>
      </Note>
    ),
  },
  {
    id: "contact",
    title: "문의",
    body: (
      <p>약관에 대한 문의는 <a href={supportMailto("EVENTOUCH 이용약관 문의")}>{SUPPORT_EMAIL}</a>로 보내 주세요. 행사 참가와 관련한 문의는 각 행사의 참가자 문의처로 하세요.</p>
    ),
  },
];

export default function TermsPage() {
  return (
    <DocumentPage
      current="terms"
      title="이용약관"
      draft
      lead={<p>서비스를 쓰는 조직, 운영자, 참가자 사이의 기본 약속입니다. 법무 검토가 끝나기 전의 초안이라 이후 바뀔 수 있습니다.</p>}
      sections={SECTIONS}
    />
  );
}
