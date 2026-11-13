"use client";

import ProductButton from "./ProductButton";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { acknowledgeOperatorReceipt, getOperatorContextSnapshot, operatorFetch } from "../../lib/operator-context";
import { useOperatorContextSnapshot } from "../../lib/use-operator-context";
import { forgetOperatorReceipt, operatorReceiptSharingAvailable, operatorReceiptStorageAvailable, subscribeOperatorReceipts, visibleOperatorReceipts, type OperatorReceiptPointer } from "../../lib/operator-receipts";
import ConsoleDialog from "../console/console-ui/ConsoleDialog";
import TicketReissue from "../console/events/[id]/participants/TicketReissue";
import styles from "./operator-receipts.module.css";

type TicketRecovery = {
  pointer: OperatorReceiptPointer;
  participantId: string;
  name: string;
  company: string;
  maskedPhone: string;
  eventSlug: string;
  expectedTicketRevision: number;
  contextKey: string;
};
type CancellationReviewRecovery = { pointer: OperatorReceiptPointer; contextKey: string; name: string; company: string; maskedPhone: string; reviewedName: string; reviewedCompany: string; reviewedMaskedPhone: string; currentStatus: string; currentTicketReview: string };

function cancellationReviewContext(pointer: OperatorReceiptPointer, value: unknown, contextKey: string): CancellationReviewRecovery | null {
  if (!pointer.eventId || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.participantId !== "string" || !item.participantId || item.participantId.length > 120 ||
      typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 ||
      typeof item.company !== "string" || item.company.length > 100 ||
      typeof item.maskedPhone !== "string" || (item.maskedPhone !== "" && !/^\d{3}-\*{4}-\d{4}$/.test(item.maskedPhone)) ||
      typeof item.reviewedName !== "string" || !item.reviewedName.trim() || item.reviewedName.length > 100 ||
      typeof item.reviewedCompany !== "string" || item.reviewedCompany.length > 100 ||
      typeof item.reviewedMaskedPhone !== "string" || !/^\d{3}-\*{4}-\d{4}$/.test(item.reviewedMaskedPhone) ||
      typeof item.currentStatus !== "string" || typeof item.currentTicketReview !== "string") return null;
  return { pointer, contextKey, name: item.name, company: item.company, maskedPhone: item.maskedPhone,
    reviewedName: item.reviewedName, reviewedCompany: item.reviewedCompany, reviewedMaskedPhone: item.reviewedMaskedPhone,
    currentStatus: item.currentStatus, currentTicketReview: item.currentTicketReview };
}

