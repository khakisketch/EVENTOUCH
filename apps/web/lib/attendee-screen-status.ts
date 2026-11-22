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

export type ContentSource = "notice" | "program" | "venue";

export type ScreenStatus = {
  tab: ScreenTab;
  label: string;
  tone: ScreenStatusTone;
  /** Items that still need a publish. Participation lifecycle never counts here. */
  pending: number;
  /** 공지·안내 only: the first sub-tab (공지 / 일정 / 장소) that holds something waiting. */
  source?: ContentSource;
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

export type VenueFields = {
  name: string;
  address: string;
  directions: string;
  contact: string;
  description: string;
  map: { image: { fileId: string; name: string }; alt: string } | null;
};

/**
 * The one reading of a stored 장소 안내 record. ContentWorkspace parses with this too,
 * so the hub and that screen agree on what a venue is: a map counts only when it has
 * an image file, so `{ alt, image: null }` is no map on either side.
 */
export function normalizeVenue(value: unknown): VenueFields {
  const item = rec(value) ?? {};
  const map = rec(item.map);
  const image = rec(map?.image);
  const fileId = text(image?.fileId);
  return {
    name: text(item.name),
    address: text(item.address),
    directions: text(item.directions),
    contact: text(item.contact),
    description: text(item.description),
    map: map && fileId ? { image: { fileId, name: text(image?.name, "행사장 안내도") }, alt: text(map.alt) } : null,
  };
}

/**
 * 장소 안내 has one record with a draft beside the published copy. It differs when a
 * text field, the 안내도 file (or its name) or the 안내도 text differs, which is what
 * ContentWorkspace's venueChanges shows as "수정본 있음". Only an event that offers the
 * venue feature has a 장소 안내 tab, so only then does an unpublished edit count.
 */
export function venueDraftDiffers(record: unknown): boolean {
  const venue = rec(record);
  if (!venue) return false;
  const published = normalizeVenue(venue);
  const draft = normalizeVenue(rec(venue.draft) ?? venue);
  if ((["name", "address", "directions", "contact", "description"] as const).some((field) => published[field] !== draft[field])) return true;
  if (!published.map && !draft.map) return false;
  return published.map?.image.fileId !== draft.map?.image.fileId
    || published.map?.image.name !== draft.map?.image.name
    || published.map?.alt !== draft.map?.alt;
}

function contentStatus(workspace: Rec, venueEnabled: boolean): ScreenStatus {
  const notices = Array.isArray(workspace.notices) ? workspace.notices.flatMap((value) => (rec(value) ? [rec(value) as Rec] : [])) : [];
  const program = Array.isArray(workspace.program) ? workspace.program.flatMap((value) => (rec(value) ? [rec(value) as Rec] : [])) : [];
  const waiting = (item: Rec, hasEdit: (item: Rec) => boolean) => item.published !== true || hasEdit(item);
  const noticePending = notices.filter((item) => waiting(item, noticeHasEdit)).length;
  const programPending = program.filter((item) => waiting(item, programHasEdit)).length;
  const venuePending = venueEnabled && venueDraftDiffers(workspace.venue) ? 1 : 0;
  const pending = noticePending + programPending + venuePending;
  // The hub links to the sub-tab that actually holds the first waiting item.
  const source: ContentSource | undefined = noticePending > 0 ? "notice" : programPending > 0 ? "program" : venuePending > 0 ? "venue" : undefined;
  if (pending > 0) return { tab: "content", label: `공지·안내 · 게시 전 ${pending}건`, tone: "wait", pending, source };
  if (notices.length + program.length === 0) return { tab: "content", label: "공지·안내 · 등록 없음", tone: "neutral", pending: 0 };
  return { tab: "content", label: "공지·안내 · 게시됨", tone: "ok", pending: 0 };
}

function programsStatus(workspace: Rec, drawStatuses: readonly string[], features: readonly string[]): ScreenStatus {
  // The programs page lists only modules of features that are on, so leftovers of a
  // switched-off feature (and its draws) must not show up as "준비 중" here either.
  const statuses = [
    ...(Array.isArray(workspace.modules)
      ? workspace.modules.filter((value) => features.includes(text(rec(value)?.type))).map((value) => text(rec(value)?.status))
      : []),
    ...(features.includes("draw") ? drawStatuses : []),
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
  const rawFeatures = rec(event)?.features;
  const features = Array.isArray(rawFeatures) ? rawFeatures.filter((value): value is string => typeof value === "string") : [];
  const statuses = [designStatus(space), contentStatus(space, features.includes("venue"))];
  if (hasParticipationFeature(event)) statuses.push(programsStatus(space, drawStatuses, features));
  return statuses;
}

/**
 * The first tab with something waiting to be published, for the hub's one-click review.
 * `count` is everything waiting across the hub; `tabCount` is what the linked tab itself
 * holds, so the hub can say so when the two differ instead of promising more than the
 * page it opens shows.
 */
export function firstPendingTab(statuses: readonly ScreenStatus[]): { tab: ScreenTab; count: number; tabCount: number; source?: ContentSource } | null {
  const count = statuses.reduce((sum, status) => sum + status.pending, 0);
  const first = statuses.find((status) => status.pending > 0);
  return first && count > 0 ? { tab: first.tab, count, tabCount: first.pending, ...(first.source ? { source: first.source } : {}) } : null;
}
