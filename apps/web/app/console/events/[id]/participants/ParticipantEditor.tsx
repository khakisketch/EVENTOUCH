"use client";
import ProductButton from "../../../../ui/ProductButton";
import CompanyField from "./CompanyField";
import { normalizeContactPhone } from "../../../../../lib/contact-normalize.cjs";

import { useEffect, useRef, useState } from "react";
import ValidatedForm from "../../../../ui/ValidatedForm";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import uiStyles from "../../../console-ui/console-ui.module.css";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import { consoleFetch } from "../../../../../lib/console-api";
import { acknowledgeOperatorReceipt, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useOperatorContextSnapshot } from "../../../../../lib/use-operator-context";
import styles from "./participants.module.css";

type Value = string | boolean;
type Field = { id: string; label: string; type: string; required: boolean; options: string[] };
type Snapshot = { formVersion: number; fields: Field[]; values: Values; rawAnswers: Record<string, Value> };
type Values = { name: string; phone: string; company: string; email: string; answers: Record<string, Value> };
type Attempt = { commandId: string; payload: Record<string, unknown> };
const string = (value: unknown) => typeof value === "string" ? value : "";
function record(value: unknown): Record<string, unknown> | null { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function id() { return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`; }
function normalized(values: Values): Values {
  return { ...values, name: values.name.trim(), phone: normalizeContactPhone(values.phone), company: values.company.trim(), email: values.email.trim(),
    answers: Object.fromEntries(Object.entries(values.answers).map(([key, value]) => [key, typeof value === "string" ? value.trim() : value])) };
}
function matches(values: Values, payload: Record<string, unknown>): boolean {
  const actual = normalized(values);
  for (const key of ["name", "phone", "company", "email"] as const) if (Object.hasOwn(payload, key) && payload[key] !== actual[key]) return false;
  const answers = record(payload.answers);
  return !answers || Object.entries(answers).every(([key, value]) => actual.answers[key] === value);
}

export default function ParticipantEditor({ eventId, participantId, onClose, onRefresh, companyCounts = new Map() }: {
  companyCounts?: Map<string, number>;
  eventId: string; participantId: string; onClose: () => void; onRefresh: () => Promise<boolean>;
}) {
  const [base, setBase] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState<Values | null>(null);
  const [latest, setLatest] = useState<Snapshot | null>(null);
  const [confirmMerge, setConfirmMerge] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const pendingRef = useRef<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState("");
  const [dismiss, setDismiss] = useState(false);
  const active = useRef(true);
  const operator = useOperatorContextSnapshot();
  const dirty = Boolean(base && draft && JSON.stringify(normalized(base.values)) !== JSON.stringify(normalized(draft)));
  useConsoleDraftGuard(dirty || Boolean(pending) || busy, pending || busy ? "참가자 수정 결과를 아직 확인하지 못했습니다." : "저장하지 않은 참가자 정보가 있습니다.");
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => pending ? manageOperatorReceipt(pending.commandId) : undefined, [pending]);

  async function read(): Promise<Snapshot> {
    const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" });
    const body = record(await response.json().catch(() => null));
    const workspace = record(record(record(body?.state)?.workspaces)?.[eventId]);
    const person = Array.isArray(workspace?.participants) ? workspace.participants.map(record).find((value) => value?.id === participantId) : null;
    if (!response.ok || !workspace || !person) throw new Error("참가자 정보를 불러오지 못했습니다. 행사 접근 권한과 연결을 확인하세요.");
    const raw: Record<string, Value> = Object.create(null);
    for (const [key, value] of Object.entries(record(person.answers) ?? {})) if (typeof value === "string" || typeof value === "boolean") raw[key] = value;
    const fields: Field[] = Array.isArray(workspace.fields) ? workspace.fields.flatMap((value): Field[] => {
      const field = record(value);
      if (!field || typeof field.id !== "string" || !field.id || ["name", "phone", "company"].includes(field.id) ||
          typeof field.type !== "string" || !["text", "email", "select", "checkbox"].includes(field.type)) return [];
      return [{ id: field.id, label: string(field.label) || "추가 항목", type: field.type, required: field.required === true,
        options: Array.isArray(field.options) ? field.options.filter((item): item is string => typeof item === "string") : [] }];
    }) : [];
    const answers: Record<string, Value> = Object.create(null);
    for (const field of fields) answers[field.id] = raw[field.id] ?? (field.type === "checkbox" ? false : "");
    return { formVersion: Number(workspace.formVersion) || 0, fields, rawAnswers: raw,
      values: { name: string(person.name), phone: string(person.phone), company: string(person.company), email: string(person.email), answers } };
  }
  useEffect(() => { void read().then((value) => { if (active.current) { setBase(value); setDraft(value.values); } }).catch((failure) => { if (active.current) setError(failure.message); }); }, [eventId, participantId]);

  function closeAllowed(): boolean {
    if (busyRef.current) return false;
    if (dirty || pending) { setDismiss(true); return false; }
    return true;
  }
  async function finish(attempt: Attempt) {
    // Keep the receipt until the visible roster has actually refreshed.
    if (!await onRefresh() || !active.current) {
      if (active.current) { pendingRef.current = attempt; setPending(attempt); setError("처리는 확인됐지만 참가자 목록을 갱신하지 못했습니다. 다시 확인하세요."); }
      return;
    }
    acknowledgeOperatorReceipt(attempt.commandId); forgetOperatorReceipt(attempt.commandId);
    pendingRef.current = null; setPending(null);
    onClose();
  }
  async function execute(attempt: Attempt, retry: boolean) {
    if (busyRef.current || operator.changed) return;
    busyRef.current = true; setBusy(true); setError("");
    const uncertainBefore = retry && pendingRef.current?.commandId === attempt.commandId;
    const mark = () => { pendingRef.current = attempt; setPending(attempt); setError("처리 결과를 확인하지 못했습니다. 서버 확인 또는 같은 요청 다시 시도를 선택하세요."); };
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, command: "participant.update", payload: attempt.payload }) });
      const body = record(await response.json().catch(() => null));
      if (!active.current) return;
      if (!response.ok) {
        if (uncertainBefore || response.status >= 500 || [408, 425, 429].includes(response.status)) { mark(); return; }
        setError(string(body?.error) || "참가자 정보를 저장하지 못했습니다.");
        if (response.status === 409 && ["expectedValues", "expectedFormVersion"].includes(string(body?.field))) setLatest(null);
        return;
      }
      const returned = record(body?.participant);
      if (!returned || returned.id !== participantId || ["name", "phone", "company", "email"].some((key) => Object.hasOwn(attempt.payload, key) && returned[key] !== attempt.payload[key])) { mark(); return; }
      pendingRef.current = attempt;
      const fresh = await read();
      if (!active.current) return;
      if (!matches(fresh.values, attempt.payload)) { mark(); setError("요청 뒤 참가자 정보가 다시 변경됐을 수 있습니다. 서버 처리부터 확인하세요."); return; }
      await finish(attempt);
    } catch (failure) {
      if (!active.current) return;
      if (!uncertainBefore && !pendingRef.current && isOrganizationContextBlock(failure)) setError("현재 조직을 확인한 뒤 다시 시도하세요. 요청은 보내지 않았습니다.");
      else mark();
    } finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  async function check() {
    const attempt = pendingRef.current; if (!attempt || busyRef.current || operator.changed) return;
    busyRef.current = true; setBusy(true); setError("");
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const body = record(await response.json().catch(() => null));
      if (!active.current) return;
      if (response.ok && body?.status === "APPLIED" && body.command === "participant.update") await finish(attempt);
      else setError(response.ok && body?.status === "UNCONFIRMED" ? "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요." : "서버 처리 결과를 확인하지 못했습니다. 접근 권한과 연결을 확인하세요.");
    } catch { if (active.current) setError("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다."); }
    finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  async function compareLatest() {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(true); setError("");
    try { const value = await read(); if (active.current) setLatest(value); }
    catch (failure) { if (active.current) setError(failure instanceof Error ? failure.message : "최신 정보를 불러오지 못했습니다."); }
    finally { busyRef.current = false; if (active.current) setBusy(false); }
  }
  function merge() {
    if (!base || !draft || !latest) return;
    const merged = { ...latest.values, answers: { ...latest.values.answers } };
    for (const key of ["name", "phone", "company", "email"] as const) if (normalized(draft)[key] !== normalized(base.values)[key]) merged[key] = draft[key];
    for (const field of latest.fields) if (draft.answers[field.id] !== base.values.answers[field.id] && Object.hasOwn(draft.answers, field.id)) merged.answers[field.id] = draft.answers[field.id];
    setBase(latest); setDraft(merged); setLatest(null); setConfirmMerge(false); setError("");
  }
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!base || !draft || busyRef.current || pending || operator.changed) return;
    const values = normalized(draft); const original = normalized(base.values);
    const payload: Record<string, unknown> = { id: participantId, expectedFormVersion: base.formVersion };
    const expected: Record<string, unknown> = {};
    for (const key of ["name", "phone", "company", "email"] as const) if (values[key] !== original[key]) { payload[key] = values[key]; expected[key] = original[key]; }
    const answers: Record<string, Value> = Object.create(null); const expectedAnswers: Record<string, Value | null> = Object.create(null);
    for (const field of base.fields) if (values.answers[field.id] !== original.answers[field.id]) {
      answers[field.id] = values.answers[field.id]; expectedAnswers[field.id] = base.rawAnswers[field.id] ?? null;
    }
    if (Object.keys(answers).length) { payload.answers = answers; expected.answers = expectedAnswers; }
    if (!Object.keys(expected).length) { setError("변경된 내용이 없습니다."); return; }
    // A legacy form may also have an answer named email. The server uses the
    // direct email first; do not silently replace a different saved answer.
    if (Object.hasOwn(payload, "email") && base.fields.some((field) => field.id === "email") && values.answers.email !== values.email) {
      setError("기본 이메일과 신청 양식의 이메일 답변을 동일하게 맞춰 주세요."); return;
    }
    if (Object.hasOwn(payload, "email") && base.fields.some((field) => field.id === "email")) {
      answers.email = values.email; expectedAnswers.email = base.rawAnswers.email ?? null;
      payload.answers = answers; expected.answers = expectedAnswers;
    }
    payload.expectedValues = expected;
    void execute({ commandId: id(), payload }, false);
  }
  const removedEdits = base && draft && latest ? base.fields.filter((field) => {
    const current = latest.fields.find((item) => item.id === field.id);
    return (!current || current.type !== field.type) && draft.answers[field.id] !== base.values.answers[field.id];
  }) : [];
  const conflicts = base && draft && latest ? [
    ...(["name", "phone", "company", "email"] as const).filter((key) => normalized(draft)[key] !== normalized(base.values)[key] && normalized(latest.values)[key] !== normalized(base.values)[key]).map((key) => ({ name: { name: "이름", phone: "연락처", company: "소속", email: "이메일" }[key], value: latest.values[key] })),
    ...latest.fields.filter((field) => Object.hasOwn(base.values.answers, field.id) && draft.answers[field.id] !== base.values.answers[field.id] && latest.values.answers[field.id] !== base.values.answers[field.id])
      .map((field) => ({ name: field.label, value: String(latest.values.answers[field.id]) })),
  ] : [];
  return <ConsoleDialog title="참가자 정보 수정" description="기존 신청 정보와 추가 답변을 수정합니다." onClose={onClose} busy={busy} canClose={closeAllowed} wide footer={<ConsoleFormActions>
    <ProductButton type="button" className="button button-secondary" disabled={busy} onClick={() => { if (closeAllowed()) onClose(); }}>닫기</ProductButton>
    {!pending ? <ProductButton type="submit" form="participant-edit-form" className="button button-primary" disabled={!draft || busy || operator.changed}>저장</ProductButton> : null}
  </ConsoleFormActions>}>
    {error && !pending ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
    {!base && !error ? <p role="status">참가자 정보를 불러오고 있습니다.</p> : null}
    {!base && error ? <ProductButton type="button" className="button button-secondary" onClick={() => { setError(""); void read().then((value) => { if (active.current) { setBase(value); setDraft(value.values); } }).catch((failure) => { if (active.current) setError(failure.message); }); }}>다시 불러오기</ProductButton> : null}
    {pending ? <section aria-labelledby="participant-edit-recovery" className={styles.editRecovery}>
      <h3 id="participant-edit-recovery">참가자 수정 처리 확인 필요</h3><p>요청이 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className={styles.editActions}><ProductButton type="button" className="button button-secondary" disabled={busy || operator.changed} onClick={() => void check()}>서버 처리 확인</ProductButton>
      <ProductButton type="button" className="button button-secondary" disabled={busy || operator.changed} onClick={() => void execute(pending, true)}>같은 요청 다시 시도</ProductButton></div>
    </section> : null}
    {base && draft ? <ValidatedForm id="participant-edit-form" className={uiStyles.formStack} onSubmit={submit}>
      <fieldset className={`${uiStyles.formStack} ${styles.addFields}`} disabled={busy || Boolean(pending)}><legend className="sr-only">참가자 정보</legend>
      <div><label htmlFor="edit-name">이름</label><input id="edit-name" required maxLength={60} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></div>
      <div><label htmlFor="edit-phone">연락처</label><input id="edit-phone" type="tel" inputMode="numeric" required maxLength={20} value={draft.phone} onChange={(event) => setDraft({ ...draft, phone: event.target.value })} /><p>연락처를 바꾸면 기존 참가자 세션이 해제됩니다.</p></div>
      <div><label htmlFor="edit-company">소속</label><CompanyField id="edit-company" value={draft.company} counts={companyCounts} onChange={(company) => setDraft({ ...draft, company })} /></div>
      <div><label htmlFor="edit-email">이메일</label><input id="edit-email" type="email" maxLength={120} value={draft.email} onChange={(event) => setDraft({ ...draft, email: event.target.value })} /></div>
      {base.fields.map((field, index) => {
        const inputId = `edit-answer-${index}`; const value = draft.answers[field.id];
        const update = (next: Value) => setDraft({ ...draft, answers: { ...draft.answers, [field.id]: next } });
        return <div key={field.id}>
          {field.type === "checkbox" ? <label htmlFor={inputId}><input id={inputId} type="checkbox" checked={value === true} required={field.required} onChange={(event) => update(event.target.checked)} /> {field.label}{field.required ? " (필수)" : ""}</label> : <>
            <label htmlFor={inputId}>{field.label}{field.required ? " (필수)" : ""}</label>
            {field.type === "select" ? <select id={inputId} required={field.required} value={typeof value === "string" ? value : ""} onChange={(event) => update(event.target.value)}>
              <option value="">선택하세요</option>{typeof value === "string" && value && !field.options.includes(value) ? <option value={value} disabled>{value} (현재 선택지에 없음)</option> : null}
              {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
            </select> : <input id={inputId} type={field.type === "email" ? "email" : "text"} maxLength={4000} required={field.required} value={typeof value === "string" ? value : ""} onChange={(event) => update(event.target.value)} />}
          </>}
        </div>;
      })}</fieldset>
    </ValidatedForm> : null}
    {base && draft && error && !pending ? <ProductButton type="button" className="button button-secondary" disabled={busy} onClick={() => void compareLatest()}>최신 정보와 비교</ProductButton> : null}
    {latest ? <section className={styles.editRecovery} aria-labelledby="participant-edit-compare"><h3 id="participant-edit-compare">최신 정보 확인</h3>
      {conflicts.length ? <><p>다른 작업에서도 바뀐 항목입니다. 아래는 현재 서버 값이며, 입력 유지 시 작성한 값으로 덮어쓸 수 있습니다.</p><ul>{conflicts.map((item, index) => <li key={index}>{item.name}: {item.value || "비어 있음"}</li>)}</ul></> : <p>같은 항목을 수정한 다른 변경은 없습니다. 입력한 내용은 유지됩니다.</p>}
      {removedEdits.length ? <p role="alert">작성 중인 항목이 최신 양식에서 제외되었거나 입력 방식이 바뀌어 자동으로 합칠 수 없습니다: {removedEdits.map((field) => field.label).join(", ")}. 입력을 확인한 뒤 닫고 다시 열어 주세요.</p> : <ProductButton type="button" className="button button-secondary" onClick={() => setConfirmMerge(true)}>최신 기준으로 내 입력 유지</ProductButton>}
      {confirmMerge ? <ConsoleConfirm summary="최신 값을 기준으로 입력을 유지합니다. 같은 항목의 다른 변경은 다음 저장 시 덮어쓸 수 있습니다." confirmLabel="입력 유지" onConfirm={merge} onCancel={() => setConfirmMerge(false)} /> : null}
    </section> : null}
    {dismiss ? <ConsoleConfirm summary={pending ? "요청이 이미 반영됐을 수 있습니다. 닫은 뒤 화면의 처리 결과 확인에서 확인하세요. 입력 내용은 복원되지 않습니다." : "저장하지 않은 수정 내용이 사라집니다. 닫을까요?"} confirmLabel="닫기" onConfirm={onClose} onCancel={() => setDismiss(false)} /> : null}
  </ConsoleDialog>;
}
