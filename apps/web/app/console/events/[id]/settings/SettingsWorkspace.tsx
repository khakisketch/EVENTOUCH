"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { eventStageClassName, eventStageLabel } from "../../../../event-stage";
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
  { id: "payment", label: "결제" },
  { id: "reward", label: "경품" },
];

const FEATURE_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: "참여 프로그램", ids: ["poll", "quiz", "qa", "draw", "survey", "stamp"] },
  { label: "안내·기록", ids: ["photo", "board", "venue", "screen"] },
  { label: "유료·경품", ids: ["payment", "reward"] },
];

const STAGE_ORDER = ["DRAFT", "READY", "LIVE", "ENDED", "ARCHIVED"];

type Basics = {
  name: string;
  slug: string;
  date: string;
  start: string;
  end: string;
  capacity: string;
  price: string;
  approvalRequired: boolean;
  allowReentry: boolean;
  verificationRequired: boolean;
};
type PageDraft = {
  intro: string;
  accent: string;
  showAnnouncements: boolean;
  showSchedule: boolean;
  showVenue: boolean;
  showPrograms: boolean;
};
type Ready = {
  kind: "ready";
  stage: string;
  canManageEvent: boolean;
  deskCount: number;
  deskAssignmentCount: number;
  openModules: number;
  basics: Basics;
  features: string[];
  registrationOpen: boolean;
  publishedVersion: number;
  consentText: string;
  draft: PageDraft;
  pagePublishedAt: string;
};
type State = { kind: "loading" } | { kind: "failed"; message: string } | Ready;

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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

