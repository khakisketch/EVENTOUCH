"use client";

// The three panes of 현장 모드. They only draw what LiveWorkspace hands them and
// call back for every write; the command, its confirmation copy and its gates
// are the ones of the programs, draws, rewards and display.set screens.

import { useEffect, useRef, useState, type ReactNode } from "react";
import ProductButton from "../../../../ui/ProductButton";
import ProductLink from "../../../../ui/ProductLink";
import { participationTypeLabel } from "../../../../../lib/participation-work";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import DeviceFrame from "../../../console-ui/DeviceFrame";
import { ArrowRightIcon, ExternalLinkIcon } from "../../../console-ui/ConsoleIcons";
import StatusPill, { type StatusPillTone } from "../../../console-ui/StatusPill";
import { titlesMatch, type LiveCue } from "./live-schedule";
import type { LiveDrawProgram, LiveModel, LiveModule, LiveReward } from "./live-model";
import styles from "./live.module.css";

export type LiveConfirm =
  | { kind: "status"; moduleId: string; to: "OPEN" | "CLOSED" }
  | { kind: "reveal"; moduleId: string }
  | { kind: "draw-run"; moduleId: string; count: number }
  | { kind: "draw-publish"; moduleId: string; drawId: string }
  | { kind: "program-run"; programId: string; count: number; toStage: boolean };

// Room width (px) from which the three panes sit side by side; keep in step with live.module.css.
const LIVE_THREE_PANES = 880;

const STATUS_LABEL: Record<string, string> = { DRAFT: "준비 중", OPEN: "진행 중", CLOSED: "마감" };
const CUE_LABEL: Record<string, string> = { done: "지난 일정", current: "지금", next: "다음", upcoming: "예정" };

function statusLabel(module: LiveModule): string {
  return STATUS_LABEL[module.status] ?? "상태 확인 필요";
}

// OPEN reads green, DRAFT is work waiting for the operator (amber), CLOSED is done (quiet).
function statusTone(module: LiveModule): StatusPillTone {
  return module.status === "OPEN" ? "on-dark-ok" : module.status === "DRAFT" ? "on-dark-wait" : "on-dark";
}

function timeRange(cue: LiveCue): string {
  if (cue.start && cue.end) return `${cue.start}–${cue.end}`;
  return cue.start || cue.end || "시간 미정";
}

function receivedUnit(type: string): string {
  if (type === "qa") return "개 질문";
  if (type === "photo") return "장 사진";
  if (type === "board") return "개 게시글";
  if (type === "draw") return "건";
  return "명 응답";
}

/* ───────────────────────── left: 진행 순서 ───────────────────────── */

