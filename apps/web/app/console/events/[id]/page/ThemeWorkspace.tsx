"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent, ReactNode } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { eventStageLabel } from "../../../../event-stage";
import {
  DEFAULT_HOME_STYLE,
  bannerFillCss,
  homeImageLabel,
  normalizeHomeImage,
  normalizeHomeStyle,
  parseHomePhotos,
  sameHomeImage,
  type HomeImage,
  type HomeLayout,
  type HomePhoto,
  type HomeStyle,
} from "../../../../../lib/attendee-home";
import { normalizeHomeMenus, type ConfigurableHomeMenu, type HomeMenus, type HomeProgram } from "../../../../../lib/attendee-home-menus";
import AttendeeHomeLanding from "../../../../event/[slug]/home/AttendeeHomeLanding";
import attendeeHomeStyles from "../../../../event/[slug]/home/home.module.css";
import ConsolePage from "../../../console-ui/ConsolePage";
import ProductButton from "../../../../ui/ProductButton";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import PublicationReview from "../../../console-ui/PublicationReview";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import { Switch } from "@astryxdesign/core/Switch";
import ColorField from "./ColorField";
import LayoutPicker from "./LayoutPicker";
import AttendeeGuideQr from "./AttendeeGuideQr";
import { ChoiceCards, Seg } from "./StudioControls";
import studio from "./studio.module.css";
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
  // Approved participant photos, as the photo-first layout will show them.
  previewPhotos: HomePhoto[];
};
type Ready = Snapshot & { kind: "ready"; savedForm: DesignForm; savedPageFields: PageFields };
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
    // Same rule as the public page: only approved photos, and only while the
    // 사진 feature is on. The console reads them through its own authorized route.
    previewPhotos: enabled.has("photo")
      ? parseHomePhotos(workspace.photos, (fileId) => `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(fileId)}`)
      : [],
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

