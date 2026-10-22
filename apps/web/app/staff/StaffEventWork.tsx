"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import CameraScan from "../CameraScan";
import QRCode from "react-qr-code";
import { loginHrefForLocation } from "../auth-redirect";
import { buildStaffScopes, resolveStaffScopeId, type StaffScope } from "./staff-scope";
import prizeStyles from "./staff-event-work.module.css";

type DeskReward = { id: string; name: string; status: string; method: string };
type RewardParticipant = { id: string; name: string; company: string };

type ScanResult =
  | { kind: "idle" }
  | { kind: "ok"; participantId: string; name: string; action: string; reentry: boolean; booth?: string }
  | { kind: "failed"; message: string };

type Nametag = {
  name: string;
  company: string;
  eventName: string;
  deskName: string;
  action: string;
  at: string;
};

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function parseRewardList(value: unknown): DeskReward[] {
  return Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return [];
        const reward = item as Record<string, unknown>;
        if (typeof reward.id !== "string" || typeof reward.name !== "string") return [];
        return [{
          id: reward.id,
          name: reward.name,
          status: typeof reward.status === "string" ? reward.status : "",
          method: typeof reward.method === "string" ? reward.method : "",
        }];
      })
    : [];
}

// Recent checks read in queue order; a bare name is not enough to verify the
// last scan while a line is moving.
function formatCheckTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 확인 중";
  return new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit" }).format(date);
}