export function LiveCuesPane({ model, eventId, cues, cueDate, now, selectedId, onSelect }: {
  model: LiveModel; eventId: string; cues: LiveCue[]; cueDate: string; now: Date; selectedId: string; onSelect: (id: string) => void;
}) {
  // Wide screens always show the order; narrower ones fold it under one line so
  // the screen preview and the big buttons come first.
  const [open, setOpen] = useState(false);
  const paneRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    // Same threshold as the three-pane layout in live.module.css (room width, not viewport).
    const room = paneRef.current?.closest("[data-live-room]");
    if (!room || typeof ResizeObserver === "undefined") return;
    // Crossing the threshold sets the default (open when wide, folded when narrow); a hand choice holds in between.
    let wide: boolean | null = null;
    const apply = () => {
      const next = room.clientWidth >= LIVE_THREE_PANES;
      if (next === wide) return;
      wide = next;
      setOpen(next);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(room);
    return () => observer.disconnect();
  }, []);

  const current = cues.find((cue) => cue.status === "current");
  const next = cues.find((cue) => cue.status === "next");
  const taken = new Set<string>();
  const linked = new Map<string, LiveModule[]>();
  for (const cue of cues) {
    const mine = model.modules.filter((module) => !taken.has(module.id) && titlesMatch(cue.title, module.title));
    mine.forEach((module) => taken.add(module.id));
    linked.set(cue.id, mine);
  }
  // Events that are open now belong to the cue on stage even without a title match.
  const openLoose = model.modules.filter((module) => module.status === "OPEN" && !taken.has(module.id));
  const anchor = current ?? null;
  if (anchor) linked.set(anchor.id, [...(linked.get(anchor.id) ?? []), ...openLoose]);
  const looseOutside = anchor ? [] : openLoose;
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const nowLabel = now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });

  const chips = (modules: LiveModule[]) => modules.length ? (
    <ul className={styles.cueEvents} aria-label="이 순서의 참여 이벤트">
      {modules.map((module) => (
        <li key={module.id}>
          <button type="button" className={styles.cueEvent} data-status={module.status} aria-pressed={module.id === selectedId} onClick={() => onSelect(module.id)}>
            <span className={styles.chipTitle}>{module.title}</span>
            <span className={styles.chipMeta}>{participationTypeLabel(module.type)} <StatusPill tone={statusTone(module)} size="sm" dot>{statusLabel(module)}</StatusPill></span>
          </button>
        </li>
      ))}
    </ul>
  ) : null;

  return (
    <section ref={paneRef} className={`${styles.pane} ${styles.paneCues}`} aria-labelledby="live-cues-heading" data-live-pane="cues">
      <details className={styles.cuesFold} open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary className={styles.cuesSummary}>
          <h2 id="live-cues-heading" className={styles.paneTitle}>진행 순서</h2>
          <span className={styles.cuesNow}>
            {current ? <>지금 <b>{current.title}</b></> : next ? <>다음 <b>{next.start} {next.title}</b></> : cues.length ? "일정이 모두 끝났습니다" : "등록된 일정 없음"}
          </span>
        </summary>
        {cues.length ? (
          <ol className={styles.cueList}>
            {cues.map((cue) => (
              <li key={cue.id} className={styles.cue} data-status={cue.status} aria-current={cue.status === "current" ? "step" : undefined}>
                <time dateTime={cue.start ? `${cue.date}T${cue.start}` : undefined}>{cue.start || "--:--"}</time>
                <div className={styles.cueBody}>
                  <span className={styles.cueState}>{CUE_LABEL[cue.status]}</span>
                  <strong>{cue.title}</strong>
                  <span className={styles.cuePlace}>{cue.place || "장소 미정"} · {timeRange(cue)}</span>
                  {chips(linked.get(cue.id) ?? [])}
                </div>
              </li>
            ))}
          </ol>
        ) : (
          <p className={styles.empty}>
            {cueDate ? `${cueDate} ` : ""}등록된 프로그램 일정이 없습니다.
            <ProductLink variant="ghost" href={`${base}/content`}>일정 추가<ArrowRightIcon /></ProductLink>
          </p>
        )}
        {looseOutside.length ? (
          <div className={styles.loose}>
            <h3 className={styles.miniTitle}>일정 밖에서 진행 중</h3>
            {chips(looseOutside)}
          </div>
        ) : null}
        <p className={styles.paneFoot}>기준 시각 {nowLabel} · 이 기기의 시계</p>
      </details>
    </section>
  );
}

/* ───────────────────────── center: 지금 행사장 화면 ───────────────────────── */

