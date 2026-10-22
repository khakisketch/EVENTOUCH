"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, ChangeEvent } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import {
  DEFAULT_HOME_STYLE,
  homeImageLabel,
  normalizeHomeImage,
  normalizeHomeStyle,
  sameHomeImage,
  type HomeImage,
  type HomeStyle,
} from "../../../../../lib/attendee-home";
import AttendeeHomeLanding from "../../../../event/[slug]/home/AttendeeHomeLanding";
import attendeeHomeStyles from "../../../../event/[slug]/home/home.module.css";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import styles from "./page.module.css";

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_MAX_BYTES = 600_000;

type PageFields = {
  intro: string;
  accent: string;
  showAnnouncements: boolean;
  showSchedule: boolean;
  showVenue: boolean;
  showPrograms: boolean;
};

type DesignForm = { homeStyle: HomeStyle; keyvisual: HomeImage | null };
type Snapshot = {
  eventName: string;
  eventMeta?: string;
  archived: boolean;
  pageFields: PageFields;
  publishedPageFields: PageFields;
  form: DesignForm;
  draftVersion: number;
  publishedVersion: number;
  publishedAt: string | null;
  publishedDesign: DesignForm;
};
type Ready = Snapshot & { kind: "ready"; savedForm: DesignForm; savedPageFields: PageFields };
// Names the section in view for the jump-nav readout.
const THEME_SECTION_LABELS: Record<string, string> = {
  "theme-edit": "편집",
  "theme-save": "저장·게시",
  "home-preview-heading": "미리보기",
};

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
  error?: string;
};
type ConflictState = { latest: Snapshot | null; loading: boolean; error: string | null };

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
type PendingIntent = { commandId: string; fingerprint: string };

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
): Snapshot | { denied: string } {
  const bootstrap = record(record(bootstrapValue)?.state);
  const user = record(record(meValue)?.user);
  if (!bootstrap || !user) throw new Error("행사 정보를 불러오지 못했습니다.");
  const userId = text(user.id);
  const role = text(user.role);
  const accounts = Array.isArray(bootstrap.accounts) ? bootstrap.accounts.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const account = accounts.find((item) => item.id === userId);
  const isOwner = role === "AGENCY" || account?.orgOwner === true;
  const memberships = Array.isArray(bootstrap.memberships) ? bootstrap.memberships.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const isMember = memberships.some((item) => item.accountId === userId && item.eventId === eventId);
  if (!isOwner && !(role === "MANAGER" && isMember)) {
    return { denied: "이 행사의 참가자 화면을 관리할 권한이 없습니다." };
  }
  const events = Array.isArray(bootstrap.events) ? bootstrap.events.map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
  const event = events.find((item) => item.id === eventId);
  const workspaces = record(bootstrap.workspaces);
  const workspace = record(workspaces?.[eventId]);
  if (!event || !workspace) throw new Error("행사를 찾을 수 없습니다.");
  const pageExperience = record(workspace.pageExperience) ?? {};
  const draft = record(pageExperience.draft) ?? {};
  const published = record(pageExperience.published) ?? {};
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
  };
  const publishedDesign: DesignForm = {
    homeStyle: normalizeHomeStyle(published.homeStyle),
    keyvisual: normalizeHomeImage(Object.hasOwn(published, "keyvisual") ? published.keyvisual : branding.keyvisual),
  };
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
  };
}

function formIsDirty(form: DesignForm, saved: DesignForm): boolean {
  return JSON.stringify(form.homeStyle) !== JSON.stringify(saved.homeStyle) || !sameHomeImage(form.keyvisual, saved.keyvisual);
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
    ["showSchedule", "일정"],
    ["showVenue", "장소"],
    ["showPrograms", "프로그램"],
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
  ["showSchedule", "일정 보기"],
  ["showVenue", "장소 보기"],
  ["showPrograms", "프로그램 보기"],
];

