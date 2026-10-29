"use client";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ensureOperatorContext, getOperatorContextSnapshot, isOrganizationContextBlock, listUncertainAttempts, operatorFetch, refreshOperatorContext, replayUncertainAttempt } from "../lib/operator-context";
import { useOperatorContextSnapshot } from "../lib/use-operator-context";
import { getOrganizationSelectionSnapshot, organizationSelectionDestination, selectOrganization, subscribeOrganizationSelection } from "../lib/organization-selection";
import { UNCONFIRMED_WRITE_CLOSE_MESSAGE, useConsoleDraftGuard, useConsoleDraftGuardAvailable } from "./console/console-draft-guard";
import styles from "./organization-switcher.module.css";

type Organization = { id: string; name: string; role: string };
type OrganizationsState = { kind: "loading" } | { kind: "failed"; message: string; loginRequired?: boolean } |
  { kind: "ready"; organizations: Organization[]; activeOrganizationId: string | null; contextVersion: number };
const SERVER_SELECTION = { attempt: null, busy: false, uncertain: false, error: null, notice: null };
const commandId = () => crypto.randomUUID();
const roleLabel = (role: string) => role === "AGENCY" ? "조직 소유자" : role === "MANAGER" ? "조직 구성원" : role === "STAFF" ? "현장 스태프" : "역할 확인 필요";
const asRecord = (value: unknown): Record<string, unknown> | null => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
function useSelection() { return useSyncExternalStore(subscribeOrganizationSelection, getOrganizationSelectionSnapshot, () => SERVER_SELECTION); }

function SelectionStatus({ allowRetry = true }: { allowRetry?: boolean }) {
  const selection = useSelection();
  return <>
    {selection.attempt ? <p className={styles.help} role="status">전환 대상: <strong>{selection.attempt.organizationName}</strong>{selection.busy ? " · 확인 중…" : " · 결과 미확인"}</p> : null}
    {selection.error ? <p className={styles.error} role="alert">{selection.error}</p> : null}
    {selection.uncertain && allowRetry ? <button className="button button-secondary" type="button" disabled={selection.busy} onClick={() => void selectOrganization()}>같은 전환 요청 다시 확인</button> : null}
    {selection.notice ? <p className={styles.help} role="status">{selection.notice}</p> : null}
  </>;
}

