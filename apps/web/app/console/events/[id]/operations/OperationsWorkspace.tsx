"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import styles from "./operations.module.css";

type Desk = { id: string; name: string; action: string; mode: string; open: boolean };
type Booth = {
  id: string;
  name: string;
  zone: string;
  status: string;
  capacity: number;
  limit: number;
  used: number;
};
type Assignment = { id: string; accountId: string; type: string; targetId: string };
type Account = { id: string; name: string; role: string; active: boolean };

type BoothMapPoint = { boothId: string; x: number; y: number };
type BoothMapDraft = { version: number; image: { fileId: string; name: string; width: number; height: number }; points: BoothMapPoint[] };
type BoothMapState = {
  draft: BoothMapDraft | null;
  published: (BoothMapDraft & { publishedAt: string }) | null;
};

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      eventId: string;
      stampEnabled: boolean;
      stampMode: string;
      visitsCount: number;
      boothMap: BoothMapState;
      desks: Desk[];
      booths: Booth[];
      assignments: Assignment[];
      accounts: Account[];
    };

type Failure = { message: string; field?: string };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

const DESK_ACTION_LABEL: Record<string, string> = { IN: "입장", OUT: "퇴장" };
const BOOTH_STATUS_LABEL: Record<string, string> = {
  WAITING: "대기",
  OPEN: "진행",
  CLOSED: "종료",
};

