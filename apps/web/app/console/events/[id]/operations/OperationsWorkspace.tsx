"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import uiStyles from "../../../console-ui/console-ui.module.css";
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

// The participant map is the published one only; a draft that differs from it
// can be saved for hours without ever reaching the floor, so the screen names
// that gap instead of showing a bare "초안 저장" success.
function mapMatchesPublished(boothMap: BoothMapState): boolean {
  const { draft, published } = boothMap;
  if (!draft || !published) return false;
  if (draft.image.fileId !== published.image.fileId) return false;
  if (draft.points.length !== published.points.length) return false;
  const publishedByBooth = new Map(published.points.map((point) => [point.boothId, point]));
  return draft.points.every((point) => {
    const counterpart = publishedByBooth.get(point.boothId);
    return (
      counterpart !== undefined &&
      Math.abs(counterpart.x - point.x) < 1e-6 &&
      Math.abs(counterpart.y - point.y) < 1e-6
    );
  });
}

type State =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      stage: string;
      canManage: boolean;
      eventMeta?: string;
      eventId: string;
      stampEnabled: boolean;
      stampMode: string;
      visitsCount: number;
      boothMap: BoothMapState;
      screenEnabled: boolean;
      display: { type: string; moduleId: string; noticeId: string };
      displayOptions: {
        notices: Array<{ id: string; title: string; published: boolean }>;
        modules: Array<{ id: string; title: string; type: string; published: boolean; revealed: boolean; hasPublishedDraw: boolean }>;
        approvedPhotos: number;
        approvedQuestions: number;
      };
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

// Sticky jump-nav readout labels. The nav itself stays the shared
// ConsoleSectionNav (native anchors only); this map only names the section
// the observer currently sees so the operator can read where they are.
const SECTION_LABELS: Record<string, string> = {
  "ops-desks": "데스크",
  "ops-booths": "부스",
  "ops-booth-mode": "부스 인증 방식",
  "ops-booth-map": "부스 지도",
  "ops-display": "전광판 출력",
  "ops-staff": "스태프 배정",
};

