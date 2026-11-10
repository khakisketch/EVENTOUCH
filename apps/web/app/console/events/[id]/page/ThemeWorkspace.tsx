"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent, FocusEvent as ReactFocusEvent, MouseEvent as ReactMouseEvent } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { eventStageLabel } from "../../../../event-stage";
import {
  DEFAULT_HOME_STYLE,
  homeImageLabel,
  normalizeHomeImage,
  normalizeHomeStyle,
  sameHomeImage,
  type HomeImage,
  type HomeStyle,
} from "../../../../../lib/attendee-home";
import { normalizeHomeMenus, type ConfigurableHomeMenu, type HomeMenus, type HomeProgram } from "../../../../../lib/attendee-home-menus";
import AttendeeHomeLanding from "../../../../event/[slug]/home/AttendeeHomeLanding";
import attendeeHomeStyles from "../../../../event/[slug]/home/home.module.css";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import PublicationReview from "../../../console-ui/PublicationReview";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import styles from "./page.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { acknowledgeOperatorReceipt, confirmsAttendeePageCommand, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt } from "../../../../../lib/operator-receipts";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_MAX_BYTES = 600_000;
const MENU_LABELS: Record<ConfigurableHomeMenu, string> = {
  notice: "공지사항", lucky: "럭키드로우 번호", roulette: "룰렛 이벤트", vote: "순위 투표", stamp: "부스 인증",
};
const MENU_GROUPS: Array<{ label: string; keys: ConfigurableHomeMenu[] }> = [
  { label: "행사 안내", keys: ["notice", "lucky"] },
  { label: "행사 참여", keys: ["roulette", "vote", "stamp"] },
];

type PageFields = {
  intro: string;
  accent: string;
  showAnnouncements: boolean;
  showSchedule: boolean;
  showVenue: boolean;
  showPrograms: boolean;
};

type DesignForm = { homeStyle: HomeStyle; keyvisual: HomeImage | null; homeMenus: HomeMenus };
type Snapshot = {
  eventName: string;
  slug: string;
  eventStage: string;
  defaultHomeBanner: "legacy" | "neutral";
  eventMeta?: string;
  archived: boolean;
  pageFields: PageFields;
  publishedPageFields: PageFields;
  form: DesignForm;
  draftVersion: number;
  publishedVersion: number;
  publishedAt: string | null;
  publishedDesign: DesignForm;
  availablePrograms: HomeProgram[];
  programOptions: Array<HomeProgram & { available: boolean }>;
  unavailableMenus: ConfigurableHomeMenu[];
};
type Ready = Snapshot & { kind: "ready"; savedForm: DesignForm; savedPageFields: PageFields };
// Names the section in view for the jump-nav active link.
const THEME_SECTION_LABELS: Record<string, string> = {
  "theme-edit": "편집",
  "theme-save": "저장·게시",
  "home-preview-heading": "미리보기",
};

// Maps any focused or jumped-to node to the jump-nav section that owns it.
// The save region lives inside the edit column, so it wins first; the
// preview panel is a labelled section of its own.
function sectionForNode(node: Element | null): string | null {
  if (!node || typeof node.closest !== "function") return null;
  if (node.closest("#theme-save")) return "theme-save";
  const section = node.closest("section");
  if (section?.getAttribute("aria-labelledby") === "home-preview-heading") return "home-preview-heading";
  if (node.closest("#theme-edit")) return "theme-edit";
  return null;
}

type EditorState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "denied"; message: string }
  | Ready;
type UploadIntent = {
  file: File;
  objectUrl: string;
  commandId: string;
  previousImage: HomeImage | null;
  status: "uploading" | "failed" | "uploaded";
  uncertain: boolean;
  error?: string;
};
type ConflictState = { latest: Snapshot | null; loading: boolean; error: string | null; afterWrite?: boolean; contextChanged?: boolean };

function isKnownEventStage(stage: string): boolean {
  return ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"].includes(stage);
}

function isPublicEventStage(stage: string): boolean {
  return ["READY", "LIVE", "ENDED"].includes(stage);
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function validAccent(value: unknown): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : "#E76D26";
}

