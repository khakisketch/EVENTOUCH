"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleToolbar from "../../../console-ui/ConsoleToolbar";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ui from "../../../console-ui/console-ui.module.css";
import styles from "./reports.module.css";

type ReportSnapshot = {
  event?: { name?: unknown; date?: unknown; start?: unknown; end?: unknown; venue?: unknown; client?: unknown };
  metrics?: { total?: unknown; checked?: unknown; inside?: unknown; rate?: unknown };
  groups?: Array<{ name?: unknown; count?: unknown }>;
  booths?: Array<{ name?: unknown; used?: unknown; capacity?: unknown }>;
  programs?: Array<{ name?: unknown; type?: unknown; responses?: unknown }>;
  survey?: Array<{ name?: unknown; count?: unknown; average?: unknown | null; questions?: Array<{ name?: unknown; average?: unknown | null; count?: unknown }> }>;
  photos?: Array<{ image?: unknown; caption?: unknown }>;
  capturedAt?: unknown;
  revision?: unknown;
};

type Report = {
  id: string;
  title: string;
  subtitle: string;
  coverNote: string;
  summary: string;
  sections: string[];
  color: string;
  status: string;
  version: number;
  createdAt: string;
  publishedAt: string;
  familyId?: string;
  snapshot?: ReportSnapshot | null;
};

type Ready = {
  kind: "ready";
  eventName: string;
  eventMeta?: string;
  archived: boolean;
  metrics: { total: number; pending: number; approved: number; checked: number; inside: number; rate: number };
  groups: Array<{ name: string; count: number }>;
  booths: Array<{ name: string; used: number; capacity: number }>;
  programs: Array<{ name: string; type: string; responses: number }>;
  surveys: Array<{ name: string; count: number; average: string | null; questions: Array<{ name: string; average: string | null; count: number }> }>;
  photoCount: number;
  photoCaptions: string[];
  reports: Report[];
};

type State = { kind: "loading" } | { kind: "failed"; message: string } | Ready;

const SECTION_LABELS: Array<{ id: string; label: string }> = [
  { id: "overview", label: "운영 요약" },
  { id: "attendance", label: "참가·입장" },
  { id: "programs", label: "프로그램·부스" },
  { id: "survey", label: "만족도" },
  { id: "photos", label: "승인 사진" },
];