export default function OrganizationSwitcher({ confirmLeave, suggestedOrganizationId }: {
  confirmLeave?: () => boolean;
  suggestedOrganizationId?: string;
}) {
  const id = useId();
  const context = useOperatorContextSnapshot();
  const selection = useSelection();
  const [state, setState] = useState<OrganizationsState>({ kind: "loading" });
  const [tick, setTick] = useState(0);
  const [selected, setSelected] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [createBusy, setCreateBusy] = useState(false);
  const [createUnknown, setCreateUnknown] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createNotice, setCreateNotice] = useState<string | null>(null);
  const createAttempt = useRef<{ name: string; commandId: string } | null>(null);
  const createGate = useRef(false);
  const exitApproved = useRef(false);
  const consoleGuardAvailable = useConsoleDraftGuardAvailable();
  const formDirty = createOpen && name.trim() !== "";
  useEffect(() => { void ensureOperatorContext().catch(() => {}); }, []);
  useConsoleDraftGuard(formDirty || createUnknown || selection.attempt !== null,
    createUnknown || selection.attempt ? UNCONFIRMED_WRITE_CLOSE_MESSAGE : undefined);
  useEffect(() => {
    if (!formDirty && !createUnknown) return;
    exitApproved.current = false;
    const approveExit = () => { exitApproved.current = true; };
    const warn = (event: BeforeUnloadEvent) => { if (exitApproved.current) return; event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    window.addEventListener("eventouch:organization-confirmed-exit", approveExit);
    return () => { window.removeEventListener("beforeunload", warn); window.removeEventListener("eventouch:organization-confirmed-exit", approveExit); };
  }, [formDirty, createUnknown]);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    setState({ kind: "loading" });
    void (async () => {
      try {
        const response = await operatorFetch("/api/auth/organizations", { cache: "no-store", signal: controller.signal });
        const data = asRecord(await response.json().catch(() => null));
        if (cancelled) return;
        if (!response.ok || !Array.isArray(data?.organizations)) {
          setState({ kind: "failed", loginRequired: response.status === 401, message: response.status === 401 ? "로그인이 필요합니다. 로그인한 뒤 소속을 확인하세요." : "운영사 소속을 불러오지 못했습니다. 다시 확인하세요." });
          return;
        }
        if (typeof data.contextVersion !== "number" || !Number.isSafeInteger(data.contextVersion) || data.contextVersion < 0) {
          setState({ kind: "failed", message: "전환에 필요한 접속 정보를 확인하지 못했습니다. 소속을 다시 확인하세요." });
          return;
        }
        const organizations = data.organizations.flatMap((value) => {
          const item = asRecord(value);
          return typeof item?.id === "string" && typeof item.name === "string" && typeof item.role === "string"
            ? [{ id: item.id, name: item.name, role: item.role }] : [];
        });
        setState({ kind: "ready", organizations, activeOrganizationId: typeof data.activeOrganizationId === "string" ? data.activeOrganizationId : null,
          contextVersion: data.contextVersion });
        setSelected((current) => organizations.some((item) => item.id === current) ? current
          : organizations.some((item) => item.id === suggestedOrganizationId) ? suggestedOrganizationId!
          : organizations.some((item) => item.id === context.context?.organizationId) ? context.context!.organizationId : "");
        const pinned = getOperatorContextSnapshot().context;
        if (pinned && (data.activeOrganizationId !== pinned.organizationId || data.contextVersion !== pinned.contextVersion)) {
          void refreshOperatorContext();
        }
      } catch {
        if (!cancelled) setState({ kind: "failed", message: "운영사 소속을 확인하지 못했습니다. 연결을 확인하고 다시 시도하세요." });
      } finally { window.clearTimeout(timeout); }
    })();
    return () => { cancelled = true; window.clearTimeout(timeout); controller.abort(); };
  // A restored view keeps its chosen form; only explicit reload/add refreshes membership.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tick, suggestedOrganizationId, context.context?.contextVersion, context.changed, context.observed?.contextVersion]);

  const pending = selection.busy || selection.uncertain || createBusy || createUnknown;
  const blockedWrites = context.inFlightWrites > 0 || context.uncertainWrites > 0;
  async function switchNow() {
    const live = getOperatorContextSnapshot();
    if (pending || live.inFlightWrites > 0 || live.uncertainWrites > 0 || state.kind !== "ready") return;
    const target = state.organizations.find((item) => item.id === selected);
    if (!target || (target.id === live.context?.organizationId && !live.changed)) return;
    const restoring = target.id === live.context?.organizationId;
    const roleTransition = restoring && target.role !== live.context?.role;
    if ((!restoring || roleTransition) && confirmLeave && !confirmLeave()) return;
    if ((!restoring || roleTransition) && formDirty && !consoleGuardAvailable && !window.confirm("작성 중인 운영사 이름이 사라집니다. 이동할까요?")) return;
    if (roleTransition && !window.confirm(`${target.name}에서 역할이 ${roleLabel(target.role)}로 바뀌었습니다. 현재 입력을 떠나 변경된 역할의 홈으로 이동할까요?`)) return;
    await selectOrganization({ organizationId: target.id, organizationName: target.name, commandId: commandId(),
      mode: restoring ? "restore" : "switch", expectedContextVersion: state.contextVersion });
  }

  async function createOrganization(event: React.FormEvent) {
    event.preventDefault();
    if (createGate.current || createBusy || context.changed || context.context?.role !== "AGENCY") return;
    const attempt = createAttempt.current ?? { name: name.trim(), commandId: commandId() };
    const wasUncertain = createUnknown;
    if (!attempt.name) return;
    createAttempt.current = attempt;
    createGate.current = true;
    setCreateBusy(true); setCreateError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await operatorFetch("/api/auth/organizations", { method: "POST", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify(attempt) });
      const data = asRecord(await response.json().catch(() => null));
      const organization = asRecord(data?.organization);
      if (!response.ok || typeof organization?.id !== "string") {
        const contextChanged = response.status === 409 && data?.code === "ORGANIZATION_CONTEXT_CHANGED";
        const uncertain = response.status >= 500 || response.status === 408 || response.ok || (contextChanged && wasUncertain);
        setCreateUnknown(uncertain);
        if (!uncertain) createAttempt.current = null;
        setCreateError(uncertain ? "등록 결과를 확인하지 못했습니다. 원래 운영사에 다시 연결한 뒤 같은 요청으로 확인하세요." : contextChanged ? "운영사 문맥이 바뀌어 등록하지 않았습니다. 소속을 다시 확인하세요." : "운영사를 추가할 권한 또는 이름을 확인하세요.");
        return;
      }
      createAttempt.current = null;
      setCreateUnknown(false); setCreateOpen(false); setName("");
      setSelected(organization.id); setTick((value) => value + 1);
      setCreateNotice("운영사를 추가했습니다. 새 운영사는 발송 미연동 상태입니다. 전환 버튼을 눌러 명시적으로 이동하세요.");
    } catch (error) {
      if (isOrganizationContextBlock(error) && !wasUncertain) {
        createAttempt.current = null;
        setCreateUnknown(false);
        setCreateError("운영사 문맥이 바뀌어 등록을 보내지 않았습니다. 소속을 다시 확인하세요.");
      } else {
        setCreateUnknown(true);
        setCreateError("등록 결과를 확인하지 못했습니다. 원래 운영사에 다시 연결한 뒤 같은 요청으로 확인하세요.");
      }
    } finally { createGate.current = false; setCreateBusy(false); window.clearTimeout(timeout); }
  }

  return <section className={styles.switcher} aria-label="운영사 선택">
    <p className={styles.current}><span>현재 작업 운영사</span><strong>{context.context?.organizationName || (context.loading ? "확인 중" : "선택 필요")}</strong>
      {context.context ? <span>{roleLabel(context.context.role)}</span> : null}</p>
    {state.kind === "loading" ? <p className={styles.help} role="status">소속 운영사를 확인하고 있습니다.</p> : null}
    {state.kind === "failed" ? <><p className={styles.error} role="alert">{state.message}</p>{state.loginRequired ? <a href="/login">로그인으로</a> : null}</> : null}
    {context.error && context.error !== "조직을 선택하세요" && state.kind !== "failed" ? <p className={styles.error} role="alert">{context.error}</p> : null}
    {state.kind === "ready" && !state.organizations.length ? <p className={styles.help} role="status">활성 운영사 소속이 없습니다. 초대한 운영사 담당자에게 소속 상태를 확인하세요.</p> : null}
    {state.kind === "ready" && (state.organizations.length > 1 || (!state.activeOrganizationId && state.organizations.length > 0)) ? <div className={styles.controls}>
      <label htmlFor={`${id}-organization`}>전환할 운영사</label>
      <select id={`${id}-organization`} value={selected} disabled={pending || blockedWrites} onChange={(event) => setSelected(event.target.value)}>
        <option value="">선택하세요</option>{state.organizations.map((organization) => <option key={organization.id} value={organization.id}>{organization.name} · {roleLabel(organization.role)}</option>)}
      </select>
      <button type="button" className="button button-secondary" disabled={pending || blockedWrites || !selected || (selected === context.context?.organizationId && !context.changed)} onClick={() => void switchNow()}>이 운영사로 이동</button>
      {blockedWrites ? <p className={styles.help}>진행 중이거나 결과를 확인하지 못한 작업이 있습니다. 원래 운영사에서 결과를 확인한 뒤 전환하세요.</p> : <p className={styles.help}>운영사마다 역할과 자료가 다릅니다. 이동하면 현재 선택과 화면은 초기화됩니다.</p>}
    </div> : null}
    {!context.changed ? <SelectionStatus /> : <p className={styles.help}>운영사 문맥이 바뀌었습니다. 본문의 문맥 안내 또는 소속 목록에서 계속할 운영사를 명시적으로 선택하세요.</p>}
    {state.kind !== "loading" ? <button type="button" className="button button-secondary" disabled={pending} onClick={() => { setTick((value) => value + 1); void refreshOperatorContext(); }}>소속 다시 확인</button> : null}
    {createNotice ? <p className={styles.help} role="status">{createNotice}</p> : null}
    {context.context?.role === "AGENCY" && !context.changed ? <div className={styles.create}>
      {!createOpen ? <button type="button" className="button button-secondary" disabled={pending || blockedWrites} onClick={() => setCreateOpen(true)}>운영사 추가</button> : <form onSubmit={(event) => void createOrganization(event)}>
        <label htmlFor={`${id}-org-name`}>새 운영사 이름</label>
        <input id={`${id}-org-name`} value={name} onChange={(event) => setName(event.target.value)} disabled={createBusy || createUnknown} maxLength={80} autoComplete="organization" required />
        <p className={styles.help}>다른 운영사의 자료·발송 설정을 가져오지 않습니다. 새 운영사는 발송 미연동 상태로 시작합니다.</p>
        {createError ? <p className={styles.error} role="alert">{createError}</p> : null}
        <div className={styles.actions}><button type="submit" className="button button-primary" disabled={createBusy || !name.trim()}>{createBusy ? "등록 중…" : createUnknown ? "같은 등록 요청 다시 확인" : "운영사 등록"}</button>
          <button type="button" className="button button-secondary" disabled={createBusy || createUnknown} onClick={() => { if (formDirty && !window.confirm("작성한 운영사 이름을 버릴까요?")) return; setCreateOpen(false); setName(""); createAttempt.current = null; }}>취소</button></div>
      </form>}
    </div> : null}
  </section>;
}

