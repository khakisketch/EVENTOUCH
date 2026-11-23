"use client";
import ProductButton from "../../../../ui/ProductButton";

import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ValidatedForm from "../../../../ui/ValidatedForm";


import { useCallback, useEffect, useRef, useState } from "react";
import ProductLink from "../../../../ui/ProductLink";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { eventStageLabel } from "../../../../event-stage";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import uiStyles from "../../../console-ui/console-ui.module.css";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import StageTransitionConfirmation from "../../../console-ui/StageTransitionConfirmation";
import StatusPill from "../../../console-ui/StatusPill";
import SettingsToc from "./SettingsToc";
import styles from "./settings.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsSettingsCommand, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import { readCloseReturn, readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";
import { useEventCloseHandoff } from "../../../use-event-close-handoff";
import { isRecoveryBlocked, useVerificationMode } from "../../../../../lib/use-verification-mode";
import { publicRecoveryContact } from "../../../../../lib/public-recovery-contact";
import { parsePublishedRegisterFields, type PublishedField } from "../../../../event/[slug]/register/register-data";

// Mirrors server/commands/preparation.js FEATURES. A toggle that the server
// does not accept would fail on save, so the list is deliberate.
const FEATURES: Array<{ id: string; label: string }> = [
  { id: "poll", label: "투표" },
  { id: "quiz", label: "퀴즈" },
  { id: "qa", label: "Q&A" },
  { id: "draw", label: "추첨" },
  { id: "survey", label: "만족도" },
  { id: "stamp", label: "스탬프(부스)" },
  { id: "photo", label: "사진" },
  { id: "board", label: "게시판" },
  { id: "venue", label: "장소 안내" },
  { id: "screen", label: "행사장 출력" },
  { id: "reward", label: "경품" },
];

// Payment is deliberately absent: this product is an event-agency console and
// never collects money (user decision 2026-10-19). The server keeps the
// feature id for API compatibility, but the screen offers no way to enable it.
const FEATURE_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: "참여 콘텐츠", ids: ["poll", "quiz", "qa", "draw", "survey", "stamp"] },
  { label: "안내·기록", ids: ["photo", "board", "venue", "screen"] },
  { label: "경품", ids: ["reward"] },
];

const STAGE_ORDER = ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"];

// Attendee page editing lives only in /console/events/:id/page (ThemeWorkspace),
// which guards saves with expectedDraftVersion. Settings keeps a read-only
// status link so the two editors can never silently overwrite each other.

type Basics = {
  name: string;
  slug: string;
  clientId: string;
  date: string;
  start: string;
  end: string;
  capacity: string;
  price: string;
  // Display-only progress shape: '' means unspecified (absent key), never an
  // invented default. Submitted verbatim; the server keeps '' semantics.
  format: string;
  approvalRequired: boolean;
  allowReentry: boolean;
  verificationRequired: boolean;
};
type Ready = {
  kind: "ready";
  closeSnapshot: CloseSnapshot;
  stage: string;
  eventMeta?: string;
  clientName: string;
  venueName: string;
  recoveryContact: string;
  clients: Array<{ id: string; name: string }>;
  role: string;
  userId: string;
  memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
  deskCount: number;
  deskAssignmentCount: number;
  openModules: number;
  basics: Basics;
  features: string[];
  registrationOpen: boolean;
  formVersion: number;
  publishedVersion: number;
  consentText: string;
  consentVersion: number;
  // 신청 항목 미리보기용. 같은 bootstrap 응답의 workspace.fields에서 읽으며,
  // 새 API를 쓰지 않는다. 편집은 신청 항목 페이지가 맡는다.
  fields: Array<{ label: string; required: boolean; type: string }>;
  publishedFields: PublishedField[] | null;
  pageDraftVersion: number;
  pagePublishedVersion: number;
  pagePublishedAt: string;
};
type State = { kind: "loading" } | { kind: "failed"; message: string } | Ready;
type LatestIntake = {
  formVersion: number;
  publishedVersion: number;
  consentVersion: number;
  consentText: string;
  registrationOpen: boolean;
  fields: Array<{ label: string; required: boolean; type: string; options: string[] }>;
  publishedFields: PublishedField[] | null;
};
type IntakeConflict = { latest: LatestIntake | null; loading: boolean; error: string | null };
type BasicsConflict = { latest: Basics | null; loading: boolean; error: string | null };
type FeaturesConflict = { latest: string[] | null; loading: boolean; error: string | null };

const BASIC_COMPARISON_FIELDS: Array<{ key: keyof Basics; label: string }> = [
  { key: "name", label: "행사명" }, { key: "slug", label: "주소" }, { key: "clientId", label: "고객사" },
  { key: "date", label: "날짜" }, { key: "start", label: "시작" }, { key: "end", label: "종료" },
  { key: "capacity", label: "정원" },
  { key: "approvalRequired", label: "참가 승인" }, { key: "allowReentry", label: "재입장" },
  { key: "verificationRequired", label: "본인 확인" },
];
// The screen no longer edits 참가비 or 진행 형태 (2026-11-15): the price only
// matters with the payment feature this product never offers, and the format
// is display-only metadata shown nowhere. Stored values are preserved verbatim
// in saves and conflict baselines; they just have no inputs.

function basicComparisonValue(key: keyof Basics, values: Basics, clients: Ready["clients"]): string {
  switch (key) {
    case "clientId": return clients.find((client) => client.id === values.clientId)?.name || values.clientId || "미지정";
    case "capacity": return values.capacity === "0" ? "제한 없음" : values.capacity || "미지정";
    case "approvalRequired": return values.approvalRequired ? "필요" : "불필요";
    case "allowReentry": return values.allowReentry ? "허용" : "불허";
    case "verificationRequired": return values.verificationRequired ? "필요" : "불필요";
    default: return String(values[key] || "미지정");
  }
}

function sameFeatures(left: string[], right: string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((item) => b.has(item));
}

const CAPACITY_MAX = 10_000_000;

/**
 * 정원 to send, or null when the box cannot be saved: empty, text, negative, fractional or
 * absurdly large (0 means 제한 없음, never a stand-in for a bad entry). A value the operator
 * did not touch is sent as it was stored, so an older record with an odd stored capacity
 * does not block unrelated edits.
 */
function capacityToSave(draft: string, saved: string): number | null {
  if (draft === saved) return Number(draft) || 0;
  const value = draft.trim();
  if (!/^\d{1,8}$/.test(value)) return null;
  const parsed = Number(value);
  return parsed <= CAPACITY_MAX ? parsed : null;
}

const CAPACITY_MESSAGE = "정원은 0 이상 1천만 이하의 숫자로 입력해 주세요. 제한이 없으면 0을 입력합니다.";

/** The event.basics.save payload; both save paths (direct and slug-confirm) build it here. */
function basicsSavePayload(basics: Basics, saved: Basics, capacity: number) {
  return {
    name: basics.name,
    slug: basics.slug,
    clientId: basics.clientId,
    date: basics.date,
    start: basics.start,
    end: basics.end,
    capacity,
    // price/format은 화면에서 고치지 않지만 저장값은 그대로 유지한다.
    price: Number(basics.price) || 0,
    format: basics.format,
    approvalRequired: basics.approvalRequired,
    allowReentry: basics.allowReentry,
    verificationRequired: basics.verificationRequired,
    expectedBasics: basicsPayload(saved),
  };
}