function ticketRecoveryContext(pointer: OperatorReceiptPointer, value: unknown, contextKey: string): TicketRecovery | null {
  if (!pointer.eventId || !value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (typeof item.participantId !== "string" || !item.participantId || item.participantId.length > 120 ||
      typeof item.name !== "string" || !item.name.trim() || item.name.length > 100 ||
      typeof item.company !== "string" || item.company.length > 100 ||
      typeof item.maskedPhone !== "string" || (item.maskedPhone !== "" && !/^\d{3}-\*{4}-\d{4}$/.test(item.maskedPhone)) ||
      typeof item.eventSlug !== "string" || !item.eventSlug || item.eventSlug.length > 100 ||
      !Number.isSafeInteger(item.expectedTicketRevision) || Number(item.expectedTicketRevision) < 0) return null;
  return { pointer, participantId: item.participantId, name: item.name, company: item.company,
    maskedPhone: item.maskedPhone, eventSlug: item.eventSlug, expectedTicketRevision: Number(item.expectedTicketRevision), contextKey };
}

function label(command: string): string {
  const labels: Record<string, string> = {
    "event.create": "행사 생성", "event.duplicate": "행사 복제", "event.update": "행사 정보 저장", "event.basics.save": "행사 정보 저장", "event.features": "운영 기능 저장", "event.stage": "행사 단계 전환", "form.publish": "참가 양식 게시", "form.close": "참가 접수 닫기", "field.save": "신청 항목 저장", "field.move": "신청 항목 순서 변경", "field.delete": "신청 항목 제외", "client.save": "고객사 저장",
    "member.assign": "행사 권한 저장", "org.permissions.save": "팀 권한 저장", "invitation.create": "구성원 초대", "account.password-reset": "비밀번호 재설정",
    "message.create": "발송 요청", "message.create-reviewed": "발송 요청", "message.create-charset-reviewed": "발송 요청", "message.record-provider-check": "공급사 확인 기록", "message.retry": "발송 재시도", "message.retry-charset-reviewed": "발송 재시도", "message.cancel": "발송 취소", "message.sync": "발송 결과 조회", "template.save": "메시지 템플릿 저장", "template.archive": "메시지 템플릿 보관·복원",
    "check.scan": "입퇴장 처리", "check.correct": "입퇴장 정정", "check.reviewed-exit": "확인 후 퇴장 기록", "check.reconcile": "출입 상태 복구", "booth.visit": "부스 방문 처리",
    "desk.save": "데스크 저장", "desk.set-open": "데스크 가동 변경", "booth.save": "부스 저장", "booth.mode": "부스 인증 방식 변경", "booth.mode-reviewed": "부스 인증 방식 변경",
    "booth.map.save": "부스 지도 저장", "booth.map.publish": "부스 지도 게시", "booth.map.unpublish": "부스 지도 게시 중단",
    "staff.assign": "스태프 배정", "staff.unassign": "스태프 배정 해제", "display.set": "전광판 출력 변경",
    "participant.create": "참가자 등록", "participant.update": "참가자 수정", "participant.import": "참가자 가져오기",
    "participant.status": "참가자 상태 변경", "participant.bulk-cancel": "신청 일괄 취소", "participant.resolve-cancellation-conflict": "참가 취소 기록 확인", "ticket.reissue": "티켓 재발급", "ticket.reissue-reviewed": "티켓 재발급", "group.assign": "그룹 지정", "reward.create": "경품 등록", "reward.lookup": "경품 조회", "reward.collect": "경품 수령", "reward.fulfill": "경품 지급", "reward.cancel": "경품 취소",
    "notice.publish": "공지 게시", "notice.publish-reviewed": "공지 게시", "program.publish": "일정 게시", "program.publish-reviewed": "일정 게시", "venue.publish": "장소 안내 게시", "venue.publish-reviewed": "장소 안내 게시", "venue.save": "장소 안내 저장",
    "notice.save": "공지 저장", "program.save": "일정 저장",
    "report.create": "보고서 만들기", "report.update": "보고서 수정", "report.publish": "보고서 공유 기록", "report.successor": "보고서 새 버전",
    "evidence.photo.add": "현장 사진 등록", "evidence.photo.move": "현장 사진 이동", "evidence.photo.remove": "현장 사진 제외",
    "draw.program.run": "추첨 실행", "draw.program.save": "추첨 프로그램 저장", "team.save": "투표 팀 저장",
    "vote.config.save": "투표 설정 저장", "vote.tally": "투표 집계", "lucky.config.save": "럭키번호 설정 저장", "lucky.config.save-reviewed": "럭키번호 설정 저장",
    "lucky.preassign": "럭키번호 배정", "lucky.preassign-reviewed": "럭키번호 배정", "lucky.preassign-range-reviewed": "럭키번호 배정", "roulette.config.save": "룰렛 설정 저장", "roulette.config.save-reviewed": "룰렛 설정 저장", "reward.assign": "경품 수령자 지정",
    "attendee.page.save": "참가자 페이지 저장", "attendee.page.publish": "참가자 페이지 게시", "attendee.page.publish-reviewed": "참가자 페이지 게시",
    "module.save": "참여 콘텐츠 저장", "module.status": "참여 콘텐츠 상태 변경", "module.reveal": "퀴즈 정답 공개",
    "draw.run": "간단 추첨", "draw.publish": "간단 추첨 공개", "photo.moderate": "참여 사진 검토", "post.moderate": "게시글 검토",
    "question.manage": "질문 답변·공개", "question.edit.approve": "질문 수정 승인", "question.edit.reject": "질문 수정 반려",
  };
  return labels[command] ?? "업무 요청";
}

export default function OperatorReceiptRecovery({ currentEventId, currentEventName, onlyCommandId, excludeCommandId, inline = false, disabled = false, onCheckingChange }: {
  currentEventId?: string | null; currentEventName?: string | null; onlyCommandId?: string | null; excludeCommandId?: string | null;
  inline?: boolean; disabled?: boolean; onCheckingChange?: (checking: boolean) => void;
} = {}) {
  const snapshot = useOperatorContextSnapshot();
  const pathname = usePathname();
  const router = useRouter();
  const [items, setItems] = useState<OperatorReceiptPointer[]>([]);
  const [checking, setChecking] = useState<string | null>(null);
  const [storageAvailable, setStorageAvailable] = useState(true);
  const [sharingAvailable, setSharingAvailable] = useState(true);
  const [removeCandidate, setRemoveCandidate] = useState<OperatorReceiptPointer | null>(null);
  const [ticketRecovery, setTicketRecovery] = useState<TicketRecovery | null>(null);
  const [cancellationReviewRecovery, setCancellationReviewRecovery] = useState<CancellationReviewRecovery | null>(null);
  const [openTicketRecovery, setOpenTicketRecovery] = useState<TicketRecovery | null>(null);
  const [message, setMessage] = useState<{ userId: string; organizationId: string; text: string; href?: string } | null>(null);
  useEffect(() => {
    const update = () => { setItems(visibleOperatorReceipts()); setStorageAvailable(operatorReceiptStorageAvailable()); setSharingAvailable(operatorReceiptSharingAvailable()); };
    update();
    return subscribeOperatorReceipts(update);
  }, []);
  const context = snapshot.context;
  const contextKey = context ? `${context.userId}|${context.organizationId}|${context.contextVersion}|${context.role}` : "";
  useEffect(() => { setTicketRecovery(null); setOpenTicketRecovery(null); setCancellationReviewRecovery(null); }, [contextKey, snapshot.changed]);
  // The draw workspace has a purpose-built recovery panel that also locks
  // another draw and refreshes winners. Avoid presenting two identical checks
  // on that screen; other screens still show the shared receipt list.
  const onDrawPage = Boolean(currentEventId && pathname === `/console/events/${encodeURIComponent(currentEventId)}/draws`);
  const mine = context ? items.filter((item) => item.userId === context.userId && item.organizationId === context.organizationId &&
    (!onlyCommandId || (item.commandId === onlyCommandId && (!currentEventId || item.eventId === currentEventId))) &&
    (!excludeCommandId || item.commandId !== excludeCommandId) &&
    !(onDrawPage && item.eventId === currentEventId && item.command === "draw.program.run")) : [];
  const visibleMessage = context && message?.userId === context.userId && message.organizationId === context.organizationId ? message : null;
  const visibleTicketRecovery = context && !snapshot.changed && ticketRecovery?.pointer.userId === context.userId &&
    ticketRecovery.pointer.organizationId === context.organizationId && ticketRecovery.contextKey === contextKey && mine.some(item => item.commandId === ticketRecovery.pointer.commandId) ? ticketRecovery : null;
  const activeTicketRecovery = context && !snapshot.changed && openTicketRecovery?.pointer.userId === context.userId &&
    openTicketRecovery.pointer.organizationId === context.organizationId && openTicketRecovery.contextKey === contextKey ? openTicketRecovery : null;
  const visibleCancellationReview = context && !snapshot.changed && cancellationReviewRecovery?.pointer.userId === context.userId &&
    cancellationReviewRecovery.pointer.organizationId === context.organizationId && cancellationReviewRecovery.contextKey === contextKey && mine.some(item => item.commandId === cancellationReviewRecovery.pointer.commandId) ? cancellationReviewRecovery : null;
  if (inline && !mine.length && !visibleMessage) return null;
  if (!inline && !mine.length && !visibleMessage && !activeTicketRecovery && storageAvailable && sharingAvailable) return null;

  async function check(pointer: OperatorReceiptPointer) {
    if (checking || snapshot.changed || disabled) return;
    setChecking(pointer.commandId);
    onCheckingChange?.(true);
    setMessage(null);
    setTicketRecovery(null);
    setCancellationReviewRecovery(null);
    const say = (text: string, href?: string) => setMessage({ userId: pointer.userId, organizationId: pointer.organizationId, text, href });
    const path = pointer.eventId
      ? `/api/events/${encodeURIComponent(pointer.eventId)}/command-receipts/${encodeURIComponent(pointer.commandId)}`
      : `/api/command-receipts/${encodeURIComponent(pointer.commandId)}`;
    try {
      const view = pointer.command === "ticket.reissue-reviewed" ? "?view=ticket-reissue" : pointer.command === "participant.resolve-cancellation-conflict" ? "?view=cancellation-review" : "";
      const response = await operatorFetch(`${path}${view}`, { cache: "no-store" });
      const body = await response.json().catch(() => null) as { status?: unknown; command?: unknown; ticketReissue?: unknown; cancellationReview?: unknown } | null;
      const latest = getOperatorContextSnapshot();
      const current = latest.context;
      if (latest.changed || !current || `${current.userId}|${current.organizationId}|${current.contextVersion}|${current.role}` !== contextKey) return;
      if (response.ok && body?.status === "APPLIED" && body.command === pointer.command) {
        if (pointer.command === "event.basics.save") {
          // The status endpoint omits the saved values and ticket impact.
          // Keep the unresolved request until its original response is proven
          // or the operator explicitly reviews the current records.
          say("서버에 행사 정보 저장 기록이 있습니다. 원래 화면에서 같은 요청을 다시 확인하거나, 현재 행사 정보와 티켓 확인이 필요한 참가자를 확인하세요.", pointer.eventId ? `/console/events/${encodeURIComponent(pointer.eventId)}/participants?ticket=review` : undefined);
          return;
        }
        if (pointer.command === "message.retry-charset-reviewed") {
          // A status lookup is read-only and proves only the command ID, not
          // its target or policy. Refresh a mounted history but keep the
          // pointer and the original request for explicit same-ID recovery.
          window.dispatchEvent(new CustomEvent("eventouch:operator-receipt-applied", { detail: pointer }));
          say("서버에 발송 실행 기록이 있습니다. 발송 이력의 최신 상태를 확인하고, 원래 요청이 남아 있으면 같은 요청을 다시 확인하세요.");
          return;
        }
        if (["message.create-reviewed", "message.create-charset-reviewed", "message.record-provider-check"].includes(pointer.command)) {
          // APPLIED does not identify the original recipients, content, or
          // provider review. Do not dismiss or announce a matching outcome.
          say(["message.create-reviewed", "message.create-charset-reviewed"].includes(pointer.command)
            ? "서버에 발송 요청 기록이 있습니다. 원래 작성 화면에서 같은 요청을 확인하거나 발송 내역의 대상과 내용을 확인하세요."
            : "서버에 공급사 확인 기록이 있습니다. 원래 화면에서 같은 요청을 확인하거나 발송 내역의 수신자를 확인하세요.");
          return;
        }
        if (pointer.command === "participant.resolve-cancellation-conflict") {
          const target = cancellationReviewContext(pointer, body.cancellationReview, contextKey);
          if (target) { setCancellationReviewRecovery(target); say("서버에 확인 내용이 저장됐습니다. 대상과 현재 상태를 확인하세요."); }
          else say("확인 기록은 있지만 대상이나 현재 권한을 확인하지 못했습니다. 참가자 명단을 확인하세요.");
          return;
        }
        if (pointer.command === "participant.bulk-cancel") {
          // A status lookup proves only that this command ID was used, not
          // which participants the original cancellation affected. Do not
          // dispatch an applied event or release the unresolved request.
          say("서버에 취소 요청 기록이 있습니다. 원래 명단의 상태를 직접 확인한 뒤 필요하면 목록에서 지우세요.");
          return;
        }
        if (pointer.command === "ticket.reissue-reviewed") {
          const target = ticketRecoveryContext(pointer, body.ticketReissue, contextKey);
          if (target) {
            setTicketRecovery(target);
            say("서버에 티켓 재발급 기록이 있습니다. 대상과 발급된 링크를 확인하세요.");
          } else {
            say("서버에 티켓 재발급 기록이 있지만 대상이나 현재 권한을 확인하지 못했습니다. 원래 화면이나 참가자 명단을 확인하세요.");
          }
          return;
        }
        if (["booth.visit", "reward.lookup", "reward.collect"].includes(pointer.command)) {
          // This endpoint reports only the command name, not the booth or
          // participant. Keep the pointer through reload until the original
          // request is checked, or the operator has checked the visit log.
          if (!(inline && pointer.command === "booth.visit")) window.dispatchEvent(new CustomEvent("eventouch:operator-receipt-applied", { detail: pointer }));
          say(pointer.command === "booth.visit"
            ? inline ? "서버에 부스 인증 기록이 있습니다. 대상을 확인하려면 같은 요청을 다시 확인하세요." : "서버에 부스 인증 기록이 있습니다. 화면에 원래 요청이 남아 있다면 다시 확인하고, 그렇지 않다면 인증 내역을 확인하세요."
            : "서버에 경품 요청 기록이 있습니다. 화면에 원래 요청이 남아 있다면 다시 확인하고, 그렇지 않다면 운영자에게 경품 내역을 확인하세요.");
          return;
        }
        if (!forgetOperatorReceipt(pointer.commandId, pointer)) {
          say("확인 목록을 갱신하지 못했습니다. 브라우저 저장 상태와 현재 계정, 처리 내역을 다시 확인하세요.");
          return;
        }
        acknowledgeOperatorReceipt(pointer.commandId);
        // A mounted work surface may still hold the frozen request in memory.
        // Let that surface reconcile its own matching request after this
        // authorized, status-only lookup. No submitted content is dispatched.
        window.dispatchEvent(new CustomEvent("eventouch:operator-receipt-applied", { detail: pointer }));
        if (pointer.command === "event.update" && pointer.eventId) {
          say("서버에 저장된 것을 확인했습니다. 날짜를 변경했다면 티켓 확인이 필요한 참가자를 확인하세요. 이 화면에서는 원래 변경 내용과 영향 인원을 확인할 수 없습니다.", `/console/events/${encodeURIComponent(pointer.eventId)}/participants?ticket=review`);
          return;
        }
        say(pointer.command === "invitation.create"
          ? "초대 발급이 반영됐습니다. 링크는 다시 볼 수 없으므로 팀의 대기 초대를 확인하고 필요하면 철회 후 다시 발급하세요."
          : pointer.command.startsWith("message.")
          ? "서버에 반영된 것을 확인했습니다. 실제 발송 결과는 발송 기록에서 확인하세요."
          : "서버에 반영된 것을 확인했습니다. 화면의 최신 내용을 확인하세요.");
      } else if (response.ok && body?.status === "UNCONFIRMED") {
        say("아직 처리 여부를 확인할 수 없습니다. 요청이 처리 중이거나 도착하지 않았을 수 있습니다. 잠시 후 다시 확인하세요.");
      } else if (response.status >= 500 || [425, 429].includes(response.status)) {
        say("일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요.");
      } else {
        say("결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
      }
    } catch {
      say("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다.");
    } finally { setChecking(null); onCheckingChange?.(false); }
  }

  if (inline) return <div role="group" aria-label="현재 요청 서버 확인">
    {mine.map((pointer) => <ProductButton key={pointer.commandId} type="button" className="button button-secondary" disabled={Boolean(checking) || snapshot.changed || disabled} onClick={() => void check(pointer)}>{checking === pointer.commandId ? "확인 중…" : "서버 처리 확인"}</ProductButton>)}
    {visibleMessage ? <p role="status">{visibleMessage.text}</p> : null}
  </div>;

  return <section className={styles.panel} aria-label="처리 결과 확인">
    {!storageAvailable ? <p role="alert">이 브라우저에서 결과 확인 정보를 저장할 수 없습니다. 응답이 끊기면 화면을 떠나기 전에 원래 요청을 확인하세요.</p> : null}
    {storageAvailable && !sharingAvailable ? <p role="alert">다른 창과 처리 결과를 공유할 수 없습니다. 이 창에서 결과를 확인하고, 다른 창에서 같은 업무를 다시 처리하기 전에 내역을 확인하세요.</p> : null}
    {mine.length ? <>
      <h2>처리 결과 확인</h2>
      <p>{mine.some((item) => item.command === "ticket.reissue-reviewed")
        ? "처리 결과나 발급된 링크를 확인할 요청이 있습니다. 서버 확인은 요청을 다시 보내지 않습니다."
        : "다른 창에서 처리 중이거나 응답을 받지 못한 요청이 있습니다. 서버 확인은 요청을 다시 보내지 않습니다."}</p>
      {mine.map((pointer) => <div className={styles.row} key={pointer.commandId}>
        <span><strong>{label(pointer.command)}</strong>{pointer.eventId
          ? pointer.eventId === currentEventId ? ` · ${currentEventName || "현재 행사"}` : ` · 행사 (${pointer.eventId.slice(-6)})`
          : " · 운영사"}</span>
        <span className={styles.actions}>
          <ProductButton type="button" className="button button-secondary" disabled={Boolean(checking) || snapshot.changed} onClick={() => void check(pointer)}>{checking === pointer.commandId ? "확인 중…" : "서버 처리 확인"}</ProductButton>
          <ProductButton type="button" className="button button-secondary" disabled={Boolean(checking)} onClick={() => setRemoveCandidate(pointer)}>목록에서 지우기</ProductButton>
        </span>
      </div>)}
    </> : null}
    {visibleMessage ? <p role="status">{visibleMessage.text}{visibleMessage.href ? <> <a href={visibleMessage.href}>티켓 확인 필요 명단 보기</a></> : null}</p> : null}
    {visibleTicketRecovery ? <div className={styles.ticketRecovery}>
      <p><strong>{visibleTicketRecovery.name}</strong>{visibleTicketRecovery.company ? ` · ${visibleTicketRecovery.company}` : ""}{visibleTicketRecovery.maskedPhone ? ` · ${visibleTicketRecovery.maskedPhone}` : ""}</p>
      <ProductButton type="button" className="button button-secondary" onClick={() => setOpenTicketRecovery(visibleTicketRecovery)}>발급된 링크 확인</ProductButton>
    </div> : null}
    {visibleCancellationReview ? <div className={styles.ticketRecovery}>
      <p>확인 당시 <strong>{visibleCancellationReview.reviewedName}</strong>{visibleCancellationReview.reviewedCompany ? ` · ${visibleCancellationReview.reviewedCompany}` : ""} · {visibleCancellationReview.reviewedMaskedPhone}</p>
      {visibleCancellationReview.name !== visibleCancellationReview.reviewedName || visibleCancellationReview.company !== visibleCancellationReview.reviewedCompany || visibleCancellationReview.maskedPhone !== visibleCancellationReview.reviewedMaskedPhone ? <p>현재 {visibleCancellationReview.name}{visibleCancellationReview.company ? ` · ${visibleCancellationReview.company}` : ""}{visibleCancellationReview.maskedPhone ? ` · ${visibleCancellationReview.maskedPhone}` : ""}</p> : null}
      <p>조회 시 신청 상태 {({ APPROVED: "참가 확정", PENDING: "승인 대기", WAITLIST: "대기 명단", CANCELLED: "신청 취소" } as Record<string, string>)[visibleCancellationReview.currentStatus] || "확인 필요"} · 티켓 {({ valid: "유효", revoked: "무효", expired: "만료", cancelled: "취소" } as Record<string, string>)[visibleCancellationReview.currentTicketReview] || "확인 필요"}</p>
      <span className={styles.actions}><a href={`/console/events/${encodeURIComponent(visibleCancellationReview.pointer.eventId!)}/participants`}>참가자 명단 보기</a>
        <ProductButton type="button" className="button button-secondary" onClick={() => {
          const pointer = visibleCancellationReview.pointer;
          if (!forgetOperatorReceipt(pointer.commandId, pointer)) {
            setMessage({ userId: pointer.userId, organizationId: pointer.organizationId, text: "확인 목록을 정리하지 못했습니다. 브라우저 저장 상태를 확인하세요." }); return;
          }
          acknowledgeOperatorReceipt(pointer.commandId);
          setCancellationReviewRecovery(null);
          setMessage({ userId: pointer.userId, organizationId: pointer.organizationId, text: "확인 내용을 정리했습니다. 필요한 경우 참가자 명단에서 새 티켓을 발급해 전달하세요." });
        }}>확인 완료</ProductButton></span>
    </div> : null}
    {activeTicketRecovery ? <TicketReissue
      key={activeTicketRecovery.pointer.commandId}
      eventId={activeTicketRecovery.pointer.eventId!}
      slug={activeTicketRecovery.eventSlug}
      person={{ id: activeTicketRecovery.participantId, name: activeTicketRecovery.name, ticketRevision: activeTicketRecovery.expectedTicketRevision }}
      resumeCommandId={activeTicketRecovery.pointer.commandId}
      onClose={() => setOpenTicketRecovery(null)}
      onIssued={() => {
        setTicketRecovery(null);
        setMessage({ userId: activeTicketRecovery.pointer.userId, organizationId: activeTicketRecovery.pointer.organizationId, text: "발급된 링크를 확인했습니다. 참가자에게 전달해 주세요." });
        window.dispatchEvent(new Event("eventouch:shell-reload"));
      }}
      onRefresh={async () => {
        try {
          const result = await operatorFetch(`/api/events/${encodeURIComponent(activeTicketRecovery.pointer.eventId!)}/bootstrap`, { cache: "no-store" });
          if (!result.ok) return false;
          const value: unknown = await result.json().catch(() => null);
          const state = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).state : null;
          const root = state && typeof state === "object" && !Array.isArray(state) ? state as Record<string, unknown> : null;
          const workspaces = root?.workspaces && typeof root.workspaces === "object" && !Array.isArray(root.workspaces) ? root.workspaces as Record<string, unknown> : null;
          const workspace = workspaces?.[activeTicketRecovery.pointer.eventId!];
          if (!workspace || typeof workspace !== "object" || Array.isArray(workspace) || !Array.isArray((workspace as Record<string, unknown>).participants)) return false;
          router.push(`/console/events/${encodeURIComponent(activeTicketRecovery.pointer.eventId!)}/participants`);
          return true;
        } catch { return false; }
      }}
    /> : null}
    {removeCandidate && context?.userId === removeCandidate.userId && context.organizationId === removeCandidate.organizationId ? <ConsoleDialog
      title="처리 결과 확인에서 지우기"
      description={`${label(removeCandidate.command)} 요청은 다른 창에서 처리 중이거나 이미 반영됐을 수 있습니다. 목록에서 지워도 서버 처리는 취소되지 않습니다. 원래 업무의 내역을 확인했나요?`}
      onClose={() => setRemoveCandidate(null)}
      footer={<><ProductButton type="button" className="button button-secondary" onClick={() => setRemoveCandidate(null)}>계속 확인</ProductButton><ProductButton type="button" className="button button-primary" onClick={() => {
        const removed = forgetOperatorReceipt(removeCandidate.commandId, removeCandidate);
        setMessage({ userId: removeCandidate.userId, organizationId: removeCandidate.organizationId, text: removed
          ? operatorReceiptSharingAvailable() ? "목록에서 지웠습니다. 서버 처리는 취소되지 않았습니다." : "현재 창의 목록에서만 지웠습니다. 다른 창의 내역은 확인해 주세요. 서버 처리는 취소되지 않았습니다."
          : "목록에서 지우지 못했습니다. 브라우저 저장 상태와 현재 계정, 처리 내역을 다시 확인하세요." });
        setRemoveCandidate(null);
      }}>목록에서 지우기</ProductButton></>}
    ><p>다른 창에서 아직 요청을 처리 중이라면, 결과가 확인되지 않았을 때 이 항목이 다시 나타날 수 있습니다.</p></ConsoleDialog> : null}
  </section>;
}
