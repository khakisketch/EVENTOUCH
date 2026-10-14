"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
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
          router.push("/staff/login");
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: {
            events?: unknown;
            workspaces?: Record<string, {
              features?: unknown;
              price?: unknown;
              approvalRequired?: unknown;
              allowReentry?: unknown;
              registrationOpen?: unknown;
              publishedVersion?: unknown;
              consentText?: unknown;
              pageExperience?: unknown;
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
        <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
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
          <div className={styles.actions}>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "저장 중입니다" : "기본 정보 저장"}
            </button>
          </div>
        </form>
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