type UncertainReceiptView = { key: string; organizationName: string; organizationId: string; commandLabel: string; replayable: boolean };
function uncertainCommandLabel(command: string | null, path: string): string {
  switch (command) {
    case "notice.save": return "공지 저장";
    case "notice.delete": return "공지 삭제";
    case "venue.save": return "장소 저장";
    case "program.save": return "프로그램 저장";
    case "program.delete": return "프로그램 삭제";
    case "draw.run": return "추첨 실행";
    case "draw.publish": return "추첨 게시";
    case "message.create": return "메시지 발송";
    case "message.retry": return "메시지 재시도";
    case "message.cancel": return "메시지 취소";
    case "message.sync": return "메시지 동기화";
    case "template.save": return "템플릿 저장";
    case "participant.import": return "명단 가져오기";
    case "participant.status": return "참가자 상태 변경";
    case "participant.create": return "참가자 등록";
    case "participant.update": return "참가자 수정";
    case "group.assign": return "그룹 지정";
    case "group.save": return "그룹 저장";
    case "event.update": return "행사 정보 변경";
    case "event.features": return "행사 기능 변경";
    case "event.stage": return "진행 단계 변경";
    case "form.publish": return "접수 게시";
    case "form.close": return "접수 마감";
    case "field.save": return "입력 항목 저장";
    case "evidence.photo.add": return "증빙 사진 등록";
    case "report.create": return "보고서 만들기";
    case "report.publish": return "보고서 게시";
    case "reward.create": return "경품 등록";
    case "reward.assign": return "경품 지정";
    case "reward.fulfill": return "경품 지급";
    case "reward.cancel": return "경품 취소";
    case "desk.save": return "데스크 저장";
    case "staff.assign": return "스태프 배정";
    case "staff.unassign": return "스태프 배정 해제";
    case "check.scan": return "체크인 스캔";
    case "check.correct": return "체크인 정정";
    case "booth.save": return "부스 저장";
    case "booth.map.save": return "부스 지도 저장";
    case "booth.map.publish": return "부스 지도 게시";
    case "display.set": return "전광판 출력 변경";
    case "draw.program.save": return "추첨 프로그램 저장";
    default: break;
  }
  if (path.indexOf("/invitations") >= 0) return "초대 관련 요청";
  if (path.indexOf("/members") >= 0) return "권한 변경";
  if (path.indexOf("/auth/organizations") >= 0 && path.indexOf("/members") < 0) return "운영사 등록";
  if (path.indexOf("/files") >= 0) return "파일 업로드";
  if (path.indexOf("/commands") >= 0) return "저장 요청";
  return "미확인 요청";
}