const BACKGROUND_SWATCHES = [
  { color: "#B9DEF0", name: "맑은 하늘" }, { color: "#F3EEE6", name: "크림" }, { color: "#FDE3D5", name: "피치" },
  { color: "#DCEBDD", name: "세이지" }, { color: "#E6E1F5", name: "라벤더" }, { color: "#1E2026", name: "잉크" },
];
const BANNER_SWATCHES = [
  { color: "#1E2026", name: "잉크" }, { color: "#2E3D5B", name: "남색" }, { color: "#C8441F", name: "주황" },
  { color: "#2F6B4F", name: "초록" }, { color: "#6D5BD0", name: "보라" }, { color: "#E58A4B", name: "살구" },
];
const GRADIENT_PRESETS = [
  { name: "노을", from: "#2E3D5B", to: "#E58A4B" }, { name: "바다", from: "#0F4C75", to: "#3BA3C7" },
  { name: "숲", from: "#1F3D2B", to: "#6FA37A" }, { name: "벚꽃", from: "#E8A0BF", to: "#FDE3D5" },
  { name: "밤", from: "#101114", to: "#4A5A8A" }, { name: "라벤더", from: "#6D5BD0", to: "#C7B8FF" },
];

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
  ["layout", "레이아웃"],
  ["menuShape", "메뉴 모양"],
  ["bannerKind", "배너 종류"],
  ["bannerColor", "배너 색"],
  ["bannerColor2", "배너 끝 색"],
  ["bannerAngle", "그라데이션 방향"],
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
  const choices: Record<string, string> = { centered: "가운데 제목", "bottom-overlay": "아래쪽 제목", "image-only": "이미지만", standard: "기본", large: "크게", center: "가운데", left: "왼쪽", right: "오른쪽", top: "위쪽", bottom: "아래쪽", light: "흰색", dark: "짙은 색", none: "없음", soft: "부드럽게", strong: "강하게", tile: "타일형", poster: "포스터형", typography: "타이포형", circle: "원형 아이콘", list: "목록", image: "이미지", gradient: "그라데이션", solid: "단색", diagonal: "대각선", vertical: "위에서 아래", horizontal: "왼쪽에서 오른쪽" };
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
  // Which sub-panel replaces the settings list (null = the list), and the
  // full-view phone on narrow screens.
  const [panel, setPanel] = useState<null | "banner" | "text" | "menus" | "exposure">(null);
  const [stageOpen, setStageOpen] = useState(false);
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

  const editsLocked = Boolean(commandBusy || conflict || state.archived);
  const homeStyle = state.form.homeStyle;
  const bannerDirty = (["bannerKind", "bannerColor", "bannerColor2", "bannerAngle", "heroLayout", "imageFocus", "overlay"] as const).some((key) => homeStyle[key] !== state.savedForm.homeStyle[key]);
  const menusDirty = JSON.stringify(state.form.homeMenus) !== JSON.stringify(state.savedForm.homeMenus);
  const bannerSummary = homeStyle.bannerKind === "gradient" ? "그라데이션" : homeStyle.bannerKind === "solid" ? `단색 ${homeStyle.bannerColor}`
    : upload?.status === "uploading" ? upload.file.name : !state.form.keyvisual && state.defaultHomeBanner === "neutral" ? "기본 색상 배너" : homeImageLabel(state.form.keyvisual);
  const bannerFill = bannerFillCss(homeStyle);
  const bannerSwatch = (
    <span className={studio.swatchArt} style={bannerFill ? { background: bannerFill } : imageUrl ? { backgroundImage: `url(${imageUrl})` } : undefined} aria-hidden="true" />
  );
  const menuShown = state.form.homeMenus.order.filter((key) => !state.form.homeMenus.hidden.includes(key)).length;
  const menuSummary = `${state.form.homeMenus.order.length}개 중 ${menuShown}개 표시${state.form.homeMenus.programs.length ? ` · 프로그램 ${state.form.homeMenus.programs.length}개` : ""}`;
  const exposureSummary = hiddenEventSections.length ? `숨김: ${hiddenEventSections.join(" · ")}` : "공지 · 일정 · 장소 · 프로그램 모두 표시";

  function selectLayout(next: HomeLayout) {
    updateForm((form) => ({
      ...form,
      homeStyle: {
        ...form.homeStyle,
        layout: next,
        // Large type reads best on a dark page; only move off the untouched default.
        ...(next === "typography" && form.homeStyle.backgroundColor === DEFAULT_HOME_STYLE.backgroundColor ? { backgroundColor: "#1E2026" } : {}),
      },
    }));
  }

  function studioRow(key: "banner" | "text" | "menus" | "exposure", title: string, summary: string, visual: ReactNode, dirtyRow: boolean) {
    return (
      <button type="button" className={studio.row} onClick={() => { setPanel(key); requestAnimationFrame(() => document.getElementById("theme-panel-title")?.focus()); }}>
        <span className={studio.rowText}>
          <span className={studio.rowTitle}>{title}{dirtyRow ? <span className={studio.dirtyDot} role="img" aria-label="미저장 변경" /> : null}</span>
          <span className={studio.rowSummary}>{summary}</span>
        </span>
        {visual}
        <svg className={studio.chevron} viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M9.5 6.5 15 12l-5.5 5.5" /></svg>
      </button>
    );
  }

  return (
    <ConsolePage
      pageId="attendeePage"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      headerActions={publicAvailable ? <AttendeeGuideQr eventName={state.eventName} slug={state.slug} /> : undefined}
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
              <ProductButton variant="secondary" type="button" onClick={() => void reloadLatestDraft()} disabled={conflict.loading}>
                {conflict.loading ? "최신 상태 확인 중…" : conflict.contextChanged ? "최신 상태 확인" : "최신 초안 확인"}
              </ProductButton>
            ) : (
              <>
                <ProductButton variant="secondary" type="button" onClick={requestUseLatestDraft}>{conflict.contextChanged ? "최신 상태 불러오기" : "최신 초안 불러오기"}</ProductButton>
                {!conflict.afterWrite || currentScreenChanges.length ? (
                  <ProductButton variant="secondary" type="button" onClick={requestKeepMyDesign}>{conflict.afterWrite ? "현재 화면 내용 적용" : "내 변경을 최신 초안에 적용"}</ProductButton>
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

      <div className={studio.studio} data-layout={homeStyle.layout}>
        <div className={studio.stage}>
          <div className={studio.stageBar}>
            <div className={styles.sourceSwitch} role="group" aria-label="미리보기 기준">
              <ProductButton className={styles.viewportChoice} variant="secondary" type="button" aria-pressed={previewSource === "draft"} onClick={() => setPreviewSource("draft")}>편집 중</ProductButton>
              <ProductButton className={styles.viewportChoice} variant="secondary" type="button" aria-pressed={previewSource === "published"} onClick={() => setPreviewSource("published")}>게시본</ProductButton>
            </div>
          </div>
          <div className={studio.phoneSlot}>
            <h2 id="home-preview-heading" tabIndex={-1} className="sr-only">홈 디자인 미리보기</h2>
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
                  photos={state.previewPhotos}
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
          </div>
          <div className={studio.phoneOptions}>
            <label>
              <span className="sr-only">참가자 티켓</span>
              <select value={previewHasTicket ? "yes" : "no"} onChange={(event) => setPreviewHasTicket(event.target.value === "yes")}>
                <option value="yes">티켓 있음</option>
                <option value="no">티켓 없음</option>
              </select>
            </label>
            <label>
              <span className="sr-only">미리보기 화면 크기</span>
              <select value={`${previewSize.width}x${previewSize.height}`} onChange={(event) => { const [width, height] = event.target.value.split("x").map(Number); setPreviewSize({ width, height }); }}>
                <option value="320x568">짧은 화면 320×568</option>
                <option value="390x700">390×700</option>
                <option value="390x844">390×844</option>
              </select>
            </label>
            <button type="button" className={studio.expand} onClick={() => setStageOpen(true)}>크게 보기</button>
          </div>
          <p className={styles.previewNote}>미리보기 메뉴는 작동하지 않습니다. 행사 안내의 소개·강조색·일정·장소·프로그램은 안내 화면에서 확인하세요.</p>
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
        </div>

        <div className={studio.panel} id="theme-edit" tabIndex={-1}>
          {panel === null ? (
            <>
              <section className={studio.section} aria-labelledby="studio-layout">
                <h2 id="studio-layout" className={studio.sectionTitle}>레이아웃</h2>
                <p className={studio.sectionHint}>행사 성격에 맞는 구성을 고르세요. 다른 설정은 그대로 유지됩니다.</p>
                <fieldset className={studio.bare} disabled={editsLocked}>
                  <LayoutPicker
                    value={homeStyle.layout}
                    menuShape={homeStyle.menuShape}
                    homeStyle={homeStyle}
                    eventName={state.eventName}
                    keyvisual={imageUrl}
                    defaultHomeBanner={state.defaultHomeBanner}
                    homeMenus={state.form.homeMenus}
                    programs={state.availablePrograms}
                    photos={state.previewPhotos}
                    unavailable={state.unavailableMenus}
                    disabled={editsLocked}
                    onLayout={selectLayout}
                    onMenuShape={(shape) => changeHomeStyle("menuShape", shape)}
                  />
                </fieldset>
              </section>
              <section className={studio.section} aria-labelledby="studio-background">
                <h2 id="studio-background" className={studio.sectionTitle}>배경{backgroundDirty ? <span className={studio.dirtyDot} role="img" aria-label="미저장 변경" /> : null}</h2>
                <fieldset className={studio.bare} disabled={editsLocked}>
                  <ColorField label="배경색" value={homeStyle.backgroundColor} swatches={BACKGROUND_SWATCHES} disabled={editsLocked} paletteSource={imageUrl} onChange={(color) => changeHomeStyle("backgroundColor", color)} />
                </fieldset>
              </section>
              <ul className={studio.rows}>
                {homeStyle.layout !== "typography" ? <li>{studioRow("banner", "배너", bannerSummary, bannerSwatch, imageDirty || bannerDirty)}</li> : null}
                <li>{studioRow("text", "제목과 문구", homeStyle.heroTitle?.trim() || state.eventName, null, copyDirty)}</li>
                <li>{studioRow("menus", "홈 메뉴", menuSummary, null, menusDirty)}</li>
                <li>{studioRow("exposure", "소개와 공개 범위", exposureSummary, null, exposureDirty)}</li>
              </ul>
            </>
          ) : (
            <section className={studio.sub} aria-labelledby="theme-panel-title">
              <button type="button" className={studio.crumb} onClick={() => setPanel(null)}>
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>
                설정
              </button>
              <h2 id="theme-panel-title" tabIndex={-1} className={studio.subTitle}>{panel === "banner" ? "배너" : panel === "text" ? "제목과 문구" : panel === "menus" ? "홈 메뉴" : "소개와 공개 범위"}</h2>
              {panel === "banner" ? (
                <fieldset className={studio.bare} disabled={editsLocked}>
                  <legend className="sr-only">배너</legend>
                  <ChoiceCards
                    label="배너 종류"
                    value={homeStyle.bannerKind}
                    onChange={(kind) => changeHomeStyle("bannerKind", kind)}
                    options={[
                      { value: "image", name: "이미지", art: <span className={studio.artImage} /> },
                      { value: "gradient", name: "그라데이션", art: <span className={studio.artFill} style={{ background: `linear-gradient(135deg, ${homeStyle.bannerColor}, ${homeStyle.bannerColor2})` }} /> },
                      { value: "solid", name: "단색", art: <span className={studio.artFill} style={{ background: homeStyle.bannerColor }} /> },
                    ]}
                  />
                  {homeStyle.bannerKind === "image" ? (
                    <div className={studio.group}>
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
                  <ProductButton variant="secondary" type="button" onClick={() => void uploadFile(upload)}>같은 요청으로 다시 시도</ProductButton>
                  <ProductButton variant="secondary" type="button" onClick={requestCancelUpload}>선택 취소</ProductButton>
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
              <ProductButton variant="secondary" type="button" onClick={requestClearImage} disabled={!canEditImage || (!state.form.keyvisual && !upload)}>
                {upload?.status === "uploaded" || upload?.status === "failed" ? "선택 취소" : state.form.keyvisual ? "배너 이미지 제거" : state.defaultHomeBanner === "neutral" ? "기본 배너 사용 중" : "기본 이미지 사용 중"}
              </ProductButton>
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
                      <p className={studio.groupTitle}>사진 초점</p>
                      <ChoiceCards
                        label="사진 초점"
                        value={homeStyle.imageFocus}
                        onChange={(focus) => changeHomeStyle("imageFocus", focus)}
                        options={[
                          { value: "top", name: "위", art: <span className={studio.artFocus} data-focus="top" /> },
                          { value: "center", name: "가운데", art: <span className={studio.artFocus} data-focus="center" /> },
                          { value: "bottom", name: "아래", art: <span className={studio.artFocus} data-focus="bottom" /> },
                        ]}
                      />
                      <p className={studio.groupTitle}>글자 가독성</p>
                      <Seg label="읽기 배경" value={homeStyle.overlay} onChange={(overlay) => changeHomeStyle("overlay", overlay)} options={[{ value: "none", name: "없음" }, { value: "soft", name: "부드럽게" }, { value: "strong", name: "진하게" }]} />
                    </div>
                  ) : null}
                  {homeStyle.bannerKind === "gradient" ? (
                    <div className={studio.group}>
                      <p className={studio.groupTitle}>추천 그라데이션</p>
                      <div className={studio.presets} role="radiogroup" aria-label="추천 그라데이션">
                        {GRADIENT_PRESETS.map((preset) => {
                          const on = homeStyle.bannerColor === preset.from && homeStyle.bannerColor2 === preset.to;
                          return (
                            <button key={preset.name} type="button" role="radio" aria-checked={on} className={studio.preset} onClick={() => updateForm((form) => ({ ...form, homeStyle: { ...form.homeStyle, bannerColor: preset.from, bannerColor2: preset.to } }))}>
                              <span className={studio.presetArt} style={{ background: `linear-gradient(135deg, ${preset.from}, ${preset.to})` }} aria-hidden="true" />
                              {preset.name}
                            </button>
                          );
                        })}
                      </div>
                      <p className={studio.groupTitle}>시작 색</p>
                      <ColorField label="시작 색" value={homeStyle.bannerColor} swatches={BANNER_SWATCHES} disabled={editsLocked} compact onChange={(color) => changeHomeStyle("bannerColor", color)} />
                      <p className={studio.groupTitle}>끝 색</p>
                      <ColorField label="끝 색" value={homeStyle.bannerColor2} swatches={BANNER_SWATCHES} disabled={editsLocked} compact onChange={(color) => changeHomeStyle("bannerColor2", color)} />
                      <p className={studio.groupTitle}>방향</p>
                      <ChoiceCards
                        label="그라데이션 방향"
                        value={homeStyle.bannerAngle}
                        onChange={(angle) => changeHomeStyle("bannerAngle", angle)}
                        options={(["diagonal", "vertical", "horizontal"] as const).map((angle) => ({
                          value: angle,
                          name: angle === "diagonal" ? "대각선" : angle === "vertical" ? "위에서 아래" : "왼쪽에서 오른쪽",
                          art: <span className={studio.artFill} style={{ background: `linear-gradient(${angle === "diagonal" ? "135deg" : angle === "vertical" ? "180deg" : "90deg"}, ${homeStyle.bannerColor}, ${homeStyle.bannerColor2})` }} />,
                        }))}
                      />
                    </div>
                  ) : null}
                  {homeStyle.bannerKind === "solid" ? (
                    <div className={studio.group}>
                      <p className={studio.groupTitle}>배너 색</p>
                      <ColorField label="배너 색" value={homeStyle.bannerColor} swatches={BANNER_SWATCHES} disabled={editsLocked} onChange={(color) => changeHomeStyle("bannerColor", color)} />
                    </div>
                  ) : null}
                  {homeStyle.layout === "tile" ? (
                    <div className={studio.group}>
                      <p className={studio.groupTitle}>글 위치</p>
                      <ChoiceCards
                        label="글 위치"
                        value={homeStyle.heroLayout}
                        onChange={(position) => changeHomeStyle("heroLayout", position)}
                        options={[
                          { value: "centered", name: "가운데", art: <span className={studio.artText} data-pos="middle" /> },
                          { value: "bottom-overlay", name: "아래", art: <span className={studio.artText} data-pos="bottom" /> },
                          { value: "image-only", name: "글자 숨김", art: <span className={studio.artText} data-pos="none" />, disabled: homeStyle.bannerKind !== "image" },
                        ]}
                      />
                    </div>
                  ) : null}
                </fieldset>
              ) : null}
              {panel === "text" ? (
                <fieldset className={studio.bare} disabled={editsLocked}>
                  <legend className="sr-only">제목과 문구</legend>
                  <label className={styles.field} htmlFor="home-hero-title">
                    배너 제목 <span>최대 80자</span>
                    <input id="home-hero-title" type="text" maxLength={80} value={homeStyle.heroTitle ?? ""} placeholder={state.eventName} onChange={(event) => changeHomeStyle("heroTitle", event.target.value || null)} />
                  </label>
                  <label className={styles.field} htmlFor="home-hero-subtitle">
                    보조 문구 <span>최대 100자</span>
                    <input id="home-hero-subtitle" type="text" maxLength={100} value={homeStyle.heroSubtitle} placeholder="선택 입력" onChange={(event) => changeHomeStyle("heroSubtitle", event.target.value)} />
                  </label>
                  <div className={studio.group}>
                    <p className={studio.groupTitle}>제목 크기</p>
                    <Seg label="제목 크기" value={homeStyle.titleScale} onChange={(scale) => changeHomeStyle("titleScale", scale)} options={[{ value: "standard", name: "기본" }, { value: "large", name: "크게" }]} />
                    <p className={studio.groupTitle}>글 정렬</p>
                    <Seg label="글 정렬" value={homeStyle.textAlign} onChange={(align) => changeHomeStyle("textAlign", align)} options={[{ value: "left", name: "왼쪽" }, { value: "center", name: "가운데" }, { value: "right", name: "오른쪽" }]} />
                    {homeStyle.layout !== "typography" && homeStyle.bannerKind === "image" ? (
                      <>
                        <p className={studio.groupTitle}>글자 색</p>
                        <Seg label="글자 색" value={homeStyle.textTone} onChange={(tone) => changeHomeStyle("textTone", tone)} options={[{ value: "light", name: "흰색" }, { value: "dark", name: "짙은 색" }]} />
                      </>
                    ) : null}
                  </div>
                </fieldset>
              ) : null}
              {panel === "menus" ? (
                <fieldset className={studio.bare} disabled={Boolean(commandBusy || conflict || state.archived)}>
                  <legend className="sr-only">메뉴 표시와 순서</legend>
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
                    <ProductButton type="button" variant="secondary" aria-label={`${MENU_LABELS[key]} 위로 이동`} disabled={index === 0} onClick={() => moveHomeMenu(key, -1)}>↑</ProductButton>
                    <ProductButton type="button" variant="secondary" aria-label={`${MENU_LABELS[key]} 아래로 이동`} disabled={index === ordered.length - 1} onClick={() => moveHomeMenu(key, 1)}>↓</ProductButton>
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
                    <ProductButton type="button" variant="secondary" aria-label={`${program.title} 위로 이동`} disabled={position === 0} onClick={() => moveHomeProgram(program.id, -1)}>↑</ProductButton>
                    <ProductButton type="button" variant="secondary" aria-label={`${program.title} 아래로 이동`} disabled={position === state.form.homeMenus.programs.length - 1} onClick={() => moveHomeProgram(program.id, 1)}>↓</ProductButton>
                  </span> : null}
                </li>;
              })}</ol> : <p className={styles.help}>게시된 참여 콘텐츠가 없습니다.</p>}
            </div>
                </fieldset>
              ) : null}
              {panel === "exposure" ? (
                <fieldset className={studio.bare} disabled={editsLocked}>
                  <legend className="sr-only">소개와 공개 범위</legend>
                  <label className={styles.field} htmlFor="home-intro">
                    행사 소개 <span>최대 160자</span>
                    <input id="home-intro" type="text" maxLength={160} value={state.pageFields.intro} onChange={(event) => updatePageField("intro", event.target.value)} aria-invalid={failure?.field === "intro" || undefined} />
                  </label>
                  <div className={studio.group}>
                    <p className={studio.groupTitle}>강조색</p>
                    <ColorField label="강조색" value={state.pageFields.accent} swatches={BANNER_SWATCHES} disabled={editsLocked} compact onChange={(color) => updatePageField("accent", color)} />
                  </div>
                  <div className={studio.group}>
                    <p className={studio.groupTitle}>참가자에게 보여줄 곳</p>
                    <p className={styles.help}>공지 설정은 참가자 홈에도 적용됩니다. 행사 일시·장소를 숨겨도 티켓의 행사일, 프로그램 일정의 일시·장소, 부스 지도와 전광판은 별도로 표시될 수 있습니다.</p>
                    <div className={studio.switches}>
                      <Switch label="공지 보기" value={state.pageFields.showAnnouncements} onChange={(checked) => updatePageField("showAnnouncements", checked)} isDisabled={editsLocked} />
                      <Switch label="행사 일시 보기" value={state.pageFields.showSchedule} onChange={(checked) => updatePageField("showSchedule", checked)} isDisabled={editsLocked} />
                      <Switch label="장소 보기" value={state.pageFields.showVenue} onChange={(checked) => updatePageField("showVenue", checked)} isDisabled={editsLocked} />
                      <Switch label="프로그램 일정 보기" value={state.pageFields.showPrograms} onChange={(checked) => updatePageField("showPrograms", checked)} isDisabled={editsLocked} />
                    </div>
                  </div>
                </fieldset>
              ) : null}
            </section>
          )}
          <div id="theme-save" tabIndex={-1} className={`${styles.saveAnchor} ${styles.saveBar}`}>
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
              <ProductButton variant="secondary" type="button" disabled={Boolean(commandBusy || conflict)} onClick={() => void reloadLatestDraft(true)}>최신 상태 확인</ProductButton>
            </div> : null}
            {uploadBlocked ? (
              <p className={styles.inlineHelp}>
                {upload?.status === "uploading" ? "이미지를 올리는 중입니다. 완료될 때까지 초안 저장이 잠깁니다." : "이미지 업로드 결과를 확인해야 초안을 저장할 수 있습니다. 같은 요청으로 다시 시도하세요."}
              </p>
            ) : null}
            <div className={styles.saveButtons}>
            <ConsoleFormActions>
              <ProductButton id="theme-save-draft" variant={dirty || !canPublish ? "primary" : "secondary"} type="button" onClick={() => void saveDraft()} disabled={!canSave}>
                {commandBusy === "save" ? "초안 저장 중…" : "초안 저장"}
              </ProductButton>
              <ProductButton variant={!dirty && canPublish ? "primary" : "secondary"} type="button" onClick={() => void requestPublishDraft()} disabled={!canPublish}>
                {commandBusy === "publish" ? "게시 중…" : "게시 검토"}
              </ProductButton>
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
              <ProductButton variant="secondary" type="button" onClick={requestLoadPublishedDesign} disabled={Boolean(commandBusy || conflict || state.archived || upload?.status === "uploading")}>게시된 디자인 불러오기</ProductButton>
              <ProductButton variant="secondary" type="button" onClick={requestResetDesignDefaults} disabled={Boolean(commandBusy || conflict || state.archived || upload?.status === "uploading")}>기본 디자인으로</ProductButton>
              {dirty ? <ProductButton variant="secondary" type="button" onClick={requestDiscardChanges} disabled={Boolean(commandBusy || state.archived || upload?.status === "uploading")}>저장 전 변경 취소</ProductButton> : null}
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
      </div>

      {stageOpen ? (
        <ConsoleDialog titleId="theme-stage-title" title="참가자 홈 미리보기" presentation="stage" onClose={() => setStageOpen(false)}>
          <div className={studio.stageDialog}>
            <div className={studio.stageDialogBar}>
              <div className={styles.sourceSwitch} role="group" aria-label="미리보기 기준">
                <ProductButton className={styles.viewportChoice} variant="secondary" type="button" aria-pressed={previewSource === "draft"} onClick={() => setPreviewSource("draft")}>편집 중</ProductButton>
                <ProductButton className={styles.viewportChoice} variant="secondary" type="button" aria-pressed={previewSource === "published"} onClick={() => setPreviewSource("published")}>게시본</ProductButton>
              </div>
              <button type="button" className={studio.stageClose} onClick={() => setStageOpen(false)}>닫기</button>
            </div>
            <div className={studio.stageDialogBody}>          <div className={styles.phoneStage}>
            <div
              className={styles.phoneViewport}
              role="region"
              aria-label={`${previewSize.width}×${previewSize.height} 홈 디자인 큰 미리보기`}
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
                  photos={state.previewPhotos}
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
          </div></div>
          </div>
        </ConsoleDialog>
      ) : null}
    </ConsolePage>
  );
}
