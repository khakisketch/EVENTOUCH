/**
 * 참여 이벤트: one list for every participation content and stage draw.
 *
 * Read-only derivation over the already-loaded operator bootstrap. Nothing
 * here writes, and nothing invents a state: a life-cycle segment is lit only
 * by data that exists (configured, run state, results, linked rewards). Types
 * that have no reward path report "na" instead of an empty reward step.
 */

export type RunStatus = "DRAFT" | "OPEN" | "CLOSED";
export type SegmentState = "done" | "current" | "todo" | "na";
export type LifecycleSegment = { key: "prepare" | "run" | "result" | "reward"; label: string; state: SegmentState };
export type LifecycleStep = { key: "prepare" | "expose" | "run" | "result" | "reward"; label: string; state: SegmentState; hint: string };
export type PillTone = "live" | "review" | "ready" | "prep" | "done" | "check";

/** Facts every event kind can answer from loaded data. rewardCount null = no reward path for this type. */
export type EventFacts = {
  status: string;
  configured: boolean;
  hasResult: boolean;
  rewardCount: number | null;
};

export function runStatus(status: string): RunStatus | null {
  return status === "DRAFT" || status === "OPEN" || status === "CLOSED" ? status : null;
}

export function lifecycleSegments(facts: EventFacts): LifecycleSegment[] {
  const status = runStatus(facts.status);
  const closed = status === "CLOSED";
  const open = status === "OPEN";
  const rewardState: SegmentState = facts.rewardCount === null ? "na"
    : facts.rewardCount > 0 ? "done"
    : closed || facts.hasResult ? "current" : "todo";
  return [
    { key: "prepare", label: "준비", state: facts.configured ? "done" : "current" },
    { key: "run", label: "진행", state: closed ? "done" : open ? "current" : "todo" },
    { key: "result", label: "결과", state: closed || facts.hasResult ? "done" : "todo" },
    { key: "reward", label: "경품", state: rewardState },
  ];
}

export function lifecycleSteps(facts: EventFacts): LifecycleStep[] {
  const status = runStatus(facts.status);
  const exposed = status === "OPEN" || status === "CLOSED";
  const resultDone = status === "CLOSED" || facts.hasResult;
  const states: SegmentState[] = [
    facts.configured ? "done" : "todo",
    exposed ? "done" : "todo",
    status === "CLOSED" ? "done" : "todo",
    resultDone ? "done" : "todo",
    facts.rewardCount === null ? "na" : facts.rewardCount > 0 ? "done" : "todo",
  ];
  // The current step is the first one that is not done; a running event is
  // always on 진행, and a type with no reward path never waits on 경품.
  let current = status === "OPEN" ? 2 : states.findIndex((state) => state === "todo");
  if (status === "OPEN" && !facts.configured) current = 0;
  if (current >= 0 && states[current] !== "na") states[current] = "current";
  const labels: Array<[LifecycleStep["key"], string, string]> = [
    // Reopened 2026-11-24 (H5): the five steps carry the names of the row meter's four segments
    // (준비 · 진행 · 결과 · 경품); 공개 is the one step the meter folds into 진행.
    ["prepare", "준비", facts.configured ? "설정이 저장되어 있습니다." : "내용을 채워 설정을 완성하세요."],
    ["expose", "공개", exposed ? "참가자에게 공개되었습니다." : "시작하면 참가자 화면에 공개됩니다."],
    ["run", "진행", status === "OPEN" ? "지금 진행 중입니다." : status === "CLOSED" ? "진행이 끝났습니다." : "시작하면 응답을 받습니다."],
    ["result", "결과", resultDone ? "결과를 확인할 수 있습니다." : "종료하면 결과가 정리됩니다."],
    ["reward", "경품", facts.rewardCount === null ? "이 유형은 경품을 연결하지 않습니다." : facts.rewardCount > 0 ? `경품 ${facts.rewardCount}건이 연결되어 있습니다.` : "연결된 경품이 아직 없습니다."],
  ];
  return labels.map(([key, label, hint], index) => ({ key, label, hint, state: states[index] }));
}

export function eventPill(facts: EventFacts, reviewCount = 0): { tone: PillTone; label: string } {
  if (reviewCount > 0) return { tone: "review", label: `검토 ${reviewCount}` };
  const status = runStatus(facts.status);
  if (status === "OPEN") return { tone: "live", label: "진행 중" };
  if (status === "CLOSED") return { tone: "done", label: "종료" };
  if (status === "DRAFT") return facts.configured ? { tone: "ready", label: "준비 완료" } : { tone: "prep", label: "준비 중" };
  return { tone: "check", label: "상태 확인 필요" };
}

// ---------------------------------------------------------------------------
// Stage draws, rank vote, roulette and lucky numbers (the old 추첨·투표 screen)
// ---------------------------------------------------------------------------

export type DrawEventKind = "stage" | "vote" | "roulette" | "lucky";
export type DrawEvent = {
  key: string;
  kind: DrawEventKind;
  /** ProgramTypeIcon type */
  icon: string;
  title: string;
  typeLabel: string;
  status: string;
  configured: boolean;
  hasResult: boolean;
  rewardCount: number | null;
  /** One quiet line: type · counts */
  line: string;
  schedule: string | null;
  count: number;
  unit: string;
  /** Hash on the draws route that selects this item. */
  hash: string;
  featureKey: "draw" | "poll";
  facts: string[];
};

