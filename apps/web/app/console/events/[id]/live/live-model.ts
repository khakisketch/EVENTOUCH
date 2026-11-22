// One read model for 현장 모드. It only reshapes what /bootstrap already returns
// (the same fields the programs, draws, rewards and operations screens read);
// nothing here talks to the server and nothing adds a data shape.

import { PARTICIPATION_TYPES, participationSnapshot, type ParticipationSnapshot } from "../../../../../lib/participation-work";
import { rewardBucket, rewardParticipantIssue } from "../../../../../lib/reward-status";
import type { LiveDisplay, LiveDisplayOptions, LiveProgram } from "./live-schedule";

export type LiveModule = {
  id: string;
  type: string;
  title: string;
  status: string;
  published: boolean;
  revealed: boolean;
  options: string[];
  /** Latest unpublished simple-draw result, when there is one to publish. */
  pendingDrawId: string;
  pendingDrawNames: string[];
};

export type LiveDrawProgram = {
  id: string;
  name: string;
  quota: number;
  revision: number;
  status: string;
  winners: number;
  overlap: "EVENT" | "PROGRAM" | "NONE";
};

export type LiveReward = { id: string; name: string; who: string; method: string };

export type LiveModel = {
  eventId: string;
  eventName: string;
  eventSlug: string;
  eventDate: string;
  stage: string;
  venue: string;
  role: string;
  userId: string;
  memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
  features: string[];
  capacity: number | null;
  /** Participants not cancelled; null when the roster could not be read. */
  registered: number | null;
  everIn: number | null;
  programs: LiveProgram[];
  modules: LiveModule[];
  /** Responses (or questions, photos, posts) received per participation event. */
  received: Record<string, number>;
  /** Poll tallies in option order. */
  tallies: Record<string, number[]>;
  display: LiveDisplay;
  displayOptions: LiveDisplayOptions;
  drawPrograms: LiveDrawProgram[];
  participation: ParticipationSnapshot;
  rewardsOn: boolean;
  rewardsWaiting: LiveReward[];
  rewardsAttention: number;
  refreshVersion: string;
};

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function identifier(value: unknown): string {
  return typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value)) ? String(value) : "";
}

