"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import styles from "./draws.module.css";
import { useEventCloseHandoff } from "../../../use-event-close-handoff";
import { readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";

// Operator screen for the event-plan draw bundle: voting teams + ranked vote
// tally, named draw programs (quota/status/module) with batched runs, and the
// cross-program duplicate rule. Every write goes through the idempotent event
// command path; the server re-checks role, membership, and feature flags.

type Team = { id: string; name: string; order: number };
type Participant = { id: string; name: string; company: string; group: string; status: string; revoked: boolean };
type ProgramTierDraft = { key: string; name: string; count: string };
type RoulettePrizeDraft = { id: string; label: string; quantity: string; unlimited: boolean; weight: string };
type DrawProgram = {
  id: string;
  name: string;
  quota: number;
  moduleId: string;
  status: string;
  published: boolean;
  eligibility: "PERSON" | "COMPANY";
  eligibleGroups: string[];
  eligibleCompanies: string[];
  overlap: "EVENT" | "PROGRAM" | "NONE";
  prizeTiers: Array<{ name: string; count: number }>;
  winners: Array<{ id?: string; name: string; company: string; kind?: "PERSON" | "COMPANY"; tier?: string; luckyNumber?: number | null }>;
  drawnAt: string;
};
type DrawModule = { id: string; title: string; status: string; published: boolean };
type VoteConfig = { pickCount: number; status: "OPEN" | "CLOSED"; resultsPublished: boolean };
type RouletteConfig = {
  status: "DRAFT" | "OPEN" | "CLOSED";
  startsAt: string | null;
  endsAt: string | null;
  prizes: RoulettePrizeDraft[];
};
type VoteTally = {
  results: Array<{ teamId: string; name: string; selections: number; rank: number; tied: boolean }>;
  totalVotes: number;
  published: boolean;
} | null;
type RewardRecord = {
  id: string;
  name: string;
  company: string;
  participantId: string;
  status: string;
  sourceKind: string;
  sourceProgramId: string;
  winnerIndex: number | null;
};

// Names the section in view for the jump-nav readout.
const DRAW_SECTION_LABELS: Record<string, string> = {
  "draws-programs": "무대 추첨",
  "draws-vote": "순위 투표",
  "draws-roulette": "모바일 룰렛",
  "draws-lucky": "럭키번호",
};

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      closeSnapshot: CloseSnapshot;
      eventName: string;
      eventMeta?: string;
      archived: boolean;
      features: string[];
      canManage: boolean;
      drawEnabled: boolean;
      pollEnabled: boolean;
      rewardEnabled: boolean;
      teams: Team[];
      participants: Participant[];
      drawPrograms: DrawProgram[];
      drawModules: DrawModule[];
      voteConfig: VoteConfig;
      voteTally: VoteTally;
      voteTotal: number;
      luckyIssued: number;
      luckyNumbers: Array<{ participantId: string; number: number }>;
      luckyMin: number;
      luckyMax: number;
      rouletteSpun: number;
      rouletteConfig: RouletteConfig;
      rouletteUsedById: Record<string, number>;
      rewards: RewardRecord[];
    };