const MODULE_TYPE_LABELS: Record<string, string> = {
  poll: "투표",
  quiz: "퀴즈",
  qa: "Q&A",
  draw: "추첨",
  survey: "만족도",
  stamp: "스탬프",
  photo: "사진",
  board: "게시판",
};

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function averageLabel(values: number[]): string | null {
  if (!values.length) return null;
  return (values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(1);
}

// Frozen snapshot timestamps render as a compact local wall time so the
// 집계 기준 stays distinct from date-only shared/published stamps.
function capturedLabel(value: unknown): string {
  if (typeof value !== "string" || !value) return "";
  return value.slice(0, 16).replace("T", " ");
}

function snapshotImageFileId(image: unknown): string {
  if (typeof image !== "object" || image === null || Array.isArray(image)) return "";
  const fileId = (image as Record<string, unknown>).fileId;
  return typeof fileId === "string" ? fileId : "";
}

export default function ReportsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [publishId, setPublishId] = useState<string | null>(null);
  const [successorId, setSuccessorId] = useState<string | null>(null);
  const [successorSource, setSuccessorSource] = useState("current");
  const [loadedAt, setLoadedAt] = useState<string | null>(null);
  const pendingCommandsRef = useRef(new Map<string, string>());
  const sendingRef = useRef(false);
  // Tracks a dialog save whose outcome is still unknown (ambiguous failure
  // kept its idempotent key). Dismissal must warn that it may already have
  // applied instead of claiming a cancel.
  const dialogUnresolvedRef = useRef(false);

  // 보관된 행사는 서버가 모든 쓰기를 거부하므로(409) 쓰기 affordance를
  // 잠그고 읽기·내보내기(내용 보기·JSON 저장·인쇄)만 둡니다.
  const writeLocked = state.kind === "ready" && state.archived;

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
            clients?: unknown;
            workspaces?: Record<string, Record<string, unknown>>;
          } | null;
        } | null;
        const bootstrap = data?.state;
        if (!res.ok || !bootstrap) {
          setState({ kind: "failed", message: "결과 데이터를 불러오지 못했습니다." });
          return;
        }
        const event = (Array.isArray(bootstrap.events) ? bootstrap.events : []).find(
          (item): item is Record<string, unknown> =>
            typeof item === "object" && item !== null &&
            (item as Record<string, unknown>).id === eventId
        );
        const workspace = bootstrap.workspaces?.[eventId];
        if (!event || !workspace) {
          setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
          return;
        }
        const asList = (value: unknown): Record<string, unknown>[] =>
          Array.isArray(value)
            ? value.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
            : [];
        const people = asList(workspace.participants).filter((person) => person.status !== "CANCELLED");
        const responses = asList(workspace.responses);
        const modules = asList(workspace.modules);
        const questions = asList(workspace.questions);
        const photos = asList(workspace.photos).filter((photo) => photo.status === "APPROVED");
        const clients = asList(bootstrap.clients);
        const clientName = clients.find((client) => client.id === event.clientId)?.name;
        const surveys = modules
          .filter((module) => module.type === "survey")
          .map((module) => {
            const moduleResponses = responses.filter((response) => response.moduleId === module.id);
            const values = moduleResponses.flatMap((response) =>
              Object.values(
                typeof response.ratings === "object" && response.ratings !== null
                  ? (response.ratings as Record<string, unknown>)
                  : {}
              ).map(Number).filter((value) => Number.isFinite(value))
            );
            const names = Array.isArray(module.questions) && module.questions.length
              ? module.questions.filter((name): name is string => typeof name === "string")
              : ["전반적인 만족도", "프로그램 구성", "현장 운영", "행사장 편의성", "재참석 의향"];
            return {
              name: text(module.title),
              count: moduleResponses.length,
              average: averageLabel(values),
              questions: names.map((name) => {
                const ratings = moduleResponses
                  .map((response) => {
                    const ratings = response.ratings;
                    if (typeof ratings !== "object" || ratings === null) return undefined;
                    return (ratings as Record<string, unknown>)[name];
                  })
                  .filter((value) => value !== undefined)
                  .map(Number)
                  .filter((value) => Number.isFinite(value));
                return { name, average: averageLabel(ratings), count: ratings.length };
              }),
            };
          });
        const venue = typeof workspace.venue === "object" && workspace.venue !== null
          ? (workspace.venue as Record<string, unknown>)
          : {};
        if (!cancelled) {
          setLoadedAt(new Date().toISOString());
          setState({
            kind: "ready",
            eventName: text(event.name) || "이름 없는 행사",
            eventMeta: formatConsoleEventMeta({
              clientName: text(clientName),
              date: text(event.date),
              start: text(event.start),
              end: text(event.end),
              venue: text(venue.name),
            }),
            archived: text(event.stage).toUpperCase() === "ARCHIVED",
            metrics: {
              total: people.length,
              pending: people.filter((person) => person.status === "PENDING").length,
              approved: people.filter((person) => person.status === "APPROVED").length,
              checked: people.filter((person) => person.everIn === true).length,
              inside: people.filter((person) => person.inside === true).length,
              rate: people.length
                ? Math.round((people.filter((person) => person.everIn === true).length / people.length) * 100)
                : 0,
            },
            groups: (Array.isArray(workspace.groups) ? workspace.groups : [])
              .filter((name): name is string => typeof name === "string")
              .map((name) => ({ name, count: people.filter((person) => person.group === name).length })),
            booths: asList(workspace.booths).map((booth) => ({
              name: text(booth.name),
              used: num(booth.used),
              capacity: num(booth.capacity),
            })),
            programs: modules.map((module) => ({
              name: text(module.title),
              type: text(module.type),
              responses: text(module.type) === "qa"
                ? questions.filter((question) => question.moduleId === module.id).length
                : text(module.type) === "draw"
                  ? asList(module.drawHistory).reduce(
                      (sum, result) => sum + asList(result.winners).length,
                      0
                    )
                  : responses.filter((response) => response.moduleId === module.id).length,
            })),
            surveys,
            photoCount: photos.length,
            photoCaptions: photos.map((photo) => text(photo.caption)).filter(Boolean).slice(0, 20),
            reports: asList(workspace.reports).flatMap((item) =>
              typeof item.id === "string" && item.id
                ? [{
                    id: item.id,
                    title: text(item.title),
                    subtitle: text(item.subtitle),
                    coverNote: text(item.coverNote),
                    summary: text(item.summary),
                    sections: Array.isArray(item.sections)
                      ? item.sections.filter((section): section is string => typeof section === "string")
                      : [],
                    color: /^#[0-9a-f]{6}$/i.test(text(item.color)) ? text(item.color).toUpperCase() : "#E76D26",
                    status: text(item.status) || "DRAFT",
                    version: Number(item.version) || 1,
                    createdAt: text(item.createdAt),
                    publishedAt: text(item.publishedAt),
                    familyId: typeof item.familyId === "string" ? item.familyId : undefined,
                    snapshot: (typeof item.snapshot === "object" && item.snapshot !== null
                      ? (item.snapshot as ReportSnapshot)
                      : null),
                  }]
                : []
            ),
          });
        }
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

  const detail = useMemo(() => {
    if (state.kind !== "ready" || !detailId) return null;
    return state.reports.find((report) => report.id === detailId) ?? null;
  }, [state, detailId]);

  async function runCommand(
    command: string,
    payload: Record<string, unknown>,
    successMessage: string
  ): Promise<boolean> {
    if (sendingRef.current) return false;
    if (writeLocked) {
      setFailure({ message: "보관된 행사는 읽기 전용입니다." });
      return false;
    }
    sendingRef.current = true;
    const attempt = JSON.stringify([eventId, command, payload]);
    const commandId = pendingCommandsRef.current.get(attempt) ?? randomCommandId();
    pendingCommandsRef.current.set(attempt, commandId);
    setBusy(true);
    setFailure(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, payload }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        report?: { id?: unknown };
      } | null;
      if (!res.ok) {
        const uncertain = res.status >= 500 || res.status === 408;
        if (!uncertain) pendingCommandsRef.current.delete(attempt);
        setFailure({
          message: uncertain ? "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요." : typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return false;
      }
      if (!data || typeof data.report?.id !== "string") {
        setFailure({ message: "응답을 확인하지 못했습니다. 같은 내용으로 다시 시도하세요." });
        return false;
      }
      pendingCommandsRef.current.delete(attempt);
      setNotice(successMessage);
      setReloadTick((tick) => tick + 1);
      return true;
    } catch {
      setFailure({ message: "연결하지 못했습니다. 같은 내용으로 다시 시도하세요." });
      return false;
    } finally {
      sendingRef.current = false;
      setBusy(false);
    }
  }

  const articleRef = useRef<HTMLElement>(null);

  function cleanupReportPrint() {
    if (typeof document === "undefined") return;
    document.getElementById("eventouch-report-print")?.remove();
    document.body.classList.remove("report-printing");
  }

  // Print ONLY the chosen saved snapshot: clone the rendered article into a
  // temporary body child, flag the body for the print stylesheet, print,
  // then clean up on afterprint and on unmount. cloneNode preserves module
  // classes and the inline cover color; nothing reloads and no new data,
  // assets or history tricks are involved. The live analysis section and
  // any open modal stay out of the printed page by construction.
  function printReport() {
    const source = articleRef.current;
    if (!source || typeof document === "undefined" || typeof window === "undefined") return;
    cleanupReportPrint();
    const clone = source.cloneNode(true) as HTMLElement;
    clone.id = "eventouch-report-print";
    document.body.appendChild(clone);
    document.body.classList.add("report-printing");
    const handleAfterPrint = () => {
      window.removeEventListener("afterprint", handleAfterPrint);
      cleanupReportPrint();
    };
    window.addEventListener("afterprint", handleAfterPrint);
    window.print();
  }

  useEffect(() => () => {
    cleanupReportPrint();
  }, []);

  function exportJson(report: Report) {
    const blob = new Blob(
      [JSON.stringify({ ...report, exportedAt: new Date().toISOString() }, null, 2)],
      { type: "application/json" }
    );
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `EVENTOUCH_report_v${report.version}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="reports" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="결과 데이터를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="reports" eventId={eventId}>
        {/* Shared panel dispatches eventouch:shell-reload before calling this page's retry. */}
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }

  const sectionLabel = (id: string) =>
    SECTION_LABELS.find((section) => section.id === id)?.label ?? "항목 확인 필요";

  return (
    <ConsolePage
      pageId="reports"
      eventId={eventId}
      eventName={state.eventName}
      meta={state.eventMeta}
      toolbar={
        <ConsoleToolbar
          actions={
            <button
              type="button"
              className="button button-primary"
              disabled={writeLocked}
              onClick={() => { setDetailId(null); setFailure(null); dialogUnresolvedRef.current = false; setCreateOpen(true); }}
            >
              보고서 만들기
            </button>
          }
        />
      }
      sectionNav={
        <ConsoleSectionNav
          items={
            detail
              ? [
                  { id: "reports-analysis", label: "결과 분석" },
                  { id: "reports-list", label: "보고서" },
                  { id: "report-detail", label: "보고서 내용" },
                ]
              : [
                  { id: "reports-analysis", label: "결과 분석" },
                  { id: "reports-list", label: "보고서" },
                ]
          }
        />
      }
      feedback={
        <>
          {failure && !createOpen ? <ConsoleFeedback kind="error">{failure.message}</ConsoleFeedback> : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {state.archived ? (
            <ConsoleFeedback kind="warning">보관된 행사는 읽기 전용입니다. 분석과 보고서를 볼 수 있지만 만들거나 바꿀 수 없습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      <ConsoleSection
        headingId="reports-analysis"
        title="결과 분석"
        description={
          <>
            누적 입장은 한 번 이상 입장한 참가자 기준이며 재입장을 중복 집계하지 않습니다. 취소된 신청은 제외합니다.{" "}
            <span className={styles.stamp}>조회 기준 시각 {loadedAt ? capturedLabel(loadedAt) : "확인 중"}</span>
          </>
        }
        className={styles.analysisSubheads}
        action={
          <button type="button" className="button button-secondary" onClick={() => setReloadTick((tick) => tick + 1)}>
            새로고침
          </button>
        }
      >
        <div className={styles.metricGrid}>
          <div className={styles.metricCard}><strong>{state.metrics.total}</strong><span>취소 제외 등록 (명)</span></div>
          <div className={styles.metricCard}><strong>{state.metrics.checked}</strong><span>누적 입장 (명)</span></div>
          <div className={styles.metricCard}><strong>{state.metrics.inside}</strong><span>현재 입장 (명)</span></div>
          <div className={styles.metricCard}><strong>{state.metrics.rate}</strong><span>누적 입장률 (%)</span></div>
          {state.metrics.pending > 0 ? (
            <div className={styles.metricCard}>
              <strong>{state.metrics.pending}</strong>
              <span>승인 대기 (명)</span>
            </div>
          ) : null}
        </div>
        <div className={styles.subgroup}>
        <h3>등록 그룹</h3>
        {state.groups.length ? (
          <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="등록 그룹별 인원 표">
            <table className={styles.dataTable}>
              <thead><tr><th scope="col">그룹</th><th scope="col" className={styles.num}>인원</th></tr></thead>
              <tbody>
                {state.groups.map((group) => (
                  <tr key={group.name}><td>{group.name}</td><td className={styles.num}>{group.count}명</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.help}>등록 그룹이 없습니다.</p>
        )}
        </div>
        <div className={styles.subgroup}>
        <h3>부스 이용</h3>
        {state.booths.length ? (
          <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="부스별 인증 수 표">
            <table className={styles.dataTable}>
              <thead><tr><th scope="col">부스</th><th scope="col" className={styles.num}>인증</th></tr></thead>
              <tbody>
                {state.booths.map((booth) => (
                  <tr key={booth.name}><td>{booth.name}</td><td className={styles.num}>{booth.used}건</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.help}>부스 데이터가 없습니다.</p>
        )}
        </div>
        <div className={styles.subgroup}>
        <h3>프로그램 응답</h3>
        {state.programs.length ? (
          <div className={styles.tableScroll} role="region" tabIndex={0} aria-label="프로그램별 응답 표">
            <table className={styles.dataTable}>
              <thead><tr><th scope="col">프로그램</th><th scope="col">종류</th><th scope="col" className={styles.num}>응답</th></tr></thead>
              <tbody>
                {state.programs.map((program) => (
                  <tr key={`${program.type}-${program.name}`}>
                    <td>{program.name}</td>
                    <td>{MODULE_TYPE_LABELS[program.type] ?? "항목 확인 필요"}</td>
                    <td className={styles.num}>{program.responses}건</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className={styles.help}>참여 기록이 없습니다.</p>
        )}
        </div>
        <div className={styles.subgroup}>
        <h3>만족도</h3>
        {state.surveys.length ? (
          state.surveys.map((survey) => (
            <div key={survey.name} className={styles.surveyGroup}>
              <p><strong>{survey.name}</strong> · 응답 {survey.count}명 · 평균 {survey.average === null ? "응답 없음" : `${survey.average} / 5`}</p>
              <div className={styles.tableScroll} role="region" tabIndex={0} aria-label={`${survey.name} 만족도 항목별 결과 표`}>
                <table className={styles.dataTable}>
                  <thead><tr><th scope="col">항목</th><th scope="col" className={styles.num}>평균</th><th scope="col" className={styles.num}>응답</th></tr></thead>
                  <tbody>
                    {survey.questions.map((question) => (
                      <tr key={question.name}>
                        <td>{question.name}</td>
                        <td className={styles.num}>{question.average === null ? "—" : `${question.average} / 5`}</td>
                        <td className={styles.num}>{question.count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))
        ) : (
          <p className={styles.help}>만족도 데이터가 없습니다.</p>
        )}
        </div>
        <p className={styles.help}>승인 사진 {state.photoCount}건{state.photoCaptions.length ? ` · ${state.photoCaptions.slice(0, 3).join(" · ")}` : ""}</p>
      </ConsoleSection>

      <ConsoleSection
        headingId="reports-list"
        title="보고서"
        description="생성 시점의 집계와 승인 사진을 보관하며, 이후 운영 변경은 자동 반영되지 않습니다. 고객사에 파일을 별도로 전달한 뒤 공유 완료를 기록하세요."
      >
        {state.reports.length ? (
          <ul className={ui.collection}>
            {state.reports.map((report) => (
              <li key={report.id} className={ui.recordRow}>
                <div className={ui.recordMain}>
                  <strong>{report.title}</strong>
                  <p className={ui.recordMeta}>
                    버전 {report.version}
                    {capturedLabel(report.snapshot?.capturedAt) ? ` · 집계 기준 ${capturedLabel(report.snapshot?.capturedAt)}` : ""}
                  </p>
                </div>
                <div className={ui.recordActions}>
                  <span className={`${styles.badge} ${report.status === "PUBLISHED" ? styles.badgePublished : styles.badgeDraft}`}>
                    {report.status === "PUBLISHED" ? "공유 완료 기록" : "초안"}
                  </span>
                  <button type="button" className="button button-secondary" onClick={() => { setDetailId(report.id); setPublishId(null); setSuccessorId(null); }}>
                    내용 보기
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.help}>아직 보고서가 없습니다.</p>
        )}
      </ConsoleSection>

      {detail ? (
        <ConsoleSection headingId="report-detail" title="보고서 내용">
          <article ref={articleRef} className={styles.reportDoc}>
            <header className={styles.reportCover} style={{ borderColor: detail.color }}>
              <p className="eyebrow">EVENTOUCH · 결과 보고서</p>
              <h3>{detail.title}</h3>
              {detail.subtitle ? <p className={styles.reportSubtitle}>{detail.subtitle}</p> : null}
              {detail.snapshot?.event ? (
                <p className={styles.help}>
                  {[text(detail.snapshot.event.name), text(detail.snapshot.event.date), text(detail.snapshot.event.client), text(detail.snapshot.event.venue)].filter(Boolean).join(" · ")}
                </p>
              ) : null}
              <p className={styles.help}>버전 {detail.version} · {detail.status === "PUBLISHED" ? `공유 완료 기록 · 편집 잠김${detail.publishedAt ? ` · ${detail.publishedAt.slice(0, 10)}` : ""}` : "초안"}</p>
              {capturedLabel(detail.snapshot?.capturedAt) ? (
                <p className={styles.help}>집계 기준 {capturedLabel(detail.snapshot?.capturedAt)}</p>
              ) : null}
              {detail.coverNote ? <p>{detail.coverNote}</p> : null}
            </header>
            {detail.sections.includes("overview") ? (
              <section><h3>운영 요약</h3><p>{detail.summary || "운영 요약을 작성해주세요."}</p></section>
            ) : null}
            {detail.sections.includes("attendance") && detail.snapshot?.metrics ? (
              <section>
                <h3>참가·입장</h3>
                <p>등록 {num(detail.snapshot.metrics.total)}명 · 누적 입장 {num(detail.snapshot.metrics.checked)}명 · 현재 입장 {num(detail.snapshot.metrics.inside)}명 · 입장률 {num(detail.snapshot.metrics.rate)}%</p>
                {detail.snapshot.groups?.length ? (
                  <p>{detail.snapshot.groups.map((group) => `${text(group.name)} ${num(group.count)}명`).join(" · ")}</p>
                ) : null}
              </section>
            ) : null}
            {detail.sections.includes("programs") ? (
              <section>
                <h3>참여 프로그램</h3>
                {(detail.snapshot?.programs?.length ? detail.snapshot.programs : []).map((program, index) => (
                  <p key={index}>{text(program.name)} · {num(program.responses)}건</p>
                ))}
                {(detail.snapshot?.booths?.length ? detail.snapshot.booths : []).map((booth, index) => (
                  <p key={`booth-${index}`}>{text(booth.name)} · {num(booth.used)}건</p>
                ))}
              </section>
            ) : null}
            {detail.sections.includes("survey") ? (
              <section>
                <h3>만족도</h3>
                {(detail.snapshot?.survey?.length ? detail.snapshot.survey : []).map((survey, index) => (
                  <div key={index}>
                    <p><strong>{text(survey.name)}</strong> · 응답 {num(survey.count)}명 · 평균 {survey.average == null ? "응답 없음" : `${survey.average} / 5`}</p>
                    {(survey.questions ?? []).map((question, questionIndex) => (
                      <p key={questionIndex}>{text(question.name)} · {question.average == null ? "—" : `${question.average} / 5`} · {num(question.count)}</p>
                    ))}
                  </div>
                ))}
              </section>
            ) : null}
            {detail.sections.includes("photos") ? (
              <section>
                <h3>행사 사진</h3>
                <p>승인 사진 {(detail.snapshot?.photos?.length ?? 0)}건</p>
                {(detail.snapshot?.photos?.length ?? 0) ? (
                  <ul className={styles.snapshotPhotos}>
                    {(detail.snapshot?.photos ?? []).map((photo, index) => {
                      const fileId = snapshotImageFileId(photo.image);
                      const caption = text(photo.caption);
                      return (
                        <li key={index}>
                          {fileId ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(fileId)}`}
                              alt={caption || "승인된 행사 사진"}
                              loading="lazy"
                            />
                          ) : null}
                          <p>{caption || "설명 없음"}</p>
                          {!fileId ? <p>원본 파일을 확인할 수 없습니다.</p> : null}
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
              </section>
            ) : null}
          </article>
          <ConsoleFormActions>
            <button type="button" className="button button-secondary" onClick={() => exportJson(detail)}>
              원본 파일 저장 (JSON)
            </button>
            <button type="button" className="button button-secondary" onClick={printReport}>
              인쇄하기
            </button>
            {detail.status === "DRAFT" ? (
              <>
                <button type="button" className="button button-secondary" disabled={writeLocked} onClick={() => { setFailure(null); dialogUnresolvedRef.current = false; setCreateOpen(true); }}>
                  내용 편집
                </button>
                {publishId === detail.id ? (
                  <>
                    <span className={styles.help}>완료로 표시하면 이 버전은 편집할 수 없습니다. 고객사에 자동 전송되지는 않습니다.</span>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy || writeLocked}
                      onClick={async () => {
                        const ok = await runCommand("report.publish", { id: detail.id }, "공유 완료를 기록하고 이 버전을 잠갔습니다. 고객사에 자동 전송되지는 않습니다.");
                        if (ok) { setPublishId(null); setDetailId(detail.id); }
                      }}
                    >
                      {busy ? "기록 중입니다" : "공유 완료·잠금"}
                    </button>
                    <button type="button" className="button button-secondary" onClick={() => setPublishId(null)}>
                      취소
                    </button>
                  </>
                ) : (
                  <button type="button" className="button button-primary" disabled={writeLocked} onClick={() => setPublishId(detail.id)}>
                    공유 완료로 표시
                  </button>
                )}
              </>
            ) : (
              <>
                {successorId === detail.id ? (
                  <>
                    <label className={styles.check}>
                      <input
                        type="radio"
                        name="successor-source"
                        value="current"
                        checked={successorSource === "current"}
                        onChange={() => setSuccessorSource("current")}
                      />
                      현재 집계를 새로 반영
                    </label>
                    <label className={styles.check}>
                      <input
                        type="radio"
                        name="successor-source"
                        value="snapshot"
                        checked={successorSource === "snapshot"}
                        onChange={() => setSuccessorSource("snapshot")}
                      />
                      이 보고서의 집계 유지
                    </label>
                    <button
                      type="button"
                      className="button button-primary"
                      disabled={busy || writeLocked}
                      onClick={async () => {
                        const ok = await runCommand(
                          "report.successor",
                          { id: detail.id, source: successorSource },
                          "새 보고서 버전을 만들었습니다."
                        );
                        if (ok) setSuccessorId(null);
                      }}
                    >
                      {busy ? "만드는 중입니다" : "새 버전 만들기"}
                    </button>
                    <button type="button" className="button button-secondary" onClick={() => setSuccessorId(null)}>
                      취소
                    </button>
                  </>
                ) : (
                  <button type="button" className="button button-primary" disabled={writeLocked} onClick={() => { setSuccessorId(detail.id); setSuccessorSource("current"); }}>
                    새 버전 만들기
                  </button>
                )}
              </>
            )}
            <button type="button" className="button button-secondary" onClick={() => { setDetailId(null); setPublishId(null); setSuccessorId(null); }}>
              닫기
            </button>
          </ConsoleFormActions>
        </ConsoleSection>
      ) : null}

      {createOpen ? (
        <CreateDialog
          key={detail?.status === "DRAFT" && detailId ? detail.id : "new"}
          initial={detail?.status === "DRAFT" && detailId ? detail : null}
          busy={busy}
          failure={failure}
          pendingApproval={state.metrics.pending}
          eventId={eventId}
          submitGateRef={sendingRef}
          unresolvedRef={dialogUnresolvedRef}
          onClose={() => { if (!sendingRef.current) setCreateOpen(false); }}
          onSubmit={async (payload) => {
            // Size growth means this attempt kept its idempotent key: an
            // ambiguous outcome the dismissal gate must warn about.
            const pendingBefore = pendingCommandsRef.current.size;
            if (detail?.status === "DRAFT" && detailId) {
              const ok = await runCommand("report.update", { ...payload, id: detail.id }, "보고서를 수정했습니다.");
              dialogUnresolvedRef.current = !ok && pendingCommandsRef.current.size > pendingBefore;
              if (ok) setCreateOpen(false);
            } else {
              const ok = await runCommand("report.create", payload, "보고서 초안을 만들었습니다.");
              dialogUnresolvedRef.current = !ok && pendingCommandsRef.current.size > pendingBefore;
              if (ok) setCreateOpen(false);
            }
          }}
        />
      ) : null}
    </ConsolePage>
  );
}