export default function OperationsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [deskOpen, setDeskOpen] = useState(false);
  const [boothOpen, setBoothOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState(false);
  const [mapUploading, setMapUploading] = useState(false);
  const [mapPlacing, setMapPlacing] = useState<string>("");
  const [mapDraftPoints, setMapDraftPoints] = useState<BoothMapPoint[] | null>(null);
  const [mapImageOverride, setMapImageOverride] = useState<BoothMapDraft["image"] | null>(null);

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
              desks?: unknown;
              booths?: unknown;
              assignments?: unknown;
              checks?: unknown;
              visits?: unknown;
              stampMode?: unknown;
              boothMap?: unknown;
            }>;
          } | null;
        } | null;
        const bootstrap = data?.state;
        if (!res.ok || !bootstrap) {
          setState({ kind: "failed", message: "현장 운영 정보를 불러오지 못했습니다." });
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
        const desks: Desk[] = Array.isArray(workspace.desks)
          ? workspace.desks.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const desk = item as Record<string, unknown>;
              if (typeof desk.id !== "string" || !desk.id) return [];
              return [{
                id: desk.id,
                name: text(desk.name),
                action: text(desk.action) || "IN",
                mode: text(desk.mode) || "desk",
                open: desk.open !== false,
              }];
            })
          : [];
        const booths: Booth[] = Array.isArray(workspace.booths)
          ? workspace.booths.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const booth = item as Record<string, unknown>;
              if (typeof booth.id !== "string" || !booth.id) return [];
              return [{
                id: booth.id,
                name: text(booth.name),
                zone: text(booth.zone),
                status: text(booth.status) || "WAITING",
                capacity: Number(booth.capacity) || 0,
                limit: Number(booth.limit) || 1,
                used: Number(booth.used) || 0,
              }];
            })
          : [];
        const assignments: Assignment[] = Array.isArray(workspace.assignments)
          ? workspace.assignments.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const assignment = item as Record<string, unknown>;
              if (typeof assignment.id !== "string" || !assignment.id) return [];
              return [{
                id: assignment.id,
                accountId: text(assignment.accountId),
                type: text(assignment.type) || "DESK",
                targetId: text(assignment.targetId),
              }];
            })
          : [];
        const features = Array.isArray(event.features)
          ? event.features.filter((feature): feature is string => typeof feature === "string")
          : [];
        const parseBoothMap = (value: unknown): BoothMapState => {
          const source = value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
          const parseOne = (raw: unknown): BoothMapDraft | null => {
            const map = raw && typeof raw === "object" && !Array.isArray(raw)
              ? (raw as Record<string, unknown>)
              : null;
            if (!map) return null;
            const image = map.image && typeof map.image === "object"
              ? (map.image as Record<string, unknown>)
              : null;
            if (!image || typeof image.fileId !== "string" || !image.fileId) return null;
            const points: BoothMapPoint[] = Array.isArray(map.points)
              ? map.points.flatMap((item) => {
                  if (typeof item !== "object" || item === null) return [];
                  const point = item as Record<string, unknown>;
                  if (typeof point.boothId !== "string") return [];
                  const x = Number(point.x);
                  const y = Number(point.y);
                  if (!Number.isFinite(x) || !Number.isFinite(y)) return [];
                  return [{ boothId: point.boothId, x, y }];
                })
              : [];
            return {
              version: Number(map.version) || 0,
              image: {
                fileId: image.fileId,
                name: text(image.name),
                width: Number(image.width) || 0,
                height: Number(image.height) || 0,
              },
              points,
            };
          };
          const published = parseOne(source.published);
          return {
            draft: parseOne(source.draft),
            published: published
              ? { ...published, publishedAt: text((source.published as Record<string, unknown>)?.publishedAt) }
              : null,
          };
        };
        const accounts: Account[] = Array.isArray(bootstrap.accounts)
          ? bootstrap.accounts.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const account = item as Record<string, unknown>;
              if (typeof account.id !== "string" || !account.id) return [];
              return [{
                id: account.id,
                name: text(account.name) || account.id,
                role: text(account.role),
                active: account.active !== false,
              }];
            })
          : [];
        setState({
          kind: "ready",
          eventName: text(event.name),
          eventId,
          stampEnabled: features.includes("stamp"),
          stampMode: workspace.stampMode === "SELF" ? "SELF" : "STAFF",
          visitsCount: Array.isArray(workspace.visits) ? workspace.visits.length : 0,
          boothMap: parseBoothMap(workspace.boothMap),
          desks,
          booths,
          assignments,
          accounts,
        });
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

  const staffAccounts = useMemo(
    () => (state.kind === "ready"
      ? state.accounts.filter((account) => account.role === "STAFF" && account.active)
      : []),
    [state]
  );

  function reload() {
    setReloadTick((tick) => tick + 1);
    window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
  }

  async function runCommand(
    command: string,
    payload: Record<string, unknown>,
    successMessage: string
  ) {
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
      reload();
      return true;
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function saveBoothMapDraft() {
    const image = mapImageOverride ?? boothMap.draft?.image ?? null;
    if (!image) {
      setFailure({ message: "배치도 이미지를 먼저 올리세요." });
      return;
    }
    const ok = await runCommand(
      "booth.map.save",
      {
        expectedDraftVersion: boothMap.draft?.version ?? 0,
        fileId: image.fileId,
        points: mapPoints,
      },
      "부스 지도 초안을 저장했습니다."
    );
    if (ok) {
      setMapDraftPoints(null);
      setMapImageOverride(null);
      setMapPlacing("");
    }
  }

  async function publishBoothMap() {
    const ok = await runCommand(
      "booth.map.publish",
      { expectedDraftVersion: boothMap.draft?.version ?? 0 },
      "부스 지도를 게시했습니다. 참가자 화면에 보입니다."
    );
    if (ok) setMapDraftPoints(null);
  }

  async function unpublishBoothMap() {
    if (!window.confirm("게시된 부스 지도를 내릴까요? 참가자 화면에서 사라집니다.")) return;
    await runCommand(
      "booth.map.unpublish",
      { expectedPublishedVersion: boothMap.published?.version ?? 0 },
      "부스 지도를 내렸습니다."
    );
  }

  async function setStampMode(mode: "SELF" | "STAFF") {
    if (mode === stampMode) return;
    const label = mode === "SELF" ? "참가자가 부스 QR을 직접 스캔" : "스태프가 참가자 티켓을 확인";
    if (!window.confirm(`인증 방식을 '${label}'(으)로 바꿀까요?\n인증 기록이 있으면 바꿀 수 없습니다.`)) return;
    await runCommand("booth.mode", { mode, acknowledge: true }, "부스 인증 방식을 바꿨습니다.");
  }

  if (state.kind === "loading") {
    return <p className="loading-state" role="status">현장 운영 정보를 불러오고 있습니다.</p>;
  }
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{state.message}</p>
        <button type="button" className="button button-secondary" onClick={reload}>
          다시 불러오기
        </button>
      </section>
    );
  }
  const { desks, booths, assignments, accounts, stampEnabled, eventName } = state;
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));
  const deskName = new Map(desks.map((desk) => [desk.id, desk.name]));
  const boothName = new Map(booths.map((booth) => [booth.id, booth.name]));
  const deskStaffCount = assignments.filter((assignment) => assignment.type === "DESK").length;

  const stampMode = state.stampMode;
  const visitsCount = state.visitsCount;
  const boothMap = state.boothMap;
  const mapPoints = mapDraftPoints ?? boothMap.draft?.points ?? [];
  const pointFor = (boothId: string) => mapPoints.find((point) => point.boothId === boothId) ?? null;

  // Booth-map draft edits stay local until 저장; mapDraftPoints holds the
  // working set, and each placement is normalized to 0..1 so the published
  // map scales to any board size.
  async function uploadMapImage(file: File) {
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setFailure({ message: "배치도는 PNG·JPG·WebP 이미지를 사용하세요." });
      return;
    }
    if (file.size > 600000) {
      setFailure({ message: "600KB 이하 배치도 이미지를 올려주세요." });
      return;
    }
    setMapUploading(true);
    setFailure(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/files?name=${encodeURIComponent(file.name)}&commandId=${encodeURIComponent(randomCommandId())}`,
        { method: "POST", headers: { "content-type": file.type }, body: file }
      );
      const data = (await res.json().catch(() => null)) as {
        file?: { fileId?: unknown; name?: unknown; width?: unknown; height?: unknown };
        error?: unknown;
      } | null;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      if (!res.ok || !fileId) {
        setFailure({ message: typeof data?.error === "string" ? data.error : "배치도를 올리지 못했습니다." });
        return;
      }
      if (boothMap.draft && boothMap.draft.image.fileId !== fileId && mapPoints.length) {
        // The server refuses an image swap with leftover points; clear them
        // here so the operator learns before the save round-trip.
        setMapDraftPoints([]);
        setFailure({ message: "배치도를 교체했습니다. 부스 위치를 다시 지정한 뒤 저장하세요." });
        setMapImageOverride({
          fileId,
          name: typeof data?.file?.name === "string" ? data.file.name : file.name,
          width: Number(data?.file?.width) || 0,
          height: Number(data?.file?.height) || 0,
        });
        return;
      }
      setMapImageOverride({
        fileId,
        name: typeof data?.file?.name === "string" ? data.file.name : file.name,
        width: Number(data?.file?.width) || 0,
        height: Number(data?.file?.height) || 0,
      });
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setMapUploading(false);
    }
  }

  return (
    <div className={styles.wrapper}>
      <header className={styles.header}>
        <p className="eyebrow">현장 운영</p>
        <h1>{eventName}</h1>
      </header>

      {failure && !(deskOpen || boothOpen || assignOpen) ? (
        <p role="alert" className={styles.alert}>{failure.message}</p>
      ) : null}
      {notice ? <p role="status" className={styles.notice}>{notice}</p> : null}

      <section className={styles.section} aria-labelledby="ops-desks">
        <div className={styles.sectionHead}>
          <h2 id="ops-desks">데스크</h2>
          <button
            type="button"
            className="button button-secondary"
            onClick={() => { setDeskOpen(true); setFailure(null); }}
          >
            데스크 추가
          </button>
        </div>
        {desks.length ? (
          <ul className={styles.list}>
            {desks.map((desk) => (
              <li key={desk.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <strong>{desk.name}</strong>
                  <span className={styles.rowMeta}>
                    {DESK_ACTION_LABEL[desk.action] ?? "작업 미정"}
                    {" · "}
                    {desk.mode === "tablet" ? "태블릿" : "데스크"}
                    {" · "}
                    {desk.open ? "가동 중" : "중지됨"}
                  </span>
                </div>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void runCommand(
                    "desk.set-open",
                    { id: desk.id, open: !desk.open },
                    `${desk.name} 데스크를 ${desk.open ? "중지" : "가동"}했습니다.`
                  )}
                >
                  {desk.open ? "가동 중지" : "가동 시작"}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">등록된 데스크가 없습니다. 진행 중 전환에는 데스크와 스태프 배정이 필요합니다.</p>
        )}
      </section>

      <section className={styles.section} aria-labelledby="ops-booths">
        <div className={styles.sectionHead}>
          <h2 id="ops-booths">부스</h2>
          {stampEnabled ? (
            <button
              type="button"
              className="button button-secondary"
              onClick={() => { setBoothOpen(true); setFailure(null); }}
            >
              부스 추가
            </button>
          ) : null}
        </div>
        {!stampEnabled ? (
          <p className="notice" role="status">
            이 행사에서 부스 인증 기능을 먼저 켜야 부스를 사용할 수 있습니다.
          </p>
        ) : booths.length ? (
          <ul className={styles.list}>
            {booths.map((booth) => (
              <li key={booth.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <strong>{booth.name}</strong>
                  <span className={styles.rowMeta}>
                    {booth.zone || "구역 미지정"}
                    {" · "}
                    {BOOTH_STATUS_LABEL[booth.status] ?? "상태 미정"}
                    {" · "}
                    잔여 {booth.capacity ? Math.max(0, booth.capacity - booth.used) : "제한 없음"}
                    {" · "}
                    참가자 {booth.limit}회
                  </span>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">등록된 부스가 없습니다.</p>
        )}
      </section>

      {stampEnabled ? (
        <section className={styles.section} aria-labelledby="ops-booth-mode">
          <div className={styles.sectionHead}>
            <h2 id="ops-booth-mode">부스 인증 방식</h2>
          </div>
          <p className={styles.rowMeta}>
            {stampMode === "SELF"
              ? "참가자가 부스 QR을 직접 스캔합니다. 부스마다 QR을 붙여 주세요."
              : "스태프가 참가자 티켓을 확인해 처리합니다. 부스 배정이 필요합니다."}
            {visitsCount ? ` · 이미 인증 ${visitsCount}건이라 방식을 바꿀 수 없습니다.` : ""}
          </p>
          <div className={styles.rowActions}>
            <button
              type="button"
              className={`button ${stampMode === "STAFF" ? "button-primary" : "button-secondary"}`}
              disabled={busy || visitsCount > 0 || stampMode === "STAFF"}
              aria-pressed={stampMode === "STAFF"}
              onClick={() => void setStampMode("STAFF")}
            >
              스태프 확인
            </button>
            <button
              type="button"
              className={`button ${stampMode === "SELF" ? "button-primary" : "button-secondary"}`}
              disabled={busy || visitsCount > 0 || stampMode === "SELF"}
              aria-pressed={stampMode === "SELF"}
              onClick={() => void setStampMode("SELF")}
            >
              참가자 셀프 스캔
            </button>
          </div>
        </section>
      ) : null}

      {stampEnabled ? (
        <section className={styles.section} aria-labelledby="ops-booth-map">
          <div className={styles.sectionHead}>
            <h2 id="ops-booth-map">부스 지도</h2>
          </div>
          <p className={styles.rowMeta}>
            배치도를 올리고, 부스를 골라 이미지를 눌러 위치를 찍습니다. 게시해야 참가자 화면에 보입니다.
          </p>
          <div className={styles.rowActions}>
            <label className="button button-secondary">
              {mapUploading ? "올리는 중…" : boothMap.draft ? "배치도 교체" : "배치도 올리기"}
              <input
                type="file"
                className="sr-only"
                accept="image/png,image/jpeg,image/webp"
                disabled={mapUploading || busy}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadMapImage(file);
                  event.target.value = "";
                }}
              />
            </label>
            {mapImageOverride || boothMap.draft ? (
              <>
                <button type="button" className="button button-primary" disabled={busy || mapUploading} onClick={() => void saveBoothMapDraft()}>
                  초안 저장
                </button>
                <button type="button" className="button button-secondary" disabled={busy || !boothMap.draft} onClick={() => void publishBoothMap()}>
                  게시
                </button>
              </>
            ) : null}
            {boothMap.published ? (
              <button type="button" className="button button-secondary" disabled={busy} onClick={() => void unpublishBoothMap()}>
                게시 내리기
              </button>
            ) : null}
          </div>
          {(() => {
            const image = mapImageOverride ?? boothMap.draft?.image ?? null;
            if (!image) {
              return <p className="empty-state">아직 배치도가 없습니다. 배치도 올리기로 시작하세요.</p>;
            }
            return (
              <div className={styles.mapWrap}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  className={styles.mapImage}
                  src={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(image.fileId)}`}
                  alt="부스 배치도"
                  onClick={(event) => {
                    if (!mapPlacing) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const x = (event.clientX - rect.left) / rect.width;
                    const y = (event.clientY - rect.top) / rect.height;
                    const next = mapPoints.filter((point) => point.boothId !== mapPlacing);
                    next.push({
                      boothId: mapPlacing,
                      x: Math.min(1, Math.max(0, x)),
                      y: Math.min(1, Math.max(0, y)),
                    });
                    setMapDraftPoints(next);
                    setMapPlacing("");
                  }}
                />
                {mapPoints.map((point) => {
                  const booth = booths.find((item) => item.id === point.boothId);
                  return (
                    <span
                      key={point.boothId}
                      className={styles.mapPoint}
                      style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                    >
                      {booth?.name ?? "부스"}
                    </span>
                  );
                })}
              </div>
            );
          })()}
          {booths.length ? (
            <ul className={styles.list}>
              {booths.map((booth) => {
                const point = pointFor(booth.id);
                return (
                  <li key={booth.id} className={styles.row}>
                    <div className={styles.rowMain}>
                      <strong>{booth.name}</strong>
                      <span className={styles.rowMeta}>{point ? "위치 지정됨" : "위치 미지정"}</span>
                    </div>
                    <button
                      type="button"
                      className="button button-secondary"
                      disabled={busy}
                      onClick={() => setMapPlacing(mapPlacing === booth.id ? "" : booth.id)}
                    >
                      {mapPlacing === booth.id ? "지정 취소" : point ? "다시 지정" : "위치 지정"}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {mapPlacing ? (
            <p className="notice" role="status">
              {boothName.get(mapPlacing) ?? "부스"} 위치를 이미지에서 눌러 지정하세요.
            </p>
          ) : null}
          {boothMap.published ? (
            <p className={styles.rowMeta}>
              게시본 v{boothMap.published.version} · {boothMap.published.points.length}개 위치
              {boothMap.published.publishedAt ? ` · ${boothMap.published.publishedAt.slice(0, 10)}` : ""}
            </p>
          ) : null}
        </section>
      ) : null}

      <section className={styles.section} aria-labelledby="ops-staff">
        <div className={styles.sectionHead}>
          <h2 id="ops-staff">스태프 배정</h2>
          <button
            type="button"
            className="button button-primary"
            onClick={() => { setAssignOpen(true); setFailure(null); }}
            disabled={!desks.length}
          >
            스태프 배정
          </button>
        </div>
        {!desks.length ? (
          <p className="notice" role="status">배정하려면 먼저 데스크를 만들어야 합니다.</p>
        ) : assignments.length ? (
          <ul className={styles.list}>
            {assignments.map((assignment) => (
              <li key={assignment.id} className={styles.row}>
                <div className={styles.rowMain}>
                  <strong>{accountName.get(assignment.accountId) ?? "알 수 없는 계정"}</strong>
                  <span className={styles.rowMeta}>
                    {assignment.type === "DESK" ? "데스크" : "부스"}
                    {" · "}
                    {(assignment.type === "DESK"
                      ? deskName.get(assignment.targetId)
                      : boothName.get(assignment.targetId)) ?? "알 수 없는 담당"}
                  </span>
                </div>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void runCommand(
                    "staff.unassign",
                    { id: assignment.id },
                    "배정을 해제했습니다."
                  )}
                >
                  해제
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="empty-state">
            배정된 스태프가 없습니다. 진행 중으로 전환하려면 입장 데스크에 스태프를 배정하세요.
          </p>
        )}
        {!deskStaffCount ? (
          <p className="notice" role="status">
            진행 중 전환 조건: 등록 데스크 {desks.length}개 · 데스크 배정 {deskStaffCount}건
          </p>
        ) : null}
      </section>

      {deskOpen ? (
        <DeskDialog
          busy={busy}
          failure={failure}
          onClose={() => setDeskOpen(false)}
          onSubmit={async (payload) => {
            const ok = await runCommand("desk.save", payload, "데스크를 저장했습니다.");
            if (ok) setDeskOpen(false);
          }}
        />
      ) : null}
      {boothOpen ? (
        <BoothDialog
          busy={busy}
          failure={failure}
          onClose={() => setBoothOpen(false)}
          onSubmit={async (payload) => {
            const ok = await runCommand("booth.save", payload, "부스를 저장했습니다.");
            if (ok) setBoothOpen(false);
          }}
        />
      ) : null}
      {assignOpen ? (
        <AssignDialog
          busy={busy}
          failure={failure}
          staffAccounts={staffAccounts}
          desks={desks}
          booths={stampEnabled ? booths : []}
          onClose={() => setAssignOpen(false)}
          onSubmit={async (payload) => {
            const ok = await runCommand("staff.assign", payload, "스태프를 배정했습니다.");
            if (ok) setAssignOpen(false);
          }}
        />
      ) : null}
    </div>
  );
}

function Dialog({
  title,
  children,
  onClose,
  busy,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  busy: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    dialogRef.current
      ?.querySelector<HTMLElement>("button:not(:disabled), input, select, textarea, a[href]")
      ?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!busyRef.current) onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const items = Array.from(
        dialogRef.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input, select, textarea, a[href]"
        )
      ).filter((item) => item.tabIndex >= 0);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, []);
  return (
    <div
      className={styles.backdrop}
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        {children}
      </div>
    </div>
  );
}

function DialogError({ failure, id }: { failure: Failure | null; id: string }) {
  if (!failure) return null;
  return <p role="alert" id={id}>{failure.message}</p>;
}

function DeskDialog({
  busy,
  failure,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  failure: Failure | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [action, setAction] = useState("IN");
  const [mode, setMode] = useState("desk");
  return (
    <Dialog title="데스크 추가" onClose={onClose} busy={busy}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ name, action, mode, open: true });
        }}
      >
        <div>
          <label htmlFor="desk-name">데스크 이름</label>
          <input
            id="desk-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={failure?.field === "name" || undefined}
            aria-describedby={failure ? "desk-dialog-error" : undefined}
            required
          />
        </div>
        <div>
          <label htmlFor="desk-action">작업</label>
          <select id="desk-action" value={action} onChange={(event) => setAction(event.target.value)}>
            <option value="IN">입장</option>
            <option value="OUT">퇴장</option>
          </select>
        </div>
        <div>
          <label htmlFor="desk-mode">화면</label>
          <select id="desk-mode" value={mode} onChange={(event) => setMode(event.target.value)}>
            <option value="desk">데스크</option>
            <option value="tablet">태블릿</option>
          </select>
        </div>
        <DialogError failure={failure} id="desk-dialog-error" />
        <div className={styles.actions}>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
            {busy ? "저장 중입니다" : "데스크 저장"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function BoothDialog({
  busy,
  failure,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  failure: Failure | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState("");
  const [zone, setZone] = useState("");
  const [status, setStatus] = useState("WAITING");
  const [capacity, setCapacity] = useState("0");
  const [limit, setLimit] = useState("1");
  return (
    <Dialog title="부스 추가" onClose={onClose} busy={busy}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            name,
            zone,
            status,
            capacity: Number(capacity) || 0,
            limit: Number(limit) || 1,
          });
        }}
      >
        <div>
          <label htmlFor="booth-name">부스 이름</label>
          <input
            id="booth-name"
            type="text"
            value={name}
            onChange={(event) => setName(event.target.value)}
            aria-invalid={failure?.field === "name" || undefined}
            aria-describedby={failure ? "booth-dialog-error" : undefined}
            required
          />
        </div>
        <div>
          <label htmlFor="booth-zone">구역</label>
          <input id="booth-zone" type="text" value={zone} onChange={(event) => setZone(event.target.value)} />
        </div>
        <div>
          <label htmlFor="booth-status">상태</label>
          <select id="booth-status" value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="WAITING">대기</option>
            <option value="OPEN">진행</option>
            <option value="CLOSED">종료</option>
          </select>
        </div>
        <div className={styles.gridTwo}>
          <div>
            <label htmlFor="booth-capacity">수량 (0=제한 없음)</label>
            <input
              id="booth-capacity"
              type="number"
              min={0}
              inputMode="numeric"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
            />
          </div>
          <div>
            <label htmlFor="booth-limit">참가자 1인 횟수</label>
            <input
              id="booth-limit"
              type="number"
              min={1}
              inputMode="numeric"
              value={limit}
              onChange={(event) => setLimit(event.target.value)}
            />
          </div>
        </div>
        <DialogError failure={failure} id="booth-dialog-error" />
        <div className={styles.actions}>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
            {busy ? "저장 중입니다" : "부스 저장"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function AssignDialog({
  busy,
  failure,
  staffAccounts,
  desks,
  booths,
  onClose,
  onSubmit,
}: {
  busy: boolean;
  failure: Failure | null;
  staffAccounts: Account[];
  desks: Desk[];
  booths: Booth[];
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [type, setType] = useState("DESK");
  const [targetId, setTargetId] = useState("");
  const targets = type === "DESK" ? desks : booths;
  const currentTarget = targets.some((target) => target.id === targetId) ? targetId : "";
  return (
    <Dialog title="스태프 배정" onClose={onClose} busy={busy}>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ accountId, type, targetId: currentTarget });
        }}
      >
        <div>
          <label htmlFor="assign-account">현장 스태프</label>
          <select
            id="assign-account"
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
            aria-invalid={failure?.field === "accountId" || undefined}
            aria-describedby={failure ? "assign-dialog-error" : undefined}
            required
          >
            <option value="">선택하세요</option>
            {staffAccounts.map((account) => (
              <option key={account.id} value={account.id}>{account.name}</option>
            ))}
          </select>
          {!staffAccounts.length ? (
            <p className="notice" role="status">배정할 수 있는 활성 현장 스태프 계정이 없습니다. 조직 소유자가 계정을 만든 뒤에 다시 시도하세요.</p>
          ) : null}
        </div>
        <div>
          <label htmlFor="assign-type">업무 종류</label>
          <select
            id="assign-type"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setTargetId("");
            }}
          >
            <option value="DESK">데스크</option>
            {booths.length ? <option value="BOOTH">부스</option> : null}
          </select>
        </div>
        <div>
          <label htmlFor="assign-target">담당 대상</label>
          <select
            id="assign-target"
            value={currentTarget}
            onChange={(event) => setTargetId(event.target.value)}
            aria-invalid={failure?.field === "targetId" || undefined}
            aria-describedby={failure ? "assign-dialog-error" : undefined}
            required
          >
            <option value="">선택하세요</option>
            {targets.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name}
                {"mode" in target && target.mode === "tablet" ? " (태블릿)" : ""}
                {"action" in target ? ` · ${DESK_ACTION_LABEL[target.action] ?? "작업 미정"}` : ""}
              </option>
            ))}
          </select>
        </div>
        <DialogError failure={failure} id="assign-dialog-error" />
        <div className={styles.actions}>
          <button type="button" className="button button-secondary" onClick={onClose} disabled={busy}>
            취소
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || !accountId || !currentTarget}
          >
            {busy ? "배정 중입니다" : "배정 저장"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
