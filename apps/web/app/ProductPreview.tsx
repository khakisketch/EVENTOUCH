import QRCode from "react-qr-code";
import styles from "./product-preview.module.css";

type Variant = "console" | "home" | "ticket" | "staff" | "report";

/** Public, synthetic product illustrations. No account, ticket or operational data is loaded. */
export default function ProductPreview({ variant }: { variant: Variant }) {
  if (variant === "console") return <div className={styles.workspace} aria-label="운영 현황 구성 예시">
    <div className={styles.rail}><strong>EVENTOUCH</strong><span>운영 현황</span><span>참가자 명단</span><span>메시지</span><span>현장 운영</span><span>참여 콘텐츠</span><span>결과 보고서</span></div>
    <div className={styles.canvas}><p className={styles.context}>파트너 컨퍼런스 · 진행 중</p><p className={styles.title}>운영 현황</p>
      <div className={styles.metrics}>{[["신청", "269"], ["참가 확정", "245"], ["승인 대기", "24"]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}<small>명</small></strong></div>)}</div>
      <div className={styles.workColumns}><div><p className={styles.sectionTitle}>지금 할 일</p><div className={styles.workRow}><span>승인 대기 24명</span><b>명단 확인 →</b></div><div className={styles.workRow}><span>예약 메시지 2건</span><b>메시지 확인 →</b></div></div><div><p className={styles.sectionTitle}>행사 일정</p><p className={styles.schedule}><time>10:00</time> 오프닝</p><p className={styles.schedule}><time>11:00</time> 파트너 세션</p></div></div>
      <p className={styles.caption}>화면 구성 예시 · 합성 데이터</p>
    </div>
  </div>;
  if (variant === "report") return <div className={styles.report} aria-label="결과 보고서 구성 예시"><p className={styles.context}>파트너 컨퍼런스</p><p className={styles.title}>결과 보고서</p><div className={styles.tabRow}><b>보고서</b><span>결과 분석</span><span>행사 마감</span></div><div className={styles.workRow}><div><strong>파트너 컨퍼런스 운영 결과</strong><p className={styles.context}>버전 1 · 생성 시점 고정</p></div><span className={styles.tag}>공유 완료 기록</span></div><div className={styles.metrics}>{[["등록", "269명"], ["누적 입장", "221명"], ["입장률", "82%"]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{value}</strong></div>)}</div><p className={styles.caption}>화면 구성 예시 · 합성 데이터</p></div>;
  return <div className={`${styles.phone} ${variant === "home" ? styles.home : ""}`} aria-label={`${variant === "home" ? "참가자 홈" : variant === "ticket" ? "모바일 티켓" : "스태프 업무"} 구성 예시`}>
    {variant === "home" ? <><div className={styles.banner}><p>파트너<br />컨퍼런스</p></div><p className={styles.ticketAction}>모바일 티켓 <span>→</span></p><p className={styles.groupLabel}>행사 안내</p><div className={styles.menuPair}><span>공지사항</span><span>럭키드로우 번호</span></div><p className={styles.groupLabel}>행사 참여</p><div className={styles.menuPair}><span>룰렛 이벤트</span><span>순위 투표</span><span>부스 인증</span></div><p className={styles.caption}>화면 구성 예시</p></> : variant === "ticket" ? <><p className={styles.context}>EVENTOUCH <span>참가 메뉴로</span></p><p className={styles.title}>내 티켓</p><p className={styles.context}>파트너 컨퍼런스</p><div className={styles.workRow}><strong>김참가</strong><span className={styles.tag}>참가 확정</span></div><div className={styles.qr}><QRCode value="EVENTOUCH-DEMO-NOT-A-VALID-TICKET" size={160} /></div><p className={styles.caption}>입장할 때 QR을 보여 주세요.</p><p className={styles.sample}>샘플 QR · 실제 입장에 사용할 수 없습니다.</p></> : <><p className={styles.title}>현장 업무</p><p className={styles.context}>파트너 컨퍼런스 · 현장 운영팀</p><div className={styles.tabRow}><b>데스크 체크인</b><span>부스 인증</span></div><p className={styles.groupLabel}>처리 위치</p><div className={styles.input}>입장 데스크 A</div><p className={styles.sectionTitle}>참가자 티켓 확인</p><div className={styles.scan}>카메라로 스캔</div><p className={styles.groupLabel}>티켓 코드</p><div className={styles.input}>코드 입력</div><div className={styles.workRow}><span>최근 처리</span><b>김참가 · 입장</b></div><p className={styles.caption}>화면 구성 예시</p></>}
  </div>;
}
