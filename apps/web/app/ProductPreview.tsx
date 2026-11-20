import QRCode from "react-qr-code";
import { LandingIcon, type LandingIconName } from "./LandingIcons";
import styles from "./product-preview.module.css";

type Variant = "console" | "home" | "ticket" | "staff" | "report";

// The console menu as the operator sees it today (console-navigation.ts):
// four labelled groups, 운영 현황 first. Names here must stay product names.
const RAIL: ReadonlyArray<readonly [string, readonly string[]]> = [
  ["운영", ["운영 현황", "참가자 명단", "메시지"]],
  ["행사 준비", ["참가자 페이지", "공지·안내", "참여 이벤트", "입장·스태프", "행사 설정"]],
  ["당일", ["현장 모드"]],
  ["결과", ["결과 보고서"]],
];

// 운영 현황: one big entry number, the counts that explain it, then who came in.
const COUNTS: ReadonlyArray<{ label: string; hint: string; value: string; tone?: "warn" }> = [
  { label: "신청", hint: "취소 제외 등록", value: "269" },
  { label: "참가 확정", hint: "승인된 참가자", value: "251" },
  { label: "승인 대기", hint: "검토가 필요한 신청", value: "18", tone: "warn" },
  { label: "확정 중 미입장", hint: "아직 입장하지 않음", value: "30" },
];
const RECENT: ReadonlyArray<readonly [string, string, string]> = [
  ["김", "김하늘", "10:42"],
  ["이", "이도윤", "10:41"],
  ["박", "박서연", "10:39"],
  ["정", "정하윤", "10:37"],
];

const SHORTCUTS: ReadonlyArray<{ label: string; icon: LandingIconName; needsTicket?: boolean }> = [
  { label: "공지사항", icon: "notice" },
  { label: "럭키드로우 번호", icon: "gift", needsTicket: true },
  { label: "룰렛 이벤트", icon: "spark", needsTicket: true },
  { label: "순위 투표", icon: "vote", needsTicket: true },
];

const STAFF_TOOLS: ReadonlyArray<{ label: string; icon: LandingIconName }> = [
  { label: "코드 입력", icon: "code" },
  { label: "명단 찾기", icon: "search" },
  { label: "최근 처리", icon: "history" },
];