export function OrganizationContextNotice({ confirmLeave }: { confirmLeave?: () => boolean }) {
  const context = useOperatorContextSnapshot();
  const selection = useSelection();
  const [checkingRestore, setCheckingRestore] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const restoreGate = useRef(false);
  const [checkingRole, setCheckingRole] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);
  const roleGate = useRef(false);
  const [checkingKeys, setCheckingKeys] = useState<string[]>([]);
  const [checkResults, setCheckResults] = useState<Record<string, string>>({});
  const checkingRef = useRef<Set<string>>(new Set());
  // Resolved receipt summaries persist OUTSIDE the pending list: once an
  // entry settles it leaves the pending map, but its generic confirmation
  // (operation label + HTTP status only — never key, body, payload, or
  // token) stays until an explicit exit unmounts this notice. A key that
  // becomes uncertain again hides its old summary via the render filter.
  const [resolvedSummaries, setResolvedSummaries] = useState<Record<string, { label: string; text: string }>>({});
  const uncertainList = context.context
    ? listUncertainAttempts().filter((item) => item.organizationId === context.context?.organizationId).map((item) => ({
        key: item.key,
        organizationName: item.organizationName || context.context?.organizationId || item.organizationId,
        commandLabel: uncertainCommandLabel(item.command, item.path),
        replayable: item.replayable,
      }))
    : [];

  const original = context.context;
  const observed = context.observed;
  const roleChanged = Boolean(original && observed && original.organizationId === observed.organizationId && original.role !== observed.role);
  const busy = selection.busy || context.inFlightWrites > 0 || checkingRestore || checkingRole;
  const canGoNew = Boolean(observed && original && observed.organizationId !== original.organizationId);
  const hasPendingSameOrg = uncertainList.length > 0;
  async function restore() {
    if (!original || busy || selection.uncertain || restoreGate.current) return;
    const pendingSameOrg = listUncertainAttempts().some((item) => item.organizationId === original.organizationId);
    if (roleChanged && !pendingSameOrg) {
      // No receipts to protect: the explicit fresh-role check owns the move
      // home (actual org + role named, CAS never bypassed). Never navigate
      // off a preGET membership list here.
      await recheckRole();
      return;
    }
    restoreGate.current = true;
    setCheckingRestore(true); setRestoreError(null);
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 8000);
    try {
      const response = await operatorFetch("/api/auth/organizations", { cache: "no-store", signal: controller.signal });
      const data = asRecord(await response.json().catch(() => null));
      if (!response.ok || typeof data?.contextVersion !== "number" || !Array.isArray(data.organizations)) {
        setRestoreError("현재 소속과 접속 정보를 확인하지 못했습니다. 다시 확인하세요.");
        return;
      }
      const membership = data.organizations.map(asRecord).find((value) => value?.id === original.organizationId);
      if (!membership) {
        setRestoreError("이 운영사의 활성 소속이 없습니다. 계정 메뉴에서 다른 소속을 명시적으로 선택하세요.");
        return;
      }
      if (membership.role !== original.role) {
        // Changed role with receipts still unresolved: renew via the
        // CAS-guarded select below, which STOPS (keeps the mounted view,
        // its drafts, and the lock). This button never exits while
        // anything is pending.
        if (confirmLeave && !confirmLeave()) return;
        if (!window.confirm(`${original.organizationName}에서 역할이 ${roleLabel(String(membership.role))}로 바뀌었습니다. 미확인 요청을 같은 요청으로 먼저 확인해야 하며, 복구해도 현재 화면은 유지되고 이동하지 않습니다. 계속할까요?`)) return;
      }
      await selectOrganization({ organizationId: original.organizationId, organizationName: original.organizationName,
        commandId: commandId(), mode: "restore", expectedContextVersion: data.contextVersion });
      // STOPS here by the selection contract (same-org renew keeps the
      // workspace mounted and locked). The explicit move home goes through
      // '현재 역할 다시 확인', never a preGET-list navigation.
    } catch { setRestoreError("소속에 연결하지 못했습니다. 입력은 유지했습니다. 다시 확인하세요."); }
    finally { restoreGate.current = false; setCheckingRestore(false); window.clearTimeout(timeout); }
  }
  async function checkUncertain(key: string) {
    if (checkingRef.current.has(key) || busy) return;
    const target = uncertainList.find((item) => item.key === key);
    const label = target ? `${target.organizationName} · ${target.commandLabel}` : "미확인 요청";
    checkingRef.current.add(key);
    setCheckingKeys([...checkingRef.current]);
    setCheckResults((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
    try {
      const result = await replayUncertainAttempt(key);
      if (result.settled) {
        const text = result.status === 200
          ? "서버 응답을 받았습니다(HTTP 200)"
          : `서버 응답을 확인했습니다(HTTP ${result.status ?? "?"}). 미확인 목록에서 제외합니다.`;
        setCheckResults((prev) => {
          if (!(key in prev)) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
        setResolvedSummaries((prev) => ({ ...prev, [key]: { label, text } }));
      } else {
        setCheckResults((prev) => ({ ...prev, [key]: "응답을 확인하지 못했습니다. 나중에 같은 요청으로 다시 확인하세요." }));
      }
    } catch (error) {
      setCheckResults((prev) => ({
        ...prev,
        [key]: isOrganizationContextBlock(error) ? "조직을 확인하고 같은 요청으로 다시 확인하세요." : "연결을 확인하고 다시 시도하세요.",
      }));
    } finally {
      checkingRef.current.delete(key);
      setCheckingKeys([...checkingRef.current]);
    }
  }
  // Explicit fresh-me role check, outside the locked workspace. The check
  // itself never replays a receipt; on a verified selected org + known
  // role it first rebinds the session to the freshly confirmed membership
  // (same explicit action, same org, receipted select) and only then moves
  // natively to the ACTUAL role home (never a guessed or requested role).
  // Without the rebind, own-membership changes since the pin leave the
  // stored session binding stale and every guarded read on the destination
  // home 409s it locked on arrival. A verified unselected identity
  // (user.id + null org + null role) opens the explicit picker; malformed
  // 200s, unknown roles, and any other 403/503/ambiguity report truthfully
  // with no exit and no replay. Blocked while any pinned receipt is
  // unresolved.
  async function recheckRole() {
    if (!original || checkingRole || roleGate.current || busy || selection.uncertain) return;
    if (context.inFlightWrites > 0 || context.uncertainWrites > 0) return;
    roleGate.current = true;
    setCheckingRole(true);
    setRoleError(null);
    try {
      const response = await operatorFetch("/api/auth/me", { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 403) {
          const data = asRecord(await response.clone().json().catch(() => null));
          const code = typeof data?.code === "string" ? data.code
            : typeof data?.errorCode === "string" ? data.errorCode
            : typeof asRecord(data?.error)?.code === "string" ? String(asRecord(data?.error)?.code) : null;
          const identity = asRecord(data?.user);
          if (code === "NO_ORGANIZATION_MEMBERSHIP" && identity && typeof identity.id === "string" && identity.id !== "") {
            if (confirmLeave && !confirmLeave()) return;
            window.dispatchEvent(new Event("eventouch:organization-confirmed-exit"));
            window.location.assign("/console?chooseOrganization=1");
            return;
          }
        }
        setRoleError(`현재 역할을 확인하지 못했습니다(HTTP ${response.status}). 연결을 확인하고 다시 시도하세요.`);
        return;
      }
      const data = asRecord(await response.json().catch(() => null));
      const user = asRecord(data?.user);
      const userId = typeof user?.id === "string" && user.id !== "" ? user.id : null;
      const actualRole = typeof user?.role === "string" ? user.role : null;
      const actualOrg = typeof user?.organizationId === "string" && user.organizationId !== "" ? user.organizationId : null;
      const actualOrgName =
        typeof user?.organizationName === "string" && user.organizationName !== "" ? user.organizationName : actualOrg;
      if (userId && actualOrg && (actualRole === "AGENCY" || actualRole === "MANAGER" || actualRole === "STAFF")) {
        if (confirmLeave && !confirmLeave()) return;
        // Name the ACTUAL fresh target (a third tab may have selected an
        // org that differs from this banner): never silently change it.
        if (!window.confirm(`현재 소속은 ${actualOrgName}(${actualOrg}) · ${roleLabel(actualRole)}입니다. 현재 입력을 떠나 역할의 홈으로 이동할까요?`)) return;
        // Rebind the session to the freshly confirmed membership BEFORE
        // leaving: own-membership changes since the pin make the stored
        // session binding stale, and without a rebind every guarded read
        // on the destination home 409s and locks it on arrival. Same
        // explicit user action, same org, receipted select — no new scope.
        const freshSessionRev = typeof user?.contextVersion === "number" && Number.isSafeInteger(user.contextVersion) && user.contextVersion >= 0
          ? user.contextVersion : null;
        if (freshSessionRev === null) {
          setRoleError("현재 접속 정보를 확인하지 못했습니다. 소속을 다시 확인하세요.");
          return;
        }
        let rebound = false;
        try {
          const rebindRes = await operatorFetch("/api/auth/organizations/select", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ organizationId: actualOrg, commandId: commandId(), expectedContextVersion: freshSessionRev }),
          });
          const rebindData = asRecord(await rebindRes.json().catch(() => null));
          const rebindUser = asRecord(rebindData?.user);
          rebound = rebindRes.ok && rebindUser?.organizationId === actualOrg;
        } catch {
          rebound = false;
        }
        if (!rebound) {
          setRoleError("현재 소속으로 이동하기 전에 접속 정보를 다시 묶지 못했습니다. 소속을 다시 확인한 뒤 이동하세요.");
          return;
        }
        window.dispatchEvent(new Event("eventouch:organization-confirmed-exit"));
        window.location.assign(organizationSelectionDestination(actualRole, window.location.search));
        return;
      }
      if (userId && !actualOrg && !actualRole) {
        // Authenticated but truly unselected (verified identity, null org
        // and null role): the explicit picker owns recovery. Anything else
        // — unreadable or malformed 200, unknown role — reports truthfully
        // below instead of a picker that implies an unproven session state.
        if (confirmLeave && !confirmLeave()) return;
        window.dispatchEvent(new Event("eventouch:organization-confirmed-exit"));
        window.location.assign("/console?chooseOrganization=1");
        return;
      }
      setRoleError("현재 역할을 확인하지 못했습니다(HTTP 200). 연결을 확인하고 다시 시도하세요.");
      return;
    } catch {
      setRoleError("현재 역할에 연결하지 못했습니다. 입력은 유지했습니다. 다시 확인하세요.");
    } finally {
      roleGate.current = false;
      setCheckingRole(false);
    }
  }
  function goToObserved() {
    if (!canGoNew || !observed || busy || selection.uncertain || context.uncertainWrites > 0) return;
    if (confirmLeave && !confirmLeave()) return;
    if (!window.confirm(`${observed.organizationName}의 ${roleLabel(observed.role)} 홈으로 이동합니다. 현재 화면의 입력과 미확인 요청은 버려집니다. 이동할까요?`)) return;
    // Revalidate the named destination through the same selection contract;
    // a newer third-tab switch must not land the user in an unnamed org.
    void selectOrganization({ organizationId: observed.organizationId, organizationName: observed.organizationName,
      commandId: commandId(), mode: "switch", expectedContextVersion: observed.contextVersion });
  }
  // All hooks above run unconditionally. Past this point the warning region
  // renders ONLY while drifted: a recovered view shows plain selection
  // status (retry/notice) with no false context alarm, and a fully clean
  // view renders nothing at all.
  if (!context.changed) {
    if (!selection.attempt && !selection.uncertain && !selection.error && !selection.notice) return null;
    return <div className={styles.plain}><SelectionStatus /></div>;
  }
  return <section className={styles.notice} role="region" aria-label="운영사 문맥 변경">
    <h2>운영사 문맥이 바뀌었습니다</h2>
    <p>이 화면의 작업 운영사: <strong>{original?.organizationName || "확인 필요"}</strong>. 입력과 미확인 요청은 그대로 두고 쓰기를 잠갔습니다.</p>
    <p>{roleChanged ? `이 운영사의 역할이 ${roleLabel(observed!.role)}로 바뀌었습니다. 변경된 역할의 홈에서 계속해야 합니다.` : observed && observed.organizationId !== original?.organizationId ? `다른 탭에서 선택한 운영사: ${observed.organizationName}.` : "현재 소속과 접속 상태를 다시 확인하세요."} 원래 운영사의 요청을 다른 운영사로 보내지 않습니다.</p>
    <div className={styles.actions}>
      {original && !selection.attempt ? <button type="button" className="button button-secondary" disabled={busy} onClick={() => void restore()}>{checkingRestore ? "소속 확인 중…" : roleChanged ? (hasPendingSameOrg ? "미확인 요청 복구 연결" : "변경된 역할의 홈으로 이동") : `${original.organizationName}에 다시 연결`}</button> : null}
      {canGoNew ? <button type="button" className="button button-secondary" disabled={busy || selection.uncertain || context.uncertainWrites > 0} onClick={goToObserved}>{observed?.organizationName}의 홈으로 이동</button> : null}
      <button type="button" className="button button-secondary" disabled={busy || selection.uncertain || context.inFlightWrites > 0 || context.uncertainWrites > 0 || !original} onClick={() => void recheckRole()}>{checkingRole ? "현재 역할 확인 중…" : "현재 역할 다시 확인"}</button>
      <button type="button" className="button button-secondary" disabled={busy} onClick={() => void refreshOperatorContext()}>문맥 다시 확인</button>
    </div>
    {roleError ? <p className={styles.error} role="alert">{roleError}</p> : null}
    {context.uncertainWrites > 0 ? <p className={styles.help}>결과 미확인 작업이 있습니다. 위의 복구 버튼으로 같은 요청으로 결과를 확인하세요. 복구해도 현재 화면은 유지되며 이동하지 않습니다.</p> : null}
    {uncertainList.length > 0 ? <div className={styles.controls}>
      <p className={styles.help} role="status">미확인 요청 {uncertainList.length}건: 원래 운영사의 같은 요청으로 결과를 확인합니다. 새로운 저장은 보내지 않습니다.</p>
      {uncertainList.map((item) => {
        const checking = checkingKeys.includes(item.key);
        return <div key={item.key} className={styles.actions}>
          <span className={styles.help}>{item.organizationName} · {item.commandLabel}</span>
          {item.replayable ? (
            <button type="button" className="button button-secondary" disabled={busy || checking} onClick={() => void checkUncertain(item.key)}>{checking ? "결과 확인 중…" : "같은 요청으로 결과 확인"}</button>
          ) : (
            <span className={styles.help} role="note">재전송할 요청 본문이 없어 같은 요청으로 확인할 수 없습니다. 원래 화면의 입력과 영수증을 확인하세요.</span>
          )}
          {checkResults[item.key] ? <span className={styles.help} role="status">{checkResults[item.key]}</span> : null}
        </div>;
      })}
    </div> : null}
    {Object.entries(resolvedSummaries).filter(([resolvedKey]) => !uncertainList.some((item) => item.key === resolvedKey)).map(([resolvedKey, summary]) => (
      <p key={resolvedKey} className={styles.help} role="status">확인됨 · {summary.label}: {summary.text}</p>
    ))}
    <SelectionStatus />
    {restoreError ? <p className={styles.error} role="alert">{restoreError}</p> : null}
    {context.error ? <p className={styles.error} role="alert">{context.error}</p> : null}
  </section>;
}