export default function OperationsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [deskOpen, setDeskOpen] = useState(false);
  const [editingDesk, setEditingDesk] = useState<Desk | null>(null);
  const [boothOpen, setBoothOpen] = useState(false);
  const [editingBooth, setEditingBooth] = useState<Booth | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  // Row-level assignment preset (UI only): a desk/booth row opens the same
  // AssignDialog with its type+target already chosen, so the operator only
  // picks staff and submits. Null means the generic #ops-staff dialog with
  // its existing defaults. The dialog unmounts on close, so each open starts
  // from its own preset and never inherits a stale target.
  const [assignPreset, setAssignPreset] = useState<{ type: string; targetId: string } | null>(null);
  const [mapUploading, setMapUploading] = useState(false);
  const [mapPlacing, setMapPlacing] = useState<string>("");
  const [mapDraftPoints, setMapDraftPoints] = useState<BoothMapPoint[] | null>(null);
  const [mapImageOverride, setMapImageOverride] = useState<BoothMapDraft["image"] | null>(null);
  const [displayChoice, setDisplayChoice] = useState("");
  const [stampModePending, setStampModePending] = useState<"SELF" | "STAFF" | null>(null);
  const [mapUnpublishPending, setMapUnpublishPending] = useState(false);
  const [deskDirty, setDeskDirty] = useState(false);
  const [boothDirty, setBoothDirty] = useState(false);
  const [assignDirty, setAssignDirty] = useState(false);
  // Field-day reading aids (UI only). activeSection names the section in
  // view for the sticky jump-nav readout; presetOpen folds the
  // before-the-day presets (auth mode, booth map) on phones while the
  // same-day controls (desks, display) stay unfolded.
  const [activeSection, setActiveSection] = useState("ops-desks");
  const [presetOpen, setPresetOpen] = useState({ mode: true, map: true });

  // One idempotency id per command+payload fingerprint (same discipline as
  // the settings command cache): the same logical write reuses its id, any
  // edit fingerprints differently. Entries clear only on success. Toggles
  // and version-guarded map writes converge on replay instead of doubling.
  const commandIdCache = useRef(new Map<string, string>());
  // Synchronous in-flight gate: `busy` flips only after rerender, so
  // same-turn double submits (including dialog saves) would overlap.
  const commandBusyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // The actor comes from the session (/api/auth/me), concurrent with
        // bootstrap: this console 403s STAFF writes on the server, so the
        // write affordances below gate on the same role+membership contract.
        // No granular write array exists server-side; none is consulted.
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
        const meData = (await meRes.json().catch(() => null)) as {
          user?: { id?: unknown; role?: unknown } | null;
        } | null;
        const meUser =
          meData?.user && typeof meData.user === "object"
            ? (meData.user as Record<string, unknown>)
            : null;
        const role = typeof meUser?.role === "string" ? meUser.role : "";
        const myId = typeof meUser?.id === "string" ? meUser.id : "";
        const res = bootRes;
        const data = (await res.json().catch(() => null)) as {
          state?: {
            events?: unknown;
            clients?: unknown;
            accounts?: unknown;
            memberships?: unknown;
            workspaces?: Record<string, {
              venue?: unknown;
              desks?: unknown;
              booths?: unknown;
              assignments?: unknown;
              checks?: unknown;
              visits?: unknown;
              stampMode?: unknown;
              boothMap?: unknown;
              display?: unknown;
              notices?: unknown;
              modules?: unknown;
              photos?: unknown;
              questions?: unknown;
            }>;
          } | null;
        } | null;
        const bootstrap = data?.state;
        if (!res.ok || !meUser || !bootstrap) {
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
        const clientName = Array.isArray(bootstrap.clients)
          ? bootstrap.clients
              .map((item) => item && typeof item === "object" ? item as Record<string, unknown> : null)
              .find((client) => client?.id === event.clientId)?.name
          : "";
        const eventMemberships: Array<{ accountId: string; eventId: string }> = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const membership = item as Record<string, unknown>;
              if (typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
              return [{ accountId: membership.accountId, eventId: membership.eventId }];
            })
          : [];
        // Display gate mirroring the current server contract: AGENCY
        // everywhere, MANAGER on their own events. STAFF console writes 403
        // server-side, so mutation affordances below stay disabled for them
        // while reads keep working. The server stays authoritative.
        const canManage =
          role === "AGENCY" ||
          (role === "MANAGER" &&
            eventMemberships.some((membership) => membership.accountId === myId && membership.eventId === eventId));
        const venue = workspace.venue && typeof workspace.venue === "object"
          ? workspace.venue as Record<string, unknown>
          : {};
        setState({
          kind: "ready",
          eventName: text(event.name),
          stage: text(event.stage).toUpperCase(),
          canManage,
          eventMeta: formatConsoleEventMeta({
            clientName: text(clientName),
            date: text(event.date),
            start: text(event.start),
            end: text(event.end),
            venue: text(venue.name),
          }),
          eventId,
          stampEnabled: features.includes("stamp"),
          stampMode: workspace.stampMode === "SELF" ? "SELF" : "STAFF",
          visitsCount: Array.isArray(workspace.visits) ? workspace.visits.length : 0,
          boothMap: parseBoothMap(workspace.boothMap),
          screenEnabled: features.includes("screen"),
          display: {
            type: typeof (workspace.display as Record<string, unknown> | undefined)?.type === "string"
              ? String((workspace.display as Record<string, unknown>).type)
              : "idle",
            moduleId: text((workspace.display as Record<string, unknown> | undefined)?.moduleId),
            noticeId: text((workspace.display as Record<string, unknown> | undefined)?.noticeId),
          },
          displayOptions: {
            notices: Array.isArray(workspace.notices)
              ? workspace.notices.flatMap((item) => {
                  if (typeof item !== "object" || item === null) return [];
                  const notice = item as Record<string, unknown>;
                  if (typeof notice.id !== "string") return [];
                  return [{ id: notice.id, title: text(notice.title), published: notice.published === true }];
                })
              : [],
            modules: Array.isArray(workspace.modules)
              ? workspace.modules.flatMap((item) => {
                  if (typeof item !== "object" || item === null) return [];
                  const module = item as Record<string, unknown>;
                  if (typeof module.id !== "string" || typeof module.type !== "string") return [];
                  return [{
                    id: module.id,
                    title: text(module.title),
                    type: module.type,
                    published: module.published === true,
                    revealed: module.revealed === true,
                    hasPublishedDraw: Array.isArray(module.drawHistory)
                      && module.drawHistory.some((row) => (row as Record<string, unknown>)?.published === true),
                  }];
                })
              : [],
            approvedPhotos: Array.isArray(workspace.photos)
              ? workspace.photos.filter((photo) => (photo as Record<string, unknown>)?.status === "APPROVED").length
              : 0,
            approvedQuestions: Array.isArray(workspace.questions)
              ? workspace.questions.filter((question) => (question as Record<string, unknown>)?.approved === true).length
              : 0,
          },
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

  // Presets fold on phones (≤768px) and stay open on desktop. The operator
  // can still unfold either side by hand; a viewport change only restores
  // the side-appropriate default, never a command or a draft.
  useEffect(() => {
    const query = window.matchMedia("(max-width: 768px)");
    const sync = () => {
      setPresetOpen(query.matches ? { mode: false, map: false } : { mode: true, map: true });
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  // Names the section in view for the sticky jump-nav readout. Observes
  // only the anchors this screen renders; anchor clicks keep working
  // natively with or without the observer.
  useEffect(() => {
    if (state.kind !== "ready") return;
    if (typeof IntersectionObserver === "undefined") return;
    const ids = [
      "ops-desks",
      "ops-booths",
      ...(state.stampEnabled ? ["ops-booth-mode", "ops-booth-map"] : []),
      ...(state.screenEnabled ? ["ops-display"] : []),
      "ops-staff",
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

  // Draft-guard dirty state, evaluated before every early return below. Only
  // true diffs and truthful pending intent: dialog input diffs, unsaved map
  // points/image overrides, an unapplied display choice, in-flight uploads,
  // and command receipts kept after ambiguous responses. Merely opening a
  // pristine dialog is not dirty — its own canClose already closes those
  // silently — so a reload with a pristine dialog warns nothing.
  const guardDisplayDirty =
    state.kind === "ready" &&
    displayChoice !== "" &&
    displayChoice !== `${state.display.type}|${state.display.type === "notice" ? state.display.noticeId : state.display.moduleId}`;
  useConsoleDraftGuard(
    deskDirty ||
      boothDirty ||
      assignDirty ||
      mapDraftPoints !== null ||
      mapImageOverride !== null ||
      guardDisplayDirty ||
      mapUploading ||
      commandBusyRef.current ||
      commandIdCache.current.size > 0,
    "작성 중인 현장 운영 내용이나 저장하지 않은 지도·출력이 있습니다. 페이지를 떠나면 사라집니다."
  );

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
    if (busy || commandBusyRef.current) return false;
    // Archived and unauthorized writes never reach the server from here;
    // the server stays authoritative either way.
    if (writeBlocked) return false;
    commandBusyRef.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    const fingerprint = `${command}:${JSON.stringify(payload)}`;
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
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } | null;
      if (!res.ok) {
        if (res.status !== 408 && res.status < 500) {
          // Definitive rejection: nothing applied, so the id carries no
          // replayable receipt. Clearing also keeps the draft guard truthful:
          // only ambiguous responses leave pending intent behind.
          commandIdCache.current.delete(fingerprint);
        }
        setFailure({
          message: typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return false;
      }
      commandIdCache.current.delete(fingerprint);
      setNotice(successMessage);
      reload();
      return true;
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    } finally {
      commandBusyRef.current = false;
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

  function requestUnpublishBoothMap() {
    setMapUnpublishPending(true);
  }

  async function confirmUnpublishBoothMap() {
    if (!mapUnpublishPending) return;
    await runCommand(
      "booth.map.unpublish",
      { expectedPublishedVersion: boothMap.published?.version ?? 0 },
      "부스 지도를 내렸습니다."
    );
    setMapUnpublishPending(false);
  }

  function requestStampMode(mode: "SELF" | "STAFF") {
    if (mode === stampMode) return;
    setStampModePending(mode);
  }

  async function confirmStampMode() {
    const mode = stampModePending;
    if (mode === null) return;
    if (mode === stampMode) {
      setStampModePending(null);
      return;
    }
    await runCommand("booth.mode", { mode, acknowledge: true }, "부스 인증 방식을 바꿨습니다.");
    setStampModePending(null);
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="operations" eventId={eventId}>
        <ConsoleStatePanel kind="loading" message="현장 운영 정보를 불러오고 있습니다." onRetry={() => {}} />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="operations" eventId={eventId}>
        <ConsoleStatePanel kind="failed" message={state.message} onRetry={() => setReloadTick((tick) => tick + 1)} />
      </ConsolePage>
    );
  }
  const { desks, booths, assignments, accounts, stampEnabled } = state;
  // 보관된 행사는 서버가 모든 쓰기를 거부하므로 쓰기 affordance를 미리
  // 잠그고 이유를 밝힌다. 조회·기록 확인은 그대로 둔다.
  const archived = state.stage === "ARCHIVED";
  const archivedReason = "보관된 행사는 읽기 전용입니다";
  // Write gate: archived events reject every command server-side, and STAFF
  // console writes 403 server-side (their staff work routes are separate and
  // unaffected). Reads, placement previews and downloads keep working.
  const writeBlocked = archived || !state.canManage;
  const writeBlockedReason = archived
    ? archivedReason
    : "현장 운영을 변경할 운영 권한이 없습니다";
  const accountName = new Map(accounts.map((account) => [account.id, account.name]));
  const deskName = new Map(desks.map((desk) => [desk.id, desk.name]));
  const boothName = new Map(booths.map((booth) => [booth.id, booth.name]));
  const deskStaffCount = assignments.filter((assignment) => assignment.type === "DESK").length;
  // Staff can be assigned to booths without any desk: the LIVE precondition
  // still needs a desk separately (see the notice below), but assignment
  // itself only needs a selectable target of either kind.
  const assignableTargets = desks.length + (stampEnabled ? booths.length : 0);

  const stampMode = state.stampMode;
  const visitsCount = state.visitsCount;
  const boothMap = state.boothMap;
  const display = state.display;
  const displayOptions = state.displayOptions;
  const screenEnabled = state.screenEnabled;

  // Each section states its own status in one summary line (same-day vs
  // before-the-day is the same description slot, one method everywhere).
  // Counts reuse the loaded rows; an empty roster stays quiet and lets the
  // section's existing guidance speak instead.
  const deskOpenCount = desks.filter((desk) => desk.open).length;
  const boothOpenCount = booths.filter((booth) => booth.status === "OPEN").length;
  const modeValueLabel = stampMode === "SELF" ? "참가자 셀프 스캔" : "스태프 확인";
  const mapStatusText = boothMap.published
    ? `게시 중 · v${boothMap.published.version} ${boothMap.published.points.length}개 위치`
    : boothMap.draft
      ? "초안만 있음 · 미게시"
      : "미게시";
  const deskSummary = desks.length
    ? `지금 할 일 · 가동 ${deskOpenCount} / 전체 ${desks.length}`
    : "지금 할 일";
  const boothSummary = stampEnabled && booths.length
    ? `지금 할 일 · 운영 ${boothOpenCount} / 전체 ${booths.length}`
    : "지금 할 일";
  const modeSummary = `사전 설정 · ${modeValueLabel}`;
  const mapSummary = `사전 설정 · ${mapStatusText}`;
  const staffSummary = `지금 할 일 · 배정 ${assignments.length}명`;

  // Output choices mirror the server contract exactly; impossible choices are
  // not offered (unpublished notices, unrevealed quizzes, unmocked draws).
  const displayChoices = (() => {
    const options: Array<{ value: string; label: string }> = [
      { value: "idle|", label: "유휴 화면 (안내 없음)" },
    ];
    for (const notice of displayOptions.notices) {
      if (notice.published) options.push({ value: `notice|${notice.id}`, label: `공지 · ${notice.title}` });
    }
    for (const module of displayOptions.modules) {
      if (!module.published) continue;
      if (module.type === "poll") options.push({ value: `poll|${module.id}`, label: `투표 · ${module.title}` });
      if (module.type === "quiz" && module.revealed) options.push({ value: `quiz|${module.id}`, label: `퀴즈 정답 · ${module.title}` });
      if (module.type === "draw" && module.hasPublishedDraw) options.push({ value: `draw|${module.id}`, label: `추첨 결과 · ${module.title}` });
      if (module.type === "qa" && displayOptions.approvedQuestions > 0) options.push({ value: `qa|${module.id}`, label: `Q&A · ${module.title}` });
    }
    if (displayOptions.approvedPhotos > 0) options.push({ value: "photo|", label: `사진 · 승인 ${displayOptions.approvedPhotos}장` });
    return options;
  })();
  const currentDisplayValue = `${display.type}|${display.type === "notice" ? display.noticeId : display.moduleId}`;
  const mapPoints = mapDraftPoints ?? boothMap.draft?.points ?? [];
  const pointFor = (boothId: string) => mapPoints.find((point) => point.boothId === boothId) ?? null;

  async function applyDisplayChoice() {
    const [type, target] = displayChoice.split("|");
    if (!type) return;
    const payload: Record<string, unknown> = { type };
    if (type === "notice") payload.noticeId = target;
    else if (type !== "idle" && type !== "photo") payload.moduleId = target;
    const ok = await runCommand(
      "display.set",
      payload,
      type === "idle" ? "전광판을 유휴 화면으로 바꿨습니다." : "전광판 출력을 바꿨습니다."
    );
    if (ok) setDisplayChoice("");
  }

  // Booth-map draft edits stay local until 저장; mapDraftPoints holds the
  // working set, and each placement is normalized to 0..1 so the published
  // map scales to any board size.
  async function uploadMapImage(file: File) {
    if (writeBlocked) return;
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
    <ConsolePage
      pageId="operations"
      eventId={eventId}
      eventName={state.eventName || undefined}
      meta={state.eventMeta}
      sectionNav={(
        <div className={styles.navSticky}>
          <ConsoleSectionNav
            label="현장 운영 구역"
            items={[
              { id: "ops-desks", label: "데스크" },
              { id: "ops-booths", label: "부스" },
              ...(state.stampEnabled
                ? [
                    { id: "ops-booth-mode", label: "부스 인증 방식" },
                    { id: "ops-booth-map", label: "부스 지도" },
                  ]
                : []),
              ...(state.screenEnabled ? [{ id: "ops-display", label: "전광판 출력" }] : []),
              { id: "ops-staff", label: "스태프 배정" },
            ]}
          />
          <p className={styles.navNow}>
            현재 위치: {SECTION_LABELS[activeSection] || "데스크"}
          </p>
        </div>
      )}
      feedback={(
        <>
          {state.stage === "ARCHIVED" ? (
            <ConsoleFeedback kind="warning">
              보관된 행사는 읽기 전용입니다. 운영 현황은 볼 수 있지만 추가·변경·게시할 수 없습니다.
            </ConsoleFeedback>
          ) : !state.canManage ? (
            <ConsoleFeedback kind="warning">
              현장 운영을 변경할 운영 권한이 없습니다. 현황 조회는 그대로 볼 수 있습니다.
            </ConsoleFeedback>
          ) : null}
          {failure && !(deskOpen || boothOpen || assignOpen) ? (
            <ConsoleFeedback kind="error">{failure.message}</ConsoleFeedback>
          ) : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
        </>
      )}
    >

      <ConsoleSection
        headingId="ops-desks"
        title="데스크"
        description={deskSummary}
        className={styles.anchorSection}
        action={(
          <button
            type="button"
            className="button button-secondary"
            disabled={writeBlocked}
            title={writeBlocked ? writeBlockedReason : undefined}
            onClick={() => { setEditingDesk(null); setDeskOpen(true); setFailure(null); }}
          >
            데스크 추가
          </button>
        )}
      >
        {desks.length ? (
          <ul className={uiStyles.collection}>
            {desks.map((desk) => {
              const deskStaffNames = assignments
                .filter((assignment) => assignment.type === "DESK" && assignment.targetId === desk.id)
                .map((assignment) => accountName.get(assignment.accountId) ?? "알 수 없는 계정");
              return (
              <li key={desk.id} className={uiStyles.recordRow}>
                <div className={uiStyles.recordMain}>
                  <div className={styles.resourceHead}>
                    <strong>{desk.name}</strong>
                    <span className={styles.resourceStatus} data-tone={desk.open ? "good" : "muted"}>
                      {desk.open ? "가동 중" : "중지됨"}
                    </span>
                  </div>
                  <p className={uiStyles.recordMeta}>
                    {DESK_ACTION_LABEL[desk.action] ?? "작업 미정"}
                    {" · "}
                    {desk.mode === "tablet" ? "태블릿" : "데스크"}
                  </p>
                  <p className={uiStyles.recordMeta}>
                    {deskStaffNames.length ? `배정: ${deskStaffNames.join(", ")}` : "배정된 스태프 없음"}
                  </p>
                </div>
                <div className={uiStyles.recordActions}>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || writeBlocked}
                    title={writeBlocked ? writeBlockedReason : undefined}
                    onClick={() => { setEditingDesk(desk); setDeskOpen(true); setFailure(null); }}
                  >
                    편집
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || writeBlocked}
                    title={writeBlocked ? writeBlockedReason : undefined}
                    onClick={() => void runCommand(
                      "desk.set-open",
                      { id: desk.id, open: !desk.open },
                      `${desk.name} 데스크를 ${desk.open ? "중지" : "가동"}했습니다.`
                    )}
                  >
                    {desk.open ? "가동 중지" : "가동 시작"}
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || writeBlocked}
                    title={writeBlocked ? writeBlockedReason : undefined}
                    aria-label={`${desk.name}에 스태프 배정`}
                    onClick={() => { setAssignPreset({ type: "DESK", targetId: desk.id }); setAssignOpen(true); setFailure(null); }}
                  >
                    스태프 배정
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state">등록된 데스크가 없습니다. 진행 중 전환에는 데스크와 스태프 배정이 필요합니다.</p>
        )}
      </ConsoleSection>

      <ConsoleSection
        headingId="ops-booths"
        title="부스"
        description={boothSummary}
        className={styles.anchorSection}
        action={stampEnabled ? (
          <button
            type="button"
            className="button button-secondary"
            disabled={writeBlocked}
            title={writeBlocked ? writeBlockedReason : undefined}
            onClick={() => { setEditingBooth(null); setBoothOpen(true); setFailure(null); }}
          >
            부스 추가
          </button>
        ) : (
          <Link
            className="button button-secondary"
            href={`/console/events/${encodeURIComponent(eventId)}/settings#settings-features`}
          >
            부스 인증 기능 켜기
          </Link>
        )}
      >
        {!stampEnabled ? (
          <p className="notice" role="status">
            이 행사에서 부스 인증 기능을 먼저 켜야 부스를 사용할 수 있습니다. 행사 설정의 기능에서 켜면
            여기서 부스를 만들고 현장에 열 수 있습니다.
          </p>
        ) : booths.length ? (
          <ul className={uiStyles.collection}>
            {booths.map((booth) => {
              const boothStaffNames = assignments
                .filter((assignment) => assignment.type === "BOOTH" && assignment.targetId === booth.id)
                .map((assignment) => accountName.get(assignment.accountId) ?? "알 수 없는 계정");
              return (
              <li key={booth.id} className={uiStyles.recordRow}>
                <div className={uiStyles.recordMain}>
                  <div className={styles.resourceHead}>
                    <strong>{booth.name}</strong>
                    <span
                      className={styles.resourceStatus}
                      data-tone={booth.status === "OPEN" ? "good" : booth.status === "WAITING" ? "wait" : "muted"}
                    >
                      {BOOTH_STATUS_LABEL[booth.status] ?? "상태 미정"}
                    </span>
                  </div>
                  <p className={uiStyles.recordMeta}>
                    {booth.zone || "구역 미지정"}
                    {" · "}
                    {booth.capacity
                      ? `인증 ${booth.used}회 · 잔여 ${Math.max(0, booth.capacity - booth.used)} / ${booth.capacity}`
                      : `인증 ${booth.used}회 · 잔여 제한 없음`}
                    {" · "}
                    참가자 {booth.limit}회
                  </p>
                  <p className={uiStyles.recordMeta}>
                    {boothStaffNames.length ? `배정: ${boothStaffNames.join(", ")}` : "배정된 스태프 없음"}
                  </p>
                </div>
                <div className={uiStyles.recordActions}>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || writeBlocked}
                    title={writeBlocked ? writeBlockedReason : undefined}
                    onClick={() => { setEditingBooth(booth); setBoothOpen(true); setFailure(null); }}
                  >
                    편집
                  </button>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || writeBlocked}
                    title={writeBlocked ? writeBlockedReason : undefined}
                    aria-label={`${booth.name}에 스태프 배정`}
                    onClick={() => { setAssignPreset({ type: "BOOTH", targetId: booth.id }); setAssignOpen(true); setFailure(null); }}
                  >
                    스태프 배정
                  </button>
                </div>
              </li>
              );
            })}
          </ul>
        ) : (
          <p className="empty-state">등록된 부스가 없습니다.</p>
        )}
      </ConsoleSection>

      {stampEnabled ? (
        <ConsoleSection headingId="ops-booth-mode" title="부스 인증 방식" description={modeSummary} className={styles.anchorSection}>
          {/* Before-the-day preset: folds on phones with the current value
              in the folded summary; the draws setup-details same grammar. */}
          <details className={styles.presetFold} open={presetOpen.mode} onToggle={(event) => setPresetOpen((prev) => ({ ...prev, mode: (event.target as HTMLDetailsElement).open }))}>
            <summary className={styles.presetSummary}>인증 방식 · {modeValueLabel}</summary>
            <div className={styles.presetBody}>
          <p className={styles.hint}>
            {stampMode === "SELF"
              ? "참가자가 부스 QR을 직접 스캔합니다. 부스마다 QR을 붙여 주세요."
              : "스태프가 참가자 티켓을 확인해 처리합니다. 부스 배정이 필요합니다."}
            {visitsCount ? ` · 이미 인증 ${visitsCount}건이라 방식을 바꿀 수 없습니다.` : ""}
          </p>
          <div className={styles.buttonRow}>
            <button
              type="button"
              className={`button ${stampMode === "STAFF" ? "button-primary" : "button-secondary"}`}
              disabled={busy || visitsCount > 0 || stampMode === "STAFF" || writeBlocked}
              title={writeBlocked ? writeBlockedReason : undefined}
              aria-pressed={stampMode === "STAFF"}
              onClick={() => requestStampMode("STAFF")}
            >
              스태프 확인
            </button>
            <button
              type="button"
              className={`button ${stampMode === "SELF" ? "button-primary" : "button-secondary"}`}
              disabled={busy || visitsCount > 0 || stampMode === "SELF" || writeBlocked}
              title={writeBlocked ? writeBlockedReason : undefined}
              aria-pressed={stampMode === "SELF"}
              onClick={() => requestStampMode("SELF")}
            >
              참가자 셀프 스캔
            </button>
          </div>
          {stampModePending ? (
            <ConsoleConfirm
              summary={(
                <>
                  인증 방식을 &lsquo;{stampModePending === "SELF" ? "참가자가 부스 QR을 직접 스캔" : "스태프가 참가자 티켓을 확인"}&rsquo;(으)로 바꿀까요?
                  <br />
                  인증 기록이 있으면 바꿀 수 없습니다.
                </>
              )}
              confirmLabel="인증 방식 바꾸기"
              busy={busy}
              onConfirm={() => void confirmStampMode()}
              onCancel={() => setStampModePending(null)}
            />
          ) : null}
            </div>
          </details>
        </ConsoleSection>
      ) : null}

      {stampEnabled ? (
        <ConsoleSection headingId="ops-booth-map" title="부스 지도" description={mapSummary} className={styles.anchorSection}>
          {/* Before-the-day preset: folds on phones with the publish state
              in the folded summary so an unposted draft is never missed. */}
          <details className={styles.presetFold} open={presetOpen.map} onToggle={(event) => setPresetOpen((prev) => ({ ...prev, map: (event.target as HTMLDetailsElement).open }))}>
            <summary className={styles.presetSummary}>부스 지도 · {mapStatusText}</summary>
            <div className={styles.presetBody}>
          <p className={styles.hint}>
            배치도를 올리고, 부스를 골라 이미지를 눌러 위치를 찍습니다. 게시해야 참가자 화면에 보입니다.
          </p>
          <div className={styles.buttonRow}>
            <label className="button button-secondary" title={writeBlocked ? writeBlockedReason : undefined}>
              {mapUploading ? "올리는 중…" : boothMap.draft ? "배치도 교체" : "배치도 올리기"}
              <input
                type="file"
                className="sr-only"
                accept="image/png,image/jpeg,image/webp"
                disabled={mapUploading || busy || writeBlocked}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void uploadMapImage(file);
                  event.target.value = "";
                }}
              />
            </label>
            {mapImageOverride || boothMap.draft ? (
              <>
                <button type="button" className="button button-primary" disabled={busy || mapUploading || writeBlocked} title={writeBlocked ? writeBlockedReason : undefined} onClick={() => void saveBoothMapDraft()}>
                  초안 저장
                </button>
                <button type="button" className="button button-secondary" disabled={busy || !boothMap.draft || writeBlocked} title={writeBlocked ? writeBlockedReason : !boothMap.draft ? "초안을 먼저 저장하세요" : undefined} onClick={() => void publishBoothMap()}>
                  게시
                </button>
              </>
            ) : null}
            {boothMap.published ? (
              <button type="button" className="button button-secondary" disabled={busy || writeBlocked} title={writeBlocked ? writeBlockedReason : undefined} onClick={() => requestUnpublishBoothMap()}>
                게시 내리기
              </button>
            ) : null}
          </div>
          {mapUnpublishPending ? (
            <ConsoleConfirm
              summary={(
                <>
                  게시된 부스 지도를 내릴까요?
                  <br />
                  참가자 화면에서 사라집니다.
                </>
              )}
              confirmLabel="게시 내리기"
              busy={busy}
              onConfirm={() => void confirmUnpublishBoothMap()}
              onCancel={() => setMapUnpublishPending(false)}
            />
          ) : null}
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
                    if (!mapPlacing || writeBlocked) return;
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
            <ul className={uiStyles.collection}>
              {booths.map((booth) => {
                const point = pointFor(booth.id);
                return (
                  <li key={booth.id} className={uiStyles.recordRow}>
                    <div className={uiStyles.recordMain}>
                      <strong>{booth.name}</strong>
                      <p className={uiStyles.recordMeta}>{point ? "위치 지정됨" : "위치 미지정"}</p>
                    </div>
                    <div className={uiStyles.recordActions}>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy || writeBlocked}
                        title={writeBlocked ? writeBlockedReason : undefined}
                        onClick={() => setMapPlacing(mapPlacing === booth.id ? "" : booth.id)}
                      >
                        {mapPlacing === booth.id ? "지정 취소" : point ? "다시 지정" : "위치 지정"}
                      </button>
                    </div>
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
            <p className={styles.hint}>
              게시본 v{boothMap.published.version} · {boothMap.published.points.length}개 위치
              {boothMap.published.publishedAt ? ` · ${boothMap.published.publishedAt.slice(0, 10)}` : ""}
            </p>
          ) : null}
          {boothMap.draft && !mapMatchesPublished(boothMap) ? (
            <p className="notice" role="status">
              초안이 아직 게시되지 않았습니다.{" "}
              {boothMap.published ? "참가자에게는 이전 게시본이 보입니다." : "참가자에게는 아직 배치도가 보이지 않습니다."}
            </p>
          ) : null}
            </div>
          </details>
        </ConsoleSection>
      ) : null}

      {screenEnabled ? (
        <ConsoleSection headingId="ops-display" title="전광판 출력" description="지금 할 일" className={styles.anchorSection}>
          <p className={styles.hint}>
            행사장 화면에 지금 내보낼 내용입니다. 현재:{" "}
            {currentDisplayValue.startsWith("idle")
              ? "유휴 화면"
              : displayChoices.find((choice) => choice.value === currentDisplayValue)?.label ?? "출력 확인 필요"}
          </p>
          <div className={styles.buttonRow}>
            <label className="sr-only" htmlFor="ops-display-pick">전광판 출력 선택</label>
            <select
              id="ops-display-pick"
              value={displayChoice}
              onChange={(event) => setDisplayChoice(event.target.value)}
            >
              <option value="">출력 고르기</option>
              {displayChoices.map((choice) => (
                <option key={choice.value} value={choice.value}>{choice.label}</option>
              ))}
            </select>
            <button
              type="button"
              className="button button-primary"
              disabled={busy || !displayChoice || displayChoice === currentDisplayValue || writeBlocked}
              title={
                writeBlocked
                  ? writeBlockedReason
                  : !displayChoice
                    ? "출력을 먼저 고르세요"
                    : displayChoice === currentDisplayValue
                      ? "이미 적용된 출력입니다"
                      : undefined
              }
              onClick={() => void applyDisplayChoice()}
            >
              {displayChoice && displayChoice !== currentDisplayValue ? (displayChoice.startsWith("idle") ? "유휴로 내리기" : "출력 적용") : "출력 적용"}
            </button>
          </div>
          <p className={styles.hint}>
            게시한 공지·공개된 프로그램만 고를 수 있습니다. 참가자 화면과 같은 내용이 행사장 화면에 나옵니다.
          </p>
          {displayChoice && displayChoice !== currentDisplayValue ? (
            <p className="notice" role="status">선택한 출력은 아직 적용되지 않았습니다. ‘출력 적용’을 눌러야 행사장 화면에 나옵니다.</p>
          ) : null}
        </ConsoleSection>
      ) : null}

      <ConsoleSection headingId="ops-staff" title="스태프 배정" description={staffSummary} className={styles.anchorSection}>
        <div className={styles.primarySectionAction}>
          <button
            type="button"
            className="button button-primary"
            onClick={() => { setAssignPreset(null); setAssignOpen(true); setFailure(null); }}
            disabled={assignableTargets === 0 || writeBlocked}
            title={writeBlocked ? writeBlockedReason : assignableTargets === 0 ? "데스크나 부스를 먼저 만드세요" : undefined}
          >
            스태프 배정
          </button>
        </div>
        {assignments.length ? (
          <ul className={uiStyles.collection}>
            {assignments.map((assignment) => (
              <li key={assignment.id} className={uiStyles.recordRow}>
                <div className={uiStyles.recordMain}>
                  <strong>{accountName.get(assignment.accountId) ?? "알 수 없는 계정"}</strong>
                  <p className={uiStyles.recordMeta}>
                    {assignment.type === "DESK" ? "데스크" : "부스"}
                    {" · "}
                    {(assignment.type === "DESK"
                      ? deskName.get(assignment.targetId)
                      : boothName.get(assignment.targetId)) ?? "알 수 없는 담당"}
                  </p>
                </div>
                <div className={uiStyles.recordActions}>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={busy || writeBlocked}
                    title={writeBlocked ? writeBlockedReason : undefined}
                    onClick={() => void runCommand(
                      "staff.unassign",
                      { id: assignment.id },
                      "배정을 해제했습니다."
                    )}
                  >
                    해제
                  </button>
                </div>
              </li>
            ))}
          </ul>
        ) : assignableTargets === 0 ? (
          <p className="notice" role="status">배정하려면 먼저 데스크나 부스를 만드세요.</p>
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
      </ConsoleSection>

      {deskOpen ? (
        <DeskDialog
          busy={busy}
          failure={failure}
          initial={editingDesk}
          onClose={() => { setDeskDirty(false); setDeskOpen(false); setEditingDesk(null); }}
          onDirtyChange={setDeskDirty}
          onSubmit={async (payload) => {
            const ok = await runCommand("desk.save", payload, "데스크를 저장했습니다.");
            if (ok) { setDeskDirty(false); setDeskOpen(false); setEditingDesk(null); }
          }}
        />
      ) : null}
      {boothOpen ? (
        <BoothDialog
          busy={busy}
          failure={failure}
          initial={editingBooth}
          onClose={() => { setBoothDirty(false); setBoothOpen(false); setEditingBooth(null); }}
          onDirtyChange={setBoothDirty}
          onSubmit={async (payload) => {
            const ok = await runCommand("booth.save", payload, "부스를 저장했습니다.");
            if (ok) { setBoothDirty(false); setBoothOpen(false); setEditingBooth(null); }
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
          initialType={assignPreset?.type ?? (desks.length ? "DESK" : "BOOTH")}
          initialTargetId={assignPreset?.targetId ?? ""}
          onClose={() => { setAssignDirty(false); setAssignOpen(false); }}
          onDirtyChange={setAssignDirty}
          onSubmit={async (payload) => {
            const ok = await runCommand("staff.assign", payload, "스태프를 배정했습니다.");
            if (ok) { setAssignDirty(false); setAssignOpen(false); setAssignPreset(null); }
          }}
        />
      ) : null}
    </ConsolePage>
  );
}

function DialogError({ failure, id }: { failure: Failure | null; id: string }) {
  if (!failure) return null;
  return <p role="alert" id={id}>{failure.message}</p>;
}

function DeskDialog({
  busy,
  failure,
  initial,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  busy: boolean;
  failure: Failure | null;
  initial?: Desk | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [action, setAction] = useState(initial?.action === "OUT" ? "OUT" : "IN");
  const [mode, setMode] = useState(initial?.mode === "tablet" ? "tablet" : "desk");
  const [confirmDirection, setConfirmDirection] = useState(false);
  const directionChanged = Boolean(initial) && initial?.action !== action;
  const dirty =
    name !== (initial?.name ?? "") ||
    action !== (initial?.action ?? "IN") ||
    mode !== (initial?.mode ?? "desk") ||
    confirmDirection;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Dismissal gate for Escape/backdrop/Cancel: dirty input asks once instead
  // of silently discarding. In-flight submits stay locked by `busy`.
  const canClose = () => {
    if (!dirty) return true;
    return window.confirm("작성 중인 내용이 사라집니다. 닫을까요?");
  };
  return (
    <ConsoleDialog title={initial ? "데스크 편집" : "데스크 추가"} onClose={onClose} busy={busy} canClose={canClose}>
      <form
        className={uiStyles.formStack}
        onSubmit={(event) => {
          event.preventDefault();
          // The server derives open from the payload; an edit that omits it
          // would silently reopen a stopped desk, so the current state rides
          // along. A direction change forces the desk closed server-side.
          const payload: Record<string, unknown> = initial
            ? { id: initial.id, name, action, mode, open: initial.open }
            : { name, action, mode, open: true };
          if (directionChanged && confirmDirection) payload.confirmDirectionChange = true;
          onSubmit(payload);
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
        {directionChanged ? (
          <div className={uiStyles.checkRow}>
            <input
              id="desk-direction-confirm"
              type="checkbox"
              checked={confirmDirection}
              onChange={(event) => setConfirmDirection(event.target.checked)}
            />
            <label htmlFor="desk-direction-confirm">
              입장·퇴장 방향을 바꾸면 기존 기록과 섞일 수 있습니다. 확인했습니다.
            </label>
          </div>
        ) : null}
        <DialogError failure={failure} id="desk-dialog-error" />
        <ConsoleFormActions>
          <button type="button" className="button button-secondary" onClick={() => { if (canClose()) onClose(); }} disabled={busy}>
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={busy || !name.trim() || (directionChanged && !confirmDirection)}>
            {busy ? "저장 중입니다" : "데스크 저장"}
          </button>
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}

function BoothDialog({
  busy,
  failure,
  initial,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  busy: boolean;
  failure: Failure | null;
  initial?: Booth | null;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [zone, setZone] = useState(initial?.zone ?? "");
  const [status, setStatus] = useState(initial?.status ?? "WAITING");
  const [capacity, setCapacity] = useState(String(initial?.capacity ?? 0));
  const [limit, setLimit] = useState(String(initial?.limit ?? 1));
  const dirty =
    name !== (initial?.name ?? "") ||
    zone !== (initial?.zone ?? "") ||
    status !== (initial?.status ?? "WAITING") ||
    capacity !== String(initial?.capacity ?? 0) ||
    limit !== String(initial?.limit ?? 1);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const canClose = () => {
    if (!dirty) return true;
    return window.confirm("작성 중인 내용이 사라집니다. 닫을까요?");
  };
  return (
    <ConsoleDialog title={initial ? "부스 편집" : "부스 추가"} onClose={onClose} busy={busy} canClose={canClose}>
      <form
        className={uiStyles.formStack}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({
            ...(initial ? { id: initial.id } : null),
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
        <div className={uiStyles.formGrid}>
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
        <ConsoleFormActions>
          <button type="button" className="button button-secondary" onClick={() => { if (canClose()) onClose(); }} disabled={busy}>
            취소
          </button>
          <button type="submit" className="button button-primary" disabled={busy || !name.trim()}>
            {busy ? "저장 중입니다" : "부스 저장"}
          </button>
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}

function AssignDialog({
  busy,
  failure,
  staffAccounts,
  desks,
  booths,
  initialType,
  initialTargetId,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  busy: boolean;
  failure: Failure | null;
  staffAccounts: Account[];
  desks: Desk[];
  booths: Booth[];
  initialType: string;
  initialTargetId?: string;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [accountId, setAccountId] = useState("");
  const [type, setType] = useState(initialType);
  // Row-level opens preselect their target; the dialog never submits on its
  // own, so the operator still picks staff and confirms. The pristine preset
  // (no staff chosen yet) is not dirty, keeping the canClose gate truthful.
  const [targetId, setTargetId] = useState(initialTargetId ?? "");
  const dirty = accountId !== "" || type !== initialType || targetId !== (initialTargetId ?? "");
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const canClose = () => {
    if (!dirty) return true;
    return window.confirm("작성 중인 내용이 사라집니다. 닫을까요?");
  };
  const targets = type === "DESK" ? desks : booths;
  const currentTarget = targets.some((target) => target.id === targetId) ? targetId : "";
  // A preset target can go stale while the dialog is open (deleted desk or
  // booth, or booths hidden after the feature switch): the save button would
  // only sit disabled with no reason, so the mismatch reads out loud.
  const targetStale = targetId !== "" && currentTarget === "";
  return (
    <ConsoleDialog title="스태프 배정" onClose={onClose} busy={busy} canClose={canClose}>
      <form
        className={uiStyles.formStack}
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
            <p className="notice" role="status">
              배정할 수 있는 활성 현장 스태프 계정이 없습니다.{" "}
              <Link href="/console/team">팀·권한에서 현장 스태프 초대</Link>하면
              수락한 계정을 여기서 데스크·부스로 지정할 수 있습니다.
              초대 수락 후 다시 여세요. 닫기 전 고른 데스크·부스 대상은 유지됩니다.
            </p>
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
          {targetStale ? (
            <p className="notice" role="alert">
              선택한 담당 대상을 찾을 수 없습니다. 삭제되었거나 부스 인증 방식이 바뀌어 목록에서 빠졌습니다.
              담당 대상을 다시 선택하세요.
            </p>
          ) : null}
        </div>
        <DialogError failure={failure} id="assign-dialog-error" />
        <ConsoleFormActions>
          <button type="button" className="button button-secondary" onClick={() => { if (canClose()) onClose(); }} disabled={busy}>
            취소
          </button>
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || !accountId || !currentTarget}
          >
            {busy ? "배정 중입니다" : "배정 저장"}
          </button>
        </ConsoleFormActions>
      </form>
    </ConsoleDialog>
  );
}