function version(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// Deterministic payload serialization for idempotency fingerprints.
// Key order must not affect the fingerprint: the same logical payload
// retried after an ambiguous failure has to resolve to the same key.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`)
    .join(",")}}`;
}

// An in-flight save/publish intent binds one immutable payload to one
// command id. The server receipt matches id+command, not payload: reusing a
// retained id for CHANGED values would replay the earlier response and
// overwrite the new edits. Unchanged retries reuse the id; any edit mints a
// fresh one.
type PendingIntent = { commandId: string; fingerprint: string; uncertain: boolean };

function isUncertainStatus(status: number): boolean {
  return status >= 500 || [408, 425, 429].includes(status);
}

function formatPublishedAt(value: string | null): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value.slice(0, 10);
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
}

function parseSnapshot(
  bootstrapValue: unknown,
  meValue: unknown,
  eventId: string,
  afterWrite = false,
): Snapshot | { denied: string } {
  const bootstrap = record(record(bootstrapValue)?.state);
  const user = record(record(meValue)?.user);
  if (!bootstrap || !user) throw new Error("행사 정보를 불러오지 못했습니다.");
  const userId = text(user.id);
  const role = text(user.role);
  const accounts = Array.isArray(bootstrap.accounts) ? bootstrap.accounts.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const account = accounts.find((item) => item.id === userId);
  const isOwner = role === "AGENCY" || account?.orgOwner === true;
  const memberships = Array.isArray(bootstrap.memberships)
    ? bootstrap.memberships
        .map(record)
        .filter((item): item is Record<string, unknown> => item !== null)
        .flatMap((item) => (
          typeof item.accountId === "string" && typeof item.eventId === "string"
            ? [{ accountId: item.accountId, eventId: item.eventId, write: item.write }]
            : []
        ))
    : [];
  // Page write gate mirrors the server scope map (attendee.page.save is page
  // scope): owners and fully/granted managers edit, everyone else is denied
  // with the reason. The server re-checks save/publish either way.
  const canWritePage = canWriteEvent({ role, userId, memberships, eventId }, "attendee.page.save");
  if (!isOwner && !canWritePage) {
    const isMember = memberships.some((item) => item.accountId === userId && item.eventId === eventId);
    if (isMember && role === "MANAGER") {
      return { denied: "참가자 화면 쓰기 권한이 없습니다. 화면 구성 변경이 필요하면 담당 행사 운영자에게 요청하세요." };
    }
    return { denied: "이 행사의 참가자 화면을 관리할 권한이 없습니다." };
  }
  const events = Array.isArray(bootstrap.events) ? bootstrap.events.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const event = events.find((item) => item.id === eventId);
  const workspaces = record(bootstrap.workspaces);
  const workspace = record(workspaces?.[eventId]);
  if (!event || !workspace) throw new Error("행사를 찾을 수 없습니다.");
  const eventStage = text(event.stage).toUpperCase();
  if (afterWrite && (!isKnownEventStage(eventStage) || !text(event.slug))) throw new Error("행사 공개 상태를 확인하지 못했습니다.");
  const pageExperience = record(workspace.pageExperience) ?? {};
  const draft = record(pageExperience.draft) ?? {};
  const published = record(pageExperience.published) ?? {};
  // A post-write refresh must actually contain the saved page. Initial
  // loads intentionally tolerate legacy workspaces without this section.
  const completePage = (page: Record<string, unknown>) =>
    typeof page.intro === "string" && typeof page.accent === "string" && /^#[0-9a-f]{6}$/i.test(page.accent) &&
    ["showAnnouncements", "showSchedule", "showVenue", "showPrograms"].every((key) => typeof page[key] === "boolean") &&
    Boolean(record(page.homeStyle)) && Boolean(record(page.homeMenus)) && Object.hasOwn(page, "keyvisual");
  const validVersion = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
  if (afterWrite && (!Object.hasOwn(pageExperience, "publishedAt") || !validVersion(pageExperience.draftVersion) || !completePage(draft) ||
      (pageExperience.publishedAt != null && (typeof pageExperience.publishedAt !== "string" ||
        !Number.isFinite(Date.parse(pageExperience.publishedAt)) || !validVersion(pageExperience.publishedVersion) || !completePage(published))))) {
    throw new Error("최신 참가자 페이지 상태를 확인하지 못했습니다.");
  }
  const branding = record(workspace.branding) ?? {};
  const pageFields: PageFields = {
    intro: text(draft.intro) || text(branding.tagline) || text(event.name),
    accent: validAccent(draft.accent),
    showAnnouncements: draft.showAnnouncements !== false,
    showSchedule: draft.showSchedule !== false,
    showVenue: draft.showVenue !== false,
    showPrograms: draft.showPrograms !== false,
  };
  const venue = record(workspace.venue);
  const eventName = text(event.name) || "행사";
  const eventMeta = formatConsoleEventMeta({
    date: text(event.date),
    start: text(event.start),
    end: text(event.end),
    venue: text(venue?.name),
  });
  const form: DesignForm = {
    homeStyle: normalizeHomeStyle(draft.homeStyle),
    keyvisual: normalizeHomeImage(Object.hasOwn(draft, "keyvisual") ? draft.keyvisual : branding.keyvisual),
    homeMenus: normalizeHomeMenus(draft.homeMenus),
  };
  const publishedDesign: DesignForm = {
    homeStyle: normalizeHomeStyle(published.homeStyle),
    keyvisual: normalizeHomeImage(Object.hasOwn(published, "keyvisual") ? published.keyvisual : branding.keyvisual),
    homeMenus: normalizeHomeMenus(published.homeMenus),
  };
  const enabled = new Set(Array.isArray(event.features) ? event.features.filter((value): value is string => typeof value === "string") : []);
  const programOptions: Array<HomeProgram & { available: boolean }> = Array.isArray(workspace.modules) ? workspace.modules.flatMap((value) => {
    const module = record(value);
    return typeof module?.id === "string" && typeof module.title === "string"
      ? [{ id: module.id, title: module.title, available: module.published === true && module.status !== "DRAFT" && enabled.has(text(module.type)) }] : [];
  }) : [];
  const availablePrograms: HomeProgram[] = programOptions.filter((item) => item.available).map(({ id, title }) => ({ id, title }));
  const unavailableMenus: ConfigurableHomeMenu[] = [
    ...(!enabled.has("draw") ? ["lucky" as const, "roulette" as const] : []),
    ...(!enabled.has("poll") ? ["vote" as const] : []),
    ...(!enabled.has("stamp") ? ["stamp" as const] : []),
  ];
  const publishedPageFields: PageFields = {
    intro: text(published.intro) || text(branding.tagline) || text(event.name),
    accent: validAccent(published.accent),
    showAnnouncements: published.showAnnouncements !== false,
    showSchedule: published.showSchedule !== false,
    showVenue: published.showVenue !== false,
    showPrograms: published.showPrograms !== false,
  };
  return {
    eventName,
    slug: text(event.slug),
    eventStage,
    defaultHomeBanner: workspace.defaultHomeBanner === "neutral" ? "neutral" : "legacy",
    // Compact fact-only line for the shared frame: the frame already shows
    // `행사 / {eventName}` above the H1, so the name is not repeated here.
    eventMeta,
    archived: text(event.stage).toUpperCase() === "ARCHIVED",
    pageFields,
    publishedPageFields,
    form,
    draftVersion: version(pageExperience.draftVersion),
    publishedVersion: version(pageExperience.publishedVersion),
    publishedAt: typeof pageExperience.publishedAt === "string" ? pageExperience.publishedAt : null,
    publishedDesign,
    availablePrograms,
    programOptions,
    unavailableMenus,
  };
}

function formIsDirty(form: DesignForm, saved: DesignForm): boolean {
  return JSON.stringify(form.homeStyle) !== JSON.stringify(saved.homeStyle) || !sameHomeImage(form.keyvisual, saved.keyvisual) ||
    JSON.stringify(form.homeMenus) !== JSON.stringify(saved.homeMenus);
}

function pageFieldsAreDirty(current: { pageFields: PageFields; savedPageFields: PageFields }): boolean {
  return JSON.stringify(current.pageFields) !== JSON.stringify(current.savedPageFields);
}

function describeChangedPageFields(from: PageFields, to: PageFields): string[] {
  const changed: string[] = [];
  if (from.intro !== to.intro) changed.push("행사 소개");
  if (from.accent !== to.accent) changed.push("강조색");
  const visibility: Array<[keyof PageFields, string]> = [
    ["showAnnouncements", "공지"],
    ["showSchedule", "행사 일시"],
    ["showVenue", "장소"],
    ["showPrograms", "프로그램 일정"],
  ];
  const toggled = visibility.filter(([key]) => from[key] !== to[key]).map(([, label]) => label);
  if (toggled.length) changed.push(`노출 항목(${toggled.join("·")})`);
  return changed;
}

const HOME_STYLE_LABELS: Array<[keyof HomeStyle, string]> = [
  ["backgroundColor", "배경색"],
  ["heroTitle", "배너 제목"],
  ["heroSubtitle", "보조 문구"],
  ["heroLayout", "배너 배치"],
  ["titleScale", "제목 크기"],
  ["imageFocus", "이미지 초점"],
  ["textAlign", "문구 정렬"],
  ["textTone", "문구 색상"],
  ["overlay", "읽기 배경"],
];

const PAGE_FIELD_LABELS: Array<[keyof PageFields, string]> = [
  ["intro", "행사 소개"],
  ["accent", "강조색"],
  ["showAnnouncements", "공지 보기"],
  ["showSchedule", "행사 일시 보기"],
  ["showVenue", "장소 보기"],
  ["showPrograms", "프로그램 일정 보기"],
];

function describeChangedDesign(from: DesignForm, to: DesignForm): string[] {
  const changed = HOME_STYLE_LABELS.flatMap(([key, label]) => from.homeStyle[key] !== to.homeStyle[key] ? [label] : []);
  if (!sameHomeImage(from.keyvisual, to.keyvisual)) changed.push("배너 이미지");
  if (JSON.stringify(from.homeMenus) !== JSON.stringify(to.homeMenus)) changed.push("홈 메뉴");
  return changed;
}

function comparisonRows(fromForm: DesignForm, fromFields: PageFields, toForm: DesignForm, toFields: PageFields, programs: Array<HomeProgram>): Array<{ label: string; before: string; after: string }> {
  const choices: Record<string, string> = { centered: "가운데 제목", "bottom-overlay": "아래쪽 제목", "image-only": "이미지만", standard: "기본", large: "크게", center: "가운데", left: "왼쪽", right: "오른쪽", top: "위쪽", bottom: "아래쪽", light: "흰색", dark: "짙은 색", none: "없음", soft: "부드럽게", strong: "강하게" };
  const display = (value: unknown) => typeof value === "boolean" ? (value ? "보기" : "숨김") : typeof value === "string" ? (choices[value] || value || "기본값") : "기본값";
  const rows = HOME_STYLE_LABELS.flatMap(([key, label]) => fromForm.homeStyle[key] !== toForm.homeStyle[key]
    ? [{ label, before: display(fromForm.homeStyle[key]), after: display(toForm.homeStyle[key]) }] : []);
  if (!sameHomeImage(fromForm.keyvisual, toForm.keyvisual)) rows.push({ label: "배너 이미지", before: homeImageLabel(fromForm.keyvisual), after: homeImageLabel(toForm.keyvisual) });
  if (JSON.stringify(fromForm.homeMenus) !== JSON.stringify(toForm.homeMenus)) {
    const menuSummary = (menus: HomeMenus) => `${MENU_GROUPS.map((group) => `${group.label}: ${menus.order.filter((key) => group.keys.includes(key)).map((key) => MENU_LABELS[key]).join(" → ")}`).join(" / ")} · 숨김 ${menus.hidden.map((key) => MENU_LABELS[key]).join("·") || "없음"} · 개별 프로그램 ${menus.programs.length}개`;
    rows.push({ label: "홈 메뉴", before: menuSummary(fromForm.homeMenus), after: menuSummary(toForm.homeMenus) });
    if (JSON.stringify(fromForm.homeMenus.programs) !== JSON.stringify(toForm.homeMenus.programs)) {
      const programSummary = (ids: string[]) => ids.map((id) => programs.find((program) => program.id === id)?.title || "사용할 수 없는 프로그램").join(" → ") || "없음";
      rows.push({ label: "개별 프로그램 순서", before: programSummary(fromForm.homeMenus.programs), after: programSummary(toForm.homeMenus.programs) });
    }
  }
  for (const [key, label] of PAGE_FIELD_LABELS) {
    if (fromFields[key] !== toFields[key]) rows.push({ label, before: display(fromFields[key]), after: display(toFields[key]) });
  }
  return rows;
}

function homeBackgroundInk(color: string): string {
  const rgb = color.slice(1).match(/.{2}/g)?.map((channel) => parseInt(channel, 16) / 255) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const background = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const dark = "#17252B";
  const darkRgb = dark.slice(1).match(/.{2}/g)?.map((channel) => parseInt(channel, 16) / 255) ?? [0, 0, 0];
  const darkLinear = darkRgb.map((channel) => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  const darkLuminance = 0.2126 * darkLinear[0] + 0.7152 * darkLinear[1] + 0.0722 * darkLinear[2];
  const contrastDark = (background + 0.05) / (darkLuminance + 0.05);
  const contrastLight = 1.05 / (background + 0.05);
  return contrastDark >= contrastLight ? dark : "#FFFFFF";
}

async function loadSnapshot(eventId: string, afterWrite = false): Promise<Snapshot | { denied: string }> {
  // A signal bypasses shared in-flight reads: a receipt replay must be
  // followed by a new read, not one started before the command completed.
  const controller = afterWrite ? new AbortController() : null;
  const timer = controller ? window.setTimeout(() => controller.abort(), 12000) : null;
  try {
  const [meResponse, bootstrapResponse] = await Promise.all([
    consoleFetch("/api/auth/me", { cache: "no-store", signal: controller?.signal }),
    consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller?.signal }),
  ]);
  if (meResponse.status === 401 || bootstrapResponse.status === 401) {
    const error = new Error("로그인이 필요합니다.");
    Object.assign(error, { status: 401 });
    throw error;
  }
  const [me, bootstrap] = await Promise.all([
    meResponse.json().catch(() => null),
    bootstrapResponse.json().catch(() => null),
  ]);
  if (!meResponse.ok || !bootstrapResponse.ok) throw new Error("행사 정보를 불러오지 못했습니다.");
  if (controller?.signal.aborted) throw new Error("최신 참가자 페이지 상태를 확인하지 못했습니다.");
  return parseSnapshot(bootstrap, me, eventId, afterWrite);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
    controller?.abort();
  }
}

export default function ThemeWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<EditorState>({ kind: "loading" });
  const [activeSection, setActiveSection] = useState("theme-edit");
  const [mobileView, setMobileView] = useState<"edit" | "preview">("edit");
  const lastEditTarget = useRef<HTMLElement | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [upload, setUpload] = useState<UploadIntent | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 390, height: 700 });
  // Read-only preview choice: which snapshot feeds the landing below. Never
  // touches editor fields and stays outside the unsaved-work guard.
  const [previewSource, setPreviewSource] = useState<"draft" | "published">("draft");
  const [previewHasTicket, setPreviewHasTicket] = useState(true);
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [commandBusy, setCommandBusy] = useState<"save" | "publish" | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [cancelImagePending, setCancelImagePending] = useState(false);
  const [clearImagePending, setClearImagePending] = useState(false);
  const [discardPending, setDiscardPending] = useState(false);
  const [loadPublishedPending, setLoadPublishedPending] = useState(false);
  const [defaultsPending, setDefaultsPending] = useState(false);
  const [useLatestPending, setUseLatestPending] = useState(false);
  const [mergePending, setMergePending] = useState<{ kept: string[]; conflicted: string[] } | null>(null);
  const [publishPending, setPublishPending] = useState(false);
  const pendingSaveRef = useRef<PendingIntent | null>(null);
  const pendingPublishRef = useRef<PendingIntent | null>(null);
  const failureFocusOriginRef = useRef<HTMLElement | null>(null);
  const uploadUrlRef = useRef<string | null>(null);
  const activeThemeEventRef = useRef(eventId);
  const loadedThemeEventRef = useRef<string | null>(null);
  activeThemeEventRef.current = eventId;
  const previousThemeEventRef = useRef(eventId);
  useEffect(() => {
    if (previousThemeEventRef.current === eventId) return;
    previousThemeEventRef.current = eventId;
    loadedThemeEventRef.current = null;
    pendingSaveRef.current = null;
    pendingPublishRef.current = null;
    if (uploadUrlRef.current) URL.revokeObjectURL(uploadUrlRef.current);
    uploadUrlRef.current = null;
    setUpload(null);
    setState({ kind: "loading" });
    setFailure(null);
    setNotice(null);
    setConflict(null);
    setCommandBusy(null);
    setPublishPending(false);
    setCancelImagePending(false);
    setClearImagePending(false);
    setDiscardPending(false);
    setLoadPublishedPending(false);
    setDefaultsPending(false);
    setUseLatestPending(false);
    setMergePending(null);
    failureFocusOriginRef.current = null;
  }, [eventId]);
  useEffect(() => {
    const origin = failureFocusOriginRef.current;
    if (!failure || !origin) return;
    failureFocusOriginRef.current = null;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active !== origin && active !== document.body && active?.isConnected) return;
      const target = document.getElementById("theme-error");
      target?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [failure]);
  // The edit form stacks every field above the save/publish actions, so a
  // keyboard-only save means tabbing through all of them. This ref is the
  // landing target of the "skip the fields" link at the top of the form:
  // focusing the save region (not just scrolling to it) puts the next Tab
  // stop on the save button itself.
  const saveActionsRef = useRef<HTMLDivElement>(null);

  // The active link follows where the operator actually is: explicit jumps and
  // real focus move it; scrolling only moves it through the genuine
  // document flow (see the observer below).
  const syncSectionFromFocus = useCallback((event: ReactFocusEvent<HTMLElement>) => {
    const target = event.target as Element | null;
    if (target instanceof HTMLElement && target.matches("input, select, textarea") && target.closest("#theme-edit")) lastEditTarget.current = target;
    // Preview auxiliaries (source/viewport switches) never rename the
    // location: only the explicit preview jump, which focuses the heading
    // itself, may name the preview. Real scroll arrival stays the
    // observer's job on stacked widths.
    if (target && typeof target.closest === "function") {
      const inPreview = target.closest('section[aria-labelledby="home-preview-heading"]');
      if (inPreview && target.id !== "home-preview-heading") return;
    }
    const section = sectionForNode(target);
    if (section && section in THEME_SECTION_LABELS) setActiveSection(section);
  }, []);

  // Unsaved work the cross-route guard must hold: local edits, an upload
  // context that is not settled, a pending save/publish intent, or an
  // unresolved version conflict. Read-only preview choices stay unguarded.
  useConsoleDraftGuard(
    state.kind === "ready" && (
      formIsDirty(state.form, state.savedForm) ||
      pageFieldsAreDirty(state) ||
      upload !== null ||
      pendingSaveRef.current !== null ||
      pendingPublishRef.current !== null ||
      conflict !== null
    ),
    "참가자 페이지에 저장하지 않은 변경이 있습니다."
  );

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const snapshot = await loadSnapshot(eventId);
        if (cancelled || activeThemeEventRef.current !== eventId) return;
        if ("denied" in snapshot) {
          setState({ kind: "denied", message: snapshot.denied });
          return;
        }
        loadedThemeEventRef.current = eventId;
        setState({ ...snapshot, kind: "ready", savedForm: snapshot.form, savedPageFields: { ...snapshot.pageFields } });
      } catch (error) {
        if (cancelled || activeThemeEventRef.current !== eventId) return;
        if (record(error)?.status === 401) {
          router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
          return;
        }
        setState({ kind: "failed", message: error instanceof Error ? error.message : "연결하지 못했습니다." });
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [eventId, reloadTick, router]);

  // Desktop lays the editor and the preview side by side, so the sticky
  // preview and the sticky save bar would always own the in-view link.
  // There the active link keeps the basic edit context and moves only on
  // explicit jumps and real focus. On stacked (mobile) widths a single
  // document flow decides, and the preview takes over only when genuinely
  // reached. The sticky save bar never joins the observation on either
  // width: it reports through focus and explicit jumps only, so its stuck
  // position cannot rename the location on first paint. Matches the 1080px
  // layout breakpoint in page.module.css.
  const [stackedNav, setStackedNav] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia("(max-width: 1080px)");
    const sync = () => setStackedNav(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Anchor clicks keep working natively whether or not the observer is
  // available; the focus handoff in ConsoleSectionNav and the skip link
  // both land focus, which the capture handler above turns into the
  // active link. This covers fragment changes that move no focus.
  useEffect(() => {
    const sync = () => {
      const id = window.location.hash.slice(1);
      const target = document.getElementById(id);
      if (id === "home-preview-heading") setMobileView("preview");
      else if (id === "theme-edit" || id === "theme-save" || id === "theme-save-draft") setMobileView("edit");
      const section = sectionForNode(target);
      if (section && section in THEME_SECTION_LABELS) setActiveSection(section);
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [state.kind]);

  // Names the section in view for the jump-nav active link. Canonical
  // document order wins ties, so a sticky panel behind the arrival point
  // never renames where the operator has arrived.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = stackedNav
      ? ["theme-edit", "home-preview-heading"]
      : ["theme-edit"];
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = new Set(
          entries.filter((entry) => entry.isIntersecting).map((entry) => entry.target.id)
        );
        for (const id of ids) {
          if (visible.has(id)) setActiveSection(id);
        }
      },
      { rootMargin: "-30% 0px -60% 0px" }
    );
    for (const id of ids) {
      const node = document.getElementById(id);
      if (node) observer.observe(node);
    }
    return () => observer.disconnect();
  }, [state, stackedNav]);

  useEffect(() => () => {
    if (uploadUrlRef.current) URL.revokeObjectURL(uploadUrlRef.current);
  }, []);

  const revokeUploadPreview = useCallback(() => {
    if (uploadUrlRef.current) URL.revokeObjectURL(uploadUrlRef.current);
    uploadUrlRef.current = null;
  }, []);

  const updateForm = useCallback((update: (form: DesignForm) => DesignForm) => {
    setState((current) => current.kind === "ready" ? { ...current, form: update(current.form) } : current);
    setFailure(null);
    setNotice(null);
  }, []);

  const updatePageField = useCallback(<K extends keyof PageFields>(field: K, value: PageFields[K]) => {
    setState((current) => current.kind === "ready"
      ? { ...current, pageFields: { ...current.pageFields, [field]: value } }
      : current);
    setFailure(null);
    setNotice(null);
  }, []);

  async function uploadFile(intent: UploadIntent) {
    setUpload({ ...intent, status: "uploading", error: undefined });
    try {
      const url = `/api/events/${encodeURIComponent(eventId)}/files?name=${encodeURIComponent(intent.file.name)}&commandId=${encodeURIComponent(intent.commandId)}`;
      const response = await consoleFetch(url, {
        method: "POST",
        headers: { "content-type": intent.file.type },
        body: intent.file,
      });
      const payload = record(await response.json().catch(() => null));
      if (activeThemeEventRef.current !== eventId) return;
      const file = record(payload?.file);
      const fileId = text(file?.fileId);
      if (!response.ok || !/^[A-Za-z0-9_-]{1,160}$/.test(fileId) || file?.name !== intent.file.name ||
          file?.type !== intent.file.type || file?.size !== intent.file.size ||
          !Number.isInteger(file?.width) || Number(file?.width) < 1 || !Number.isInteger(file?.height) || Number(file?.height) < 1) {
        const uncertain = intent.uncertain || response.ok || isUncertainStatus(response.status);
        setUpload({ ...intent, uncertain, status: "failed", error: uncertain
          ? "업로드 결과를 확인하지 못했습니다. 이미 올라갔을 수 있으므로 같은 요청으로 다시 시도하세요."
          : text(payload?.error) || "파일을 올리지 못했습니다. 같은 파일로 다시 시도하세요." });
        if (response.status === 401 && !uncertain) router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
        return;
      }
      const image: HomeImage = {
        fileId,
        name: text(file?.name) || intent.file.name,
        type: intent.file.type,
        size: intent.file.size,
        ...(typeof file?.width === "number" ? { width: file.width } : {}),
        ...(typeof file?.height === "number" ? { height: file.height } : {}),
      };
      setState((current) => current.kind === "ready"
        ? { ...current, form: { ...current.form, keyvisual: image } }
        : current);
      setUpload({ ...intent, uncertain: false, status: "uploaded" });
      setFailure(null);
      setNotice("배너 이미지를 올렸습니다. 참가자에게 보이려면 초안을 저장하고 게시하세요.");
    } catch (error) {
      if (activeThemeEventRef.current !== eventId) return;
      // Keep the same upload receipt intent and local object URL. Retrying
      // this exact request avoids creating duplicate stored files.
      const uncertain = intent.uncertain || !isOrganizationContextBlock(error);
      setUpload({ ...intent, uncertain, status: "failed", error: uncertain
        ? "업로드 응답을 확인하지 못했습니다. 이미 올라갔을 수 있으므로 같은 요청으로 다시 시도하세요."
        : "현재 조직을 확인한 뒤 같은 파일 요청을 다시 시도하세요." });
    }
  }

  function selectImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file || commandBusy) return;
    if (!IMAGE_TYPES.has(file.type)) {
      setFailure({ message: "배너 이미지는 PNG, JPEG, WEBP 형식만 올릴 수 있습니다.", field: "keyvisual" });
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      setFailure({ message: "배너 이미지는 600KB 이하로 올려주세요.", field: "keyvisual" });
      return;
    }
    if (upload?.status === "uploading" || upload?.status === "failed") return;
    revokeUploadPreview();
    const objectUrl = URL.createObjectURL(file);
    uploadUrlRef.current = objectUrl;
    const intent: UploadIntent = {
      file,
      objectUrl,
      commandId: randomCommandId(),
      previousImage: state.kind === "ready" ? state.form.keyvisual : null,
      status: "uploading",
      uncertain: false,
    };
    setUpload(intent);
    setFailure(null);
    setNotice(null);
    void uploadFile(intent);
  }

  function requestCancelUpload() {
    if (!upload || state.kind !== "ready" || commandBusy) return;
    if (upload.status === "uploading") return;
    if (upload.status === "uploaded" || upload.status === "failed") {
      setCancelImagePending(true);
    }
  }

  function confirmCancelUpload() {
    if (!upload || state.kind !== "ready" || commandBusy) {
      setCancelImagePending(false);
      return;
    }
    if (upload.status !== "uploaded" && upload.status !== "failed") {
      setCancelImagePending(false);
      return;
    }
    updateForm((form) => ({ ...form, keyvisual: upload.previousImage }));
    revokeUploadPreview();
    setUpload(null);
    setCancelImagePending(false);
    setNotice("선택한 배너 이미지를 취소했습니다. 저장된 초안과 게시본은 바뀌지 않았습니다.");
  }

  function requestClearImage() {
    if (commandBusy) return;
    if (upload && upload.status !== "uploading") {
      requestCancelUpload();
      return;
    }
    if (upload?.status === "uploading" || state.kind !== "ready") return;
    if (!state.form.keyvisual) return;
    setClearImagePending(true);
  }

  function confirmClearImage() {
    if (commandBusy || state.kind !== "ready") {
      setClearImagePending(false);
      return;
    }
    if (upload || !state.form.keyvisual) {
      setClearImagePending(false);
      return;
    }
    revokeUploadPreview();
    setUpload(null);
    updateForm((form) => ({ ...form, keyvisual: null }));
    setClearImagePending(false);
    setNotice("기본 배너 이미지로 바꿨습니다. 저장 후 게시해야 참가자에게 적용됩니다.");
  }

  function requestDiscardChanges() {
    if (state.kind !== "ready" || commandBusy) return;
    if (upload?.status === "uploading") return;
    setDiscardPending(true);
  }

  function confirmDiscardChanges() {
    if (state.kind !== "ready" || commandBusy) {
      setDiscardPending(false);
      return;
    }
    if (upload?.status === "uploading") {
      setDiscardPending(false);
      return;
    }
    revokeUploadPreview();
    setUpload(null);
    setState((current) => current.kind === "ready"
      ? { ...current, form: current.savedForm, pageFields: { ...current.savedPageFields } }
      : current);
    setConflict(null);
    setFailure(null);
    setDiscardPending(false);
    setNotice("저장된 초안을 불러왔습니다. 게시된 화면은 변경되지 않았습니다.");
  }

  function applyPublishedDesign() {
    if (state.kind !== "ready") return;
    revokeUploadPreview();
    setUpload(null);
    setConflict(null);
    setFailure(null);
    setState((current) => current.kind === "ready"
      ? { ...current, form: { ...current.publishedDesign, homeStyle: { ...current.publishedDesign.homeStyle }, homeMenus: current.form.homeMenus } }
      : current);
    setNotice(state.publishedAt
      ? "현재 게시된 디자인을 편집기에 불러왔습니다. 초안 저장 후 다시 게시해야 변경할 수 있습니다."
      : "아직 게시된 버전이 없어 기본 공개 디자인을 불러왔습니다. 저장 후 게시해야 적용됩니다.");
  }

  function requestLoadPublishedDesign() {
    if (state.kind !== "ready" || commandBusy) return;
    if (upload?.status === "uploading") return;
    const hasLocalChanges = formIsDirty(state.form, state.savedForm) || Boolean(upload);
    if (!hasLocalChanges) {
      applyPublishedDesign();
      return;
    }
    setLoadPublishedPending(true);
  }

  function confirmLoadPublishedDesign() {
    if (state.kind !== "ready" || commandBusy) {
      setLoadPublishedPending(false);
      return;
    }
    if (upload?.status === "uploading") {
      setLoadPublishedPending(false);
      return;
    }
    setLoadPublishedPending(false);
    applyPublishedDesign();
  }

  function applyDesignDefaults() {
    revokeUploadPreview();
    setUpload(null);
    setConflict(null);
    setState((current) => current.kind === "ready"
      ? { ...current, form: { homeStyle: { ...DEFAULT_HOME_STYLE }, keyvisual: null, homeMenus: current.form.homeMenus } }
      : current);
    setNotice("기본 디자인을 불러왔습니다. 초안 저장과 게시 전까지 참가자 화면은 그대로입니다.");
  }

  function requestResetDesignDefaults() {
    if (state.kind !== "ready" || commandBusy) return;
    if (upload?.status === "uploading") return;
    const hasChanges = formIsDirty(state.form, state.savedForm) || Boolean(upload);
    if (!hasChanges) {
      applyDesignDefaults();
      return;
    }
    setDefaultsPending(true);
  }

  function confirmResetDesignDefaults() {
    if (state.kind !== "ready" || commandBusy) {
      setDefaultsPending(false);
      return;
    }
    if (upload?.status === "uploading") {
      setDefaultsPending(false);
      return;
    }
    setDefaultsPending(false);
    applyDesignDefaults();
  }

  async function reloadLatestDraft(contextOverride = false) {
    if (conflict?.loading) return;
    const contextChanged = contextOverride || conflict?.contextChanged;
    setConflict({ latest: null, loading: true, error: null, contextChanged });
    try {
      const snapshot = await loadSnapshot(eventId);
      if (activeThemeEventRef.current !== eventId) return;
      if ("denied" in snapshot) {
        setConflict({ latest: null, loading: false, error: snapshot.denied, contextChanged });
        return;
      }
      setConflict({ latest: snapshot, loading: false, error: null, contextChanged });
    } catch (error) {
      if (activeThemeEventRef.current !== eventId) return;
      if (record(error)?.status === 401) {
        router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
        return;
      }
      setConflict({ latest: null, loading: false, error: error instanceof Error ? error.message : "최신 초안을 확인하지 못했습니다.", contextChanged });
    }
  }

  function applyLatestDraft(latest: Snapshot) {
    revokeUploadPreview();
    setUpload(null);
    setState({ ...latest, kind: "ready", savedForm: latest.form, savedPageFields: { ...latest.pageFields } });
    setConflict(null);
    setFailure(null);
    setNotice("최신 초안을 불러왔습니다. 내용을 확인한 뒤 저장하거나 게시하세요.");
  }

  function requestUseLatestDraft() {
    if (state.kind !== "ready" || !conflict?.latest || commandBusy) return;
    const localChanges = formIsDirty(state.form, state.savedForm) || pageFieldsAreDirty(state) || Boolean(upload) ||
      Boolean(conflict.afterWrite && (formIsDirty(state.form, conflict.latest.form) ||
        JSON.stringify(state.pageFields) !== JSON.stringify(conflict.latest.pageFields)));
    if (!localChanges) {
      applyLatestDraft(conflict.latest);
      return;
    }
    setUseLatestPending(true);
  }

  function confirmUseLatestDraft() {
    if (state.kind !== "ready" || !conflict?.latest || commandBusy) {
      setUseLatestPending(false);
      return;
    }
    if (upload?.status === "uploading") {
      setUseLatestPending(false);
      return;
    }
    const latest = conflict.latest;
    setUseLatestPending(false);
    applyLatestDraft(latest);
  }

  function computeDesignMerge(): {
    mergedHomeStyle: HomeStyle;
    mergedPageFields: PageFields;
    mergedKeyvisual: HomeImage | null;
    mergedHomeMenus: HomeMenus;
    kept: string[];
    conflicted: string[];
  } | null {
    if (state.kind !== "ready" || !conflict?.latest) return null;
    const latest = conflict.latest;
    // Ordinary 409s use a three-way merge against the saved baseline both sides forked
    // from: only leaves this editor actually changed are carried over; every
    // other leaf adopts the latest draft. A leaf both sides changed is a
    // real conflict — disclosed by name and resolved here with the local
    // value, because that is what "내 변경 유지" was asked to do. After a
    // successful but superseded write, the common ancestor is no longer
    // known: use every difference from the latest draft and explicitly show
    // both values before applying the current screen to the editor.
    const afterWrite = conflict.afterWrite === true;
    const mergedHomeStyle = { ...latest.form.homeStyle };
    const mergedPageFields = { ...latest.pageFields };
    let mergedKeyvisual = latest.form.keyvisual;
    let mergedHomeMenus = latest.form.homeMenus;
    const kept: string[] = [];
    const conflicted: string[] = [];
    for (const [key, label] of HOME_STYLE_LABELS) {
      const mine = state.form.homeStyle[key] !== (afterWrite ? latest.form.homeStyle[key] : state.savedForm.homeStyle[key]);
      const theirs = latest.form.homeStyle[key] !== state.savedForm.homeStyle[key];
      if (!mine) continue;
      kept.push(label);
      if (!afterWrite && theirs) conflicted.push(label);
      Object.assign(mergedHomeStyle, { [key]: state.form.homeStyle[key] });
    }
    for (const [key, label] of PAGE_FIELD_LABELS) {
      const mine = state.pageFields[key] !== (afterWrite ? latest.pageFields[key] : state.savedPageFields[key]);
      const theirs = latest.pageFields[key] !== state.savedPageFields[key];
      if (!mine) continue;
      kept.push(label);
      if (!afterWrite && theirs) conflicted.push(label);
      Object.assign(mergedPageFields, { [key]: state.pageFields[key] });
    }
    if (!sameHomeImage(state.form.keyvisual, afterWrite ? latest.form.keyvisual : state.savedForm.keyvisual)) {
      kept.push("배너 이미지");
      if (!afterWrite && !sameHomeImage(latest.form.keyvisual, state.savedForm.keyvisual)) conflicted.push("배너 이미지");
      mergedKeyvisual = state.form.keyvisual;
    }
    if (JSON.stringify(state.form.homeMenus) !== JSON.stringify(afterWrite ? latest.form.homeMenus : state.savedForm.homeMenus)) {
      kept.push("홈 메뉴");
      if (!afterWrite && JSON.stringify(latest.form.homeMenus) !== JSON.stringify(state.savedForm.homeMenus)) conflicted.push("홈 메뉴");
      mergedHomeMenus = state.form.homeMenus;
    }
    return { mergedHomeStyle, mergedPageFields, mergedKeyvisual, mergedHomeMenus, kept, conflicted };
  }

  function requestKeepMyDesign() {
    const merge = computeDesignMerge();
    if (!merge) return;
    setMergePending({ kept: merge.kept, conflicted: merge.conflicted });
  }

  function confirmKeepMyDesign() {
    const merge = computeDesignMerge();
    if (!merge || state.kind !== "ready" || !conflict?.latest || commandBusy) {
      setMergePending(null);
      return;
    }
    const latest = conflict.latest;
    const afterWrite = conflict.afterWrite === true;
    const localForm: DesignForm = { ...latest.form, homeStyle: merge.mergedHomeStyle, keyvisual: merge.mergedKeyvisual, homeMenus: merge.mergedHomeMenus };
    setState({
      ...latest,
      kind: "ready",
      savedForm: latest.form,
      savedPageFields: { ...latest.pageFields },
      form: localForm,
      pageFields: { ...merge.mergedPageFields },
    });
    setConflict(null);
    setFailure(null);
    setMergePending(null);
    setNotice(
      afterWrite
        ? "현재 화면 내용을 최신 초안에 적용했습니다. 변경 항목을 확인한 뒤 초안을 저장하세요. 아직 게시되지 않았습니다."
        : merge.conflicted.length
        ? `최신 초안의 다른 설정은 보존하고, 내 변경 ${merge.kept.length}개를 저장 대상으로 준비했습니다. 둘 다 바꾼 항목(내 값 유지): ${merge.conflicted.join(", ")}. 변경 항목을 확인한 뒤 초안을 저장하세요.`
        : "최신 초안의 다른 설정은 보존하고, 내 변경을 저장 대상으로 준비했습니다. 변경 항목을 확인한 뒤 초안을 저장하세요."
    );
  }

  async function saveDraft() {
    if (state.kind !== "ready" || commandBusy || conflict || state.archived || upload?.status === "uploading" || upload?.status === "failed") return;
    if (!formIsDirty(state.form, state.savedForm) && !pageFieldsAreDirty(state)) return;
    if (!state.pageFields.intro.trim()) {
      setFailure({ message: "행사 소개가 비어 있어 초안을 저장할 수 없습니다. 아래 소개 입력란을 확인하세요.", field: "intro" });
      return;
    }
    if (state.form.keyvisual && !state.form.keyvisual.fileId && !sameHomeImage(state.form.keyvisual, state.savedForm.keyvisual)) {
      setFailure({ message: "이 기존 배너 이미지는 업로드 파일 ID가 없어 다시 연결할 수 없습니다. 사용할 이미지를 다시 올려주세요.", field: "keyvisual" });
      return;
    }
    const payload: Record<string, unknown> = {
      ...state.pageFields,
      homeStyle: {
        ...state.form.homeStyle,
        heroTitle: state.form.homeStyle.heroTitle?.trim() ? state.form.homeStyle.heroTitle : null,
      },
      expectedDraftVersion: state.draftVersion,
    };
    const menusChanged = JSON.stringify(state.form.homeMenus) !== JSON.stringify(state.savedForm.homeMenus);
    if (menusChanged) payload.homeMenus = state.form.homeMenus;
    if (!sameHomeImage(state.form.keyvisual, state.savedForm.keyvisual)) {
      if (state.form.keyvisual?.fileId) payload.keyvisual = { fileId: state.form.keyvisual.fileId };
      else if (!state.form.keyvisual) payload.clearKeyvisual = true;
    }
    // Bind this exact payload to one command id. An unchanged retry after an
    // ambiguous failure replays the same receipt; any further edit mints a
    // fresh id so the server can never replay a stale response over it.
    const fingerprint = stableStringify(payload);
    const pending = pendingSaveRef.current;
    const earlierSaveUnconfirmed = Boolean(pending?.uncertain && pending.fingerprint !== fingerprint);
    const commandId = pending && pending.fingerprint === fingerprint ? pending.commandId : randomCommandId();
    const attempt = pending && pending.fingerprint === fingerprint ? pending : { commandId, fingerprint, uncertain: false };
    pendingSaveRef.current = attempt;
    // Capture exactly what is being sent. The success path advances only the
    // saved baselines and never overwrites newer local values with this
    // earlier response.
    const submittedForm = state.form;
    const submittedPageFields = state.pageFields;
    const submittedUpload = upload;
    failureFocusOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    setCommandBusy("save");
    setFailure(null);
    setNotice(null);
    let confirmedReceipt = false;
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command: "attendee.page.save", payload }),
      });
      const body = record(await response.json().catch(() => null));
      if (activeThemeEventRef.current !== eventId) return;
      if (!response.ok) {
        if (earlierSaveUnconfirmed && (response.status === 401 || response.status === 403)) {
          pendingSaveRef.current = null;
          setFailure({ message: "새 저장 요청이 권한 문제로 거부됐습니다. 앞선 저장은 처리됐을 수 있으니 서버 처리 확인을 이용하세요. 편집 내용은 유지했습니다." });
          return;
        }
        if (attempt.uncertain || isUncertainStatus(response.status)) {
          attempt.uncertain = true;
          setFailure({ message: "저장 응답을 확인하지 못했습니다. 이미 반영됐을 수 있습니다. 같은 요청으로 다시 시도하세요." });
          return;
        }
        const message = text(body?.error) || "초안을 저장하지 못했습니다.";
        setFailure({ message, field: text(body?.field) || undefined });
        if (response.status === 409 && (body?.field === "expectedDraftVersion" || /최신 초안/.test(message))) {
          setConflict({ latest: null, loading: false, error: null });
        }
        pendingSaveRef.current = null;
        if (response.status === 401) router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
        if (response.status === 403) setState({ kind: "denied", message: "이 행사의 참가자 화면을 관리할 권한이 없습니다." });
        return;
      }
      const saved = record(body?.draft);
      if (!body || !saved || !confirmsAttendeePageCommand("attendee.page.save", payload, body) ||
          (menusChanged && (!record(saved.homeMenus) || JSON.stringify(normalizeHomeMenus(saved.homeMenus)) !== JSON.stringify(submittedForm.homeMenus)))) {
        attempt.uncertain = true;
        setFailure({ message: "저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      const savedForm: DesignForm = {
        homeStyle: normalizeHomeStyle(saved.homeStyle),
        keyvisual: normalizeHomeImage(saved.keyvisual),
        homeMenus: normalizeHomeMenus(saved.homeMenus),
      };
      const savedPageFields: PageFields = {
        intro: text(saved.intro) || submittedPageFields.intro,
        accent: validAccent(saved.accent),
        showAnnouncements: saved.showAnnouncements !== false,
        showSchedule: saved.showSchedule !== false,
        showVenue: saved.showVenue !== false,
        showPrograms: saved.showPrograms !== false,
      };
      const savedDraftVersion = version(body.draftVersion);
      // The receipt proves this request completed, not that its result is
      // still the newest draft. Keep the same retry intent until a fresh,
      // complete read has established the current state.
      confirmedReceipt = true;
      attempt.uncertain = true;
      const latest = await loadSnapshot(eventId, true);
      if (activeThemeEventRef.current !== eventId) return;
      if ("denied" in latest) throw new Error(latest.denied);
      const superseded = latest.draftVersion !== savedDraftVersion ||
        formIsDirty(latest.form, savedForm) || JSON.stringify(latest.pageFields) !== JSON.stringify(savedPageFields);
      pendingSaveRef.current = null;
      failureFocusOriginRef.current = null;
      setState((current) => {
        if (current.kind !== "ready") return current;
        // Adopt the server-normalized values only where the local editor
        // still holds exactly what was submitted. Newer local edits stay
        // untouched and remain dirty against the advanced baselines.
        const formSettled = !formIsDirty(current.form, submittedForm);
        const fieldsSettled = JSON.stringify(current.pageFields) === JSON.stringify(submittedPageFields);
        return {
          ...current,
          ...(!superseded ? latest : {
            publishedAt: latest.publishedAt,
            publishedVersion: latest.publishedVersion,
            publishedDesign: latest.publishedDesign,
            publishedPageFields: latest.publishedPageFields,
          }),
          kind: "ready",
          form: formSettled ? savedForm : current.form,
          savedForm,
          pageFields: fieldsSettled ? savedPageFields : current.pageFields,
          savedPageFields,
          draftVersion: savedDraftVersion,
        };
      });
      // Clear the upload context only if it is still the one this save saw;
      // a newer selection made after the flight started keeps its intent.
      setUpload((current) => {
        if (current !== submittedUpload) return current;
        if (uploadUrlRef.current) URL.revokeObjectURL(uploadUrlRef.current);
        uploadUrlRef.current = null;
        return null;
      });
      if (superseded) {
        setConflict({ latest, loading: false, error: null, afterWrite: true });
        setFailure({ message: "저장 요청이 처리된 뒤 최신 초안이 변경되었습니다. 아래에서 최신 내용을 확인하세요." });
      } else {
        setConflict(null);
        setNotice("초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.");
      }
    } catch (error) {
      if (activeThemeEventRef.current !== eventId) return;
      if (!attempt.uncertain && isOrganizationContextBlock(error)) {
        pendingSaveRef.current = null;
        setFailure({ message: "현재 조직을 확인한 뒤 초안을 다시 저장하세요." });
      } else {
        attempt.uncertain = true;
        setFailure({ message: confirmedReceipt
          ? "저장 요청은 처리됐지만 최신 상태를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요."
          : "저장 응답을 확인하지 못했습니다. 이미 반영됐을 수 있습니다. 같은 요청으로 다시 시도하세요." });
      }
    } finally {
      if (activeThemeEventRef.current === eventId) setCommandBusy(null);
    }
  }

  function requestPublishDraft() {
    if (state.kind !== "ready" || commandBusy || conflict || state.archived || formIsDirty(state.form, state.savedForm) || pageFieldsAreDirty(state) || upload) return;
    if (state.publishedAt && state.publishedVersion === state.draftVersion) return;
    if (!isKnownEventStage(state.eventStage) || !state.slug) {
      setFailure({ message: "행사 공개 상태를 확인하지 못했습니다. 최신 행사 정보를 확인한 뒤 다시 게시하세요." });
      return;
    }
    setPublishPending(true);
  }

  async function confirmPublishDraft() {
    if (state.kind !== "ready" || commandBusy || conflict || state.archived || formIsDirty(state.form, state.savedForm) || pageFieldsAreDirty(state) || upload) {
      setPublishPending(false);
      return;
    }
    if (state.publishedAt && state.publishedVersion === state.draftVersion) {
      setPublishPending(false);
      return;
    }
    if (!isKnownEventStage(state.eventStage) || !state.slug) {
      setPublishPending(false);
      setFailure({ message: "행사 공개 상태를 확인하지 못했습니다. 최신 행사 정보를 확인한 뒤 다시 게시하세요." });
      return;
    }
    setPublishPending(false);
    const payload = { expectedDraftVersion: state.draftVersion, expectedDestinations: { slug: state.slug, public: isPublicEventStage(state.eventStage) } };
    const fingerprint = stableStringify(payload);
    const pending = pendingPublishRef.current;
    const commandId = pending && pending.fingerprint === fingerprint ? pending.commandId : randomCommandId();
    const attempt = pending && pending.fingerprint === fingerprint ? pending : { commandId, fingerprint, uncertain: false };
    pendingPublishRef.current = attempt;
    failureFocusOriginRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
    setCommandBusy("publish");
    setFailure(null);
    setNotice(null);
    let confirmedReceipt = false;
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId,
          command: "attendee.page.publish-reviewed",
          payload,
        }),
      });
      const body = record(await response.json().catch(() => null));
      if (activeThemeEventRef.current !== eventId) return;
      if (!response.ok) {
        const reviewedConflict = response.status === 409 && (body?.code === "PAGE_PUBLICATION_CONTEXT_CHANGED" || body?.field === "expectedDraftVersion");
        if ((attempt.uncertain && !reviewedConflict) || isUncertainStatus(response.status)) {
          attempt.uncertain = true;
          setFailure({ message: "게시 응답을 확인하지 못했습니다. 이미 게시됐을 수 있습니다. 같은 요청으로 다시 시도하세요." });
          return;
        }
        const message = body?.field === "command"
          ? "현재 서버가 이 게시 검토를 지원하지 않습니다. 관리자에게 업데이트를 요청하세요."
          : text(body?.error) || "게시하지 못했습니다.";
        setFailure({ message, field: text(body?.field) || undefined });
        if (reviewedConflict) {
          acknowledgeOperatorReceipt(commandId);
          forgetOperatorReceipt(commandId);
          setConflict({ latest: null, loading: false, error: null, contextChanged: body?.code === "PAGE_PUBLICATION_CONTEXT_CHANGED" });
        }
        pendingPublishRef.current = null;
        if (response.status === 401) router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
        if (response.status === 403) setState({ kind: "denied", message: "이 행사의 참가자 화면을 관리할 권한이 없습니다." });
        return;
      }
      const published = record(body?.published);
      if (!body || !published || !confirmsAttendeePageCommand("attendee.page.publish-reviewed", payload, body) ||
          !record(published.homeStyle) || !record(published.homeMenus) || !Object.hasOwn(published, "keyvisual") ||
          typeof published.intro !== "string" || typeof published.accent !== "string" || !/^#[0-9a-f]{6}$/i.test(published.accent) ||
          !["showAnnouncements", "showSchedule", "showVenue", "showPrograms"].every((key) => typeof published[key] === "boolean")) {
        attempt.uncertain = true;
        setFailure({ message: "게시 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      const publishedDesign: DesignForm = {
        homeStyle: normalizeHomeStyle(published.homeStyle),
        keyvisual: normalizeHomeImage(published.keyvisual),
        homeMenus: normalizeHomeMenus(published.homeMenus),
      };
      const publishedPageFields: PageFields = {
        intro: text(published.intro),
        accent: validAccent(published.accent),
        showAnnouncements: published.showAnnouncements !== false,
        showSchedule: published.showSchedule !== false,
        showVenue: published.showVenue !== false,
        showPrograms: published.showPrograms !== false,
      };
      if (JSON.stringify(publishedDesign.homeStyle) !== JSON.stringify(state.savedForm.homeStyle) ||
          !sameHomeImage(publishedDesign.keyvisual, state.savedForm.keyvisual) ||
          JSON.stringify(publishedDesign.homeMenus) !== JSON.stringify(state.savedForm.homeMenus) ||
          JSON.stringify(publishedPageFields) !== JSON.stringify(state.savedPageFields)) {
        attempt.uncertain = true;
        setFailure({ message: "게시 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      const publishedVersion = version(body.publishedVersion);
      confirmedReceipt = true;
      attempt.uncertain = true;
      const latest = await loadSnapshot(eventId, true);
      if (activeThemeEventRef.current !== eventId) return;
      if ("denied" in latest || !latest.publishedAt) throw new Error("현재 게시 상태를 확인하지 못했습니다.");
      const contextChanged = latest.slug !== payload.expectedDestinations.slug || isPublicEventStage(latest.eventStage) !== payload.expectedDestinations.public;
      const superseded = latest.draftVersion !== state.draftVersion || latest.publishedVersion !== publishedVersion || contextChanged ||
        formIsDirty(latest.form, state.savedForm) || JSON.stringify(latest.pageFields) !== JSON.stringify(state.savedPageFields) ||
        formIsDirty(latest.publishedDesign, publishedDesign) || JSON.stringify(latest.publishedPageFields) !== JSON.stringify(publishedPageFields);
      pendingPublishRef.current = null;
      failureFocusOriginRef.current = null;
      acknowledgeOperatorReceipt(commandId);
      forgetOperatorReceipt(commandId);
      if (superseded) {
        setState((current) => current.kind === "ready" ? {
          ...current,
          publishedAt: latest.publishedAt,
          publishedVersion: latest.publishedVersion,
          publishedDesign: latest.publishedDesign,
          publishedPageFields: latest.publishedPageFields,
        } : current);
        setConflict({ latest, loading: false, error: null, afterWrite: true, contextChanged });
        setFailure({ message: contextChanged
          ? "게시 요청이 처리된 뒤 행사 공개 상태 또는 주소가 변경되었습니다. 아래에서 현재 상태를 확인하세요."
          : "게시 요청이 처리된 뒤 페이지 상태가 변경되었습니다. 아래에서 현재 상태를 확인하세요." });
        return;
      }
      setState((current) => current.kind === "ready" ? {
        ...current,
        ...latest,
        kind: "ready",
        form: current.form,
        savedForm: current.savedForm,
        pageFields: current.pageFields,
        savedPageFields: current.savedPageFields,
      } : current);
      setNotice(isPublicEventStage(latest.eventStage)
        ? "게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다."
        : latest.eventStage === "DRAFT"
          ? "참가자 페이지 설정을 게시했습니다. 행사가 기획 단계라 참가자에게 공개되지 않습니다. 운영 준비로 전환한 뒤 공개됩니다."
          : "참가자 페이지 설정을 게시했습니다. 행사의 공개 상태를 확인하세요.");
    } catch (error) {
      if (activeThemeEventRef.current !== eventId) return;
      if (!attempt.uncertain && isOrganizationContextBlock(error)) {
        pendingPublishRef.current = null;
        setFailure({ message: "현재 조직을 확인한 뒤 게시를 다시 시도하세요." });
      } else {
        attempt.uncertain = true;
        setFailure({ message: confirmedReceipt
          ? "게시 요청은 처리됐지만 현재 게시 상태를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요."
          : "게시 응답을 확인하지 못했습니다. 이미 게시됐을 수 있습니다. 같은 요청으로 다시 시도하세요." });
      }
    } finally {
      if (activeThemeEventRef.current === eventId) setCommandBusy(null);
    }
  }

  if (state.kind === "loading" || (state.kind === "ready" && loadedThemeEventRef.current !== eventId)) {
    return (
      <ConsolePage pageId="attendeePage" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="참가자 페이지 설정을 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="attendeePage" eventId={eventId}>
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }
  if (state.kind === "denied") {
    return (
      <ConsolePage pageId="attendeePage" eventId={eventId} feedback={<ConsoleFeedback kind="error">{state.message}</ConsoleFeedback>}>
        {null}
      </ConsolePage>
    );
  }

  const dirty = formIsDirty(state.form, state.savedForm) || pageFieldsAreDirty(state);
  const uploadBlocked = upload?.status === "uploading" || upload?.status === "failed";
  const alreadyPublished = Boolean(state.publishedAt) && state.publishedVersion === state.draftVersion;
  const statusNeedsReview = Boolean(conflict || pendingSaveRef.current?.uncertain || pendingPublishRef.current?.uncertain);
  const publicAvailable = isPublicEventStage(state.eventStage) && Boolean(state.slug);
  const stageUnknown = !isKnownEventStage(state.eventStage) || !state.slug;
  const publishedStateLabel = publicAvailable ? "현재 초안 게시됨"
    : state.eventStage === "DRAFT" ? "페이지 게시됨 · 행사 비공개"
      : state.eventStage === "ARCHIVED" ? "페이지 게시됨 · 행사 보관" : "페이지 게시됨 · 공개 상태 확인 필요";
  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 저장·게시 affordance를
  // 잠그고 읽기·미리보기만 둡니다.
  const canSave = dirty && !uploadBlocked && !commandBusy && !conflict && !state.archived;
  const canPublish = !dirty && !upload && !commandBusy && !conflict && !alreadyPublished && !state.archived && !stageUnknown;
  const pendingLocalImage = upload?.objectUrl ?? null;
  const imageUrl = pendingLocalImage || (state.form.keyvisual?.fileId
    ? `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(state.form.keyvisual.fileId)}`
    : state.form.keyvisual?.data || null);
  const publishedImageUrl = state.publishedDesign.keyvisual?.fileId
    ? `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(state.publishedDesign.keyvisual.fileId)}`
    : state.publishedDesign.keyvisual?.data || null;
  const previewStyle = {
    "--home-viewport-height": `${previewSize.height}px`,
    "--home-background-color": state.form.homeStyle.backgroundColor,
    ...(state.form.homeStyle.backgroundColor === DEFAULT_HOME_STYLE.backgroundColor
      ? {}
      : {
          "--home-background-ink": homeBackgroundInk(state.form.homeStyle.backgroundColor),
          "--home-background-copy": homeBackgroundInk(state.form.homeStyle.backgroundColor),
        }),
  } as CSSProperties;
  const publishedPreviewStyle = {
    "--home-viewport-height": `${previewSize.height}px`,
    "--home-background-color": state.publishedDesign.homeStyle.backgroundColor,
    ...(state.publishedDesign.homeStyle.backgroundColor === DEFAULT_HOME_STYLE.backgroundColor
      ? {}
      : {
          "--home-background-ink": homeBackgroundInk(state.publishedDesign.homeStyle.backgroundColor),
          "--home-background-copy": homeBackgroundInk(state.publishedDesign.homeStyle.backgroundColor),
        }),
  } as CSSProperties;
  const showingPublished = previewSource === "published";
  const hasPublished = Boolean(state.publishedAt);
  // Per-group unsaved markers derive from the same saved baselines the
  // save guard compares: no new data, only a group-level reading of the
  // existing dirty state so a long form shows where the changes sit.
  // The preview reflects the home style, menu settings and announcement
  // visibility. The public event page's other fields remain separate.
  const designDirty = formIsDirty(state.form, state.savedForm);
  const backgroundDirty = state.form.homeStyle.backgroundColor !== state.savedForm.homeStyle.backgroundColor;
  const imageDirty = !sameHomeImage(state.form.keyvisual, state.savedForm.keyvisual) || upload !== null;
  const exposureDirty = JSON.stringify(state.pageFields) !== JSON.stringify(state.savedPageFields);
  const copyDirty = (Object.keys(state.form.homeStyle) as (keyof HomeStyle)[]).some(
    (key) => key !== "backgroundColor" && state.form.homeStyle[key] !== state.savedForm.homeStyle[key]
  );
  const publishedVisibility = [
    state.publishedPageFields.showAnnouncements ? null : "공지 숨김",
    state.publishedPageFields.showSchedule ? null : "행사 일시 숨김",
    state.publishedPageFields.showVenue ? null : "장소 숨김",
    state.publishedPageFields.showPrograms ? null : "프로그램 일정 숨김",
  ].filter((item): item is string => item !== null);
  const hiddenEventSections = [
    !state.savedPageFields.showSchedule ? "행사 일시" : null,
    !state.savedPageFields.showAnnouncements ? "공지" : null,
    !state.savedPageFields.showPrograms ? "프로그램 일정" : null,
    !state.savedPageFields.showVenue ? "장소" : null,
  ].filter((item): item is string => item !== null);
  const hiddenHomeMenus = [...new Set([
    ...state.savedForm.homeMenus.hidden,
    ...(!state.savedPageFields.showAnnouncements ? ["notice" as const] : []),
  ])];
  const publishedChanges = [
    ...describeChangedDesign(state.publishedDesign, state.savedForm),
    ...describeChangedPageFields(state.publishedPageFields, state.savedPageFields),
  ];
  const reviewRows = dirty
    ? comparisonRows(state.savedForm, state.savedPageFields, state.form, state.pageFields, state.programOptions)
    : state.publishedAt ? comparisonRows(state.publishedDesign, state.publishedPageFields, state.savedForm, state.savedPageFields, state.programOptions) : [];
  const latestChanges = conflict?.latest ? [
    ...describeChangedDesign(state.savedForm, conflict.latest.form),
    ...describeChangedPageFields(state.savedPageFields, conflict.latest.pageFields),
  ] : [];
  const currentScreenChanges = conflict?.afterWrite && conflict.latest
    ? comparisonRows(conflict.latest.form, conflict.latest.pageFields, state.form, state.pageFields, conflict.latest.programOptions)
    : [];
  const canEditImage = !commandBusy && !state.archived && upload?.status !== "uploading" && upload?.status !== "failed";

  function switchMobileView(view: "edit" | "preview", returnTarget?: HTMLElement | null) {
    if (view === "preview" && returnTarget) lastEditTarget.current = returnTarget;
    const fragment = view === "preview" ? "#home-preview-heading" : "#theme-edit";
    if (window.location.hash !== fragment) window.history.pushState(null, "", fragment);
    setMobileView(view);
    setActiveSection(view === "preview" ? "home-preview-heading" : "theme-edit");
    requestAnimationFrame(() => {
      const target = view === "preview" ? document.getElementById("home-preview-heading") : (lastEditTarget.current || document.getElementById("theme-edit"));
      if (target instanceof HTMLElement) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start", behavior: "instant" }); }
    });
  }

  function jumpToSaveActions(event: ReactMouseEvent<HTMLAnchorElement>) {
    event.preventDefault();
    const save = document.getElementById("theme-save-draft");
    const target = save instanceof HTMLButtonElement && !save.disabled ? save : saveActionsRef.current;
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: "center", behavior: "instant" });
  }

  function changeHomeStyle<K extends keyof HomeStyle>(field: K, value: HomeStyle[K]) {
    updateForm((form) => ({ ...form, homeStyle: { ...form.homeStyle, [field]: value } }));
  }

  function moveHomeMenu(key: ConfigurableHomeMenu, direction: -1 | 1) {
    updateForm((form) => {
      const group = MENU_GROUPS.find((item) => item.keys.includes(key));
      if (!group) return form;
      const order = [...form.homeMenus.order];
      const indexes = order.flatMap((value, index) => group.keys.includes(value) ? [index] : []);
      const position = indexes.findIndex((index) => order[index] === key);
      const other = indexes[position + direction];
      if (position < 0 || other === undefined) return form;
      [order[indexes[position]], order[other]] = [order[other], order[indexes[position]]];
      return { ...form, homeMenus: { ...form.homeMenus, order } };
    });
  }

  function moveHomeProgram(id: string, direction: -1 | 1) {
    updateForm((form) => {
      const programs = [...form.homeMenus.programs];
      const position = programs.indexOf(id), other = position + direction;
      if (position < 0 || other < 0 || other >= programs.length) return form;
      [programs[position], programs[other]] = [programs[other], programs[position]];
      return { ...form, homeMenus: { ...form.homeMenus, programs } };
    });
  }

  const optionsById = new Map(state.programOptions.map((program) => [program.id, program]));
  const programOptions = [
    ...state.form.homeMenus.programs.map((id) => optionsById.get(id) ?? { id, title: "삭제된 프로그램", available: false }),
    ...state.programOptions.filter((program) => !state.form.homeMenus.programs.includes(program.id)),
  ];

  return (
    <ConsolePage
      pageId="attendeePage"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      feedback={
        <>
          {failure ? <div id="theme-error" tabIndex={-1}><ConsoleFeedback kind="error">{failure.message}</ConsoleFeedback></div> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 디자인과 소개를 볼 수 있지만 저장·게시는 할 수 없습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
      badges={
        state.publishedAt ? <span>최근 게시 {formatPublishedAt(state.publishedAt)}</span> : null
      }
      sectionNav={
        <div className={styles.navSticky}>
          <p className={styles.navIndexLabel} aria-hidden="true">참가자 페이지 목차 · 해당 위치로 이동</p>
          <ConsoleSectionNav
            label="참가자 페이지 구역"
            activeId={activeSection}
            onNavigate={(id) => {
              const origin = document.activeElement;
              setMobileView(id === "home-preview-heading" ? "preview" : "edit");
              setActiveSection(id);
              requestAnimationFrame(() => {
                const target = document.getElementById(id);
                // The shared nav may already have focused a visible target.
                // Do not steal focus if the operator has since moved on.
                if (document.activeElement !== origin && document.activeElement !== target) return;
                if (target) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: "start", behavior: "instant" }); }
              });
            }}
            items={[
              { id: "theme-edit", label: "편집" },
              { id: "theme-save", label: "저장·게시" },
              { id: "home-preview-heading", label: "미리보기" },
            ]}
          />
        </div>
      }
    >
      {conflict ? (
        <section className={styles.conflictPanel} aria-labelledby="page-conflict-title">
          <div>
            <h2 id="page-conflict-title">{conflict.afterWrite ? conflict.contextChanged ? "게시 후 행사 공개 상태 또는 주소가 달라졌습니다" : "요청 후 페이지가 변경되었습니다" : conflict.contextChanged ? "행사 공개 상태 또는 주소가 달라졌습니다" : "최신 초안이 달라졌습니다"}</h2>
            <p>{conflict.afterWrite ? conflict.contextChanged ? "게시 요청은 처리됐지만 이후 행사 공개 상태 또는 주소가 변경됐습니다. 최신 상태를 확인하세요." : "요청은 처리됐지만 그 후 다른 변경이 반영됐습니다. 현재 편집 내용을 보존했으니 최신 상태를 확인하세요." : conflict.contextChanged ? "게시하지 않았습니다. 최신 행사 상태를 불러와 반영 위치를 다시 확인하세요." : "다른 운영자가 먼저 저장했습니다. 현재 편집 내용은 그대로 보존했고, 확인 없이 덮어쓰지 않았습니다."}</p>
            {conflict.latest ? (
              <p className={styles.conflictDetails}>
                최신 초안 v{conflict.latest.draftVersion}
                {latestChanges.length ? ` · 변경 항목: ${latestChanges.join(" · ")}` : " · 초안 내용 변경 없음"}
                {conflict.latest.publishedAt ? ` · 현재 게시본 v${conflict.latest.publishedVersion}` : " · 아직 게시된 페이지 없음"}
                {conflict.contextChanged ? ` · 행사 ${isKnownEventStage(conflict.latest.eventStage) ? eventStageLabel(conflict.latest.eventStage) : "상태 확인 필요"}` : ""}
              </p>
            ) : null}
            {conflict.error ? <p role="alert">{conflict.error}</p> : null}
          </div>
          <div className={styles.conflictActions}>
            {!conflict.latest ? (
              <button className="button button-secondary" type="button" onClick={() => void reloadLatestDraft()} disabled={conflict.loading}>
                {conflict.loading ? "최신 상태 확인 중…" : conflict.contextChanged ? "최신 상태 확인" : "최신 초안 확인"}
              </button>
            ) : (
              <>
                <button className="button button-secondary" type="button" onClick={requestUseLatestDraft}>{conflict.contextChanged ? "최신 상태 불러오기" : "최신 초안 불러오기"}</button>
                {!conflict.afterWrite || currentScreenChanges.length ? (
                  <button className="button button-secondary" type="button" onClick={requestKeepMyDesign}>{conflict.afterWrite ? "현재 화면 내용 적용" : "내 변경을 최신 초안에 적용"}</button>
                ) : null}
              </>
            )}
          </div>
          {useLatestPending && conflict?.latest ? (
            <ConsoleConfirm
              summary={`현재 화면의 내용을 버리고 최신 초안으로 바꿀까요?${upload ? " 업로드된 파일은 최신 초안에 연결되지 않으며 서버에 남을 수 있습니다." : ""}`}
              confirmLabel="최신 초안으로 바꾸기"
              onConfirm={confirmUseLatestDraft}
              onCancel={() => setUseLatestPending(false)}
            />
          ) : null}
          {mergePending ? (
            <ConsoleConfirm
              summary={conflict.afterWrite ? (
                <>
                  최신 초안의 아래 항목을 현재 화면의 값으로 바꿉니다. 확인 후에도 저장·게시는 별도로 해야 합니다.
                  {currentScreenChanges.map((row) => (
                    <span key={row.label}><br /><br /><strong>{row.label}</strong>: {row.before} → {row.after}</span>
                  ))}
                </>
              ) : (
                <>
                  최신 초안을 기준으로 삼고 내 변경을 유지할까요?
                  <br />
                  <br />
                  {mergePending.kept.length ? `유지할 내 변경: ${mergePending.kept.join(", ")}.` : "바꾼 항목이 없어 최신 초안을 그대로 불러옵니다."}
                  {mergePending.conflicted.length ? (
                    <>
                      <br />
                      <br />
                      {`둘 다 바꾼 항목(내 값으로 덮어씁니다): ${mergePending.conflicted.join(", ")}.`}
                    </>
                  ) : null}
                  <br />
                  <br />
                  위 목록에 없는 항목은 최신 값으로 보존됩니다.
                </>
              )}
              confirmLabel={conflict.afterWrite ? "현재 화면 내용 적용하기" : "내 변경 유지하기"}
              onConfirm={confirmKeepMyDesign}
              onCancel={() => setMergePending(null)}
            />
          ) : null}
        </section>
      ) : null}

      <div className={styles.editorLayout} data-mobile-view={mobileView} onFocusCapture={syncSectionFromFocus}>
        <div className={styles.controls} id="theme-edit" tabIndex={-1}>
          <div className={styles.editStatusLine}>
            <span>{statusNeedsReview ? "최신 상태 확인 필요" : uploadBlocked ? (upload?.status === "uploading" ? "이미지 업로드 중" : "이미지 업로드 확인 필요") : dirty ? "저장되지 않은 변경" : alreadyPublished ? publishedStateLabel : "저장된 초안"}</span>
            <a href="#theme-save" data-skip-to="theme-save-draft" onClick={jumpToSaveActions}>저장·게시 검토</a>
          </div>
          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>배경{backgroundDirty ? <span className={styles.groupFlag}>미저장 변경</span> : null}</legend>
            <p className={styles.help}>행사 홈과 상세 안내의 배경에 적용됩니다. 타일과 티켓은 읽기 쉽도록 밝은 카드로 유지됩니다.</p>
            <div className={styles.colorRow}>
              <label className={styles.colorLabel} htmlFor="home-background">배경색</label>
              <input
                id="home-background"
                type="color"
                value={state.form.homeStyle.backgroundColor}
                onChange={(event) => changeHomeStyle("backgroundColor", event.target.value.toUpperCase())}
              />
              <output htmlFor="home-background">{state.form.homeStyle.backgroundColor}</output>
            </div>
          </fieldset>

          <button className={styles.inlinePreview} type="button" onClick={(event) => switchMobileView("preview", event.currentTarget)}>현재 디자인 미리보기</button>
          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>배너 이미지{imageDirty ? <span className={styles.groupFlag}>미저장 변경</span> : null}</legend>
            <p className={styles.help}>PNG, JPEG, WEBP · 최대 600KB. 업로드 후 저장하고 게시해야 참가자에게 적용됩니다.</p>
            <div className={styles.imageStatus}>
              <span className={styles.imageStatusName}>{upload?.status === "uploading" ? upload.file.name : !state.form.keyvisual && state.defaultHomeBanner === "neutral" ? "기본 색상 배너" : homeImageLabel(state.form.keyvisual)}</span>
              <span className={styles.imageStatusMeta}>
                {upload?.status === "uploading" ? "업로드 중" : upload?.status === "failed" ? "업로드 확인 필요" : upload?.status === "uploaded" ? "업로드됨 · 초안 저장 전" : state.form.keyvisual?.size ? `${Math.ceil(state.form.keyvisual.size / 1024)}KB` : ""}
              </span>
            </div>
            {upload?.status === "failed" ? (
              <div className={styles.uploadError} role="alert">
                <p>{upload.error}</p>
                <div className={styles.smallActions}>
                  <button className="button button-secondary" type="button" onClick={() => void uploadFile(upload)}>같은 요청으로 다시 시도</button>
                  <button className="button button-secondary" type="button" onClick={requestCancelUpload}>선택 취소</button>
                </div>
              </div>
            ) : null}
            <div className={styles.imageActions}>
              <label className={`${styles.fileButton} button button-secondary`}>
                배너 이미지 선택
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={selectImage}
                  disabled={!canEditImage || Boolean(conflict)}
                  aria-label="배너 이미지 선택"
                />
              </label>
              <button className="button button-secondary" type="button" onClick={requestClearImage} disabled={!canEditImage || (!state.form.keyvisual && !upload)}>
                {upload?.status === "uploaded" || upload?.status === "failed" ? "선택 취소" : state.form.keyvisual ? "배너 이미지 제거" : state.defaultHomeBanner === "neutral" ? "기본 배너 사용 중" : "기본 이미지 사용 중"}
              </button>
            </div>
            {cancelImagePending ? (
              <ConsoleConfirm
                summary="이 이미지 선택을 취소할까요? 업로드된 파일은 초안에서 연결 해제되며 서버 저장소에서 삭제되지 않을 수 있습니다. 저장된 초안과 게시본은 유지됩니다."
                confirmLabel="선택 취소하기"
                onConfirm={confirmCancelUpload}
                onCancel={() => setCancelImagePending(false)}
              />
            ) : null}
            {clearImagePending ? (
              <ConsoleConfirm
                summary="배너 이미지 연결을 초안에서 해제할까요? 저장 후에도 참가자 화면은 게시하기 전까지 바뀌지 않습니다."
                confirmLabel="연결 해제하기"
                onConfirm={confirmClearImage}
                onCancel={() => setClearImagePending(false)}
              />
            ) : null}
            <details className={styles.advanced}>
              <summary className={styles.advancedSummary}>이미지 상세 설정</summary>
              <div className={styles.advancedBody}>
                <label className={styles.field} htmlFor="home-image-focus">
                  이미지 초점
                  <select id="home-image-focus" value={state.form.homeStyle.imageFocus} onChange={(event) => changeHomeStyle("imageFocus", event.target.value as HomeStyle["imageFocus"])}>
                    <option value="center">가운데</option>
                    <option value="top">위쪽</option>
                    <option value="bottom">아래쪽</option>
                  </select>
                </label>
              </div>
            </details>
          </fieldset>

          <button className={styles.inlinePreview} type="button" onClick={(event) => switchMobileView("preview", event.currentTarget)}>현재 디자인 미리보기</button>
          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>문구와 배치{copyDirty ? <span className={styles.groupFlag}>미저장 변경</span> : null}</legend>
            <p className={styles.help}>행사명은 기본 제목입니다. 보조 문구는 기존 행사 소개와 별개로 배너에 표시됩니다.</p>
            <label className={styles.field} htmlFor="home-hero-title">
              배너 제목 <span>최대 80자</span>
              <input
                id="home-hero-title"
                type="text"
                maxLength={80}
                value={state.form.homeStyle.heroTitle ?? ""}
                placeholder={state.eventName}
                onChange={(event) => changeHomeStyle("heroTitle", event.target.value || null)}
              />
            </label>
            <label className={styles.field} htmlFor="home-hero-subtitle">
              보조 문구 <span>최대 100자</span>
              <input
                id="home-hero-subtitle"
                type="text"
                maxLength={100}
                value={state.form.homeStyle.heroSubtitle}
                placeholder="선택 입력"
                onChange={(event) => changeHomeStyle("heroSubtitle", event.target.value)}
              />
            </label>
            <details className={styles.advanced}>
              <summary className={styles.advancedSummary}>배치·색상 상세 설정</summary>
              <div className={styles.advancedBody}>
                <div className={styles.fieldGrid}>
                  <label className={styles.field} htmlFor="home-layout">
                    배너 배치
                    <select id="home-layout" value={state.form.homeStyle.heroLayout} onChange={(event) => changeHomeStyle("heroLayout", event.target.value as HomeStyle["heroLayout"])}>
                      <option value="centered">가운데 제목</option>
                      <option value="bottom-overlay">아래쪽 제목</option>
                      <option value="image-only">이미지만</option>
                    </select>
                  </label>
                  <label className={styles.field} htmlFor="home-title-scale">
                    제목 크기
                    <select id="home-title-scale" value={state.form.homeStyle.titleScale} onChange={(event) => changeHomeStyle("titleScale", event.target.value as HomeStyle["titleScale"])}>
                      <option value="standard">기본</option>
                      <option value="large">크게</option>
                    </select>
                  </label>
                  <label className={styles.field} htmlFor="home-text-align">
                    문구 정렬
                    <select id="home-text-align" value={state.form.homeStyle.textAlign} onChange={(event) => changeHomeStyle("textAlign", event.target.value as HomeStyle["textAlign"])}>
                      <option value="center">가운데</option>
                      <option value="left">왼쪽</option>
                      <option value="right">오른쪽</option>
                    </select>
                  </label>
                  <label className={styles.field} htmlFor="home-text-tone">
                    문구 색상
                    <select id="home-text-tone" value={state.form.homeStyle.textTone} onChange={(event) => changeHomeStyle("textTone", event.target.value as HomeStyle["textTone"])}>
                      <option value="light">흰색</option>
                      <option value="dark">짙은 색</option>
                    </select>
                  </label>
                  <label className={styles.field} htmlFor="home-overlay">
                    읽기 배경
                    <select id="home-overlay" value={state.form.homeStyle.overlay} onChange={(event) => changeHomeStyle("overlay", event.target.value as HomeStyle["overlay"])}>
                      <option value="none">없음</option>
                      <option value="soft">부드럽게</option>
                      <option value="strong">강하게</option>
                    </select>
                  </label>
                </div>
              </div>
            </details>
          </fieldset>

          <button className={styles.inlinePreview} type="button" onClick={(event) => switchMobileView("preview", event.currentTarget)}>현재 디자인 미리보기</button>
          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>소개와 노출{exposureDirty ? <span className={styles.groupFlag}>미저장 변경</span> : null}</legend>
            <p className={styles.help}>공지 설정은 참가자 홈에도 적용됩니다. 행사 일시·장소를 숨겨도 티켓의 행사일, 프로그램 일정의 일시·장소, 부스 지도와 전광판은 별도로 표시될 수 있습니다.</p>
            <label className={styles.field} htmlFor="home-intro">
              행사 소개 <span>최대 160자</span>
              <input
                id="home-intro"
                type="text"
                maxLength={160}
                value={state.pageFields.intro}
                onChange={(event) => updatePageField("intro", event.target.value)}
                aria-invalid={failure?.field === "intro" || undefined}
              />
            </label>
            <div className={styles.colorRow}>
              <label className={styles.colorLabel} htmlFor="home-accent">강조색</label>
              <input
                id="home-accent"
                type="color"
                value={state.pageFields.accent}
                onChange={(event) => updatePageField("accent", event.target.value.toUpperCase())}
              />
              <output htmlFor="home-accent">{state.pageFields.accent}</output>
            </div>
            <div className={styles.toggleGrid}>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={state.pageFields.showAnnouncements}
                  onChange={(event) => updatePageField("showAnnouncements", event.target.checked)}
                />
                공지 보기
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={state.pageFields.showSchedule}
                  onChange={(event) => updatePageField("showSchedule", event.target.checked)}
                />
                행사 일시 보기
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={state.pageFields.showVenue}
                  onChange={(event) => updatePageField("showVenue", event.target.checked)}
                />
                장소 보기
              </label>
              <label className={styles.check}>
                <input
                  type="checkbox"
                  checked={state.pageFields.showPrograms}
                  onChange={(event) => updatePageField("showPrograms", event.target.checked)}
                />
                프로그램 일정 보기
              </label>
            </div>
          </fieldset>

          <details className={styles.advanced}>
          <summary className={styles.advancedSummary}>홈 메뉴 구성{JSON.stringify(state.form.homeMenus) !== JSON.stringify(state.savedForm.homeMenus) ? <span className={styles.groupFlag}>미저장 변경</span> : null}</summary>
          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>메뉴 표시와 순서</legend>
            <p className={styles.help}>모바일 티켓과 내 신청 정보는 항상 제공됩니다. 꺼진 기능과 미게시 프로그램은 참가자에게 표시되지 않습니다.</p>
            {MENU_GROUPS.map((group) => {
              const ordered = state.form.homeMenus.order.filter((key) => group.keys.includes(key));
              return <div key={group.label} className={styles.menuGroup}>
                <h3>{group.label}</h3>
                <ol className={styles.menuRows}>{ordered.map((key, index) => <li key={key} className={styles.menuRow}>
                  <label className={styles.check}>
                    <input type="checkbox" checked={!state.form.homeMenus.hidden.includes(key)} onChange={(event) => {
                      const checked = event.target.checked;
                      updateForm((form) => ({ ...form, homeMenus: { ...form.homeMenus,
                        hidden: checked ? form.homeMenus.hidden.filter((item) => item !== key) : [...form.homeMenus.hidden, key] } }));
                    }} />
                    {MENU_LABELS[key]}{state.unavailableMenus.includes(key) || (key === "notice" && !state.pageFields.showAnnouncements) ? <span className={styles.menuNote}>공개 조건 꺼짐</span> : null}
                  </label>
                  <span className={styles.menuMove}>
                    <button type="button" className="button button-secondary" aria-label={`${MENU_LABELS[key]} 위로 이동`} disabled={index === 0} onClick={() => moveHomeMenu(key, -1)}>↑</button>
                    <button type="button" className="button button-secondary" aria-label={`${MENU_LABELS[key]} 아래로 이동`} disabled={index === ordered.length - 1} onClick={() => moveHomeMenu(key, 1)}>↓</button>
                  </span>
                </li>)}</ol>
              </div>;
            })}
            <div className={styles.menuGroup}>
              <h3>개별 참여 콘텐츠</h3>
              <p className={styles.help}>선택한 프로그램으로 바로 가는 링크를 홈에 추가합니다.</p>
              {programOptions.length ? <ol className={styles.menuRows}>{programOptions.map((program) => {
                const selected = state.form.homeMenus.programs.includes(program.id);
                const position = state.form.homeMenus.programs.indexOf(program.id);
                return <li key={program.id} className={styles.menuRow}>
                  <label className={styles.check}>
                    <input type="checkbox" checked={selected} disabled={!program.available && !selected} onChange={(event) => {
                      const checked = event.target.checked;
                      updateForm((form) => ({ ...form, homeMenus: { ...form.homeMenus,
                        programs: checked ? [...form.homeMenus.programs, program.id] : form.homeMenus.programs.filter((id) => id !== program.id) } }));
                    }} />
                    {program.title}{!program.available ? <span className={styles.menuNote}>미게시 또는 기능 꺼짐</span> : null}
                  </label>
                  {selected ? <span className={styles.menuMove}>
                    <button type="button" className="button button-secondary" aria-label={`${program.title} 위로 이동`} disabled={position === 0} onClick={() => moveHomeProgram(program.id, -1)}>↑</button>
                    <button type="button" className="button button-secondary" aria-label={`${program.title} 아래로 이동`} disabled={position === state.form.homeMenus.programs.length - 1} onClick={() => moveHomeProgram(program.id, 1)}>↓</button>
                  </span> : null}
                </li>;
              })}</ol> : <p className={styles.help}>게시된 참여 콘텐츠가 없습니다.</p>}
            </div>
          </fieldset>
          </details>

          <div id="theme-save" ref={saveActionsRef} tabIndex={-1} className={`${styles.saveAnchor} ${styles.saveBar}`}>
            <div className={styles.versionSummary} aria-live="polite">
              <span className={styles.statePill} data-state={dirty || statusNeedsReview ? "dirty" : alreadyPublished && publicAvailable ? "published" : "draft"}>
                {statusNeedsReview ? "최신 상태 확인 필요" : dirty ? "저장되지 않은 변경" : alreadyPublished ? publishedStateLabel : "저장된 초안"}
              </span>
              <span>
                {statusNeedsReview ? "편집 중인 초안은 최신 상태와 다를 수 있습니다" : state.publishedAt
                  ? `게시 버전 ${state.publishedVersion} · 초안 ${state.draftVersion}`
                  : `아직 게시하지 않음 · 초안 ${state.draftVersion}`}
              </span>
            </div>
            <p className={styles.workflowHelp}>{statusNeedsReview ? "요청 결과와 최신 페이지 상태를 확인한 뒤 저장하거나 게시하세요." : dirty ? "편집 내용은 아직 저장되지 않았습니다. 초안 저장은 참가자 화면을 바꾸지 않습니다." : alreadyPublished ? publicAvailable ? "저장된 초안이 참가자 화면에 게시되어 있습니다." : state.eventStage === "DRAFT" ? "페이지 설정은 게시됐지만 행사가 기획 단계라 참가자에게 공개되지 않습니다." : "페이지 설정은 게시됐지만 행사 공개 상태를 확인할 수 없습니다." : "저장된 초안은 아직 참가자 화면에 적용되지 않았습니다. 게시 검토를 눌러 확인하세요."}</p>
            {dirty ? <p className={styles.changeSummary}>저장할 변경: {[...describeChangedDesign(state.savedForm, state.form), ...describeChangedPageFields(state.savedPageFields, state.pageFields)].join(" · ") || "선택한 이미지"}</p> : null}
            {reviewRows.length ? (
              <details className={styles.reviewChanges}>
                <summary data-disclosure-indicator="">{dirty ? "저장 전 변경 내용 확인" : "게시할 변경 내용 확인"} ({reviewRows.length})</summary>
                <p>{dirty ? "저장된 초안 → 편집 중" : "게시본 → 저장된 초안"}</p>
                <dl>{reviewRows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd><span>{row.before}</span> → <strong>{row.after}</strong></dd></div>)}</dl>
              </details>
            ) : null}
            {state.publishedAt && publishedChanges.length ? (
              <details className={styles.diffFold}>
                <summary className={styles.advancedSummary}>게시본과 다른 저장된 변경 {publishedChanges.length}개</summary>
                <p className={styles.publishedNote}>게시본과 다른 저장된 변경: {publishedChanges.join(" · ")}</p>
              </details>
            ) : null}
            {dirty && !uploadBlocked ? <p className={styles.inlineHelp}>게시 버튼은 저장된 초안에만 작동합니다. 먼저 초안을 저장하세요.</p> : null}
            {stageUnknown ? <div className={styles.inlineHelp}>
              <p>행사 공개 상태나 주소를 확인하지 못했습니다. 최신 행사 정보를 확인한 뒤 게시하세요.</p>
              <button className="button button-secondary" type="button" disabled={Boolean(commandBusy || conflict)} onClick={() => void reloadLatestDraft(true)}>최신 상태 확인</button>
            </div> : null}
            {uploadBlocked ? (
              <p className={styles.inlineHelp}>
                {upload?.status === "uploading" ? "이미지를 올리는 중입니다. 완료될 때까지 초안 저장이 잠깁니다." : "이미지 업로드 결과를 확인해야 초안을 저장할 수 있습니다. 같은 요청으로 다시 시도하세요."}
              </p>
            ) : null}
            <div className={styles.saveButtons}>
            <ConsoleFormActions>
              <button id="theme-save-draft" className="button button-primary" type="button" onClick={() => void saveDraft()} disabled={!canSave}>
                {commandBusy === "save" ? "초안 저장 중…" : "초안 저장"}
              </button>
              <button className="button button-secondary" type="button" onClick={() => void requestPublishDraft()} disabled={!canPublish}>
                {commandBusy === "publish" ? "게시 중…" : "게시 검토"}
              </button>
            </ConsoleFormActions>
            </div>
            {publishPending ? (
              <PublicationReview
                title="참가자 페이지 게시 검토"
                description={publicAvailable
                  ? `“${state.eventName}”의 저장된 페이지 설정을 게시합니다. 화면 열기는 현재 참가자 화면입니다. 게시할 변경은 아래에서 확인하세요.`
                  : `“${state.eventName}”의 페이지 설정을 게시해도 행사가 기획 단계라 참가자에게 공개되지 않습니다. 행사 설정에서 운영 준비로 전환한 뒤 공개됩니다.`}
                changes={comparisonRows(state.publishedDesign, state.publishedPageFields, state.savedForm, state.savedPageFields, state.programOptions)}
                destinations={[
                  { label: "참가자 홈", detail: `배너·제목·색상·메뉴 구성이 반영됩니다.${hiddenHomeMenus.length ? ` 숨길 메뉴: ${hiddenHomeMenus.map(key => MENU_LABELS[key]).join(" · ")}.` : ""}${!state.savedPageFields.showAnnouncements ? " 전광판 공지는 별도입니다." : ""}`, href: publicAvailable ? `/event/${encodeURIComponent(state.slug)}/home` : undefined },
                  { label: "행사 안내", detail: `행사 소개·강조색과 각 안내의 표시 설정이 반영됩니다.${hiddenEventSections.length ? ` 숨길 안내: ${hiddenEventSections.join(" · ")}.` : ""}${!state.savedPageFields.showSchedule ? " 티켓의 행사일·프로그램 일정·전광판 행사일은 별도입니다." : ""}${!state.savedPageFields.showVenue ? " 프로그램의 장소·부스 지도·전광판 장소는 별도입니다." : ""}`, href: publicAvailable ? `/event/${encodeURIComponent(state.slug)}` : undefined },
                ]}
                busy={commandBusy === "publish"}
                disabled={!canPublish}
                onConfirm={() => void confirmPublishDraft()}
                onClose={() => setPublishPending(false)}
              >
                {!publishedChanges.length ? <p className={styles.help}>{state.publishedAt ? "게시본과 디자인이 같습니다. 저장된 초안의 버전을 게시 상태로 확정합니다." : "현재 기본 참가자 디자인을 처음 게시합니다."}</p> : null}
                <p className={styles.help}>행사 일시는 행사 설정에서, 공지·프로그램 일정·장소 내용은 콘텐츠에서 관리합니다. 실제 표시는 게시된 내용과 행사 기능에 따라 달라질 수 있습니다.</p>
              </PublicationReview>
            ) : null}
          </div>
          <section className={styles.recoveryGroup} aria-labelledby="page-recovery-heading">
            <h2 id="page-recovery-heading">되돌리기</h2>
            <p className={styles.help}>아래 동작은 편집기에만 적용됩니다. 저장과 게시를 따로 해야 참가자 화면이 바뀝니다.</p>
            <div className={styles.smallActions}>
              <button className="button button-secondary" type="button" onClick={requestLoadPublishedDesign} disabled={Boolean(commandBusy || conflict || state.archived || upload?.status === "uploading")}>게시된 디자인 불러오기</button>
              <button className="button button-secondary" type="button" onClick={requestResetDesignDefaults} disabled={Boolean(commandBusy || conflict || state.archived || upload?.status === "uploading")}>기본 디자인으로</button>
              {dirty ? <button className="button button-secondary" type="button" onClick={requestDiscardChanges} disabled={Boolean(commandBusy || state.archived || upload?.status === "uploading")}>저장 전 변경 취소</button> : null}
            </div>
            {loadPublishedPending ? (
              <ConsoleConfirm
                summary={`게시된 디자인으로 현재 편집 내용을 바꿀까요?${upload ? " 선택한 이미지는 초안에서 연결 해제되며, 이미 올라간 파일은 서버에 남을 수 있습니다." : ""} 바뀐 값은 저장 전까지 초안에 반영되지 않습니다.`}
                confirmLabel="게시된 디자인 불러오기"
                onConfirm={confirmLoadPublishedDesign}
                onCancel={() => setLoadPublishedPending(false)}
              />
            ) : null}
            {defaultsPending ? (
              <ConsoleConfirm
                summary={`저장하지 않은 디자인 변경을 버리고 기본 디자인으로 바꿀까요?${upload ? " 선택한 이미지는 초안에서 연결 해제되며, 이미 올라간 파일은 서버에 남을 수 있습니다." : ""} 실제 초안과 게시 화면은 저장·게시 전까지 바뀌지 않습니다.`}
                confirmLabel="기본 디자인으로 바꾸기"
                onConfirm={confirmResetDesignDefaults}
                onCancel={() => setDefaultsPending(false)}
              />
            ) : null}
            {discardPending ? (
              <ConsoleConfirm
                summary={upload
                  ? "저장하지 않은 변경을 취소할까요? 업로드한 파일은 초안에 연결되지 않으며 서버 저장소에서 삭제되지 않습니다. 저장된 초안과 게시본은 유지됩니다."
                  : "저장하지 않은 변경을 취소하고 마지막으로 저장된 초안을 불러올까요? 현재 게시된 화면은 바뀌지 않습니다."}
                confirmLabel="변경 취소하기"
                onConfirm={confirmDiscardChanges}
                onCancel={() => setDiscardPending(false)}
              />
            ) : null}
          </section>


        </div>

        <section className={styles.previewPanel} aria-labelledby="home-preview-heading">
          <div className={styles.previewHeader}>
            <div>
              <h2 id="home-preview-heading" tabIndex={-1}>홈 디자인 미리보기</h2>
              <p>{showingPublished ? (hasPublished ? publicAvailable ? "현재 게시된 홈을 표시합니다." : state.eventStage === "DRAFT" ? "게시된 설정을 미리 봅니다. 행사가 기획 단계라 참가자에게 공개되지 않습니다." : "게시된 설정을 미리 봅니다. 행사 공개 상태를 확인하세요." : "아직 게시된 홈이 없습니다.") : "저장 전 변경을 포함한 편집 중 홈을 표시합니다."} 행사 안내의 소개·강조색·일정·장소·프로그램은 안내 화면에서 확인하세요.</p>
            </div>
            <span className={styles.liveMark}><span aria-hidden="true" />{showingPublished ? "게시본" : "편집 중"}</span>
          </div>
          <button className={styles.backToEdit} type="button" onClick={() => switchMobileView("edit")}>편집하던 곳으로 돌아가기</button>
          <div className={styles.switchBlock}>
            <p className={styles.previewNote}>{publicAvailable ? "현재 기능과 게시된 참여 콘텐츠를 반영합니다. 미리보기 메뉴는 작동하지 않습니다. 실제 참가자 화면에서 이용하세요." : state.eventStage === "DRAFT" ? "현재 기능과 게시된 참여 콘텐츠를 반영합니다. 미리보기 메뉴는 작동하지 않습니다. 행사가 공개되면 참가자 화면에서 이용할 수 있습니다." : "현재 기능과 게시된 참여 콘텐츠를 반영합니다. 미리보기 메뉴는 작동하지 않습니다. 행사 공개 상태를 확인하세요."}</p>
            <p className={styles.switchLabel} id="preview-source-label">미리보기 기준</p>
            <div className={styles.sourceSwitch} role="group" aria-labelledby="preview-source-label">
            <button
              className={styles.viewportChoice}
              type="button"
              aria-pressed={previewSource === "draft"}
              onClick={() => setPreviewSource("draft")}
            >
              편집 중
            </button>
            <button
              className={styles.viewportChoice}
              type="button"
              aria-pressed={previewSource === "published"}
              onClick={() => setPreviewSource("published")}
            >
              게시본
            </button>
          </div>
          </div>
          <div className={styles.switchBlock}>
            <p className={styles.switchLabel} id="preview-ticket-label">참가자 티켓</p>
            <div className={styles.sourceSwitch} role="group" aria-labelledby="preview-ticket-label">
              <button className={styles.viewportChoice} type="button" aria-pressed={previewHasTicket} onClick={() => setPreviewHasTicket(true)}>티켓 있음</button>
              <button className={styles.viewportChoice} type="button" aria-pressed={!previewHasTicket} onClick={() => setPreviewHasTicket(false)}>티켓 없음</button>
            </div>
          </div>
          <div className={styles.switchBlock}>
            <p className={styles.switchLabel} id="preview-viewport-label">미리보기 화면 크기</p>
            <div className={styles.viewportChoices} role="group" aria-labelledby="preview-viewport-label">
            {[
              { width: 320, height: 568, label: "짧은 화면 320×568" },
              { width: 390, height: 700, label: "390×700" },
              { width: 390, height: 844, label: "390×844" },
            ].map((size) => (
              <button
                key={`${size.width}-${size.height}`}
                className={styles.viewportChoice}
                type="button"
                aria-pressed={previewSize.width === size.width && previewSize.height === size.height}
                onClick={() => setPreviewSize({ width: size.width, height: size.height })}
              >
                {size.label}
              </button>
            ))}
            </div>
          </div>
          <div className={styles.phoneStage}>
            <div
              className={styles.phoneViewport}
              role="region"
              aria-label={`${previewSize.width}×${previewSize.height} 홈 디자인 미리보기`}
              tabIndex={0}
              style={{ "--preview-width": `${previewSize.width}px`, "--preview-height": `${previewSize.height}px` } as CSSProperties}
            >
              {showingPublished && !hasPublished ? (
                <p className={styles.previewNote}>아직 게시된 화면이 없습니다</p>
              ) : (
              <div className={`${styles.previewHome} ${attendeeHomeStyles.homePage}`} style={showingPublished ? publishedPreviewStyle : previewStyle}>
                <AttendeeHomeLanding
                  eventName={state.eventName}
                  hasTicket={previewHasTicket}
                  keyvisual={showingPublished ? publishedImageUrl : imageUrl}
                  defaultHomeBanner={state.defaultHomeBanner}
                  homeStyle={showingPublished ? state.publishedDesign.homeStyle : state.form.homeStyle}
                  homeMenus={showingPublished ? state.publishedDesign.homeMenus : state.form.homeMenus}
                  programs={state.availablePrograms}
                  hasPrograms={state.availablePrograms.length > 0}
                  unavailable={[
                    ...state.unavailableMenus,
                    ...(!(showingPublished ? state.publishedPageFields.showAnnouncements : state.pageFields.showAnnouncements) ? ["notice" as const] : []),
                  ]}
                  preview
                  shortViewport={previewSize.height <= 820}
                />
              </div>
              )}
            </div>
          </div>
          {/* Home presentation and menu configuration reflect the selected
              draft or published version; event-page content remains separate. */}
          {!showingPublished && designDirty && !uploadBlocked ? <p className={styles.previewNote}>미저장 변경이 미리보기에 바로 반영됩니다.</p> : null}
          {!showingPublished && upload?.status === "failed" ? <p className={styles.previewNote}>업로드가 확인되지 않았습니다. 미리보기에는 선택한 파일을 표시하고 있어요.</p> : null}
          {!showingPublished && state.form.homeStyle.heroLayout === "image-only" ? <p className={styles.previewNote}>이미지만 배치해도 제목은 스크린리더용으로 유지됩니다.</p> : null}
          {showingPublished && hasPublished ? (
            <p className={styles.previewNote}>
              게시된 소개: {state.publishedPageFields.intro || "소개 없음"} · 강조색 {state.publishedPageFields.accent}
              {publishedVisibility.length ? ` · 표시 설정: ${publishedVisibility.join(" · ")}` : " · 표시 설정 모두 켜짐"}
              {" · 실제 표시는 게시된 내용과 행사 기능에 따라 달라질 수 있습니다."}
            </p>
          ) : null}
          {!showingPublished && state.publishedAt && publishedChanges.length ? <p className={styles.publishedNote}>게시본과 다른 저장된 변경: {publishedChanges.join(" · ")}</p> : null}
        </section>
      </div>
    </ConsolePage>
  );
}