function basicsPayload(basics: Basics) {
  return { ...basics, capacity: Number(basics.capacity) || 0, price: Number(basics.price) || 0 };
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// Deterministic payload serialization so a retry of the same command sends
// the same idempotency fingerprint regardless of key insertion order.
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const source = value as Record<string, unknown>;
  return `{${Object.keys(source)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(source[key])}`)
    .join(",")}}`;
}

// Timeouts, temporary limits and 5xx leave the outcome unknown: the server may have applied the
// command before the response was lost. A missing or unparsable body is
// equally ambiguous. Definitive 4xx responses (validation, conflicts, auth)
// mean the command did not apply, so a corrected retry needs a fresh id.
function isAmbiguousFailure(status: number, body: unknown): boolean {
  return [408, 425, 429].includes(status) || status >= 500 || body === null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finiteNumber(value: unknown): boolean {
  return (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) && Number.isFinite(Number(value));
}

function formatPublishedAt(value: string): string {
  if (!value) return "";
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return value.slice(0, 10);
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(time));
}

function formatClockNow(): string {
  return new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date());
}

type SettingsSectionId = "basics" | "intake" | "features";
const SETTINGS_COMMANDS = new Set(["event.update", "event.basics.save", "event.features", "form.publish", "form.close", "event.stage", "field.save", "field.move", "field.delete"]);
const SETTINGS_COMMAND_LABEL: Record<string, string> = {
  "event.update": "기본 정보 저장", "event.basics.save": "기본 정보 저장", "event.features": "운영 기능 저장", "form.publish": "양식 게시",
  "form.close": "접수 닫기", "event.stage": "행사 단계 전환",
};
type SettingsAttempt = {
  eventId: string;
  command: string;
  payload: Record<string, unknown>;
  successMessage: string;
  section: SettingsSectionId | "stage";
  commandId: string;
  fingerprint: string;
};

function isBasicsCommand(command: string): boolean { return command === "event.update" || command === "event.basics.save"; }

function postponesEvent(attempt: SettingsAttempt): boolean {
  if (!isBasicsCommand(attempt.command)) return false;
  const baseline = attempt.payload.expectedBasics;
  const oldDate = baseline && typeof baseline === "object" && !Array.isArray(baseline)
    ? (baseline as Record<string, unknown>).date : null;
  const date = attempt.payload.date;
  return typeof date === "string" && typeof oldDate === "string" && date > oldDate;
}

function changesEventSchedule(attempt: SettingsAttempt): boolean {
  if (!isBasicsCommand(attempt.command)) return false;
  const baseline = attempt.payload.expectedBasics;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) return false;
  const previous = baseline as Record<string, unknown>;
  return ["date", "start", "end"].some((key) =>
    typeof previous[key] === "string" && typeof attempt.payload[key] === "string" && previous[key] !== attempt.payload[key]);
}

type SectionStatus = {
  kind: "success" | "error";
  message: string;
  at: string;
  /** Monotonic: `at` has minute resolution, so it cannot tell which of two same-minute results came last. */
  order: number;
};

// Reopened 2026-11-20: the footer shows the most recent section result. Comparing only the minute-resolution clock
// let an earlier 운영 기능 저장 outrank a 기본 정보 저장 made seconds later (its drawer closes, so the footer is the only
// place that confirms it). Every status takes the next order number instead.
let sectionStatusOrder = 0;
function stampNow(): Pick<SectionStatus, "at" | "order"> {
  sectionStatusOrder += 1;
  return { at: formatClockNow(), order: sectionStatusOrder };
}

const SETTINGS_SECTION_LABEL: Record<SettingsSectionId, string> = {
  basics: "기본 정보",
  intake: "참가 접수",
  features: "운영 기능",
};

// 한 장의 작업 판. 탭은 없애고 네 구역(기본 정보·참가 접수·운영 기능·진행
// 단계)이 세로로 이어진다. 기본 정보만 드로어에서 고친다. 앵커
// id(settings-*)는 기존 딥링크와 closeStep 복귀 흐름이 그대로 쓰므로 바꾸지
// 않는다: #settings-basics는 드로어를 열고, 나머지는 해당 구역으로 스크롤한다.
type SettingsAnchorId = "basics" | "intake" | "features" | "stage";

const SECTION_ANCHORS: Record<SettingsAnchorId, string> = {
  basics: "settings-basics",
  intake: "settings-intake",
  features: "settings-features",
  stage: "settings-stage",
};

function sectionFromHash(hash: string): SettingsAnchorId | null {
  const key = hash.startsWith("#") ? hash.slice(1) : hash;
  return (Object.keys(SECTION_ANCHORS) as SettingsAnchorId[]).find((id) => SECTION_ANCHORS[id] === key) ?? null;
}

function buildEventMeta(clientName: string, basics: Basics, venueName: string): string | undefined {
  return formatConsoleEventMeta({
    clientName,
    date: basics.date,
    start: basics.start,
    end: basics.end,
    venue: venueName,
  });
}

export default function SettingsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const verificationMode = useVerificationMode();
  const closeHref = useEventCloseHandoff(eventId);
  const closeLandingRef = useRef<string | null>(null);
  // 선형 마감 "다음" 인계로 예약된 제목 포커스. 렌더 뒤 효과에서 소비한다.
  const pendingHeadingFocusRef = useRef<SettingsAnchorId | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [refreshingAfterWrite, setRefreshingAfterWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);
  // 저장 실패가 어느 구역의 입력인지 기억해 두었다가, 배너 다음에 해당
  // 구역으로 스크롤한다. 기본 정보 필드면 드로어를 연다(SSR 불일치 방지를
  // 위해 DOM 조회는 effect에서 계산).
  const [failureSection, setFailureSection] = useState<SettingsAnchorId | null>(null);
  useEffect(() => {
    if (!failure?.field || failure.field === "serverUnsupported") { setFailureSection(null); return; }
    if (failure.field === "consentText") { setFailureSection("intake"); return; }
    const section = document.getElementById(failure.field)?.closest("[data-settings-section]");
    const anchor = section?.id.replace(/^panel-/, "");
    setFailureSection(
      (Object.keys(SECTION_ANCHORS) as SettingsAnchorId[]).find((id) => SECTION_ANCHORS[id] === anchor) ?? "basics"
    );
  }, [failure]);
  // 기본 정보는 드로어에서 고친다. 접힌 행이 아니라 별도 편집면이므로,
  // 폼 상태는 컴포넌트에 두고 드로어는 열림만 토글한다.
  const [basicsOpen, setBasicsOpen] = useState(false);
  // Failure paths move focus to an element that only exists once the state change they make has committed (a drawer
  // opened, a conflict panel shown). A requestAnimationFrame can fire before that commit, so ask for the focus and
  // apply it in an effect after the render; give up after a few renders if the target never appears.
  const focusAfterCommitRef = useRef<{ id: string; tries: number } | null>(null);
  function requestFocusAfterCommit(id: string) {
    focusAfterCommitRef.current = { id, tries: 0 };
  }
  useEffect(() => {
    const pending = focusAfterCommitRef.current;
    if (!pending) return;
    const target = document.getElementById(pending.id);
    if (target) { focusAfterCommitRef.current = null; target.focus(); return; }
    pending.tries += 1;
    if (pending.tries > 3) focusAfterCommitRef.current = null;
  });
  // 공개된 행사의 주소 코드를 바꿔 저장할 때 한 번 더 묻는다.
  const [slugConfirm, setSlugConfirm] = useState(false);
  // 딥링크 도착 구역을 잠깐 강조한다.
  const [highlight, setHighlight] = useState<SettingsAnchorId | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  function flashSection(section: SettingsAnchorId) {
    setHighlight(section);
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = window.setTimeout(() => setHighlight(null), 1600);
  }
  useEffect(() => () => { if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current); }, []);
  const [notice, setNotice] = useState<string | null>(null);
  const [showTicketReview, setShowTicketReview] = useState(false);
  const [showScheduleReview, setShowScheduleReview] = useState(false);
  // Per-section save state shown in place ("기본 정보를 저장했습니다 · HH:MM").
  // The page-top ConsoleFeedback strip is kept for the latest page-level
  // result; these lines persist per section with a timestamp instead of
  // adding another global banner.
  const [basicsStatus, setBasicsStatus] = useState<SectionStatus | null>(null);
  const [intakeStatus, setIntakeStatus] = useState<SectionStatus | null>(null);
  const [featuresStatus, setFeaturesStatus] = useState<SectionStatus | null>(null);
  // 구역으로 스크롤하고 잠깐 강조한다. 기본 정보는 드로어가 편집면이므로
  // 스크롤 대신 드로어를 연다.
  const scrollToSection = useCallback((section: SettingsAnchorId) => {
    if (section === "basics") { setBasicsOpen(true); return; }
    const element = document.getElementById(SECTION_ANCHORS[section]);
    if (element) {
      element.scrollIntoView({ block: "start" });
      flashSection(section);
    }
  }, []);

  // 저장 실패가 가리킨 구역으로 이동한다. consentText는 접수 구역으로,
  // 기본 정보 필드는 드로어로.
  useEffect(() => {
    if (!failureSection) return;
    if (failureSection === "basics") { setBasicsOpen(true); return; }
    scrollToSection(failureSection);
  }, [failureSection, scrollToSection]);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageConfirm, setStageConfirm] = useState(false);
  const [closeIntakeConfirm, setCloseIntakeConfirm] = useState(false);
  const [archiveRecheckRequired, setArchiveRecheckRequired] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  const stageCommandIdRef = useRef<string | null>(null);
  // Synchronous in-flight guard shared by runCommand and stage transitions.
  // React state alone can allow same-turn double submits before the rerender
  // flips `busy`/`stageBusy`; the ref closes that gap for both paths.
  const operationsBusyRef = useRef(false);
  // One idempotency id per command+payload fingerprint. Ambiguous failures
  // keep the id so a retry replays the server receipt instead of applying
  // the command twice; success and definitive 4xx responses clear it.
  const commandIdCache = useRef(new Map<string, string>());
  const [pendingSettings, setPendingSettings] = useState<SettingsAttempt | null>(null);
  const [intakeConflict, setIntakeConflict] = useState<IntakeConflict | null>(null);
  const intakeConflictRef = useRef<IntakeConflict | null>(null);
  const intakeReadRef = useRef<AbortController | null>(null);
  const [basicsConflict, setBasicsConflict] = useState<BasicsConflict | null>(null);
  const basicsConflictRef = useRef<BasicsConflict | null>(null);
  const basicsReadRef = useRef<AbortController | null>(null);
  const [featuresConflict, setFeaturesConflict] = useState<FeaturesConflict | null>(null);
  const featuresConflictRef = useRef<FeaturesConflict | null>(null);
  const featuresReadRef = useRef<AbortController | null>(null);
  const pendingSettingsRef = useRef<SettingsAttempt | null>(null);
  const [checkingSettings, setCheckingSettings] = useState(false);
  const [settingsRecoveryError, setSettingsRecoveryError] = useState<string | null>(null);
  const [abandonSettingsConfirm, setAbandonSettingsConfirm] = useState(false);
  const eventReceipts = useEventReceipts(eventId);
  const otherSettingsReceipt = eventReceipts.some((entry) => SETTINGS_COMMANDS.has(entry.command) &&
    entry.commandId !== pendingSettings?.commandId && ![...commandIdCache.current.values()].includes(entry.commandId));
  const activeSettingsEventRef = useRef(eventId);
  const loadedSettingsEventRef = useRef<string | null>(null);
  const settledSectionRef = useRef<SettingsSectionId | null>(null);
  activeSettingsEventRef.current = eventId;
  useEffect(() => pendingSettings && state.kind === "ready" ? manageOperatorReceipt(pendingSettings.commandId) : undefined, [pendingSettings, state.kind]);
  const previousSettingsEventRef = useRef(eventId);
  useEffect(() => {
    if (previousSettingsEventRef.current === eventId) return;
    previousSettingsEventRef.current = eventId;
    loadedSettingsEventRef.current = null;
    settledSectionRef.current = null;
    liveRef.current = { state: { kind: "loading" }, basics: null, features: null, consentText: "", fields: null };
    setState({ kind: "loading" });
    setBasics(null);
    setFeatures(null);
    setConsentText("");
    setFailure(null);
    setNotice(null);
    setShowTicketReview(false);
    setShowScheduleReview(false);
    setBasicsStatus(null);
    setIntakeStatus(null);
    setFeaturesStatus(null);
    setStageConfirm(false);
    setArchiveRecheckRequired(false);
    setStageError(null);
    setStageNotice(null);
    setBasicsOpen(false);
    setSlugConfirm(false);
    setHighlight(null);
    hadOtherSettingsReceiptRef.current = false;
    pendingSettingsRef.current = null;
    setPendingSettings(null);
    intakeReadRef.current?.abort();
    intakeConflictRef.current = null;
    setIntakeConflict(null);
    basicsReadRef.current?.abort();
    basicsConflictRef.current = null;
    setBasicsConflict(null);
    featuresReadRef.current?.abort();
    featuresConflictRef.current = null;
    setFeaturesConflict(null);
    setSettingsRecoveryError(null);
    setAbandonSettingsConfirm(false);
    commandIdCache.current.clear();
    stageCommandIdRef.current = null;
    operationsBusyRef.current = false;
    setBusy(false);
    setStageBusy(false);
    setCheckingSettings(false);
    setRefreshingAfterWrite(false);
  }, [eventId]);
  useEffect(() => () => { intakeReadRef.current?.abort(); basicsReadRef.current?.abort(); featuresReadRef.current?.abort(); }, []);
  const hadOtherSettingsReceiptRef = useRef(false);
  useEffect(() => {
    if (hadOtherSettingsReceiptRef.current && !otherSettingsReceipt && !pendingSettings) {
      setRefreshingAfterWrite(true);
      setReloadTick((tick) => tick + 1);
      window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
    }
    hadOtherSettingsReceiptRef.current = otherSettingsReceipt;
  }, [otherSettingsReceipt, pendingSettings]);
  useEffect(() => {
    if (!pendingSettings) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.getElementById("settings-recovery-heading");
      heading?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingSettings]);
  // Live mirrors of the independently dirty sections and their server
  // baselines. A reload after saving one section (or after a stage
  // transition) only overwrites the sections the operator has not edited,
  // so unrelated form values survive the refresh.
  const liveRef = useRef<{
    state: State;
    basics: Basics | null;
    features: string[] | null;
    consentText: string;
    fields: Array<{ label: string; required: boolean; type: string }> | null;
  }>({ state: { kind: "loading" }, basics: null, features: null, consentText: "", fields: null });

  const [basics, setBasics] = useState<Basics | null>(null);
  const [features, setFeatures] = useState<string[] | null>(null);
  const [consentText, setConsentText] = useState("");

  useEffect(() => {
    if (loadedSettingsEventRef.current === eventId) liveRef.current = { state, basics, features, consentText, fields: state.kind === "ready" ? state.fields : null };
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const loadFailed = (message: string) => {
        if (loadedSettingsEventRef.current === eventId && liveRef.current.state.kind === "ready") {
          setFailure({ message: `${message} 작성 중인 내용은 유지됩니다.` });
        } else setState({ kind: "failed", message });
      };
      try {
        // The actor comes from the session (/api/auth/me), not from the
        // account directory: gating on "any manager exists" projected the
        // wrong permission onto signed-in staff. This mirrors the current
        // server role+membership semantics; the server stays authoritative.
        const [meRes, bootRes, dirRes] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store" }),
          consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
          consoleFetch("/api/console/directory", { cache: "no-store" }),
        ]);
        if (cancelled || activeSettingsEventRef.current !== eventId) return;
        if (meRes.status === 401 || bootRes.status === 401) {
          if (loadedSettingsEventRef.current === eventId && liveRef.current.state.kind === "ready") {
            loadFailed("최신 설정을 불러오지 못했습니다. 로그인과 접근 권한을 확인하세요.");
            return;
          }
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const meData = (await meRes.json().catch(() => null)) as unknown;
        const user = record(record(meData)?.user);
        const bootData = (await bootRes.json().catch(() => null)) as {
          state?: {
            events?: unknown;
            clients?: unknown;
            memberships?: unknown;
            workspaces?: Record<string, {
              venue?: unknown;
              features?: unknown;
              price?: unknown;
              approvalRequired?: unknown;
              allowReentry?: unknown;
              verificationRequired?: unknown;
              registrationOpen?: unknown;
              formVersion?: unknown;
              publishedVersion?: unknown;
              consentText?: unknown;
              consentVersion?: unknown;
              // 신청 항목 미리보기용. 편집은 신청 항목 페이지가 맡는다.
              fields?: unknown;
              publishedFields?: unknown;
              pageExperience?: unknown;
              desks?: unknown;
              assignments?: unknown;
              modules?: unknown;
            }>;
          } | null;
        } | null;
        const bootstrap = bootData?.state;
        // The 고객사 selector needs the org-level list, which the scoped
        // event bootstrap does not carry: the directory provides it with the
        // same per-role visibility the full bootstrap had (AGENCY all,
        // MANAGER own events' clients). Scoped data stays the fallback.
        const dirData = (await dirRes.json().catch(() => null)) as {
          directory?: { clients?: unknown } | null;
        } | null;
        if (cancelled || activeSettingsEventRef.current !== eventId) return;
        const dirClients = Array.isArray(dirData?.directory?.clients)
          ? (dirData as { directory: { clients: unknown[] } }).directory.clients
              .map(record)
              .filter((item): item is Record<string, unknown> => item !== null)
          : [];
        if (!meRes.ok || !bootRes.ok || !user || !bootstrap) {
          loadFailed("행사 설정을 불러오지 못했습니다.");
          return;
        }
        const event = Array.isArray(bootstrap.events)
          ? bootstrap.events.find(
              (item): item is Record<string, unknown> =>
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>).id === eventId
            )
          : undefined;
        const workspace = bootstrap.workspaces?.[eventId];
        if (!event || !workspace) {
          loadFailed("행사를 찾을 수 없습니다.");
          return;
        }
        if (!Array.isArray(event.features) || event.features.some((feature) => typeof feature !== "string")) {
          loadFailed("운영 기능을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도하세요.");
          return;
        }
        const clients = (dirClients.length ? dirClients : Array.isArray(bootstrap.clients)
          ? bootstrap.clients.map(record).filter((item): item is Record<string, unknown> => item !== null)
          : []);
        const clientName = text(clients.find((client) => client.id === event.clientId)?.name);
        const venue = record(workspace.venue);
        const venueName = text(venue?.name);
        const role = text(user.role);
        const myId = text(user.id);
        const memberships = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((value) => {
              const item = record(value);
              if (!item || typeof item.accountId !== "string" || typeof item.eventId !== "string") return [];
              return [{ accountId: item.accountId, eventId: item.eventId, write: item.write }];
            })
          : [];
        // Display gates only, per server/event-permissions.js: 행사 정보·기능·
        // 단계는 settings (event.*), 접수 게시·마감은 participants (form.*).
        // The server still authorizes every settings command.
        const desks = Array.isArray(workspace.desks) ? workspace.desks : [];
        const assignments = Array.isArray(workspace.assignments) ? workspace.assignments : [];
        const modules = Array.isArray(workspace.modules) ? workspace.modules : [];
        const deskAssignmentCount = assignments.filter((item) => record(item)?.type === "DESK").length;
        const openModules = modules.filter((item) => text(record(item)?.status).toUpperCase() === "OPEN").length;
        const pageExperience = typeof workspace.pageExperience === "object" && workspace.pageExperience !== null
          ? (workspace.pageExperience as Record<string, unknown>)
          : {};
        const newBasics: Basics = {
          name: text(event.name),
          slug: text(event.slug),
          clientId: text(event.clientId),
          date: text(event.date),
          start: text(event.start) || "09:00",
          end: text(event.end) || "18:00",
          capacity: String(Number(event.capacity) || 0),
          price: String(Number(workspace.price) || 0),
          format: ["offline", "online", "hybrid"].includes(text(event.format)) ? text(event.format) : "",
          approvalRequired: workspace.approvalRequired === true,
          allowReentry: workspace.allowReentry !== false,
          verificationRequired: workspace.verificationRequired === true,
        };
        const newFeatures = Array.isArray(event.features)
          ? event.features.filter((feature): feature is string => typeof feature === "string")
          : [];
        const newConsentText = text(workspace.consentText);
        const pageDraftVersion = Number.isSafeInteger(pageExperience.draftVersion)
          ? Number(pageExperience.draftVersion)
          : 0;
        const pagePublishedVersion = Number.isSafeInteger(pageExperience.publishedVersion)
          ? Number(pageExperience.publishedVersion)
          : 0;
        const live = liveRef.current;
        const previous = live.state.kind === "ready" ? live.state : null;
        const settledSection = settledSectionRef.current;
        const preserveBasics = Boolean(previous && live.basics && (basicsConflictRef.current ||
          (settledSection !== "basics" && JSON.stringify(live.basics) !== JSON.stringify(previous.basics))));
        const preserveFeatures = Boolean(previous && live.features && (featuresConflictRef.current ||
          (settledSection !== "features" && !sameFeatures(live.features, previous.features))));
        // Unrelated refreshes must not silently mark changed application
        // fields as reviewed, even if the consent editor itself was clean.
        const preserveIntake = Boolean(previous && (intakeConflictRef.current || settledSection !== "intake"));
        // 신청 항목 미리보기. 편집이 아니라 읽기 전용 요약이므로 관대하게
        // 읽는다(배열이 아니면 빈 목록).
        const loadedFields = Array.isArray(workspace.fields)
          ? workspace.fields.map(record).filter((item): item is Record<string, unknown> => item !== null)
            .filter((item) => typeof item.label === "string")
            .map((item) => ({ label: text(item.label), required: item.required === true, type: text(item.type) }))
          : [];
        loadedSettingsEventRef.current = eventId;
        setArchiveRecheckRequired(false);
        setState({
          kind: "ready",
          closeSnapshot: readCloseSnapshot(event, workspace),
          stage: text(event.stage).toUpperCase(),
          eventMeta: buildEventMeta(clientName, newBasics, venueName),
          clientName,
          venueName,
          recoveryContact: publicRecoveryContact(workspace, newFeatures),
          clients: clients
            .map((client) => ({ id: text(client.id), name: text(client.name) }))
            .filter((client) => client.id !== ""),
          role,
          userId: myId,
          memberships,
          deskCount: desks.length,
          deskAssignmentCount,
          openModules,
          // A dirty editor and its concurrency baseline are inseparable. A
          // refresh caused by another section must not make stale edits look
          // as if they were authored against a newer server value.
          basics: preserveBasics && previous ? previous.basics : newBasics,
          features: preserveFeatures && previous ? previous.features : newFeatures,
          registrationOpen: workspace.registrationOpen === true,
          formVersion: preserveIntake && previous ? previous.formVersion : Number(workspace.formVersion) || 0,
          publishedVersion: Number(workspace.publishedVersion) || 0,
          consentText: preserveIntake && previous ? previous.consentText : newConsentText,
          consentVersion: preserveIntake && previous ? previous.consentVersion : Number(workspace.consentVersion) || 1,
          fields: preserveIntake && previous ? previous.fields : loadedFields,
          publishedFields: parsePublishedRegisterFields(workspace.publishedFields, "workspace"),
          pageDraftVersion,
          pagePublishedVersion,
          pagePublishedAt: text(pageExperience.publishedAt),
        });
        // Preserve independent dirty sections: a local form that differs from
        // its previous server baseline keeps the operator's edits; a clean
        // form takes the fresh server values.
        settledSectionRef.current = null;
        setBasics(
          preserveBasics && live.basics
            ? live.basics
            : newBasics
        );
        setFeatures(
          preserveFeatures && live.features
            ? live.features
            : newFeatures
        );
        setConsentText(
          preserveIntake ? live.consentText : newConsentText
        );
        if (intakeConflictRef.current) {
          const conflict = { latest: null, loading: false, error: null };
          intakeReadRef.current?.abort();
          intakeReadRef.current = null;
          intakeConflictRef.current = conflict;
          setIntakeConflict(conflict);
        }
        if (basicsConflictRef.current) {
          const conflict = { latest: null, loading: false, error: null };
          basicsReadRef.current?.abort();
          basicsReadRef.current = null;
          basicsConflictRef.current = conflict;
          setBasicsConflict(conflict);
        }
        if (featuresConflictRef.current) {
          const conflict = { latest: null, loading: false, error: null };
          featuresReadRef.current?.abort();
          featuresReadRef.current = null;
          featuresConflictRef.current = conflict;
          setFeaturesConflict(conflict);
        }
      } catch {
        if (!cancelled && activeSettingsEventRef.current === eventId) {
          loadFailed("연결하지 못했습니다. 다시 시도하세요.");
        }
      } finally {
        if (!cancelled && activeSettingsEventRef.current === eventId) setRefreshingAfterWrite(false);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [eventId, router, reloadTick]);

  // Draft-guard dirty state, evaluated before every early return below. True
  // diffs of the independently dirty sections against their server baselines
  // (not mere input focus), plus pending ambiguous intent kept in the
  // command refs. Clean post-save screens navigate without a confirm.
  const basicsDirty =
    state.kind === "ready" &&
    basics !== null &&
    JSON.stringify(basics) !== JSON.stringify(state.basics);
  const intakeDirty =
    state.kind === "ready" && consentText !== state.consentText;
  const featuresDirty =
    state.kind === "ready" &&
    features !== null &&
    !sameFeatures(features, state.features);
  const sectionsDirty = Boolean(basicsDirty || intakeDirty || featuresDirty);
  const pendingIntent =
    pendingSettings !== null || otherSettingsReceipt || stageCommandIdRef.current !== null || commandIdCache.current.size > 0;
  const unresolvedConflict = Boolean(intakeConflict || basicsConflict || featuresConflict);
  // The existing draft-guard passage, improved to name the sections that
  // still hold unsaved edits so the operator knows where to go back to.
  const dirtySectionNames: string[] = [
    basicsDirty ? SETTINGS_SECTION_LABEL.basics : null,
    intakeDirty ? SETTINGS_SECTION_LABEL.intake : null,
    featuresDirty ? SETTINGS_SECTION_LABEL.features : null,
  ].filter((name): name is string => name !== null);
  const guardReason = dirtySectionNames.length > 0
    ? `저장하지 않은 행사 설정 변경(${dirtySectionNames.join(" · ")})이 있습니다. 페이지를 떠나면 사라집니다.${
        pendingIntent ? " 응답을 확인하지 못한 요청도 있습니다." : ""
      }`
    : pendingIntent
      ? "응답을 확인하지 못한 요청이 있습니다. 페이지를 떠나기 전에 처리 결과를 확인하세요."
      : "변경된 최신 설정을 아직 확인하지 않았습니다. 페이지를 떠나면 현재 화면의 작성 내용이 사라질 수 있습니다.";
  useConsoleDraftGuard(
    sectionsDirty || pendingIntent || unresolvedConflict,
    guardReason
  );

  // 해시→구역 동기화. 딥링크·뒤로/앞으로·closeStep 복귀가 같은 앵커를
  // 쓴다. #settings-basics는 기본 정보 드로어를 열고, 나머지는 해당 구역으로
  // 스크롤하며 잠깐 강조한다. 포커스는 closeStep 복귀와 선형 마감 "다음"
  // 인계 때만 구역 제목으로 옮기고, 그 외에는 포커스를 빼앗지 않는다.
  useEffect(() => {
    if (state.kind !== "ready") {
      if (state.kind === "failed") closeLandingRef.current = null;
      return;
    }
    const applyHash = () => {
      const section = sectionFromHash(window.location.hash);
      if (!section) return;
      if (section === "basics") { setBasicsOpen(true); return; }
      scrollToSection(section);
    };
    applyHash();
    const anchor = window.location.hash;
    const returnHref = readCloseReturn(new URLSearchParams(window.location.search).get("closeReturn"), eventId);
    let frame = 0;
    if (returnHref && anchor && anchor !== "#settings-basics" && sectionFromHash(anchor)) {
      const key = `${eventId}:${returnHref}`;
      if (closeLandingRef.current !== key) {
        closeLandingRef.current = key;
        frame = requestAnimationFrame(() => {
          const heading = document.getElementById(anchor.slice(1));
          heading?.setAttribute("tabindex", "-1");
          heading?.scrollIntoView({ block: "start" });
          heading?.focus({ preventScroll: true });
        });
      }
    }
    window.addEventListener("hashchange", applyHash);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", applyHash);
    };
  }, [state, eventId, scrollToSection]);

  // 선형 마감 "다음" 인계의 제목 포커스. 캡처 리스너가 "다음" 활성화
  // 순간에만 예약하며, 뒤로/앞으로·일반 딥링크에서는 예약되지 않으므로
  // 포커스를 유지한다.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const pending = pendingHeadingFocusRef.current;
    pendingHeadingFocusRef.current = null;
    if (!pending) return;
    const heading = document.getElementById(SECTION_ANCHORS[pending]);
    if (!heading) return;
    heading.setAttribute("tabindex", "-1");
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [state]);

  // 선형 마감 "다음" 활성화 의도의 캡처. 공유 EventCloseReturn의 핸들러와
  // 네이티브 앵커 기본 동작보다 먼저 실행되므로, 해시 변경 때 이미 body로
  // 돌아간 activeElement를 읽는 방식과 달리 의도를 놓치지 않는다. 키보드
  // Enter의 네이티브 클릭도 여기로 들어온다. 같은 해시는 상태 변경·효과를
  // 일으키지 않아 표시가 남고, 나중의 무관한 저장 후 재렌더에서 포커스를
  // 훔칠 수 있으므로 예약하지 않는다.
  useEffect(() => {
    const onCaptureClick = (event: MouseEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest?.("a[data-close-linear-next]");
      if (!link) return;
      let hash = "";
      try {
        hash = new URL(link.getAttribute("href") ?? "", window.location.href).hash;
      } catch {
        return;
      }
      if (window.location.hash === hash) return;
      const section = sectionFromHash(hash);
      if (!section) return;
      if (!readCloseReturn(new URLSearchParams(window.location.search).get("closeReturn"), eventId)) return;
      pendingHeadingFocusRef.current = section;
    };
    document.addEventListener("click", onCaptureClick, true);
    return () => document.removeEventListener("click", onCaptureClick, true);
  }, [eventId]);

  // A success status alone is not enough: compare the returned entity to the
  // original request before accepting it or removing its recovery pointer.
  function isProvenResponse(command: string, data: Record<string, unknown>, payload: Record<string, unknown>): boolean {
    return confirmsSettingsCommand(command, eventId, payload, data);
  }

  function sectionStatusSetter(section: SettingsSectionId) {
    return section === "basics" ? setBasicsStatus : section === "intake" ? setIntakeStatus : setFeaturesStatus;
  }

  function finishSettings(attempt: SettingsAttempt, checked: boolean, response?: Record<string, unknown>) {
    commandIdCache.current.delete(attempt.fingerprint);
    acknowledgeOperatorReceipt(attempt.commandId);
    forgetOperatorReceipt(attempt.commandId);
    pendingSettingsRef.current = null;
    setPendingSettings(null);
    setSettingsRecoveryError(null);
    setAbandonSettingsConfirm(false);
    setFailure(null);
    const impact = response?.ticketImpact && typeof response.ticketImpact === "object" && !Array.isArray(response.ticketImpact)
      ? response.ticketImpact as Record<string, unknown> : null;
    const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
    const ticketSummary = isBasicsCommand(attempt.command) && impact && count(impact.extended) && count(impact.review)
      ? ` 유효한 티켓 ${impact.extended}건을 연장했습니다.${impact.review ? ` 만료·철회됐거나 확인이 필요한 티켓 ${impact.review}건은 연장하지 않았습니다.` : ""}` : "";
    setShowTicketReview(Boolean(impact && count(impact.review) && impact.review > 0));
    if (changesEventSchedule(attempt)) setShowScheduleReview(true);
    const message = checked ? "서버에 설정이 반영된 것을 확인했습니다. 최신 내용을 확인하세요." : attempt.successMessage + ticketSummary;
    if (attempt.section === "stage") {
      stageCommandIdRef.current = null;
      setStageError(null);
      setStageConfirm(false);
      setStageNotice(message);
      window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
    } else if (attempt.section === "basics") {
      // 저장 결과가 확정되면 드로어를 닫는다. 성공이면 폼이 최신값을
      // 보여주고, 처리 확인(복구)이 뜨면 그 안내가 보이도록 비킨다. 작성
      // 중 값은 상태에 그대로 있어 다시 열면 이어서 볼 수 있다.
      setBasicsOpen(false);
      setSlugConfirm(false);
      setFailure(null);
      sectionStatusSetter(attempt.section)({ kind: "success", message, ...stampNow() });
    } else {
      setNotice(message);
      sectionStatusSetter(attempt.section)({ kind: "success", message, ...stampNow() });
    }
    // The loader keeps unrelated dirty sections; bootstrap is authoritative
    // for workspace fields the write response does not include.
    settledSectionRef.current = isBasicsCommand(attempt.command) ? "basics" :
      attempt.command === "event.features" ? "features" : attempt.command === "form.publish" ? "intake" : null;
    setRefreshingAfterWrite(true);
    setReloadTick((tick) => tick + 1);
  }

  async function executeSettingsAttempt(attempt: SettingsAttempt, retry = false): Promise<boolean> {
    if (operationsBusyRef.current || busy || stageBusy) return false;
    const held = pendingSettingsRef.current;
    if ((held && (!retry || held.commandId !== attempt.commandId)) || otherSettingsReceipt) {
      setSettingsRecoveryError("이전 설정 요청의 처리 결과를 먼저 확인하세요.");
      return false;
    }
    if (state.kind !== "ready" || archived || attempt.eventId !== eventId ||
        !canWriteEvent({ role: state.role, userId: state.userId, memberships: state.memberships, eventId }, attempt.command)) return false;
    operationsBusyRef.current = true;
    if (attempt.section === "stage") setStageBusy(true); else setBusy(true);
    setFailure(null);
    setNotice(null);
    setStageError(null);
    setSettingsRecoveryError(null);
    commandIdCache.current.set(attempt.fingerprint, attempt.commandId);
    const unconfirmed = () => {
      pendingSettingsRef.current = attempt;
      setPendingSettings(attempt);
      setStageConfirm(false);
      // 기본 정보 저장이 미확정이면 드로어를 닫아 처리 확인(복구) 안내가
      // 보이게 한다. 작성 중 값은 그대로 두어 다시 열면 이어서 본다.
      if (attempt.section === "basics") { setBasicsOpen(false); setSlugConfirm(false); }
      setSettingsRecoveryError("처리 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.");
    };
    try {
      const res = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, command: attempt.command, payload: attempt.payload }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (activeSettingsEventRef.current !== attempt.eventId) return false;
      if (!res.ok || data === null) {
        // These guards run inside the locked publish command, after receipt
        // replay. Even a retry following a lost response is therefore a
        // definitive rejection; a generic 409/403 is not.
        if (attempt.command === "form.publish" && res.status === 409 &&
            ["expectedFormVersion", "expectedConsentVersion", "expectedConsentText"].includes(String(data?.field))) {
          commandIdCache.current.delete(attempt.fingerprint);
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          pendingSettingsRef.current = null;
          setPendingSettings(null);
          setSettingsRecoveryError(null);
          setAbandonSettingsConfirm(false);
          const conflict = { latest: null, loading: false, error: null };
          intakeConflictRef.current = conflict;
          setIntakeConflict(conflict);
          setFailure(null);
          setIntakeStatus(null);
          requestFocusAfterCommit("intake-conflict-heading");
        } else if (isBasicsCommand(attempt.command) && res.status === 409 && data?.code === "EVENT_BASICS_CHANGED") {
          commandIdCache.current.delete(attempt.fingerprint);
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          pendingSettingsRef.current = null;
          setPendingSettings(null);
          setSettingsRecoveryError(null);
          setAbandonSettingsConfirm(false);
          const conflict = { latest: null, loading: false, error: null };
          basicsConflictRef.current = conflict;
          setBasicsConflict(conflict);
          setFailure(null);
          setBasicsStatus(null);
          requestFocusAfterCommit("basics-conflict-heading");
        } else if (attempt.command === "event.features" && res.status === 409 && data?.code === "EVENT_FEATURES_CHANGED") {
          commandIdCache.current.delete(attempt.fingerprint);
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          pendingSettingsRef.current = null;
          setPendingSettings(null);
          setSettingsRecoveryError(null);
          setAbandonSettingsConfirm(false);
          const conflict = { latest: null, loading: false, error: null };
          featuresConflictRef.current = conflict;
          setFeaturesConflict(conflict);
          setFailure(null);
          setFeaturesStatus(null);
          requestFocusAfterCommit("features-conflict-heading");
        } else if (!retry && !res.ok && !isAmbiguousFailure(res.status, data)) {
          commandIdCache.current.delete(attempt.fingerprint);
          const unsupportedServer = attempt.command === "event.basics.save" && res.status === 400 && data?.field === "command";
          const message = unsupportedServer
            ? "현재 서버에서는 행사 정보를 안전하게 저장할 수 없습니다. 관리자에게 서버 업데이트를 요청하세요. 입력한 내용은 유지됩니다."
            : typeof data?.error === "string" ? data.error : "처리하지 못했습니다.";
          if (attempt.section === "stage") {
            stageCommandIdRef.current = null;
            setStageConfirm(false);
            setStageError(message);
            if (data?.code === "ARCHIVE_PRECONDITIONS_UNAVAILABLE") setArchiveRecheckRequired(true);
            setFailure({ message });
          } else {
            setFailure({ message, field: unsupportedServer ? "serverUnsupported" : typeof data?.field === "string" ? data.field : undefined });
            sectionStatusSetter(attempt.section)({ kind: "error", message, ...stampNow() });
            // 한 장에 모든 구역이 보이므로, 실패한 입력으로 직접 포커스를
            // 옮긴다. 기본 정보는 드로어가 편집면이라 먼저 연다.
            if (unsupportedServer) {
              setBasicsOpen(true);
              requestFocusAfterCommit("settings-basics-save");
            }
            if (data?.field === "consentText") {
              requestFocusAfterCommit("set-consent");
            }
          }
        } else {
          // A later rejection cannot settle an earlier lost response.
          unconfirmed();
        }
        return false;
      }
      if (!isProvenResponse(attempt.command, data, attempt.payload)) {
        unconfirmed();
        return false;
      }
      if (postponesEvent(attempt)) {
        const impact = data.ticketImpact;
        const counts = impact && typeof impact === "object" && !Array.isArray(impact) ? impact as Record<string, unknown> : null;
        if (!counts || typeof counts.extended !== "number" || !Number.isSafeInteger(counts.extended) || counts.extended < 0 ||
            typeof counts.review !== "number" || !Number.isSafeInteger(counts.review) || counts.review < 0) {
          unconfirmed();
          setSettingsRecoveryError("행사 날짜는 변경됐을 수 있지만 티켓 연장 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하고 참가자 명단을 살펴보세요.");
          return false;
        }
      }
      finishSettings(attempt, false, data);
      return true;
    } catch (error) {
      if (activeSettingsEventRef.current !== attempt.eventId) return false;
      if (!retry && isOrganizationContextBlock(error)) {
        commandIdCache.current.delete(attempt.fingerprint);
        stageCommandIdRef.current = null;
        setStageConfirm(false);
        setFailure({ message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        unconfirmed();
      }
      return false;
    } finally {
      if (activeSettingsEventRef.current === attempt.eventId) {
        operationsBusyRef.current = false;
        setBusy(false);
        setStageBusy(false);
      }
    }
  }

  async function runCommand(command: string, payload: Record<string, unknown>, successMessage: string, section: SettingsSectionId): Promise<boolean> {
    if (operationsBusyRef.current || pendingSettingsRef.current || otherSettingsReceipt) return false;
    const frozen = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const fingerprint = `${command}:${stableStringify(frozen)}`;
    const commandId = randomCommandId();
    return executeSettingsAttempt({ eventId, command, payload: frozen, successMessage, section, commandId, fingerprint });
  }

  async function checkSettings() {
    const attempt = pendingSettingsRef.current;
    if (!attempt || attempt.eventId !== activeSettingsEventRef.current || operationsBusyRef.current) return;
    operationsBusyRef.current = true;
    setCheckingSettings(true);
    setSettingsRecoveryError(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (activeSettingsEventRef.current !== attempt.eventId) return;
      if (response.ok && data?.status === "APPLIED" && data.command === attempt.command) {
        if (attempt.command === "event.basics.save" || postponesEvent(attempt)) setSettingsRecoveryError("행사 정보 저장은 기록됐습니다. 저장 내용과 티켓 영향을 확인하려면 같은 요청을 다시 시도하세요.");
        else finishSettings(attempt, true);
      } else {
        setSettingsRecoveryError(response.ok && data?.status === "UNCONFIRMED"
          ? "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요."
          : "처리 결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인한 뒤 다시 확인하세요.");
      }
    } catch {
      if (activeSettingsEventRef.current === attempt.eventId) setSettingsRecoveryError("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다.");
    } finally {
      if (activeSettingsEventRef.current === attempt.eventId) {
        operationsBusyRef.current = false;
        setCheckingSettings(false);
      }
    }
  }

  async function retrySettings() {
    const attempt = pendingSettingsRef.current;
    if (!attempt || checkingSettings || attempt.eventId !== activeSettingsEventRef.current) return;
    await executeSettingsAttempt(attempt, true);
  }

  async function readLatestIntake() {
    if (!intakeConflictRef.current || intakeReadRef.current) return;
    const controller = new AbortController();
    intakeReadRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const loading = { latest: null, loading: true, error: null };
    intakeConflictRef.current = loading;
    setIntakeConflict(loading);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const body = record(await response.json());
      const bootstrap = record(body?.state);
      const workspaces = record(bootstrap?.workspaces);
      const workspace = record(workspaces?.[eventId]);
      const events = bootstrap?.events;
      const event = Array.isArray(events) ? events.map(record).find((item) => item?.id === eventId) : null;
      if (!response.ok || !workspace || !event || !Array.isArray(workspace.fields)) throw new Error("invalid response");
      if (![workspace.formVersion, workspace.publishedVersion, workspace.consentVersion].every(finiteNumber) ||
          typeof workspace.consentText !== "string" || typeof workspace.registrationOpen !== "boolean") throw new Error("incomplete response");
      const formVersion = Number(workspace.formVersion);
      const publishedVersion = Number(workspace.publishedVersion);
      const consentVersion = Number(workspace.consentVersion) || 1;
      if (![formVersion, publishedVersion, consentVersion].every((version) => Number.isSafeInteger(version) && version >= 0) ||
          (workspace.consentText != null && typeof workspace.consentText !== "string")) throw new Error("invalid version");
      const fields = workspace.fields.map(record);
      if (fields.some((field) => !field || typeof field.id !== "string" || typeof field.label !== "string" ||
          typeof field.type !== "string" || (field.required !== undefined && typeof field.required !== "boolean") ||
          (field.options !== undefined && (!Array.isArray(field.options) || field.options.some((value) => typeof value !== "string"))))) throw new Error("invalid fields");
      if (controller.signal.aborted || activeSettingsEventRef.current !== eventId || intakeReadRef.current !== controller) return;
      const latest: LatestIntake = { formVersion, publishedVersion, consentVersion, consentText: text(workspace.consentText),
        publishedFields: parsePublishedRegisterFields(workspace.publishedFields, "workspace"),
        registrationOpen: workspace.registrationOpen === true, fields: fields.map((field) => ({ label: text(field?.label),
          required: field?.required === true, type: text(field?.type),
          options: Array.isArray(field?.options) ? field.options.filter((value): value is string => typeof value === "string") : [] })) };
      const resolved = { latest, loading: false, error: null };
      intakeConflictRef.current = resolved;
      setIntakeConflict(resolved);
    } catch {
      if (activeSettingsEventRef.current !== eventId || intakeReadRef.current !== controller) return;
      const failed = { latest: null, loading: false, error: "최신 설정을 불러오지 못했습니다. 작성 중인 내용은 그대로 있습니다. 연결과 접근 권한을 확인한 뒤 다시 시도하세요." };
      intakeConflictRef.current = failed;
      setIntakeConflict(failed);
    } finally {
      window.clearTimeout(timeout);
      if (intakeReadRef.current === controller) intakeReadRef.current = null;
    }
  }

  function resolveIntakeConflict(useLatest: boolean) {
    const latest = intakeConflictRef.current?.latest;
    if (!latest || activeSettingsEventRef.current !== eventId) return;
    setState((previous) => previous.kind === "ready" ? { ...previous, formVersion: latest.formVersion,
      publishedVersion: latest.publishedVersion, consentVersion: latest.consentVersion,
      fields: latest.fields, publishedFields: latest.publishedFields,
      consentText: latest.consentText, registrationOpen: latest.registrationOpen } : previous);
    if (useLatest) setConsentText(latest.consentText);
    intakeConflictRef.current = null;
    setIntakeConflict(null);
    setIntakeStatus({ kind: "success", message: "선택한 안내를 확인했습니다. 게시하려면 아래 버튼을 직접 눌러 주세요.", ...stampNow() });
    window.requestAnimationFrame(() => document.getElementById("set-consent")?.focus());
  }

  async function readLatestBasics() {
    if (!basicsConflictRef.current || basicsReadRef.current) return;
    const controller = new AbortController();
    basicsReadRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const loading = { latest: null, loading: true, error: null };
    basicsConflictRef.current = loading;
    setBasicsConflict(loading);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const bootstrap = record(record(await response.json())?.state);
      const workspace = record(record(bootstrap?.workspaces)?.[eventId]);
      const event = Array.isArray(bootstrap?.events) ? bootstrap.events.map(record).find((item) => item?.id === eventId) : null;
      if (!response.ok || !workspace || !event ||
          [event.name, event.slug, event.date, event.start, event.end].some((value) => typeof value !== "string") ||
          !(event.clientId === null || typeof event.clientId === "string") ||
          !finiteNumber(event.capacity) || !finiteNumber(workspace.price) ||
          typeof workspace.approvalRequired !== "boolean" || typeof workspace.allowReentry !== "boolean" ||
          (workspace.verificationRequired !== undefined && typeof workspace.verificationRequired !== "boolean") ||
          (event.format !== undefined && event.format !== null && typeof event.format !== "string")) throw new Error("invalid response");
      const latest: Basics = { name: text(event.name), slug: text(event.slug), clientId: text(event.clientId),
        date: text(event.date), start: text(event.start) || "09:00", end: text(event.end) || "18:00",
        capacity: String(Number(event.capacity) || 0), price: String(Number(workspace.price) || 0),
        format: ["offline", "online", "hybrid"].includes(text(event.format)) ? text(event.format) : "",
        approvalRequired: workspace.approvalRequired === true, allowReentry: workspace.allowReentry !== false,
        verificationRequired: workspace.verificationRequired === true };
      if (controller.signal.aborted || activeSettingsEventRef.current !== eventId || basicsReadRef.current !== controller) return;
      const resolved = { latest, loading: false, error: null };
      basicsConflictRef.current = resolved;
      setBasicsConflict(resolved);
    } catch {
      if (activeSettingsEventRef.current !== eventId || basicsReadRef.current !== controller) return;
      const failed = { latest: null, loading: false, error: "최신 설정을 불러오지 못했습니다. 작성 중인 내용은 그대로 있습니다. 연결과 접근 권한을 확인한 뒤 다시 시도하세요." };
      basicsConflictRef.current = failed;
      setBasicsConflict(failed);
    } finally {
      window.clearTimeout(timeout);
      if (basicsReadRef.current === controller) basicsReadRef.current = null;
    }
  }

  function resolveBasicsConflict(useLatest: boolean) {
    const latest = basicsConflictRef.current?.latest;
    if (!latest || activeSettingsEventRef.current !== eventId) return;
    setState((previous) => previous.kind === "ready" ? { ...previous, basics: latest } : previous);
    if (useLatest) setBasics(latest);
    basicsConflictRef.current = null;
    setBasicsConflict(null);
    setBasicsStatus({ kind: "success", message: "선택한 내용을 확인했습니다. 저장하려면 아래 버튼을 직접 눌러 주세요.", ...stampNow() });
    window.requestAnimationFrame(() => document.getElementById("set-name")?.focus());
  }

  async function readLatestFeatures() {
    if (!featuresConflictRef.current || featuresReadRef.current) return;
    const controller = new AbortController();
    featuresReadRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const loading = { latest: null, loading: true, error: null };
    featuresConflictRef.current = loading;
    setFeaturesConflict(loading);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const bootstrap = record(record(await response.json())?.state);
      const event = Array.isArray(bootstrap?.events) ? bootstrap.events.map(record).find((item) => item?.id === eventId) : null;
      if (!response.ok || !event || !Array.isArray(event.features) || event.features.some((item) => typeof item !== "string")) throw new Error("invalid response");
      if (controller.signal.aborted || activeSettingsEventRef.current !== eventId || featuresReadRef.current !== controller) return;
      const resolved = { latest: event.features as string[], loading: false, error: null };
      featuresConflictRef.current = resolved;
      setFeaturesConflict(resolved);
    } catch {
      if (activeSettingsEventRef.current !== eventId || featuresReadRef.current !== controller) return;
      const failed = { latest: null, loading: false, error: "최신 설정을 불러오지 못했습니다. 선택 중인 기능은 그대로 있습니다. 연결과 접근 권한을 확인한 뒤 다시 시도하세요." };
      featuresConflictRef.current = failed;
      setFeaturesConflict(failed);
    } finally {
      window.clearTimeout(timeout);
      if (featuresReadRef.current === controller) featuresReadRef.current = null;
    }
  }

  function resolveFeaturesConflict(useLatest: boolean) {
    const latest = featuresConflictRef.current?.latest;
    if (!latest || !features || activeSettingsEventRef.current !== eventId) return;
    const visible = new Set(FEATURES.map((feature) => feature.id));
    // Hidden/legacy features have no switch here: neither the old draft nor
    // the selection action may overwrite their newer server values.
    const chosen = useLatest ? latest : [ ...features.filter((feature) => visible.has(feature)),
      ...latest.filter((feature) => !visible.has(feature)) ];
    setState((previous) => previous.kind === "ready" ? { ...previous, features: latest } : previous);
    setFeatures(chosen);
    featuresConflictRef.current = null;
    setFeaturesConflict(null);
    setFeaturesStatus({ kind: "success", message: "선택한 기능을 확인했습니다. 저장하려면 아래 버튼을 직접 눌러 주세요.", ...stampNow() });
    window.requestAnimationFrame(() => document.getElementById("settings-features-legend")?.focus());
  }

  if (state.kind === "loading" || (state.kind === "ready" && loadedSettingsEventRef.current !== eventId)) {
    return (
      <ConsolePage pageId="settings" eventId={eventId}>
        <ConsoleStatePanel kind="loading" shape="form" message="행사 설정을 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="settings" eventId={eventId}>
        {/* ConsoleStatePanel owns the "다시 불러오기" control and eventouch:shell-reload dispatch. */}
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }
  if (!basics || !features) {
    return (
      <ConsolePage pageId="settings" eventId={eventId}>
        <ConsoleStatePanel kind="loading" shape="form" message="행사 설정을 준비하고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }

  const invalid = (field: string) => failure?.field === field;
  const describedBy = (field: string) =>
    failure?.field === field ? "settings-error" : undefined;

  const currentStage = state.stage.toUpperCase();
  const hasPublishedForm = state.publishedVersion > 0;
  const formPreviewFields = hasPublishedForm ? state.publishedFields : state.fields;
  const formPreviewTitle = hasPublishedForm ? "현재 게시된 신청서" : "신청서 초안";
  const stageKnown = STAGE_ORDER.includes(currentStage);
  const stageIndex = STAGE_ORDER.indexOf(currentStage);
  const nextStage = stageIndex >= 0 && stageIndex < STAGE_ORDER.length - 1
    ? STAGE_ORDER[stageIndex + 1]
    : null;
  const stageText = stageKnown ? eventStageLabel(currentStage) : "단계 미정";
  const stagePrompt = nextStage
    ? `현재 ${stageText} · 다음 ${eventStageLabel(nextStage)}`
    : currentStage === "ARCHIVED"
      ? "보관된 행사는 읽기 전용입니다."
      : stageKnown
        ? "마지막 진행 단계입니다."
        : "단계 정보가 확인되지 않아 전환할 수 없습니다.";
  const archiveDataUnavailable = nextStage === "ARCHIVED" && (!state.closeSnapshot.archiveAvailable || archiveRecheckRequired);
  const archiveUnavailableNames = [!state.closeSnapshot.participantsAvailable ? "참가자" : "", !state.closeSnapshot.registrationAvailable ? "접수" : "", !state.closeSnapshot.modulesAvailable ? "참여 콘텐츠" : ""].filter(Boolean).join(" · ") || "보관 전제";
  const stagePrecondition = nextStage === "LIVE" && (state.deskCount === 0 || state.deskAssignmentCount === 0)
    ? "진행 중 전환에는 등록 데스크와 데스크 배정이 필요합니다. 배정은 출근 확인이 아닙니다."
    : archiveDataUnavailable
      ? `${archiveUnavailableNames} 상태를 확인할 수 없어 보관할 수 없습니다. 다시 확인해도 계속되면 시스템 관리자에게 문의하세요.`
    : nextStage === "ARCHIVED" && (state.registrationOpen || state.openModules > 0)
      ? "보관하려면 접수를 닫고 진행 중인 참여 콘텐츠를 모두 닫아야 합니다."
      : null;
  // A known-failing transition is blocked before confirmation instead of
  // sent to the server for a predictable rejection. Server rules stay
  // authoritative; this only avoids the wasted round trip.
  const stageBlocked = stagePrecondition !== null;
  // 보관된 행사는 서버가 모든 쓰기를 거부하므로 쓰기 affordance를 미리
  // 잠그고 이유를 밝힌다. 조회는 그대로 둔다.
  const archived = currentStage === "ARCHIVED";
  const archivedReason = "보관된 행사는 읽기 전용입니다";
  // Section write gates mirror the server scope map: 행사 정보·기능·단계는
  // settings (event.* probe), 접수 게시·마감은 participants (form.* probe).
  // Neither gate invents access; the server re-checks every command.
  const capabilities = { role: state.role, userId: state.userId, memberships: state.memberships, eventId };
    const canWriteSettings = canWriteEvent(capabilities, "event.basics.save");
  const canWriteIntake = canWriteEvent(capabilities, "form.publish");
  const settingsLocked = Boolean(pendingSettings) || otherSettingsReceipt || busy || stageBusy || checkingSettings || refreshingAfterWrite;
  // form.publish is rejected server-side once the event ends (preparation.js
  // publishForm): the button stays visible for layout stability but cannot
  // be pressed, with the reason inline. form.close stays available so the
  // archive precondition can still be met from ENDED.
  const endedPublishBlocked = currentStage === "ENDED";
  const endedPublishReason = "종료된 행사에서는 양식을 게시할 수 없습니다. 접수를 닫은 뒤 보관하세요.";
  const settingsNoWriteReason = "행사 정보 변경 권한이 없습니다. 필요하면 담당 행사 운영자에게 요청하세요.";
  const intakeNoWriteReason = "접수 게시·마감은 참가자 쓰기 권한이 필요합니다. 행사 정보 권한과는 별개이며, 필요하면 담당 행사 운영자에게 요청하세요.";

  function sectionStatusLine(status: SectionStatus | null, section: SettingsSectionId) {
    if (!status) return null;
    return (
      <p
        role={status.kind === "error" && failure?.field === "serverUnsupported" ? "alert" : "status"}
        data-settings-section-status={section}
        className={`${styles.sectionStatus} ${status.kind === "error" ? styles.sectionStatusError : styles.sectionStatusSuccess}`}
      >
        {status.message} · {status.at}
      </p>
    );
  }

  function requestFormPublish() {
    if (state.kind !== "ready" || settingsLocked || intakeConflict) return;
    // Omitted consent leaves the server's previous text unchanged. Do not
    // make an emptied editor look as if it will remove that stored text.
    if (!consentText.trim() && consentText !== state.consentText) {
      const message = "빈 동의 안내는 저장되지 않습니다. 기존 안내를 유지하거나 내용을 입력하세요.";
      setFailure({ message, field: "consentText" });
      setNotice(null);
      setIntakeStatus(null);
      window.requestAnimationFrame(() => document.getElementById("set-consent")?.focus());
      return;
    }
    void runCommand(
      "form.publish",
      { ...(consentText.trim() ? { consentText } : {}), expectedFormVersion: state.formVersion,
        expectedConsentVersion: state.consentVersion, expectedConsentText: state.consentText },
      currentStage === "DRAFT"
        ? "양식을 게시했습니다. 진행 단계에서 운영 준비 단계로 전환하면 접수가 열립니다."
        : "양식을 게시하고 접수를 열었습니다.",
      "intake"
    );
  }

  async function submitStageTransition() {
    if (state.kind !== "ready" || !canWriteSettings || !nextStage || stageBusy || operationsBusyRef.current ||
        pendingSettingsRef.current || otherSettingsReceipt || !stageConfirm || stageBlocked) return;
    const payload = { stage: nextStage };
    if (!stageCommandIdRef.current) stageCommandIdRef.current = randomCommandId();
    const commandId = stageCommandIdRef.current;
    await executeSettingsAttempt({ eventId, command: "event.stage", payload,
      successMessage: `행사를 ${eventStageLabel(nextStage)} 단계로 전환했습니다.`, section: "stage",
      commandId, fingerprint: `event.stage:${stableStringify(payload)}` });
  }

  // 행사 카드의 달력 블록. 저장된 날짜(state.basics)를 읽는다.
  function eventCalendar(): { month: string; day: string; weekday: string } {
    const parsed = /^(\d{4})-(\d{2})-(\d{2})$/.exec(state.kind === "ready" ? state.basics.date : "");
    if (!parsed) return { month: "", day: "–", weekday: "" };
    const date = new Date(Number(parsed[1]), Number(parsed[2]) - 1, Number(parsed[3]));
    const weekday = ["일", "월", "화", "수", "목", "금", "토"][date.getDay()] ?? "";
    return { month: `${Number(parsed[2])}월`, day: String(Number(parsed[3])), weekday };
  }

  // 저장된 접수 정책 한 줄. 켜진 것만 적는다(꺼진 항목은 적지 않는다).
  function savedPolicyFlags(): string[] {
    if (state.kind !== "ready") return [];
    const flags: string[] = [];
    if (state.basics.approvalRequired) flags.push("승인 필요");
    if (state.basics.allowReentry) flags.push("재입장 허용");
    if (state.basics.verificationRequired) flags.push("연락처 인증");
    return flags;
  }

  // 기본 정보 저장. 공개된 행사(준비 이후 단계)에서 주소 코드가 바뀌면
  // 먼저 확인 창을 거친다. 기획 단계에서는 바로 저장한다.
  function submitBasicsForm() {
    if (state.kind !== "ready" || !basics || basicsConflict) return;
    // 0 means 제한 없음; an empty or malformed box must not silently become it.
    const capacity = capacityToSave(basics.capacity, state.basics.capacity);
    if (capacity === null) {
      setFailure({ message: CAPACITY_MESSAGE, field: "capacity" });
      return;
    }
    if (currentStage !== "DRAFT" && basics.slug !== state.basics.slug) {
      setSlugConfirm(true);
      return;
    }
    void runCommand("event.basics.save", basicsSavePayload(basics, state.basics, capacity), "기본 정보를 저장했습니다.", "basics");
  }

  const latestSectionStatus = [basicsStatus, intakeStatus, featuresStatus].reduce<SectionStatus | null>(
    (latest, status) => {
      if (!status) return latest;
      if (!latest || status.order >= latest.order) return status;
      return latest;
    },
    null
  );
  const lastResult = failure
    ? failure.field === "consentText" || failure.field === "serverUnsupported" ? null : { kind: "error" as const, message: failure.message }
    : notice
      ? { kind: "success" as const, message: notice }
      : latestSectionStatus;

  // 운영 기능 summary for the TOC tiles and the group headers (2026-11-21): only features the
  // screen can switch count; an unknown stored feature never shows up as "켜짐".
  const switchableFeatureIds = FEATURE_GROUPS.flatMap((group) => group.ids);
  const featureTotal = switchableFeatureIds.length;
  const featureOnCount = switchableFeatureIds.filter((id) => (features ?? state.features).includes(id)).length;
  const featureChangeCount = switchableFeatureIds.filter((id) => (features ?? state.features).includes(id) !== state.features.includes(id)).length;
  const recoveryGap = isRecoveryBlocked(verificationMode) && !state.recoveryContact;

  return (
    <ConsolePage
      pageId="settings"
      closeSnapshot={state.closeSnapshot}
      eventId={eventId}
      eventName={basics?.name || state.basics.name}
      meta={state.eventMeta}
      feedback={(
        <>
          {archived ? (
            <ConsoleFeedback kind="warning">
              보관된 행사는 읽기 전용입니다. 설정은 볼 수 있지만 저장·게시·전환할 수 없습니다.
            </ConsoleFeedback>
          ) : null}
          {failure && failure.field !== "serverUnsupported" && failure.field !== "consentText" ? <ConsoleFeedback kind="error" id="settings-error">{failure.message}</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {showTicketReview ? <p><ProductLink className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>티켓 확인이 필요한 참가자 보기</ProductLink></p> : null}
          {intakeConflict ? <ConsoleFeedback kind="warning">참가 접수 설정이 변경되어 최신 내용을 확인해야 합니다. 아래 참가 접수 구역에서 작성 중인 안내를 확인하세요.</ConsoleFeedback> : null}
          {basicsConflict ? <ConsoleFeedback kind="warning">기본 정보가 변경되어 최신 내용을 확인해야 합니다. 기본 정보 드로어를 열어 작성 중인 내용을 확인하세요.</ConsoleFeedback> : null}
          {featuresConflict ? <ConsoleFeedback kind="warning">운영 기능이 변경되어 최신 내용을 확인해야 합니다. 아래 운영 기능 구역에서 선택 중인 기능을 확인하세요.</ConsoleFeedback> : null}
          {refreshingAfterWrite ? <ConsoleFeedback kind="info">최신 행사 설정을 불러오고 있습니다.</ConsoleFeedback> : null}
        </>
      )}
    >
      <p className={styles.scopeNote} data-settings-scope-note>
        각 구역의 저장·게시·전환은 그 구역에만 적용됩니다.
      </p>
      {pendingSettings ? <section className={styles.recovery} aria-labelledby="settings-recovery-heading">
        <h2 id="settings-recovery-heading" tabIndex={-1} className={styles.blockTitle}>행사 설정 처리 확인 필요</h2>
        <p>{SETTINGS_COMMAND_LABEL[pendingSettings.command] ?? "이전 설정"} 요청이 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</p>
        {archived || !canWriteEvent(capabilities, pendingSettings.command) ? <p>현재 권한이나 행사 상태에서는 같은 요청을 다시 보낼 수 없습니다. 서버 처리 확인이나 담당자 확인을 이용하세요.</p> : null}
        {settingsRecoveryError ? <p role="alert">{settingsRecoveryError}</p> : null}
        {postponesEvent(pendingSettings) ? <p><ProductLink className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>티켓 확인이 필요한 참가자 보기</ProductLink></p> : null}
        <div className={styles.recoveryActions}>
          <ProductButton type="button" className="button button-secondary" disabled={busy || stageBusy || checkingSettings || abandonSettingsConfirm} onClick={() => void checkSettings()}>{checkingSettings ? "확인 중…" : "서버 처리 확인"}</ProductButton>
          <ProductButton type="button" className="button button-secondary" disabled={busy || stageBusy || checkingSettings || abandonSettingsConfirm || archived || !canWriteEvent(capabilities, pendingSettings.command)} onClick={() => void retrySettings()}>같은 요청 다시 시도</ProductButton>
          <ProductButton type="button" className="button button-secondary" disabled={busy || stageBusy || checkingSettings || abandonSettingsConfirm} onClick={() => setAbandonSettingsConfirm(true)}>확인 전 그만두기</ProductButton>
        </div>
        {abandonSettingsConfirm ? <ConsoleConfirm
          summary="이미 반영된 설정은 취소되지 않습니다. 확인을 그만두고 최신 내용을 확인할까요?"
          confirmLabel="확인 그만두기"
          onConfirm={() => {
            const attempt = pendingSettingsRef.current;
            if (!attempt) return;
            commandIdCache.current.delete(attempt.fingerprint);
            abandonOperatorAttempt(attempt.commandId);
            forgetOperatorReceipt(attempt.commandId);
            stageCommandIdRef.current = null;
            pendingSettingsRef.current = null;
            setPendingSettings(null);
            setSettingsRecoveryError(null);
            setAbandonSettingsConfirm(false);
            setStageConfirm(false);
            setFailure({ message: "이전 설정이 반영됐을 수 있습니다. 최신 내용을 확인한 뒤 다시 진행하세요." });
            setRefreshingAfterWrite(true);
            setReloadTick((tick) => tick + 1);
          }}
          onCancel={() => setAbandonSettingsConfirm(false)}
        /> : null}
      </section> : null}
      {otherSettingsReceipt ? <ConsoleFeedback kind="warning">이전 행사 설정의 처리 결과를 화면 위에서 먼저 확인하세요. 서버 확인은 요청을 다시 보내지 않습니다.</ConsoleFeedback> : null}
      <div className={styles.layout}>
      <SettingsToc items={[
        { id: "basics", label: "기본 정보", hint: `정원 ${state.basics.capacity === "0" ? "제한 없음" : `${state.basics.capacity}명`}`, tone: "ok", dirty: Boolean(basicsDirty), onSelect: () => setBasicsOpen(true), disabled: archived || !canWriteSettings },
        { id: "stage", label: "진행 단계", hint: stageText, tone: "ok", href: "#settings-stage" },
        { id: "intake", label: "참가 접수", hint: state.registrationOpen ? "접수 중" : "접수 닫힘", note: recoveryGap ? "확인할 안내 1건" : undefined, tone: recoveryGap ? "attention" : state.registrationOpen ? "ok" : "neutral", dirty: Boolean(intakeDirty), href: "#settings-intake" },
        { id: "features", label: "운영 기능", hint: `${featureOnCount}개 켜짐`, note: `나머지 ${featureTotal - featureOnCount}개 꺼짐`, tone: "neutral", dirty: Boolean(featuresDirty), href: "#settings-features" },
      ]} />
      <div className={styles.main}>
      <section className={styles.eventCard} aria-label="행사 개요와 진행 단계">
        <div className={styles.eventTop} id="panel-settings-basics" data-settings-section="basics">
          <div className={styles.cal} aria-hidden="true">
            <small>{eventCalendar().month}</small>
            <b>{eventCalendar().day}</b>
            <span>{eventCalendar().weekday}</span>
          </div>
          <div className={styles.eventName}>
            <h2 id="settings-basics" className={styles.eventTitle}>{state.basics.name}</h2>
            <p className={styles.eventMetaLine}>{state.eventMeta}</p>
            <p className={styles.eventFlags}>
              정원 {state.basics.capacity === "0" ? "제한 없음" : `${state.basics.capacity}명`}
              {savedPolicyFlags().length ? ` · ${savedPolicyFlags().join(" · ")}` : ""}
            </p>
          </div>
          <div className={styles.cardEdit}>
            <ProductButton
              type="button"
              className="button button-secondary"
              disabled={archived || !canWriteSettings}
              title={archived ? archivedReason : !canWriteSettings ? settingsNoWriteReason : undefined}
              onClick={() => setBasicsOpen(true)}
            >
              수정
            </ProductButton>
            {basicsDirty ? (
              <span role="status" className={styles.unsavedTag}>
                <StatusPill tone="wait" size="sm" dot>저장 안 됨</StatusPill>
              </span>
            ) : null}
          </div>
        </div>
        <div
          id="panel-settings-stage"
          data-settings-section="stage"
          className={`${styles.cardStage} ${highlight === "stage" ? styles.sectionFlash : ""}`}
        >
          <h2 id="settings-stage" className={styles.stageName}>
            <span className={styles.stageDot} aria-hidden="true" />
            {stageText}
          </h2>
          <p className={styles.stagePrompt}>{stagePrompt}</p>
          <ol className={styles.stageTimeline} aria-label="전체 진행 단계">
            {STAGE_ORDER.map((stage) => {
              const isCurrent = stage === currentStage;
              const isNext = stage === nextStage;
              const isDone = stageIndex > STAGE_ORDER.indexOf(stage);
              return (
                <li
                  key={stage}
                  aria-current={isCurrent ? "step" : undefined}
                  data-done={isDone ? "true" : undefined}
                  className={`${styles.stageStep} ${isCurrent ? styles.stageStepCurrent : ""} ${isNext && !isCurrent ? styles.stageStepNext : ""}`}
                >
                  <span>{eventStageLabel(stage)}</span>
                  {isCurrent ? (
                    <span className={styles.stageStepMark}>현재</span>
                  ) : isNext ? (
                    <span className={styles.stageStepMark}>다음</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          {stagePrecondition ? (
            <div id="settings-stage-precondition" className={styles.stagePrecondition} role="note">
              <span>{stagePrecondition}</span>
              <span>
              {archiveDataUnavailable ? (
                <ProductButton type="button" className="button button-secondary" disabled={refreshingAfterWrite} onClick={() => { setStageError(null); setRefreshingAfterWrite(true); setReloadTick((tick) => tick + 1); }}>{refreshingAfterWrite ? "상태 확인 중" : "상태 다시 확인"}</ProductButton>
              ) : nextStage === "LIVE" ? (
                <ProductLink className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/operations`}>운영에서 데스크 배정하기</ProductLink>
              ) : (
                <>
                  <a className="button button-secondary" href="#settings-intake">접수 닫기</a>
                  {" · "}
                  <ProductLink className="button button-secondary" href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>프로그램 닫기</ProductLink>
                </>
              )}
              </span>
            </div>
          ) : null}
          {stageError ? <ConsoleFeedback kind="error">{stageError}</ConsoleFeedback> : null}
          {stageNotice ? <ConsoleFeedback kind="success">{stageNotice}</ConsoleFeedback> : null}
          <div className={styles.stageActions}>
            {!canWriteSettings ? (
              <p className={styles.help}>행사 단계 변경 권한이 없습니다.</p>
            ) : nextStage && !stageConfirm ? (
              <ProductButton
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setStageError(null);
                  setStageNotice(null);
                  setStageConfirm(true);
                }}
                disabled={settingsLocked || stageBlocked}
                aria-describedby={stageBlocked ? "settings-stage-precondition" : undefined}
              >
                {eventStageLabel(nextStage)} 단계로 전환
              </ProductButton>
            ) : nextStage ? (
              <StageTransitionConfirmation className={styles.stageConfirmation} label={eventStageLabel(nextStage)}
                busy={stageBusy} disabled={settingsLocked || stageBlocked} cancelDisabled={settingsLocked}
                retry={Boolean(stageCommandIdRef.current && stageError)}
                describedBy={stageBlocked ? "settings-stage-precondition" : undefined}
                onConfirm={() => void submitStageTransition()}
                onCancel={() => { setStageConfirm(false); setStageError(null); }}>
                {nextStage === "ENDED" ? (
                  <p className={styles.help}>
                    종료하면 참가자 변경이 막힙니다. 승인 대기 등 필요한 참가자 처리는 종료 전에 마치세요.
                    결과 보고서는 생성 시점 값으로 고정됩니다. 종료 뒤 마감 집계를 생성·검토하고 동결할 수 있으며, 편집이나 공유 완료 기록만으로 집계가 갱신되지는 않습니다.
                  </p>
                ) : null}
              </StageTransitionConfirmation>
            ) : null}
          </div>
        </div>
      </section>
      {basicsOpen ? (
      <ConsoleDialog
        title="기본 정보"
        titleId="settings-basics-dialog"
        presentation="drawer"
        stickyChrome
        onClose={() => { setSlugConfirm(false); setBasicsOpen(false); }}
        busy={busy || stageBusy || checkingSettings}
      >
        {!canWriteSettings ? (
          <p className={styles.help} role="note">{settingsNoWriteReason}</p>
        ) : null}
        {basicsConflict ? <section className={styles.conflict} aria-labelledby="basics-conflict-heading">
          <h3 id="basics-conflict-heading" tabIndex={-1} className={styles.blockTitle}>다른 작업에서 기본 정보가 변경됐습니다</h3>
          <p>이번 저장 요청은 반영되지 않았습니다. 작성 중인 내용은 그대로 있습니다. 최신 정보와 비교해 사용할 내용을 선택해 주세요.</p>
          {basicsConflict.error ? <p role="alert">{basicsConflict.error}</p> : null}
          {basicsConflict.latest ? <>
            <table className={styles.settingsComparison}>
              <caption>최신 정보와 내가 작성 중인 기본 정보 비교</caption>
              <thead><tr><th scope="col">항목</th><th scope="col">최신 기본 정보</th><th scope="col">내 작성 내용</th></tr></thead>
              <tbody>{BASIC_COMPARISON_FIELDS.map(({ key, label }) => {
                const latest = basicsConflict.latest!;
                const changed = latest[key] !== basics[key];
                return <tr key={key} className={changed ? styles.comparisonChanged : undefined}>
                  <th scope="row">{label}{changed ? <span className={styles.comparisonDifference}>다름</span> : null}</th>
                  <td>{basicComparisonValue(key, latest, state.clients)}</td>
                  <td>{basicComparisonValue(key, basics, state.clients)}</td>
                </tr>;
              })}</tbody>
            </table>
            <div className={styles.recoveryActions}>
              <ProductButton type="button" className="button button-secondary" disabled={settingsLocked} onClick={() => resolveBasicsConflict(false)}>내 작성 내용으로 계속</ProductButton>
              <ProductButton type="button" className="button button-secondary" disabled={settingsLocked} onClick={() => resolveBasicsConflict(true)}>최신 정보 사용</ProductButton>
            </div>
            <p className={styles.help}>내 작성 내용으로 계속한 뒤 저장하면, 다른 운영자가 바꾼 항목을 포함해 현재 입력된 기본 정보 전체가 적용됩니다. 필요한 값을 먼저 수정할 수 있습니다. 선택만으로 저장되지는 않습니다.</p>
          </> : <ProductButton type="button" className="button button-secondary" disabled={basicsConflict.loading || settingsLocked} onClick={() => void readLatestBasics()}>{basicsConflict.loading ? "최신 설정 확인 중…" : "최신 설정 확인"}</ProductButton>}
        </section> : null}
        <ValidatedForm
          className={`${uiStyles.formStack} ${styles.basicsForm}`}
          onSubmit={(event) => {
            event.preventDefault();
            submitBasicsForm();
          }}
        >
          <fieldset disabled={!canWriteSettings || archived || settingsLocked} className={styles.bareFieldset}>
          {/* 기본 정보 안의 과제 묶음: 식별 → 일시·규모 → 접수 정책.
              그룹 래퍼와 소제목만 추가하며 입력 id·순서·검증은 그대로. */}
          <div className={styles.fieldGroup}>
            <h3 className={styles.groupTitle}>행사 식별</h3>
          <div className={`${uiStyles.formGrid} ${styles.identityFields}`}>
            <div>
              <label htmlFor="set-name">행사명</label>
              <input
                id="set-name"
                type="text"
                value={basics.name}
                onChange={(event) => setBasics({ ...basics, name: event.target.value })}
                aria-invalid={invalid("name") || undefined}
                aria-describedby={describedBy("name") || undefined}
                required
              />
            </div>
            <div>
              <label htmlFor="set-slug">주소 코드</label>
              <input
                id="set-slug"
                type="text"
                pattern="[a-z0-9][a-z0-9\-]{0,49}"
                value={basics.slug}
                onChange={(event) => setBasics({ ...basics, slug: event.target.value })}
                aria-invalid={invalid("slug") || undefined}
                aria-describedby={describedBy("slug") || undefined}
                required
              />
            </div>
          </div>
          <div>
            <label htmlFor="set-client">고객사</label>
            <select
              id="set-client"
              value={basics.clientId}
              onChange={(event) => setBasics({ ...basics, clientId: event.target.value })}
              aria-invalid={invalid("clientId") || undefined}
              aria-describedby={describedBy("clientId") || undefined}
            >
              <option value="" disabled={state.basics.clientId !== ""}>
                {state.basics.clientId ? "고객사 선택" : "고객사 없음"}
              </option>
              {state.clients.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.name || client.id}
                </option>
              ))}
            </select>
          </div>
          {state.basics.clientId ? (
            <p className={styles.help}>연결된 고객사는 다른 고객사로만 바꿀 수 있고, 비우기로 끊을 수는 없습니다.</p>
          ) : null}
          </div>
          <div className={styles.fieldGroup}>
            <h3 className={styles.groupTitle}>일시·규모</h3>
          <div className={`${uiStyles.formGrid} ${styles.scheduleFields}`}>
            <div>
              <label htmlFor="set-date">행사 날짜</label>
              <input
                id="set-date"
                type="date"
                value={basics.date}
                onChange={(event) => setBasics({ ...basics, date: event.target.value })}
                aria-invalid={invalid("date") || undefined}
                aria-describedby={[describedBy("date"), basics.date && basics.date > state.basics.date ? "ticket-expiry-help" : null].filter(Boolean).join(" ") || undefined}
                required
              />
              {basics.date && basics.date > state.basics.date ? (
                <p id="ticket-expiry-help" className={`${styles.help} ${styles.ticketExpiryHelp}`} role="note">저장하면 현재 유효한 티켓은 새 행사 날짜에 맞춰 연장됩니다. 이미 만료·취소·철회된 티켓은 연장하지 않습니다. 참가자 로그인은 별도로 다시 인증해야 할 수 있습니다.</p>
              ) : null}
            </div>
            <div className={styles.twoCols}>
              <div>
                <label htmlFor="set-start">시작</label>
                <input
                  id="set-start"
                  type="time"
                  value={basics.start}
                  onChange={(event) => setBasics({ ...basics, start: event.target.value })}
                  aria-invalid={invalid("start") || invalid("end") || undefined}
                  aria-describedby={failure?.field === "start" || failure?.field === "end" ? "settings-error" : undefined}
                />
              </div>
              <div>
                <label htmlFor="set-end">종료</label>
                <input
                  id="set-end"
                  type="time"
                  value={basics.end}
                  onChange={(event) => setBasics({ ...basics, end: event.target.value })}
                  aria-invalid={invalid("start") || invalid("end") || undefined}
                  aria-describedby={failure?.field === "start" || failure?.field === "end" ? "settings-error" : undefined}
                />
              </div>
            </div>
          </div>
          <div className={uiStyles.formGrid}>
            <div>
              <label htmlFor="set-capacity">정원 (0=제한 없음)</label>
              <input
                id="set-capacity"
                type="number"
                min={0}
                inputMode="numeric"
                value={basics.capacity}
                onChange={(event) => setBasics({ ...basics, capacity: event.target.value })}
                aria-invalid={invalid("capacity") || undefined}
                aria-describedby={describedBy("capacity") || undefined}
              />
            </div>
          </div>
          </div>
          <div className={styles.fieldGroup}>
            <h3 className={styles.groupTitle}>접수 정책</h3>
          <div className={styles.policyList}>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={basics.approvalRequired}
              onChange={(event) => setBasics({ ...basics, approvalRequired: event.target.checked })}
            />
            신청 후 운영자 승인 필요
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={basics.allowReentry}
              onChange={(event) => setBasics({ ...basics, allowReentry: event.target.checked })}
            />
            재입장 허용
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={basics.verificationRequired}
              onChange={(event) => setBasics({ ...basics, verificationRequired: event.target.checked })}
            />
            참가 신청 전 연락처 인증 필요
          </label>
          </div>
          <p className={styles.help}>인증번호는 신청자의 휴대전화로 발송됩니다. 발송 준비가 안 된 상태에서는 신청이 막히므로, 먼저 인증번호 1건을 테스트하세요.</p>
          </div>
          {failure && failure.field !== "serverUnsupported" && failure.field !== "consentText" ? (
            <p role="alert" className={styles.fieldError}>{failure.message}</p>
          ) : null}
          <ConsoleFormActions>
            <ProductButton
              id="settings-basics-save"
              type="submit"
              className="button button-primary"
              disabled={settingsLocked || Boolean(basicsConflict) || archived || !canWriteSettings}
              title={archived ? archivedReason : !canWriteSettings ? settingsNoWriteReason : undefined}
            >
              {busy ? "저장 중입니다" : "기본 정보 저장"}
            </ProductButton>
            {basicsDirty ? (
              <span role="status" className={styles.unsavedTag}>
                <StatusPill tone="wait" size="sm" dot>저장 안 됨</StatusPill>
              </span>
            ) : null}
          </ConsoleFormActions>
          {sectionStatusLine(basicsStatus, "basics")}
          </fieldset>
        </ValidatedForm>
        {slugConfirm ? (
          <ConsoleConfirm
            summary={<><strong>주소 코드를 바꿀까요?</strong><br />이미 공개된 행사입니다. 바꾸면 이전 주소({state.basics.slug})로 나간 링크는 열리지 않습니다. 새 주소({basics.slug || "미입력"})로 저장할까요?</>}
            confirmLabel="주소 바꾸고 저장"
            onConfirm={() => {
              setSlugConfirm(false);
              // The box may have changed since the confirm opened: validate again, same rule.
              const capacity = capacityToSave(basics.capacity, state.basics.capacity);
              if (capacity === null) { setFailure({ message: CAPACITY_MESSAGE, field: "capacity" }); return; }
              void runCommand("event.basics.save", basicsSavePayload(basics, state.basics, capacity), "기본 정보를 저장했습니다.", "basics");
            }}
            onCancel={() => setSlugConfirm(false)}
          />
        ) : null}
      </ConsoleDialog>
      ) : null}
      {/* The drawer closes when the save lands, so the review of what attendees still see lives on the board, not inside it. */}
      <div className="sr-only" aria-live="polite" aria-atomic="true">
        {showScheduleReview ? "행사 일시가 저장되었습니다. 게시된 안내도 확인해 주세요." : ""}
      </div>
      {showScheduleReview ? (
        <section className={styles.scheduleReview} aria-labelledby="schedule-review-title">
          <h3 id="schedule-review-title" className={styles.blockTitle}>참가자에게 보이는 안내도 확인해 주세요</h3>
          <p>행사 일시는 저장됐지만, 기존에 게시한 프로그램 일정과 공지·장소 안내는 그대로입니다. 여러 날짜에 진행하는 일정일 수 있으니 내용을 확인하고 필요한 경우에만 수정·게시하세요.</p>
          <div className={styles.scheduleReviewLinks}>
            {canWriteEvent(capabilities, "program.save") ? <ProductLink className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/content#content-program`}>프로그램 일정 확인</ProductLink> : null}
            {canWriteEvent(capabilities, "notice.save") ? <ProductLink className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/content#content-notices`}>공지 확인</ProductLink> : null}
            {canWriteEvent(capabilities, "venue.save") ? <ProductLink className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/content#content-venue`}>장소 안내 확인</ProductLink> : null}
          </div>
          {!canWriteEvent(capabilities, "program.save") || !canWriteEvent(capabilities, "notice.save") ? <p>확인할 권한이 없는 안내는 담당 운영자에게 검토를 요청하세요.</p> : null}
        </section>
      ) : null}
      <div className={styles.workPanels}>
      <section
        id="panel-settings-intake"
        data-settings-section="intake"
        className={highlight === "intake" ? styles.sectionFlash : undefined}
      >
      <ConsoleSection headingId="settings-intake" title="참가 접수" heading="rule" surface="panel">
        <div className={styles.intakeGrid}>
        <div className={styles.intakeStatus}>
        {!canWriteIntake ? (
          <p className={styles.help} role="note">{intakeNoWriteReason}</p>
        ) : null}
        <div className={`${styles.intakeBand} ${state.registrationOpen ? styles.bandOpen : styles.bandClosed}`}>
          <span className={styles.bandDot} data-open={state.registrationOpen} aria-hidden="true" />
          <p className={styles.intakeSummary}>
            {currentStage === "READY" || currentStage === "LIVE" ? (
              <>현재 {state.registrationOpen ? "접수 중" : "접수 닫힘"} · 게시된 양식 버전 {state.publishedVersion}</>
            ) : (
              // DRAFT/ENDED cannot publicly accept no matter the flag, so the
              // stored line names itself as a setting; the acceptance line
              // below carries the honest public state.
              <>현재 {state.registrationOpen ? "접수 중" : "접수 닫힘"} (설정) · 게시된 양식 버전 {state.publishedVersion}</>
            )}
          </p>
          {state.registrationOpen ? (
            <>
            <ProductButton
              type="button"
              className="button button-quiet"
              disabled={settingsLocked || Boolean(intakeConflict) || archived || !canWriteIntake}
              title={archived ? archivedReason : !canWriteIntake ? intakeNoWriteReason : undefined}
              onClick={() => setCloseIntakeConfirm(true)}
            >
              접수 닫기
            </ProductButton>
            {closeIntakeConfirm ? <ConsoleConfirm
              summary="접수를 닫으면 새 신청을 받지 않습니다. 이미 접수된 참가자와 티켓은 유지됩니다. 접수를 닫을까요?"
              confirmLabel="접수 닫기"
              onConfirm={() => { setCloseIntakeConfirm(false); void runCommand("form.close", {}, "접수를 닫았습니다.", "intake"); }}
              onCancel={() => setCloseIntakeConfirm(false)}
            /> : null}
            </>
          ) : null}
        </div>
        {isRecoveryBlocked(verificationMode) && !state.recoveryContact ? (
          <ConsoleFeedback kind="warning">
            <p className={styles.intakeWarningText}>문자로 티켓을 다시 연결할 수 없고 참가자에게 표시되는 문의처도 없습니다. 탭을 잃은 참가자가 도움을 받을 수 있도록 장소 안내의 문의 정보와 참가자 페이지의 공개 설정을 확인하세요.</p>
            <ProductLink variant="ghost" className={styles.intakeWarningLink} href={`/console/events/${encodeURIComponent(eventId)}/content#content-venue`}>장소 안내의 문의 정보</ProductLink>
          </ConsoleFeedback>
        ) : null}
        {currentStage === "DRAFT" && !state.registrationOpen ? (
          <p className={styles.help} role="note">
            공개 접수: 닫힘 — 기획 단계에서는 공개 페이지가 열리지 않습니다. 접수를 열려면 양식을 게시하고,{" "}
            <a href="#settings-stage">진행 단계에서 운영 준비 단계로 전환</a>하세요.
          </p>
        ) : null}
        {currentStage === "DRAFT" && state.registrationOpen ? (
          <p className={styles.help} role="note">
            공개 접수: 닫힘 — 기획 단계에서는 공개 페이지가 열리지 않아 참가 신청을 받을 수 없습니다.{" "}
            <a href="#settings-stage">진행 단계에서 운영 준비 단계로 전환</a>하면 게시된 양식대로 접수가 열립니다.
          </p>
        ) : null}
        {currentStage === "ENDED" && state.registrationOpen ? (
          <p className={styles.help} role="note">
            공개 접수: 닫힘 — 종료된 행사에서는 신청을 받을 수 없습니다. 공개 신청 화면은 닫혀 있습니다. 보관하려면 접수를 닫으세요.
          </p>
        ) : null}
        </div>
        <section className={styles.formPreview} aria-label={formPreviewTitle}>
          <div className={styles.previewHead}>
            <b>{formPreviewTitle}</b>
            <ProductLink variant="ghost" className={styles.intakeFieldsLink} href={`/console/events/${encodeURIComponent(eventId)}/settings/fields`}>신청 항목 편집</ProductLink>
          </div>
          {formPreviewFields?.length ? (
            <ul className={styles.previewFields}>
              {formPreviewFields.map((field, index) => (
                <li key={`${field.label}-${index}`}>{field.label}{field.required ? " *" : ""}</li>
              ))}
            </ul>
          ) : (
            <p className={styles.help}>{formPreviewFields ? "등록된 신청 항목이 없습니다. 항목 편집에서 추가하세요." : "게시된 항목을 확인하지 못했습니다. 신청 항목 편집에서 최신 게시본을 확인하세요."}</p>
          )}
        </section>
        <div className={styles.intakeCompose}>
        {intakeConflict ? <section className={styles.conflict} aria-labelledby="intake-conflict-heading">
          <h3 id="intake-conflict-heading" tabIndex={-1} className={styles.blockTitle}>다른 작업에서 참가 접수 설정이 변경됐습니다</h3>
          <p>이번 게시 요청은 반영되지 않았습니다. 작성 중인 안내는 그대로 있습니다. 최신 설정을 확인하고 사용할 안내를 선택해 주세요.</p>
          {intakeConflict.error ? <p role="alert">{intakeConflict.error}</p> : null}
          {intakeConflict.latest ? <>
            <div className={styles.conflictComparison}>
              <div><strong>최신 동의 안내</strong><p>{intakeConflict.latest.consentText || "등록된 안내 없음"}</p></div>
              <div><strong>내가 작성 중인 안내</strong><p>{consentText || "입력된 안내 없음"}</p></div>
            </div>
            <div>
              <strong>게시될 신청 항목 {intakeConflict.latest.fields.length}개</strong>
              <ul className={styles.conflictFields}>{intakeConflict.latest.fields.map((field, index) => <li key={index}>
                {field.label} · {field.required ? "필수" : "선택"} · {({ text: "텍스트", email: "이메일", select: "선택형", checkbox: "체크" } as Record<string, string>)[field.type] || field.type}
                {field.options.length ? ` (${field.options.join(", ")})` : ""}
              </li>)}</ul>
            </div>
            <p className={styles.help}>게시하면 최신 신청 항목과 선택한 안내가 적용됩니다.</p>
            <div className={styles.recoveryActions}>
              <ProductButton type="button" className="button button-secondary" disabled={settingsLocked} onClick={() => resolveIntakeConflict(false)}>내 작성 내용으로 계속</ProductButton>
              <ProductButton type="button" className="button button-secondary" disabled={settingsLocked} onClick={() => resolveIntakeConflict(true)}>최신 안내 사용</ProductButton>
            </div>
            <p className={styles.help}>선택만으로 게시되지 않습니다.</p>
          </> : <ProductButton type="button" className="button button-secondary" disabled={intakeConflict.loading || settingsLocked} onClick={() => void readLatestIntake()}>{intakeConflict.loading ? "최신 설정 확인 중…" : "최신 설정 확인"}</ProductButton>}
        </section> : null}
        <div className={uiStyles.formStack}>
          <div>
            <label htmlFor="set-consent">정보 수집 동의 안내</label>
            <textarea data-resize-none="true"
              id="set-consent"
              rows={3}
              value={consentText}
              onChange={(event) => {
                setConsentText(event.target.value);
                if (failure?.field === "consentText") { setFailure(null); setIntakeStatus(null); }
              }}
              aria-invalid={invalid("consentText") || undefined}
              aria-describedby={failure?.field === "consentText" ? "settings-consent-error" : undefined}
              disabled={!canWriteIntake || archived || settingsLocked}
            />
            {failure?.field === "consentText" ? <>
              <p className={styles.fieldError} id="settings-consent-error">{failure.message}</p>
              {state.consentText && !consentText.trim() ? <ProductButton type="button" className={`button button-secondary ${styles.fieldRecovery}`} disabled={settingsLocked || !canWriteIntake || archived} onClick={() => {
                setConsentText(state.consentText);
                setFailure(null);
                setIntakeStatus(null);
                window.requestAnimationFrame(() => document.getElementById("set-consent")?.focus());
              }}>기존 안내 되돌리기</ProductButton> : null}
            </> : null}
          </div>
          <ConsoleFormActions sticky>
            <span className={styles.barSection}>참가 접수</span>
            {/* 게시 버튼은 항상 둔다. 신청 항목은 별도 페이지에서 바뀌어
                동의 문구가 그대로어도 게시할 일이 있다(버전이 바뀌면 게시
                검토에서 충돌로 알려준다). 바뀐 게 있으면 "변경 게시"라고
                부른다. */}
            <ProductButton
              type="button"
              className="button button-primary"
              disabled={settingsLocked || Boolean(intakeConflict) || archived || !canWriteIntake || endedPublishBlocked}
              title={archived ? archivedReason : !canWriteIntake ? intakeNoWriteReason : endedPublishBlocked ? endedPublishReason : undefined}
              onClick={requestFormPublish}
            >
              {busy ? "처리 중입니다" : !state.registrationOpen ? "양식 게시·접수 열기" : intakeDirty ? "변경 게시" : "양식 게시·접수 열기"}
            </ProductButton>
            {!state.registrationOpen ? (
              <p role="status" className={styles.help}>
                {endedPublishBlocked
                  ? "접수가 닫혀 있습니다."
                  : "접수가 닫혀 있습니다. 다시 열려면 양식을 게시하세요."}
              </p>
            ) : null}
            {endedPublishBlocked ? (
              <p className={styles.help} role="note">{endedPublishReason}</p>
            ) : null}
            {intakeDirty ? (
              <span role="status" className={styles.unsavedTag}>
                <StatusPill tone="wait" size="sm" dot>저장 안 됨</StatusPill>
              </span>
            ) : null}
          </ConsoleFormActions>
          {sectionStatusLine(intakeStatus, "intake")}
        </div>
        </div>
        </div>
      </ConsoleSection>
      </section>

      <section
        id="panel-settings-features"
        data-settings-section="features"
        className={highlight === "features" ? styles.sectionFlash : undefined}
      >
      <ConsoleSection headingId="settings-features" title="운영 기능" heading="rule" surface="panel">
        {!canWriteSettings ? (
          <p className={styles.help} role="note">{settingsNoWriteReason}</p>
        ) : null}
        <p className={styles.help}>끈 기능은 콘솔 메뉴와 참가자 화면에서 함께 사라집니다. 기존 응답과 기록은 삭제되지 않습니다.</p>
        <p className={styles.help}>행사장 출력을 끄면 열린 전광판도 다음 확인 때 멈춥니다. 다시 켜면 저장된 출력을 표시합니다.</p>
        <p className={styles.featureSummary}>{featureOnCount}개 켜짐 · {featureTotal - featureOnCount}개 꺼짐</p>
        {featuresConflict ? <section className={styles.conflict} aria-labelledby="features-conflict-heading">
          <h3 id="features-conflict-heading" tabIndex={-1} className={styles.blockTitle}>다른 작업에서 운영 기능이 변경됐습니다</h3>
          <p>이번 저장 요청은 반영되지 않았습니다. 선택 중인 기능은 그대로 있습니다. 최신 설정과 비교해 사용할 선택을 정해 주세요.</p>
          {featuresConflict.error ? <p role="alert">{featuresConflict.error}</p> : null}
          {featuresConflict.latest ? <>
            <table className={styles.settingsComparison}>
              <caption>최신 설정과 내가 선택한 운영 기능 비교</caption>
              <thead><tr><th scope="col">기능</th><th scope="col">최신 설정</th><th scope="col">내 선택</th></tr></thead>
              <tbody>{FEATURES.map((feature) => <tr key={feature.id} className={featuresConflict.latest?.includes(feature.id) !== features.includes(feature.id) ? styles.comparisonChanged : undefined}>
                <th scope="row">{feature.label}{featuresConflict.latest?.includes(feature.id) !== features.includes(feature.id) ? <span className={styles.comparisonDifference}>다름</span> : null}</th>
                <td>{featuresConflict.latest?.includes(feature.id) ? "켜짐" : "꺼짐"}</td>
                <td>{features.includes(feature.id) ? "켜짐" : "꺼짐"}</td>
              </tr>)}</tbody>
            </table>
            <p className={styles.help}>내 선택으로 계속한 뒤 저장하면 다른 운영자가 바꾼 기능도 포함해, 위의 내 선택 전체가 적용됩니다. 화면에서 변경할 수 없는 기존 기능은 최신 설정을 유지합니다.</p>
            <div className={styles.recoveryActions}>
              <ProductButton type="button" className="button button-secondary" disabled={settingsLocked} onClick={() => resolveFeaturesConflict(false)}>내 선택으로 계속</ProductButton>
              <ProductButton type="button" className="button button-secondary" disabled={settingsLocked} onClick={() => resolveFeaturesConflict(true)}>최신 설정 사용</ProductButton>
            </div>
            <p className={styles.help}>선택만으로 저장되지 않습니다. 필요한 기능을 수정한 뒤 직접 저장해 주세요.</p>
          </> : <ProductButton type="button" className="button button-secondary" disabled={featuresConflict.loading || settingsLocked} onClick={() => void readLatestFeatures()}>{featuresConflict.loading ? "최신 설정 확인 중…" : "최신 설정 확인"}</ProductButton>}
        </section> : null}
        <fieldset className={styles.featureGroups} disabled={!canWriteSettings || archived || settingsLocked}>
          <legend id="settings-features-legend" tabIndex={-1}>사용할 기능</legend>
          {FEATURE_GROUPS.map((group) => (
            <div key={group.label} className={styles.featureGroup}>
              <p className={styles.featureGroupLabel}>
                {group.label}
                <span className={styles.featureGroupCount}>{group.ids.filter((id) => features.includes(id)).length} / {group.ids.length} 켜짐</span>
              </p>
              <div className={styles.featureGrid}>
                {group.ids.map((id) => {
                  const feature = FEATURES.find((item) => item.id === id);
                  if (!feature) return null;
                  return (
                    <label key={feature.id} className={styles.check}>
                      <input
                        type="checkbox"
                        checked={features.includes(feature.id)}
                        onChange={(event) => {
                          setFeatures((prev) => {
                            const list = prev ?? [];
                            return event.target.checked
                              ? [...list, feature.id]
                              : list.filter((item) => item !== feature.id);
                          });
                        }}
                      />
                      {feature.label}
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </fieldset>
        <ConsoleFormActions sticky>
          <span className={styles.barSection}>운영 기능</span>
          {featuresDirty ? (
            <span role="status" className={styles.unsavedTag}>
              <StatusPill tone="wait" size="sm" dot>저장 안 된 변경{featureChangeCount > 0 ? ` ${featureChangeCount}개` : ""}</StatusPill>
            </span>
          ) : null}
          {featuresDirty ? (
            <ProductButton
              type="button"
              className="button button-quiet"
              disabled={settingsLocked || Boolean(featuresConflict) || archived || !canWriteSettings}
              onClick={() => { setFeatures(state.features); setFeaturesStatus(null); }}
            >
              되돌리기
            </ProductButton>
          ) : null}
          <ProductButton
            type="button"
            className="button button-primary"
            disabled={settingsLocked || Boolean(featuresConflict) || archived || !canWriteSettings}
            title={archived ? archivedReason : !canWriteSettings ? settingsNoWriteReason : undefined}
            onClick={() => { if (!featuresConflict) void runCommand("event.features", { features, expectedFeatures: state.features }, "운영 기능 설정을 저장했습니다.", "features"); }}
          >
            {busy ? "저장 중입니다" : "운영 기능 저장"}
          </ProductButton>
        </ConsoleFormActions>
        {sectionStatusLine(featuresStatus, "features")}
      </ConsoleSection>
      </section>
      </div>

      <div className={styles.settingsFooter}>
        <ProductLink
          className="button button-secondary"
          href={`/console/events/${encodeURIComponent(eventId)}`}
        >
          현황으로 돌아가기
        </ProductLink>
        {lastResult ? (
          <p
            role="status"
            className={`${styles.footerResult} ${lastResult.kind === "error" ? styles.footerResultError : styles.footerResultSuccess}`}
          >
            {lastResult.message}
            {"at" in lastResult && lastResult.at ? ` · ${lastResult.at}` : ""}
          </p>
        ) : (
          <p className={styles.footerResult}>저장·게시·전환 결과는 각 구역과 여기에 표시됩니다.</p>
        )}
      </div>

      {/* 꾸미기는 선택 사항이므로 탭 과업과 복귀 흐름 사이에 별도 섹션을 두지 않고
          푸터 뒤의 종속 안내로 둔다. 두 번째 primary를 두지 않는다. */}
      <details className={styles.pageDisclosure} id="settings-page">
        <summary data-disclosure-indicator="">
          참가자 페이지 · 선택 사항 · {state.pagePublishedAt
            ? `게시 버전 ${state.pagePublishedVersion}${state.pageDraftVersion > state.pagePublishedVersion ? " · 새 초안" : ""}`
            : `초안 ${state.pageDraftVersion} · 미게시`}
        </summary>
        <div className={styles.pageFold}>
          <p>
            {state.pagePublishedAt
              ? `초안 ${state.pageDraftVersion} · 게시 버전 ${state.pagePublishedVersion} · 최근 게시 ${formatPublishedAt(state.pagePublishedAt)}`
              : `초안 ${state.pageDraftVersion} · 아직 게시하지 않음`}
          </p>
          <p className={styles.help}>
            소개·강조색·노출 항목과 디자인은 참가자 페이지 편집기에서 저장·게시합니다. 이 화면에서는 바꾸지 않습니다.
            게시하지 않아도 공개·접수·진행에 영향이 없습니다.
          </p>
          <p>
            <ProductLink
              className="button button-secondary"
              href={`/console/events/${encodeURIComponent(eventId)}/page`}
            >
              참가자 페이지 편집으로 이동
            </ProductLink>
          </p>
        </div>
      </details>
      </div>
      </div>
    </ConsolePage>
  );
}