function describeChangedDesign(from: DesignForm, to: DesignForm): string[] {
  const changed = HOME_STYLE_LABELS.flatMap(([key, label]) => from.homeStyle[key] !== to.homeStyle[key] ? [label] : []);
  if (!sameHomeImage(from.keyvisual, to.keyvisual)) changed.push("배너 이미지");
  return changed;
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

async function loadSnapshot(eventId: string): Promise<Snapshot | { denied: string }> {
  const [meResponse, bootstrapResponse] = await Promise.all([
    fetch("/api/auth/me", { cache: "no-store" }),
    fetch("/api/bootstrap", { cache: "no-store" }),
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
  return parseSnapshot(bootstrap, me, eventId);
}

export default function ThemeWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<EditorState>({ kind: "loading" });
  const [activeSection, setActiveSection] = useState("theme-edit");
  const [reloadTick, setReloadTick] = useState(0);
  const [upload, setUpload] = useState<UploadIntent | null>(null);
  const [previewSize, setPreviewSize] = useState({ width: 390, height: 700 });
  // Read-only preview choice: which snapshot feeds the landing below. Never
  // touches editor fields and stays outside the unsaved-work guard.
  const [previewSource, setPreviewSource] = useState<"draft" | "published">("draft");
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
  const uploadUrlRef = useRef<string | null>(null);

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
        if (cancelled) return;
        if ("denied" in snapshot) {
          setState({ kind: "denied", message: snapshot.denied });
          return;
        }
        setState({ ...snapshot, kind: "ready", savedForm: snapshot.form, savedPageFields: { ...snapshot.pageFields } });
      } catch (error) {
        if (cancelled) return;
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

  // Names the section in view for the jump-nav readout. Anchor clicks keep
  // working natively whether or not the observer is available.
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const ids = Object.keys(THEME_SECTION_LABELS);
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
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": intent.file.type },
        body: intent.file,
      });
      const payload = record(await response.json().catch(() => null));
      const file = record(payload?.file);
      const fileId = text(file?.fileId);
      if (!response.ok || !/^[A-Za-z0-9_-]{1,160}$/.test(fileId)) {
        setUpload({ ...intent, status: "failed", error: text(payload?.error) || "파일을 올리지 못했습니다. 같은 파일로 다시 시도하세요." });
        if (response.status === 401) router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
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
      setUpload({ ...intent, status: "uploaded" });
      setFailure(null);
      setNotice("배너 이미지를 올렸습니다. 참가자에게 보이려면 초안을 저장하고 게시하세요.");
    } catch {
      // Keep the same upload receipt intent and local object URL. Retrying
      // this exact request avoids creating duplicate stored files.
      setUpload({ ...intent, status: "failed", error: "업로드 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
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
      ? { ...current, form: { ...current.publishedDesign, homeStyle: { ...current.publishedDesign.homeStyle } } }
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
      ? { ...current, form: { homeStyle: { ...DEFAULT_HOME_STYLE }, keyvisual: null } }
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

  async function reloadLatestDraft() {
    if (conflict?.loading) return;
    setConflict({ latest: null, loading: true, error: null });
    try {
      const snapshot = await loadSnapshot(eventId);
      if ("denied" in snapshot) {
        setConflict({ latest: null, loading: false, error: snapshot.denied });
        return;
      }
      setConflict({ latest: snapshot, loading: false, error: null });
    } catch (error) {
      if (record(error)?.status === 401) {
        router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
        return;
      }
      setConflict({ latest: null, loading: false, error: error instanceof Error ? error.message : "최신 초안을 확인하지 못했습니다." });
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
    const localChanges = formIsDirty(state.form, state.savedForm) || pageFieldsAreDirty(state) || Boolean(upload);
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
    kept: string[];
    conflicted: string[];
  } | null {
    if (state.kind !== "ready" || !conflict?.latest) return null;
    const latest = conflict.latest;
    // Per-leaf three-way merge against the saved baseline both sides forked
    // from: only leaves this editor actually changed are carried over; every
    // other leaf adopts the latest draft. A leaf both sides changed is a
    // real conflict — disclosed by name and resolved here with the local
    // value, because that is what "내 변경 유지" was asked to do.
    const mergedHomeStyle = { ...latest.form.homeStyle };
    const mergedPageFields = { ...latest.pageFields };
    let mergedKeyvisual = latest.form.keyvisual;
    const kept: string[] = [];
    const conflicted: string[] = [];
    for (const [key, label] of HOME_STYLE_LABELS) {
      const mine = state.form.homeStyle[key] !== state.savedForm.homeStyle[key];
      const theirs = latest.form.homeStyle[key] !== state.savedForm.homeStyle[key];
      if (!mine) continue;
      kept.push(label);
      if (theirs) conflicted.push(label);
      Object.assign(mergedHomeStyle, { [key]: state.form.homeStyle[key] });
    }
    for (const [key, label] of PAGE_FIELD_LABELS) {
      const mine = state.pageFields[key] !== state.savedPageFields[key];
      const theirs = latest.pageFields[key] !== state.savedPageFields[key];
      if (!mine) continue;
      kept.push(label);
      if (theirs) conflicted.push(label);
      Object.assign(mergedPageFields, { [key]: state.pageFields[key] });
    }
    if (!sameHomeImage(state.form.keyvisual, state.savedForm.keyvisual)) {
      kept.push("배너 이미지");
      if (!sameHomeImage(latest.form.keyvisual, state.savedForm.keyvisual)) conflicted.push("배너 이미지");
      mergedKeyvisual = state.form.keyvisual;
    }
    return { mergedHomeStyle, mergedPageFields, mergedKeyvisual, kept, conflicted };
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
    const localForm: DesignForm = { ...latest.form, homeStyle: merge.mergedHomeStyle, keyvisual: merge.mergedKeyvisual };
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
      merge.conflicted.length
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
    if (!sameHomeImage(state.form.keyvisual, state.savedForm.keyvisual)) {
      if (state.form.keyvisual?.fileId) payload.keyvisual = { fileId: state.form.keyvisual.fileId };
      else if (!state.form.keyvisual) payload.clearKeyvisual = true;
    }
    // Bind this exact payload to one command id. An unchanged retry after an
    // ambiguous failure replays the same receipt; any further edit mints a
    // fresh id so the server can never replay a stale response over it.
    const fingerprint = stableStringify(payload);
    const pending = pendingSaveRef.current;
    const commandId = pending && pending.fingerprint === fingerprint ? pending.commandId : randomCommandId();
    pendingSaveRef.current = { commandId, fingerprint };
    // Capture exactly what is being sent. The success path advances only the
    // saved baselines and never overwrites newer local values with this
    // earlier response.
    const submittedForm = state.form;
    const submittedPageFields = state.pageFields;
    const submittedUpload = upload;
    setCommandBusy("save");
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command: "attendee.page.save", payload }),
      });
      const body = record(await response.json().catch(() => null));
      if (!response.ok) {
        const message = text(body?.error) || "초안을 저장하지 못했습니다.";
        setFailure({ message, field: text(body?.field) || undefined });
        if (response.status === 409 && (body?.field === "expectedDraftVersion" || /최신 초안/.test(message))) {
          setConflict({ latest: null, loading: false, error: null });
        }
        // Definitive rejections need a fresh id; 408/5xx keep the bound one.
        if (response.status !== 408 && response.status < 500) pendingSaveRef.current = null;
        if (response.status === 401) router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
        if (response.status === 403) setState({ kind: "denied", message: "이 행사의 참가자 화면을 관리할 권한이 없습니다." });
        return;
      }
      const saved = record(body?.draft);
      if (!body || !saved || !Number.isSafeInteger(body.draftVersion)) {
        setFailure({ message: "저장 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      pendingSaveRef.current = null;
      const savedForm: DesignForm = {
        homeStyle: normalizeHomeStyle(saved.homeStyle),
        keyvisual: normalizeHomeImage(saved.keyvisual),
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
      setState((current) => {
        if (current.kind !== "ready") return current;
        // Adopt the server-normalized values only where the local editor
        // still holds exactly what was submitted. Newer local edits stay
        // untouched and remain dirty against the advanced baselines.
        const formSettled = !formIsDirty(current.form, submittedForm);
        const fieldsSettled = JSON.stringify(current.pageFields) === JSON.stringify(submittedPageFields);
        return {
          ...current,
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
      setConflict(null);
      setNotice("초안을 저장했습니다. 참가자 화면에는 게시 전까지 적용되지 않습니다.");
    } catch {
      // Keep the bound id and file reference after ambiguous transport failures.
      setFailure({ message: "저장 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
    } finally {
      setCommandBusy(null);
    }
  }

  function requestPublishDraft() {
    if (state.kind !== "ready" || commandBusy || conflict || state.archived || formIsDirty(state.form, state.savedForm) || pageFieldsAreDirty(state) || upload) return;
    if (state.publishedAt && state.publishedVersion === state.draftVersion) return;
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
    setPublishPending(false);
    const payload = { expectedDraftVersion: state.draftVersion };
    const fingerprint = stableStringify(payload);
    const pending = pendingPublishRef.current;
    const commandId = pending && pending.fingerprint === fingerprint ? pending.commandId : randomCommandId();
    pendingPublishRef.current = { commandId, fingerprint };
    setCommandBusy("publish");
    setFailure(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId,
          command: "attendee.page.publish",
          payload,
        }),
      });
      const body = record(await response.json().catch(() => null));
      if (!response.ok) {
        const message = text(body?.error) || "게시하지 못했습니다.";
        setFailure({ message, field: text(body?.field) || undefined });
        if (response.status === 409 && (body?.field === "expectedDraftVersion" || /최신 초안/.test(message))) {
          setConflict({ latest: null, loading: false, error: null });
        }
        if (response.status !== 408 && response.status < 500) pendingPublishRef.current = null;
        if (response.status === 401) router.replace(loginHrefForLocation(window.location.pathname, window.location.search));
        if (response.status === 403) setState({ kind: "denied", message: "이 행사의 참가자 화면을 관리할 권한이 없습니다." });
        return;
      }
      const published = record(body?.published);
      if (!body || !published || !Number.isSafeInteger(body.publishedVersion)) {
        setFailure({ message: "게시 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
        return;
      }
      pendingPublishRef.current = null;
      const publishedDesign: DesignForm = {
        homeStyle: normalizeHomeStyle(published.homeStyle),
        keyvisual: normalizeHomeImage(published.keyvisual),
      };
      const publishedPageFields: PageFields = {
        intro: text(published.intro),
        accent: validAccent(published.accent),
        showAnnouncements: published.showAnnouncements !== false,
        showSchedule: published.showSchedule !== false,
        showVenue: published.showVenue !== false,
        showPrograms: published.showPrograms !== false,
      };
      const publishedVersion = version(body.publishedVersion);
      const publishedAt = new Date().toISOString();
      setState((current) => current.kind === "ready" ? {
        ...current,
        publishedDesign,
        publishedPageFields,
        publishedVersion,
        publishedAt,
      } : current);
      setNotice("게시했습니다. 이 행사를 보는 참가자에게 새 디자인이 적용되었습니다.");
    } catch {
      setFailure({ message: "게시 응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요." });
    } finally {
      setCommandBusy(null);
    }
  }

  if (state.kind === "loading") {
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
  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 저장·게시 affordance를
  // 잠그고 읽기·미리보기만 둡니다.
  const canSave = dirty && !uploadBlocked && !commandBusy && !conflict && !state.archived;
  const canPublish = !dirty && !upload && !commandBusy && !conflict && !alreadyPublished && !state.archived;
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
  const publishedVisibility = [
    state.publishedPageFields.showAnnouncements ? null : "공지 숨김",
    state.publishedPageFields.showSchedule ? null : "일정 숨김",
    state.publishedPageFields.showVenue ? null : "장소 숨김",
    state.publishedPageFields.showPrograms ? null : "프로그램 숨김",
  ].filter((item): item is string => item !== null);
  const publishedChanges = [
    ...describeChangedDesign(state.publishedDesign, state.savedForm),
    ...describeChangedPageFields(state.publishedPageFields, state.savedPageFields),
  ];
  const latestChanges = conflict?.latest ? describeChangedDesign(state.savedForm, conflict.latest.form) : [];
  const canEditImage = !commandBusy && !state.archived && upload?.status !== "uploading" && upload?.status !== "failed";

  function changeHomeStyle<K extends keyof HomeStyle>(field: K, value: HomeStyle[K]) {
    updateForm((form) => ({ ...form, homeStyle: { ...form.homeStyle, [field]: value } }));
  }

  return (
    <ConsolePage
      pageId="attendeePage"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      feedback={
        <>
          {failure ? <ConsoleFeedback kind="error">{failure.message}</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 디자인과 소개를 볼 수 있지만 저장·게시는 할 수 없습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
      badges={
        <div className={styles.versionSummary} aria-live="polite">
          <span className={styles.statePill} data-state={dirty ? "dirty" : alreadyPublished ? "published" : "draft"}>
            {dirty ? "저장되지 않은 변경" : alreadyPublished ? "현재 초안 게시됨" : "저장된 초안"}
          </span>
          <span>
            {state.publishedAt
              ? `게시 버전 ${state.publishedVersion} · 초안 ${state.draftVersion}`
              : `아직 게시하지 않음 · 초안 ${state.draftVersion}`}
          </span>
          {state.publishedAt ? <span>최근 게시 {formatPublishedAt(state.publishedAt)}</span> : null}
        </div>
      }
      sectionNav={
        <div className={styles.navSticky}>
          <ConsoleSectionNav
            label="참가자 페이지 구역"
            items={[
              { id: "theme-edit", label: "편집" },
              { id: "theme-save", label: "저장·게시" },
              { id: "home-preview-heading", label: "미리보기" },
            ]}
          />
          <p className={styles.navNow}>현재 위치: {THEME_SECTION_LABELS[activeSection] || "편집"}</p>
        </div>
      }
    >
      {conflict ? (
        <section className={styles.conflictPanel} aria-labelledby="page-conflict-title">
          <div>
            <h2 id="page-conflict-title">최신 초안이 달라졌습니다</h2>
            <p>다른 운영자가 먼저 저장했습니다. 현재 편집 내용은 그대로 보존했고, 확인 없이 덮어쓰지 않았습니다.</p>
            {conflict.latest ? (
              <p className={styles.conflictDetails}>
                최신 초안 v{conflict.latest.draftVersion}
                {latestChanges.length ? ` · 변경 항목: ${latestChanges.join(" · ")}` : " · 디자인 항목 변경 없음"}
              </p>
            ) : null}
            {conflict.error ? <p role="alert">{conflict.error}</p> : null}
          </div>
          <div className={styles.conflictActions}>
            {!conflict.latest ? (
              <button className="button button-secondary" type="button" onClick={() => void reloadLatestDraft()} disabled={conflict.loading}>
                {conflict.loading ? "최신 초안 확인 중…" : "최신 초안 확인"}
              </button>
            ) : (
              <>
                <button className="button button-secondary" type="button" onClick={requestUseLatestDraft}>최신 초안 불러오기</button>
                <button className="button button-secondary" type="button" onClick={requestKeepMyDesign}>내 변경을 최신 초안에 적용</button>
              </>
            )}
          </div>
          {useLatestPending && conflict?.latest ? (
            <ConsoleConfirm
              summary={`현재 편집 중인 변경을 버리고 최신 초안으로 바꿀까요?${upload ? " 업로드된 파일은 최신 초안에 연결되지 않으며 서버에 남을 수 있습니다." : ""}`}
              confirmLabel="최신 초안으로 바꾸기"
              onConfirm={confirmUseLatestDraft}
              onCancel={() => setUseLatestPending(false)}
            />
          ) : null}
          {mergePending ? (
            <ConsoleConfirm
              summary={(
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
              confirmLabel="내 변경 유지하기"
              onConfirm={confirmKeepMyDesign}
              onCancel={() => setMergePending(null)}
            />
          ) : null}
        </section>
      ) : null}

      <div className={styles.editorLayout}>
        <div className={styles.controls} id="theme-edit">
          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>배경</legend>
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

          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>배너 이미지</legend>
            <p className={styles.help}>PNG, JPEG, WEBP · 최대 600KB. 업로드 후 저장하고 게시해야 참가자에게 적용됩니다.</p>
            <div className={styles.imageStatus}>
              <span className={styles.imageStatusName}>{upload?.status === "uploading" ? upload.file.name : homeImageLabel(state.form.keyvisual)}</span>
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
                {upload?.status === "uploaded" || upload?.status === "failed" ? "선택 취소" : state.form.keyvisual ? "배너 이미지 제거" : "기본 이미지 사용 중"}
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
            <label className={styles.field} htmlFor="home-image-focus">
              이미지 초점
              <select id="home-image-focus" value={state.form.homeStyle.imageFocus} onChange={(event) => changeHomeStyle("imageFocus", event.target.value as HomeStyle["imageFocus"])}>
                <option value="center">가운데</option>
                <option value="top">위쪽</option>
                <option value="bottom">아래쪽</option>
              </select>
            </label>
          </fieldset>

          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>소개와 노출</legend>
            <p className={styles.help}>참가자 홈에 보이는 소개와 항목입니다. 저장 후 게시해야 적용됩니다.</p>
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
                일정 보기
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
                프로그램 보기
              </label>
            </div>
          </fieldset>

          <fieldset className={styles.controlGroup} disabled={Boolean(commandBusy || conflict || state.archived)}>
            <legend>문구와 배치</legend>
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
          </fieldset>

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

          <div id="theme-save">
            {dirty && !uploadBlocked ? <p className={styles.inlineHelp}>게시 버튼은 저장된 초안에만 작동합니다. 먼저 초안을 저장하세요.</p> : null}
            {uploadBlocked ? (
              <p className={styles.inlineHelp} role="status">
                {upload?.status === "uploading" ? "이미지를 올리는 중입니다. 완료될 때까지 초안 저장이 잠깁니다." : "이미지 업로드 결과를 확인해야 초안을 저장할 수 있습니다. 같은 요청으로 다시 시도하세요."}
              </p>
            ) : null}
            <ConsoleFormActions>
              <button className="button button-primary" type="button" onClick={() => void saveDraft()} disabled={!canSave}>
                {commandBusy === "save" ? "초안 저장 중…" : "초안 저장"}
              </button>
              <button className="button button-secondary" type="button" onClick={() => void requestPublishDraft()} disabled={!canPublish}>
                {commandBusy === "publish" ? "게시 중…" : "게시"}
              </button>
            </ConsoleFormActions>
            {publishPending ? (
              <ConsoleConfirm
                summary={(
                  <>
                    &ldquo;{state.eventName}&rdquo;의 저장된 디자인을 참가자 화면에 게시할까요?
                    <br />
                    <br />
                    {publishedChanges.length ? `게시될 변경: ${publishedChanges.join(" · ")}` : "현재 기본 참가자 화면을 게시합니다."}
                    <br />
                    <br />
                    게시 후 같은 행사를 보는 모든 참가자에게 적용됩니다.
                  </>
                )}
                confirmLabel="게시하기"
                busy={commandBusy === "publish"}
                onConfirm={() => void confirmPublishDraft()}
                onCancel={() => setPublishPending(false)}
              />
            ) : null}
          </div>
        </div>

        <section className={styles.previewPanel} aria-labelledby="home-preview-heading">
          <div className={styles.previewHeader}>
            <div>
              <h2 id="home-preview-heading">홈 디자인 미리보기</h2>
              <p>저장 여부와 관계없이 현재 편집 중인 홈 디자인을 표시합니다. 행사 소개와 항목 노출은 게시 후 참가자 화면에서 확인하세요.</p>
            </div>
            <span className={styles.liveMark}><span aria-hidden="true" />실시간</span>
          </div>
          <div className={styles.sourceSwitch} role="group" aria-label="미리보기 기준">
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
          <div className={styles.viewportChoices} role="group" aria-label="미리보기 화면 크기">
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
          <div className={styles.phoneStage}>
            <div
              className={styles.phoneViewport}
              role="region"
              aria-label={`${previewSize.width}×${previewSize.height} 홈 디자인 미리보기`}
              style={{ "--preview-width": `${previewSize.width}px`, "--preview-height": `${previewSize.height}px` } as CSSProperties}
            >
              {showingPublished && !hasPublished ? (
                <p className={styles.previewNote}>아직 게시된 화면이 없습니다</p>
              ) : (
              <div className={`${styles.previewHome} ${attendeeHomeStyles.homePage}`} style={showingPublished ? publishedPreviewStyle : previewStyle}>
                <AttendeeHomeLanding
                  eventName={state.eventName}
                  // The preview shows the design as a participant with a ticket
                  // sees it; the ticket notice is a live state, not a design.
                  hasTicket
                  keyvisual={showingPublished ? publishedImageUrl : imageUrl}
                  homeStyle={showingPublished ? state.publishedDesign.homeStyle : state.form.homeStyle}
                  preview
                  shortViewport={previewSize.height <= 820}
                />
              </div>
              )}
            </div>
          </div>
          {!showingPublished && upload?.status === "failed" ? <p className={styles.previewNote}>업로드가 확인되지 않았습니다. 미리보기에는 선택한 파일을 표시하고 있어요.</p> : null}
          {!showingPublished && state.form.homeStyle.heroLayout === "image-only" ? <p className={styles.previewNote}>이미지만 배치해도 제목은 스크린리더용으로 유지됩니다.</p> : null}
          {showingPublished && hasPublished ? (
            <p className={styles.previewNote}>
              게시된 소개: {state.publishedPageFields.intro || "소개 없음"} · 강조색 {state.publishedPageFields.accent}
              {publishedVisibility.length ? ` · ${publishedVisibility.join(" · ")}` : " · 전체 항목 노출"}
            </p>
          ) : null}
          {!showingPublished && state.publishedAt && publishedChanges.length ? <p className={styles.publishedNote}>게시본과 다른 저장된 변경: {publishedChanges.join(" · ")}</p> : null}
        </section>
      </div>
    </ConsolePage>
  );
}