export type DrawEventsSnapshot = {
  events: DrawEvent[];
  /** Linked reward count per draw module id (via the draw programs built on it). */
  moduleRewards: Record<string, number>;
  moduleDraws: Record<string, number>;
  rewardTotal: number;
};

function rows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item))) : [];
}
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}
function str(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function scheduleLabel(startsAt: unknown, endsAt: unknown): string | null {
  const fmt = (value: unknown): string | null => {
    if (typeof value !== "string" || !value) return null;
    const instant = Date.parse(value);
    if (!Number.isFinite(instant)) return null;
    const parts = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(instant);
    return parts;
  };
  const from = fmt(startsAt);
  const to = fmt(endsAt);
  if (from && to) return `${from} ~ ${to}`;
  if (from) return `${from} 시작`;
  if (to) return `${to} 마감`;
  return null;
}

export function drawEventsSnapshot(workspace: Record<string, unknown>): DrawEventsSnapshot {
  const rewards = rows(workspace.rewards).map((reward) => {
    const source = record(reward.source);
    return { kind: str(source?.kind), programId: str(source?.programId) };
  });
  const programs = rows(workspace.drawPrograms).filter((program) => typeof program.id === "string" && program.id !== "");
  const luckyProgramIds = new Set<string>();
  const events: DrawEvent[] = [];
  const moduleRewards: Record<string, number> = {};
  const moduleDraws: Record<string, number> = {};
  const rewardsOf = (programId: string) => rewards.filter((reward) => reward.kind === "draw" && reward.programId === programId).length;

  for (const program of programs) {
    const id = String(program.id);
    const winners = rows(program.winners);
    const quota = typeof program.quota === "number" && program.quota > 0 ? program.quota : 0;
    if (winners.some((winner) => typeof winner.luckyNumber === "number")) luckyProgramIds.add(id);
    const moduleId = str(program.moduleId);
    const linked = rewardsOf(id);
    if (moduleId) {
      moduleRewards[moduleId] = (moduleRewards[moduleId] ?? 0) + linked;
      moduleDraws[moduleId] = (moduleDraws[moduleId] ?? 0) + 1;
    }
    const tiers = rows(program.prizeTiers).length;
    const status = str(program.status, "DRAFT");
    events.push({
      key: `stage:${id}`,
      kind: "stage",
      icon: "draw",
      title: str(program.name, "이름 없는 추첨"),
      typeLabel: "무대 추첨",
      status,
      configured: quota > 0,
      hasResult: winners.length > 0,
      rewardCount: linked,
      line: `무대 추첨 · 당첨 ${winners.length}${quota ? `/${quota}` : ""}명${tiers ? ` · 등급 ${tiers}` : ""}`,
      schedule: null,
      count: winners.length,
      unit: "명",
      hash: `#draw-program-${encodeURIComponent(id)}`,
      featureKey: "draw",
      facts: [`총 당첨 인원 ${quota}명`, `당첨자 ${winners.length}명`, program.published === true ? "결과 공개됨" : "결과 미공개"],
    });
  }

  // 순위 투표: listed once teams exist (a configured vote), never as an empty placeholder.
  const teams = rows(workspace.teams);
  const votes = rows(workspace.votes).filter((vote) => Array.isArray(vote.picks)).length;
  const voteConfig = record(workspace.voteConfig);
  if (teams.length > 0 || votes > 0) {
    const open = voteConfig?.status === "OPEN";
    const published = voteConfig?.resultsPublished === true;
    const status = open ? "OPEN" : votes > 0 || published ? "CLOSED" : "DRAFT";
    const pick = typeof voteConfig?.pickCount === "number" ? voteConfig.pickCount : null;
    events.push({
      key: "vote",
      kind: "vote",
      icon: "vote",
      title: "순위 투표",
      typeLabel: "순위 투표",
      status,
      configured: teams.length > 0,
      hasResult: published || (status === "CLOSED" && votes > 0),
      rewardCount: null,
      line: `순위 투표 · 팀 ${teams.length}${pick ? ` · 1인 ${pick}표` : ""}`,
      schedule: null,
      count: votes,
      unit: "표",
      hash: "#draws-vote",
      featureKey: "poll",
      facts: [`팀 ${teams.length}개`, `받은 투표 ${votes}건`, published ? "결과 공개됨" : "결과 미공개"],
    });
  }

  // 모바일 룰렛: listed once prizes exist.
  const roulette = record(workspace.rouletteConfig);
  const prizes = rows(roulette?.prizes);
  const spins = rows(workspace.rouletteResults).length;
  if (prizes.length > 0 || spins > 0) {
    const status = roulette?.status === "OPEN" ? "OPEN" : roulette?.status === "CLOSED" ? "CLOSED" : "DRAFT";
    const linked = rewards.filter((reward) => reward.kind === "roulette").length;
    events.push({
      key: "roulette",
      kind: "roulette",
      icon: "roulette",
      title: "모바일 룰렛",
      typeLabel: "룰렛",
      status,
      configured: prizes.length > 0,
      hasResult: spins > 0,
      rewardCount: linked,
      line: `룰렛 · 경품 칸 ${prizes.length}${spins ? ` · 참여 ${spins}회` : ""}`,
      schedule: scheduleLabel(roulette?.startsAt, roulette?.endsAt),
      count: spins,
      unit: "회",
      hash: "#draws-roulette",
      featureKey: "draw",
      facts: [`경품 칸 ${prizes.length}개`, `참여 ${spins}회`],
    });
  }

  // 럭키번호: listed once numbers are issued or a range was saved.
  const luckyNumbers = rows(workspace.luckyNumbers).filter((entry) => typeof entry.participantId === "string" && typeof entry.number === "number");
  const luckyConfig = record(workspace.luckyConfig);
  const luckyConfigured = Number.isInteger(luckyConfig?.min) && Number.isInteger(luckyConfig?.max);
  if (luckyNumbers.length > 0 || luckyConfigured) {
    const hasResult = luckyProgramIds.size > 0;
    const linked = [...luckyProgramIds].reduce((total, id) => total + rewardsOf(id), 0);
    events.push({
      key: "lucky",
      kind: "lucky",
      icon: "lucky",
      title: "럭키번호",
      typeLabel: "럭키번호",
      status: hasResult ? "CLOSED" : "DRAFT",
      configured: luckyNumbers.length > 0,
      hasResult,
      rewardCount: linked,
      line: `럭키번호 · 배정 ${luckyNumbers.length}명${luckyConfigured ? ` · 범위 ${luckyConfig?.min}–${luckyConfig?.max}` : ""}`,
      schedule: null,
      count: luckyNumbers.length,
      unit: "명",
      hash: "#draws-lucky",
      featureKey: "draw",
      facts: [`번호 배정 ${luckyNumbers.length}명`, hasResult ? "추첨 완료" : "아직 추첨 전"],
    });
  }

  return { events, moduleRewards, moduleDraws, rewardTotal: rewards.length };
}

// ---------------------------------------------------------------------------
// Template chooser: only types that exist today
// ---------------------------------------------------------------------------

export type TemplateGroupKey = "participate" | "draw" | "mission";
export type EventTemplate =
  | { id: string; group: TemplateGroupKey; label: string; description: string; icon: string; action: "module"; moduleType: string }
  | { id: string; group: TemplateGroupKey; label: string; description: string; icon: string; action: "draws"; hash: string; query?: string };

export const TEMPLATE_GROUPS: Array<{ key: TemplateGroupKey; label: string; hint: string }> = [
  { key: "participate", label: "참여형", hint: "답을 모으는 이벤트" },
  { key: "draw", label: "추첨형", hint: "당첨자를 뽑는 이벤트" },
  { key: "mission", label: "미션형", hint: "행사 내내 열어 두는 이벤트" },
];

export const EVENT_TEMPLATES: EventTemplate[] = [
  { id: "poll", group: "participate", label: "투표", icon: "poll", description: "선택지를 고르고 실시간으로 결과를 봅니다.", action: "module", moduleType: "poll" },
  { id: "quiz", group: "participate", label: "퀴즈", icon: "quiz", description: "정답을 정하고 정답률을 확인합니다.", action: "module", moduleType: "quiz" },
  { id: "qa", group: "participate", label: "Q&A", icon: "qa", description: "질문을 받고 승인한 뒤 답변합니다.", action: "module", moduleType: "qa" },
  { id: "survey", group: "participate", label: "설문", icon: "survey", description: "만족도와 의견을 받아 보고서에 반영합니다.", action: "module", moduleType: "survey" },
  { id: "roulette", group: "draw", label: "룰렛", icon: "roulette", description: "참가자가 폰에서 직접 돌려 경품을 받습니다.", action: "draws", hash: "#draws-roulette" },
  { id: "lucky", group: "draw", label: "럭키번호", icon: "lucky", description: "참가자에게 번호를 배정하고 무대에서 뽑습니다.", action: "draws", hash: "#draws-lucky" },
  { id: "draw", group: "draw", label: "간단 추첨", icon: "draw", description: "응답자 중에서 바로 몇 명을 뽑습니다.", action: "module", moduleType: "draw" },
  { id: "stage", group: "draw", label: "무대 추첨", icon: "draw", description: "대상 조건과 경품 등급을 정해 무대에서 뽑습니다.", action: "draws", hash: "", query: "new=program" },
  { id: "vote", group: "draw", label: "순위 투표", icon: "vote", description: "팀·작품에 투표받아 순위를 정합니다.", action: "draws", hash: "#draws-vote" },
  { id: "photo", group: "mission", label: "참여 사진", icon: "photo", description: "참가자가 올린 사진을 승인하고 피드로 보여 줍니다.", action: "module", moduleType: "photo" },
  { id: "board", group: "mission", label: "참여 게시판", icon: "board", description: "응원·후기 글을 받고 공개할 글을 고릅니다.", action: "module", moduleType: "board" },
];
