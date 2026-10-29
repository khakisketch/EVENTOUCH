/**
 * Console page registry: metadata ONLY.
 *
 * This module maps every console menu destination to the route that already
 * exists today. It is not a permission authority: the rail, the server reads
 * and the command authorization stay authoritative. It creates no routes and
 * no features; parallel page migrations use it so headers, links and titles
 * resolve from one place.
 *
 * Pure module: no React, no hooks, no data fetching.
 */

export type ConsolePageId =
  | "events"
  | "clients"
  | "team"
  | "overview"
  | "participants"
  | "participantImport"
  | "messages"
  | "operations"
  | "programs"
  | "draws"
  | "photos"
  | "content"
  | "attendeePage"
  | "rewards"
  | "settings"
  | "reports";

export type ConsolePageScope = "organization" | "event";

export type ConsolePageLayout = "directory" | "workspace";

/**
 * Event work is grouped into five operator questions, not one flat list.
 * A hub is navigation metadata only; permissions and feature gates stay on
 * the pages and the server. `pageIds` is ordered as the operator reads it:
 * the hub's default destination first where possible.
 */
export type ConsoleHubId = "today" | "prepare" | "participants" | "onsite" | "results";

export type ConsoleHub = {
  id: ConsoleHubId;
  label: string;
  pageIds: readonly ConsolePageId[];
  defaultPageId: ConsolePageId;
};

export type ConsolePageMeta = {
  /** Rail/menu label. */
  label: string;
  /** Menu title used for the page H1. */
  title: string;
  /** Organization pages render without an event context row. */
  scope: ConsolePageScope;
  /**
   * Body shape hint. Only the events home is a directory; every other page
   * is a workspace of sections.
   */
  layout: ConsolePageLayout;
};

export const CONSOLE_PAGES: Record<ConsolePageId, ConsolePageMeta> = {
  events: { label: "행사", title: "행사", scope: "organization", layout: "directory" },
  clients: { label: "고객사", title: "고객사", scope: "organization", layout: "workspace" },
  team: { label: "팀·권한", title: "팀·권한", scope: "organization", layout: "workspace" },
  overview: { label: "운영 현황", title: "운영 현황", scope: "event", layout: "workspace" },
  participants: { label: "참가자 명단", title: "참가자 명단", scope: "event", layout: "workspace" },
  participantImport: { label: "명단 가져오기", title: "명단 가져오기", scope: "event", layout: "workspace" },
  messages: { label: "메시지", title: "메시지 발송", scope: "event", layout: "workspace" },
  operations: { label: "현장 운영", title: "현장 운영", scope: "event", layout: "workspace" },
  programs: { label: "참여 프로그램", title: "참여 프로그램", scope: "event", layout: "workspace" },
  draws: { label: "추첨·투표", title: "추첨·투표", scope: "event", layout: "workspace" },
  photos: { label: "현장 사진", title: "현장 사진", scope: "event", layout: "workspace" },
  content: { label: "콘텐츠", title: "콘텐츠", scope: "event", layout: "workspace" },
  attendeePage: { label: "참가자 페이지", title: "참가자 페이지", scope: "event", layout: "workspace" },
  rewards: { label: "경품", title: "경품", scope: "event", layout: "workspace" },
  settings: { label: "행사 설정", title: "행사 설정", scope: "event", layout: "workspace" },
  reports: { label: "결과 보고서", title: "결과 보고서", scope: "event", layout: "workspace" },
};

/**
 * Event rail order. The five hubs are the primary grouping; the page order
 * inside each hub follows the operator's actual setup-to-live-to-results
 * sequence. `participantImport` is a participants subpage, not a separate
 * hub, and is included so the rail can name where the operator is.
 */
export const EVENT_HUBS: readonly ConsoleHub[] = [
  { id: "today", label: "오늘", pageIds: ["overview"], defaultPageId: "overview" },
  { id: "prepare", label: "준비", pageIds: ["settings", "attendeePage", "content", "programs"], defaultPageId: "settings" },
  { id: "participants", label: "참가자", pageIds: ["participants", "participantImport", "messages"], defaultPageId: "participants" },
  { id: "onsite", label: "현장", pageIds: ["operations", "photos"], defaultPageId: "operations" },
  { id: "results", label: "결과", pageIds: ["draws", "rewards", "reports"], defaultPageId: "draws" },
];

