import type { Metadata } from "next";
import DocumentPage, { Faq, Note, type DocumentSection } from "../ui/DocumentPage";
import { SUPPORT_EMAIL, supportMailto } from "../../lib/support-contact";

export const metadata: Metadata = {
  title: "도움말·문의 · EVENTOUCH",
  description: "행사 운영자와 스태프를 위한 준비 순서, 당일 입장, 메시지, 마감 안내와 자주 묻는 질문입니다.",
};

// Operator and staff help. Plain steps with the real menu names; nothing here
// is a promise the screens do not keep. Attendees are pointed to their event's
// own contact, not to this page.
const SECTIONS: readonly DocumentSection[] = [
  {
    id: "prepare",
    title: "행사 준비 순서",
    body: (
      <>
        <p>왼쪽 메뉴의 &ldquo;행사 준비&rdquo; 묶음 순서대로 하면 됩니다. 운영 현황의 준비 점검 카드가 아직 남은 항목을 알려 줍니다.</p>
        <ol>
          <li><strong>행사 만들기.</strong> 행사 목록에서 새 행사를 만듭니다. 이름과 날짜를 정하면 시작할 수 있습니다.</li>
          <li><strong>행사 설정.</strong> 참가 접수, 신청서에 받을 항목, 정보 수집 동의 안내를 정합니다. 참가자가 티켓을 잃었을 때 연락할 곳도 여기서 적어 둡니다.</li>
          <li><strong>참가자 화면.</strong> 참가자가 보는 홈의 모양, 공지·안내, 참여 이벤트(퀴즈, 투표, 추첨 등)를 준비합니다.</li>
          <li><strong>입장·스태프.</strong> 입장 데스크와 현장 스태프를 정합니다. 스태프 계정은 &ldquo;팀·권한&rdquo;에서 초대합니다.</li>
          <li><strong>참가자 명단.</strong> 신청을 받거나, &ldquo;명단 가져오기&rdquo;로 파일의 명단을 한 번에 등록합니다. 승인이 필요한 행사는 여기서 승인합니다.</li>
          <li><strong>메시지.</strong> 신청 확정 안내와 행사 전 안내를 미리 만들어 두고 보냅니다.</li>
        </ol>
      </>
    ),
  },
  {
    id: "onsite",
    title: "당일 입장",
    body: (
      <>
        <p>운영자는 왼쪽 메뉴의 &ldquo;현장 모드&rdquo;에서 입장 상황을 봅니다. 스태프는 스태프 로그인으로 들어가 행사를 고릅니다.</p>
        <ul>
          <li>참가자가 보여 주는 QR을 카메라로 스캔하면 입장이 기록됩니다. 연속으로 스캔할 수 있고, 처리 결과가 화면에 바로 표시됩니다.</li>
          <li>스캔이 안 되면 &ldquo;코드 입력&rdquo;으로 티켓 코드를 입력하거나 &ldquo;명단에서 찾기&rdquo;로 이름을 검색해 처리합니다.</li>
          <li>이미 입장한 참가자를 다시 스캔하면 &ldquo;이미 입장했습니다&rdquo;로 알려 줍니다. 입장 기록이 겹치지 않습니다.</li>
          <li>취소된 신청의 티켓은 입장 처리가 되지 않습니다.</li>
        </ul>
      </>
    ),
  },
  {
    id: "messages",
    title: "메시지 보내기",
    body: (
      <>
        <p>&ldquo;메시지&rdquo;에서 받는 사람과 내용을 정하고, 지금 보내거나 시각을 정해 예약합니다. 보내기 전에 받는 사람 수와 내용을 한 번 더 보여 줍니다.</p>
        <ul>
          <li>화면의 &ldquo;발송 연결&rdquo; 상태가 &ldquo;미연동&rdquo;이면 실제 문자는 가지 않고 기록만 남습니다. 이 기록에는 &ldquo;모의 발송 · 전달 없음&rdquo;이라고 표시됩니다.</li>
          <li>발송을 요청한 것과 받는 사람에게 도착한 것은 다릅니다. 결과 화면은 &ldquo;공급사 접수 · 전달 미확인&rdquo;, &ldquo;전달 확인&rdquo;, &ldquo;발송 실패&rdquo;, &ldquo;상태 확인 필요&rdquo;를 나누어 보여 줍니다.</li>
          <li>예약한 뒤 행사 날짜를 바꾸면, 아직 보내지 않은 행사 기준 예약은 새 날짜에 맞춰 다시 계산됩니다. 새 시각이 이미 지났다면 보내지 않고 취소합니다.</li>
          <li>문자 요금은 행사 대행사가 부담하며, 이 서비스에는 결제 기능이 없습니다.</li>
        </ul>
      </>
    ),
  },
  {
    id: "close",
    title: "마감과 보고서",
    body: (
      <>
        <p>행사가 끝나면 &ldquo;결과&rdquo; 묶음에서 마무리합니다.</p>
        <ul>
          <li><strong>결과 보고서.</strong> 입장률과 참여 결과를 모은 보고서를 만들고, 내용을 고친 뒤 공유 완료로 표시합니다. 인쇄하거나 PDF로 저장하고, 발표용 PPTX로 내보낼 수 있습니다.</li>
          <li><strong>경품 지급.</strong> 당첨된 경품의 지급 상태를 확인하고 처리합니다.</li>
          <li><strong>현장 사진.</strong> 행사 증빙 사진을 구간별로 모아 두고 ZIP으로 받을 수 있습니다.</li>
          <li><strong>기간 분석.</strong> 기간을 골라 신청과 입장 흐름을 봅니다.</li>
        </ul>
        <Note>
          <p>참가자 개인정보를 얼마나 보관하고 언제 지울지는 행사의 동의 안내에 적힌 대로 주최 측이 정합니다. 시스템이 기한이 지났다고 자동으로 지우지는 않습니다. 자세한 내용은 개인정보처리방침을 확인하세요.</p>
        </Note>
      </>
    ),
  },
  {
    id: "faq",
    title: "자주 묻는 질문",
    body: (
      <>
        <Faq question="참가자가 티켓을 잃어버렸어요">
          <p>신청한 기기의 같은 브라우저에서는 신청 화면의 &ldquo;내 티켓 열기&rdquo;로 다시 열 수 있습니다. 다른 기기나 시크릿 창에서는 열리지 않습니다.</p>
          <p>문자를 보낼 수 있는 행사라면 &ldquo;내 티켓 찾기&rdquo;에서 신청한 연락처로 인증해 다시 연결할 수 있습니다. 문자를 보낼 수 없는 행사는 이 방법이 막혀 있고, 참가자는 행사 주최 측에 문의하게 됩니다. 그래서 행사 설정에 참가자 문의처를 꼭 적어 두세요.</p>
          <p>운영자는 참가자 명단의 참가자 상세에서 &ldquo;티켓 재발급&rdquo;으로 새 티켓을 발급해 전달할 수 있습니다. 재발급하면 이전 티켓은 쓸 수 없습니다. 당일에는 스태프가 &ldquo;명단에서 찾기&rdquo;로 이름을 검색해 입장 처리할 수도 있습니다.</p>
        </Faq>
        <Faq question="문자가 안 가요">
          <p>메시지 화면의 &ldquo;발송 연결&rdquo;이 &ldquo;미연동&rdquo;이면 실제 문자는 가지 않습니다. 모의 발송 기록만 남습니다. 발송 연결은 서비스 설정으로 켭니다.</p>
          <p>연결되어 있는데 도착하지 않았다면 결과 화면에서 상태를 확인하세요. &ldquo;공급사 접수&rdquo;는 발송 서비스가 받았다는 뜻이고 받는 사람에게 도착했다는 뜻은 아닙니다. 상태가 &ldquo;상태 확인 필요&rdquo;이면 다시 보내기 전에 먼저 상태를 확인하세요. 같은 문자가 두 번 갈 수 있습니다.</p>
          <p>참가자의 인증번호 문자도 같은 발송 연결을 씁니다. 연결이 없으면 참가자 화면이 인증을 쓸 수 없다고 안내합니다.</p>
        </Faq>
        <Faq question="사진이 안 올라가요">
          <p>PNG, JPG, WebP 파일만 올릴 수 있습니다. 운영자가 올리는 현장 사진은 장당 8MB 이하여야 합니다.</p>
          <p>참가자가 올리는 사진은 큰 파일이면 자동으로 줄여서 올립니다. 줄여도 한도를 넘으면 올라가지 않고 이유가 화면에 나옵니다. 참가자 사진은 운영자가 승인한 뒤에 공개됩니다.</p>
        </Faq>
        <Faq question="스캔이 안 돼요">
          <p>브라우저가 카메라 사용을 막았는지 먼저 확인하세요. 주소창 옆의 사이트 설정에서 카메라를 허용한 뒤 다시 시도합니다. 다른 앱이 카메라를 쓰고 있어도 열리지 않습니다.</p>
          <p>QR이 흐리거나 화면이 어두우면 참가자 화면 밝기를 올리고 가까이에서 비추세요. 그래도 안 되면 &ldquo;코드 입력&rdquo;으로 티켓 코드를 입력하거나 &ldquo;명단에서 찾기&rdquo;로 이름을 검색합니다.</p>
          <p>스캔 결과가 &ldquo;처리되지 않았습니다&rdquo;로 나오면 신청 취소나 재발급으로 무효가 된 티켓이거나 아직 승인되지 않은 신청일 수 있습니다. 참가자 명단에서 상태를 확인하세요.</p>
        </Faq>
        <Faq question="참가자가 자기 정보를 지워 달라고 해요">
          <p>참가자의 요청은 행사 주최 측이 처리합니다. 참가자 상세의 &ldquo;개인정보 삭제&rdquo;를 사용하면 이름과 연락처 등을 지우고 티켓을 쓸 수 없게 합니다. 되돌릴 수 없으므로 참가자 이름을 입력해 확인한 뒤 진행합니다.</p>
        </Faq>
      </>
    ),
  },
  {
    id: "contact",
    title: "문의하기",
    body: (
      <>
        <p>도움말로 해결되지 않으면 <a href={supportMailto("EVENTOUCH 문의")}>{SUPPORT_EMAIL}</a>로 보내 주세요. 행사 이름, 어느 화면에서 무엇을 했는지, 화면에 나온 문구를 함께 적어 주시면 빨리 확인할 수 있습니다.</p>
        <p>참가자가 문의하는 곳은 이 주소가 아니라 각 행사의 참가자 문의처입니다.</p>
      </>
    ),
  },
];

export default function HelpPage() {
  return (
    <DocumentPage
      current="help"
      title="도움말·문의"
      lead={<p>행사 운영자와 스태프를 위한 안내입니다. 화면 이름은 실제 메뉴 이름과 같습니다.</p>}
      sections={SECTIONS}
    />
  );
}