export default function StaffEventWork({ eventId }: { eventId: string }) {
  const router = useRouter();
  const targetEventId = resolveStaffScopeId(eventId);
  const pendingScanIdRef = useRef(new Map<string, string>());
  const scanBusyRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [scope, setScope] = useState<StaffScope | null>(null);
  const [missingAssignment, setMissingAssignment] = useState(false);
  const [task, setTask] = useState<"desk" | "booth">("desk");
  const [deskId, setDeskId] = useState("");
  const [boothId, setBoothId] = useState("");
  const [ticket, setTicket] = useState("");
  const [cameraOpen, setCameraOpen] = useState(false);
  const [kiosk, setKiosk] = useState(false);
  const [nametag, setNametag] = useState<Nametag | null>(null);
  const [result, setResult] = useState<ScanResult>({ kind: "idle" });
  const [correctReason, setCorrectReason] = useState("");
  const [correctNotice, setCorrectNotice] = useState<string | null>(null);
  const [boothCopyNotice, setBoothCopyNotice] = useState<string | null>(null);
  // Copy feedback for the ticket/booth code typed into the scan form. Kept
  // separate from the SELF-mode QR copy notice so each message stays next to
  // the button that produced it.
  const [ticketCopyNotice, setTicketCopyNotice] = useState<string | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [directory, setDirectory] = useState<Record<string, string>>({});
  const [rewardEnabled, setRewardEnabled] = useState(false);
  const [rewardTarget, setRewardTarget] = useState<RewardParticipant | null>(null);
  const [targetRewards, setTargetRewards] = useState<DeskReward[]>([]);
  const [rewardDataLoaded, setRewardDataLoaded] = useState(false);
  const [rewardLookupTicket, setRewardLookupTicket] = useState("");
  const [rewardLookupLoading, setRewardLookupLoading] = useState(false);
  // The last successfully scanned desk ticket, kept so the prize lookup can
  // replay it with one touch: an exit scan that missed its reward response
  // must not force the operator to retype the same ticket. Client memory
  // only; no new server field is involved.
  const [lastScannedTicket, setLastScannedTicket] = useState("");
  const [rewardCollectingId, setRewardCollectingId] = useState<string | null>(null);
  const [rewardError, setRewardError] = useState<string | null>(null);
  const [rewardNotice, setRewardNotice] = useState<string | null>(null);
  const pendingRewardCommandsRef = useRef(new Map<string, string>());
  const scopeRef = useRef<StaffScope | null>(null);
  const boothQrRef = useRef<HTMLDivElement | null>(null);
  const nametagSheetRef = useRef<HTMLElement | null>(null);
  // The primary next step after a successful scan, focused on success so
  // keyboard and screen-reader users land on the next action.
  const nextParticipantRef = useRef<HTMLButtonElement | null>(null);
  scopeRef.current = scope;

  function focusTicketField() {
    window.requestAnimationFrame(() => {
      const field = document.getElementById("staff-ticket");
      if (field instanceof HTMLInputElement) field.focus();
    });
  }

  // A success clears the just-processed input so the old value can never be
  // resent, and folds the scan input away: the result block next to it owns
  // the "다음 참가자" step. That step restores the input for the next person.
  function prepareNextParticipant() {
    setTicket("");
    setTicketCopyNotice(null);
    setResult({ kind: "idle" });
    focusTicketField();
  }

  // Client-side copy of the code typed into the scan form. Long ET:BOOTH
  // codes truncate inside the single-line input, so the full value stays
  // readable below the field and travels through the clipboard instead of
  // retyping. No server call: the code itself never changes.
  async function copyTicketCode() {
    const code = ticket.trim();
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setTicketCopyNotice("입력한 코드를 복사했습니다.");
    } catch {
      setTicketCopyNotice("복사에 실패했습니다. 코드 전체를 선택해 직접 복사하세요.");
    }
  }

  async function load(silent = false) {
    // A post-scan refresh must not unmount the result the operator just
    // read: only the first load takes over the screen.
    if (!silent) {
      setLoading(true);
      setMissingAssignment(false);
    }
    setLoadError(null);
    try {
      const res = await fetch("/api/bootstrap", { cache: "no-store" });
      if (res.status === 401) {
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return;
      }
      const data = (await res.json().catch(() => null)) as {
        state?: {
          events?: Array<{ id?: unknown; name?: unknown; features?: unknown }>;
          workspaces?: Record<string, {
            desks?: unknown;
            booths?: unknown;
            assignments?: unknown;
            checks?: unknown;
            stampMode?: unknown;
            participants?: unknown;
            rewards?: unknown;
          }>;
        } | null;
      } | null;
      const state = data?.state;
      if (!res.ok || !state) {
        setLoadError("업무 정보를 불러오지 못했습니다.");
        return;
      }
      const scopes = buildStaffScopes(
        Array.isArray(state.events) ? state.events : [],
        state.workspaces ?? {}
      );
      const next = scopes.find((item) => item.eventId === targetEventId) ?? null;
      if (!next) {
        // Assignment revoked, wrong event, or signed in as an operator
        // without desk work: stay on a stable explanation, never a loop.
        if (silent && scopeRef.current) {
          setLoadError("최신 업무를 불러오지 못했습니다. 표시된 내용이 오래되었을 수 있습니다.");
        } else {
          setScope(null);
          setMissingAssignment(true);
        }
        return;
      }
      setScope(next);
      setMissingAssignment(false);
      const eventRecord = Array.isArray(state.events)
        ? state.events.find((item) => item && item.id === targetEventId)
        : undefined;
      setRewardEnabled(Array.isArray(eventRecord?.features) && eventRecord.features.includes("reward"));
      // Name directory for nametags: the staff projection already carries
      // names and companies for desk work, so no extra read is needed.
      const directoryMap: Record<string, string> = {};
      const roster = state.workspaces?.[targetEventId]?.participants;
      if (Array.isArray(roster)) {
        for (const entry of roster) {
          if (typeof entry === "object" && entry !== null) {
            const person = entry as Record<string, unknown>;
            if (typeof person.id === "string" && person.id) {
              directoryMap[person.id] = typeof person.company === "string" ? person.company : "";
            }
          }
        }
      }
      setDirectory(directoryMap);
      if (!silent) {
        // A single assigned desk is not a choice. Keep its name and IN/OUT
        // explanation visible in the existing selector; never pick between
        // multiple desks or submit a scan on the staff member's behalf.
        setDeskId(next.desks.length === 1 ? next.desks[0].id : "");
        setBoothId("");
        setTask(next.desks.length ? "desk" : "booth");
        setResult({ kind: "idle" });
        setRewardTarget(null);
        setTargetRewards([]);
        setRewardLookupTicket("");
        setRewardError(null);
        setRewardNotice(null);
      }
      // A silent refresh keeps the operator's desk selection and the result
      // just read; only the scope data (recent checks) updates underneath.
    } catch {
      setLoadError("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      if (!silent) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    pendingScanIdRef.current.clear();
    pendingRewardCommandsRef.current.clear();
    setRewardTarget(null);
    setTargetRewards([]);
    setRewardDataLoaded(false);
    setRewardLookupTicket("");
    setLastScannedTicket("");
    setRewardError(null);
    setRewardNotice(null);
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetEventId]);

  useEffect(() => {
    if (!kiosk || loading) return;
    const input = document.getElementById("staff-ticket");
    if (input instanceof HTMLInputElement) input.focus();
  }, [kiosk, loading, task, deskId, boothId]);

  // Printing is a browser dialog, not a route: closing it via 인쇄하기's
  // print (or cancelling it) fires afterprint without touching the sheet's
  // 닫기 path, so the print-only body flag is lifted here too. The sheet
  // stays open so the operator can reprint or close deliberately.
  useEffect(() => {
    if (!nametag) return;
    const liftPrintFlag = () => {
      document.body.classList.remove("nametag-printing");
    };
    window.addEventListener("afterprint", liftPrintFlag);
    return () => {
      window.removeEventListener("afterprint", liftPrintFlag);
    };
  }, [nametag]);
  // The booth QR is shown to the participant, so it has to be fully on
  // screen: scroll it into view whenever a booth is picked.
  useEffect(() => {
    if (!boothId || task !== "booth") return;
    const node = boothQrRef.current;
    if (!node) return;
    node.scrollIntoView({ block: "center", behavior: "smooth" });
  }, [boothId, task]);

  // After a successful scan the next step is the "다음 참가자" button in the
  // result block, so focus moves there instead of staying on the folded
  // input. Failures keep focus where the retry happens.
  useEffect(() => {
    if (result.kind !== "ok") return;
    const node = nextParticipantRef.current;
    if (node) node.focus();
  }, [result]);

  if (loading) return <p className="loading-state" role="status">업무 정보를 불러오고 있습니다.</p>;
  if (missingAssignment || (!scope && loadError)) {
    return (
      <section className="staff-workspace state-panel">
        <p role="alert">{loadError ?? "이 행사에 대한 업무 배정이 없습니다. 운영자에게 문의하세요."}</p>
        <p>
          <button type="button" className="button button-secondary" onClick={() => load()}>
            다시 불러오기
          </button>{" "}
          <Link className="button button-secondary" href="/staff">
            내 업무로
          </Link>
        </p>
      </section>
    );
  }
  if (!scope) return <p className="loading-state">배정된 업무가 없습니다.</p>;

  function clearRewardPanel() {
    setRewardTarget(null);
    setTargetRewards([]);
    setRewardDataLoaded(false);
    setRewardError(null);
    setRewardNotice(null);
  }

  const activeScope: StaffScope = scope;
  const hasDeskWork = activeScope.desks.length > 0;
  const hasBoothWork = activeScope.booths.length > 0;
  const activeTask: "desk" | "booth" =
    task === "booth" && hasBoothWork ? "booth" : hasDeskWork ? "desk" : "booth";
  const assignment = activeTask === "desk"
    ? activeScope.assignments.find((item) => item.targetId === deskId) ?? null
    : activeScope.boothAssignments.find((item) => item.targetId === boothId) ?? null;
  const selectedDesk = activeScope.desks.find((desk) => desk.id === deskId) ?? null;
  const isExitDesk = activeTask === "desk" && selectedDesk?.action === "OUT";
  // In the SELF booth task the staff shows a QR instead of scanning one, so
  // the scan input would be empty. An empty sticky input still floats over
  // the page and covers the QR the participant has to scan, so it is not
  // shown.
  const scanInputHasWork = activeTask === "desk" || activeScope.stampMode !== "SELF";
  // The recent list follows the task on screen: desk passes under the desk
  // task, booth stamps under the booth task. Mixing them made the operator
  // hunt for the record that belongs to the task in hand.
  const taskChecks = activeScope.checks.filter((check) =>
    activeTask === "booth" ? check.action === "STAMP" : check.action !== "STAMP"
  );
  const ready = activeTask === "desk"
    ? Boolean(assignment && deskId)
    : Boolean(assignment && boothId);
  const scanHint = !ready
    ? activeTask === "desk" ? "데스크를 먼저 선택하세요." : "운영 중인 부스를 먼저 선택하세요."
    : "카메라로 QR을 스캔하거나 티켓 코드를 입력하세요.";

  async function submitTicket(code: string) {
    const activeAssignment = assignment;
    if (scanBusyRef.current || submitting || !activeAssignment || !code.trim()) return;
    scanBusyRef.current = true;
    setSubmitting(true);
    setResult({ kind: "idle" });
    setTicketCopyNotice(null);
    clearRewardPanel();
    // Bind a retry to the exact ticket AND desk/booth assignment. A gateway
    // error can happen after commit; a different person's scan is not a retry.
    const isDesk = activeTask === "desk";
    const payload = isDesk ? { deskId, ticket: code.trim() } : { boothId, ticket: code.trim() };
    const attempt = JSON.stringify([activeScope.eventId, activeAssignment.id, activeTask, payload]);
    const commandId = pendingScanIdRef.current.get(attempt) ?? randomCommandId();
    pendingScanIdRef.current.set(attempt, commandId);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(activeScope.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId,
          command: isDesk ? "check.scan" : "booth.visit",
          assignmentId: activeAssignment.id,
          payload,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        id?: unknown;
        name?: unknown;
        action?: unknown;
        reentry?: unknown;
        booth?: unknown;
        rewards?: unknown;
      } | null;
      if (!res.ok) {
        const uncertain = res.status >= 500 || res.status === 408;
        if (!uncertain) pendingScanIdRef.current.delete(attempt);
        setResult({
          kind: "failed",
          message: uncertain
            ? "처리 응답을 확인하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요."
            : typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
        });
        return;
      }
      if (!data || typeof data.name !== "string" ||
        (isDesk && (typeof data.id !== "string" || (data.action !== "IN" && data.action !== "OUT"))) ||
        (!isDesk && typeof data.booth !== "string")) {
        setResult({ kind: "failed", message: "처리 응답을 확인하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요." });
        return;
      }
      pendingScanIdRef.current.delete(attempt);
      const scanAction = isDesk
        ? typeof data?.action === "string" ? data.action : ""
        : "STAMP";
      const participantId = typeof data?.id === "string" ? data.id : "";
      const participantName = typeof data?.name === "string" ? data.name : "";
      if (isDesk) setLastScannedTicket(code.trim());
      setResult({
        kind: "ok",
        participantId,
        name: participantName,
        action: scanAction,
        reentry: data?.reentry === true,
        booth: typeof data?.booth === "string" ? data.booth : "",
      });
      if (isDesk && scanAction === "OUT" && participantId && rewardEnabled) {
        setRewardTarget({ id: participantId, name: participantName, company: directory[participantId] ?? "" });
        setTargetRewards(parseRewardList(data?.rewards));
        setRewardDataLoaded(Array.isArray(data?.rewards));
      }
      setTicket("");
      await load(true);
    } catch {
      setResult({ kind: "failed", message: "연결하지 못했습니다. 같은 업무·티켓으로 다시 시도하세요." });
    } finally {
      scanBusyRef.current = false;
      setSubmitting(false);
    }
  }

  async function onScan(event: React.FormEvent) {
    event.preventDefault();
    await submitTicket(ticket);
  }

  async function postRewardCommand(command: "reward.lookup" | "reward.collect", payload: Record<string, unknown>) {
    if (!assignment || activeTask !== "desk") throw new Error("배정된 데스크를 먼저 선택하세요.");
    const attempt = JSON.stringify([activeScope.eventId, assignment.id, command, payload]);
    const commandId = pendingRewardCommandsRef.current.get(attempt) ?? randomCommandId();
    pendingRewardCommandsRef.current.set(attempt, commandId);
    const response = await fetch(`/api/events/${encodeURIComponent(activeScope.eventId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, command, assignmentId: assignment.id, payload }),
    }).catch(() => {
      throw new Error(command === "reward.collect"
        ? "수령 처리 응답을 확인하지 못했습니다. 같은 경품의 수령 확인을 다시 누르거나 경품을 다시 조회하세요."
        : "경품 조회 응답을 확인하지 못했습니다. 같은 티켓으로 다시 조회하세요.");
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!response.ok) {
      if (response.status < 500) pendingRewardCommandsRef.current.delete(attempt);
      throw new Error(typeof data?.error === "string" ? data.error : "경품 요청을 처리하지 못했습니다.");
    }
    if (!data || Array.isArray(data)) throw new Error("경품 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
    return { data, attempt };
  }

  async function lookupRewardsByTicket(event: React.FormEvent, ticketOverride?: string) {
    event.preventDefault();
    const lookupTicket = (ticketOverride ?? rewardLookupTicket).trim();
    if (!rewardEnabled || !isExitDesk || !assignment || !lookupTicket || rewardLookupLoading) return;
    setRewardLookupTicket(lookupTicket);
    setRewardLookupLoading(true);
    clearRewardPanel();
    try {
      const { data, attempt } = await postRewardCommand("reward.lookup", { ticket: lookupTicket });
      const person = typeof data.participant === "object" && data.participant !== null
        ? data.participant as Record<string, unknown>
        : null;
      if (!person || typeof person.id !== "string" || typeof person.name !== "string" || !Array.isArray(data.rewards)) {
        throw new Error("경품 조회 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      }
      pendingRewardCommandsRef.current.delete(attempt);
      setRewardTarget({ id: person.id, name: person.name, company: typeof person.company === "string" ? person.company : "" });
      setTargetRewards(parseRewardList(data.rewards));
      setRewardDataLoaded(true);
      setRewardNotice(`${person.name}님의 경품을 확인했습니다.`);
      setRewardError(null);
    } catch (error) {
      setRewardError(error instanceof Error ? error.message : "경품을 조회하지 못했습니다.");
    } finally {
      setRewardLookupLoading(false);
    }
  }

  async function refreshTargetRewards() {
    if (!rewardEnabled || !isExitDesk || !assignment || !rewardTarget || rewardLookupLoading) return;
    const target = rewardTarget;
    setRewardLookupLoading(true);
    setRewardError(null);
    setRewardNotice(null);
    try {
      const { data, attempt } = await postRewardCommand("reward.lookup", { participantId: target.id });
      const person = typeof data.participant === "object" && data.participant !== null
        ? data.participant as Record<string, unknown>
        : null;
      if (!person || person.id !== target.id || !Array.isArray(data.rewards)) {
        throw new Error("경품 조회 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
      }
      pendingRewardCommandsRef.current.delete(attempt);
      setTargetRewards(parseRewardList(data.rewards));
      setRewardDataLoaded(true);
      setRewardNotice(`${target.name}님의 경품 정보를 다시 확인했습니다.`);
    } catch (error) {
      setRewardError(error instanceof Error ? error.message : "경품을 다시 조회하지 못했습니다.");
    } finally {
      setRewardLookupLoading(false);
    }
  }

  async function collectReward(reward: DeskReward) {
    if (!rewardTarget || !assignment || reward.status !== "READY" || rewardCollectingId) return;
    if (!window.confirm(`${rewardTarget.name}님에게 “${reward.name}”을 전달하고 수령 완료 처리할까요?`)) return;
    setRewardCollectingId(reward.id);
    setRewardError(null);
    setRewardNotice(null);
    try {
      const { data, attempt } = await postRewardCommand("reward.collect", { id: reward.id });
      const result = typeof data.reward === "object" && data.reward !== null
        ? data.reward as Record<string, unknown>
        : null;
      if (!result || result.id !== reward.id || result.status !== "RECEIVED") {
        throw new Error("수령 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.");
      }
      pendingRewardCommandsRef.current.delete(attempt);
      setTargetRewards((items) => items.map((item) => item.id === reward.id ? { ...item, status: "RECEIVED" } : item));
      setRewardNotice(`${reward.name} · 수령 완료`);
    } catch (error) {
      setRewardError(error instanceof Error ? error.message : "경품 수령 처리를 확인하지 못했습니다.");
    } finally {
      setRewardCollectingId(null);
    }
  }

  // A valid QR for the wrong person is accepted instantly, so the latest
  // record of this session carries its own correction. The server still
  // enforces desk scope and authorship; other records stay read-only here.
  const correctableCheck = result.kind === "ok" && result.action !== "STAMP"
    ? activeScope.checks.find(
        (check) => check.participantId === result.participantId && check.corrected !== true && check.deskId === deskId
      ) ?? null
    : null;

  async function correctLatest(event: React.FormEvent) {
    event.preventDefault();
    if (correcting || !correctableCheck || !assignment || !correctReason.trim()) return;
    setCorrecting(true);
    setCorrectNotice(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(activeScope.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          command: "check.correct",
          assignmentId: assignment.id,
          payload: { id: correctableCheck.id, reason: correctReason.trim() },
        }),
      });
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setCorrectNotice(typeof data?.error === "string" ? data.error : "정정하지 못했습니다.");
        return;
      }
      setCorrectNotice("기록을 정정했습니다. 현재 입장 상태에 반영되었습니다.");
      setCorrectReason("");
      setResult({ kind: "idle" });
      await load(true);
    } catch {
      setCorrectNotice("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      setCorrecting(false);
    }
  }

  return (
    <section className={`staff-workspace${kiosk ? " kiosk-mode" : ""}`} aria-label={`${activeScope.eventName} 현장 업무`}>
      <p className="staff-event-context">
        <Link className="staff-back-link" href="/staff">
          ← 내 업무
        </Link>
        <span>{activeScope.eventName}</span>
        <button
          type="button"
          className="button button-secondary kiosk-toggle"
          aria-pressed={kiosk}
          onClick={() => {
            setKiosk((current) => !current);
            setResult({ kind: "idle" });
            clearRewardPanel();
          }}
        >
          {kiosk ? "일반 화면" : "키오스크 모드"}
        </button>
      </p>
      {kiosk ? (
        <p className="notice" role="status">
          공용 태블릿용 큰 화면입니다. 같은 배정·같은 로그인으로 처리하며, 무인 셀프 체크인은 지원하지 않습니다.
        </p>
      ) : null}
      {hasDeskWork && hasBoothWork ? (
        <div className="staff-task-switch" role="group" aria-label="업무 종류">
          <button
            type="button"
            className={`button ${activeTask === "desk" ? "button-primary" : "button-secondary"}`}
            aria-pressed={activeTask === "desk"}
            onClick={() => {
              setTask("desk");
              setResult({ kind: "idle" });
              clearRewardPanel();
              setRewardLookupTicket("");
            }}
          >
            데스크 체크인
          </button>
          <button
            type="button"
            className={`button ${activeTask === "booth" ? "button-primary" : "button-secondary"}`}
            aria-pressed={activeTask === "booth"}
            onClick={() => {
              setTask("booth");
              setResult({ kind: "idle" });
              clearRewardPanel();
              setRewardLookupTicket("");
            }}
          >
            부스 인증
          </button>
        </div>
      ) : null}
      {activeTask === "desk" ? (
        <div className="staff-select-field">
          <label htmlFor="staff-desk">데스크</label>
          <select
            id="staff-desk"
            value={deskId}
            onChange={(event) => {
              setDeskId(event.target.value);
              setCameraOpen(false);
              setResult({ kind: "idle" });
              clearRewardPanel();
              setRewardLookupTicket("");
            }}
          >
            <option value="">선택하세요</option>
            {activeScope.desks.map((desk) => (
              <option key={desk.id} value={desk.id}>
                {desk.name} · {desk.action === "OUT" ? "퇴장" : "입장"}
              </option>
            ))}
          </select>
          {deskId ? (
            <p className="staff-direction-hint" role="status">
              {(() => {
                const selected = activeScope.desks.find((desk) => desk.id === deskId);
                return selected
                  ? `이 데스크는 ${selected.action === "OUT" ? "퇴장" : "입장"} 처리합니다.`
                  : "";
              })()}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="staff-select-field">
          <label htmlFor="staff-booth">부스</label>
          <select
            id="staff-booth"
            value={boothId}
            onChange={(event) => {
              setBoothId(event.target.value);
              setBoothCopyNotice(null);
              setCameraOpen(false);
              setResult({ kind: "idle" });
              clearRewardPanel();
              setRewardLookupTicket("");
            }}
          >
            <option value="">선택하세요</option>
            {activeScope.booths.map((booth) => (
              <option
                key={booth.id}
                value={booth.id}
                disabled={booth.status !== "" && booth.status !== "OPEN"}
              >
                {booth.name}
                {booth.status === "WAITING" ? " (운영 전)" : booth.status === "CLOSED" ? " (종료)" : ""}
              </option>
            ))}
          </select>
          {(() => {
            const selected = activeScope.booths.find((booth) => booth.id === boothId);
            if (!selected) return null;
            if (selected.status === "WAITING") {
              return <p className="staff-direction-hint" role="status">아직 운영을 시작하지 않은 부스입니다. 운영자가 부스를 열면 선택할 수 있습니다.</p>;
            }
            if (selected.status === "CLOSED") {
              return <p className="staff-direction-hint" role="status">종료된 부스입니다. 운영자가 다시 열면 선택할 수 있습니다.</p>;
            }
            return null;
          })()}
        </div>
      )}
      {activeTask === "booth" && activeScope.stampMode === "SELF" ? (
        <p className="notice" role="status">
          참가자가 직접 인증하는 방식입니다. QR을 보여주고 참가자 홈 &gt; 부스 인증에서 카메라로 바로 인증하게 안내하세요.
          이 화면에서 티켓을 대신 처리하지 않습니다.
        </p>
      ) : null}
      {activeTask === "booth" && activeScope.stampMode === "SELF" && boothId ? (
        <div className="staff-booth-code">
          <p>이 QR을 참가자에게 보여주세요. 참가자는 참가자 홈 &gt; 부스 인증에서 카메라로 찍어 바로 인증하고, 카메라를 쓸 수 없으면 아래 코드를 직접 입력합니다.</p>
          <div
            className={prizeStyles.boothQr}
            role="img"
            aria-label={`${activeScope.booths.find((booth) => booth.id === boothId)?.name ?? "부스"} 인증 QR`}
            ref={boothQrRef}
          >
            <QRCode value={`ET:BOOTH:${activeScope.eventId}:${boothId}`} size={200} />
          </div>
          <p>
            <button
              type="button"
              className="button button-secondary"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(`ET:BOOTH:${activeScope.eventId}:${boothId}`);
                  setBoothCopyNotice("부스 코드를 복사했습니다.");
                } catch {
                  setBoothCopyNotice("복사에 실패했습니다. 아래 코드를 선택해 복사하세요.");
                }
              }}
            >
              코드 복사
            </button>
          </p>
          {boothCopyNotice ? <p role="status">{boothCopyNotice}</p> : null}
          <details className={prizeStyles.codeFallback}>
            <summary>코드 직접 복사</summary>
            <p><code>{`ET:BOOTH:${activeScope.eventId}:${boothId}`}</code></p>
          </details>
        </div>
      ) : null}
      {activeTask !== "booth" || activeScope.stampMode !== "SELF" ? (
        <p id="staff-scan-hint" className="staff-direction-hint" role="status">{scanHint}</p>
      ) : null}
      {scanInputHasWork && result.kind !== "ok" ? (
      <div className={prizeStyles.scanInput}>
      {activeTask === "booth" && activeScope.stampMode !== "SELF" ? (
        <form className="scan-form" onSubmit={onScan}>
          <div className="form-field">
            <label htmlFor="staff-ticket">티켓 코드</label>
            <input
              id="staff-ticket"
              type="text"
              autoComplete="off"
              placeholder="티켓 코드를 입력하거나 스캔하세요"
              value={ticket}
              aria-describedby="staff-scan-hint"
              onChange={(event) => setTicket(event.target.value)}
            />
          </div>
          {ticket ? (
            <p className={prizeStyles.ticketFullCode} data-ticket-full-code>
              <span className={prizeStyles.ticketFullCodeLabel}>입력한 코드 전체</span>
              <code>{ticket}</code>
            </p>
          ) : null}
          <button
            type="button"
            className={`button button-secondary ${prizeStyles.ticketCopy}`}
            disabled={!ticket.trim() || submitting}
            onClick={copyTicketCode}
          >
            코드 복사
          </button>
          {ticketCopyNotice ? <p role="status" className={prizeStyles.nextStep}>{ticketCopyNotice}</p> : null}
          <button className="button button-primary" type="submit" disabled={submitting || !ready || !ticket.trim()}>
            {submitting ? "처리 중입니다" : "부스 인증"}
          </button>
        </form>
      ) : null}
      {activeTask === "desk" ? (
        <form className="scan-form" onSubmit={onScan}>
          <div className="form-field">
            <label htmlFor="staff-ticket">티켓 코드</label>
            <input
              id="staff-ticket"
              type="text"
              autoComplete="off"
              placeholder="티켓 코드를 입력하거나 스캔하세요"
              value={ticket}
              aria-describedby="staff-scan-hint"
              onChange={(event) => setTicket(event.target.value)}
            />
          </div>
          <button className="button button-primary" type="submit" disabled={submitting || !ready || !ticket.trim()}>
            {submitting ? "처리 중입니다" : isExitDesk ? "퇴장 처리" : "입장 처리"}
          </button>
        </form>
      ) : null}
      <div className="camera-action">
        {activeTask === "booth" && activeScope.stampMode === "SELF" ? null : (
          <button
            type="button"
            disabled={!ready}
            aria-describedby="staff-scan-hint"
            className="button button-secondary"
            onClick={() => {
              setResult({ kind: "idle" });
              setCameraOpen(true);
            }}
          >
            카메라로 스캔
          </button>
        )}
      </div>
      </div>
      ) : null}
      {cameraOpen && ready ? (
        <CameraScan
          onDetected={(code) => {
            setCameraOpen(false);
            setTicket(code);
            submitTicket(code);
          }}
          onClose={() => setCameraOpen(false)}
        />
      ) : null}
      {result.kind === "ok" ? (
        <section className={prizeStyles.resultBlock} aria-label="스캔 결과">
          <p className="scan-result scan-success" role="status">
            {result.name} ·{" "}
            {result.action === "STAMP"
              ? `부스 인증${result.booth ? ` · ${result.booth}` : ""}`
              : result.action === "IN" ? "입장" : "퇴장"}
            {result.reentry ? " (재입장)" : ""}
          </p>
          <p className={prizeStyles.nextStep}>다음 참가자를 스캔하세요. 입력창을 비우고 포커스를 돌려놓습니다.</p>
          <div className={prizeStyles.nextActions}>
            <button type="button" ref={nextParticipantRef} className="button button-primary" onClick={prepareNextParticipant}>
              다음 참가자
            </button>
            {result.action === "IN" ? (
              <button
                type="button"
                className={`button button-secondary ${prizeStyles.auxAction}`}
                onClick={() => {
                  setNametag({
                    name: result.name,
                    company: (result.participantId && directory[result.participantId]) || "",
                    eventName: activeScope.eventName,
                    deskName: activeScope.desks.find((desk) => desk.id === deskId)?.name ?? "",
                    action: result.action,
                    at: new Date().toISOString(),
                  });
                  document.body.classList.add("nametag-printing");
                  // Move focus to the sheet so keyboard and screen-reader users
                  // land on the print action instead of scrolling to find it.
                  window.requestAnimationFrame(() => nametagSheetRef.current?.focus());
                }}
              >
                네임택 인쇄
              </button>
            ) : null}
          </div>
        </section>
      ) : null}
      {result.kind === "failed" ? (
        <section className={prizeStyles.resultBlock} aria-label="스캔 실패">
          <p className="scan-result scan-failure" role="alert">{result.message}</p>
          {/* Server verdicts (중복·미등록·만료) carry no recovery steps, while
              uncertain-network messages already ask for a retry: add only the
              missing half so the same "다시 시도" guidance never repeats. */}
          <p className={prizeStyles.nextStep}>
            {result.message.includes("다시 시도")
              ? "카메라가 안 되면 티켓 코드를 직접 입력하세요."
              : "같은 업무·같은 티켓으로 다시 시도하세요. 카메라가 안 되면 티켓 코드를 직접 입력하세요."}
          </p>
          <div className={prizeStyles.nextActions}>
            <button type="button" className="button button-primary" onClick={prepareNextParticipant}>
              다시 시도
            </button>
          </div>
        </section>
      ) : null}
      {result.kind === "ok" && result.action === "OUT" && !rewardEnabled ? (
        <p className="notice" role="status">이 행사에서 경품 기능이 꺼져 있어 현장 경품 조회·수령 처리를 사용할 수 없습니다.</p>
      ) : null}
      {rewardEnabled && isExitDesk && assignment ? (
        <section className={prizeStyles.prizeWorkspace} aria-label="경품 확인 및 수령">
          <div className={prizeStyles.prizeHeader}>
            <div>
              <h3>경품 확인·수령</h3>
              <p>퇴장 처리 응답 또는 티켓 조회로 해당 참가자의 경품만 확인합니다.</p>
            </div>
            {rewardTarget ? (
              <button type="button" className="button button-secondary" disabled={rewardLookupLoading} onClick={refreshTargetRewards}>
                {rewardLookupLoading ? "다시 확인 중" : "경품 다시 확인"}
              </button>
            ) : null}
          </div>
          <form className={prizeStyles.lookupForm} onSubmit={lookupRewardsByTicket}>
            <div className="form-field">
              <label htmlFor="reward-lookup-ticket">경품 대상 티켓</label>
              <input
                id="reward-lookup-ticket"
                type="text"
                autoComplete="off"
                placeholder="퇴장 스캔 응답을 놓쳤다면 티켓 코드를 입력하세요"
                value={rewardLookupTicket}
                onChange={(event) => {
                  setRewardLookupTicket(event.target.value);
                  clearRewardPanel();
                }}
              />
            </div>
            <button type="submit" className="button button-secondary" disabled={rewardLookupLoading || !ready || !rewardLookupTicket.trim()}>
              {rewardLookupLoading ? "조회 중입니다" : "경품 조회"}
            </button>
            {lastScannedTicket ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={rewardLookupLoading || !ready}
                onClick={(event) => lookupRewardsByTicket(event, lastScannedTicket)}
              >
                마지막 스캔 티켓으로 조회
              </button>
            ) : null}
          </form>
          {rewardTarget ? (
            <div className={prizeStyles.prizeTarget}>
              <div className={prizeStyles.targetIdentity}>
                <strong>{rewardTarget.name}</strong>
                {rewardTarget.company ? <span>{rewardTarget.company}</span> : null}
              </div>
              {!rewardDataLoaded ? (
                <p className={prizeStyles.prizeEmpty}>경품 응답을 확인하지 못했습니다. 같은 참가자의 경품을 다시 조회하세요.</p>
              ) : targetRewards.length ? (
                <ul className={prizeStyles.rewardList}>
                  {targetRewards.map((reward) => {
                    const received = reward.status === "RECEIVED";
                    const readyReward = reward.status === "READY";
                    const pending = reward.status === "PENDING";
                    const retrying = pendingRewardCommandsRef.current.has(JSON.stringify([
                      activeScope.eventId,
                      assignment.id,
                      "reward.collect",
                      { id: reward.id },
                    ]));
                    return (
                      <li key={reward.id} className={prizeStyles.rewardItem}>
                        <div className={prizeStyles.rewardInfo}>
                          <strong>{reward.name}</strong>
                          <span className={`${prizeStyles.rewardStatus} ${received ? prizeStyles.rewardReceived : readyReward ? prizeStyles.rewardReady : ""}`}>
                            {received ? "수령 완료" : readyReward ? "수령 대기" : pending ? "운영자 수령자 지정 필요" : reward.status || "상태 확인 필요"}
                          </span>
                        </div>
                        {readyReward ? (
                          <button type="button" className="button button-primary" disabled={rewardCollectingId === reward.id || rewardCollectingId !== null} onClick={() => collectReward(reward)}>
                            {rewardCollectingId === reward.id ? "수령 확인 중" : retrying ? "같은 요청으로 다시 확인" : "수령 확인"}
                          </button>
                        ) : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className={prizeStyles.prizeEmpty}>이 참가자에게 등록된 경품이 없습니다.</p>
              )}
              {targetRewards.some((reward) => reward.status === "PENDING") ? <p className={prizeStyles.prizeNote}>수령자를 먼저 지정해야 합니다. 운영자에게 확인을 요청하세요.</p> : null}
            </div>
          ) : result.kind === "ok" && result.action === "OUT" ? (
            <p className={prizeStyles.prizeEmpty}>퇴장 스캔 결과의 경품을 불러오지 못했습니다. 티켓으로 다시 조회하세요.</p>
          ) : (
            <p className={prizeStyles.prizeEmpty}>경품 확인은 티켓 스캔 또는 퇴장 처리 후 시작할 수 있습니다.</p>
          )}
          {rewardNotice ? <p className={prizeStyles.prizeNotice} role="status">{rewardNotice}</p> : null}
          {rewardError ? <p className={prizeStyles.prizeError} role="alert">{rewardError}</p> : null}
          <p className={prizeStyles.prizeNote}>각 경품은 개별 확인 후 수령 처리합니다. 퇴장만으로는 경품을 수령 완료 처리하지 않습니다.</p>
        </section>
      ) : null}
      {correctableCheck ? (
        <form className="correction-form" onSubmit={correctLatest}>
          <p className="staff-direction-hint">다른 분의 QR을 처리했다면 여기서 바로 정정하세요. 본인 배정 데스크의 최신 기록만 정정됩니다.</p>
          <div className="form-field">
            <label htmlFor="correct-reason">정정 사유</label>
            <input
              id="correct-reason"
              type="text"
              maxLength={300}
              placeholder="예: 다른 분 티켓을 잘못 스캔함"
              value={correctReason}
              onChange={(event) => setCorrectReason(event.target.value)}
            />
          </div>
          <button className="button button-secondary" type="submit" disabled={correcting || !correctReason.trim()}>
            {correcting ? "정정 중입니다" : "최신 기록 정정"}
          </button>
        </form>
      ) : null}
      {correctNotice ? <p className="scan-result" role="status">{correctNotice}</p> : null}
      <h2 className="activity-heading">최근 처리 · {activeTask === "booth" ? "부스 인증" : "데스크 체크인"}</h2>
      <p className={prizeStyles.nextStep}>같은 티켓을 다시 스캔하면 같은 결과가 나옵니다. 아래에서 무엇이 처리됐는지 확인하고 다음 참가자로 넘어가세요.</p>
      {loadError && scope ? (
        <p className="notice" role="status">
          {loadError}{" "}
          <button type="button" className="button button-secondary" onClick={() => load()}>
            다시 불러오기
          </button>
        </p>
      ) : null}
      {taskChecks.length ? (
        <ul className="activity-list">
          {taskChecks.slice(0, 10).map((check) => {
            const actionLabel = check.action === "IN" ? "입장" : check.action === "OUT" ? "퇴장" : check.action === "STAMP" ? "부스 인증" : check.action;
            const placeName = activeScope.desks.find((desk) => desk.id === check.deskId)?.name
              ?? activeScope.booths.find((booth) => booth.id === check.deskId)?.name
              ?? "";
            return (
              <li key={check.id} className={prizeStyles.recentRow}>
                <span>
                  {check.name} · {actionLabel}
                  {placeName ? ` · ${placeName}` : ""}
                  {check.at ? ` · ${formatCheckTime(check.at)}` : ""}
                  {check.corrected ? " (정정됨)" : ""}
                </span>
                <button
                  type="button"
                  className="button button-secondary"
                  aria-label={`${check.name} 다시 스캔 준비`}
                  onClick={prepareNextParticipant}
                >
                  다시 스캔
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p>아직 처리 기록이 없습니다.</p>
      )}
      {nametag ? (
        <section
          className="nametag-sheet"
          aria-label="네임택 인쇄"
          ref={nametagSheetRef}
          tabIndex={-1}
        >
          <p className="nametag-event">{nametag.eventName}</p>
          <p className="nametag-name">{nametag.name}</p>
          {nametag.company ? <p className="nametag-company">{nametag.company}</p> : null}
          <p className="nametag-meta">
            {[nametag.deskName, nametag.action === "IN" ? "입장" : "퇴장"].filter(Boolean).join(" · ")}
          </p>
          <p className="nametag-actions">
            <button type="button" className="button button-primary" onClick={() => window.print()}>
              인쇄하기
            </button>{" "}
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                setNametag(null);
                document.body.classList.remove("nametag-printing");
                window.requestAnimationFrame(() => {
                  const field = document.getElementById("staff-ticket");
                  if (field instanceof HTMLInputElement) field.focus();
                });
              }}
            >
              닫기
            </button>
          </p>
        </section>
      ) : null}
    </section>
  );
}