/** Returns null when the event or its workspace is missing from the read. */
export function parseLiveModel(
  bootstrap: Record<string, unknown>,
  eventId: string,
  actor: { role: string; userId: string },
): LiveModel | null {
  const event = records(bootstrap.events).find((item) => item.id === eventId);
  const workspace = record(record(bootstrap.workspaces)?.[eventId]);
  if (!event || !workspace) return null;
  const features = strings(event.features);
  const enabled = new Set(features);

  const people = records(workspace.participants).filter((person) => text(person.status).toUpperCase() !== "CANCELLED");
  const rosterReadable = Array.isArray(workspace.participants);
  const capacityValue = event.capacity;
  const capacity = typeof capacityValue === "number" && Number.isSafeInteger(capacityValue) && capacityValue > 0 ? capacityValue
    : typeof capacityValue === "string" && /^\d+$/.test(capacityValue) && Number(capacityValue) > 0 ? Number(capacityValue) : null;

  const responses = records(workspace.responses);
  const questions = records(workspace.questions);
  const photos = records(workspace.photos);
  const posts = records(workspace.posts);
  const received: Record<string, number> = {};
  const tallies: Record<string, number[]> = {};
  const modules: LiveModule[] = records(workspace.modules).flatMap((item) => {
    const id = text(item.id);
    const type = text(item.type);
    if (!id || !type) return [];
    const options = strings(item.options);
    const mine = responses.filter((response) => response.moduleId === id);
    received[id] = type === "qa" ? questions.filter((question) => question.moduleId === id).length
      : type === "photo" ? photos.length
      : type === "board" ? posts.length
      : mine.length;
    if (type === "poll" && options.length) tallies[id] = options.map((option) => mine.filter((response) => response.answer === option).length);
    const history = records(item.drawHistory);
    const latest = history[0];
    const pending = latest && latest.published !== true && typeof latest.id === "string" ? latest : null;
    return [{
      id, type, title: text(item.title, "제목 없는 이벤트"), status: text(item.status, "DRAFT"),
      published: item.published === true, revealed: item.revealed === true, options,
      pendingDrawId: pending ? String(pending.id) : "",
      pendingDrawNames: pending ? records(pending.winners).map((winner) => text(winner.name, "이름 미등록")) : [],
    }];
  });

  const display = record(workspace.display);
  const drawModules = records(workspace.modules);
  const displayOptions: LiveDisplayOptions = {
    notices: records(workspace.notices).flatMap((notice) => typeof notice.id === "string" ? [{ id: notice.id, title: text(notice.title), published: notice.published === true }] : []),
    modules: drawModules.flatMap((module) => {
      if (typeof module.id !== "string" || typeof module.type !== "string") return [];
      // The server only outputs a module whose feature is on (setDisplay); a leftover
      // module of a switched-off feature must not be offered as a choice.
      if (!enabled.has(module.type)) return [];
      return [{
        id: module.id, title: text(module.title), type: module.type, published: module.published === true, revealed: module.revealed === true,
        draws: module.type === "draw" && enabled.has("draw") && module.status !== "DRAFT"
          ? records(module.drawHistory).flatMap((draw) => draw.published === true && typeof draw.id === "string" && draw.id
            ? [{ id: draw.id, name: text(draw.programName), at: text(draw.at) }] : [])
          : [],
      }];
    }),
    approvedPhotos: enabled.has("photo") ? photos.filter((photo) => photo.status === "APPROVED").length : 0,
    approvedQuestions: questions.filter((question) => question.approved === true).length,
  };

  const drawPrograms: LiveDrawProgram[] = enabled.has("draw") ? records(workspace.drawPrograms).flatMap((program) => {
    if (typeof program.id !== "string") return [];
    return [{
      id: program.id, name: text(program.name, "이름 없는 추첨"),
      quota: typeof program.quota === "number" ? program.quota : 0,
      revision: typeof program.revision === "number" && Number.isSafeInteger(program.revision) && program.revision >= 0 ? program.revision : 0,
      status: text(program.status, "DRAFT"),
      winners: Array.isArray(program.winners) ? program.winners.length : 0,
      overlap: program.overlap === "PROGRAM" || program.overlap === "NONE" ? program.overlap : "EVENT",
    }];
  }) : [];

  // Rewards: the same "waiting" definition as the 경품 지급 현황 screen.
  const rewardsOn = enabled.has("reward") && Array.isArray(workspace.rewards);
  const byId = new Map<string, Array<Record<string, unknown>>>();
  for (const person of records(workspace.participants)) {
    const id = identifier(person.id);
    if (id) byId.set(id, [...(byId.get(id) ?? []), person]);
  }
  const rewardsWaiting: LiveReward[] = [];
  let rewardsAttention = 0;
  if (rewardsOn) {
    for (const reward of records(workspace.rewards)) {
      if (typeof reward.id !== "string") continue;
      const owner = byId.get(identifier(reward.participantId)) ?? [];
      const bucket = rewardBucket(text(reward.status), rewardParticipantIssue(owner));
      if (bucket === "attention") rewardsAttention += 1;
      if (bucket !== "waiting") continue;
      rewardsWaiting.push({
        id: reward.id, name: text(reward.name, "경품명 미등록"), method: text(reward.method, "ONSITE"),
        who: text(owner[0]?.name) || text(reward.company) || "참가자 확인 필요",
      });
    }
  }

  const venue = record(workspace.venue);
  const memberships = records(bootstrap.memberships).flatMap((membership) =>
    typeof membership.accountId === "string" && typeof membership.eventId === "string"
      ? [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }] : []);

  return {
    eventId,
    eventName: text(event.name),
    eventSlug: text(event.slug),
    eventDate: text(event.date),
    stage: text(event.stage).toUpperCase(),
    venue: text(venue?.name) || text(event.venue),
    role: actor.role,
    userId: actor.userId,
    memberships,
    features,
    capacity,
    registered: rosterReadable ? people.length : null,
    everIn: rosterReadable ? people.filter((person) => person.everIn === true).length : null,
    programs: records(workspace.program).flatMap((program, index) => {
      const title = text(program.title);
      if (!title) return [];
      return [{ id: text(program.id) || `program-${index}`, title, date: text(program.date), start: text(program.start), end: text(program.end), place: text(program.place) }];
    }),
    modules: modules.filter((module) => enabled.has(module.type) && PARTICIPATION_TYPES.some((type) => type.id === module.type)),
    received,
    tallies,
    display: {
      type: text(display?.type) || "idle",
      moduleId: text(display?.moduleId),
      noticeId: text(display?.noticeId),
      drawId: display?.type === "draw" ? text(display.drawId) : "",
    },
    displayOptions,
    drawPrograms,
    participation: participationSnapshot(workspace, features),
    rewardsOn,
    rewardsWaiting,
    rewardsAttention,
    refreshVersion: text(bootstrap.refreshVersion),
  };
}
