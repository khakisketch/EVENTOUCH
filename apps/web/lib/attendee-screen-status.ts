/**
 * 참가자 화면 허브의 게시 상태 줄 (2026-11-21).
 *
 * Read-only summary of what is still waiting to reach attendees across the
 * three screens the hub groups: 디자인(참가자 페이지), 공지·안내, 참여 이벤트.
 * It reads the same bootstrap workspace those screens already read and invents
 * no state: the rules below mirror the labels each screen already shows
 * (ThemeWorkspace "게시 전 초안"/"게시본과 다름", ContentWorkspace "비공개"/
 * "수정본 있음", ProgramsWorkspace "준비 중"). It never writes and is not a
 * permission authority. Pure module: no React, no fetching.
 */

type Rec = Record<string, unknown>;

export type ScreenTab = "design" | "content" | "programs";
export type ScreenStatusTone = "wait" | "ok" | "neutral";

export type ScreenStatus = {
  tab: ScreenTab;
  label: string;
  tone: ScreenStatusTone;
  /** Items that still need a publish. Participation lifecycle never counts here. */
  pending: number;
};

/** Features that make 참여 이벤트 a destination (same list as the console rail). */
export const PARTICIPATION_FEATURES: readonly string[] = ["poll", "quiz", "qa", "draw", "survey", "stamp", "photo", "board"];

function rec(value: unknown): Rec | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function hasParticipationFeature(event: unknown): boolean {
  const features = rec(event)?.features;
  return Array.isArray(features) && features.some((feature) => typeof feature === "string" && PARTICIPATION_FEATURES.includes(feature));
}

function designStatus(workspace: Rec): ScreenStatus {
  const page = rec(workspace.pageExperience);
  const publishedAt = typeof page?.publishedAt === "string" && page.publishedAt ? page.publishedAt : null;
  if (!publishedAt) return { tab: "design", label: "디자인 · 게시 전 초안", tone: "wait", pending: 1 };
  if (page?.publishedVersion !== page?.draftVersion) return { tab: "design", label: "디자인 · 게시본과 다름", tone: "wait", pending: 1 };
  return { tab: "design", label: "디자인 · 게시됨", tone: "ok", pending: 0 };
}

function noticeHasEdit(item: Rec): boolean {
  const draft = rec(item.draft);
  if (!draft) return false;
  return text(draft.title, text(item.title)) !== text(item.title)
    || text(draft.body, text(item.body)) !== text(item.body)
    || (draft.pinned === true) !== (item.pinned === true);
}

function programHasEdit(item: Rec): boolean {
  const draft = rec(item.draft);
  if (!draft) return false;
  const fields = ["title", "date", "start", "end", "place", "description"];
  if (fields.some((field) => text(draft[field], text(item[field])) !== text(item[field]))) return true;
  return text(rec(draft.attachment)?.fileId) !== text(rec(item.attachment)?.fileId);
}

/**
 * 장소 안내 has one record with a draft beside the published copy (ContentWorkspace
 * "수정본 있음": the same fields venueChanges compares). Only an event that offers
 * the venue feature has a 장소 안내 tab, so only then does an unpublished edit count.
 */
function venueHasEdit(workspace: Rec): boolean {
  const venue = rec(workspace.venue);
  const draft = rec(venue?.draft);
  if (!venue || !draft) return false;
  if (["name", "address", "directions", "contact", "description"].some((field) => text(draft[field]) !== text(venue[field]))) return true;
  const published = rec(venue.map);
  const next = rec(draft.map);
  if (!published && !next) return false;
  return text(rec(published?.image)?.fileId) !== text(rec(next?.image)?.fileId) || text(published?.alt) !== text(next?.alt);
}

function contentStatus(workspace: Rec, venueEnabled: boolean): ScreenStatus {
  const notices = Array.isArray(workspace.notices) ? workspace.notices.flatMap((value) => (rec(value) ? [rec(value) as Rec] : [])) : [];
  const program = Array.isArray(workspace.program) ? workspace.program.flatMap((value) => (rec(value) ? [rec(value) as Rec] : [])) : [];
  const waiting = (item: Rec, hasEdit: (item: Rec) => boolean) => item.published !== true || hasEdit(item);
  const pending = notices.filter((item) => waiting(item, noticeHasEdit)).length + program.filter((item) => waiting(item, programHasEdit)).length
    + (venueEnabled && venueHasEdit(workspace) ? 1 : 0);
  if (pending > 0) return { tab: "content", label: `공지·안내 · 게시 전 ${pending}건`, tone: "wait", pending };
  if (notices.length + program.length === 0) return { tab: "content", label: "공지·안내 · 등록 없음", tone: "neutral", pending: 0 };
  return { tab: "content", label: "공지·안내 · 게시됨", tone: "ok", pending: 0 };
}

function programsStatus(workspace: Rec, drawStatuses: readonly string[]): ScreenStatus {
  const statuses = [
    ...(Array.isArray(workspace.modules) ? workspace.modules.map((value) => text(rec(value)?.status)) : []),
    ...drawStatuses,
  ];
  const count = (status: string) => statuses.filter((value) => value === status).length;
  if (count("DRAFT") > 0) return { tab: "programs", label: `참여 이벤트 · 준비 중 ${count("DRAFT")}건`, tone: "neutral", pending: 0 };
  if (count("OPEN") > 0) return { tab: "programs", label: `참여 이벤트 · 진행 중 ${count("OPEN")}건`, tone: "neutral", pending: 0 };
  if (statuses.length > 0) return { tab: "programs", label: "참여 이벤트 · 모두 종료", tone: "neutral", pending: 0 };
  return { tab: "programs", label: "참여 이벤트 · 없음", tone: "neutral", pending: 0 };
}

/**
 * One status per tab, in tab order. 참여 이벤트 is omitted when the event has
 * no participation feature, matching the rail's own rule. `drawStatuses` are
 * the status values of the draw events the programs screen lists beside the
 * modules (see participation-events drawEventsSnapshot).
 */
export function attendeeScreenStatuses(event: unknown, workspace: unknown, drawStatuses: readonly string[] = []): ScreenStatus[] {
  const space = rec(workspace) ?? {};
  const features = rec(event)?.features;
  const venueEnabled = Array.isArray(features) && features.includes("venue");
  const statuses = [designStatus(space), contentStatus(space, venueEnabled)];
  if (hasParticipationFeature(event)) statuses.push(programsStatus(space, drawStatuses));
  return statuses;
}

/**
 * The first tab with something waiting to be published, for the hub's one-click review.
 * `count` is everything waiting across the hub; `tabCount` is what the linked tab itself
 * holds, so the hub can say so when the two differ instead of promising more than the
 * page it opens shows.
 */
export function firstPendingTab(statuses: readonly ScreenStatus[]): { tab: ScreenTab; count: number; tabCount: number } | null {
  const count = statuses.reduce((sum, status) => sum + status.pending, 0);
  const first = statuses.find((status) => status.pending > 0);
  return first && count > 0 ? { tab: first.tab, count, tabCount: first.pending } : null;
}
