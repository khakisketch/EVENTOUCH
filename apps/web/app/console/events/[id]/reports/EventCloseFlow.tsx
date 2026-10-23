import Link from "next/link";
import { eventStageLabel } from "../../../../event-stage";
import { closeHandoffHref, closePrerequisite, type CloseInputs } from "../../../console-event-close";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import styles from "./reports.module.css";

type CloseReport = { id: string; title: string; status: string; version: number; capturedAt: string };

export default function EventCloseFlow({ eventId, inputs, loadedAt, report, hasReports, onCreate, onReview, onRefresh }: {
  eventId: string;
  inputs: CloseInputs;
  loadedAt: string;
  report: CloseReport | null;
  hasReports: boolean;
  onCreate: () => void;
  onReview: () => void;
  onRefresh: () => void;
}) {
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const href = (target: string) => closeHandoffHref(target, eventId, report?.id);
  const step = closePrerequisite(inputs);
  const frozen = report?.status === "PUBLISHED";
  const next = step === "pending"
    ? { label: "승인 대기 처리하기", href: href(`${base}/participants?status=PENDING`), detail: "종료하면 참가자 변경이 막힙니다. 승인 대기부터 처리하세요." }
    : step === "features"
      ? { label: "프로그램 기능 설정 확인하기", href: href(`${base}/settings?closeStep=programs#settings-features`), detail: "기능이 꺼진 진행 프로그램이 있습니다. 해당 기능을 켜서 저장한 뒤 프로그램을 닫으세요. 자동으로 활성화하지 않습니다." }
      : step === "programs"
        ? { label: "참여 프로그램 닫기", href: href(`${base}/programs`), detail: "진행 중인 참여 프로그램을 모두 닫은 뒤 이 화면의 ‘다음’으로 바로 이어가세요." }
        : step === "intake"
          ? { label: "참가 접수 닫기", href: href(`${base}/settings?closeStep=intake#settings-intake`), detail: "새 신청을 받지 않도록 접수를 닫으세요. 같은 설정 화면에서 진행 단계도 확인할 수 있습니다." }
          : step === "stage"
            ? { label: "진행 단계에서 종료 확인하기", href: href(`${base}/settings?closeStep=end#settings-stage`), detail: "기존 진행 단계 순서와 전제·확인을 거쳐 종료로 전환하세요. 단계는 건너뛰거나 되돌릴 수 없습니다." }
            : step === "archived"
              ? null
              : frozen
                ? { label: "결과 안내 작성·확인하기", href: href(`${base}/messages`), detail: "동결한 보고서의 집계 기준을 확인한 뒤 메시지에서 대상과 내용을 직접 검토하세요. 자동 발송되지 않습니다." }
                : report
                  ? { label: "보고서 검토·동결하기", href: null, detail: "초안도 생성 시점의 집계입니다. 내용을 검토하고 파일을 별도로 전달한 뒤 공유 완료·잠금을 기록하세요." }
                  : { label: "마감 보고서 만들기", href: null, detail: "마감 전제가 준비됐습니다. 현재 집계를 담은 보고서를 생성하고 검토·동결하세요." };
  return (
    <ConsoleSection headingId="event-close" title="행사 마감" className={styles.closeFlow}
      description={`조회 기준 시각 ${loadedAt || "확인 중"} · 새로고침과 마감 복귀 시 갱신됩니다.`}
      action={<button type="button" className="button button-secondary" onClick={onRefresh}>마감 상태 새로고침</button>}>
      <p className={styles.help}>마감 지도 · {step === "pending" ? 1 : ["features", "programs"].includes(step) ? 2 : step === "intake" ? 3 : step === "stage" ? 4 : step === "archived" ? 7 : frozen ? 6 : 5}/7 · 각 화면의 ‘다음’으로 이어가며, 지도 복귀는 선택입니다.</p>
      <dl className={styles.closeFacts}>
        <div><dt>진행 단계</dt><dd>{eventStageLabel(inputs.stage)}</dd></div>
        <div><dt>참가 접수</dt><dd>{inputs.registrationOpen ? "열림" : "닫힘"}</dd></div>
        <div><dt>승인 대기</dt><dd>{inputs.pending}명</dd></div>
        <div><dt>진행 프로그램</dt><dd>{inputs.openModules.length}개</dd></div>
      </dl>
      {inputs.pending > 0 && ["ENDED", "ARCHIVED"].includes(inputs.stage) ? (
        <ConsoleFeedback kind="warning">승인 대기 {inputs.pending}명이 남아 있지만 종료 이후에는 참가자를 변경할 수 없습니다. 참가 확정은 아니며, 취소 제외 등록 집계에는 포함됩니다.</ConsoleFeedback>
      ) : null}
      {report ? <p className={styles.help}>마감에 선택한 보고서: <strong>{report.title}</strong> · 버전 {report.version} · {frozen ? "공유 완료 기록·편집 잠김" : "초안"} · 집계 기준 {report.capturedAt || "확인 필요"}. 선택한 보고서는 생성 시점 그대로 유지되며 현재 상태와 다를 수 있습니다.</p> : null}
      {next ? <div className={styles.closeNext}>
        <p><strong>다음 할 일 · {next.label}</strong></p><p className={styles.help}>{next.detail}</p>
        <ConsoleFormActions>
          {next.href ? <Link className="button button-primary" href={next.href} data-close-next>{next.label}</Link>
            : <button type="button" className="button button-primary" onClick={report ? onReview : onCreate} data-close-next>{next.label}</button>}
          {step === "report" && !report && hasReports ? <a className="button button-secondary" href="#reports-list">기존 보고서 검토·선택</a> : null}
          {step === "report" && report && !frozen ? <button type="button" className="button button-secondary" onClick={onCreate}>현재 집계로 새 보고서 만들기</button> : null}
        </ConsoleFormActions>
      </div> : <p>보관된 행사입니다. 분석과 동결 보고서는 읽기 전용이며, 메시지 작성·발송과 행사 변경은 잠겨 있습니다.</p>}
      {frozen && step === "report" ? <div className={styles.closeNext}>
        <p className={styles.help}>보관 후에는 메시지 작성·발송도 잠깁니다. 결과 안내의 대상·내용·발송 상태를 먼저 확인하세요. 이 화면은 발송 완료를 자동으로 판단하지 않습니다.</p>
        <Link className="button button-secondary" href={href(`${base}/settings?closeStep=archive#settings-stage`)} data-close-archive>결과 안내 확인 후 보관하기</Link>
      </div> : null}
      <details className={styles.closeDetails}>
        <summary>전체 마감 단계와 전제 확인</summary>
        <p className={styles.help}>보관 전제 · 조회 시점 — 보고서는 생성 시점 그대로 유지되며 아래는 마지막으로 불러온 행사 상태입니다. 새로고침 시 갱신됩니다. 각 화면의 ‘다음’으로 바로 이어가며 ‘마감으로 돌아가기’는 상태 확인용 선택입니다.</p>
        <ol className={styles.archiveList}>
          <li>승인 대기 {inputs.pending}명 — 참가 확정과 구분되며 취소 제외 등록 집계에는 포함됩니다. 종료 전에 필요한 처리를 마치세요. {!["ENDED", "ARCHIVED"].includes(inputs.stage) ? <Link className="button button-secondary" href={href(`${base}/participants?status=PENDING`)}>참가자에서 승인 처리하기</Link> : "종료 이후 참가자 변경 불가"}</li>
          <li>{inputs.openModules.length ? `진행 중인 참여 프로그램 ${inputs.openModules.length}개 — 보관 전에 모두 닫기가 필요합니다: ${inputs.openModules.map((module) => module.name).join(" · ")}` : "진행 중인 참여 프로그램 없음"} <Link className="button button-secondary" href={href(`${base}/programs`)}>참여 프로그램에서 닫기</Link> <Link className="button button-secondary" href={href(`${base}/draws`)}>추첨·투표에서 닫기</Link></li>
          <li>{inputs.registrationOpen ? "참가 접수 열림 — 보관 전에 접수 닫기가 필요합니다." : "참가 접수 닫힘"} <Link className="button button-secondary" href={href(`${base}/settings#settings-intake`)}>참가 접수에서 닫기</Link></li>
          <li>현재 단계: {eventStageLabel(inputs.stage)} <Link className="button button-secondary" href={href(`${base}/settings#settings-stage`)}>진행 단계에서 확인·전환</Link></li>
          <li>보고서 생성·검토·공유 완료 기록 — 초안도 집계가 고정됩니다. 편집·공유 완료 기록은 집계를 갱신하지 않습니다. 현재 집계가 필요하면 새 보고서나 ‘현재 집계를 새로 반영’하는 후속 버전을 만드세요.</li>
          <li>결과 안내 — 메시지에서 직접 대상·내용·발송 상태를 확인하세요. 공유 완료 기록은 고객사 자동 전송이나 참가자 결과 안내를 대신하지 않습니다. <Link className="button button-secondary" href={href(`${base}/messages`)}>메시지에서 결과 안내 확인</Link></li>
          <li>보관 — 접수와 진행 프로그램을 모두 닫은 종료 행사에서 기존 확인을 거칩니다. 보관 후에는 모든 쓰기가 잠기므로 결과 안내를 먼저 마치세요.</li>
        </ol>
      </details>
    </ConsoleSection>
  );
}