function CreateDialog({
  initial,
  busy,
  failure,
  pendingApproval,
  eventId,
  submitGateRef,
  unresolvedRef,
  onClose,
  onSubmit,
}: {
  initial: Report | null;
  busy: boolean;
  failure: { message: string; field?: string } | null;
  pendingApproval: number;
  eventId: string;
  submitGateRef: { current: boolean };
  unresolvedRef: { current: boolean };
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => Promise<void>;
}) {
  const [title, setTitle] = useState(initial?.title ?? "");
  const [subtitle, setSubtitle] = useState(initial?.subtitle ?? "");
  const [coverNote, setCoverNote] = useState(initial?.coverNote ?? "");
  const [summary, setSummary] = useState(initial?.summary ?? "");
  const [color, setColor] = useState(
    initial && /^#[0-9a-f]{6}$/i.test(initial.color) ? initial.color : "#E76D26"
  );
  const [sections, setSections] = useState<string[]>(
    initial?.sections.length ? [...initial.sections] : SECTION_LABELS.map((section) => section.id)
  );
  const [formError, setFormError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  // Cross-route guard: the dialog holds unsaved report input until it is
  // submitted or explicitly closed. Compared against the opened baseline so
  // a pristine dialog never blocks navigation.
  const defaultSections = SECTION_LABELS.map((section) => section.id);
  const pristine = initial
    ? title === initial.title &&
      subtitle === initial.subtitle &&
      coverNote === initial.coverNote &&
      summary === initial.summary &&
      color.toUpperCase() === initial.color.toUpperCase() &&
      sections.length === initial.sections.length &&
      sections.every((section) => initial.sections.includes(section))
    : title === "" &&
      subtitle === "" &&
      coverNote === "" &&
      summary === "" &&
      color.toUpperCase() === "#E76D26" &&
      sections.length === defaultSections.length &&
      sections.every((section) => defaultSections.includes(section));
  useConsoleDraftGuard(!pristine, "작성 중인 보고서 내용이 있습니다.");

  // Shared dismissal gate for Escape, backdrop and Cancel, mirroring
  // CreateEventDialog: in-flight writes block on the sync ref, an
  // unresolved save warns that it may already have applied, edited input
  // confirms, pristine dialogs close without a confirm.
  function confirmDialogClose(): boolean {
    if (submitGateRef.current || busy) return false;
    if (unresolvedRef.current) {
      return window.confirm("보고서 저장 결과를 아직 확인하지 못했습니다. 이미 저장되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?");
    }
    if (pristine) return true;
    return window.confirm("작성 중인 보고서 내용이 있습니다. 닫을까요?");
  }

  function toggleSection(id: string, checked: boolean) {
    setSections((prev) => checked ? [...new Set([...prev, id])] : prev.filter((section) => section !== id));
  }

  return (
    <ConsoleDialog
      title={initial ? "보고서 내용 편집" : "결과 보고서 만들기"}
      onClose={onClose}
      busy={busy}
      canClose={confirmDialogClose}
      initialFocusRef={titleRef}
      description={initial ? "내용을 수정해도 이 보고서의 집계는 생성 시점 그대로 유지합니다." : "현재 집계와 승인 사진을 보관합니다. 이후 변경은 자동 반영되지 않습니다."}
    >
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy) return;
          if (!sections.length) {
            setFormError("보고서 항목을 하나 이상 선택하세요.");
            return;
          }
          setFormError(null);
          void onSubmit({ title, subtitle, coverNote, summary, color, sections });
        }}
      >
          {!initial && pendingApproval > 0 ? (
            <div className={styles.help} role="status">
              승인 대기 {pendingApproval}명이 남아 있습니다. 보고서는 지금 집계로 고정되므로 이후 승인은 반영되지 않습니다.{" "}
              <Link href={`/console/events/${encodeURIComponent(eventId)}/participants?status=PENDING`}>
                참가자에서 승인 처리하기
              </Link>
            </div>
          ) : null}
          <div>
            <label htmlFor="report-title">보고서 제목 (필수)</label>
            <input
              id="report-title"
              ref={titleRef}
              type="text"
              maxLength={100}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              aria-invalid={failure?.field === "title" || undefined}
              aria-describedby={failure?.field === "title" ? "report-dialog-error" : undefined}
              required
            />
          </div>
          <div>
            <label htmlFor="report-subtitle">표지 부제목</label>
            <input
              id="report-subtitle"
              type="text"
              maxLength={100}
              value={subtitle}
              onChange={(event) => setSubtitle(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="report-cover-note">표지 문구</label>
            <textarea
              id="report-cover-note"
              maxLength={500}
              value={coverNote}
              onChange={(event) => setCoverNote(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="report-summary">운영 요약</label>
            <textarea
              id="report-summary"
              maxLength={4000}
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="report-color">보고서 테마 색</label>
            <input
              id="report-color"
              type="color"
              value={color}
              onChange={(event) => setColor(event.target.value)}
            />
          </div>
          <fieldset>
            <legend>포함할 항목</legend>
            {SECTION_LABELS.map((section) => (
              <label key={section.id} className={styles.check}>
                <input
                  type="checkbox"
                  checked={sections.includes(section.id)}
                  onChange={(event) => toggleSection(section.id, event.target.checked)}
                />
                {section.label}
              </label>
            ))}
          </fieldset>
          {formError ? <p role="alert" className={styles.alert}>{formError}</p> : null}
          {failure ? <p id="report-dialog-error" role="alert" className={styles.alert}>{failure.message}</p> : null}
          <ConsoleFormActions>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => { if (!busy && confirmDialogClose()) onClose(); }}
              disabled={busy}
            >
              취소
            </button>
            <button type="submit" className="button button-primary" disabled={busy}>
              {busy ? "저장 중입니다" : initial ? "수정 저장" : "보고서 만들기"}
            </button>
          </ConsoleFormActions>
        </form>
    </ConsoleDialog>
  );
}
