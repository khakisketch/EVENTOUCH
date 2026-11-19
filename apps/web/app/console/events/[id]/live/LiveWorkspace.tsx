"use client";

// 현장 모드: the day-of control room (owner decision 2026-11-20, proposal C).
// One dark screen to keep open beside the stage: today's order on the left, what
// the venue screen shows now with the big controls in the middle, live response
// and what is waiting on the right. It is a view and control surface over data
// and commands that already exist; it adds no server command and no data shape.
// Writes keep the gates of their source screens (programs, draws, rewards,
// display.set), and read-only operators see the same screen without controls.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import ProductButton from "../../../../ui/ProductButton";
import ProductLink from "../../../../ui/ProductLink";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { consoleFetch, subscribeConsoleFreshness } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsolePage from "../../../console-ui/ConsolePage";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { RefreshIcon } from "../../../console-ui/ConsoleIcons";
import { displayChoices, displayKey, liveCues, currentDisplayLabel } from "./live-schedule";
import { parseLiveModel, type LiveModel, type LiveModule } from "./live-model";
import { useLiveCommand } from "./useLiveCommand";
import { LiveCuesPane, LiveSidePane, LiveStagePane, type LiveConfirm } from "./LivePanes";
import styles from "./live.module.css";

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; model: LiveModel; readAt: Date };

const POLL_VISIBLE_MS = 10000;
const POLL_FAILED_MS = 20000;
const READ_TIMEOUT_MS = 8000;
const FULL_READ_EVERY = 6;

const TIME = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const TIME_SECONDS = new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

function displayPayload(choice: string): Record<string, unknown> | null {
  const [type, target, drawId] = choice.split("|");
  if (!type) return null;
  const payload: Record<string, unknown> = { type };
  if (type === "notice") payload.noticeId = target;
  else if (type !== "idle" && type !== "photo") payload.moduleId = target;
  if (type === "draw") payload.drawId = drawId;
  return payload;
}

