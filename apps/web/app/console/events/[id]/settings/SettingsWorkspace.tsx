"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { eventStageClassName, eventStageLabel } from "../../../../event-stage";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import uiStyles from "../../../console-ui/console-ui.module.css";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import StageTransitionConfirmation from "../../../console-ui/StageTransitionConfirmation";
import styles from "./settings.module.css";
import { readCloseReturn, readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";
import { useEventCloseHandoff } from "../../../use-event-close-handoff";

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
  { label: "참여 프로그램", ids: ["poll", "quiz", "qa", "draw", "survey", "stamp"] },
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
  clients: Array<{ id: string; name: string }>;
  canManageEvent: boolean;
  deskCount: number;
  deskAssignmentCount: number;
  openModules: number;
  basics: Basics;
  features: string[];
  registrationOpen: boolean;
  publishedVersion: number;
  consentText: string;
  pageDraftVersion: number;
  pagePublishedVersion: number;
  pagePublishedAt: string;
};
type State = { kind: "loading" } | { kind: "failed"; message: string } | Ready;

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

// 408 and 5xx leave the outcome unknown: the server may have applied the
// command before the response was lost. A missing or unparsable body is
// equally ambiguous. Definitive 4xx responses (validation, conflicts, auth)
// mean the command did not apply, so a corrected retry needs a fresh id.
function isAmbiguousFailure(status: number, body: unknown): boolean {
  return status === 408 || status >= 500 || body === null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
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

type SectionStatus = {
  kind: "success" | "error";
  message: string;
  at: string;
};

const SETTINGS_SECTION_LABEL: Record<SettingsSectionId, string> = {
  basics: "기본 정보",
  intake: "참가 접수",
  features: "운영 기능",
};

// 네 개의 실제 탭. 다섯 번째였던 참가자 페이지는 탭이 아니라 탭 아래 보조
// 구역으로 둔다(꾸미기는 선택 사항). 앵커 id(settings-*)는 기존 딥링크와
// closeStep 복귀 흐름이 그대로 쓰므로 바꾸지 않는다.
type SettingsTabId = "basics" | "intake" | "features" | "stage";

const SETTINGS_TABS: Array<{ id: SettingsTabId; anchor: string; label: string }> = [
  { id: "basics", anchor: "settings-basics", label: "기본 정보" },
  { id: "intake", anchor: "settings-intake", label: "참가 접수" },
  { id: "features", anchor: "settings-features", label: "운영 기능" },
  { id: "stage", anchor: "settings-stage", label: "진행 단계" },
];

const TAB_ANCHORS: Record<SettingsTabId, string> = {
  basics: "settings-basics",
  intake: "settings-intake",
  features: "settings-features",
  stage: "settings-stage",
};

function tabFromHash(hash: string): SettingsTabId | null {
  const key = hash.startsWith("#") ? hash.slice(1) : hash;
  const found = SETTINGS_TABS.find((tab) => tab.anchor === key);
  return found ? found.id : null;
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
  const closeHref = useEventCloseHandoff(eventId);
  const closeLandingRef = useRef<string | null>(null);
  // 선형 마감 "다음" 인계로 예약된 제목 포커스. 렌더 뒤 효과에서 소비한다.
  const pendingHeadingFocusRef = useRef<SettingsTabId | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Per-section save state shown in place ("기본 정보를 저장했습니다 · HH:MM").
  // The page-top ConsoleFeedback strip is kept for the latest page-level
  // result; these lines persist per section with a timestamp instead of
  // adding another global banner.
  const [basicsStatus, setBasicsStatus] = useState<SectionStatus | null>(null);
  const [intakeStatus, setIntakeStatus] = useState<SectionStatus | null>(null);
  const [featuresStatus, setFeaturesStatus] = useState<SectionStatus | null>(null);
  // 선택된 탭. 전환해도 패널은 마운트된 채 hidden으로만 가리므로 초안이 유지된다.
  const [activeTab, setActiveTab] = useState<SettingsTabId>(
    () => tabFromHash(typeof window === "undefined" ? "" : window.location.hash) ?? "basics"
  );
  const tabButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageConfirm, setStageConfirm] = useState(false);
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
  // Live mirrors of the independently dirty sections and their server
  // baselines. A reload after saving one section (or after a stage
  // transition) only overwrites the sections the operator has not edited,
  // so unrelated form values survive the refresh.
  const liveRef = useRef<{
    state: State;
    basics: Basics | null;
    features: string[] | null;
    consentText: string;
  }>({ state: { kind: "loading" }, basics: null, features: null, consentText: "" });

  const [basics, setBasics] = useState<Basics | null>(null);
  const [features, setFeatures] = useState<string[] | null>(null);
  const [consentText, setConsentText] = useState("");

  useEffect(() => {
    liveRef.current = { state, basics, features, consentText };
  });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // The actor comes from the session (/api/auth/me), not from the
        // account directory: gating on "any manager exists" projected the
        // wrong permission onto signed-in staff. This mirrors the current
        // server role+membership semantics; the server stays authoritative.
        const [meRes, bootRes] = await Promise.all([
          fetch("/api/auth/me", { cache: "no-store" }),
          fetch("/api/bootstrap", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (meRes.status === 401 || bootRes.status === 401) {
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
              publishedVersion?: unknown;
              consentText?: unknown;
              pageExperience?: unknown;
              desks?: unknown;
              assignments?: unknown;
              modules?: unknown;
            }>;
          } | null;
        } | null;
        const bootstrap = bootData?.state;
        if (!meRes.ok || !bootRes.ok || !user || !bootstrap) {
          setState({ kind: "failed", message: "행사 설정을 불러오지 못했습니다." });
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
          setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
          return;
        }
        const clients = Array.isArray(bootstrap.clients)
          ? bootstrap.clients.map(record).filter((item): item is Record<string, unknown> => item !== null)
          : [];
        const clientName = text(clients.find((client) => client.id === event.clientId)?.name);
        const venue = record(workspace.venue);
        const venueName = text(venue?.name);
        const role = text(user.role);
        const myId = text(user.id);
        const memberships = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((value) => {
              const item = record(value);
              if (!item || typeof item.accountId !== "string" || typeof item.eventId !== "string") return [];
              return [{ accountId: item.accountId, eventId: item.eventId }];
            })
          : [];
        // Display gate only: AGENCY everywhere, MANAGER on their own events.
        // The server still authorizes every settings command.
        const canManageEvent = role === "AGENCY" || (role === "MANAGER" && memberships.some(
          (membership) => membership.accountId === myId && membership.eventId === eventId
        ));
        const desks = Array.isArray(workspace.desks) ? workspace.desks : [];
        const assignments = Array.isArray(workspace.assignments) ? workspace.assignments : [];
        const modules = Array.isArray(workspace.modules) ? workspace.modules : [];
        const deskAssignmentCount = assignments.filter((item) => record(item)?.type === "DESK").length;
        const openModules = modules.filter((item) => record(item)?.status === "OPEN").length;
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
        setState({
          kind: "ready",
          closeSnapshot: readCloseSnapshot(event, workspace),
          stage: text(event.stage).toUpperCase(),
          eventMeta: buildEventMeta(clientName, newBasics, venueName),
          clientName,
          venueName,
          clients: clients
            .map((client) => ({ id: text(client.id), name: text(client.name) }))
            .filter((client) => client.id !== ""),
          canManageEvent,
          deskCount: desks.length,
          deskAssignmentCount,
          openModules,
          basics: newBasics,
          features: newFeatures,
          registrationOpen: workspace.registrationOpen === true,
          publishedVersion: Number(workspace.publishedVersion) || 0,
          consentText: newConsentText,
          pageDraftVersion,
          pagePublishedVersion,
          pagePublishedAt: text(pageExperience.publishedAt),
        });
        // Preserve independent dirty sections: a local form that differs from
        // its previous server baseline keeps the operator's edits; a clean
        // form takes the fresh server values.
        const live = liveRef.current;
        const previous = live.state.kind === "ready"
          ? { basics: live.state.basics, features: live.state.features, consentText: live.state.consentText }
          : null;
        setBasics(
          previous && live.basics && JSON.stringify(live.basics) !== JSON.stringify(previous.basics)
            ? live.basics
            : newBasics
        );
        setFeatures(
          previous && live.features && JSON.stringify(live.features) !== JSON.stringify(previous.features)
            ? live.features
            : newFeatures
        );
        setConsentText(
          previous && live.consentText !== previous.consentText ? live.consentText : newConsentText
        );
      } catch {
        if (!cancelled) {
          setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
        }
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
    JSON.stringify(features) !== JSON.stringify(state.features);
  const sectionsDirty = Boolean(basicsDirty || intakeDirty || featuresDirty);
  // 탭별 미저장 표시. stage 탭은 확인 대기 중인 전환이 있을 때만 표시한다.
  const tabDirty: Record<SettingsTabId, boolean> = {
    basics: basicsDirty,
    intake: intakeDirty,
    features: featuresDirty,
    stage: stageConfirm,
  };
  const pendingIntent =
    stageCommandIdRef.current !== null || commandIdCache.current.size > 0;
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
    : "저장하지 않은 행사 설정 변경이나 응답을 확인하지 못한 요청이 있습니다. 페이지를 떠나면 사라집니다.";
  useConsoleDraftGuard(
    sectionsDirty || pendingIntent,
    guardReason
  );

  // 해시→탭 동기화. 딥링크·뒤로/앞으로·closeStep 복귀가 같은 앵커를 쓰고,
  // 탭 전환은 해시를 갱신하므로 back으로 이전 탭에 돌아올 수 있다. 패널은
  // hidden으로만 가리므로 초안이 유지된다. closeStep 복귀 때만 기존처럼
  // 구역 제목으로 포커스를 옮기고, 그 외에는 포커스를 빼앗지 않는다.
  useEffect(() => {
    if (state.kind !== "ready") {
      if (state.kind === "failed") closeLandingRef.current = null;
      return;
    }
    const syncTab = () => {
      const next = tabFromHash(window.location.hash);
      if (next) setActiveTab((current) => (current === next ? current : next));
    };
    syncTab();
    const anchor = window.location.hash;
    const returnHref = readCloseReturn(new URLSearchParams(window.location.search).get("closeReturn"), eventId);
    let frame = 0;
    if (returnHref && anchor && anchor !== "#settings-basics" && tabFromHash(anchor)) {
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
    window.addEventListener("hashchange", syncTab);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", syncTab);
    };
  }, [state, eventId]);

  // 선형 마감 "다음" 인계의 제목 포커스. 패널이 렌더된 뒤에 실행하므로
  // 숨은 제목에 대한 no-op이 되지 않는다. 캡처 리스너가 "다음" 활성화
  // 순간에만 예약하며, 탭 키보드 이동·뒤로/앞으로·일반 딥링크에서는
  // 예약되지 않으므로 탭 포커스를 유지한다. 예약과 선택이 어긋나면
  // (이미 같은 탭 등) 포커스를 옮기지 않고 표시만 버린다.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const pending = pendingHeadingFocusRef.current;
    pendingHeadingFocusRef.current = null;
    if (!pending || pending !== activeTab) return;
    const heading = document.getElementById(TAB_ANCHORS[pending]);
    if (!heading || heading.closest("[hidden]")) return;
    heading.setAttribute("tabindex", "-1");
    heading.scrollIntoView({ block: "start" });
    heading.focus({ preventScroll: true });
  }, [state, activeTab]);

  // 선형 마감 "다음" 활성화 의도의 캡처. 공유 EventCloseReturn의 핸들러와
  // 네이티브 앵커 기본 동작보다 먼저 실행되므로, 해시 변경 때 이미 body로
  // 돌아간 activeElement를 읽는 방식과 달리 의도를 놓치지 않는다. 키보드
  // Enter의 네이티브 클릭도 여기로 들어온다. 이미 선택된 탭을 가리키면
  // 예약하지 않는다(같은 해시는 상태 변경·효과를 일으키지 않아 표시가
  // 남고, 나중의 무관한 저장 후 재렌더에서 포커스를 훔칠 수 있다. 같은 탭의
  // 제목 포커스는 공유 핸들러가 보이는 제목에 직접 수행한다). 탭 버튼·
  // 일반 앵커·히스토리는 이 표시를 세우지 않는다.
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
      const tab = tabFromHash(hash);
      if (!tab || tab === activeTab) return;
      if (!readCloseReturn(new URLSearchParams(window.location.search).get("closeReturn"), eventId)) return;
      pendingHeadingFocusRef.current = tab;
    };
    document.addEventListener("click", onCaptureClick, true);
    return () => document.removeEventListener("click", onCaptureClick, true);
  }, [eventId, activeTab]);

  // A 2xx with a missing or misshapen body proves nothing: {} and [] are not
  // success. Known command shapes come from server/commands/preparation.js
  // via server/commands/domain.js (flat result.body, replayed identically
  // from command_receipts); anything else stays ambiguous and keeps the
  // idempotency id for a safe retry.
  function isProvenResponse(command: string, data: Record<string, unknown>, expectedStage?: string): boolean {
    switch (command) {
      case "event.update": {
        const event = record(data.event);
        return event !== null && text(event.id) === eventId;
      }
      case "event.features":
        return Array.isArray(data.features) && data.features.every((feature) => typeof feature === "string");
      case "form.publish": {
        const publishedVersion = Number(data.publishedVersion);
        return Number.isSafeInteger(publishedVersion) && publishedVersion > 0;
      }
      case "form.close":
        return data.registrationOpen === false;
      case "event.stage": {
        const event = record(data.event);
        return (
          event !== null &&
          text(event.id) === eventId &&
          (expectedStage === undefined || text(event.stage).toUpperCase() === expectedStage)
        );
      }
      default:
        return true;
    }
  }

  async function runCommand(
    command: string,
    payload: Record<string, unknown>,
    successMessage: string,
    section: SettingsSectionId
  ): Promise<boolean> {
    if (busy || operationsBusyRef.current) return false;
    // Archived events reject every command server-side; the disabled buttons
    // already prevent this path, and the server stays authoritative either way.
    if (archived) return false;
    operationsBusyRef.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    const setSectionStatus =
      section === "basics" ? setBasicsStatus : section === "intake" ? setIntakeStatus : setFeaturesStatus;
    const fingerprint = `${command}:${stableStringify(payload)}`;
    let commandId = commandIdCache.current.get(fingerprint);
    if (!commandId) {
      commandId = randomCommandId();
      commandIdCache.current.set(fingerprint, commandId);
    }
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, payload }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || data === null) {
        const status = res.status;
        if (!res.ok && !isAmbiguousFailure(status, data)) {
          // Definitive rejection: the command did not apply, so a corrected
          // retry needs a fresh id. Editing is preserved for the fix.
          commandIdCache.current.delete(fingerprint);
          const message = typeof data?.error === "string" ? data.error : "처리하지 못했습니다.";
          setFailure({
            message,
            field: typeof data?.field === "string" ? data.field : undefined,
          });
          setSectionStatus({ kind: "error", message, at: formatClockNow() });
        } else {
          // Ambiguous network/5xx/malformed response: keep the id so a retry
          // replays the same request instead of applying it twice.
          const message = "응답을 확인하지 못했습니다. 입력한 내용을 유지한 채 같은 요청으로 다시 시도하세요.";
          setFailure({
            message,
            field: data !== null && typeof data.field === "string" ? data.field : undefined,
          });
          setSectionStatus({ kind: "error", message, at: formatClockNow() });
        }
        setNotice(null);
        return false;
      }
      if (!isProvenResponse(command, data)) {
        // Success status but unusable body: stay ambiguous and keep the id.
        const message = "처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.";
        setFailure({ message });
        setSectionStatus({ kind: "error", message, at: formatClockNow() });
        setNotice(null);
        return false;
      }
      commandIdCache.current.delete(fingerprint);
      setNotice(successMessage);
      setSectionStatus({ kind: "success", message: successMessage, at: formatClockNow() });
      // Reload through the shared loader; liveRef keeps the sections the
      // operator edited elsewhere from being overwritten.
      setReloadTick((tick) => tick + 1);
      return true;
    } catch {
      // Transport failure: the server may still have applied the command.
      const message = "연결하지 못했습니다. 같은 요청으로 다시 시도하세요.";
      setFailure({ message });
      setSectionStatus({ kind: "error", message, at: formatClockNow() });
      setNotice(null);
      return false;
    } finally {
      operationsBusyRef.current = false;
      setBusy(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="settings" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="행사 설정을 불러오고 있습니다." onRetry={() => {}} />
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
        <ConsoleStatePanel kind="loading" message="행사 설정을 준비하고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }

  const invalid = (field: string) => failure?.field === field;
  const describedBy = (field: string) =>
    failure?.field === field ? "settings-error" : undefined;

  const currentStage = state.stage.toUpperCase();
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
  const stagePrecondition = nextStage === "LIVE" && (state.deskCount === 0 || state.deskAssignmentCount === 0)
    ? "진행 중 전환에는 등록 데스크와 데스크 배정이 필요합니다. 배정은 출근 확인이 아닙니다."
    : nextStage === "ARCHIVED" && (state.registrationOpen || state.openModules > 0)
      ? "보관하려면 접수를 닫고 진행 중인 참여 프로그램을 모두 닫아야 합니다."
      : null;
  // A known-failing transition is blocked before confirmation instead of
  // sent to the server for a predictable rejection. Server rules stay
  // authoritative; this only avoids the wasted round trip.
  const stageBlocked = stagePrecondition !== null;
  // 보관된 행사는 서버가 모든 쓰기를 거부하므로 쓰기 affordance를 미리
  // 잠그고 이유를 밝힌다. 조회는 그대로 둔다.
  const archived = currentStage === "ARCHIVED";
  const archivedReason = "보관된 행사는 읽기 전용입니다";

  function sectionStatusLine(status: SectionStatus | null, section: SettingsSectionId) {
    if (!status) return null;
    return (
      <p
        role="status"
        data-settings-section-status={section}
        className={`${styles.sectionStatus} ${status.kind === "error" ? styles.sectionStatusError : styles.sectionStatusSuccess}`}
      >
        {status.message} · {status.at}
      </p>
    );
  }

  async function submitStageTransition() {
    if (state.kind !== "ready" || !state.canManageEvent || !nextStage || stageBusy || operationsBusyRef.current || !stageConfirm || stageBlocked) return;
    const label = eventStageLabel(nextStage);
    if (!stageCommandIdRef.current) stageCommandIdRef.current = randomCommandId();
    operationsBusyRef.current = true;
    setStageBusy(true);
    setStageError(null);
    setStageNotice(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: stageCommandIdRef.current,
          command: "event.stage",
          payload: { stage: nextStage },
        }),
      });
      const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (!res.ok || data === null) {
        if (!res.ok && !isAmbiguousFailure(res.status, data)) {
          setStageError(typeof data?.error === "string" ? data.error : "단계를 전환하지 못했습니다.");
          setStageConfirm(false);
          stageCommandIdRef.current = null;
          return;
        }
        // Preserve the id and the confirmation so a retry can replay the
        // server receipt after a lost response.
        setStageError(
          data !== null && typeof data.error === "string"
            ? data.error
            : "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요."
        );
        return;
      }
      if (!isProvenResponse("event.stage", data, nextStage)) {
        // Success status but unusable body: stay ambiguous and keep the id.
        setStageError("처리 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.");
        return;
      }
      stageCommandIdRef.current = null;
      setStageNotice(`행사를 ${label}(으)로 전환했습니다.`);
      setStageConfirm(false);
      setReloadTick((tick) => tick + 1);
      // 셸의 행사 하위 메뉴와 단계 표시가 새 단계를 따라오도록 깨운다.
      // 개요 화면은 복귀 시 다시 bootstrap을 읽으므로 별도 처리가 필요 없다.
      window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
    } catch {
      // Preserve the id so a retry can replay the server receipt after a lost response.
      setStageError("연결하지 못했습니다. 같은 요청을 다시 시도하세요.");
    } finally {
      operationsBusyRef.current = false;
      setStageBusy(false);
    }
  }

  // 탭 키보드 이동: 화살표·Home·End는 포커스와 선택을 함께 옮긴다(자동 활성화).
  // 감사와 키보드 조작이 포커스된 탭의 선택을 기대하므로 수동 확정은 두지 않는다.
  // Enter·Space는 버튼의 기본 클릭으로 같은 탭을 다시 연다.
  function onTabKeyDown(event: React.KeyboardEvent) {
    const order = SETTINGS_TABS.map((tab) => tab.id);
    const buttons = tabButtonRefs.current;
    const focused = buttons.findIndex((button) => button === document.activeElement);
    const from = focused >= 0 ? focused : order.indexOf(activeTab);
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      next = (from + 1) % order.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      next = (from - 1 + order.length) % order.length;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = order.length - 1;
    }
    if (next !== null) {
      event.preventDefault();
      activateTab(order[next]);
      buttons[next]?.focus();
    }
  }

  function activateTab(tab: SettingsTabId) {
    setActiveTab(tab);
    const anchor = `#${TAB_ANCHORS[tab]}`;
    if (window.location.hash !== anchor) window.location.hash = anchor;
  }

  const latestSectionStatus = [basicsStatus, intakeStatus, featuresStatus].reduce<SectionStatus | null>(
    (latest, status) => {
      if (!status) return latest;
      if (!latest || status.at >= latest.at) return status;
      return latest;
    },
    null
  );
  const lastResult = failure
    ? { kind: "error" as const, message: failure.message }
    : notice
      ? { kind: "success" as const, message: notice }
      : latestSectionStatus;

  return (
    <ConsolePage
      pageId="settings"
      closeSnapshot={state.closeSnapshot}
      eventId={eventId}
      eventName={basics?.name || state.basics.name}
      meta={state.eventMeta}
      sectionNav={(
        <div role="tablist" aria-label="행사 설정 구역" className={styles.tabs} onKeyDown={onTabKeyDown}>
          {SETTINGS_TABS.map((tab, index) => {
            const selected = activeTab === tab.id;
            const dirty = tabDirty[tab.id];
            return (
              <button
                key={tab.id}
                type="button"
                role="tab"
                id={`tab-${tab.anchor}`}
                aria-selected={selected}
                aria-controls={`panel-${tab.anchor}`}
                tabIndex={selected ? 0 : -1}
                ref={(node) => {
                  tabButtonRefs.current[index] = node;
                }}
                className={styles.tab}
                data-settings-tab={tab.id}
                onClick={() => activateTab(tab.id)}
              >
                {tab.label}
                {dirty ? (
                  <>
                    <span className={styles.tabDirtyDot} aria-hidden="true">●</span>
                    <span className="sr-only"> 저장 안 됨</span>
                  </>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
      feedback={(
        <>
          {archived ? (
            <ConsoleFeedback kind="warning">
              보관된 행사는 읽기 전용입니다. 설정은 볼 수 있지만 저장·게시·전환할 수 없습니다.
            </ConsoleFeedback>
          ) : null}
          {failure ? <ConsoleFeedback kind="error" id="settings-error">{failure.message}</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
        </>
      )}
    >
      <p className={styles.scopeNote} data-settings-scope-note>
        각 구역의 저장·게시·전환은 그 구역에만 적용됩니다.
      </p>
      <div
        role="tabpanel"
        id="panel-settings-basics"
        aria-labelledby="tab-settings-basics"
        hidden={activeTab !== "basics"}
        className={styles.tabPanel}
      >
      <ConsoleSection headingId="settings-basics" title="기본 정보" width="form">
        <form
          className={uiStyles.formStack}
          onSubmit={(event) => {
            event.preventDefault();
            void runCommand("event.update", {
              name: basics.name,
              slug: basics.slug,
              clientId: basics.clientId,
              date: basics.date,
              start: basics.start,
              end: basics.end,
              capacity: Number(basics.capacity) || 0,
              price: Number(basics.price) || 0,
              approvalRequired: basics.approvalRequired,
              allowReentry: basics.allowReentry,
              verificationRequired: basics.verificationRequired,
            }, "기본 정보를 저장했습니다.", "basics");
          }}
        >
          <div className={uiStyles.formGrid}>
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
          <div className={`${uiStyles.formGrid} ${styles.scheduleFields}`}>
            <div>
              <label htmlFor="set-date">행사 날짜</label>
              <input
                id="set-date"
                type="date"
                value={basics.date}
                onChange={(event) => setBasics({ ...basics, date: event.target.value })}
                aria-invalid={invalid("date") || undefined}
                aria-describedby={describedBy("date") || undefined}
                required
              />
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
            <div>
              <label htmlFor="set-price">참가비 (원)</label>
              <input
                id="set-price"
                type="number"
                min={0}
                inputMode="numeric"
                value={basics.price}
                onChange={(event) => setBasics({ ...basics, price: event.target.value })}
                aria-invalid={invalid("price") || undefined}
                aria-describedby={describedBy("price") || undefined}
              />
            </div>
          </div>
          {Number(basics.price) > 0 ? (
            <p className={styles.help}>
              이 시스템은 결제를 처리하지 않습니다. 참가비는 참가자에게 청구되지 않으며, 수납이 필요하면
              행사 안내에서 별도 절차로 안내하세요.
            </p>
          ) : null}
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
          <p className={styles.help}>인증번호는 신청자의 휴대전화로 발송됩니다. 발송 준비가 안 된 상태에서는 신청이 막히므로, 먼저 인증번호 1건을 테스트하세요.</p>
          <ConsoleFormActions>
            <button
              type="submit"
              className="button button-primary"
              disabled={busy || archived}
              title={archived ? archivedReason : undefined}
            >
              {busy ? "저장 중입니다" : "기본 정보 저장"}
            </button>
            {basicsDirty ? (
              <span role="status" className={styles.unsavedTag}>
                <span aria-hidden="true">● </span>저장 안 됨
              </span>
            ) : null}
          </ConsoleFormActions>
          {sectionStatusLine(basicsStatus, "basics")}
        </form>
      </ConsoleSection>
      </div>

      <div
        role="tabpanel"
        id="panel-settings-intake"
        aria-labelledby="tab-settings-intake"
        hidden={activeTab !== "intake"}
        className={styles.tabPanel}
      >
      <ConsoleSection headingId="settings-intake" title="참가 접수" width="form">
        <p>
          현재 {state.registrationOpen ? "접수 중" : "접수 닫힘"} · 게시된 양식 버전 {state.publishedVersion}
        </p>
        <div className={uiStyles.formStack}>
          <div>
            <label htmlFor="set-consent">정보 수집 동의 안내</label>
            <textarea
              id="set-consent"
              rows={3}
              value={consentText}
              onChange={(event) => setConsentText(event.target.value)}
              aria-invalid={invalid("consentText") || undefined}
              aria-describedby={describedBy("consentText") || undefined}
            />
          </div>
          <ConsoleFormActions>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || archived}
              title={archived ? archivedReason : undefined}
              onClick={() => void runCommand(
                "form.publish",
                consentText ? { consentText } : {},
                "양식을 게시하고 접수를 열었습니다.",
                "intake"
              )}
            >
              {busy ? "처리 중입니다" : "양식 게시·접수 열기"}
            </button>
            {state.registrationOpen ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={busy || archived}
                title={archived ? archivedReason : undefined}
                onClick={() => void runCommand("form.close", {}, "접수를 닫았습니다.", "intake")}
              >
                접수 닫기
              </button>
            ) : (
              <p role="status" className={styles.help}>접수가 닫혀 있습니다. 다시 열려면 양식을 게시하세요.</p>
            )}
            {intakeDirty ? (
              <span role="status" className={styles.unsavedTag}>
                <span aria-hidden="true">● </span>저장 안 됨
              </span>
            ) : null}
          </ConsoleFormActions>
          {sectionStatusLine(intakeStatus, "intake")}
        </div>
      </ConsoleSection>
      </div>

      <div
        role="tabpanel"
        id="panel-settings-features"
        aria-labelledby="tab-settings-features"
        hidden={activeTab !== "features"}
        className={styles.tabPanel}
      >
      <ConsoleSection headingId="settings-features" title="운영 기능" width="form">
        <p className={styles.help}>끈 기능은 콘솔 메뉴와 참가자 화면에서 함께 사라집니다. 기존 응답과 기록은 삭제되지 않습니다.</p>
        <fieldset className={styles.featureGroups}>
          <legend>사용할 기능</legend>
          {FEATURE_GROUPS.map((group) => (
            <div key={group.label} className={styles.featureGroup}>
              <p className={styles.featureGroupLabel}>{group.label}</p>
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
        <ConsoleFormActions>
          <button
            type="button"
            className="button button-primary"
            disabled={busy || archived}
            title={archived ? archivedReason : undefined}
            onClick={() => void runCommand("event.features", { features }, "운영 기능 설정을 저장했습니다.", "features")}
          >
            {busy ? "저장 중입니다" : "운영 기능 저장"}
          </button>
          {featuresDirty ? (
            <span role="status" className={styles.unsavedTag}>
              <span aria-hidden="true">● </span>저장 안 됨
            </span>
          ) : null}
        </ConsoleFormActions>
        {sectionStatusLine(featuresStatus, "features")}
      </ConsoleSection>
      </div>

      <div
        role="tabpanel"
        id="panel-settings-stage"
        aria-labelledby="tab-settings-stage"
        hidden={activeTab !== "stage"}
        className={styles.tabPanel}
      >
      <ConsoleSection headingId="settings-stage" title="진행 단계" width="form" description={stagePrompt}>
          <div className={styles.stagePanel}>
          <ol className={styles.stageTimeline} aria-label="전체 진행 단계">
            {STAGE_ORDER.map((stage) => {
              const isCurrent = stage === currentStage;
              const isNext = stage === nextStage;
              return (
                <li
                  key={stage}
                  aria-current={isCurrent ? "step" : undefined}
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
          <div className={styles.stageIdentity}>
            <span className={styles.stageLabel}>현재 단계</span>
            <span className={eventStageClassName(currentStage)}>{stageText}</span>
          </div>
          {stagePrecondition ? (
            <p id="settings-stage-precondition" className={styles.stagePrecondition} role="note">
              {stagePrecondition}{" "}
              {nextStage === "LIVE" ? (
                <Link href={`/console/events/${encodeURIComponent(eventId)}/operations`}>운영에서 데스크 배정하기</Link>
              ) : (
                <>
                  <a href="#settings-intake">접수 닫기</a>
                  {" · "}
                  <Link href={closeHref(`/console/events/${encodeURIComponent(eventId)}/programs`)}>프로그램 닫기</Link>
                </>
              )}
            </p>
          ) : null}
          {stageError ? <ConsoleFeedback kind="error">{stageError}</ConsoleFeedback> : null}
          {stageNotice ? <ConsoleFeedback kind="success">{stageNotice}</ConsoleFeedback> : null}
          <div className={styles.stageActions}>
            {!state.canManageEvent ? (
              <p className={styles.help}>행사 단계 변경 권한이 없습니다.</p>
            ) : nextStage && !stageConfirm ? (
              <button
                type="button"
                className="button button-secondary"
                onClick={() => {
                  setStageError(null);
                  setStageNotice(null);
                  setStageConfirm(true);
                }}
                disabled={stageBusy || busy || stageBlocked}
                aria-describedby={stageBlocked ? "settings-stage-precondition" : undefined}
              >
                {eventStageLabel(nextStage)}(으)로 전환
              </button>
            ) : nextStage ? (
              <StageTransitionConfirmation className={styles.stageConfirmation} label={eventStageLabel(nextStage)}
                busy={stageBusy} disabled={busy || stageBlocked} cancelDisabled={busy}
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
      </ConsoleSection>
      </div>

      <div className={styles.settingsFooter}>
        <Link
          className="button button-secondary"
          href={`/console/events/${encodeURIComponent(eventId)}`}
        >
          현황으로 돌아가기
        </Link>
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
        <summary>
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
            <Link
              className="button button-secondary"
              href={`/console/events/${encodeURIComponent(eventId)}/page`}
            >
              참가자 페이지 편집으로 이동
            </Link>
          </p>
        </div>
      </details>
    </ConsolePage>
  );
}