export function LiveStagePane(props: {
  model: LiveModel; eventId: string; selected: LiveModule | null; onSelect: (id: string) => void;
  screenOn: boolean; displayLabel: string; choices: Array<{ value: string; label: string }>;
  displayChoice: string; onDisplayChoice: (value: string) => void; currentKey: string;
  canDisplay: boolean; canPrograms: boolean; canDraws: boolean; locked: boolean; busy: boolean;
  confirm: LiveConfirm | null; onConfirm: (next: LiveConfirm | null) => void; onRun: (next: LiveConfirm) => void;
  onApplyDisplay: () => void; onShowResults: (module: LiveModule) => void;
  counts: Record<string, string>; onCount: (key: string, value: string) => void;
}) {
  const { model, eventId, selected, screenOn, choices, displayChoice, currentKey, locked, confirm } = props;
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const changed = displayChoice !== "" && displayChoice !== currentKey;
  const selectedPicked = model.display.moduleId === selected?.id && model.display.type !== "idle";

  function askCount(key: string, max: number, make: (count: number) => LiveConfirm) {
    const count = Number(props.counts[key] ?? "1");
    if (!Number.isInteger(count) || count < 1 || count > Math.min(20, max)) {
      setError({ key, message: `인원은 1~${Math.min(20, max)}명으로 입력하세요.` });
      return;
    }
    setError(null);
    props.onConfirm(make(count));
  }

  function summary(next: LiveConfirm): ReactNode {
    const module = model.modules.find((item) => "moduleId" in next && item.id === next.moduleId);
    if (next.kind === "status") return next.to === "OPEN"
      ? `“${module?.title}”을(를) 열까요? 참가자가 바로 참여할 수 있습니다.`
      : `“${module?.title}”을(를) 마감할까요? 마감하면 참가자가 더 이상 참여할 수 없습니다.`;
    if (next.kind === "reveal") return `“${module?.title}” 퀴즈 정답을 공개할까요? 공개하면 콘텐츠가 종료됩니다.`;
    if (next.kind === "draw-run") return `“${module?.title}” 추첨을 ${next.count}명으로 실행할까요? 이미 당첨된 참가자는 제외됩니다.`;
    if (next.kind === "draw-publish") {
      const names = module?.pendingDrawNames.slice(0, 3).join(", ") || "없음";
      const others = Math.max(0, (module?.pendingDrawNames.length ?? 0) - 3);
      return `당첨자 ${names}${others ? ` 외 ${others}명` : ""}의 결과를 참가자에게 공개할까요?`;
    }
    const program = model.drawPrograms.find((item) => item.id === next.programId);
    if (!program) return "";
    const remaining = program.quota - program.winners;
    const overlap = program.overlap === "EVENT" ? "행사 안에서 이미 당첨된 참가자와 업체는 제외됩니다."
      : program.overlap === "PROGRAM" ? "이 프로그램에서 이미 당첨된 참가자와 업체만 제외됩니다." : "중복 당첨을 허용합니다.";
    return `“${program.name}”에서 ${next.count}명을 ${next.toStage ? "추첨하고 행사장 화면에 결과를 표시" : "추첨"}할까요? 현재 ${program.winners}명 당첨 · ${remaining}명 남음. ${overlap}`;
  }

  const confirmLabel = (next: LiveConfirm) => next.kind === "status" ? (next.to === "OPEN" ? "연다" : "마감한다")
    : next.kind === "reveal" || next.kind === "draw-publish" ? "공개한다" : "실행한다";

  const confirmBox = (next: LiveConfirm | null, scope: (value: LiveConfirm) => boolean) => next && scope(next) ? (
    <ConsoleConfirm summary={summary(next)} confirmLabel={confirmLabel(next)} busy={props.busy} onConfirm={() => props.onRun(next)} onCancel={() => props.onConfirm(null)} />
  ) : null;

  const programs = model.drawPrograms;
  const writable = props.canPrograms;
  const type = selected?.type ?? "";
  const countKey = selected?.id ?? "";

  return (
    <section className={`${styles.pane} ${styles.paneStage}`} aria-labelledby="live-stage-heading" data-live-pane="stage">
      <h2 id="live-stage-heading" className={styles.paneTitle}>지금 진행</h2>

      <h3 className={styles.miniTitle} id="live-events-heading">무대 이벤트</h3>
      {model.modules.length ? (
        <ul className={styles.pick} aria-labelledby="live-events-heading">
          {model.modules.map((module) => (
            <li key={module.id}>
              <button type="button" className={styles.pickItem} data-status={module.status} aria-pressed={module.id === selected?.id} onClick={() => props.onSelect(module.id)}>
                <span className={styles.chipTitle}>{module.title}</span>
                <span className={styles.chipMeta}>{participationTypeLabel(module.type)} <StatusPill tone={statusTone(module)} size="sm" dot>{statusLabel(module)}</StatusPill></span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>
          진행할 참여 이벤트가 없습니다.
          <ProductLink variant="ghost" href={`${base}/programs`}>참여 콘텐츠 보기<ArrowRightIcon /></ProductLink>
        </p>
      )}

      {selected ? (
        <div className={styles.eventPanel} data-live-event={selected.id} data-status={selected.status}>
          <div className={styles.eventHead}>
            <div>
              <h3 className={styles.eventTitle}>{selected.title}</h3>
              <p className={styles.eventMeta}>
                {participationTypeLabel(selected.type)} <StatusPill tone={statusTone(selected)} size="sm" dot>{statusLabel(selected)}</StatusPill>
                {selectedPicked ? " · 행사장 화면에 나가는 중" : ""}
                {` · 받은 ${model.received[selected.id] ?? 0}${receivedUnit(selected.type)}`}
              </p>
            </div>
          </div>

          {writable ? (
            <div className={styles.bigRow}>
              {selected.status === "OPEN" ? (
                <ProductButton type="button" variant="primary" size="lg" disabled={locked} onClick={() => props.onConfirm({ kind: "status", moduleId: selected.id, to: "CLOSED" })}>마감</ProductButton>
              ) : (
                <ProductButton type="button" variant={selected.status === "DRAFT" ? "primary" : "secondary"} size="lg" disabled={locked} onClick={() => props.onConfirm({ kind: "status", moduleId: selected.id, to: "OPEN" })}>
                  {selected.status === "CLOSED" ? "다시 열기" : "열기"}
                </ProductButton>
              )}
              {type === "quiz" && selected.published && !selected.revealed && (selected.status === "OPEN" || selected.status === "CLOSED") ? (
                <ProductButton type="button" variant="secondary" size="lg" disabled={locked} onClick={() => props.onConfirm({ kind: "reveal", moduleId: selected.id })}>결과 공개 · 정답</ProductButton>
              ) : null}
              {(type === "poll" || type === "qa") && selected.published && props.canDisplay && screenOn ? (
                <ProductButton type="button" variant="secondary" size="lg" disabled={locked || selectedPicked || (type === "qa" && model.displayOptions.approvedQuestions === 0)} title={selectedPicked ? "이미 행사장 화면에 나가고 있습니다" : type === "qa" && model.displayOptions.approvedQuestions === 0 ? "승인된 질문이 있어야 화면에 표시할 수 있습니다" : undefined} onClick={() => props.onShowResults(selected)}>
                  결과 공개 · 화면에 표시
                </ProductButton>
              ) : null}
              {type === "draw" && props.canDraws ? (
                <>
                  <label className={styles.countField} htmlFor={`live-count-${selected.id}`}>
                    <span>당첨 인원</span>
                    <input id={`live-count-${selected.id}`} type="number" min={1} max={20} inputMode="numeric" value={props.counts[countKey] ?? "1"} disabled={locked}
                      aria-invalid={error?.key === countKey} aria-describedby={error?.key === countKey ? "live-count-error" : undefined}
                      onChange={(event) => props.onCount(countKey, event.target.value)} />
                  </label>
                  <ProductButton type="button" variant="secondary" size="lg" disabled={locked || selected.status !== "OPEN"} title={selected.status !== "OPEN" ? "진행 중인 추첨만 실행할 수 있습니다. 먼저 여세요." : undefined}
                    onClick={() => askCount(countKey, 20, (count) => ({ kind: "draw-run", moduleId: selected.id, count }))}>추첨 실행</ProductButton>
                  {selected.pendingDrawId ? (
                    <ProductButton type="button" variant="secondary" size="lg" disabled={locked} onClick={() => props.onConfirm({ kind: "draw-publish", moduleId: selected.id, drawId: selected.pendingDrawId })}>결과 공개 · 최신 추첨</ProductButton>
                  ) : null}
                </>
              ) : null}
            </div>
          ) : (
            <p className={styles.hintLine}>이 계정은 진행 상태를 바꿀 수 없습니다. 상태와 응답만 볼 수 있습니다.</p>
          )}
          {error?.key === countKey ? <p id="live-count-error" className={styles.fail} role="alert">{error.message}</p> : null}
          {confirmBox(confirm, (value) => "moduleId" in value && value.moduleId === selected.id)}
        </div>
      ) : null}

      <div className={styles.divider} />
      <h3 className={styles.miniTitle} id="live-screen-heading">행사장 화면</h3>
      <div className={styles.tv} data-live-tv>
        <div className={styles.tvGlass} aria-hidden="true">
          <DeviceFrame variant="screen" fixed maxDisplayWidth={820} className={styles.tvDevice}>
            {screenOn && model.eventSlug ? (
              <iframe
                key={currentKey}
                className={styles.tvFrame}
                src={`/screen/${encodeURIComponent(model.eventSlug)}`}
                title="행사장 화면 미리보기"
                tabIndex={-1}
                loading="lazy"
              />
            ) : (
              <div className={styles.tvOff}>
                <strong>행사장 화면 기능이 꺼져 있습니다</strong>
                <span>행사 설정의 기능에서 켜면 이곳에 송출 화면이 보입니다.</span>
              </div>
            )}
          </DeviceFrame>
        </div>
        <p className={styles.tvLabel}><span className={styles.tvDot} data-state={!screenOn ? "off" : model.display.type === "idle" ? "idle" : "live"} aria-hidden="true" />현재 출력 · <strong>{props.displayLabel}</strong></p>
      </div>

      {screenOn ? (
        <div className={styles.outputRow}>
          {props.canDisplay ? (
            <>
              <label className="sr-only" htmlFor="live-display-pick">행사장 화면 출력 선택</label>
              <select id="live-display-pick" className={styles.select} value={displayChoice} disabled={locked} onChange={(event) => props.onDisplayChoice(event.target.value)}>
                <option value="">출력 고르기</option>
                {choices.map((choice) => <option key={choice.value} value={choice.value}>{choice.label}</option>)}
              </select>
              <ProductButton
                type="button" variant="secondary" size="lg" busy={props.busy && changed}
                disabled={locked || !changed}
                title={!displayChoice ? "출력을 먼저 고르세요" : !changed ? "이미 적용된 출력입니다" : undefined}
                onClick={props.onApplyDisplay}
              >
                {changed && displayChoice.startsWith("idle") ? "유휴로 내리기" : "출력 적용"}
              </ProductButton>
            </>
          ) : null}
          {model.eventSlug ? (
            <ProductLink variant="ghost" href={`/screen/${encodeURIComponent(model.eventSlug)}`} target="_blank" rel="noreferrer">
              행사장 화면 열기<ExternalLinkIcon /><span className="sr-only"> (새 탭)</span>
            </ProductLink>
          ) : null}
        </div>
      ) : null}
      {screenOn && props.canDisplay ? <p className={styles.hintLine}>추첨은 무대별 최근 공개 결과를 고를 수 있습니다. 공개 중인 결과는 다른 출력을 적용할 때까지 유지됩니다.</p> : null}
      {changed ? <p className={styles.hintLine} role="status">선택한 출력은 아직 적용되지 않았습니다. ‘출력 적용’을 누르면 행사장 화면에 나옵니다.</p> : null}

      {programs.length ? (
        <>
          <div className={styles.divider} />
          <div className={styles.rowHead}>
            <h3 className={styles.miniTitle} id="live-programs-heading">추첨 프로그램</h3>
            <ProductLink variant="ghost" href={`${base}/draws`}>추첨 관리<ArrowRightIcon /></ProductLink>
          </div>
          <ul className={styles.programs} aria-labelledby="live-programs-heading">
            {programs.slice(0, 5).map((program: LiveDrawProgram) => {
              const remaining = program.quota - program.winners;
              const done = remaining <= 0;
              return (
                <li key={program.id} className={styles.program} data-done={done ? "true" : undefined}>
                  <div className={styles.programCopy}>
                    <strong>{program.name}</strong>
                    <span>{program.winners} / {program.quota}명 당첨{done ? " · 추첨 완료" : ` · ${remaining}명 남음`}</span>
                  </div>
                  {props.canDraws && !done ? (
                    <div className={styles.programActions}>
                      <label className={styles.countField} htmlFor={`live-count-${program.id}`}>
                        <span className="sr-only">{program.name} 인원</span>
                        <input id={`live-count-${program.id}`} type="number" min={1} max={Math.min(20, remaining)} inputMode="numeric" value={props.counts[program.id] ?? "1"} disabled={locked}
                          aria-invalid={error?.key === program.id} aria-describedby={error?.key === program.id ? `live-count-error-${program.id}` : undefined}
                          onChange={(event) => props.onCount(program.id, event.target.value)} />
                        <span aria-hidden="true">명</span>
                      </label>
                      <ProductButton type="button" variant="secondary" size="lg" disabled={locked} onClick={() => askCount(program.id, remaining, (count) => ({ kind: "program-run", programId: program.id, count, toStage: false }))}>추첨 실행</ProductButton>
                      {props.canDisplay ? (
                        <ProductButton type="button" variant="ghost" size="lg" disabled={locked} onClick={() => askCount(program.id, remaining, (count) => ({ kind: "program-run", programId: program.id, count, toStage: true }))}>추첨하고 화면에 표시</ProductButton>
                      ) : null}
                    </div>
                  ) : null}
                  {error?.key === program.id ? <p id={`live-count-error-${program.id}`} className={styles.fail} role="alert">{error.message}</p> : null}
                  {confirmBox(confirm, (value) => value.kind === "program-run" && value.programId === program.id)}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}

/* ───────────────────────── right: 실시간 응답 · 다음 · 검토 · 경품 ───────────────────────── */

export function LiveSidePane({ model, eventId, selected, cues, canRewards, locked, onSelect, onFulfill }: {
  model: LiveModel; eventId: string; selected: LiveModule | null; cues: LiveCue[]; canRewards: boolean; locked: boolean;
  onSelect: (id: string) => void; onFulfill: (reward: LiveReward) => void;
}) {
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const received = selected ? model.received[selected.id] ?? 0 : 0;
  const countsPeople = selected ? ["poll", "quiz", "survey"].includes(selected.type) : false;
  const sharePct = countsPeople && model.everIn ? Math.min(100, Math.round((received / model.everIn) * 100)) : null;
  const tally = selected ? model.tallies[selected.id] : undefined;
  const tallyTotal = tally ? tally.reduce((sum, value) => sum + value, 0) : 0;
  const next = cues.find((cue) => cue.status === "next");
  const nextModule = next ? model.modules.find((module) => module.status === "DRAFT" && titlesMatch(next.title, module.title)) : undefined;
  const waiting = model.modules.filter((module) => module.status === "DRAFT" && module.id !== nextModule?.id).slice(0, 4);
  const tasks = model.participation.tasks;

  return (
    <aside className={`${styles.pane} ${styles.paneSide}`} aria-label="실시간 현황" data-live-pane="side">
      <section aria-labelledby="live-next-heading" className={styles.block}>
        <h2 id="live-next-heading" className={styles.paneTitle}>다음에 할 일</h2>
        {next || waiting.length ? (
          <ul className={styles.todo}>
            {next ? (nextModule ? (
              <li>
                <button type="button" className={styles.todoButton} onClick={() => onSelect(nextModule.id)}>
                  <span>{next.title}</span><em>{next.start || "시간 미정"} · {participationTypeLabel(nextModule.type)} 대기</em>
                </button>
              </li>
            ) : <li><span>{next.title}</span><em>{next.start || "시간 미정"}</em></li>) : null}
            {waiting.map((module) => (
              <li key={module.id}>
                <button type="button" className={styles.todoButton} onClick={() => onSelect(module.id)}>
                  <span>{module.title}</span><em>대기 · {participationTypeLabel(module.type)}</em>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className={styles.empty}>예정된 일정과 대기 중인 이벤트가 없습니다.</p>}
      </section>

      <section aria-labelledby="live-response-heading" className={styles.block}>
        <h2 id="live-response-heading" className={styles.paneTitle}>실시간 응답</h2>
        {selected ? (
          <>
            <p className={styles.bigFigure}><b>{received}</b><span>{receivedUnit(selected.type)}</span></p>
            <p className={styles.figureNote}>{selected.title} · {statusLabel(selected)}{sharePct !== null ? ` · 입장자의 ${sharePct}%` : ""}</p>
            {sharePct !== null ? <i className={styles.meter} aria-hidden="true"><i style={{ width: `${sharePct}%` }} /></i> : null}
            {tally && tallyTotal > 0 ? (
              <ul className={styles.tally} aria-label="선택지별 응답">
                {selected.options.map((option, index) => {
                  const pct = Math.round(((tally[index] ?? 0) / tallyTotal) * 100);
                  return (
                    <li key={`${option}-${index}`}>
                      <span>{option}</span>
                      <i aria-hidden="true"><i style={{ width: `${pct}%` }} /></i>
                      <b>{tally[index] ?? 0}<small> · {pct}%</small></b>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </>
        ) : <p className={styles.empty}>선택한 참여 이벤트가 없습니다.</p>}
      </section>

      <section aria-labelledby="live-review-heading" className={styles.block}>
        <h2 id="live-review-heading" className={styles.paneTitle}>검토 대기</h2>
        {tasks.length ? (
          <ul className={styles.todo}>
            {tasks.map((task) => (
              <li key={task.key}>
                <span>{task.title}<small>{task.hint}</small></span>
                <ProductLink variant="ghost" href={`${base}/programs?review=${task.review}&from=live`}>{task.count}<span className="sr-only"> · {task.action}</span><ArrowRightIcon /></ProductLink>
              </li>
            ))}
          </ul>
        ) : <p className={styles.empty}>검토할 질문이나 참여 응답이 없습니다.</p>}
      </section>

      {model.rewardsOn ? (
        <section aria-labelledby="live-reward-heading" className={styles.block}>
          <div className={styles.rowHead}>
            <h2 id="live-reward-heading" className={styles.paneTitle}>경품 지급 대기{model.rewardsWaiting.length ? <span className={styles.count}>{model.rewardsWaiting.length}</span> : null}</h2>
            <ProductLink variant="ghost" href={`${base}/rewards`}>전체 보기<ArrowRightIcon /></ProductLink>
          </div>
          {model.rewardsWaiting.length ? (
            <ul className={styles.todo} data-live-rewards>
              {model.rewardsWaiting.slice(0, 5).map((reward) => (
                <li key={reward.id}>
                  <span>{reward.who}<small>{reward.name}</small></span>
                  {canRewards ? (
                    <ProductButton type="button" variant="secondary" disabled={locked} aria-label={`${reward.who} ${reward.name} 지급`} onClick={() => onFulfill(reward)}>지급</ProductButton>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : <p className={styles.empty}>지급을 기다리는 경품이 없습니다.</p>}
          {model.rewardsWaiting.length > 5 ? <p className={styles.paneFoot}>외 {model.rewardsWaiting.length - 5}건은 경품 지급 현황에서 확인하세요.</p> : null}
          {model.rewardsAttention ? (
            <p className={styles.attention}><ProductLink variant="ghost" href={`${base}/rewards`}>확인 필요 {model.rewardsAttention}건<ArrowRightIcon /></ProductLink></p>
          ) : null}
        </section>
      ) : null}
    </aside>
  );
}
