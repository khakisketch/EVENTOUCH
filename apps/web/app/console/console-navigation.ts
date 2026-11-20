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
  | "live"
  | "programs"
  | "draws"
  | "photos"
  | "content"
  | "attendeePage"
  | "rewards"
  | "settings"
  | "reports"
  | "analysis";

export type ConsolePageScope = "organization" | "event";

export type ConsolePageLayout = "directory" | "workspace";

/**
 * Event destinations remain visible in four labeled work groups.
 * A hub is navigation metadata only; permissions and feature gates stay on
 * the pages and the server. `pageIds` is ordered as the operator reads it:
 * the hub's default destination first where possible.
 */
export type ConsoleHubId = "today" | "prepare" | "onsite" | "results";

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
  operations: { label: "입장·스태프", title: "입장·스태프", scope: "event", layout: "workspace" },
  live: { label: "현장 모드", title: "현장 모드", scope: "event", layout: "workspace" },
  programs: { label: "참여 이벤트", title: "참여 이벤트", scope: "event", layout: "workspace" },
  draws: { label: "추첨·투표", title: "추첨·투표", scope: "event", layout: "workspace" },
  photos: { label: "현장 사진", title: "현장 사진", scope: "event", layout: "workspace" },
  content: { label: "공지·안내", title: "공지·안내", scope: "event", layout: "workspace" },
  attendeePage: { label: "참가자 페이지", title: "참가자 페이지", scope: "event", layout: "workspace" },
  rewards: { label: "경품 지급", title: "경품 지급", scope: "event", layout: "workspace" },
  settings: { label: "행사 설정", title: "행사 설정", scope: "event", layout: "workspace" },
  reports: { label: "결과 보고서", title: "결과 보고서", scope: "event", layout: "workspace" },
  analysis: { label: "기간 분석", title: "기간 분석", scope: "event", layout: "workspace" },
};

/**
 * Event rail order. Four labels organize a fully expanded rail; the page order
 * inside each hub follows the operator's actual setup-to-live-to-results
 * sequence. `participantImport` is a participants subpage, not a separate
 * hub, and is included so the rail can name where the operator is.
 */
export const EVENT_HUBS: readonly ConsoleHub[] = [
  { id: "today", label: "운영", pageIds: ["overview", "participants", "messages"], defaultPageId: "overview" },
  { id: "prepare", label: "행사 준비", pageIds: ["attendeePage", "content", "programs", "operations", "settings"], defaultPageId: "attendeePage" },
  { id: "onsite", label: "당일", pageIds: ["live"], defaultPageId: "live" },
  { id: "results", label: "결과", pageIds: ["reports", "rewards", "photos", "analysis"], defaultPageId: "reports" },
];

/**
 * Pages that exist and resolve but have no rail item of their own. 추첨·투표
 * lives inside 참여 이벤트 (the same list and life cycle), and 기간 분석 opens
 * from the report page. Deep links, titles and the active group keep working.
 */
export const RAIL_HIDDEN_PAGE_IDS: readonly ConsolePageId[] = ["draws", "analysis", "content", "programs"];

/**
 * Reopened 2026-11-21 (참가자 화면 허브, C안): 참가자 페이지, 공지·안내, 참여 이벤트
 * share one rail item named 참가자 화면. The three routes, titles and page
 * metadata above are unchanged; the hub (AttendeeScreenHub) joins them with a
 * tab row inside the pages.
 */
export const ATTENDEE_SCREEN_PAGE_IDS: readonly ConsolePageId[] = ["attendeePage", "content", "programs"];

const RAIL_LABELS: Partial<Record<ConsolePageId, string>> = { attendeePage: "참가자 화면" };

/** Rail/menu label; differs from the page label only for the merged 참가자 화면 item. */
export function railLabel(pageId: ConsolePageId): string {
  return RAIL_LABELS[pageId] ?? CONSOLE_PAGES[pageId].label;
}

/** The rail item a hidden page lights up, so the operator still sees where they are. */
export function railPageFor(pageId: ConsolePageId): ConsolePageId {
  if (pageId === "content" || pageId === "programs") return "attendeePage";
  if (pageId === "draws") return "attendeePage";
  if (pageId === "analysis") return "reports";
  return pageId;
}

/** Flattened order for callers that only need a page list. */
export const EVENT_PAGE_IDS: readonly ConsolePageId[] = EVENT_HUBS.flatMap((hub) => hub.pageIds);

