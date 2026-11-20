"use client";
import ProductButton from "../../../../../ui/ProductButton";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../../auth-redirect";
import { parsePublishedRegisterFields } from "../../../../../event/[slug]/register/register-data";
import ValidatedForm from "../../../../../ui/ValidatedForm";
import ConsolePage from "../../../../console-ui/ConsolePage";
import ConsoleSection from "../../../../console-ui/ConsoleSection";
import ConsoleFeedback from "../../../../console-ui/ConsoleFeedback";
import ConsoleConfirm from "../../../../console-ui/ConsoleConfirm";
import ConsoleChoiceGroup from "../../../../console-ui/ConsoleChoiceGroup";
import { ArrowDownIcon, ArrowUpIcon, PlusIcon } from "../../../../console-ui/ConsoleIcons";
import FieldsPhonePreview, { type PreviewSheet } from "./FieldsPhonePreview";
import ConsoleStatePanel from "../../../../console-ui/ConsoleStatePanel";
import ListRow, { ListRowOpen } from "../../../../console-ui/ListRow";
import StatusPill from "../../../../console-ui/StatusPill";
import ProductLink from "../../../../../ui/ProductLink";
import { useConsoleDraftGuard } from "../../../../console-draft-guard";
import { consoleFetch } from "../../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../../lib/event-capabilities";
import { normalizeHomeImage, normalizeHomeStyle } from "../../../../../../lib/attendee-home";
import { readPublicEventContext } from "../../../../../../lib/public-event-context";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsFieldCommand, isOrganizationContextBlock } from "../../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../../lib/use-event-receipts";
import { useOperatorContextSnapshot } from "../../../../../../lib/use-operator-context";
import styles from "./fields.module.css";