export default function SettingsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [stageBusy, setStageBusy] = useState(false);
  const [stageConfirm, setStageConfirm] = useState(false);
  const [stageError, setStageError] = useState<string | null>(null);
  const [stageNotice, setStageNotice] = useState<string | null>(null);
  const stageCommandIdRef = useRef<string | null>(null);

  const [basics, setBasics] = useState<Basics | null>(null);
  const [features, setFeatures] = useState<string[] | null>(null);
  const [consentText, setConsentText] = useState("");
  const [draft, setDraft] = useState<PageDraft | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: {
            events?: unknown;
            accounts?: unknown;
            workspaces?: Record<string, {
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
        const bootstrap = data?.state;
        if (!res.ok || !bootstrap) {
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
        const accounts = Array.isArray(bootstrap.accounts)
          ? bootstrap.accounts.map(record).filter((item): item is Record<string, unknown> => item !== null)
          : [];
        // Match the overview's UI gate. The server still authorizes every stage command.
        const canManageEvent = accounts.some((account) =>
          ["AGENCY", "MANAGER"].includes(text(account.role))
        );
        const desks = Array.isArray(workspace.desks) ? workspace.desks : [];
        const assignments = Array.isArray(workspace.assignments) ? workspace.assignments : [];
        const modules = Array.isArray(workspace.modules) ? workspace.modules : [];
        const deskAssignmentCount = assignments.filter((item) => record(item)?.type === "DESK").length;
        const openModules = modules.filter((item) => record(item)?.status === "OPEN").length;
        const pageExperience = typeof workspace.pageExperience === "object" && workspace.pageExperience !== null
          ? (workspace.pageExperience as Record<string, unknown>)
          : {};
        const draftSource = typeof pageExperience.draft === "object" && pageExperience.draft !== null
          ? (pageExperience.draft as Record<string, unknown>)
          : {};
        const newBasics: Basics = {
          name: text(event.name),
          slug: text(event.slug),
          date: text(event.date),
          start: text(event.start) || "09:00",
          end: text(event.end) || "18:00",
          capacity: String(Number(event.capacity) || 0),
          price: String(Number(workspace.price) || 0),
          approvalRequired: workspace.approvalRequired === true,
          allowReentry: workspace.allowReentry !== false,
          verificationRequired: workspace.verificationRequired === true,
        };
        const newDraft: PageDraft = {
          intro: text(draftSource.intro) || text(event.name),
          accent: /^#[0-9a-f]{6}$/i.test(text(draftSource.accent)) ? text(draftSource.accent).toUpperCase() : "#E76D26",
          showAnnouncements: draftSource.showAnnouncements !== false,
          showSchedule: draftSource.showSchedule !== false,
          showVenue: draftSource.showVenue !== false,
          showPrograms: draftSource.showPrograms !== false,
        };
        setState({
          kind: "ready",
          stage: text(event.stage).toUpperCase(),
          canManageEvent,
          deskCount: desks.length,
          deskAssignmentCount,
          openModules,
          basics: newBasics,
          features: Array.isArray(event.features)
            ? event.features.filter((feature): feature is string => typeof feature === "string")
            : [],
          registrationOpen: workspace.registrationOpen === true,
          publishedVersion: Number(workspace.publishedVersion) || 0,
          consentText: text(workspace.consentText),
          draft: newDraft,
          pagePublishedAt: text(pageExperience.publishedAt),
        });
        setBasics(newBasics);
        setFeatures(
          Array.isArray(event.features)
            ? event.features.filter((feature): feature is string => typeof feature === "string")
            : []
        );
        setConsentText(text(workspace.consentText));
        setDraft(newDraft);
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

  async function runCommand(
    command: string,
    payload: Record<string, unknown>,
    successMessage: string
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: randomCommandId(), command, payload }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } | null;
      if (!res.ok) {
        setFailure({
          message: typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return false;
      }
      setNotice(successMessage);
      setReloadTick((tick) => tick + 1);
      return true;
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  if (state.kind === "loading") {
    return <p className="loading-state" role="status">행사 설정을 불러오고 있습니다.</p>;
  }
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{state.message}</p>
        <button type="button" className="button button-secondary" onClick={() => {
          setReloadTick((tick) => tick + 1);
          window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
        }}>
          다시 불러오기
        </button>
      </section>
    );
  }
  if (!basics || !features || !draft) {
    return <p className="loading-state" role="status">행사 설정을 준비하고 있습니다.</p>;
  }

  const invalid = (field: string) => failure?.field === field;
  const describedBy = (field: string) =>
    failure?.field === field ? "settings-error" : undefined;
  const draftDirty =
    state.kind === "ready" && draft
      ? JSON.stringify(draft) !== JSON.stringify(state.draft)
      : false;

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

  async function submitStageTransition() {
    if (state.kind !== "ready" || !state.canManageEvent || !nextStage || stageBusy || !stageConfirm) return;
    const label = eventStageLabel(nextStage);
    if (!stageCommandIdRef.current) stageCommandIdRef.current = randomCommandId();
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
      const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
      if (!res.ok) {
        setStageError(typeof data?.error === "string" ? data.error : "단계를 전환하지 못했습니다.");
        setStageConfirm(false);
        stageCommandIdRef.current = null;
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
      setStageBusy(false);
    }
  }

  return (
    <div className={styles.wrapper}>
      <header>
        <p className="eyebrow">행사 설정</p>
        <h1>{basics.name}</h1>
      </header>
      {failure ? <p role="alert" id="settings-error" className={styles.alert}>{failure.message}</p> : null}
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}

      <section className={styles.section} aria-labelledby="settings-basics">
        <h2 id="settings-basics">기본 정보</h2>
        <form
          className={styles.form}
          onSubmit={(event) => {
            event.preventDefault();
            void runCommand("event.update", {
              name: basics.name,
              slug: basics.slug,
              date: basics.date,
              start: basics.start,
              end: basics.end,
              capacity: Number(basics.capacity) || 0,
              price: Number(basics.price) || 0,
              approvalRequired: basics.approvalRequired,
              allowReentry: basics.allowReentry,
              verificationRequired: basics.verificationRequired,
            }, "기본 정보를 저장했습니다.");
          }}
        >
          <div className={styles.gridTwo}>
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
                pattern="[a-z0-9][a-z0-9-]{0,49}"
                value={basics.slug}
                onChange={(event) => setBasics({ ...basics, slug: event.target.value })}
                aria-invalid={invalid("slug") || undefined}
                aria-describedby={describedBy("slug") || undefined}
                required
              />
            </div>
          </div>
          <div className={styles.gridTwo}>
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
          <div className={styles.gridTwo}>
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
          <div className={styles.actions}>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "저장 중입니다" : "기본 정보 저장"}
            </button>
          </div>
        </form>
      </section>

      <section className={styles.section} aria-labelledby="settings-stage">
        <h2 id="settings-stage">진행 단계</h2>
        <div className={styles.stagePanel}>
          <div className={styles.stageIdentity}>
            <span className={styles.stageLabel}>현재 단계</span>
            <span className={eventStageClassName(currentStage)}>{stageText}</span>
          </div>
          <p className={styles.help}>{stagePrompt}</p>
          {stagePrecondition ? <p className={styles.stagePrecondition}>{stagePrecondition}</p> : null}
          {stageError ? <p className={styles.alert} role="alert">{stageError}</p> : null}
          {stageNotice ? <p className={styles.notice} role="status">{stageNotice}</p> : null}
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
                disabled={stageBusy || busy}
              >
                {eventStageLabel(nextStage)}(으)로 전환
              </button>
            ) : nextStage ? (
              <div className={styles.stageConfirmation} role="group" aria-label="단계 전환 확인">
                <p>정말 {eventStageLabel(nextStage)} 단계로 전환합니다?</p>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className="button button-secondary"
                    onClick={() => void submitStageTransition()}
                    disabled={stageBusy || busy}
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
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="settings-features">
        <h2 id="settings-features">기능</h2>
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
        <div className={styles.actions}>
          <button
            type="button"
            className="button button-primary"
            disabled={busy}
            onClick={() => void runCommand("event.features", { features }, "기능 설정을 저장했습니다.")}
          >
            {busy ? "저장 중입니다" : "기능 저장"}
          </button>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="settings-intake">
        <h2 id="settings-intake">참가 접수</h2>
        <p>
          현재 {state.registrationOpen ? "접수 중" : "접수 닫힘"} · 게시된 양식 버전 {state.publishedVersion}
        </p>
        <div className={styles.form}>
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
          <div className={styles.actions}>
            <button
              type="button"
              className="button button-primary"
              disabled={busy}
              onClick={() => void runCommand(
                "form.publish",
                consentText ? { consentText } : {},
                "양식을 게시하고 접수를 열었습니다."
              )}
            >
              {busy ? "처리 중입니다" : "양식 게시·접수 열기"}
            </button>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy || !state.registrationOpen}
              onClick={() => void runCommand("form.close", {}, "접수를 닫았습니다.")}
            >
              접수 닫기
            </button>
          </div>
        </div>
      </section>

      <section className={styles.section} aria-labelledby="settings-page">
        <h2 id="settings-page">참가자 페이지</h2>
        <p className={styles.help}>
          저장은 초안만 바꾸고, 게시해야 참가자에게 보입니다.
          {state.pagePublishedAt ? ` 최근 게시: ${formatPublishedAt(state.pagePublishedAt)}` : ""}
        </p>
        <div className={styles.form}>
          <div>
            <label htmlFor="set-intro">행사 소개 (160자)</label>
            <input
              id="set-intro"
              type="text"
              maxLength={160}
              value={draft.intro}
              onChange={(event) => setDraft({ ...draft, intro: event.target.value })}
              aria-invalid={invalid("intro") || undefined}
              aria-describedby={describedBy("intro") || undefined}
              required
            />
          </div>
          <div>
            <label htmlFor="set-accent">강조색</label>
            <input
              id="set-accent"
              type="color"
              value={draft.accent}
              onChange={(event) => setDraft({ ...draft, accent: event.target.value.toUpperCase() })}
              aria-invalid={invalid("accent") || undefined}
              aria-describedby={describedBy("accent") || undefined}
            />
          </div>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.showAnnouncements}
              onChange={(event) => setDraft({ ...draft, showAnnouncements: event.target.checked })}
            />
            공지 보기
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.showSchedule}
              onChange={(event) => setDraft({ ...draft, showSchedule: event.target.checked })}
            />
            일정 보기
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.showVenue}
              onChange={(event) => setDraft({ ...draft, showVenue: event.target.checked })}
            />
            장소 보기
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={draft.showPrograms}
              onChange={(event) => setDraft({ ...draft, showPrograms: event.target.checked })}
            />
            프로그램 보기
          </label>
          {draftDirty ? (
            <p className={styles.help} role="status">저장되지 않은 변경이 있습니다. 게시하기 전에 초안을 저장하세요.</p>
          ) : null}
          <div className={styles.actions}>
            <button
              type="button"
              className="button button-secondary"
              disabled={busy}
              onClick={() => void runCommand("attendee.page.save", { ...draft }, "초안을 저장했습니다.")}
            >
              초안 저장
            </button>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || draftDirty}
              title={draftDirty ? "초안을 먼저 저장하세요" : undefined}
              onClick={() => void runCommand("attendee.page.publish", {}, "참가자 페이지를 게시했습니다.")}
            >
              {busy ? "처리 중입니다" : "페이지 게시"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