export default function LiveWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const [selectedId, setSelectedId] = useState("");
  const [displayChoice, setDisplayChoice] = useState("");
  const [confirm, setConfirm] = useState<LiveConfirm | null>(null);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const versionRef = useRef<{ eventId: string; version: string; reads: number } | null>(null);
  const forceFullRef = useRef(true);

  const cmd = useLiveCommand(
    eventId,
    () => { forceFullRef.current = true; setReloadTick((tick) => tick + 1); window.dispatchEvent(new CustomEvent("eventouch:shell-reload")); },
    () => { forceFullRef.current = true; setReloadTick((tick) => tick + 1); },
  );

  // The clock drives the cue states; a minute is the schedule's own resolution.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);

  // Any committed write (here or in another tab) asks for a fresh full read.
  useEffect(() => subscribeConsoleFreshness(() => {
    forceFullRef.current = true;
    setReloadTick((tick) => tick + 1);
  }), []);

  // A new event never keeps the last event's picks.
  useEffect(() => {
    setSelectedId(""); setDisplayChoice(""); setConfirm(null); setCounts({});
    versionRef.current = null; forceFullRef.current = true;
  }, [eventId]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), READ_TIMEOUT_MS);
    async function load() {
      setRefreshing(true);
      try {
        const previous = versionRef.current?.eventId === eventId ? versionRef.current : null;
        const full = forceFullRef.current || !previous?.version || previous.reads >= FULL_READ_EVERY;
        forceFullRef.current = false;
        const endpoint = `/api/events/${encodeURIComponent(eventId)}/bootstrap`;
        const [meRes, bootRes] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store" }),
          consoleFetch(full ? endpoint : `${endpoint}?ifVersion=${encodeURIComponent(previous!.version)}`, { cache: "no-store", signal: controller.signal }),
        ]);
        if (cancelled) return;
        if (meRes.status === 401 || bootRes.status === 401) {
          router.push(loginHrefForLocation(window.location.pathname, window.location.search));
          return;
        }
        if (bootRes.status === 403 || bootRes.status === 404) {
          setState({ kind: "failed", message: bootRes.status === 404 ? "행사를 찾을 수 없습니다." : "행사에 대한 접근 권한을 확인하세요." });
          return;
        }
        const me = (await meRes.json().catch(() => null)) as { user?: { id?: unknown; role?: unknown } | null } | null;
        const data = (await bootRes.json().catch(() => null)) as { state?: Record<string, unknown> | null } | null;
        if (cancelled) return;
        const bootstrap = data?.state;
        const user = me?.user && typeof me.user === "object" ? me.user : null;
        if (!bootRes.ok || !bootstrap || !user) throw new Error("read failed");
        if (!full && previous && bootstrap.unchanged === true && bootstrap.refreshVersion === previous.version) {
          versionRef.current = { eventId, version: previous.version, reads: previous.reads + 1 };
          setState((current) => current.kind === "ready" ? { kind: "ready", model: current.model, readAt: new Date() } : current);
          setRefreshError(null);
          return;
        }
        const model = parseLiveModel(bootstrap, eventId, {
          role: typeof user.role === "string" ? user.role : "",
          userId: typeof user.id === "string" ? user.id : "",
        });
        if (!model) {
          setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
          return;
        }
        versionRef.current = { eventId, version: model.refreshVersion, reads: 1 };
        setState({ kind: "ready", model, readAt: new Date() });
        setRefreshError(null);
      } catch {
        if (cancelled) return;
        // A failed refresh never wipes the screen: keep what was read and say so.
        setRefreshError(controller.signal.aborted ? "서버 응답이 늦어 최신 내용을 확인하지 못했습니다." : "연결하지 못해 최신 내용을 확인하지 못했습니다.");
        setState((current) => current.kind === "ready" ? current : { kind: "failed", message: "현장 모드 정보를 불러오지 못했습니다." });
      } finally {
        window.clearTimeout(timeout);
        if (!cancelled) setRefreshing(false);
      }
    }
    void load();
    return () => { cancelled = true; controller.abort(); window.clearTimeout(timeout); };
  }, [eventId, router, reloadTick]);

  // Visibility-aware polling: nothing runs in a hidden tab, and coming back to
  // the tab reads at once instead of waiting out the interval.
  useEffect(() => {
    if (state.kind !== "ready" || refreshing) return;
    let timer: number | undefined;
    function schedule() {
      window.clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      timer = window.setTimeout(() => setReloadTick((tick) => tick + 1), refreshError ? POLL_FAILED_MS : POLL_VISIBLE_MS);
    }
    function wake() {
      if (document.visibilityState === "visible") setReloadTick((tick) => tick + 1);
      else window.clearTimeout(timer);
    }
    schedule();
    document.addEventListener("visibilitychange", wake);
    return () => { window.clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
  }, [state.kind, refreshing, refreshError, reloadTick]);

  const model = state.kind === "ready" ? state.model : null;
  const unappliedDisplay = Boolean(model && displayChoice && displayChoice !== displayKey(model.display));
  useConsoleDraftGuard(
    unappliedDisplay || Boolean(cmd.pending) || cmd.busy,
    "행사장 화면에 아직 적용하지 않은 출력 선택이나 확인하지 못한 요청이 있습니다. 페이지를 떠나면 선택은 사라집니다.",
  );

  const modules = model?.modules ?? [];
  const selected: LiveModule | null = useMemo(() => {
    if (!modules.length) return null;
    return modules.find((module) => module.id === selectedId)
      ?? modules.find((module) => module.status === "OPEN")
      ?? modules.find((module) => module.status === "DRAFT")
      ?? modules[0];
  }, [modules, selectedId]);

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="live" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="현장 모드를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed" || !model) {
    return (
      <ConsolePage pageId="live" eventId={eventId}>
        <ConsoleStatePanel kind="failed" message={state.kind === "failed" ? state.message : "현장 모드 정보를 불러오지 못했습니다."} onRetry={() => { forceFullRef.current = true; setReloadTick((tick) => tick + 1); }} />
      </ConsolePage>
    );
  }

  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const meta = formatConsoleEventMeta({ date: model.eventDate, venue: model.venue });

  // Before 진행 중 nothing here can run, so say how to get there.
  if (model.stage === "DRAFT" || model.stage === "READY") {
    return (
      <ConsolePage pageId="live" eventId={eventId} eventName={model.eventName || undefined} meta={meta}>
        <section className={styles.gate} aria-labelledby="live-gate-heading" data-live-gate="before">
          <h2 id="live-gate-heading">행사를 진행 중 단계로 바꾸면 사용할 수 있습니다</h2>
          <p>현장 모드는 행사 당일에 무대 옆에서 켜 두는 진행 화면입니다. 지금은 {model.stage === "DRAFT" ? "준비 중" : "운영 준비"} 단계입니다.</p>
          <ProductLink variant="primary" href={`${base}/settings#settings-stage`}>행사 설정에서 단계 바꾸기</ProductLink>
        </section>
      </ConsolePage>
    );
  }

  const live = model.stage === "LIVE";
  const capabilities = { role: model.role, userId: model.userId, memberships: model.memberships, eventId };
  const screenOn = model.features.includes("screen");
  const can = {
    display: live && screenOn && canWriteEvent(capabilities, "display.set"),
    programs: live && canWriteEvent(capabilities, "module.status"),
    draws: live && canWriteEvent(capabilities, "draw.program.run"),
    rewards: live && model.rewardsOn && canWriteEvent(capabilities, "reward.fulfill"),
  };
  const anyControl = can.display || can.programs || can.draws || can.rewards;
  const cues = liveCues(model.programs, model.eventDate, now);
  const choices = displayChoices(model.displayOptions);
  const currentKey = displayKey(model.display);

  async function applyDisplay() {
    const payload = displayPayload(displayChoice);
    if (!payload || !model) return;
    const ok = await cmd.send({
      command: "display.set", payload, label: "행사장 화면 출력 변경",
      successMessage: payload.type === "idle" ? "행사장 화면을 유휴 화면으로 바꿨습니다." : "행사장 화면 출력을 바꿨습니다.",
    });
    if (ok) setDisplayChoice("");
  }

  async function runConfirmed(next: LiveConfirm) {
    let ok = false;
    const target = modules.find((module) => module.id === ("moduleId" in next ? next.moduleId : ""));
    if (next.kind === "status" && target) {
      ok = await cmd.send({
        command: "module.status", payload: { id: target.id, status: next.to }, label: `“${target.title}” ${next.to === "OPEN" ? "열기" : "마감"}`,
        successMessage: next.to === "OPEN" ? `“${target.title}”을(를) 열었습니다.` : `“${target.title}”을(를) 마감했습니다.`,
      });
    } else if (next.kind === "reveal" && target) {
      ok = await cmd.send({ command: "module.reveal", payload: { id: target.id }, label: `“${target.title}” 정답 공개`, successMessage: "퀴즈 정답을 공개했습니다." });
    } else if (next.kind === "draw-run" && target) {
      ok = await cmd.send({ command: "draw.run", payload: { id: target.id, count: next.count }, label: `“${target.title}” 추첨`, successMessage: "추첨을 실행했습니다. 결과를 확인하고 공개하세요." });
    } else if (next.kind === "draw-publish" && target) {
      ok = await cmd.send({ command: "draw.publish", payload: { id: target.id, expectedDrawId: next.drawId }, label: `“${target.title}” 추첨 결과 공개`, successMessage: "추첨 결과를 공개했습니다." });
    } else if (next.kind === "program-run") {
      const program = model?.drawPrograms.find((item) => item.id === next.programId);
      if (program) {
        ok = await cmd.send({
          command: "draw.program.run",
          payload: { id: program.id, count: next.count, expectedRevision: program.revision, ...(next.toStage ? { showOnScreen: true } : {}) },
          label: `“${program.name}” 추첨`,
          successMessage: next.toStage ? `${next.count}명을 추첨해 행사장 화면에 표시했습니다.` : `${next.count}명을 추첨했습니다.`,
        });
      }
    }
    if (ok || !cmd.pending) setConfirm(null);
  }

  async function showResults(module: LiveModule) {
    await cmd.send({
      command: "display.set",
      payload: { type: module.type, moduleId: module.id },
      label: `“${module.title}” 결과를 행사장 화면에 표시`,
      successMessage: "결과를 행사장 화면에 표시했습니다.",
    });
  }

  async function fulfill(rewardId: string, name: string, who: string) {
    await cmd.send({ command: "reward.fulfill", payload: { id: rewardId }, label: `${who} · ${name} 지급`, successMessage: `${who}님께 ${name} 지급을 기록했습니다.` });
  }

  const entryPct = model.registered ? Math.round(((model.everIn ?? 0) / model.registered) * 100) : 0;
  const displayLabel = currentDisplayLabel(model.display, model.displayOptions);

  return (
    <ConsolePage pageId="live" eventId={eventId} eventName={model.eventName || undefined} meta={meta}>
      <div className={styles.room} data-live-room data-stage={model.stage}>
        <header className={styles.top}>
          <div className={styles.topMain}>
            <strong className={styles.eventName}>{model.eventName || "이름 없는 행사"}</strong>
            <span className={styles.clock}><time dateTime={now.toISOString()}>{TIME.format(now)}</time></span>
            {model.registered !== null ? (
              <span className={styles.entry} role="img" aria-label={`입장 ${model.everIn ?? 0}명, 등록 ${model.registered}명${model.capacity ? `, 정원 ${model.capacity}명` : ""}, 등록 대비 ${entryPct}%`}>
                <span aria-hidden="true">입장 <b>{model.everIn ?? 0}</b> / 등록 {model.registered}<em>{model.capacity ? ` · 정원 ${model.capacity}` : ""}</em> · {entryPct}%</span>
                <i className={styles.entryBar} aria-hidden="true"><i style={{ width: `${Math.min(100, entryPct)}%` }} /></i>
              </span>
            ) : <span className={styles.entry}>입장 현황을 읽을 수 없습니다</span>}
          </div>
          <div className={styles.topSide}>
            <div className={styles.topSideRow}>
            <span className={styles.onair} data-state={!screenOn ? "off" : model.display.type === "idle" ? "idle" : "live"}>
              <i aria-hidden="true" />
              {!screenOn ? "행사장 화면 꺼짐" : model.display.type === "idle" ? "행사장 화면 대기 중" : "행사장 화면 송출 중"}
            </span>
            <ProductLink variant="ghost" className={styles.backLink} href={base}>관리 화면으로</ProductLink>
            </div>
            <p className={styles.fresh}>
              <span>마지막 갱신 <time dateTime={state.readAt.toISOString()}>{TIME_SECONDS.format(state.readAt)}</time></span>
              <ProductButton
                type="button" variant="ghost" size="sm" className={styles.refresh} busy={refreshing}
                icon={<RefreshIcon />}
                onClick={() => { forceFullRef.current = true; setReloadTick((tick) => tick + 1); }}
              >지금 확인</ProductButton>
            </p>
          </div>
        </header>

        {cmd.notice ? <div className={styles.status} aria-live="polite" aria-atomic="true"><p className={styles.noticeLine}>{cmd.notice}</p></div> : <div className={styles.status} aria-live="polite" aria-atomic="true" />}
        {refreshError ? (
          <p className={styles.warn} role="alert" data-live-refresh-error>
            {refreshError} 마지막으로 읽은 내용을 보고 있습니다.
            <ProductButton type="button" variant="ghost" size="sm" onClick={() => { forceFullRef.current = true; setReloadTick((tick) => tick + 1); }}>다시 시도</ProductButton>
          </p>
        ) : null}
        {cmd.failure ? <p className={styles.fail} role="alert">{cmd.failure}</p> : null}
        {!live ? <p className={styles.banner} role="status">행사가 {model.stage === "ENDED" ? "끝났습니다" : "보관되었습니다"}. 현장 모드는 읽기 전용입니다.</p> : null}
        {live && !anyControl ? <p className={styles.banner} role="status">이 계정에는 현장 진행 권한이 없어 조회만 할 수 있습니다. 필요하면 담당 행사 운영자에게 요청하세요.</p> : null}
        {cmd.pending ? (
          <section className={styles.recovery} aria-labelledby="live-recovery-heading" data-live-recovery>
            <h2 id="live-recovery-heading" tabIndex={-1}>처리 확인 필요 · {cmd.pending.label}</h2>
            <p>이전 요청이 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</p>
            {cmd.recoveryError ? <p role="alert">{cmd.recoveryError}</p> : null}
            <div className={styles.recoveryActions}>
              <ProductButton type="button" variant="secondary" disabled={cmd.busy || cmd.checking || cmd.abandoning} onClick={() => void cmd.check()}>{cmd.checking ? "확인 중…" : "서버 처리 확인"}</ProductButton>
              <ProductButton type="button" variant="secondary" disabled={cmd.busy || cmd.checking || cmd.abandoning || !anyControl} onClick={() => void cmd.retry()}>같은 요청 다시 시도</ProductButton>
              <ProductButton type="button" variant="ghost" disabled={cmd.busy || cmd.checking || cmd.abandoning} onClick={() => cmd.setAbandoning(true)}>확인 전 그만두기</ProductButton>
            </div>
            {cmd.abandoning ? (
              <p className={styles.abandon} role="group" aria-label="확인 그만두기">
                이미 반영된 처리는 취소되지 않습니다. 확인을 그만두고 최신 내용을 확인할까요?
                <ProductButton type="button" variant="primary" onClick={() => cmd.abandon()}>확인 그만두기</ProductButton>
                <ProductButton type="button" variant="ghost" onClick={() => cmd.setAbandoning(false)}>취소</ProductButton>
              </p>
            ) : null}
          </section>
        ) : cmd.otherReceipt ? (
          <p className={styles.warn} role="alert">이전 요청의 처리 결과를 화면 위의 안내에서 먼저 확인하세요. 서버 확인은 요청을 다시 보내지 않습니다.</p>
        ) : null}

        <div className={styles.grid}>
          <LiveCuesPane model={model} eventId={eventId} cues={cues.cues} cueDate={cues.date} now={now} selectedId={selected?.id ?? ""} onSelect={(id) => { setSelectedId(id); setConfirm(null); }} />
          <LiveStagePane
            model={model}
            eventId={eventId}
            selected={selected}
            onSelect={(id) => { setSelectedId(id); setConfirm(null); }}
            screenOn={screenOn}
            displayLabel={displayLabel}
            choices={choices}
            displayChoice={displayChoice}
            onDisplayChoice={setDisplayChoice}
            currentKey={currentKey}
            canDisplay={can.display}
            canPrograms={can.programs}
            canDraws={can.draws}
            locked={cmd.locked}
            busy={cmd.busy}
            confirm={confirm}
            onConfirm={setConfirm}
            onRun={(next) => void runConfirmed(next)}
            onApplyDisplay={() => void applyDisplay()}
            onShowResults={(module) => void showResults(module)}
            counts={counts}
            onCount={(key, value) => setCounts((current) => ({ ...current, [key]: value }))}
          />
          <LiveSidePane
            model={model}
            eventId={eventId}
            selected={selected}
            cues={cues.cues}
            canRewards={can.rewards}
            locked={cmd.locked}
            onSelect={(id) => { setSelectedId(id); setConfirm(null); }}
            onFulfill={(reward) => void fulfill(reward.id, reward.name, reward.who)}
          />
        </div>
      </div>
    </ConsolePage>
  );
}