type Field = { id: string; label: string; type: string; required: boolean; options: string[] };
type Draft = { id: string; label: string; type: string; required: boolean; optionsText: string; existing: boolean };
type Ready = { kind: "ready"; name: string; fields: Field[]; publishedFields: Field[] | null; formVersion: number; publishedVersion: number; archived: boolean; canWrite: boolean; sheet: PreviewSheet };
type State = { kind: "loading" } | { kind: "failed"; message: string } | Ready;
type Attempt = { eventId: string; command: "field.save" | "field.move" | "field.delete"; commandId: string; payload: Record<string, unknown> };
const COMMANDS = new Set(["field.save", "field.move", "field.delete", "form.publish"]);
const LABELS: Record<Attempt["command"], string> = { "field.save": "신청 항목 저장", "field.move": "항목 순서 변경", "field.delete": "신청 항목 제외" };
const TYPE_LABELS: Record<string, string> = { text: "짧은 답변", email: "이메일", select: "하나 선택", checkbox: "체크" };
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function str(value: unknown): string { return typeof value === "string" ? value : ""; }
function fieldsFrom(value: unknown): Field[] {
  return Array.isArray(value) ? value.flatMap((item) => {
    const field = record(item);
    if (!field || typeof field.id !== "string" || !field.id) return [];
    return [{ id: field.id, label: str(field.label), type: str(field.type), required: field.required === true,
      options: Array.isArray(field.options) ? field.options.filter((option): option is string => typeof option === "string") : [] }];
  }) : [];
}
// The banner, facts and notices the registration sheet wears, read the way the
// public page reads them (published design only), so the preview matches it.
function sheetFrom(eventId: string, event: Record<string, unknown>, workspace: Record<string, unknown>): PreviewSheet {
  const published = record(record(workspace.pageExperience)?.published) ?? {};
  const keyvisual = normalizeHomeImage(Object.hasOwn(published, "keyvisual") ? published.keyvisual : record(workspace.branding)?.keyvisual);
  return {
    theme: {
      homeStyle: normalizeHomeStyle(published.homeStyle),
      keyvisual: keyvisual?.fileId ? `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(keyvisual.fileId)}` : keyvisual?.data || null,
      defaultHomeBanner: workspace.defaultHomeBanner === "neutral" ? "neutral" : "legacy",
    },
    context: readPublicEventContext(event, workspace),
    verificationRequired: workspace.verificationRequired === true,
    approvalRequired: workspace.approvalRequired === true,
    consentText: str(workspace.consentText),
    consentVersion: Number(workspace.consentVersion) || 1,
  };
}
function newId(): string { return `field-${typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.floor(Math.random() * 1e9)}`}`; }
function commandId(): string { return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; }
function toDraft(field: Field): Draft { return { ...field, optionsText: field.options.join("\n"), existing: true }; }

export default function FieldsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [draft, setDraft] = useState<Draft | null>(null);
  const initialDraftRef = useRef("");
  const [pending, setPending] = useState<Attempt | null>(null);
  const pendingRef = useRef<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlightRef = useRef<symbol | null>(null);
  const activeIdRef = useRef(eventId); activeIdRef.current = eventId;
  const loadedIdRef = useRef<string | null>(null);
  const sentIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [cancelDraft, setCancelDraft] = useState(false);
  const [abandon, setAbandon] = useState(false);
  const [refreshingOther, setRefreshingOther] = useState(false);
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [conflict, setConflict] = useState(false);
  const hadOtherRef = useRef(false);
  const focusOriginRef = useRef<Element | null>(null);
  const receipts = useEventReceipts(eventId);
  const operator = useOperatorContextSnapshot();
  const otherReceipt = receipts.some((item) => COMMANDS.has(item.command) && item.commandId !== pending?.commandId && item.commandId !== sentIdRef.current);
  const locked = busy || Boolean(pending) || otherReceipt || refreshingOther || needsRefresh || (hadOtherRef.current && !otherReceipt);
  const writeLocked = locked || conflict;
  const dirty = Boolean(draft && JSON.stringify(draft) !== initialDraftRef.current);
  useConsoleDraftGuard(dirty || Boolean(pending) || busy, pending || busy ? "신청 항목의 처리 결과가 확인되지 않았습니다. 화면을 떠나면 같은 입력을 다시 보낼 수 없습니다." : "작성 중인 신청 항목이 있습니다.");
  useEffect(() => pending && state.kind === "ready" ? manageOperatorReceipt(pending.commandId) : undefined, [pending, state.kind]);
  useEffect(() => {
    if (!pending) return;
    const frame = requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== focusOriginRef.current && active.isConnected) return;
      const node = document.getElementById("field-recovery-heading"); node?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior }); node?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [pending?.commandId]);

  async function load(silent = false): Promise<boolean> {
    const selectedEvent = eventId;
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([consoleFetch("/api/auth/me", { cache: "no-store" }), consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" })]);
      if (activeIdRef.current !== selectedEvent) return false;
      if (meRes.status === 401 || bootRes.status === 401) {
        if (silent) { setError("최신 항목을 불러오지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요."); return false; }
        router.push(loginHrefForLocation(window.location.pathname, window.location.search)); return false;
      }
      const me = record(record(await meRes.json().catch(() => null))?.user);
      const bootstrap = record(record(await bootRes.json().catch(() => null))?.state);
      if (activeIdRef.current !== selectedEvent) return false;
      const event = Array.isArray(bootstrap?.events) ? bootstrap.events.map(record).find((item) => item?.id === eventId) : null;
      const workspace = record(record(bootstrap?.workspaces)?.[eventId]);
      if (!meRes.ok || !bootRes.ok || !me || !bootstrap || !event || !workspace) {
        if (silent) setError("최신 항목을 불러오지 못했습니다. 연결과 행사 접근 권한을 확인하세요.");
        else setState({ kind: "failed", message: "신청 항목을 불러오지 못했습니다." });
        return false;
      }
      const fields = fieldsFrom(workspace.fields);
      const publishedFields = parsePublishedRegisterFields(workspace.publishedFields, "workspace");
      const memberships = Array.isArray(bootstrap.memberships) ? bootstrap.memberships.flatMap((value) => {
        const row = record(value); return row && typeof row.accountId === "string" && typeof row.eventId === "string" ? [{ accountId: row.accountId, eventId: row.eventId, write: row.write }] : [];
      }) : [];
      loadedIdRef.current = selectedEvent;
      setState({ kind: "ready", name: str(event.name) || eventId, fields, publishedFields, formVersion: Number(workspace.formVersion) || 0,
        publishedVersion: Number(workspace.publishedVersion) || 0, archived: str(event.stage).toUpperCase() === "ARCHIVED",
        canWrite: canWriteEvent({ role: me.role, userId: me.id, memberships, eventId }, "field.save"), sheet: sheetFrom(eventId, event, workspace) });
      return true;
    } catch {
      if (activeIdRef.current !== selectedEvent) return false;
      if (silent) setError("최신 항목을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
      else setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    }
  }
  useEffect(() => { pendingRef.current = null; setPending(null); setDraft(null); setError(null); setNotice(null); setDeleteId(null); setRefreshingOther(false); setNeedsRefresh(false); setConflict(false); hadOtherRef.current = false; loadedIdRef.current = null; sentIdRef.current = null; inFlightRef.current = null; setBusy(false); void load(); }, [eventId]);
  useEffect(() => {
    if (hadOtherRef.current && !otherReceipt && !pending) {
      const selectedEvent = eventId; setRefreshingOther(true); setNeedsRefresh(true);
      void load(true).then((ok) => { if (activeIdRef.current === selectedEvent && ok) setNeedsRefresh(false); }).finally(() => { if (activeIdRef.current === selectedEvent) setRefreshingOther(false); });
    }
    hadOtherRef.current = otherReceipt;
  }, [otherReceipt, pending]);

  function finish(attempt: Attempt, checked: boolean) {
    acknowledgeOperatorReceipt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
    pendingRef.current = null; sentIdRef.current = null; setPending(null); setError(null); setAbandon(false); setDeleteId(null); setConflict(false);
    if (attempt.command === "field.save" || attempt.command === "field.delete") { setDraft(null); initialDraftRef.current = ""; }
    setNotice(checked ? "서버 처리를 확인했습니다. 최신 신청 항목을 불러왔습니다." : "신청 항목을 저장했습니다. 참가자에게 적용하려면 양식을 게시하세요.");
  }
  async function execute(attempt: Attempt, retry: boolean) {
    if (inFlightRef.current || operator.changed || attempt.eventId !== activeIdRef.current || state.kind !== "ready" || !state.canWrite || state.archived || otherReceipt || (pendingRef.current && pendingRef.current.commandId !== attempt.commandId)) return;
    const uncertainBefore = retry && pendingRef.current?.commandId === attempt.commandId;
    const mark = () => { pendingRef.current = attempt; setPending(attempt); setError("처리 결과를 확인하지 못했습니다. 서버 확인 또는 같은 요청 다시 시도를 선택하세요."); };
    const token = Symbol("field-write"); inFlightRef.current = token; sentIdRef.current = attempt.commandId; setBusy(true); setError(null); setNotice(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/commands`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ commandId: attempt.commandId, command: attempt.command, payload: attempt.payload }) });
      const body = record(await response.json().catch(() => null));
      if (activeIdRef.current !== attempt.eventId) return;
      if (!response.ok) {
        const uncertain = uncertainBefore || response.status >= 500 || [408, 425, 429].includes(response.status);
        if (uncertain) { mark(); return; }
        sentIdRef.current = null;
        setError(str(body?.error) || "신청 항목을 저장하지 못했습니다.");
        if (response.status === 409 && body?.field === "expectedFormVersion") {
          setConflict(true);
          if (!await load(true)) setNeedsRefresh(true);
        }
        return;
      }
      if (!confirmsFieldCommand(attempt.command, attempt.payload, body)) { mark(); return; }
      pendingRef.current = attempt;
      if (!await load(true) || activeIdRef.current !== attempt.eventId) { setPending(attempt); return; }
      finish(attempt, false);
    } catch (failure) {
      if (activeIdRef.current !== attempt.eventId) return;
      if (!uncertainBefore && isOrganizationContextBlock(failure)) { sentIdRef.current = null; setError("현재 조직을 확인한 뒤 다시 시도하세요. 요청은 보내지 않았습니다."); }
      else mark();
    } finally { if (inFlightRef.current === token) inFlightRef.current = null; if (activeIdRef.current === attempt.eventId) setBusy(false); }
  }
  async function check() {
    const attempt = pendingRef.current;
    if (!attempt || inFlightRef.current || operator.changed) return;
    const token = Symbol("field-check"); inFlightRef.current = token; setBusy(true); setError(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const body = record(await response.json().catch(() => null));
      if (activeIdRef.current !== attempt.eventId) return;
      if (response.ok && body?.status === "APPLIED" && body.command === attempt.command) {
        if (await load(true)) finish(attempt, true);
      } else setError(response.ok && body?.status === "UNCONFIRMED" ? "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요." : "서버 처리 결과를 확인하지 못했습니다. 접근 권한과 연결을 확인하세요.");
    } catch { if (activeIdRef.current === attempt.eventId) setError("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다."); }
    finally { if (inFlightRef.current === token) inFlightRef.current = null; if (activeIdRef.current === attempt.eventId) setBusy(false); }
  }
  function start(d: Draft) { if (writeLocked) return; setDraft(d); initialDraftRef.current = JSON.stringify(d); setError(null); setNotice(null); requestAnimationFrame(() => document.getElementById("field-label")?.focus()); }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || state.kind !== "ready" || writeLocked || !state.canWrite || state.archived) return;
    if (draft.existing && !state.fields.some((field) => field.id === draft.id)) { setError("이 항목이 다른 작업에서 제외됐습니다. 취소한 뒤 새 항목으로 추가하세요."); return; }
    const label = draft.label.trim(); const options = draft.optionsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    if (!label) { setError("항목 이름을 입력하세요."); document.getElementById("field-label")?.focus(); return; }
    if (draft.type === "select" && (options.length < 2 || options.length > 30 || new Set(options).size !== options.length || options.some((item) => item.length > 200))) { setError("선택지는 중복 없이 2~30개, 한 줄에 하나씩 입력하세요."); document.getElementById("field-options")?.focus(); return; }
    const payload = { id: draft.id, label, type: draft.type, required: ["name", "phone"].includes(draft.id) || draft.required,
      options: draft.type === "select" ? options : [], expectedFormVersion: state.formVersion, protectExistingAnswers: true };
    focusOriginRef.current = document.activeElement;
    void execute({ eventId, command: "field.save", commandId: commandId(), payload }, false);
  }
  function reorder(id: string, delta: number) {
    if (state.kind !== "ready" || writeLocked || !state.canWrite || state.archived) return;
    const order = state.fields.map((field) => field.id); const index = order.indexOf(id); const destination = index + delta;
    if (index < 0 || destination < 0 || destination >= order.length) return;
    [order[index], order[destination]] = [order[destination], order[index]];
    focusOriginRef.current = document.activeElement;
    void execute({ eventId, command: "field.move", commandId: commandId(), payload: { id, delta, expectedOrder: order, expectedFormVersion: state.formVersion } }, false);
  }
  function remove(id: string) {
    if (state.kind !== "ready" || writeLocked || !state.canWrite || state.archived) return;
    const expectedOrder = state.fields.filter((field) => field.id !== id).map((field) => field.id);
    focusOriginRef.current = document.activeElement;
    setDeleteId(null);
    void execute({ eventId, command: "field.delete", commandId: commandId(), payload: { id, expectedOrder, expectedFormVersion: state.formVersion } }, false);
  }
  if (state.kind === "loading" || (state.kind === "ready" && loadedIdRef.current !== eventId)) return <ConsolePage pageId="settings" title="신청 항목" eventId={eventId}><ConsoleStatePanel kind="loading" message="신청 항목을 불러오고 있습니다." onRetry={() => void load()} /></ConsolePage>;
  if (state.kind === "failed") return <ConsolePage pageId="settings" title="신청 항목" eventId={eventId}><ConsoleStatePanel kind="failed" message={state.message} onRetry={() => void load()} /></ConsolePage>;
  const writable = state.canWrite && !state.archived;
  const latestField = draft?.existing ? state.fields.find((field) => field.id === draft.id) : null;
  const draftPreviewFields = !draft ? state.fields : (() => {
    const edited = { id: draft.id, label: draft.label, type: draft.type,
      required: ["name", "phone"].includes(draft.id) || draft.required,
      options: draft.optionsText.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) };
    return draft.existing
      ? state.fields.map((field) => field.id === draft.id ? edited : field)
      : [...state.fields, edited];
  })();
  return <ConsolePage pageId="settings" title="신청 항목" parentContext={{ href: `/console/events/${encodeURIComponent(eventId)}/settings#settings-intake`, label: "행사 설정 · 참가 접수" }} eventId={eventId} eventName={state.name} headerActions={<ProductLink variant="ghost" href={`/console/events/${encodeURIComponent(eventId)}/settings#settings-intake`}>참가 접수로</ProductLink>} feedback={<>
    {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
    {error && !pending ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
    {!writable ? <ConsoleFeedback kind="warning">{state.archived ? "보관된 행사는 읽기 전용입니다." : "신청 항목을 바꾸려면 참가자 쓰기 권한이 필요합니다."}</ConsoleFeedback> : null}
    {otherReceipt && !pending ? <ConsoleFeedback kind="warning">이전 신청 항목 또는 양식 게시의 처리 결과를 화면 위에서 먼저 확인하세요.</ConsoleFeedback> : null}
    {refreshingOther ? <ConsoleFeedback kind="info">최신 신청 항목을 불러오고 있습니다.</ConsoleFeedback> : null}
    {needsRefresh && !refreshingOther ? <ConsoleFeedback kind="warning">최신 신청 항목을 불러온 뒤 변경할 수 있습니다. <ProductButton type="button" className="button button-secondary" onClick={() => { setRefreshingOther(true); void load(true).then((ok) => { if (ok) setNeedsRefresh(false); }).finally(() => setRefreshingOther(false)); }}>다시 불러오기</ProductButton></ConsoleFeedback> : null}
  </>}>
    <ConsoleSection headingId="application-fields-heading" title="항목 관리" heading="rule">
      <p className={styles.help}>항목 변경은 초안에 저장됩니다. 참가 신청 화면에는 참가 접수에서 양식을 게시한 뒤 적용됩니다. 초안 {state.formVersion} · 게시 {state.publishedVersion || "없음"}</p>
      <p className={styles.help}>이름과 연락처는 필수입니다. 항목을 제외해도 기존 답변은 즉시 삭제되지 않지만 새 양식과 내보내기에서는 빠질 수 있습니다.</p>
      {conflict ? <section className={styles.recovery} aria-labelledby="field-conflict-heading">
        <h3 id="field-conflict-heading" className={styles.editorTitle}>신청 항목이 변경됐습니다</h3>
        <p>다른 작업에서 양식이 바뀌었습니다. 입력한 내용은 유지했습니다. 최신 목록을 확인한 뒤 다시 저장하세요.</p>
        {draft?.existing ? <p>{latestField ? `현재 서버 항목: ${latestField.label} · ${TYPE_LABELS[latestField.type] || latestField.type} · ${latestField.required ? "필수" : "선택"}${latestField.type === "select" ? ` · ${latestField.options.join(", ")}` : ""}` : "이 항목이 최신 양식에서 제외됐습니다. 입력을 확인한 뒤 취소하고 새 항목으로 추가하세요."}</p> : null}
        <nav className={styles.actions} aria-label="최신 변경 작업"><ProductButton type="button" className="button button-secondary" disabled={locked} onClick={() => { setConflict(false); setError(null); }}>최신 변경 확인</ProductButton></nav>
      </section> : null}
      {pending ? <section className={styles.recovery} aria-labelledby="field-recovery-heading">
        <h3 id="field-recovery-heading" tabIndex={-1} className={styles.editorTitle}>신청 항목 처리 확인 필요</h3>
        <p>{LABELS[pending.command]} 요청이 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</p>
        {error ? <p role="alert">{error}</p> : null}
        <nav className={styles.actions} aria-label="처리 결과 작업">
          <ProductButton type="button" className="button button-secondary" disabled={busy || operator.changed || abandon} onClick={() => void check()}>서버 처리 확인</ProductButton>
          <ProductButton type="button" className="button button-secondary" disabled={busy || operator.changed || abandon || !writable} onClick={() => void execute(pending, true)}>같은 요청 다시 시도</ProductButton>
          <ProductButton type="button" className="button button-secondary" disabled={busy || abandon} onClick={() => setAbandon(true)}>확인 전 그만두기</ProductButton>
        </nav>
        {abandon ? <ConsoleConfirm summary="이미 반영된 항목 변경은 취소되지 않습니다. 확인을 그만두고 최신 항목을 확인할까요?" confirmLabel="확인 그만두기" onConfirm={() => {
          const attempt = pendingRef.current; if (!attempt) return;
          abandonOperatorAttempt(attempt.commandId); forgetOperatorReceipt(attempt.commandId); pendingRef.current = null; sentIdRef.current = null; setPending(null); setAbandon(false);
          setError("이전 변경이 반영됐을 수 있습니다. 최신 항목을 확인한 뒤 다시 진행하세요."); setRefreshingOther(true); setNeedsRefresh(true);
          void load(true).then((ok) => { if (activeIdRef.current === attempt.eventId && ok) setNeedsRefresh(false); }).finally(() => { if (activeIdRef.current === attempt.eventId) setRefreshingOther(false); });
        }} onCancel={() => setAbandon(false)} /> : null}
      </section> : null}
      <p className={styles.stateLine} role="status"><StatusPill tone={state.formVersion > state.publishedVersion ? "wait" : "ok"} dot>{state.formVersion > state.publishedVersion ? (state.publishedVersion ? "게시 안 된 변경 있음" : "아직 게시 전") : "게시된 양식과 같음"}</StatusPill></p>
      <section className={styles.split} aria-label="신청 항목 편집">
        <section className={styles.listColumn} aria-label="신청 항목 초안">
          <header className={styles.listHead}>
            <p className={styles.count}>항목 {state.fields.length}개</p>
            <nav className={styles.actions} aria-label="신청 항목 추가">
              {!state.fields.some((field) => field.id === "company") ? <ProductButton type="button" variant="ghost" disabled={!writable || writeLocked || Boolean(draft)} onClick={() => start({ id: "company", label: "소속", type: "text", required: false, optionsText: "", existing: false })}>소속 항목 다시 추가</ProductButton> : null}
              <ProductButton type="button" variant="primary" icon={<PlusIcon />} disabled={!writable || writeLocked || Boolean(draft)} onClick={() => start({ id: newId(), label: "", type: "text", required: false, optionsText: "", existing: false })}>항목 추가</ProductButton>
            </nav>
          </header>
          <ul className={styles.list}>
            {state.fields.map((field, index) => <ListRow as="li" cover className={draft?.existing && draft.id === field.id ? styles.rowSelected : undefined} key={field.id}
              title={<ListRowOpen aria-label={`${field.label} 수정`} disabled={!writable || writeLocked || Boolean(draft) || !Object.hasOwn(TYPE_LABELS, field.type)} onClick={() => start(toDraft(field))}>{field.label || "이름 없는 항목"}</ListRowOpen>}
              meta={<>{TYPE_LABELS[field.type] || "지원하지 않는 형식"}{["name", "phone"].includes(field.id) ? " · 고정 항목" : ""}{field.type === "select" ? ` · 선택지 ${field.options.length}개` : ""}</>}
              trailing={<>
                <StatusPill tone={field.required ? "ink" : "neutral"} size="sm">{field.required ? "필수" : "선택"}</StatusPill>
                <nav className={styles.move} aria-label={`${field.label} 순서 변경`}>
                  <ProductButton type="button" variant="ghost" size="sm" aria-label={`${field.label} 위로 이동`} disabled={!writable || writeLocked || Boolean(draft) || index === 0} onClick={() => reorder(field.id, -1)}><ArrowUpIcon /></ProductButton>
                  <ProductButton type="button" variant="ghost" size="sm" aria-label={`${field.label} 아래로 이동`} disabled={!writable || writeLocked || Boolean(draft) || index === state.fields.length - 1} onClick={() => reorder(field.id, 1)}><ArrowDownIcon /></ProductButton>
                </nav>
              </>} />)}
          </ul>
          {draft ? <ValidatedForm className={styles.editor} onSubmit={submit}>
            <h3 className={styles.editorTitle}>{draft.existing ? "항목 수정" : "새 항목"}</h3>
            <label className={styles.field}>항목 이름<input id="field-label" maxLength={60} required value={draft.label} disabled={locked || !writable} onChange={(event) => setDraft({ ...draft, label: event.target.value })} /></label>
            <ConsoleChoiceGroup id="field-type" label="입력 방식" value={draft.type} disabled={locked || !writable || ["name", "phone", "company"].includes(draft.id)} onChange={(type) => setDraft({ ...draft, type })}
              options={[{ value: "text", label: "짧은 답변" }, { value: "email", label: "이메일" }, { value: "select", label: "하나 선택" }, { value: "checkbox", label: "체크" }]} hint={draft.existing ? "기존 답변이 있는 항목의 입력 방식은 바꿀 수 없습니다." : undefined} />
            {draft.type === "select" ? <div className={styles.field}>
              <label htmlFor="field-options">선택지 · 한 줄에 하나씩</label>
              <textarea id="field-options" aria-describedby="field-options-help" rows={4} value={draft.optionsText} disabled={locked || !writable} onChange={(event) => setDraft({ ...draft, optionsText: event.target.value })} />
              <p id="field-options-help" className={styles.help}>기존 답변에 사용된 선택지는 삭제할 수 없습니다.</p>
            </div> : null}
            <label className={styles.check}><input type="checkbox" checked={["name", "phone"].includes(draft.id) || draft.required} disabled={locked || !writable || ["name", "phone"].includes(draft.id)} onChange={(event) => setDraft({ ...draft, required: event.target.checked })} />필수 입력</label>
            <p className={styles.help}>필수로 바꾸면 이전 참가자의 정보 수정에도 영향을 줄 수 있습니다.</p>
            <footer className={styles.editorActions}>
              {draft.existing && !["name", "phone"].includes(draft.id) ? <ProductButton type="button" variant="destructive" disabled={writeLocked || !writable} onClick={() => setDeleteId(draft.id)}>이 항목 제외</ProductButton> : <p className={styles.actionSpacer} aria-hidden="true" />}
              <nav className={styles.actions} aria-label="항목 편집 작업"><ProductButton type="button" variant="ghost" disabled={locked} onClick={() => { if (dirty) setCancelDraft(true); else { setDraft(null); setConflict(false); } }}>취소</ProductButton><ProductButton type="submit" variant="primary" disabled={writeLocked || !writable}>항목 저장</ProductButton></nav>
            </footer>
            {cancelDraft ? <ConsoleConfirm summary="작성 중인 항목 내용이 사라집니다. 취소할까요?" confirmLabel="작성 취소" onConfirm={() => { setDraft(null); setCancelDraft(false); setError(null); setConflict(false); }} onCancel={() => setCancelDraft(false)} /> : null}
          </ValidatedForm> : null}
          {deleteId ? <ConsoleConfirm summary={`“${state.fields.find((field) => field.id === deleteId)?.label || "선택 항목"}”을 초안에서 제외할까요? 기존 답변은 바로 삭제되지 않으며 게시 후 신청 화면과 내보내기에서 빠질 수 있습니다.`} confirmLabel="항목 제외" busy={busy} onConfirm={() => remove(deleteId)} onCancel={() => setDeleteId(null)} /> : null}
        </section>
        <FieldsPhonePreview eventName={state.name} activeId={draft?.id ?? null}
          publishedFields={state.publishedFields} draftFields={draftPreviewFields}
          publishedVersion={state.publishedVersion} draftVersion={state.formVersion} sheet={state.sheet} />
      </section>
    </ConsoleSection>
  </ConsolePage>;
}