const EVENT_MENU_TERMS: Partial<Record<ConsolePageId, string>> = {
  live: "당일 진행 무대 전광판 행사장 화면 컨트롤 룸 큐시트",
  overview: "대시보드 오늘 할 일 입장률",
  participants: "승인 대기 참석자 검색 명찰 티켓 등록자 엑셀 CSV",
  messages: "문자 발송 SMS LMS MMS 알림톡 예약",
  operations: "체크인 입장 퇴장 데스크 부스 스태프 현장 운영",
  programs: "이벤트 퀴즈 투표 추첨 당첨 룰렛 럭키번호 설문 질문 게시판 사진 게임",
  rewards: "경품 수령 지급",
  photos: "증빙 보관함 사진 ZIP",
  content: "공지사항 일정 시간표 장소 오시는 길",
  attendeePage: "안내 QR 안내판 배너 디자인 인쇄 참가자 화면 참가자 페이지",
  settings: "신청 접수 양식 진행 단계 정원",
  reports: "결과 보고서 PDF 인쇄 마감",
  analysis: "통계 기간별 일별 신청 입장",
};

function matchesMenuWords(label: string, query: string): boolean {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const searchable = label.toLowerCase().replace(/[\s·]/g, "");
  return terms.every((term) => searchable.includes(term.replace(/·/g, "")));
}

export function matchesEventMenu(pageId: ConsolePageId, hubLabel: string, query: string): boolean {
  const page = CONSOLE_PAGES[pageId];
  return matchesMenuWords([page.label, page.title, hubLabel, EVENT_MENU_TERMS[pageId] ?? ""].join(" "), query);
}

const SETTINGS_MENU_SHORTCUTS = [
  { label: "참가 접수", terms: "양식 게시 접수 열기 접수 닫기 접수 마감", target: "#settings-intake" },
  { label: "신청 항목", terms: "신청 항목 편집 필수 항목 등록 질문 필드", target: "/fields" },
];

/**
 * Search can lead to a section of a visible page without adding more rail items.
 * Reopened 2026-11-21: 공지·안내 and 참여 이벤트 no longer have rail items, so a
 * search that matches them leads straight to their tab of 참가자 화면.
 */
export function eventMenuShortcuts(pageId: ConsolePageId, eventId: string | undefined, query: string, features: readonly string[] = []) {
  if (!query.trim()) return [];
  if (pageId === "attendeePage") {
    const hasParticipation = features.some((feature) => PARTICIPATION_FEATURE_IDS.includes(feature));
    return (["content", "programs"] as const)
      .filter((id) => id !== "programs" || hasParticipation)
      .filter((id) => matchesMenuWords(`${CONSOLE_PAGES[id].label} ${EVENT_MENU_TERMS[id] ?? ""}`, query))
      .flatMap((id) => {
        const href = consolePageHref(id, eventId);
        return href ? [{ label: CONSOLE_PAGES[id].label, href }] : [];
      });
  }
  if (pageId !== "settings") return [];
  const href = consolePageHref(pageId, eventId);
  if (!href) return [];
  return SETTINGS_MENU_SHORTCUTS.filter(({ label, terms }) => matchesMenuWords(`${label} ${terms}`, query))
    .map(({ label, target }) => ({ label, href: `${href}${target}` }));
}

const PARTICIPATION_FEATURE_IDS: readonly string[] = ["poll", "quiz", "qa", "draw", "survey", "stamp", "photo", "board"];

/** Finds the hub that owns a page. Organization pages return undefined. */
export function consoleHubForPage(pageId: ConsolePageId): ConsoleHub | undefined {
  const railPage = railPageFor(pageId);
  return EVENT_HUBS.find((hub) => hub.pageIds.includes(pageId) || hub.pageIds.includes(railPage));
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
    case "live":
    case "programs":
    case "draws":
    case "photos":
    case "content":
    case "attendeePage":
    case "rewards":
    case "settings":
    case "reports":
    case "analysis": {
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
        case "live":
          return `${base}/live`;
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
        case "analysis":
          return `${base}/analysis`;
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
      case "live":
        return { pageId: "live", eventId };
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
      case "analysis":
        return { pageId: "analysis", eventId };
      default:
        return null;
    }
  }
  if (segments.length === 2 && segments[0] === "participants" && segments[1] === "import") {
    return { pageId: "participantImport", eventId };
  }
  if (segments.length === 2 && segments[0] === "settings" && segments[1] === "fields") {
    return { pageId: "settings", eventId };
  }
  return null;
}