/** Flattened order for callers that only need a page list. */
export const EVENT_PAGE_IDS: readonly ConsolePageId[] = EVENT_HUBS.flatMap((hub) => hub.pageIds);

/** Finds the hub that owns a page. Organization pages return undefined. */
export function consoleHubForPage(pageId: ConsolePageId): ConsoleHub | undefined {
  return EVENT_HUBS.find((hub) => hub.pageIds.includes(pageId));
}

/** Organization root destinations. Team lives in the operator menu. */
export const MAIN_PAGE_IDS: readonly ConsolePageId[] = ["events", "clients"];

/**
 * Returns the existing route for a page. Event-scoped pages need an event
 * id; when it is missing or blank this returns `undefined` so callers render
 * no link instead of a broken one. Organization pages ignore `eventId`.
 */
export function consolePageHref(pageId: ConsolePageId, eventId?: string): string | undefined {
  switch (pageId) {
    case "events":
      return "/console";
    case "clients":
      return "/console/clients";
    case "team":
      return "/console/team";
    case "overview":
    case "participants":
    case "participantImport":
    case "messages":
    case "operations":
    case "programs":
    case "draws":
    case "photos":
    case "content":
    case "attendeePage":
    case "rewards":
    case "settings":
    case "reports": {
      const id = eventId?.trim();
      if (!id) return undefined;
      const base = `/console/events/${encodeURIComponent(id)}`;
      switch (pageId) {
        case "overview":
          return base;
        case "participants":
          return `${base}/participants`;
        case "participantImport":
          return `${base}/participants/import`;
        case "messages":
          return `${base}/messages`;
        case "operations":
          return `${base}/operations`;
        case "programs":
          return `${base}/programs`;
        case "draws":
          return `${base}/draws`;
        case "photos":
          return `${base}/photos`;
        case "content":
          return `${base}/content`;
        case "attendeePage":
          return `${base}/page`;
        case "rewards":
          return `${base}/rewards`;
        case "settings":
          return `${base}/settings`;
        case "reports":
          return `${base}/reports`;
      }
    }
  }
}

export type ConsolePageResolution = {
  pageId: ConsolePageId;
  eventId?: string;
};

/**
 * Resolves a console pathname to its page. Query strings and hashes are
 * ignored. Only exact known routes classify: unknown descendants resolve to
 * `null` so arbitrary subpaths never masquerade as menu pages. The single
 * known child is `participants/import`. Only the event id segment is
 * decoded, inside a guard; undecodable segments resolve to `null`.
 *
 * No parent is returned: callers needing rail state derive the active
 * parent themselves (participantImport → participants).
 */
export function resolveConsolePage(pathname: string): ConsolePageResolution | null {
  const path = pathname.split(/[?#]/, 1)[0] ?? "";
  const normalized = path.length > 1 ? path.replace(/\/+$/, "") : path;
  if (normalized === "/console") return { pageId: "events" };
  if (normalized === "/console/clients") return { pageId: "clients" };
  if (normalized === "/console/team") return { pageId: "team" };

  const eventMatch = /^\/console\/events\/([^/]+)(?:\/(.*))?$/.exec(normalized);
  if (!eventMatch) return null;
  let eventId: string;
  try {
    eventId = decodeURIComponent(eventMatch[1]);
  } catch {
    return null;
  }
  if (!eventId) return null;

  const rest = eventMatch[2] ?? "";
  if (!rest) return { pageId: "overview", eventId };
  const segments = rest.split("/");
  if (segments.length === 1) {
    switch (segments[0]) {
      case "participants":
        return { pageId: "participants", eventId };
      case "messages":
        return { pageId: "messages", eventId };
      case "operations":
        return { pageId: "operations", eventId };
      case "programs":
        return { pageId: "programs", eventId };
      case "draws":
        return { pageId: "draws", eventId };
      case "photos":
        return { pageId: "photos", eventId };
      case "content":
        return { pageId: "content", eventId };
      case "page":
        return { pageId: "attendeePage", eventId };
      case "rewards":
        return { pageId: "rewards", eventId };
      case "settings":
        return { pageId: "settings", eventId };
      case "reports":
        return { pageId: "reports", eventId };
      default:
        return null;
    }
  }
  if (segments.length === 2 && segments[0] === "participants" && segments[1] === "import") {
    return { pageId: "participantImport", eventId };
  }
  return null;
}