type Failure = { message: string; field: string | null };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function randomId(prefix: string): string {
  if (typeof crypto.randomUUID === "function") return `${prefix}-${crypto.randomUUID()}`;
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function localDateTime(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}

function isoFromLocalDateTime(value: string): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export default function DrawsWorkspace({ eventId }: { eventId: string }) {
  const closeHref = useEventCloseHandoff(eventId);
  const router = useRouter();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [activeSection, setActiveSection] = useState("draws-programs");
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // One grammar for the commands that cannot be undone: the screen states
  // the effect, the operator confirms in place.
  const [programFormOpen, setProgramFormOpen] = useState(false);
  // Validated roulette settings travel with the confirmation, so the saved
  // values are the ones the summary was based on.
  const roulettePayloadRef = useRef<{
    prizes: Array<{ id: string; label: string; quantity: number | null; weight?: number }>;
    startsAt: string;
    endsAt: string;
  } | null>(null);
  const [pendingConfirm, setPendingConfirm] = useState<
    | { kind: "programStatus"; program: DrawProgram; status: "DRAFT" | "OPEN" | "CLOSED"; summary: string }
    | { kind: "run"; program: DrawProgram; count: number; toStage: boolean; summary: string }
    | { kind: "lucky"; summary: string }
    | { kind: "roulette"; summary: string }
  | null>(null);
  const [teamName, setTeamName] = useState("");
  const [programName, setProgramName] = useState("");
  const [programQuota, setProgramQuota] = useState("");
  const [programModuleId, setProgramModuleId] = useState("");
  const [editingProgramId, setEditingProgramId] = useState<string | null>(null);
  const [programEligibility, setProgramEligibility] = useState<"PERSON" | "COMPANY">("PERSON");
  const [programGroups, setProgramGroups] = useState<string[]>([]);
  const [programCompanies, setProgramCompanies] = useState<string[]>([]);
  const [programOverlap, setProgramOverlap] = useState<"EVENT" | "PROGRAM" | "NONE">("EVENT");
  const [programTiers, setProgramTiers] = useState<ProgramTierDraft[]>([]);
  const [groupDraft, setGroupDraft] = useState("");
  const [companyDraft, setCompanyDraft] = useState("");
  const [runCounts, setRunCounts] = useState<Record<string, string>>({});
  const [votePickCount, setVotePickCount] = useState("5");
  const [voteStatus, setVoteStatus] = useState<"OPEN" | "CLOSED">("CLOSED");
  const [voteResultsPublished, setVoteResultsPublished] = useState(false);
  const [luckyMin, setLuckyMin] = useState("1");
  const [luckyMax, setLuckyMax] = useState("900");
  const [preassignAllApproved, setPreassignAllApproved] = useState(false);
  const [rouletteStatus, setRouletteStatus] = useState<"DRAFT" | "OPEN" | "CLOSED">("DRAFT");
  const [rouletteStartsAt, setRouletteStartsAt] = useState("");
  const [rouletteEndsAt, setRouletteEndsAt] = useState("");
  const [roulettePrizes, setRoulettePrizes] = useState<RoulettePrizeDraft[]>([
    { id: randomId("prize"), label: "", quantity: "", unlimited: false, weight: "" },
  ]);
  const [rewardRecipient, setRewardRecipient] = useState<Record<string, string>>({});
  const [tallyLoading, setTallyLoading] = useState(false);
  // A lost response must replay the same receipt, not start another draw.
  const pendingCommands = useRef(new Map<string, string>());
  const programFormRef = useRef<HTMLFormElement>(null);

  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 쓰기 affordance를
  // 잠그고 읽기만 둡니다. 역할·멤버십 게이트는 그대로 둡니다.
  const writeLocked = state.kind === "ready" && state.archived;

  // Cross-route guard predicates: actual editing diffs plus retained
  // idempotent keys (an ambiguous outcome whose same-request retry is still
  // available). Read-only filters and the section picker stay unguarded;
  // clean saves delete their keys and reset their inputs, so they warn
  // nothing.
  //
  // A default empty prize row is not an edit: it is filtered before the
  // baseline compare so a pristine view stays clean, while any real input
  // (including a half-filled row) still guards.
  const normalizedPrizes = roulettePrizes
    .filter((prize) => prize.label.trim() !== "" || prize.quantity !== "" || prize.weight !== "" || prize.unlimited)
    .map((prize) => ({ ...prize, label: prize.label.trim() }));
  const drawsDirty = state.kind === "ready" && (
    teamName.trim() !== "" ||
    editingProgramId !== null ||
    programName.trim() !== "" || programQuota !== "" || programModuleId !== "" ||
    programTiers.length > 0 || programGroups.length > 0 || programCompanies.length > 0 ||
    groupDraft.trim() !== "" || companyDraft.trim() !== "" ||
    programEligibility !== "PERSON" || programOverlap !== "EVENT" ||
    votePickCount !== String(state.voteConfig.pickCount) ||
    voteStatus !== state.voteConfig.status ||
    voteResultsPublished !== state.voteConfig.resultsPublished ||
    luckyMin !== String(state.luckyMin) || luckyMax !== String(state.luckyMax) ||
    rouletteStatus !== state.rouletteConfig.status ||
    rouletteStartsAt !== localDateTime(state.rouletteConfig.startsAt) ||
    rouletteEndsAt !== localDateTime(state.rouletteConfig.endsAt) ||
    JSON.stringify(normalizedPrizes) !== JSON.stringify(state.rouletteConfig.prizes) ||
    pendingCommands.current.size > 0
  );
  useConsoleDraftGuard(drawsDirty, "작성 중인 추첨·투표 설정이 있습니다.");

  async function load(silent = false) {
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/bootstrap", { cache: "no-store" }),
      ]);
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(loginHrefForLocation(window.location.pathname, window.location.search));
        return;
      }
      const me = (await meRes.json().catch(() => null)) as {
        user?: { id?: unknown; role?: unknown } | null;
      } | null;
      const boot = (await bootRes.json().catch(() => null)) as {
        state?: {
          events?: unknown;
          clients?: unknown;
          memberships?: unknown;
          workspaces?: Record<string, unknown>;
        } | null;
      } | null;
      const bootstrap = boot?.state;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        setState({ kind: "failed", message: "추첨·투표 정보를 불러오지 못했습니다." });
        return;
      }
      const role = typeof me.user.role === "string" ? me.user.role : "";
      const myId = typeof me.user.id === "string" ? me.user.id : "";
      const memberships: Array<{ accountId: string; eventId: string }> = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((item) => {
            const membership = asRecord(item);
            if (!membership || typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
            return [{ accountId: membership.accountId, eventId: membership.eventId }];
          })
        : [];
      const canManage =
        role === "AGENCY" ||
        (role === "MANAGER" &&
          memberships.some((membership) => membership.accountId === myId && membership.eventId === eventId));
      const event = Array.isArray(bootstrap.events)
        ? bootstrap.events.flatMap((item) => {
            const record = asRecord(item);
            return record && record.id === eventId ? [record] : [];
          })[0]
        : undefined;
      const workspace = asRecord(bootstrap.workspaces?.[eventId]);
      if (!event || !workspace) {
        setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        return;
      }
      const clientName = Array.isArray(bootstrap.clients)
        ? bootstrap.clients
            .map(asRecord)
            .find((client) => client?.id === event.clientId)?.name
        : "";
      const venue = asRecord(workspace.venue);
      const teams: Team[] = Array.isArray(workspace.teams)
        ? workspace.teams.flatMap((item) => {
            const team = asRecord(item);
            if (!team || typeof team.id !== "string" || typeof team.name !== "string") return [];
            return [{ id: team.id, name: team.name, order: Number(team.order) || 0 }];
          }).sort((a, b) => a.order - b.order)
        : [];
      const participants: Participant[] = Array.isArray(workspace.participants)
        ? workspace.participants.flatMap((item) => {
            const person = asRecord(item);
            if (!person || typeof person.id !== "string") return [];
            return [{
              id: person.id,
              name: text(person.name, "이름 없음"),
              company: text(person.company),
              group: text(person.group),
              status: text(person.status).toUpperCase(),
              revoked: person.revoked === true,
            }];
          })
        : [];
      const drawPrograms: DrawProgram[] = Array.isArray(workspace.drawPrograms)
        ? workspace.drawPrograms.flatMap((item) => {
            const program = asRecord(item);
            if (!program || typeof program.id !== "string") return [];
            const winners = Array.isArray(program.winners)
              ? program.winners.flatMap((winner) => {
                  const entry = asRecord(winner);
                  if (!entry || typeof entry.name !== "string") return [];
                    const kind: "PERSON" | "COMPANY" | undefined =
                      entry.kind === "PERSON" || entry.kind === "COMPANY" ? entry.kind : undefined;
                    return [{
                      id: typeof entry.id === "string" ? entry.id : undefined,
                      name: entry.name,
                      company: text(entry.company),
                      ...(kind ? { kind } : {}),
                      ...(typeof entry.tier === "string" ? { tier: entry.tier } : {}),
                      ...(typeof entry.luckyNumber === "number" || entry.luckyNumber === null
                        ? { luckyNumber: entry.luckyNumber as number | null }
                        : {}),
                    }];
                })
              : [];
            return [{
              id: program.id,
              name: text(program.name, "이름 없는 추첨"),
              quota: typeof program.quota === "number" ? program.quota : 0,
              moduleId: text(program.moduleId),
              status: text(program.status, "DRAFT"),
              published: program.published === true,
              eligibility: program.eligibility === "COMPANY" ? "COMPANY" : "PERSON",
              eligibleGroups: Array.isArray(program.eligibleGroups) ? program.eligibleGroups.filter((item): item is string => typeof item === "string") : [],
              eligibleCompanies: Array.isArray(program.eligibleCompanies) ? program.eligibleCompanies.filter((item): item is string => typeof item === "string") : [],
              overlap: program.overlap === "PROGRAM" || program.overlap === "NONE" ? program.overlap : "EVENT",
              prizeTiers: Array.isArray(program.prizeTiers)
                ? program.prizeTiers.flatMap((item) => {
                    const tier = asRecord(item);
                    if (!tier || typeof tier.name !== "string" || typeof tier.count !== "number") return [];
                    return [{ name: tier.name, count: tier.count }];
                  })
                : [],
              winners,
              drawnAt: text(program.drawnAt),
            }];
          })
        : [];
      const drawModules: DrawModule[] = Array.isArray(workspace.modules)
        ? workspace.modules.flatMap((item) => {
            const module = asRecord(item);
            if (!module || module.type !== "draw" || typeof module.id !== "string") return [];
            return [{
              id: module.id,
              title: text(module.title, "제목 없는 추첨"),
              status: text(module.status, "DRAFT"),
              published: module.published === true,
            }];
          })
        : [];
      const voteConfigSource = asRecord(workspace.voteConfig);
      const voteConfig: VoteConfig = {
        pickCount: typeof voteConfigSource?.pickCount === "number" ? voteConfigSource.pickCount : 5,
        status: voteConfigSource?.status === "OPEN" ? "OPEN" : "CLOSED",
        resultsPublished: voteConfigSource?.resultsPublished === true,
      };
      let voteTotal = 0;
      if (Array.isArray(workspace.votes)) {
        for (const item of workspace.votes) {
          const vote = asRecord(item);
          if (!vote || !Array.isArray(vote.picks)) continue;
          voteTotal += 1;
        }
      }
      const luckyNumbers = Array.isArray(workspace.luckyNumbers)
        ? workspace.luckyNumbers.flatMap((item) => {
            const number = asRecord(item);
            if (!number || typeof number.participantId !== "string" || typeof number.number !== "number") return [];
            return [{ participantId: number.participantId, number: number.number }];
          })
        : [];
      const luckyConfigSource = asRecord(workspace.luckyConfig);
      const luckyMin = typeof luckyConfigSource?.min === "number" ? luckyConfigSource.min : 1;
      const luckyMax = typeof luckyConfigSource?.max === "number" ? luckyConfigSource.max : 900;
      const rouletteConfigSource = asRecord(workspace.rouletteConfig);
      const rouletteConfig: RouletteConfig = {
        status: rouletteConfigSource?.status === "OPEN"
          ? "OPEN"
          : rouletteConfigSource?.status === "CLOSED" ? "CLOSED" : "DRAFT",
        startsAt: typeof rouletteConfigSource?.startsAt === "string" ? rouletteConfigSource.startsAt : null,
        endsAt: typeof rouletteConfigSource?.endsAt === "string" ? rouletteConfigSource.endsAt : null,
        prizes: Array.isArray(rouletteConfigSource?.prizes)
          ? rouletteConfigSource.prizes.flatMap((item) => {
              const prize = asRecord(item);
              if (!prize || typeof prize.id !== "string" || typeof prize.label !== "string") return [];
              const unlimited = prize.quantity === null;
              return [{
                id: prize.id,
                label: prize.label,
                quantity: unlimited ? "" : typeof prize.quantity === "number" ? String(prize.quantity) : "",
                unlimited,
                weight: typeof prize.weight === "number" ? String(prize.weight) : "",
              }];
            })
          : [],
      };
      const rouletteUsedById: Record<string, number> = {};
      if (Array.isArray(workspace.rouletteResults)) {
        for (const item of workspace.rouletteResults) {
          const result = asRecord(item);
          if (typeof result?.prizeId === "string") {
            rouletteUsedById[result.prizeId] = (rouletteUsedById[result.prizeId] ?? 0) + 1;
          }
        }
      }
      const rouletteSpun = Array.isArray(workspace.rouletteResults) ? workspace.rouletteResults.length : 0;
      const rewards: RewardRecord[] = Array.isArray(workspace.rewards)
        ? workspace.rewards.flatMap((item) => {
            const reward = asRecord(item);
            if (!reward || typeof reward.id !== "string") return [];
            const source = asRecord(reward.source);
            return [{
              id: reward.id,
              name: text(reward.name),
              company: text(reward.company),
              participantId: text(reward.participantId),
              status: text(reward.status),
              sourceKind: text(source?.kind),
              sourceProgramId: text(source?.programId),
              winnerIndex: typeof source?.winnerIndex === "number" ? source.winnerIndex : null,
            }];
          })
        : [];
      const features = Array.isArray(event.features)
        ? event.features.filter((feature): feature is string => typeof feature === "string")
        : [];
      if (!silent) {
        setVotePickCount(String(voteConfig.pickCount));
        setVoteStatus(voteConfig.status);
        setVoteResultsPublished(voteConfig.resultsPublished);
        setLuckyMin(String(luckyMin));
        setLuckyMax(String(luckyMax));
        setRouletteStatus(rouletteConfig.status);
        setRouletteStartsAt(localDateTime(rouletteConfig.startsAt));
        setRouletteEndsAt(localDateTime(rouletteConfig.endsAt));
        setRoulettePrizes(rouletteConfig.prizes.length
          ? rouletteConfig.prizes
          : [{ id: randomId("prize"), label: "", quantity: "", unlimited: false, weight: "" }]);
        setPreassignAllApproved(false);
      }
      setState({
        kind: "ready",
        closeSnapshot: readCloseSnapshot(event, workspace),
        eventName: text(event.name, eventId),
        eventMeta: formatConsoleEventMeta({
          clientName: text(clientName),
          date: text(event.date),
          start: text(event.start),
          end: text(event.end),
          venue: text(venue?.name),
        }),
        archived: text(event.stage).toUpperCase() === "ARCHIVED",
        features,
        canManage,
        drawEnabled: features.includes("draw"),
        pollEnabled: features.includes("poll"),
        rewardEnabled: features.includes("reward"),
        teams,
        participants,
        drawPrograms,
        drawModules,
        voteConfig,
        voteTally: null,
        voteTotal,
        luckyIssued: luckyNumbers.length,
        luckyNumbers,
        luckyMin,
        luckyMax,
        rouletteSpun,
        rouletteConfig,
        rouletteUsedById,
        rewards,
      });
    } catch {
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  useEffect(() => {
    pendingCommands.current.clear();
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  // Names the section in view for the jump-nav readout. Anchor clicks keep
  // working natively whether or not the observer is available.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = Object.keys(DRAW_SECTION_LABELS);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setActiveSection(entry.target.id);
        }
      },
      { rootMargin: "-30% 0px -60% 0px" }
    );
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [state]);

  async function postCommand(command: string, payload: Record<string, unknown>, intent = ""): Promise<Record<string, unknown>> {
    const attempt = JSON.stringify([eventId, command, payload, intent]);
    let commandId = pendingCommands.current.get(attempt);
    if (!commandId) {
      commandId = randomCommandId();
      pendingCommands.current.set(attempt, commandId);
    }
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId, command, payload }),
    }).catch(() => {
      throw new Error("서버 응답을 확인하지 못했습니다. 같은 작업을 다시 시도해 결과를 확인하세요.");
    });
    const data = asRecord(await response.json().catch(() => null));
    if (!response.ok) {
      // 408 leaves the outcome unknown like 5xx: keep the bound id so a
      // retry replays the receipt instead of starting a second draw.
      if (response.status < 500 && response.status !== 408) pendingCommands.current.delete(attempt);
      throw new Error(typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.");
    }
    if (!data) throw new Error("서버 응답을 확인하지 못했습니다. 같은 작업을 다시 시도하세요.");
    pendingCommands.current.delete(attempt);
    return data;
  }

  async function addTeam(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (state.kind !== "ready" || !teamName.trim() || busy) return;
    if (state.voteTotal > 0) {
      setFailure("첫 투표가 접수되어 팀 구성을 바꿀 수 없습니다.");
      return;
    }
    setBusy("team:add");
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("team.save", { name: teamName.trim() });
      setTeamName("");
      setNotice("투표 팀을 등록했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "팀을 등록하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function saveProgram(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (state.kind !== "ready" || !programName.trim() || busy) return;
    const quota = Number(programQuota);
    if (!Number.isInteger(quota) || quota < 1 || quota > 10000) {
      setFailure("당첨 인원을 1~10000명으로 입력하세요.");
      return;
    }
    if (!programModuleId) {
      setFailure("추첨용 draw 프로그램을 먼저 선택하세요.");
      return;
    }
    const tiers = programTiers.map((tier) => ({ name: tier.name.trim(), count: Number(tier.count) }));
    if (programTiers.length && (
      tiers.some((tier) => !tier.name || !Number.isInteger(tier.count) || tier.count < 1 || tier.count > 10000) ||
      tiers.reduce((sum, tier) => sum + tier.count, 0) !== quota
    )) {
      setFailure("상품 등급별 인원은 1명 이상이며, 합계가 전체 당첨 인원과 같아야 합니다.");
      return;
    }
    const existing = editingProgramId
      ? state.drawPrograms.find((program) => program.id === editingProgramId)
      : null;
    if (existing?.winners.length) {
      setFailure("첫 당첨 이후에는 대상·쿼터·등급 설정을 변경할 수 없습니다.");
      return;
    }
    setBusy("program:save");
    setNotice(null);
    setFailure(null);
    try {
      const payload: Record<string, unknown> = {
        name: programName.trim(),
        quota,
        moduleId: programModuleId,
        eligibility: programEligibility,
        eligibleGroups: programGroups,
        eligibleCompanies: programCompanies,
        overlap: programOverlap,
        prizeTiers: tiers.length ? tiers : null,
      };
      if (editingProgramId) {
        payload.id = editingProgramId;
        if (existing) payload.status = existing.status;
      }
      await postCommand("draw.program.save", payload);
      setProgramName("");
      setProgramQuota("");
      setProgramModuleId("");
      setProgramEligibility("PERSON");
      setProgramGroups([]);
      setProgramCompanies([]);
      setProgramTiers([]);
      setGroupDraft("");
      setCompanyDraft("");
      setProgramOverlap("EVENT");
      setEditingProgramId(null);
      setNotice(editingProgramId ? "추첨 프로그램을 저장했습니다." : "추첨 프로그램을 만들었습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "추첨 프로그램을 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  function requestProgramStatus(program: DrawProgram, status: "DRAFT" | "OPEN" | "CLOSED") {
    if (writeLocked) return;
    setPendingConfirm({
      kind: "programStatus",
      program,
      status,
      summary: `“${program.name}” 추첨을 ${status === "OPEN" ? "시작" : status === "CLOSED" ? "종료" : "준비로 되돌릴까요"}?`,
    });
  }

  async function setProgramStatus(program: DrawProgram, status: "DRAFT" | "OPEN" | "CLOSED") {
    if (writeLocked) return;
    setBusy(`program:${program.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("draw.program.save", {
        id: program.id,
        status,
        published: status === "OPEN" ? true : status === "DRAFT" ? false : program.published,
      });
      setNotice("추첨 상태를 바꿨습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "상태를 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function setProgramPublished(program: DrawProgram, published: boolean) {
    if (writeLocked) return;
    setBusy(`publish:${program.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("draw.program.save", { id: program.id, status: program.status, published });
      setNotice(published ? "추첨 결과를 공개했습니다." : "참가자·전광판 결과를 숨겼습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "공개 상태를 바꾸지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  function selectedRunCount(program: DrawProgram): number | null {
    const remaining = program.quota - program.winners.length;
    const count = Number(runCounts[program.id] ?? "1");
    if (!Number.isInteger(count) || count < 1 || count > 20 || count > remaining) return null;
    return count;
  }

  function drawIntent(program: DrawProgram, count: number, toStage: boolean): string {
    // Repeating after an ambiguous response reuses the same command receipt.
    // A later intentional run starts a distinct receipt after winner count changes.
    return JSON.stringify([program.winners.length, count, toStage]);
  }

  async function runProgram(program: DrawProgram, toStage = false) {
    if (writeLocked) return;
    const remaining = program.quota - program.winners.length;
    if (remaining <= 0) {
      setFailure("이미 추첨이 완료된 프로그램입니다.");
      return;
    }
    const count = selectedRunCount(program);
    if (count === null) {
      setFailure(`이번 실행 인원은 1~${Math.min(20, remaining)}명으로 입력하세요.`);
      return;
    }
    const overlapCopy = program.overlap === "EVENT"
      ? "행사 안에서 이미 당첨된 참가자와 업체는 제외됩니다."
      : program.overlap === "PROGRAM"
        ? "이 프로그램에서 이미 당첨된 참가자와 업체만 제외됩니다."
        : "중복 당첨을 허용합니다.";
    const actionCopy = toStage ? "추첨하고 전광판에 결과를 표시" : "추첨";
    setPendingConfirm({
      kind: "run",
      program,
      count,
      toStage,
      summary: `“${program.name}”을 ${count}명 ${actionCopy}할까요? ${overlapCopy}`,
    });
  }

  async function runProgramConfirmed(program: DrawProgram, count: number, toStage: boolean) {
    const remaining = program.quota - program.winners.length;
    setBusy(`${toStage ? "stage" : "run"}:${program.id}`);
    setNotice(null);
    setFailure(null);
    try {
      const payload = { id: program.id, count, ...(toStage ? { showOnScreen: true } : {}) };
      const data = await postCommand("draw.program.run", payload, drawIntent(program, count, toStage));
      const winners = Array.isArray((data as { winners?: unknown }).winners)
        ? ((data as { winners: Array<{ name?: unknown }> }).winners.length)
        : 0;
      setNotice(toStage
        ? `${winners}명 결과를 추첨해 전광판에 표시했습니다.${remaining - winners > 0 ? ` 남은 인원 ${remaining - winners}명은 다음 터치에서 추첨하세요.` : ""}`
        : `${winners}명 결과를 추첨했습니다.${remaining - winners > 0 ? ` 남은 인원 ${remaining - winners}명은 다음 실행에서 추첨하세요.` : ""}`);
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "추첨을 실행하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function saveVoteConfig(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (state.kind !== "ready" || busy) return;
    const pickCount = Number(votePickCount);
    if (!Number.isInteger(pickCount) || pickCount < 1 || pickCount > 20) {
      setFailure("참가자가 선택할 팀 수를 1~20개로 입력하세요.");
      return;
    }
    if (voteStatus === "OPEN" && state.teams.length < pickCount) {
      setFailure(`투표를 열려면 최소 ${pickCount}개 팀을 먼저 등록하세요.`);
      return;
    }
    if (state.voteTotal > 0 && pickCount !== state.voteConfig.pickCount) {
      setFailure("첫 투표가 접수되어 선택할 팀 수를 바꿀 수 없습니다.");
      return;
    }
    setBusy("vote:save");
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("vote.config.save", {
        pickCount,
        status: voteStatus,
        resultsPublished: voteResultsPublished,
      });
      setNotice("투표 설정을 저장했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "투표 설정을 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function refreshVoteTally() {
    if (writeLocked) return;
    if (tallyLoading || busy) return;
    setTallyLoading(true);
    setFailure(null);
    try {
      const data = await postCommand("vote.tally", {}, "operator-tally");
      const results = Array.isArray(data.results)
        ? data.results.flatMap((item) => {
            const row = asRecord(item);
            if (!row || typeof row.teamId !== "string" || typeof row.name !== "string") return [];
            return [{
              teamId: row.teamId,
              name: row.name,
              selections: typeof row.selections === "number" ? row.selections : 0,
              rank: typeof row.rank === "number" ? row.rank : 0,
              tied: row.tied === true,
            }];
          })
        : [];
      setState((current) => current.kind === "ready" ? {
        ...current,
        voteTally: {
          results,
          totalVotes: typeof data.totalVotes === "number" ? data.totalVotes : 0,
          published: data.published === true,
        },
      } : current);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "투표 집계를 불러오지 못했습니다.");
    } finally {
      setTallyLoading(false);
    }
  }

  async function saveLuckyConfig(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (busy) return;
    const min = Number(luckyMin);
    const max = Number(luckyMax);
    if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min || max > 999999) {
      setFailure("번호 범위는 1~999999의 정수이며 최소 번호가 최대 번호보다 클 수 없습니다.");
      return;
    }
    setBusy("lucky:save");
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("lucky.config.save", { min, max });
      setNotice("럭키번호 범위를 저장했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "번호 범위를 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function preassignLuckyNumbers() {
    if (writeLocked) return;
    if (state.kind !== "ready" || !preassignAllApproved || busy) return;
    const approved = state.participants.filter((person) => person.status === "APPROVED" && !person.revoked);
    if (!approved.length) {
      setFailure("번호를 배정할 승인 참가자가 없습니다.");
      return;
    }
    setPendingConfirm({
      kind: "lucky",
      summary: `승인 참가자 ${approved.length}명에게 럭키번호를 배정할까요? 이미 번호가 있는 참가자의 번호는 유지됩니다.`,
    });
  }

  async function preassignLuckyNumbersConfirmed() {
    if (state.kind !== "ready") return;
    const approved = state.participants.filter((person) => person.status === "APPROVED" && !person.revoked);
    setBusy("lucky:preassign");
    setNotice(null);
    setFailure(null);
    try {
      const data = await postCommand("lucky.preassign", {
        participantIds: approved.map((person) => person.id),
      });
      const assigned = Array.isArray(data.assigned) ? data.assigned.length : 0;
      const skipped = typeof data.skipped === "number" ? data.skipped : 0;
      setNotice(`${assigned}명에게 번호를 배정했습니다.${skipped ? ` 기존 번호 ${skipped}명은 유지했습니다.` : ""}`);
      setPreassignAllApproved(false);
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "승인 참가자 번호 배정에 실패했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function saveRouletteConfig(event: React.FormEvent) {
    event.preventDefault();
    if (writeLocked) return;
    if (busy) return;
    if (!roulettePrizes.length || roulettePrizes.length > 20) {
      setFailure("룰렛 경품을 1~20개 등록하세요.");
      return;
    }
    const prizes: Array<{ id: string; label: string; quantity: number | null; weight?: number }> = [];
    for (const [index, prize] of roulettePrizes.entries()) {
      const label = prize.label.trim();
      if (!label) {
        setFailure(`경품 ${index + 1}의 이름을 입력하세요.`);
        return;
      }
      if (prize.unlimited) {
        const weight = Number(prize.weight);
        if (!Number.isInteger(weight) || weight <= 0 || weight > 1000000) {
          setFailure(`“${label}” 무제한 경품에는 1 이상의 정수 가중치가 필요합니다.`);
          return;
        }
        prizes.push({ id: prize.id, label, quantity: null, weight });
      } else {
        const quantity = Number(prize.quantity);
        if (prize.quantity.trim() === "" || !Number.isInteger(quantity) || quantity < 0 || quantity > 100000) {
          setFailure(`“${label}”의 재고 수량을 0~100000의 정수로 입력하세요. 무제한이면 해당 항목을 명시적으로 선택하세요.`);
          return;
        }
        const finitePrize: { id: string; label: string; quantity: number; weight?: number } = { id: prize.id, label, quantity };
        if (prize.weight.trim() !== "") {
          const weight = Number(prize.weight);
          if (!Number.isInteger(weight) || weight < 0 || weight > 1000000) {
            setFailure(`“${label}”의 가중치는 0~1000000의 정수로 입력하세요.`);
            return;
          }
          finitePrize.weight = weight;
        }
        prizes.push(finitePrize);
      }
    }
    const startsAt = isoFromLocalDateTime(rouletteStartsAt);
    const endsAt = isoFromLocalDateTime(rouletteEndsAt);
    if ((rouletteStartsAt && !startsAt) || (rouletteEndsAt && !endsAt)) {
      setFailure("룰렛 운영 시간을 확인하세요.");
      return;
    }
    if (startsAt && endsAt && Date.parse(startsAt) >= Date.parse(endsAt)) {
      setFailure("종료 시간은 시작 시간 이후여야 합니다.");
      return;
    }
    if (rouletteStatus === "OPEN" && prizes.every((prize) => prize.quantity === 0)) {
      setFailure("룰렛을 열려면 재고가 있는 경품 또는 가중치를 지정한 무제한 경품이 필요합니다.");
      return;
    }
    if (rouletteStatus === "OPEN" && state.kind === "ready" && state.rouletteConfig.status !== "OPEN") {
      setPendingConfirm({
        kind: "roulette",
        summary: "룰렛을 열면 참가자가 즉시 참여할 수 있고 결과가 1회 저장됩니다. 지금 운영을 시작할까요?",
      });
      roulettePayloadRef.current = { prizes, startsAt: startsAt ?? "", endsAt: endsAt ?? "" };
      return;
    }
    await saveRouletteConfigConfirmed(prizes, startsAt ?? "", endsAt ?? "");
  }

  async function saveRouletteConfigConfirmed(
    prizes: Array<{ id: string; label: string; quantity: number | null; weight?: number }>,
    startsAt: string,
    endsAt: string
  ) {
    setBusy("roulette:save");
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("roulette.config.save", {
        prizes,
        status: rouletteStatus,
        startsAt,
        endsAt,
      });
      setNotice("룰렛 경품과 운영 상태를 저장했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "룰렛 설정을 저장하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function assignCompanyRecipient(reward: RewardRecord) {
    const participantId = rewardRecipient[reward.id];
    if (writeLocked) return;
    if (!participantId || busy) return;
    setBusy(`reward:${reward.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("reward.assign", { id: reward.id, participantId });
      setNotice("당첨 업체의 수령자를 지정했습니다.");
      await load(true);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "수령자를 지정하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="draws" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="추첨·투표 정보를 불러오고 있습니다." onRetry={() => load()} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="draws" eventId={eventId}>
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => load()}
        />
      </ConsolePage>
    );
  }

  const approvedParticipants = state.participants.filter((person) => person.status === "APPROVED" && !person.revoked);
  const assignedLuckyIds = new Set(state.luckyNumbers.map((item) => item.participantId));
  const missingLuckyCount = approvedParticipants.filter((person) => !assignedLuckyIds.has(person.id)).length;
  const luckyPoolSize = state.luckyMax - state.luckyMin + 1;
  const luckyAvailable = Math.max(0, luckyPoolSize - state.luckyIssued);
  const rouletteFrozen = state.rouletteSpun > 0;
  const groupOptions = [...new Set(state.participants.map((person) => person.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const companyOptions = [...new Set(state.participants.map((person) => person.company).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ko"));
  const configuredTierTotal = programTiers.reduce((sum, tier) => sum + (Number(tier.count) || 0), 0);
  const screenEnabled = state.features.includes("screen");

  return (
    <ConsolePage
      pageId="draws"
      closeSnapshot={state.closeSnapshot}
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      sectionNav={
        <div className={styles.navSticky}>
          <ConsoleSectionNav
            label="추첨·투표 구역"
            items={[
              { id: "draws-programs", label: "무대 추첨" },
              { id: "draws-vote", label: "순위 투표" },
              { id: "draws-roulette", label: "모바일 룰렛" },
              { id: "draws-lucky", label: "럭키번호" },
            ]}
          />
          <p className={styles.navNow}>현재 위치: {DRAW_SECTION_LABELS[activeSection] || "무대 추첨"}</p>
        </div>
      }
      feedback={
        <>
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
          {state.canManage && state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 설정과 결과를 볼 수 있지만 바꿀 수 없습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >

      {pendingConfirm ? (
        <ConsoleConfirm
          summary={pendingConfirm.kind === "programStatus"
            ? `“${pendingConfirm.program.name}” 추첨을 ${pendingConfirm.status === "OPEN" ? "시작" : pendingConfirm.status === "CLOSED" ? "종료" : "준비로 되돌릴까요"}?`
            : pendingConfirm.kind === "run"
              ? pendingConfirm.summary
              : pendingConfirm.kind === "lucky"
                ? pendingConfirm.summary
                : pendingConfirm.summary}
          confirmLabel={pendingConfirm.kind === "programStatus"
            ? pendingConfirm.status === "OPEN" ? "시작한다" : pendingConfirm.status === "CLOSED" ? "종료한다" : "되돌린다"
            : pendingConfirm.kind === "run"
              ? pendingConfirm.toStage ? "추첨하고 전광판에 표시" : "추첨 실행"
              : pendingConfirm.kind === "lucky" ? "번호 배정" : "룰렛 운영 시작"}
          busy={busy !== null}
          onConfirm={() => {
            const pending = pendingConfirm;
            setPendingConfirm(null);
            if (pending.kind === "programStatus") void setProgramStatus(pending.program, pending.status);
            else if (pending.kind === "run") void runProgramConfirmed(pending.program, pending.count, pending.toStage);
            else if (pending.kind === "lucky") void preassignLuckyNumbersConfirmed();
            else {
              const payload = roulettePayloadRef.current;
              roulettePayloadRef.current = null;
              if (payload) void saveRouletteConfigConfirmed(payload.prizes, payload.startsAt, payload.endsAt);
            }
          }}
          onCancel={() => setPendingConfirm(null)}
        />
      ) : null}

      <ConsoleSection headingId="draws-programs" title={`무대 추첨 · ${state.drawPrograms.length}개`}>
        {!state.drawEnabled ? <p className={styles.featureOff}>이 행사에서 무대 추첨 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>실행 인원은 매번 1~20명으로 지정합니다(기본 1명). 프로그램 대상·쿼터·등급은 첫 당첨 뒤 잠기고, 공개 여부는 별도로 관리합니다.</p>
            {!screenEnabled && state.canManage ? (
              <p className={styles.stagePrerequisite} id="stage-screen-prerequisite">
                무대 터치 실행은 당첨 결과·경품 생성과 전광판 선택을 한 번에 저장합니다. 사용 전 <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/settings#settings-features`)}>행사 설정에서 행사장 출력을 켜세요.</Link>
              </p>
            ) : null}
            {!state.drawModules.some((module) => module.published) && !state.drawPrograms.length && state.canManage ? (
              <p className={styles.stagePrerequisite}>
                {state.drawModules.length
                  ? <>무대 터치 실행에는 공개된 추첨 무대가 필요합니다. 기존 비공개 결과는 자동 공개하지 않습니다. <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 프로그램에서 무대 운영을 시작해 공개하세요.</Link></>
                  : <>추첨 프로그램을 만들려면 먼저 <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 프로그램에서 추첨 무대를 만들고 공개하세요.</Link> 공개 상태로 전환한 무대만 여기에 연결할 수 있습니다.</>}
              </p>
            ) : null}
            {state.drawPrograms.length ? (
              <ul className={styles.programList}>
                {state.drawPrograms.map((program) => {
                  const remaining = Math.max(program.quota - program.winners.length, 0);
                  const runCount = Number(runCounts[program.id] ?? "1");
                  const countLimit = Math.min(20, remaining);
                  const runCountValid = Number.isInteger(runCount) && runCount >= 1 && runCount <= countLimit;
                  const canRun = program.status === "OPEN" && program.published && remaining > 0 && runCountValid;
                  const linkedModule = state.drawModules.find((module) => module.id === program.moduleId);
                  const moduleTitle = linkedModule?.title ?? "무대 추첨";
                  const moduleNeedsPublishing = !linkedModule || !linkedModule.published;
                  const stagePrerequisites = [
                    !screenEnabled ? "stage-screen-prerequisite" : null,
                    moduleNeedsPublishing ? `stage-module-prerequisite-${program.id}` : null,
                  ].filter((id): id is string => id !== null);
                  // One line that says everything still missing, so a live
                  // operator does not have to combine the section notice, the
                  // row hints and the disabled state to find the blocker.
                  const runBlockers = [
                    !program.published ? "결과 공개 필요" : "",
                    !screenEnabled ? "행사장 출력 꺼짐" : "",
                    moduleNeedsPublishing ? "무대 프로그램 공개 필요" : "",
                    !runCountValid ? `실행 인원 1~${countLimit}명` : "",
                  ].filter((reason) => reason !== "");
                  const runBlockerId = `run-blockers-${program.id}`;
                  // The first unmet premise decides the next action, so the
                  // button-adjacent line names both the blocker and what
                  // resolves it. The existing "실행 전제:" line is kept and
                  // moved next to the buttons, not duplicated elsewhere.
                  const runNextAction = !program.published
                    ? "결과를 공개하면"
                    : !screenEnabled
                      ? "행사장 출력을 켜면"
                      : moduleNeedsPublishing
                        ? "무대 프로그램을 공개하면"
                        : `실행 인원을 1~${countLimit}명 범위로 고치면`;
                  return (
                    <li key={program.id} id={`draw-program-${program.id}`} className={styles.programItem}>
                      <div className={styles.programTop}>
                        <strong>{program.name}</strong>
                        <span>총 {program.quota}명 · 당첨 {program.winners.length}명 · 남은 {remaining}명</span>
                      </div>
                      <div className={styles.programMeta}>
                        <span className={`${styles.status} ${program.status === "OPEN" ? styles.statusOpen : program.status === "DRAFT" ? styles.statusDraft : styles.statusClosed}`}>{program.status === "OPEN" ? "운영 중" : program.status === "DRAFT" ? "준비" : "종료"}</span>
                        <span>{program.eligibility === "COMPANY" ? "업체 추첨" : "개인 추첨"}</span>
                        <span>{program.overlap === "EVENT" ? "행사 중복 제외" : program.overlap === "PROGRAM" ? "프로그램 중복 제외" : "중복 허용"}</span>
                        <span>{program.published ? "참가자 공개" : "결과 비공개"}</span>
                        <span>{moduleTitle}</span>
                      </div>
                      {(program.eligibleGroups.length || program.eligibleCompanies.length) ? (
                        <p className={styles.programMetaText}>대상 {[
                          program.eligibleGroups.length ? `그룹 ${program.eligibleGroups.join(", ")}` : "",
                          program.eligibleCompanies.length ? `업체 ${program.eligibleCompanies.join(", ")}` : "",
                        ].filter(Boolean).join(" · ")}</p>
                      ) : <p className={styles.programMetaText}>그룹·업체 필터 없음 · 입장(체크인)한 승인 참가자 전체 대상</p>}
                      {program.prizeTiers.length ? <p className={styles.programMetaText}>등급 · {program.prizeTiers.map((tier) => `${tier.name} ${tier.count}명`).join(" · ")}</p> : null}
                      {program.winners.length ? (
                        <ul className={styles.winnerList} aria-label={`${program.name} 당첨 결과`}>
                          {program.winners.map((winner, index) => {
                            const reward = state.rewards.find((entry) => entry.sourceKind === "draw" && entry.sourceProgramId === program.id && entry.winnerIndex === index);
                            const recipient = reward?.participantId ? state.participants.find((person) => person.id === reward.participantId) : null;
                            const eligibleRecipients = winner.kind === "COMPANY"
                              ? state.participants.filter((person) => person.status === "APPROVED" && !person.revoked && person.company === winner.company)
                              : [];
                            return (
                              <li className={styles.winnerItem} key={`${program.id}-winner-${index}`}>
                                <div className={styles.winnerSummary}>
                                  <strong>{winner.name}</strong>
                                  <span>{winner.kind === "COMPANY" ? "당첨 업체" : winner.kind === "PERSON" ? "당첨 참가자" : "당첨"}{winner.tier ? ` · ${winner.tier}` : ""}{typeof winner.luckyNumber === "number" ? ` · 럭키번호 ${winner.luckyNumber}` : ""}</span>
                                </div>
                                {winner.kind === "COMPANY" ? (
                                  reward?.status === "PENDING" ? (
                                    <div className={styles.recipientAssign}>
                                      <label htmlFor={`recipient-${reward.id}`}>업체 수령자 지정</label>
                                      <div className={styles.recipientControls}>
                                        <select id={`recipient-${reward.id}`} value={rewardRecipient[reward.id] ?? ""} onChange={(event) => setRewardRecipient((items) => ({ ...items, [reward.id]: event.target.value }))}>
                                          <option value="">같은 업체 승인 참가자 선택</option>
                                          {eligibleRecipients.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}
                                        </select>
                                        <button type="button" className="button button-secondary" disabled={!rewardRecipient[reward.id] || writeLocked || busy === `reward:${reward.id}`} onClick={() => assignCompanyRecipient(reward)}>{busy === `reward:${reward.id}` ? "지정 중입니다" : "수령자 지정"}</button>
                                      </div>
                                      <p className={styles.hint}>수령자는 자동으로 정하지 않습니다. 지정 후 현장 DESK에서 수령 처리할 수 있습니다.</p>
                                    </div>
                                  ) : reward?.participantId ? (
                                    <p className={styles.programMetaText}>수령자 지정 · {recipient?.name ?? "참가 확정자"} · {reward.status === "RECEIVED" ? "수령 완료" : "수령 대기"}</p>
                                  ) : <p className={styles.programMetaText}>수령자 정보를 확인할 수 없습니다. 경품 목록에서 해당 업체의 보류 경품을 확인하세요.</p>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      ) : <p className={styles.programWinners}>아직 추첨 결과가 없습니다.</p>}
                      {state.canManage ? (
                        <div className={styles.programActions}>
                          {!program.winners.length ? <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked} onClick={() => {
                            setProgramFormOpen(true);
                            setEditingProgramId(program.id); setProgramName(program.name); setProgramQuota(String(program.quota)); setProgramModuleId(program.moduleId);
                            setProgramEligibility(program.eligibility); setProgramGroups(program.eligibleGroups); setProgramCompanies(program.eligibleCompanies); setProgramOverlap(program.overlap);
                            setProgramTiers(program.prizeTiers.map((tier) => ({ key: randomId("tier"), name: tier.name, count: String(tier.count) })));
                            requestAnimationFrame(() => {
                              programFormRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
                            });
                          }}>설정 수정</button> : null}
                          {program.status === "DRAFT" || program.status === "CLOSED" && remaining > 0 ? <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked || !program.published && program.winners.length > 0} onClick={() => requestProgramStatus(program, "OPEN")}>{program.status === "DRAFT" ? "운영 시작" : "다시 열기"}</button> : null}
                          {program.status === "OPEN" ? <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked} onClick={() => requestProgramStatus(program, "CLOSED")}>운영 종료</button> : null}
                          {program.winners.length ? <button type="button" className="button button-secondary" disabled={busy !== null || writeLocked} onClick={() => setProgramPublished(program, !program.published)}>{program.published ? "결과 비공개" : "결과 공개"}</button> : null}
                          {program.status === "OPEN" && remaining > 0 ? (
                            <>
                              <div className={styles.runCountField}>
                                <label htmlFor={`run-count-${program.id}`}>이번 실행 인원</label>
                                <input id={`run-count-${program.id}`} type="number" min={1} max={countLimit} value={runCounts[program.id] ?? "1"} onChange={(event) => setRunCounts((values) => ({ ...values, [program.id]: event.target.value }))} />
                              </div>
                              <div className={styles.runActions} role="group" aria-label={`${program.name} 추첨 실행`}>
                                <button type="button" className="button button-primary" aria-describedby={runBlockers.length ? runBlockerId : undefined} disabled={!canRun || busy !== null || writeLocked} onClick={() => runProgram(program)}>{busy === `run:${program.id}` ? "추첨 중입니다" : `${runCount}명 추첨 실행`}</button>
                                <button type="button" className={`button button-primary ${styles.stageButton}`} aria-describedby={[...stagePrerequisites, runBlockerId].join(" ") || undefined} disabled={!canRun || !screenEnabled || moduleNeedsPublishing || busy !== null || writeLocked} onClick={() => runProgram(program, true)}>{busy === `stage:${program.id}` ? "무대 결과 준비 중" : "무대 터치 실행"}</button>
                                {runBlockers.length ? (
                                  <p className={styles.runBlocker} id={runBlockerId}>실행 전제: {runBlockers.join(" · ")} · {runNextAction} 실행할 수 있습니다</p>
                                ) : null}
                              </div>
                              {moduleNeedsPublishing ? (
                                <p className={styles.stagePrerequisite} id={`stage-module-prerequisite-${program.id}`}>
                                  {!linkedModule
                                    ? <>연결된 추첨용 무대 프로그램이 없습니다. <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 프로그램에서 추첨 무대를 만들고 연결하세요.</Link></>
                                    : <>연결된 무대 프로그램이 비공개입니다. 기존 결과는 자동 공개되지 않습니다. <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>참여 프로그램에서 해당 무대의 운영을 시작해 공개하세요.</Link></>}
                                </p>
                              ) : null}
                            </>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            ) : <p className={styles.empty}>등록된 추첨 프로그램이 없습니다. 쿼터·대상·중복 정책을 정해 첫 프로그램을 만드세요.</p>}
            {state.canManage ? (
                    <details className={styles.setupDetails} open={programFormOpen} onToggle={(event) => setProgramFormOpen((event.target as HTMLDetailsElement).open)}>
        <summary className={styles.setupSummary}>추첨 프로그램 설정 · {state.drawPrograms.length}개</summary>
<form ref={programFormRef} className={styles.programForm} onSubmit={saveProgram}>
                <h3 className={styles.formHeading}>{editingProgramId ? "추첨 설정 수정" : "추첨 프로그램 만들기"}</h3>
                <div className={styles.configGrid}>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-name">추첨 이름</label>
                    <input id="draws-program-name" type="text" maxLength={80} placeholder="예: 초빙 업체 추첨" value={programName} onChange={(event) => setProgramName(event.target.value)} />
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-quota">총 당첨 인원</label>
                    <input id="draws-program-quota" type="number" min={1} max={10000} value={programQuota} onChange={(event) => setProgramQuota(event.target.value)} />
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-module">연결된 무대 추첨</label>
                    <select id="draws-program-module" value={programModuleId} onChange={(event) => setProgramModuleId(event.target.value)}>
                      <option value="">선택하세요</option>
                      {state.drawModules.map((module) => <option key={module.id} value={module.id}>{module.title} · {module.status}</option>)}
                    </select>
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-eligibility">추첨 단위</label>
                    <select id="draws-program-eligibility" value={programEligibility} onChange={(event) => setProgramEligibility(event.target.value as "PERSON" | "COMPANY")}>
                      <option value="PERSON">개인 참가자</option>
                      <option value="COMPANY">업체 (업체별 1회 추첨)</option>
                    </select>
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="draws-program-overlap">중복 당첨 범위</label>
                    <select id="draws-program-overlap" value={programOverlap} onChange={(event) => setProgramOverlap(event.target.value as "EVENT" | "PROGRAM" | "NONE")}>
                      <option value="EVENT">행사 전체에서 제외</option>
                      <option value="PROGRAM">이 프로그램에서만 제외</option>
                      <option value="NONE">중복 허용</option>
                    </select>
                  </div>
                </div>
                <p className={styles.hint}>
                  {programOverlap === "EVENT" ? "행사 전체에서 이미 당첨된 개인·업체를 제외합니다." : programOverlap === "PROGRAM" ? "이 프로그램의 이전 당첨만 제외합니다." : "다른 실행·프로그램의 당첨자도 다시 뽑힐 수 있습니다. 경품도 당첨 건마다 별도로 생성됩니다."}
                </p>
                <div className={styles.filterGrid}>
                  <NameFilter
                    id="draw-groups"
                    label="대상 그룹"
                    options={groupOptions}
                    selected={programGroups}
                    onChange={setProgramGroups}
                    value={groupDraft}
                    onValueChange={setGroupDraft}
                  />
                  <NameFilter
                    id="draw-companies"
                    label="대상 업체"
                    options={companyOptions}
                    selected={programCompanies}
                    onChange={setProgramCompanies}
                    value={companyDraft}
                    onValueChange={setCompanyDraft}
                  />
                </div>
                <div className={styles.tierEditor}>
                  <div className={styles.tierHeading}>
                    <div>
                      <h4>경품 등급 (선택)</h4>
                      <p className={styles.hint}>등급을 쓰면 인원 합계가 총 당첨 인원과 같아야 합니다. 비워두면 등급 없는 추첨입니다.</p>
                    </div>
                    <button type="button" className="button button-secondary" disabled={programTiers.length >= 20} onClick={() => setProgramTiers((tiers) => [...tiers, { key: randomId("tier"), name: "", count: "" }])}>등급 추가</button>
                  </div>
                  {programTiers.map((tier, index) => (
                    <div className={styles.tierRow} key={tier.key}>
                      <div className={styles.programField}>
                        <label htmlFor={`draw-tier-name-${tier.key}`}>등급 {index + 1} 이름</label>
                        <input id={`draw-tier-name-${tier.key}`} type="text" maxLength={80} placeholder="예: 1등" value={tier.name} onChange={(event) => setProgramTiers((items) => items.map((item) => item.key === tier.key ? { ...item, name: event.target.value } : item))} />
                      </div>
                      <div className={styles.programField}>
                        <label htmlFor={`draw-tier-count-${tier.key}`}>당첨 인원</label>
                        <input id={`draw-tier-count-${tier.key}`} type="number" min={1} max={10000} value={tier.count} onChange={(event) => setProgramTiers((items) => items.map((item) => item.key === tier.key ? { ...item, count: event.target.value } : item))} />
                      </div>
                      <button type="button" className="button button-secondary" aria-label={`${tier.name || `등급 ${index + 1}`} 제거`} onClick={() => setProgramTiers((items) => items.filter((item) => item.key !== tier.key))}>제거</button>
                    </div>
                  ))}
                  {programTiers.length ? <p className={configuredTierTotal === Number(programQuota) ? styles.successHint : styles.fieldError}>등급 인원 합계 {configuredTierTotal}명 · 전체 {Number(programQuota) || 0}명</p> : null}
                </div>
                <ConsoleFormActions>
                  <button type="submit" className="button button-secondary" disabled={busy === "program:save" || writeLocked || !state.drawModules.length}>
                    {busy === "program:save" ? "저장 중입니다" : editingProgramId ? "설정 저장" : "추첨 만들기"}
                  </button>
                  {editingProgramId ? <button type="button" className="button button-secondary" onClick={() => {
                    setEditingProgramId(null); setProgramName(""); setProgramQuota(""); setProgramModuleId("");
                    setProgramEligibility("PERSON"); setProgramGroups([]); setProgramCompanies([]); setProgramOverlap("EVENT"); setProgramTiers([]);
                  }}>취소</button> : null}
                </ConsoleFormActions>
              </form>
      </details>
            ) : null}
          </>
        )}
      </ConsoleSection>

      <ConsoleSection headingId="draws-vote" title={`순위 투표 · ${state.voteTotal}표`}>
        {!state.pollEnabled ? <p className={styles.featureOff}>이 행사에서 투표 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>선택 수는 1~20개로 설정합니다. 첫 투표 접수 뒤에는 선택 수와 팀 구성이 잠깁니다. 집계는 서버 순위와 동률을 그대로 표시하며 임의 순위를 만들지 않습니다.</p>
            {state.canManage ? (
              <form className={styles.configForm} onSubmit={saveVoteConfig}>
                <div className={styles.configGrid}>
                  <div className={styles.programField}>
                    <label htmlFor="vote-pick-count">참가자 선택 수</label>
                    <input id="vote-pick-count" type="number" min={1} max={20} value={votePickCount} onChange={(event) => setVotePickCount(event.target.value)} />
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="vote-status">투표 상태</label>
                    <select id="vote-status" value={voteStatus} onChange={(event) => setVoteStatus(event.target.value as "OPEN" | "CLOSED")}>
                      <option value="CLOSED">마감</option>
                      <option value="OPEN">운영 중</option>
                    </select>
                  </div>
                </div>
                <label className={styles.checkLine}>
                  <input type="checkbox" checked={voteResultsPublished} onChange={(event) => setVoteResultsPublished(event.target.checked)} />
                  참가자에게 집계 결과 공개
                </label>
                <p className={styles.hint}>공개를 끄면 집계 수치는 운영자 화면에만 표시됩니다. 결과 순위의 동률은 동률 그대로 공개합니다.</p>
                <ConsoleFormActions>
                  <button type="submit" className="button button-secondary" disabled={busy === "vote:save" || writeLocked}>
                    {busy === "vote:save" ? "저장 중입니다" : "투표 설정 저장"}
                  </button>
                </ConsoleFormActions>
              </form>
            ) : null}
            {state.canManage ? (
              // Team registration is setup work; the roster and the tally are
              // what the operator reads during the event.
              <details className={styles.setupDetails}>
                <summary className={styles.setupSummary}>투표 팀 등록 · {state.teams.length}팀</summary>
                <form className={styles.inlineForm} onSubmit={addTeam}>
                  <label className={styles.inlineLabel} htmlFor="draws-team-name">투표 팀</label>
                  <input
                    id="draws-team-name"
                    type="text"
                    maxLength={80}
                    placeholder="예: 영업 1팀"
                    value={teamName}
                    onChange={(event) => setTeamName(event.target.value)}
                    disabled={state.voteTotal > 0}
                  />
                  <button type="submit" className="button button-secondary" disabled={busy === "team:add" || writeLocked || !teamName.trim() || state.voteTotal > 0}>
                    {busy === "team:add" ? "등록 중입니다" : "팀 등록"}
                  </button>
                </form>
              </details>
            ) : null}
            {state.voteTotal > 0 ? <p className={styles.lockNote}>첫 투표가 접수되어 팀 구성과 선택 수는 잠겼습니다.</p> : null}
            {state.teams.length ? (
              <ul className={styles.teamList}>
                {state.teams.map((team) => {
                  const result = state.voteTally?.results.find((row) => row.teamId === team.id);
                  return (
                    <li key={team.id} className={styles.teamItem}>
                      <strong>{result ? `${result.tied ? `공동 ${result.rank}` : result.rank}위 · ` : ""}{team.name}</strong>
                      <span>{result ? `${result.selections}표` : state.voteTally ? "0표" : "집계 전"}</span>
                    </li>
                  );
                })}
              </ul>
            ) : <p className={styles.empty}>등록된 투표 팀이 없습니다.</p>}
            {state.canManage ? (
              <div className={styles.tallyActions}>
                <button type="button" className="button button-secondary" onClick={refreshVoteTally} disabled={tallyLoading || writeLocked || state.teams.length === 0}>
                  {tallyLoading ? "집계 중입니다" : "서버 집계 새로고침"}
                </button>
                {state.voteTally ? (
                  <span className={styles.hint}>
                    {state.voteTally.totalVotes}표 집계 · 참가자 결과 {state.voteTally.published ? "공개" : "비공개"}
                  </span>
                ) : null}
              </div>
            ) : null}
          </>
        )}
      </ConsoleSection>



      <ConsoleSection headingId="draws-roulette" title={`모바일 룰렛 · ${state.rouletteSpun}회 참여`}>
        {!state.drawEnabled ? <p className={styles.featureOff}>이 행사에서 룰렛 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>모바일 룰렛은 무대 추첨과 별도로 운영됩니다. 유한 재고는 남은 수량이 기본 가중치이며, 무제한 경품은 명시한 양의 가중치로 반영됩니다.</p>
            {state.canManage ? (
                    <details className={styles.setupDetails} >
        <summary className={styles.setupSummary}>룰렛 운영 설정 · {rouletteStatus === "OPEN" ? "운영 중" : rouletteStatus === "DRAFT" ? "준비" : "마감"}</summary>
<form className={styles.programForm} onSubmit={saveRouletteConfig}>
                <div className={styles.configGrid}>
                  <div className={styles.programField}>
                    <label htmlFor="roulette-status">운영 상태</label>
                    <select id="roulette-status" value={rouletteStatus} onChange={(event) => setRouletteStatus(event.target.value as "DRAFT" | "OPEN" | "CLOSED")}>
                      <option value="DRAFT">준비</option><option value="OPEN">운영 중</option><option value="CLOSED">마감</option>
                    </select>
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="roulette-starts">시작 시간 (선택)</label>
                    <input id="roulette-starts" type="datetime-local" value={rouletteStartsAt} onChange={(event) => setRouletteStartsAt(event.target.value)} />
                  </div>
                  <div className={styles.programField}>
                    <label htmlFor="roulette-ends">종료 시간 (선택)</label>
                    <input id="roulette-ends" type="datetime-local" value={rouletteEndsAt} onChange={(event) => setRouletteEndsAt(event.target.value)} />
                  </div>
                </div>
                {roulettePrizes.map((prize, index) => {
                  const used = state.rouletteUsedById[prize.id] ?? 0;
                  const remaining = prize.unlimited ? null : Math.max(0, (Number(prize.quantity) || 0) - used);
                  return (
                    <div className={styles.roulettePrizeRow} key={prize.id}>
                      <div className={styles.prizeRowHeading}>
                        <strong>경품 {index + 1}</strong>
                        <span>{prize.unlimited ? `무제한 · ${used}회 지급` : `남은 재고 ${remaining}개 · ${used}회 지급`}</span>
                      </div>
                      <div className={styles.configGrid}>
                        <div className={styles.programField}>
                          <label htmlFor={`roulette-name-${prize.id}`}>경품 이름</label>
                          <input id={`roulette-name-${prize.id}`} type="text" maxLength={80} value={prize.label} disabled={rouletteFrozen} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, label: event.target.value } : item))} />
                        </div>
                        <div className={styles.programField}>
                          <label htmlFor={`roulette-quantity-${prize.id}`}>유한 재고 수량</label>
                          <input id={`roulette-quantity-${prize.id}`} type="number" min={0} max={100000} value={prize.quantity} disabled={prize.unlimited} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, quantity: event.target.value } : item))} />
                        </div>
                      </div>
                      {!prize.unlimited ? <div className={styles.programField}>
                        <label htmlFor={`roulette-weight-${prize.id}`}>가중치 재정의 (선택, 0 이상)</label>
                        <input id={`roulette-weight-${prize.id}`} type="number" min={0} max={1000000} value={prize.weight} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, weight: event.target.value } : item))} />
                        <p className={styles.hint}>{prize.weight === "0" ? "가중치 0은 이 경품을 추첨에서 제외합니다." : "비워두면 남은 재고 수량이 가중치로 쓰입니다."}</p>
                      </div> : null}
                      <label className={styles.checkLine}>
                        <input type="checkbox" checked={prize.unlimited} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, unlimited: event.target.checked } : item))} />
                        무제한 재고로 운영
                      </label>
                      {prize.unlimited ? <div className={styles.programField}>
                        <label htmlFor={`roulette-weight-${prize.id}`}>무제한 경품 가중치 (양의 정수)</label>
                        <input id={`roulette-weight-${prize.id}`} type="number" min={1} max={1000000} value={prize.weight} onChange={(event) => setRoulettePrizes((items) => items.map((item) => item.id === prize.id ? { ...item, weight: event.target.value } : item))} />
                        <p className={styles.hint}>가중치는 추첨 비중입니다. 한정 재고와 같은 수치 척도에서 운영자가 직접 정합니다.</p>
                      </div> : null}
                      <button type="button" className="button button-secondary" disabled={rouletteFrozen || roulettePrizes.length <= 1} onClick={() => setRoulettePrizes((items) => items.filter((item) => item.id !== prize.id))}>이 경품 제거</button>
                    </div>
                  );
                })}
                {rouletteFrozen ? <p className={styles.lockNote}>결과가 발생해 경품 이름·목록 순서는 고정되었습니다. 재고 수량, 운영 시간·상태, 가중치는 계속 조정할 수 있습니다.</p> : null}
                <ConsoleFormActions>
                  <button type="button" className="button button-secondary" disabled={rouletteFrozen || roulettePrizes.length >= 20} onClick={() => setRoulettePrizes((items) => [...items, { id: randomId("prize"), label: "", quantity: "", unlimited: false, weight: "" }])}>경품 추가</button>
                  <button type="submit" className="button button-primary" disabled={busy === "roulette:save" || writeLocked}>{busy === "roulette:save" ? "저장 중입니다" : "룰렛 설정 저장"}</button>
                </ConsoleFormActions>
                <p className={styles.hint}>운영 중으로 저장하면 참가자가 즉시 참여할 수 있습니다. 각 티켓은 서버에서 결과를 한 번만 저장하며, 수량은 이미 나온 결과보다 줄일 수 없습니다.</p>
              </form>
      </details>
            ) : null}
            {!roulettePrizes.length ? <p className={styles.empty}>등록된 경품이 없습니다.</p> : null}
          </>
        )}
      </ConsoleSection>

      <ConsoleSection headingId="draws-lucky" title="럭키번호 사전 배정">
        {!state.drawEnabled ? <p className={styles.featureOff}>이 행사에서 럭키번호 기능이 꺼져 있습니다.</p> : (
          <>
            <p className={styles.hint}>알림 캠페인을 보내기 전에 승인 참가자에게 번호를 미리 배정할 수 있습니다. 번호는 범위 내에서 고유하며 기존 발급 번호는 유지됩니다.</p>
            {state.canManage ? (
                    <details className={styles.setupDetails} >
        <summary className={styles.setupSummary}>럭키번호 범위 설정 · {state.luckyMin}–{state.luckyMax}</summary>
<form className={styles.configForm} onSubmit={saveLuckyConfig}>
                <div className={styles.configGrid}>
                  <div className={styles.programField}><label htmlFor="lucky-min">최소 번호</label><input id="lucky-min" type="number" min={1} max={999999} value={luckyMin} onChange={(event) => setLuckyMin(event.target.value)} /></div>
                  <div className={styles.programField}><label htmlFor="lucky-max">최대 번호</label><input id="lucky-max" type="number" min={1} max={999999} value={luckyMax} onChange={(event) => setLuckyMax(event.target.value)} /></div>
                </div>
                <p className={styles.hint}>범위 {state.luckyMin}–{state.luckyMax} · 발급 {state.luckyIssued}명 · 미발급 승인 참가자 {missingLuckyCount}명 · 남은 고유 번호 {luckyAvailable}개</p>
                <ConsoleFormActions>
                  <button type="submit" className="button button-secondary" disabled={busy === "lucky:save" || writeLocked}>{busy === "lucky:save" ? "저장 중입니다" : "번호 범위 저장"}</button>
                </ConsoleFormActions>
              </form>
      </details>
            ) : <p className={styles.hint}>범위 {state.luckyMin}–{state.luckyMax} · 발급 {state.luckyIssued}명</p>}
            {state.canManage ? (
              <div className={styles.preassignBox}>
                <label className={styles.checkLine}>
                  <input type="checkbox" checked={preassignAllApproved} onChange={(event) => setPreassignAllApproved(event.target.checked)} />
                  가져온 참가자를 포함해 승인 참가자 전체 {approvedParticipants.length}명 선택 (기존 번호 유지)
                </label>
                {missingLuckyCount > luckyAvailable ? <p className={styles.fieldError}>전체 배정에 번호가 {missingLuckyCount - luckyAvailable}개 부족합니다. 범위를 먼저 넓히세요.</p> : null}
                <button type="button" className="button button-primary" disabled={!preassignAllApproved || writeLocked || busy === "lucky:preassign" || approvedParticipants.length === 0 || missingLuckyCount > luckyAvailable} onClick={preassignLuckyNumbers}>
                  {busy === "lucky:preassign" ? "번호 배정 중입니다" : `${missingLuckyCount}명 번호 일괄 배정`}
                </button>
              </div>
            ) : null}
          </>
        )}
      </ConsoleSection>
    </ConsolePage>
  );
}

function NameFilter({
  id,
  label,
  options,
  selected,
  onChange,
  value,
  onValueChange,
}: {
  id: string;
  label: string;
  options: string[];
  selected: string[];
  onChange: (values: string[]) => void;
  value: string;
  onValueChange: (value: string) => void;
}) {
  function addValue() {
    const next = value.trim();
    if (!next) return;
    if (!selected.includes(next)) onChange([...selected, next]);
    onValueChange("");
  }

  return (
    <div className={styles.filterField}>
      <label htmlFor={`${id}-input`}>{label}</label>
      <div className={styles.filterControls}>
        <input id={`${id}-input`} list={`${id}-options`} value={value} onChange={(event) => onValueChange(event.target.value)} onKeyDown={(event) => {
          if (event.key === "Enter") { event.preventDefault(); addValue(); }
        }} placeholder="이름을 입력하거나 목록에서 선택" />
        <datalist id={`${id}-options`}>{options.map((option) => <option value={option} key={option} />)}</datalist>
        <button type="button" className="button button-secondary" disabled={!value.trim()} onClick={addValue}>추가</button>
      </div>
      {selected.length ? <ul className={styles.filterChips}>{selected.map((item) => <li key={item}><span>{item}</span><button type="button" aria-label={`${item} 제외`} onClick={() => onChange(selected.filter((entry) => entry !== item))}>×</button></li>)}</ul> : <p className={styles.hint}>비워두면 전체 대상입니다.</p>}
    </div>
  );
}
