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
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import uiStyles from "../../../console-ui/console-ui.module.css";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import styles from "./settings.module.css";

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
  features: "기능",
};

// Jump-nav readout labels, one per anchor this screen renders. The wording
// matches the section titles on screen; the nav items stay the source of
// the anchor ids.
const SETTINGS_NAV_LABELS: Record<string, string> = {
  "settings-basics": "기본 정보",
  "settings-intake": "참가 접수",
  "settings-features": "기능",
  "settings-stage": "진행 단계",
  "settings-page": "참가자 페이지",
};

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
  // Names the section in view for the jump-nav readout (field operations,
  // draws, and the attendee page editor use the same grammar).
  const [activeSection, setActiveSection] = useState("settings-basics");
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

  // Names the section in view for the jump-nav readout. Anchor clicks keep
  // working natively whether or not the observer is available.
  useEffect(() => {
    if (state.kind !== "ready") return;
    if (typeof IntersectionObserver === "undefined") return;
    const ids = [
      "settings-basics",
      "settings-intake",
      "settings-features",
      "settings-stage",
      "settings-page",
    ];
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
  // 접힌 요약에 현재 상태를 보여 주기 위한 한 줄 요약. 펼치면 기존 동작 그대로.
  const stageSummary = `진행 단계 · 현재 ${stageText}`;
  const pageSummary = state.pagePublishedVersion > 0
    ? `참가자 페이지 · 게시 버전 ${state.pagePublishedVersion}`
    : `참가자 페이지 · 초안 ${state.pageDraftVersion} · 미게시`;

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
    } catch {
      // Preserve the id so a retry can replay the server receipt after a lost response.
      setStageError("연결하지 못했습니다. 같은 요청을 다시 시도하세요.");
    } finally {
      operationsBusyRef.current = false;
      setStageBusy(false);
    }
  }

  return (
    <ConsolePage
      pageId="settings"
      eventId={eventId}
      eventName={basics?.name || state.basics.name}
      meta={state.eventMeta}
      sectionNav={(
        <div className={styles.navSticky}>
          <ConsoleSectionNav
            label="행사 설정 구역"
            items={[
              { id: "settings-basics", label: "기본 정보" },
              { id: "settings-intake", label: "참가 접수" },
              { id: "settings-features", label: "기능" },
              { id: "settings-stage", label: "진행 단계" },
              { id: "settings-page", label: "참가자 페이지" },
            ]}
          />
          <p className={styles.navNow}>
            현재 위치: {SETTINGS_NAV_LABELS[activeSection] || "기본 정보"}
          </p>
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
        화면은 기본 정보·참가 접수·기능·진행 단계로 나뉘며, 각 구역의 저장 버튼이 그 구역만 저장합니다.
      </p>
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
          <div className={uiStyles.formGrid}>
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
          </ConsoleFormActions>
          {sectionStatusLine(basicsStatus, "basics")}
        </form>
      </ConsoleSection>

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
          </ConsoleFormActions>
          {sectionStatusLine(intakeStatus, "intake")}
        </div>
      </ConsoleSection>

      <ConsoleSection headingId="settings-features" title="기능" width="form">
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
            onClick={() => void runCommand("event.features", { features }, "기능 설정을 저장했습니다.", "features")}
          >
            {busy ? "저장 중입니다" : "기능 저장"}
          </button>
        </ConsoleFormActions>
        {sectionStatusLine(featuresStatus, "features")}
      </ConsoleSection>

      <ConsoleSection headingId="settings-stage" title="진행 단계" width="form">
        <details className={styles.collapse} data-settings-collapse="stage">
          <summary className={styles.collapseSummary} data-settings-collapse-summary="stage">
            {stageSummary}
          </summary>
          <div className={styles.stagePanel}>
          <div className={styles.stageIdentity}>
            <span className={styles.stageLabel}>현재 단계</span>
            <span className={eventStageClassName(currentStage)}>{stageText}</span>
          </div>
          <p className={styles.help}>{stagePrompt}</p>
          {stagePrecondition ? (
            <p id="settings-stage-precondition" className={styles.stagePrecondition} role="note">
              {stagePrecondition}{" "}
              {nextStage === "LIVE" ? (
                <Link href={`/console/events/${encodeURIComponent(eventId)}/operations`}>운영에서 데스크 배정하기</Link>
              ) : (
                <>
                  <a href="#settings-intake">접수 닫기</a>
                  {" · "}
                  <Link href={`/console/events/${encodeURIComponent(eventId)}/programs`}>프로그램 닫기</Link>
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
              <div className={styles.stageConfirmation} role="group" aria-label="단계 전환 확인">
                <p>정말 {eventStageLabel(nextStage)} 단계로 전환합니다?</p>
                {nextStage === "ENDED" ? (
                  <p className={styles.help}>
                    종료하면 참가자 변경이 막힙니다. 결과 보고서는 생성 시점 값으로 고정되므로,
                    필요한 집계는 종료 전에 동결해 두세요.
                  </p>
                ) : null}
                <ConsoleFormActions>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void submitStageTransition()}
                    disabled={stageBusy || busy || stageBlocked}
                    aria-describedby={stageBlocked ? "settings-stage-precondition" : undefined}
                    aria-label={`정말 ${eventStageLabel(nextStage)} 단계로 전환합니다`}
                  >
                    {stageBusy
                      ? "전환 중입니다"
                      : stageCommandIdRef.current && stageError
                        ? "같은 요청 다시 시도"
                        : "정말 전환합니다"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => {
                      setStageConfirm(false);
                      setStageError(null);
                    }}
                    disabled={stageBusy || busy}
                  >
                    취소
                  </button>
                </ConsoleFormActions>
              </div>
            ) : null}
          </div>
          </div>
        </details>
      </ConsoleSection>

      <ConsoleSection headingId="settings-page" title="참가자 페이지" width="form">
        <details className={styles.collapse} data-settings-collapse="page">
          <summary className={styles.collapseSummary} data-settings-collapse-summary="page">
            {pageSummary}
          </summary>
          <div className={styles.pageFold}>
        <p>
          {state.pagePublishedAt
            ? `초안 ${state.pageDraftVersion} · 게시 버전 ${state.pagePublishedVersion} · 최근 게시 ${formatPublishedAt(state.pagePublishedAt)}`
            : `초안 ${state.pageDraftVersion} · 아직 게시하지 않음`}
        </p>
        <p className={styles.help}>
          소개·강조색·노출 항목과 디자인은 참가자 페이지 편집기에서 저장·게시합니다. 이 화면에서는 바꾸지 않습니다.
        </p>
        <ConsoleFormActions>
          <Link
            className="button button-primary"
            href={`/console/events/${encodeURIComponent(eventId)}/page`}
          >
            참가자 페이지 편집으로 이동
          </Link>
        </ConsoleFormActions>
          </div>
        </details>
      </ConsoleSection>
    </ConsolePage>
  );
}