/** Public, synthetic product illustrations. No account, ticket or operational data is loaded. */
export default function ProductPreview({ variant }: { variant: Variant }) {
  if (variant === "console") {
    return (
      <div className={styles.console} role="img" aria-label="운영 현황 구성 예시. 누적 입장 숫자 하나와 신청·승인 상태 목록, 최근 입장 기록">
        <div className={styles.workspace}>
          <div className={styles.rail}>
            <strong className={styles.logo}><b>E</b>VENTOUCH</strong>
            {RAIL.map(([group, items]) => (
              <div key={group} className={styles.railGroup}>
                <small>{group}</small>
                {items.map((item) => <span key={item} data-on={item === "운영 현황" ? "true" : undefined}>{item}</span>)}
              </div>
            ))}
          </div>
          <div className={styles.canvas}>
            <p className={styles.crumb}>행사 / 파트너 컨퍼런스</p>
            <div className={styles.head}>
              <p className={styles.title}>운영 현황</p>
              <span className={styles.live}>진행 중</span>
            </div>
            <div className={styles.board}>
              <div className={styles.entry}>
                <div className={styles.entryTop}>
                  <span>누적 입장</span>
                  <span className={styles.openButton}>현장 모드 열기<LandingIcon name="arrow" size={14} /></span>
                </div>
                <p className={styles.big}><b>221</b><span>명</span><em>/ 269명</em><i className={styles.rate}>82%</i></p>
                <div className={styles.meter}><i /></div>
              </div>
              <ul className={styles.counts}>
                {COUNTS.map((row) => (
                  <li key={row.label} data-tone={row.tone}>
                    <span><b>{row.label}</b><small>{row.hint}</small></span>
                    <strong>{row.value}<small>명</small></strong>
                  </li>
                ))}
              </ul>
            </div>
            <div className={styles.recent}>
              <p className={styles.recentHead}><b>최근 입퇴장</b><span>{RECENT.length}건</span></p>
              {RECENT.map(([initial, name, time]) => (
                <p key={name} className={styles.person}>
                  <i>{initial}</i><b>{name}</b><span className={styles.statePill}>입장</span><time>{time}</time>
                </p>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (variant === "report") {
    return (
      <div className={styles.report} role="img" aria-label="결과 보고서 구성 예시. 보고서 목록과 PPTX 내보내기, 입장률 분석">
        <div className={styles.reportPage}>
          <p className={styles.crumb}>행사 / 파트너 컨퍼런스</p>
          <p className={styles.titleRow}><span className={styles.title}>결과 보고서</span><span>기간 분석</span></p>
          <p className={styles.tabRow}><span>행사 마감</span><b>보고서</b></p>
          <div className={styles.reportBody}>
            <div className={styles.docs}>
              <p className={styles.docsHead}><b>보고서</b><span className={styles.primaryButton}>보고서 만들기</span></p>
              <p className={styles.help}>생성 시점 고정 · 파일 전달 후 공유 완료 기록</p>
              <div className={styles.doc}>
                <i><LandingIcon name="file" size={18} /></i>
                <span><b>파트너 컨퍼런스 운영 결과</b><small>버전 1 · 생성 시점 고정</small></span>
                <span className={styles.statePill}>공유 완료 기록</span>
              </div>
              <p className={styles.exportRow}>
                <span className={styles.ghostButton}><LandingIcon name="download" size={14} />PPTX로 내보내기</span>
                <span className={styles.ghostButton}>인쇄·PDF</span>
              </p>
            </div>
            <div className={styles.analysis}>
              <p className={styles.analysisHead}><b>결과 분석</b></p>
              <p className={styles.bigRate}><b>82</b><span>%</span><small>누적 입장률</small></p>
              <div className={styles.meterLight}><i /></div>
              <p className={styles.miniStats}>
                <span><small>누적 입장</small><b>221<em>명</em></b></span>
                <span><small>취소 제외 등록</small><b>269<em>명</em></b></span>
                <span><small>현재 입장</small><b>187<em>명</em></b></span>
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (variant === "home") {
    return (
      <div className={styles.phone} role="img" aria-label="참가자 홈 구성 예시. 행사 배너, 모바일 티켓 카드, 행사 안내와 행사 참여 바로가기">
        <div className={styles.banner}>
          <span className={styles.chip}>12월 12일 · 코엑스</span>
          <p>파트너<br />컨퍼런스</p>
        </div>
        <div className={styles.ticketCard}>
          <i><LandingIcon name="ticket" size={20} /></i>
          <span><b>모바일 티켓</b><small>신청한 티켓 확인</small></span>
          <span className={styles.pillButton}>열기</span>
        </div>
        {[["행사 안내", SHORTCUTS.slice(0, 2)], ["행사 참여", SHORTCUTS.slice(2)]].map(([group, items]) => (
          <div key={group as string} className={styles.group}>
            <p className={styles.groupLabel}>{group as string}</p>
            <div className={styles.tiles}>
              {(items as typeof SHORTCUTS).map((item) => (
                <span key={item.label} className={styles.tile}>
                  <i><LandingIcon name={item.icon} size={18} /></i>
                  <span><b>{item.label}</b>{item.needsTicket ? <small>티켓 필요</small> : null}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (variant === "ticket") {
    return (
      <div className={styles.phone} role="img" aria-label="모바일 티켓 구성 예시. 참가 상태, 이름, 샘플 QR. 실제 입장에 사용할 수 없습니다">
        <div className={styles.passBanner}>
          <span className={styles.chip}>내 티켓</span>
          <p>파트너 컨퍼런스</p>
        </div>
        <div className={styles.pass}>
          <span className={styles.confirmed}><LandingIcon name="check" size={14} />참가 확정</span>
          <p className={styles.passName}>김참가</p>
          <span className={styles.tear} aria-hidden="true"><i /></span>
          <div className={styles.qr}><QRCode value="EVENTOUCH-DEMO-NOT-A-VALID-TICKET" size={120} /></div>
          <p className={styles.hint}>입장할 때 이 QR을 보여 주세요.</p>
        </div>
        <p className={styles.sample}>샘플 QR · 실제 입장에 사용할 수 없습니다.</p>
        <div className={styles.bottomBar}><span className={styles.primaryWide}>참여 콘텐츠 보기</span></div>
      </div>
    );
  }

  return (
    <div className={`${styles.phone} ${styles.staff}`} role="img" aria-label="스태프 현장 화면 구성 예시. 입장 데스크 선택, 카메라 스캔, 코드 입력·명단 찾기·최근 처리">
      <div className={styles.staffTop}>
        <LandingIcon name="back" size={18} /><span>파트너 컨퍼런스</span><LandingIcon name="more" size={18} />
      </div>
      <p className={styles.station}><b>입장 데스크 A</b><LandingIcon name="down" size={16} /></p>
      <p className={styles.modeSwitch}><b>데스크 체크인</b><span>부스 인증</span></p>
      <div className={styles.viewfinder}>
        <i /><i /><i /><i />
        <span className={styles.scanLine} />
      </div>
      <div className={styles.staffBar}>
        {STAFF_TOOLS.map((tool) => (
          <span key={tool.label} className={styles.tool}><LandingIcon name={tool.icon} size={20} />{tool.label}</span>
        ))}
      </div>
    </div>
  );
}
