"use client";

import ProductButton from "../../../../ui/ProductButton";

import ConsoleChoiceGroup from "../../../console-ui/ConsoleChoiceGroup";
import ValidatedForm from "../../../../ui/ValidatedForm";


import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import ProductLink from "../../../../ui/ProductLink";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { readAssignAccountParam } from "../../../console-handoff";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import { formatConsoleEventMeta } from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import DeviceFrame from "../../../console-ui/DeviceFrame";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./operations.module.css";
import { LocationRow, RunSwitch, StaffFaces, StatusDot, type Staffer } from "./LocationParts";
import { CheckIcon, CopyIcon, PlusIcon } from "../../../console-ui/ConsoleIcons";
import { CrewIcon } from "./OpsIcons";
import { consoleFetch } from "../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsOperationsCommand, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import { boothScheduleTime } from "../../../../../lib/booth-availability";

type Desk = { id: string; name: string | null; action: string | null; mode: string; open: boolean };
type DeskConflict = { kind: "edit" | "toggle"; id: string; latest: Desk | null; loading: boolean; error: string | null; incomplete?: boolean };
type Booth = {
  id: string;
  name: string;
  zone: string;
  status: string;
  capacity: number;
  limit: number;
  used: number;
  startsAt: string;
  endsAt: string;
};
type BoothConflict = { id: string; latest: Booth | null; loading: boolean; error: string | null };
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
      eventSlug: string;
      stage: string;
      role: string;
      userId: string;
      memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
      eventMeta?: string;
      eventId: string;
      stampEnabled: boolean;
      stampMode: "STAFF" | "SELF" | null;
      visitsCount: number | null;
      boothMap: BoothMapState;
      desks: Desk[];
      booths: Booth[];
      assignments: Assignment[];
      accounts: Account[];
    };

type Failure = { message: string; field?: string };
type OperationAttempt = { eventId: string; command: string; payload: Record<string, unknown>; successMessage: string; fingerprint: string; commandId: string };
const OPERATION_COMMANDS = new Set(["desk.save", "desk.set-open", "booth.save", "booth.mode", "booth.map.save", "booth.map.publish", "booth.map.unpublish", "staff.assign", "staff.unassign"]);

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
const BOOTH_TIME_FORMAT = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});
const BOOTH_TIME_FORMAT_SECONDS = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});
const BOOTH_TIME_FORMAT_MILLISECONDS = new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3, hourCycle: "h23",
});
function boothTimeLabel(value: string): string {
  if (!value) return "미지정";
  if (/^__invalid_booth_(?:time|text)__:/.test(value)) return "시간 형식 확인 필요";
  // A timezone-less legacy value is interpreted differently by each device.
  // Show the stored value instead of presenting an inferred time as Korean.
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    return Number.isFinite(boothScheduleTime(`${value}+09:00`))
      ? `시간대 확인 필요 (${value})` : `시간 형식 확인 필요 (${value})`;
  }
  const parsed = boothScheduleTime(value);
  if (parsed === null || !Number.isFinite(parsed)) return `시간 형식 확인 필요 (${value})`;
  const formatter = parsed % 1000 !== 0 ? BOOTH_TIME_FORMAT_MILLISECONDS : parsed % 60000 !== 0 ? BOOTH_TIME_FORMAT_SECONDS : BOOTH_TIME_FORMAT;
  return `${formatter.format(parsed)} (한국 시간)`;
}

type BoothTimeEdit = { action: "keep" | "set" | "clear"; value: string };
// Only an explicitly zoned timestamp has a known instant. Unzoned or broken
// legacy values are shown as stored and are never guessed into the editor.
function boothTimeInput(value: string): string {
  const parsed = boothScheduleTime(value);
  if (parsed === null || !Number.isFinite(parsed)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(parsed));
  const part = (name: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === name)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

function boothTimeFromInput(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const [, y, m, d, h, min] = match;
  const year = Number(y), month = Number(m), day = Number(d), hour = Number(h), minute = Number(min);
  const check = new Date(0);
  check.setUTCFullYear(year, month - 1, day);
  check.setUTCHours(hour, minute, 0, 0);
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day ||
      check.getUTCHours() !== hour || check.getUTCMinutes() !== minute) return null;
  return `${value}:00+09:00`;
}

function boothTimeInputDescription(value: string): string {
  if (!boothTimeFromInput(value)) return "";
  const [date, time] = value.split("T");
  const [year, month, day] = date.split("-");
  return `${Number(year)}년 ${Number(month)}월 ${Number(day)}일 ${time} (한국 시간)`;
}

function boothTimeNeedsReview(value: string): boolean {
  return Boolean(value) && !Number.isFinite(boothScheduleTime(value));
}

function boothScheduleNeedsReview(start: string, end: string): boolean {
  const startValue = boothScheduleTime(start), endValue = boothScheduleTime(end);
  return boothTimeNeedsReview(start) || boothTimeNeedsReview(end) ||
    (startValue !== null && endValue !== null && Number.isFinite(startValue) && Number.isFinite(endValue) && startValue >= endValue);
}

// Keys that scroll the document when the focus is not inside an editable
// field. Releasing the explicit-jump pin on exactly these (plus wheel and
// touch) hands control back to the scroll spy on genuine user scrolling,
// while programmatic jumps — which fire none of them — keep the chosen
// section without any timeout.

function StepPill({ n, tone, children }: { n: number; tone: "ok" | "warn" | "todo" | "wait" | "day"; children: ReactNode }) {
  return <span className={styles.stepPill} data-tone={tone}><b aria-hidden="true">{n}</b>{children}</span>;
}

export default function OperationsWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<State>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [staffLinkCopied, setStaffLinkCopied] = useState(false);
  const [deskOpen, setDeskOpen] = useState(false);
  const [editingDesk, setEditingDesk] = useState<Desk | null>(null);
  const [deskConflict, setDeskConflict] = useState<DeskConflict | null>(null);
  const deskConflictRef = useRef<DeskConflict | null>(null);
  const deskReadRef = useRef<AbortController | null>(null);
  useEffect(() => () => { deskReadRef.current?.abort(); deskReadRef.current = null; }, []);
  const [boothOpen, setBoothOpen] = useState(false);
  const [editingBooth, setEditingBooth] = useState<Booth | null>(null);
  const [boothConflict, setBoothConflict] = useState<BoothConflict | null>(null);
  const boothConflictRef = useRef<BoothConflict | null>(null);
  const boothReadRef = useRef<AbortController | null>(null);
  useEffect(() => () => { boothReadRef.current?.abort(); boothReadRef.current = null; }, []);
  const [assignOpen, setAssignOpen] = useState(false);
  // Row-level assignment preset (UI only): a desk/booth row opens the same
  // AssignDialog with its type+target already chosen, so the operator only
  // picks staff and submits. The team screen instead hands off a person
  // (accountId) with no target, so the operator only picks where and
  // submits. Null means the generic #ops-staff dialog with
  // its existing defaults. The dialog unmounts on close, so each open starts
  // from its own preset and never inherits a stale target.
  const [assignPreset, setAssignPreset] = useState<{ type?: string; targetId?: string; accountId?: string } | null>(null);
  const [detail, setDetail] = useState<{ type: "DESK" | "BOOTH"; id: string } | null>(null);
  const [deskStopPending, setDeskStopPending] = useState<Desk | null>(null);
  // Team handoff notice (UI only): names why a requested ?assignAccount=
  // did not open the dialog. Reads, never writes.
  const [assignHandoffNotice, setAssignHandoffNotice] = useState<string | null>(null);
  // The handoff applies once per event, after the workspace loads.
  const assignHandoffAppliedRef = useRef<string | null>(null);
  const [mapUploading, setMapUploading] = useState(false);
  const [mapUploadUncertain, setMapUploadUncertain] = useState(false);
  const [mapUploadError, setMapUploadError] = useState<string | null>(null);
  const [mapUploadAbandonConfirm, setMapUploadAbandonConfirm] = useState(false);
  const [mapWarning, setMapWarning] = useState<string | null>(null);
  const mapUploadRef = useRef<{ eventId: string; file: File; commandId: string; uncertain: boolean } | null>(null);
  const mapUploadGateRef = useRef(false);
  const [mapPlacing, setMapPlacing] = useState<string>("");
  const [mapDraftPoints, setMapDraftPoints] = useState<BoothMapPoint[] | null>(null);
  const [mapImageOverride, setMapImageOverride] = useState<BoothMapDraft["image"] | null>(null);
  const [stampModePending, setStampModePending] = useState<{ mode: "SELF" | "STAFF"; expectedMode: "SELF" | "STAFF" } | null>(null);
  const [mapUnpublishPending, setMapUnpublishPending] = useState(false);
  const [deskDirty, setDeskDirty] = useState(false);
  const [boothDirty, setBoothDirty] = useState(false);
  const [assignDirty, setAssignDirty] = useState(false);
  // Before-the-day presets (auth mode, booth map) start folded on every
  // viewport so the same-day work (desks, output, assignments) reads first.
  // The operator opens a preset by hand or by jumping straight to its anchor;
  // a viewport change never overwrites that choice, and unsaved work keeps
  // its preset open.
  const [presetOpen, setPresetOpen] = useState({ mode: false, map: false });

  // An unconfirmed write keeps its exact payload and id. New writes stay
  // blocked until status is checked, the same request is retried, or the
  // operator explicitly stops checking it.
  const commandIdCache = useRef(new Map<string, string>());
  const [pendingOperation, setPendingOperation] = useState<OperationAttempt | null>(null);
  const pendingOperationRef = useRef<OperationAttempt | null>(null);
  const [checkingOperation, setCheckingOperation] = useState(false);
  const [operationRecoveryError, setOperationRecoveryError] = useState<string | null>(null);
  const [abandonOperationConfirm, setAbandonOperationConfirm] = useState(false);
  const eventReceipts = useEventReceipts(eventId);
  const otherOperationReceipt = eventReceipts.some((entry) => OPERATION_COMMANDS.has(entry.command) && entry.commandId !== pendingOperation?.commandId && ![...commandIdCache.current.values()].includes(entry.commandId));
  const activeOperationsEventRef = useRef(eventId);
  activeOperationsEventRef.current = eventId;
  useEffect(() => pendingOperation && state.kind === "ready" ? manageOperatorReceipt(pendingOperation.commandId) : undefined, [pendingOperation, state.kind]);
  const previousOperationsEventRef = useRef(eventId);
  useEffect(() => {
    if (previousOperationsEventRef.current === eventId) return;
    previousOperationsEventRef.current = eventId;
    pendingOperationRef.current = null;
    setPendingOperation(null);
    setOperationRecoveryError(null);
    setAbandonOperationConfirm(false);
    commandIdCache.current.clear();
    mapUploadRef.current = null;
    mapUploadGateRef.current = false;
    setMapUploading(false);
    setMapUploadUncertain(false);
    setMapUploadError(null);
    setMapUploadAbandonConfirm(false);
    setMapWarning(null);
    deskReadRef.current?.abort();
    deskReadRef.current = null;
    deskConflictRef.current = null;
    setDeskConflict(null);
    boothReadRef.current?.abort();
    boothReadRef.current = null;
    boothConflictRef.current = null;
    setBoothConflict(null);
  }, [eventId]);
  const hadOtherOperationReceiptRef = useRef(false);
  useEffect(() => {
    if (hadOtherOperationReceiptRef.current && !otherOperationReceipt && !pendingOperation) {
      setNotice("최신 현장 운영 내용을 다시 불러옵니다.");
      reload();
    }
    hadOtherOperationReceiptRef.current = otherOperationReceipt;
  }, [otherOperationReceipt, pendingOperation]);
  // Synchronous in-flight gate: `busy` flips only after rerender, so
  // same-turn double submits (including dialog saves) would overlap.
  const commandBusyRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        // The actor comes from the session (/api/auth/me), concurrent with
        // the scoped event bootstrap: this console 403s STAFF writes on the
        // server, so the write affordances below gate per command scope
        // (desks/staff onsite, booths/map booth, no display: that moved to 현장 모드) through
        // the capability helper on the raw membership grants.
        const [meRes, bootRes] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store" }),
          consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
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
              boothVisitsAvailable?: unknown;
              stampMode?: unknown;
              boothMap?: unknown;
              notices?: unknown;
              modules?: unknown;
              photos?: unknown;
              questions?: unknown;
              posts?: unknown;
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
                name: typeof desk.name === "string" ? desk.name : null,
                action: typeof desk.action === "string" ? desk.action : null,
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
                startsAt: text(booth.startsAt),
                endsAt: text(booth.endsAt),
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
        const eventMemberships: Array<{ accountId: string; eventId: string; write?: unknown }> = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const membership = item as Record<string, unknown>;
              if (typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
              return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
            })
          : [];
        const venue = workspace.venue && typeof workspace.venue === "object"
          ? workspace.venue as Record<string, unknown>
          : {};
        setState({
          kind: "ready",
          eventName: text(event.name),
          eventSlug: text(event.slug),
          stage: text(event.stage).toUpperCase(),
          role,
          userId: myId,
          memberships: eventMemberships,
          eventMeta: formatConsoleEventMeta({
            clientName: text(clientName),
            date: text(event.date),
            start: text(event.start),
            end: text(event.end),
            venue: text(venue.name),
          }),
          eventId,
          stampEnabled: features.includes("stamp"),
          stampMode: workspace.stampMode === "SELF" || workspace.stampMode === "STAFF" ? workspace.stampMode : null,
          visitsCount: workspace.boothVisitsAvailable === true && Array.isArray(workspace.visits) ? workspace.visits.length : null,
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

  // A jump straight to a preset anchor unfolds that preset: native anchors
  // land on the always-visible section heading, but the folded body would
  // stay hidden without this. The ids below are the rendered headingId
  // values (there is no ops-stamp-mode section). Dirty or in-flight presets
  // stay open regardless (see the needs-attention flags at render time),
  // so unsaved work never hides behind a folded summary.
  useEffect(() => {
    const applyHash = () => {
      const hash = window.location.hash;
      if (hash === "#ops-booth-mode") {
        setPresetOpen((prev) => (prev.mode ? prev : { ...prev, mode: true }));
      } else if (hash === "#ops-booth-map") {
        setPresetOpen((prev) => (prev.map ? prev : { ...prev, map: true }));
      }
    };
    applyHash();
    window.addEventListener("hashchange", applyHash);
    return () => window.removeEventListener("hashchange", applyHash);
  }, []);

  // Event switch resets the handoff slice (never a key remount): a stale
  // handoff notice or an already-consumed marker from the previous event
  // must not leak into this one.
  useEffect(() => {
    assignHandoffAppliedRef.current = null;
    setAssignHandoffNotice(null);
  }, [eventId]);

  // Team -> operations handoff: read ?assignAccount= once after the
  // workspace loads, validate it against the loaded directory, and open
  // the existing assignment dialog with that person preselected. The
  // dialog never submits on its own, so the operator still picks the
  // desk/booth target and confirms. The param is removed with
  // history.replaceState (no navigation); other params and the hash
  // survive. Unknown, inactive, non-staff, target-less or read-only cases
  // open nothing, write nothing, and state the reason instead.
  useEffect(() => {
    if (state.kind !== "ready") return;
    if (assignHandoffAppliedRef.current === eventId) return;
    assignHandoffAppliedRef.current = eventId;
    let requested = "";
    try {
      requested = readAssignAccountParam(window.location.search);
    } catch {
      return;
    }
    if (!requested) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("assignAccount");
      const next = `${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ""}${url.hash}`;
      window.history.replaceState(null, "", next);
    } catch {
      // The handoff still applies; only the shareable URL keeps the param.
    }
    const handoffArchived = state.stage === "ARCHIVED";
    const handoffBlocked = handoffArchived || !canWriteOnsite;
    if (handoffBlocked) {
      setAssignHandoffNotice(
        handoffArchived
          ? "보관된 행사는 읽기 전용이라 배정을 열 수 없습니다. 팀·권한으로 돌아가 다른 행사를 선택하세요."
          : "현장 운영을 변경할 운영 권한이 없어 배정을 열 수 없습니다. 담당 행사 운영자에게 요청하세요."
      );
      return;
    }
    const person = state.accounts.find((account) => account.id === requested);
    if (!person || person.role !== "STAFF" || !person.active) {
      setAssignHandoffNotice(
        "요청한 스태프를 찾을 수 없습니다. 팀·권한에서 구성원을 확인한 뒤 다시 선택하세요. 바로 배정하지 않았습니다."
      );
      return;
    }
    const handoffTargets = state.desks.length + (state.stampEnabled ? state.booths.length : 0);
    if (handoffTargets === 0) {
      setAssignHandoffNotice(
        "배정할 데스크나 부스가 없어 배정을 열 수 없습니다. 데스크나 부스를 먼저 만드세요."
      );
      return;
    }
    setAssignHandoffNotice(null);
    setFailure(null);
    setAssignPreset({ accountId: person.id });
    // The originating link lives on the team screen. Give the dialog a
    // stable local return target, just as a row-opened dialog has its button.
    document.getElementById("ops-staff-assign")?.focus({ preventScroll: true });
    setAssignOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, eventId]);

  // Draft-guard dirty state, evaluated before every early return below. Only
  // true diffs and truthful pending intent: dialog input diffs, unsaved map
  // points/image overrides, in-flight uploads,
  // and command receipts kept after ambiguous responses. Merely opening a
  // pristine dialog is not dirty — its own canClose already closes those
  // silently — so a reload with a pristine dialog warns nothing.
  useConsoleDraftGuard(
    deskDirty ||
      Boolean(deskConflict) ||
      Boolean(boothConflict) ||
      boothDirty ||
      assignDirty ||
      mapDraftPoints !== null ||
      mapImageOverride !== null ||
      mapUploading ||
      mapUploadUncertain ||
      commandBusyRef.current ||
      commandIdCache.current.size > 0,
    mapUploadUncertain
      ? "지도 파일이 이미 올라갔을 수 있습니다. 화면을 떠나면 같은 파일 요청을 다시 시도할 수 없습니다."
      : "작성 중인 현장 운영 내용이나 저장하지 않은 지도가 있습니다. 페이지를 떠나면 사라집니다."
  );

  const staffAccounts = useMemo(
    () => (state.kind === "ready"
      ? state.accounts.filter((account) => account.role === "STAFF" && account.active)
      : []),
    [state]
  );

  async function copyStaffLink() {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/staff`);
      setStaffLinkCopied(true);
      window.setTimeout(() => setStaffLinkCopied(false), 2500);
    } catch {
      setFailure({ message: "주소를 복사하지 못했습니다. 위의 주소를 직접 선택해 복사하세요." });
    }
  }

  function reload() {
    setReloadTick((tick) => tick + 1);
    window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
  }

  async function runCommand(
    command: string,
    payload: Record<string, unknown>,
    successMessage: string,
    retry?: OperationAttempt
  ) {
    if (busy || commandBusyRef.current) return false;
    const held = pendingOperationRef.current;
    if ((held && (!retry || retry.commandId !== held.commandId)) || otherOperationReceipt) {
      setFailure({ message: "이전 현장 운영 요청의 처리 결과를 먼저 확인하세요." });
      return false;
    }
    // Archived and unauthorized writes never reach the server from here;
    // the server stays authoritative either way.
    if (commandBlocked(command)) return false;
    commandBusyRef.current = true;
    setBusy(true);
    setFailure(null);
    setNotice(null);
    const frozenPayload = retry?.payload ?? JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const fingerprint = retry?.fingerprint ?? `${command}:${JSON.stringify(frozenPayload)}`;
    const commandId = retry?.commandId ?? commandIdCache.current.get(fingerprint) ?? randomCommandId();
    commandIdCache.current.set(fingerprint, commandId);
    const attempt: OperationAttempt = retry ?? { eventId, command, payload: frozenPayload, successMessage, fingerprint, commandId };
    const markUnconfirmed = () => {
      pendingOperationRef.current = attempt;
      setPendingOperation(attempt);
      setOperationRecoveryError("처리 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.");
    };
    try {
      const res = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command: attempt.command, payload: attempt.payload }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        code?: unknown;
      } | null;
      if (activeOperationsEventRef.current !== attempt.eventId) return false;
      if (!res.ok) {
        if (res.status === 409 && attempt.command === "booth.mode-reviewed" &&
            ["BOOTH_MODE_CHANGED", "BOOTH_VISITS_UNAVAILABLE", "BOOTH_VISITS_EXIST", "BOOTH_MODE_UNAVAILABLE"].includes(String(data?.code))) {
          // These guards run only after receipt replay, so the attempt was not committed.
          commandIdCache.current.delete(fingerprint);
          abandonOperatorAttempt(commandId);
          forgetOperatorReceipt(commandId);
          pendingOperationRef.current = null;
          setPendingOperation(null);
          setOperationRecoveryError(null);
          setAbandonOperationConfirm(false);
          setFailure({ message: typeof data?.error === "string" ? data.error : "부스 인증 상태를 다시 확인하세요." });
          reload();
          return false;
        }
        if (res.status === 409 && attempt.command === "booth.save" &&
            typeof attempt.payload.id === "string" && data?.code === "BOOTH_CHANGED") {
          // Only this locked guard proves that even a retried request did not
          // commit. Generic denials after a lost response remain uncertain.
          commandIdCache.current.delete(fingerprint);
          abandonOperatorAttempt(commandId);
          forgetOperatorReceipt(commandId);
          pendingOperationRef.current = null;
          setPendingOperation(null);
          setOperationRecoveryError(null);
          setAbandonOperationConfirm(false);
          setFailure(null);
          const conflict: BoothConflict = { id: attempt.payload.id, latest: null, loading: false, error: null };
          boothConflictRef.current = conflict;
          setBoothConflict(conflict);
          window.requestAnimationFrame(() => document.getElementById("booth-conflict-heading")?.focus());
          return false;
        }
        const deskConflictKind = res.status === 409 && typeof attempt.payload.id === "string" &&
          ((attempt.command === "desk.save" && data?.code === "DESK_CHANGED") ? "edit" :
            (attempt.command === "desk.set-open" && (data?.code === "DESK_OPEN_CHANGED" || data?.code === "DESK_CHANGED" || data?.code === "DESK_INCOMPLETE")) ? "toggle" : null);
        if (deskConflictKind) {
          // These codes are returned only after locked receipt replay. They
          // settle even a lost-response retry; generic denials do not.
          commandIdCache.current.delete(fingerprint);
          abandonOperatorAttempt(commandId);
          forgetOperatorReceipt(commandId);
          pendingOperationRef.current = null;
          setPendingOperation(null);
          setOperationRecoveryError(null);
          setAbandonOperationConfirm(false);
          setFailure(null);
          const conflict: DeskConflict = { kind: deskConflictKind, id: String(attempt.payload.id), latest: null, loading: false, error: null, incomplete: data?.code === "DESK_INCOMPLETE" };
          deskConflictRef.current = conflict;
          setDeskConflict(conflict);
          window.requestAnimationFrame(() => document.getElementById("desk-conflict-heading")?.focus());
          return false;
        }
        const uncertain = Boolean(retry) || res.status >= 500 || [408, 425, 429].includes(res.status);
        if (!uncertain) {
          commandIdCache.current.delete(fingerprint);
          setFailure({
            message: typeof data?.error === "string" ? data.error : "처리하지 못했습니다.",
            field: typeof data?.field === "string" ? data.field : undefined,
          });
                } else {
          markUnconfirmed();
        }
        return false;
      }
      if (!confirmsOperationsCommand(attempt.command, attempt.payload, data)) {
        markUnconfirmed();
        return false;
      }
      commandIdCache.current.delete(fingerprint);
      acknowledgeOperatorReceipt(commandId);
      forgetOperatorReceipt(commandId);
      pendingOperationRef.current = null;
      setPendingOperation(null);
      setOperationRecoveryError(null);
      setAbandonOperationConfirm(false);
      setNotice(successMessage);
      reload();
      return true;
    } catch (error) {
      if (activeOperationsEventRef.current !== attempt.eventId) return false;
      if (!retry && isOrganizationContextBlock(error)) {
        commandIdCache.current.delete(fingerprint);
        setFailure({ message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        markUnconfirmed();
      }
      return false;
    } finally {
      commandBusyRef.current = false;
      setBusy(false);
    }
  }

  function finishRecoveredOperation(attempt: OperationAttempt) {
    if (attempt.command === "desk.save") { setDeskDirty(false); setDeskOpen(false); setEditingDesk(null); }
    if (attempt.command === "booth.save") { setBoothDirty(false); setBoothOpen(false); setEditingBooth(null); }
    if (attempt.command === "staff.assign") { setAssignDirty(false); setAssignOpen(false); setAssignPreset(null); }
    if (attempt.command === "booth.map.save") { setMapDraftPoints(null); setMapImageOverride(null); setMapPlacing(""); setMapWarning(null); }
    if (attempt.command === "booth.map.publish") setMapDraftPoints(null);
  }

  async function checkOperation() {
    const attempt = pendingOperationRef.current;
    if (!attempt || attempt.eventId !== activeOperationsEventRef.current || busy || commandBusyRef.current) return;
    commandBusyRef.current = true;
    setCheckingOperation(true);
    setOperationRecoveryError(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (activeOperationsEventRef.current !== attempt.eventId) return;
      if (response.ok && data?.status === "APPLIED" && data.command === attempt.command) {
        commandIdCache.current.delete(attempt.fingerprint);
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        pendingOperationRef.current = null;
        setPendingOperation(null);
        setAbandonOperationConfirm(false);
        finishRecoveredOperation(attempt);
        setFailure(null);
        setNotice("현장 운영 처리가 서버에 반영된 것을 확인했습니다. 최신 내용을 확인하세요.");
        reload();
      } else {
        setOperationRecoveryError(response.ok && data?.status === "UNCONFIRMED"
          ? "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요."
          : "처리 결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인한 뒤 다시 확인하세요.");
      }
    } catch {
      if (activeOperationsEventRef.current === attempt.eventId) setOperationRecoveryError("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다.");
    } finally {
      commandBusyRef.current = false;
      setCheckingOperation(false);
    }
  }

  async function retryOperation() {
    const attempt = pendingOperationRef.current;
    if (!attempt || checkingOperation || attempt.eventId !== activeOperationsEventRef.current) return;
    if (otherOperationReceipt) { setOperationRecoveryError("다른 현장 운영 요청도 미확인 상태입니다. 공통 처리 결과에서 먼저 확인하세요."); return; }
    setOperationRecoveryError(null);
    if (await runCommand(attempt.command, attempt.payload, attempt.successMessage, attempt)) finishRecoveredOperation(attempt);
  }

  async function readLatestDesk() {
    const conflict = deskConflictRef.current;
    if (!conflict || deskReadRef.current) return;
    const controller = new AbortController();
    deskReadRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const loading = { ...conflict, latest: null, loading: true, error: null };
    deskConflictRef.current = loading;
    setDeskConflict(loading);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const data = await response.json() as { state?: { events?: unknown; workspaces?: Record<string, { desks?: unknown }> } };
      const bootstrap = data?.state;
      const event = Array.isArray(bootstrap?.events) && bootstrap.events.some((item) => item && typeof item === "object" && item.id === eventId);
      const desks = bootstrap?.workspaces?.[eventId]?.desks;
      if (!response.ok || !event || !Array.isArray(desks)) throw new Error("invalid response");
      const raw = desks.find((item) => item && typeof item === "object" && item.id === conflict.id) as Record<string, unknown> | undefined;
      if (!raw || !(typeof raw.name === "string" || raw.name === null) ||
          !(typeof raw.action === "string" || raw.action === null) ||
          typeof raw.mode !== "string" || !raw.mode || typeof raw.open !== "boolean") throw new Error("invalid desk");
      if (controller.signal.aborted || activeOperationsEventRef.current !== eventId || deskReadRef.current !== controller) return;
      const latest: Desk = { id: conflict.id, name: raw.name as string | null, action: raw.action as string | null, mode: text(raw.mode), open: raw.open === true };
      const resolved = { ...conflict, latest, loading: false, error: null };
      deskConflictRef.current = resolved;
      setDeskConflict(resolved);
    } catch {
      if (activeOperationsEventRef.current !== eventId || deskReadRef.current !== controller) return;
      const failed = { ...conflict, latest: null, loading: false, error: "최신 데스크를 불러오지 못했습니다. 작성 중인 내용은 그대로 있습니다. 다시 시도하세요." };
      deskConflictRef.current = failed;
      setDeskConflict(failed);
    } finally {
      window.clearTimeout(timeout);
      if (deskReadRef.current === controller) deskReadRef.current = null;
    }
  }

  function resolveDeskConflict() {
    const conflict = deskConflictRef.current;
    if (!conflict?.latest || activeOperationsEventRef.current !== eventId) return;
    const latest = conflict.latest;
    setState((current) => current.kind === "ready" ? { ...current, desks: current.desks.map((desk) => desk.id === latest.id ? latest : desk) } : current);
    if (conflict.kind === "edit") setEditingDesk(latest);
    deskConflictRef.current = null;
    setDeskConflict(null);
    setNotice(conflict.kind === "toggle" ? (conflict.incomplete
      ? "최신 데스크를 확인했습니다. 편집에서 이름·작업 방향·화면 방식을 확인해 주세요."
      : "최신 데스크 상태를 확인했습니다. 가동 상태는 직접 변경해 주세요.") : null);
    window.requestAnimationFrame(() => document.getElementById(conflict.kind === "edit" ? "desk-name" : "ops-desks")?.focus());
  }

  async function readLatestBooth() {
    const conflict = boothConflictRef.current;
    if (!conflict || boothReadRef.current) return;
    const controller = new AbortController();
    boothReadRef.current = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const loading = { ...conflict, latest: null, loading: true, error: null };
    boothConflictRef.current = loading;
    setBoothConflict(loading);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store", signal: controller.signal });
      const data = await response.json() as { state?: { events?: unknown; workspaces?: Record<string, { booths?: unknown }> } };
      const bootstrap = data?.state;
      const event = Array.isArray(bootstrap?.events) && bootstrap.events.some((item) => item && typeof item === "object" && item.id === eventId);
      const booths = bootstrap?.workspaces?.[eventId]?.booths;
      if (!response.ok || !event || !Array.isArray(booths)) throw new Error("invalid response");
      const raw = booths.find((item) => item && typeof item === "object" && item.id === conflict.id) as Record<string, unknown> | undefined;
      if (!raw || [raw.name, raw.zone, raw.status, raw.startsAt, raw.endsAt].some((value) => typeof value !== "string") ||
          ![raw.capacity, raw.limit, raw.used].every((value) => typeof value === "number" && Number.isFinite(value))) throw new Error("invalid booth");
      if (controller.signal.aborted || activeOperationsEventRef.current !== eventId || boothReadRef.current !== controller) return;
      const latest: Booth = { id: conflict.id, name: text(raw.name), zone: text(raw.zone), status: text(raw.status),
        capacity: Number(raw.capacity), limit: Number(raw.limit), used: Number(raw.used), startsAt: text(raw.startsAt), endsAt: text(raw.endsAt) };
      const resolved = { ...conflict, latest, loading: false, error: null };
      boothConflictRef.current = resolved;
      setBoothConflict(resolved);
    } catch {
      if (activeOperationsEventRef.current !== eventId || boothReadRef.current !== controller) return;
      const failed = { ...conflict, latest: null, loading: false, error: "최신 부스를 불러오지 못했습니다. 작성 중인 내용은 그대로 있습니다. 다시 시도하세요." };
      boothConflictRef.current = failed;
      setBoothConflict(failed);
    } finally {
      window.clearTimeout(timeout);
      if (boothReadRef.current === controller) boothReadRef.current = null;
    }
  }

  function resolveBoothConflict() {
    const latest = boothConflictRef.current?.latest;
    if (!latest || activeOperationsEventRef.current !== eventId) return;
    setState((current) => current.kind === "ready" ? { ...current, booths: current.booths.map((booth) => booth.id === latest.id ? latest : booth) } : current);
    setEditingBooth(latest);
    boothConflictRef.current = null;
    setBoothConflict(null);
    window.requestAnimationFrame(() => document.getElementById("booth-name")?.focus());
  }

  async function saveBoothMapDraft() {
    if (mapUploadUncertain || mapUploading) return;
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
      setMapWarning(null);
    }
  }

  async function publishBoothMap() {
    if (mapUploadUncertain || mapUploading) return;
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
    if (!mapUnpublishPending || mapUploadUncertain || mapUploading) return;
    await runCommand(
      "booth.map.unpublish",
      { expectedPublishedVersion: boothMap.published?.version ?? 0 },
      "부스 지도를 내렸습니다."
    );
    setMapUnpublishPending(false);
  }

  function requestStampMode(mode: "SELF" | "STAFF") {
    if (!stampMode || visitsCount === null || mode === stampMode) return;
    setStampModePending({ mode, expectedMode: stampMode });
  }

  async function confirmStampMode() {
    const review = stampModePending;
    if (review === null) return;
    await runCommand("booth.mode-reviewed", { ...review, acknowledge: true }, "부스 인증 방식을 바꿨습니다.");
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
  // Write gates mirror the server scope map per section: desks and staff
  // assignment are onsite, booths/map/mode are booth (the venue-display picker moved
  // to 현장 모드). Archived events reject every command server-side,
  // and STAFF console writes 403 server-side (their staff work routes are
  // separate and unaffected). Reads, placement previews and downloads keep
  // working. Neither gate invents access; the server re-checks every command.
  const capabilities = { role: state.role, userId: state.userId, memberships: state.memberships, eventId };
  const canWriteOnsite = canWriteEvent(capabilities, "desk.save");
  const canWriteBooth = canWriteEvent(capabilities, "booth.save");
  const operationLocked = Boolean(pendingOperation) || otherOperationReceipt || busy || checkingOperation;
  const operationLockReason = pendingOperation || otherOperationReceipt ? "이전 현장 운영 요청의 처리 결과를 먼저 확인하세요" : "현장 운영 요청을 처리 중입니다";
  const onsiteBlocked = archived || !canWriteOnsite || operationLocked;
  const onsiteNoWriteReason = operationLocked ? operationLockReason : archived
    ? archivedReason
    : "현장 운영을 변경할 운영 권한이 없습니다";
  const boothBlocked = archived || !canWriteBooth || operationLocked;
  const boothNoWriteReason = operationLocked ? operationLockReason : archived
    ? archivedReason
    : "부스·스탬프 지도를 변경할 부스 권한이 없습니다. 필요하면 담당 행사 운영자에게 요청하세요.";
  const mapControlsBlocked = boothBlocked || mapUploadUncertain || mapUploading;
  // Per-command guard for the shared writer: the button gates above already
  // prevent the call, this only mirrors the same scope map. Called after
  // render, so the render-scope gates it closes over are initialized.
  function commandBlocked(command: string): boolean {
    if (archived) return true;
    return !canWriteEvent(capabilities, command);
  }

  function operationRecovery(): ReactNode {
    if (!pendingOperation) return null;
    return <section className={styles.recovery} aria-labelledby="operations-recovery-heading">
      <h2 id="operations-recovery-heading">현장 운영 처리 확인 필요</h2>
      <p>이전 요청이 반영됐을 수 있습니다. 서버 확인은 요청을 다시 보내지 않습니다.</p>
      {commandBlocked(pendingOperation.command) ? <p>현재 권한으로 같은 요청을 다시 보낼 수 없습니다. 서버 처리 확인이나 담당자 확인을 이용하세요.</p> : null}
      {operationRecoveryError ? <p role="alert">{operationRecoveryError}</p> : null}
      <div className={styles.recoveryActions}>
        <ProductButton type="button" className="button button-secondary" disabled={busy || checkingOperation || abandonOperationConfirm} onClick={() => void checkOperation()}>{checkingOperation ? "확인 중…" : "서버 처리 확인"}</ProductButton>
        <ProductButton type="button" className="button button-secondary" disabled={busy || checkingOperation || abandonOperationConfirm || commandBlocked(pendingOperation.command)} onClick={() => void retryOperation()}>같은 요청 다시 시도</ProductButton>
        <ProductButton type="button" className="button button-secondary" disabled={busy || checkingOperation || abandonOperationConfirm} onClick={() => setAbandonOperationConfirm(true)}>확인 전 그만두기</ProductButton>
      </div>
      {abandonOperationConfirm ? <ConsoleConfirm
        summary="이미 반영된 처리는 취소되지 않습니다. 확인을 그만두고 최신 현장 운영 내용을 확인할까요?"
        confirmLabel="확인 그만두기"
        onConfirm={() => {
          const attempt = pendingOperationRef.current;
          if (!attempt) return;
          commandIdCache.current.delete(attempt.fingerprint);
          abandonOperatorAttempt(attempt.commandId);
          forgetOperatorReceipt(attempt.commandId);
          pendingOperationRef.current = null;
          setPendingOperation(null);
          setOperationRecoveryError(null);
          setAbandonOperationConfirm(false);
          setFailure({ message: "이전 처리가 반영됐을 수 있습니다. 최신 현장 운영 내용을 확인한 뒤 다시 진행하세요." });
        }}
        onCancel={() => setAbandonOperationConfirm(false)}
      /> : null}
    </section>;
  }
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
  // Same-day sections state their status in the description slot; the
  // before-the-day presets state theirs in the folded summary instead, the
  // always-visible keyboard-operable reading point for those rows.
  // Counts reuse the loaded rows; an empty roster stays quiet and lets the
  // section's existing guidance speak instead.
  const deskOpenCount = desks.filter((desk) => desk.open).length;
  const boothOpenCount = booths.filter((booth) => booth.status === "OPEN").length;
  const modeValueLabel = stampMode === "SELF" ? "참가자 셀프 스캔" : stampMode === "STAFF" ? "스태프 확인" : "확인 필요";
  const boothMapHasUnpublishedDraft = Boolean(boothMap.draft) && !mapMatchesPublished(boothMap);
  const mapStatusText = boothMap.published
    ? (boothMapHasUnpublishedDraft
        ? "게시 중 · 새 초안 미게시"
        : `게시 중 · v${boothMap.published.version} ${boothMap.published.points.length}개 위치`)
    : boothMap.draft
      ? "초안만 있음 · 미게시"
      : "미게시";
  const boothSummary = stampEnabled && booths.length
    ? `운영 ${boothOpenCount} / 전체 ${booths.length}`
    : stampEnabled
      ? "등록된 부스 없음"
      : "부스 인증 기능 꺼짐";
  // Who is on duty at a place, as the loaded accounts name them.
  const staffAt = (type: "DESK" | "BOOTH", targetId: string): Staffer[] => assignments
    .filter((assignment) => assignment.type === type && assignment.targetId === targetId)
    .map((assignment) => ({ assignmentId: assignment.id, accountId: assignment.accountId, name: accountName.get(assignment.accountId) ?? "알 수 없는 계정" }));
  const staffLabel = (list: Staffer[]) => (list.length ? `담당 ${list.map((person) => person.name).join(", ")}` : "담당 없음");
  const gapTargets = [
    ...desks.filter((desk) => !staffAt("DESK", desk.id).length).map((desk) => ({ type: "DESK" as const, id: desk.id, name: desk.name || "이름 확인 필요" })),
    ...(stampEnabled ? booths.filter((booth) => !staffAt("BOOTH", booth.id).length).map((booth) => ({ type: "BOOTH" as const, id: booth.id, name: booth.name })) : []),
  ];
  // A preset holding unsaved work or a pending confirmation stays open even
  // when folded: the folded summary already names the state, but the
  // recovery action lives in the body.
  const modeNeedsAttention = stampModePending !== null || stampMode === null || visitsCount === null;
  const mapNeedsAttention =
    mapDraftPoints !== null || mapImageOverride !== null || mapUploading || mapUnpublishPending;

  const mapPoints = mapDraftPoints ?? boothMap.draft?.points ?? [];
  const pointFor = (boothId: string) => mapPoints.find((point) => point.boothId === boothId) ?? null;

  // Booth-map draft edits stay local until 저장; mapDraftPoints holds the
  // working set, and each placement is normalized to 0..1 so the published
  // map scales to any board size.
  async function uploadMapImage(file: File) {
    if (boothBlocked || mapUploadGateRef.current) return;
    if (mapUploadRef.current && mapUploadRef.current.file !== file) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
      setFailure({ message: "배치도는 PNG·JPG·WebP 이미지를 사용하세요." });
      return;
    }
    if (file.size > 600000) {
      setFailure({ message: "600KB 이하 배치도 이미지를 올려주세요." });
      return;
    }
    const attempt = mapUploadRef.current ?? { eventId, file, commandId: randomCommandId(), uncertain: false };
    mapUploadRef.current = attempt;
    mapUploadGateRef.current = true;
    setMapUploading(true);
    setFailure(null);
    setMapUploadError(null);
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(attempt.eventId)}/files?name=${encodeURIComponent(attempt.file.name)}&commandId=${encodeURIComponent(attempt.commandId)}`,
        { method: "POST", headers: { "content-type": attempt.file.type }, body: attempt.file }
      );
      const data = (await res.json().catch(() => null)) as {
        file?: { fileId?: unknown; name?: unknown; type?: unknown; size?: unknown; width?: unknown; height?: unknown };
        error?: unknown;
      } | null;
      if (activeOperationsEventRef.current !== attempt.eventId) return;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      const width = Number(data?.file?.width);
      const height = Number(data?.file?.height);
      if (!res.ok || !/^[A-Za-z0-9_-]{1,160}$/.test(fileId) || data?.file?.name !== attempt.file.name ||
          data?.file?.type !== attempt.file.type || data?.file?.size !== attempt.file.size ||
          !Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) {
        const definitive = !attempt.uncertain && !res.ok && res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
        if (definitive) {
          mapUploadRef.current = null;
          setFailure({ message: typeof data?.error === "string" ? data.error : "배치도를 올리지 못했습니다." });
        } else {
          attempt.uncertain = true;
          setMapUploadUncertain(true);
          setMapUploadError("업로드 결과를 확인하지 못했습니다. 같은 파일 요청을 다시 시도하세요.");
        }
        return;
      }
      mapUploadRef.current = null;
      setMapUploadUncertain(false);
      setMapUploadAbandonConfirm(false);
      const previousImage = mapImageOverride ?? boothMap.draft?.image ?? null;
      if (previousImage && previousImage.fileId !== fileId && mapPoints.length) {
        // The server refuses an image swap with leftover points; clear them
        // here so the operator learns before the save round-trip.
        setMapDraftPoints([]);
        setMapWarning("배치도를 교체했습니다. 부스 위치를 다시 지정한 뒤 저장하세요.");
        setMapImageOverride({
          fileId,
          name: typeof data?.file?.name === "string" ? data.file.name : attempt.file.name,
          width,
          height,
        });
        return;
      }
      setMapImageOverride({
        fileId,
        name: typeof data?.file?.name === "string" ? data.file.name : attempt.file.name,
        width,
        height,
      });
    } catch (error) {
      if (activeOperationsEventRef.current !== attempt.eventId) return;
      if (!attempt.uncertain && isOrganizationContextBlock(error)) {
        mapUploadRef.current = null;
        setFailure({ message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        attempt.uncertain = true;
        setMapUploadUncertain(true);
        setMapUploadError("업로드 결과를 확인하지 못했습니다. 같은 파일 요청을 다시 시도하세요.");
      }
    } finally {
      mapUploadGateRef.current = false;
      if (activeOperationsEventRef.current === attempt.eventId) setMapUploading(false);
    }
  }

  return (
    <ConsolePage
      pageId="operations"
      eventId={eventId}
      eventName={state.eventName || undefined}
      meta={state.eventMeta}
      headerActions={(
        <ProductButton
          id="ops-staff-assign"
          type="button"
          variant={gapTargets.length && !archived ? "primary" : "ghost"}
          onClick={() => { setAssignPreset(null); setAssignOpen(true); setFailure(null); }}
          disabled={assignableTargets === 0 || onsiteBlocked}
          title={onsiteBlocked ? onsiteNoWriteReason : assignableTargets === 0 ? "데스크나 부스를 먼저 만드세요" : undefined}
        >
          스태프 배정
        </ProductButton>
      )}
      feedback={(
        <>
          {state.stage === "ARCHIVED" ? (
            <ConsoleFeedback kind="warning">
              보관된 행사는 읽기 전용입니다. 운영 현황은 볼 수 있지만 추가·변경·게시할 수 없습니다.
            </ConsoleFeedback>
          ) : !canWriteOnsite && !canWriteBooth ? (
            <ConsoleFeedback kind="warning">
              현장 운영을 변경할 운영 권한이 없습니다. 현황 조회는 그대로 볼 수 있습니다.
            </ConsoleFeedback>
          ) : null}
          {(canWriteOnsite || canWriteBooth) && !canWriteOnsite ? (
            <ConsoleFeedback kind="warning">
              데스크·스태프 배정 변경은 현장 운영 권한이 없습니다. 다른 구역은 그대로 변경할 수 있습니다.
            </ConsoleFeedback>
          ) : null}
          {(canWriteOnsite || canWriteBooth) && !canWriteBooth ? (
            <ConsoleFeedback kind="warning">
              부스·스탬프 지도 변경은 부스 권한이 없습니다. 다른 구역은 그대로 변경할 수 있습니다.
            </ConsoleFeedback>
          ) : null}
          {failure && !(deskOpen || boothOpen || assignOpen) ? (
            <ConsoleFeedback kind="error">{failure.message}</ConsoleFeedback>
          ) : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {assignHandoffNotice ? <ConsoleFeedback kind="warning">{assignHandoffNotice}</ConsoleFeedback> : null}
        </>
      )}
    >

      {pendingOperation && !((deskOpen && pendingOperation.command === "desk.save") || (boothOpen && pendingOperation.command === "booth.save") || (assignOpen && pendingOperation.command === "staff.assign")) ? operationRecovery() : null}
      {otherOperationReceipt ? <ConsoleFeedback kind="warning">이전 현장 운영 요청의 처리 결과를 화면 위에서 먼저 확인하세요. 서버 확인은 요청을 다시 보내지 않습니다.</ConsoleFeedback> : null}

      <div className={styles.steps}>
          <ConsoleSection
            headingId="ops-desks"
            title="입장 데스크 만들기"
            description={<StepPill n={1} tone={desks.length ? "ok" : "todo"}>{desks.length ? `완료 · 데스크 ${desks.length}곳${deskOpenCount === desks.length ? "" : ` (가동 ${deskOpenCount}곳)`}` : "데스크를 만드세요"}</StepPill>}
            className={`${styles.anchorSection} ${styles.stepSection}`}
            action={(
              <ProductButton
                type="button"
                variant={desks.length ? "ghost" : "primary"}
                disabled={onsiteBlocked || Boolean(deskConflict)}
                title={onsiteBlocked ? onsiteNoWriteReason : undefined}
                onClick={() => { setEditingDesk(null); setDeskOpen(true); setFailure(null); }}
              >
                데스크 추가
              </ProductButton>
            )}
          >
            {deskConflict?.kind === "toggle" ? <section className={styles.deskConflict} aria-labelledby="desk-conflict-heading">
          <h3 id="desk-conflict-heading" tabIndex={-1}>{deskConflict.incomplete ? "데스크 정보를 확인해야 합니다" : "다른 작업에서 데스크 상태가 변경됐습니다"}</h3>
          <p>{deskConflict.incomplete ? "가동 요청은 반영되지 않았습니다. 최신 데스크를 확인하고 편집에서 이름·작업 방향·화면 방식을 확인해 주세요." : "이번 요청은 반영되지 않았습니다. 최신 상태를 확인한 뒤 직접 가동하거나 중지해 주세요."}</p>
          {deskConflict.error ? <p role="alert">{deskConflict.error}</p> : null}
          {deskConflict.latest ? <>
            <p>최신 상태: <strong>{deskConflict.latest.name || "이름 확인 필요"} · {DESK_ACTION_LABEL[deskConflict.latest.action || ""] || "방향 확인 필요"} · {deskConflict.latest.mode === "tablet" ? "태블릿" : deskConflict.latest.mode === "desk" ? "데스크" : "화면 방식 확인 필요"} · {deskConflict.latest.open ? "가동 설정" : "중지됨"}</strong></p>
            <ProductButton type="button" className="button button-secondary" onClick={resolveDeskConflict} disabled={operationLocked}>최신 상태 적용</ProductButton>
          </> : <ProductButton type="button" className="button button-secondary" onClick={() => void readLatestDesk()} disabled={deskConflict.loading || operationLocked}>{deskConflict.loading ? "최신 상태 확인 중…" : "최신 데스크 확인"}</ProductButton>}
        </section> : null}
            {desks.length ? (
              <ul className={styles.locations}>
                {desks.map((desk) => {
                  const deskIncomplete = !desk.name?.trim() || !["IN", "OUT"].includes(desk.action || "") || !["desk", "tablet"].includes(desk.mode);
                  const deskStaff = staffAt("DESK", desk.id);
                  const deskLabel = desk.name || "이름 확인이 필요한 데스크";
                  const toggleBlocked = busy || onsiteBlocked || Boolean(deskConflict) || (!desk.open && deskIncomplete);
                  return (
                    <LocationRow
                      key={desk.id}
                      name={desk.name || "이름 확인 필요"}
                      sub={`${DESK_ACTION_LABEL[desk.action || ""] ?? "방향 확인 필요"}${desk.mode === "tablet" ? " · 태블릿" : desk.mode === "desk" ? "" : " · 화면 방식 확인 필요"} · ${desk.open ? "가동 중" : "중지됨"}`}
                      staff={deskStaff}
                      staffSummary={staffLabel(deskStaff)}
                      warning={deskIncomplete ? "정보 확인 필요" : null}
                      dim={!desk.open}
                      kind={desk.mode === "tablet" ? "tablet" : "desk"}
                      tone={deskIncomplete ? "warn" : desk.open ? "on" : "off"}
                      openLabel="상세"
                      onOpen={() => setDetail({ type: "DESK", id: desk.id })}
                      control={(
                        <RunSwitch
                          name={deskLabel}
                          on={desk.open}
                          disabled={toggleBlocked}
                          reason={onsiteBlocked ? onsiteNoWriteReason : !desk.open && deskIncomplete ? "이름과 방향·화면 방식을 먼저 확인하세요" : undefined}
                          onToggle={() => {
                            if (desk.open) { setDeskStopPending(desk); return; }
                            void runCommand(
                              "desk.set-open",
                              { id: desk.id, open: true, expectedOpen: desk.open,
                                expectedDesk: { name: desk.name, action: desk.action, mode: desk.mode, open: desk.open } },
                              `${desk.name || "데스크"}를 가동했습니다.`
                            );
                          }}
                        />
                      )}
                    />
                  );
                })}
              </ul>
            ) : (
              <p className="empty-state">등록된 데스크가 없습니다. 진행 중 전환에는 데스크와 스태프 배정이 필요합니다.</p>
            )}
            {deskStopPending ? (
              <ConsoleConfirm
                summary={`${deskStopPending.name || "데스크"}를 중지할까요? 중지하면 이 데스크로 입장·퇴장을 처리할 수 없습니다.`}
                confirmLabel="가동 중지"
                busy={busy}
                onConfirm={() => {
                  const desk = deskStopPending;
                  setDeskStopPending(null);
                  void runCommand(
                    "desk.set-open",
                    { id: desk.id, open: false, expectedOpen: desk.open,
                      expectedDesk: { name: desk.name, action: desk.action, mode: desk.mode, open: desk.open } },
                    `${desk.name || "데스크"}를 중지했습니다.`
                  );
                }}
                onCancel={() => setDeskStopPending(null)}
              />
            ) : null}
          </ConsoleSection>

          <ConsoleSection
            headingId="ops-staff"
            title="스태프 배정"
            description={<StepPill n={2} tone={assignableTargets === 0 ? "wait" : gapTargets.length ? "warn" : "ok"}>{assignableTargets === 0 ? "1단계를 먼저" : gapTargets.length ? `${gapTargets.length}곳 담당 필요` : `완료 · 배정 ${assignments.length}건`}</StepPill>}
            className={`${styles.anchorSection} ${styles.stepSection}`}
          >
            {assignableTargets === 0 ? (
              <p className="notice" role="status">배정하려면 먼저 데스크나 부스를 만드세요.</p>
            ) : gapTargets.length ? (
              <div className={styles.gapSurface}>
                <p className={styles.gapHead}><span className={styles.gapMark} aria-hidden="true" />담당이 없는 곳 <b>{gapTargets.length}</b>곳</p>
                {gapTargets.map((target) => (
                  <div key={`${target.type}-${target.id}`} className={styles.gapRow}>
                    <span className={styles.gapName}><strong>{target.name}</strong><em>{target.type === "DESK" ? "데스크" : "부스"}</em></span>
                    <ProductButton
                      type="button"
                      variant="ghost"
                      icon={<PlusIcon />}
                      disabled={busy || onsiteBlocked}
                      title={onsiteBlocked ? onsiteNoWriteReason : undefined}
                      aria-label={`${target.name}에 스태프 배정`}
                      onClick={() => { setAssignPreset({ type: target.type, targetId: target.id }); setAssignOpen(true); setFailure(null); }}
                    >
                      배정
                    </ProductButton>
                  </div>
                ))}
                {!deskStaffCount ? (
                  <p className={styles.gapCondition} role="status">
                    진행 중 전환 조건: 등록 데스크 {desks.length}개 · 데스크 배정 {deskStaffCount}건
                  </p>
                ) : null}
              </div>
            ) : (
              <div className={styles.gapSurface}>
                <p className={styles.gapOk}><span className={styles.gapOkMark} aria-hidden="true"><CrewIcon /></span>모든 위치에 담당이 있습니다 · 배정 {assignments.length}건</p>
              </div>
            )}
            {assignableTargets > 0 && !assignments.length ? (
              <p className="empty-state">
                배정된 스태프가 없습니다. 진행 중으로 전환하려면 입장 데스크에 스태프를 배정하세요.
              </p>
            ) : null}
          </ConsoleSection>

          <ConsoleSection
            headingId="ops-scan"
            title="스태프 폰에서 스캔"
            description={<StepPill n={3} tone="day">당일</StepPill>}
            className={`${styles.anchorSection} ${styles.stepSection}`}
          >
            <div className={styles.scanStep}>
              <div className={styles.scanCopy}>
                <ol className={styles.scanList}>
                  <li>스태프가 자기 폰에서 <b>스태프 로그인</b> 주소를 엽니다.</li>
                  <li>배정된 데스크가 바로 열립니다.</li>
                  <li>티켓 QR을 카메라에 비추거나 번호를 입력해 입장을 처리합니다.</li>
                </ol>
                <p className={styles.scanLink}>
                  <span>로그인 주소</span>
                  <code>{typeof window === "undefined" ? "/staff" : `${window.location.origin}/staff`}</code>
                </p>
                <div className={styles.scanActions}>
                  <ProductButton type="button" variant="ghost" icon={staffLinkCopied ? <CheckIcon /> : <CopyIcon />} onClick={() => void copyStaffLink()}>{staffLinkCopied ? "복사했습니다" : "주소 복사"}</ProductButton>
                  <ProductLink variant="ghost" href="/staff" target="_blank" rel="noreferrer">스태프 화면 열기<span className="sr-only"> (새 탭)</span></ProductLink>
                  {staffAccounts.length === 0 ? <ProductLink variant="ghost" href="/console/team">스태프 초대하기</ProductLink> : null}
                </div>
                <p className={styles.hint} role="status">{staffAccounts.length ? `스태프 계정 ${staffAccounts.length}명 · 데스크에 배정된 사람만 스캔할 수 있습니다.` : "스태프 계정이 없습니다. 팀·권한에서 스태프를 초대한 뒤 데스크에 배정하세요."}</p>
              </div>
              <div className={styles.scanPhone} aria-hidden="true">
                <DeviceFrame variant="phone" fixed maxDisplayWidth={196} viewportHeight={500}>
                  <div className={styles.phoneScreen}>
                    <small>{desks[0]?.name || "입장 데스크"} · {DESK_ACTION_LABEL[desks[0]?.action || "IN"] ?? "입장"}</small>
                    <strong>QR을 비춰 주세요</strong>
                    <span className={styles.phoneCamera}>카메라</span>
                    <span className={styles.phoneButtons}><i>번호 입력</i><i>명단 찾기</i></span>
                  </div>
                </DeviceFrame>
              </div>
            </div>
          </ConsoleSection>

          {stampEnabled ? (
          <ConsoleSection
            headingId="ops-booths"
            title="부스 (선택)"
            description={boothSummary}
            className={styles.anchorSection}
            action={(
              <ProductButton
                type="button"
                variant="ghost"
                disabled={busy || boothBlocked}
                title={boothBlocked ? boothNoWriteReason : undefined}
                onClick={() => { setEditingBooth(null); setBoothOpen(true); setFailure(null); }}
              >
                부스 추가
              </ProductButton>
            )}
          >
            {booths.length ? (
              <ul className={styles.locations}>
                {booths.map((booth) => {
                  const boothStaff = staffAt("BOOTH", booth.id);
                  return (
                    <LocationRow
                      key={booth.id}
                      name={booth.name}
                      sub={`${booth.zone || "구역 미지정"} · ${booth.capacity
                        ? `인증 ${booth.used}회 · 잔여 ${Math.max(0, booth.capacity - booth.used)} / ${booth.capacity}`
                        : `인증 ${booth.used}회 · 잔여 제한 없음`}`}
                      staff={boothStaff}
                      staffSummary={staffLabel(boothStaff)}
                      warning={boothScheduleNeedsReview(booth.startsAt, booth.endsAt) ? "운영 시간 확인 필요 · 확인 전에는 부스 인증을 받을 수 없습니다." : null}
                      kind="booth"
                      tone={booth.status === "OPEN" ? "on" : booth.status === "WAITING" ? "wait" : "off"}
                      openLabel="상세"
                      onOpen={() => setDetail({ type: "BOOTH", id: booth.id })}
                      control={(
                        <StatusDot tone={booth.status === "OPEN" ? "good" : booth.status === "WAITING" ? "wait" : "muted"}>
                          {BOOTH_STATUS_LABEL[booth.status] ?? "상태 미정"}
                        </StatusDot>
                      )}
                    />
                  );
                })}
              </ul>
            ) : (
              <p className="empty-state">등록된 부스가 없습니다.</p>
            )}
          </ConsoleSection>
          ) : (
            <p className={styles.optionalNote}>
              부스 인증이 필요한 행사는 행사 설정의 기능에서 켜세요.
              <ProductLink variant="ghost" href={`/console/events/${encodeURIComponent(eventId)}/settings#settings-features`}>부스 인증 기능 켜기</ProductLink>
            </p>
          )}
      </div>

      <div className={styles.presetGrid}>
      {stampEnabled ? (
        <ConsoleSection headingId="ops-booth-mode" title="부스 인증 방식" className={styles.anchorSection}>
          {/* Before-the-day preset: starts folded with the current value
              in the folded summary; the draws setup-details same grammar. */}
          <details className={styles.presetFold} open={presetOpen.mode || modeNeedsAttention} onToggle={(event) => setPresetOpen((prev) => ({ ...prev, mode: (event.target as HTMLDetailsElement).open }))}>
            <summary className={styles.presetSummary} data-disclosure-indicator="">인증 방식 · {modeValueLabel}</summary>
            <div className={styles.presetBody}>
          <p className={styles.hint}>
            {stampMode === "SELF"
              ? "참가자가 부스 QR을 직접 스캔합니다. 부스마다 QR을 붙여 주세요."
              : stampMode === "STAFF" ? "스태프가 참가자 티켓을 확인해 처리합니다. 부스 배정이 필요합니다." : "현재 인증 방식을 확인할 수 없습니다. 시스템 관리자에게 문의하세요."}
            {visitsCount ? ` · 이미 인증 ${visitsCount}건이라 방식을 바꿀 수 없습니다.` : ""}
          </p>
          {visitsCount === null ? <ConsoleFeedback kind="warning">부스 인증 기록을 확인할 수 없습니다. 인증 방식을 변경하기 전에 시스템 관리자에게 문의하세요.</ConsoleFeedback> : null}
          <div className={styles.buttonRow}>
            <ProductButton
              type="button"
              className={`button ${stampMode === "STAFF" ? "button-primary" : "button-secondary"}`}
              disabled={busy || visitsCount === null || visitsCount > 0 || stampMode === null || stampMode === "STAFF" || boothBlocked}
              title={boothBlocked ? boothNoWriteReason : undefined}
              aria-pressed={stampMode === "STAFF"}
              onClick={() => requestStampMode("STAFF")}
            >
              스태프 확인
            </ProductButton>
            <ProductButton
              type="button"
              className={`button ${stampMode === "SELF" ? "button-primary" : "button-secondary"}`}
              disabled={busy || visitsCount === null || visitsCount > 0 || stampMode === null || stampMode === "SELF" || boothBlocked}
              title={boothBlocked ? boothNoWriteReason : undefined}
              aria-pressed={stampMode === "SELF"}
              onClick={() => requestStampMode("SELF")}
            >
              참가자 셀프 스캔
            </ProductButton>
          </div>
          {stampModePending ? (
            <ConsoleConfirm
              summary={(
                <>
                  인증 방식을 &lsquo;{stampModePending.mode === "SELF" ? "참가자가 부스 QR을 직접 스캔" : "스태프가 참가자 티켓을 확인"}&rsquo;(으)로 바꿀까요?
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
        <ConsoleSection headingId="ops-booth-map" title="부스 지도" className={styles.anchorSection}>
          {/* Before-the-day preset: starts folded with the publish state
              in the folded summary so an unposted draft is never missed. */}
          <details className={styles.presetFold} open={presetOpen.map || mapNeedsAttention || mapUploadUncertain} onToggle={(event) => setPresetOpen((prev) => ({ ...prev, map: (event.target as HTMLDetailsElement).open }))}>
            <summary className={styles.presetSummary} data-disclosure-indicator="">부스 지도 · {mapStatusText}</summary>
            <div className={styles.presetBody}>
          <p className={styles.hint}>
            배치도를 올리고, 부스를 골라 이미지를 눌러 위치를 찍습니다. 게시해야 참가자 화면에 보입니다.
          </p>
          {mapWarning ? <ConsoleFeedback kind="warning">{mapWarning}</ConsoleFeedback> : null}
          <div className={styles.buttonRow}>
            <label className={`button button-secondary ${mapControlsBlocked ? styles.uploadDisabled : ""}`} aria-disabled={mapControlsBlocked} title={mapUploadUncertain ? "먼저 파일 업로드 결과를 확인하세요" : boothBlocked ? boothNoWriteReason : undefined}>
              {mapUploading ? "올리는 중…" : boothMap.draft ? "배치도 교체" : "배치도 올리기"}
              <input
                type="file"
                className="sr-only"
                accept="image/png,image/jpeg,image/webp"
                disabled={mapUploading || busy || mapControlsBlocked}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) { setMapUnpublishPending(false); setMapPlacing(""); void uploadMapImage(file); }
                  event.target.value = "";
                }}
              />
            </label>
            {mapImageOverride || boothMap.draft ? (
              <>
                <ProductButton type="button" className="button button-primary" disabled={busy || mapUploading || mapControlsBlocked} title={mapUploadUncertain ? "먼저 파일 업로드 결과를 확인하세요" : boothBlocked ? boothNoWriteReason : undefined} onClick={() => void saveBoothMapDraft()}>
                  초안 저장
                </ProductButton>
                <ProductButton type="button" className="button button-secondary" disabled={busy || !boothMap.draft || mapControlsBlocked} title={mapUploadUncertain ? "먼저 파일 업로드 결과를 확인하세요" : boothBlocked ? boothNoWriteReason : !boothMap.draft ? "초안을 먼저 저장하세요" : undefined} onClick={() => void publishBoothMap()}>
                  게시
                </ProductButton>
              </>
            ) : null}
            {boothMap.published ? (
              <ProductButton type="button" className="button button-secondary" disabled={busy || mapControlsBlocked} title={mapUploadUncertain ? "먼저 파일 업로드 결과를 확인하세요" : boothBlocked ? boothNoWriteReason : undefined} onClick={() => requestUnpublishBoothMap()}>
                게시 내리기
              </ProductButton>
            ) : null}
          </div>
          {mapUploadUncertain ? <section className={styles.recovery} aria-labelledby="operations-map-upload-heading">
            <h3 id="operations-map-upload-heading">지도 파일 확인 필요</h3>
            <p>파일이 이미 올라갔을 수 있습니다. 같은 파일 요청을 다시 시도해 결과를 확인하세요. 선택한 파일은 이 화면에만 유지되므로 새로고침하거나 떠나면 같은 요청을 다시 시도할 수 없습니다.</p>
            {mapUploadError ? <p role="alert">{mapUploadError}</p> : null}
            <div className={styles.recoveryActions}>
              <ProductButton type="button" className="button button-secondary" disabled={mapUploading || boothBlocked || mapUploadAbandonConfirm} onClick={() => { const attempt = mapUploadRef.current; if (attempt) void uploadMapImage(attempt.file); }}>같은 파일 요청 다시 시도</ProductButton>
              <ProductButton type="button" className="button button-secondary" disabled={mapUploading || mapUploadAbandonConfirm} onClick={() => setMapUploadAbandonConfirm(true)}>확인 전 그만두기</ProductButton>
            </div>
            {mapUploadAbandonConfirm ? <ConsoleConfirm
              summary="확인을 그만둬도 이미 업로드된 파일이 서버에 남을 수 있습니다. 지도에는 자동으로 적용되지 않습니다. 그만둘까요?"
              confirmLabel="확인 그만두기"
              onConfirm={() => { mapUploadRef.current = null; setMapUploadUncertain(false); setMapUploadError(null); setMapUploadAbandonConfirm(false); }}
              onCancel={() => setMapUploadAbandonConfirm(false)}
            /> : null}
          </section> : null}
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
                    if (!mapPlacing || mapControlsBlocked) return;
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
                      <ProductButton
                        type="button"
                        className="button button-secondary"
                        disabled={busy || mapControlsBlocked}
                        title={boothBlocked ? boothNoWriteReason : undefined}
                        onClick={() => setMapPlacing(mapPlacing === booth.id ? "" : booth.id)}
                      >
                        {mapPlacing === booth.id ? "지정 취소" : point ? "다시 지정" : "위치 지정"}
                      </ProductButton>
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
      </div>

      {deskOpen ? (
        <DeskDialog
          busy={busy}
          blocked={operationLocked}
          recovery={pendingOperation?.command === "desk.save" ? operationRecovery() : null}
          failure={failure}
          initial={editingDesk}
          conflict={deskConflict?.kind === "edit" ? deskConflict : null}
          onReadLatest={() => void readLatestDesk()}
          onResolveConflict={resolveDeskConflict}
          onClose={() => {
            deskReadRef.current?.abort(); deskReadRef.current = null;
            deskConflictRef.current = null; setDeskConflict(null);
            setDeskDirty(false); setDeskOpen(false); setEditingDesk(null);
          }}
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
          blocked={operationLocked}
          recovery={pendingOperation?.command === "booth.save" ? operationRecovery() : null}
          failure={failure}
          initial={editingBooth}
          conflict={boothConflict}
          onReadLatest={() => void readLatestBooth()}
          onResolveConflict={resolveBoothConflict}
          onClose={() => {
            boothReadRef.current?.abort(); boothReadRef.current = null;
            boothConflictRef.current = null; setBoothConflict(null);
            setBoothDirty(false); setBoothOpen(false); setEditingBooth(null);
          }}
          onDirtyChange={setBoothDirty}
          onSubmit={async (payload) => {
            const ok = await runCommand("booth.save", payload, "부스를 저장했습니다.");
            if (ok) { setBoothDirty(false); setBoothOpen(false); setEditingBooth(null); }
          }}
        />
      ) : null}
      {detail ? (() => {
        const desk = detail.type === "DESK" ? desks.find((item) => item.id === detail.id) ?? null : null;
        const booth = detail.type === "BOOTH" ? booths.find((item) => item.id === detail.id) ?? null : null;
        const target = desk ?? booth;
        if (!target) return null;
        const blocked = detail.type === "DESK" ? onsiteBlocked : boothBlocked;
        return (
          <LocationDialog
            title={desk ? desk.name || "이름 확인 필요" : booth!.name}
            sub={desk ? `${DESK_ACTION_LABEL[desk.action || ""] ?? "방향 확인 필요"} · ${desk.open ? "가동 중" : "중지됨"}` : `${booth!.zone || "구역 미지정"} · ${BOOTH_STATUS_LABEL[booth!.status] ?? "상태 미정"}`}
            kind={detail.type === "DESK" ? "데스크" : "부스"}
            staff={staffAt(detail.type, detail.id)}
            busy={busy}
            blocked={blocked}
            reason={blocked ? (detail.type === "DESK" ? onsiteNoWriteReason : boothNoWriteReason) : undefined}
            onClose={() => setDetail(null)}
            onAdd={() => { setDetail(null); setAssignPreset({ type: detail.type, targetId: detail.id }); setAssignOpen(true); setFailure(null); }}
            onEdit={() => {
              setDetail(null);
              if (desk) { setEditingDesk(desk); setDeskOpen(true); } else if (booth) { setEditingBooth(booth); setBoothOpen(true); }
              setFailure(null);
            }}
            onRelease={(assignmentId) => void runCommand("staff.unassign", { id: assignmentId }, "배정을 해제했습니다.")}
          />
        );
      })() : null}
      {assignOpen ? (
        <AssignDialog
          busy={busy}
          blocked={operationLocked}
          recovery={pendingOperation?.command === "staff.assign" ? operationRecovery() : null}
          failure={failure}
          staffAccounts={staffAccounts}
          desks={desks}
          booths={stampEnabled ? booths : []}
          initialType={assignPreset?.type ?? (desks.length ? "DESK" : "BOOTH")}
          initialTargetId={assignPreset?.targetId ?? ""}
          initialAccountId={assignPreset?.accountId}
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

function LocationDialog({ title, sub, kind, staff, busy, blocked, reason, onClose, onAdd, onEdit, onRelease }: {
  title: string;
  sub: string;
  kind: "데스크" | "부스";
  staff: Staffer[];
  busy: boolean;
  blocked: boolean;
  reason?: string;
  onClose: () => void;
  onAdd: () => void;
  onEdit: () => void;
  onRelease: (assignmentId: string) => void;
}) {
  return (
    <ConsoleDialog title={title} description={sub} onClose={onClose} busy={busy}>
      <section aria-label={`${kind} 담당 스태프`}>
        {staff.length ? (
          <ul className={styles.dutyList}>
            {staff.map((person) => (
              <li key={person.assignmentId} className={styles.dutyRow}>
                <StaffFaces staff={[person]} />
                <span className={styles.dutyName}>{person.name}</span>
                <ProductButton
                  type="button"
                  variant="destructive"
                  disabled={busy || blocked}
                  title={blocked ? reason : undefined}
                  aria-label={`${person.name} 배정 해제`}
                  onClick={() => onRelease(person.assignmentId)}
                >
                  해제
                </ProductButton>
                {/* > 해제 </button> legacy source-audit compatibility */}
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.dutyEmpty}>배정된 스태프 없음</p>
        )}
      </section>
      <ConsoleFormActions>
        <ProductButton type="button" variant="ghost" disabled={busy || blocked} title={blocked ? reason : undefined} onClick={onEdit}>{kind} 편집</ProductButton>
        <ProductButton type="button" variant="secondary" disabled={busy || blocked} title={blocked ? reason : undefined} onClick={onAdd}>담당 추가</ProductButton>
      </ConsoleFormActions>
    </ConsoleDialog>
  );
}

function DialogError({ failure, id }: { failure: Failure | null; id: string }) {
  if (!failure) return null;
  return <p role="alert" id={id}>{failure.message}</p>;
}

function DeskDialog({
  busy,
  blocked,
  recovery,
  failure,
  initial,
  conflict,
  onReadLatest,
  onResolveConflict,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  busy: boolean;
  blocked: boolean;
  recovery: ReactNode;
  failure: Failure | null;
  initial?: Desk | null;
  conflict: DeskConflict | null;
  onReadLatest: () => void;
  onResolveConflict: () => void;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [action, setAction] = useState(initial ? initial.action || "" : "IN");
  const [mode, setMode] = useState(initial ? initial.mode : "desk");
  const [confirmDirection, setConfirmDirection] = useState(false);
  const directionChanged = Boolean(initial) && ["IN", "OUT"].includes(action) && initial?.action !== action;
  const dirty =
    name !== (initial?.name ?? "") ||
    action !== (initial ? initial.action ?? "" : "IN") ||
    mode !== (initial?.mode ?? "desk") ||
    confirmDirection;
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  // Dismissal gate for Escape/backdrop/Cancel: dirty input asks once instead
  // of silently discarding. In-flight submits stay locked by `busy`.
  const canClose = () => {
    if (!dirty && !blocked && !conflict) return true;
    return window.confirm(blocked ? "처리 결과를 아직 확인하지 못했습니다. 닫아도 서버 처리는 취소되지 않으며 원래 요청은 유지됩니다. 닫을까요?" : "작성 중인 내용이 사라집니다. 닫을까요?");
  };
  return (
    <ConsoleDialog title={initial ? "데스크 편집" : "데스크 추가"} onClose={onClose} busy={busy} canClose={canClose}>
      <ValidatedForm
        className={uiStyles.formStack}
        onSubmit={(event) => {
          event.preventDefault();
          if (conflict) return;
          // The server derives open from the payload; an edit that omits it
          // would silently reopen a stopped desk, so the current state rides
          // along. A direction change forces the desk closed server-side.
          const payload: Record<string, unknown> = initial
            ? { id: initial.id, name, action, mode, open: initial.open,
                expectedDesk: { name: initial.name, action: initial.action, mode: initial.mode, open: initial.open } }
            : { name, action, mode, open: true };
          if (directionChanged && confirmDirection) payload.confirmDirectionChange = true;
          onSubmit(payload);
        }}
      >
        {conflict ? <section className={styles.deskConflict} aria-labelledby="desk-conflict-heading">
          <h3 id="desk-conflict-heading" tabIndex={-1}>다른 작업에서 데스크 정보가 변경됐습니다</h3>
          <p>이번 저장은 반영되지 않았습니다. 작성 중인 내용은 그대로 있습니다. 최신 데스크를 확인해 주세요.</p>
          {conflict.error ? <p role="alert">{conflict.error}</p> : null}
          {conflict.latest ? <>
            <table className={styles.deskComparison}>
              <caption>최신 데스크와 내 작성 내용 비교</caption>
              <thead><tr><th scope="col">항목</th><th scope="col">최신 데스크</th><th scope="col">내 작성 내용</th></tr></thead>
              <tbody>
                <tr><th scope="row">이름</th><td>{conflict.latest.name || "이름 확인 필요"}</td><td>{name || "입력 필요"}</td></tr>
                <tr><th scope="row">작업</th><td>{DESK_ACTION_LABEL[conflict.latest.action || ""] || "방향 확인 필요"}</td><td>{DESK_ACTION_LABEL[action] || "방향 선택 필요"}</td></tr>
                <tr><th scope="row">화면</th><td>{conflict.latest.mode === "tablet" ? "태블릿" : conflict.latest.mode === "desk" ? "데스크" : "화면 방식 확인 필요"}</td><td>{mode === "tablet" ? "태블릿" : mode === "desk" ? "데스크" : "화면 방식 선택 필요"}</td></tr>
              </tbody>
            </table>
            <p>가동 상태는 최신 상태({conflict.latest.open ? "가동 중" : "중지됨"})를 따릅니다. 작업 방향을 바꾸면 데스크가 중지됩니다.</p>
            <div className={styles.buttonRow}>
              <ProductButton type="button" className="button button-secondary" onClick={() => { setConfirmDirection(false); onResolveConflict(); }}>내 작성 내용으로 계속</ProductButton>
              <ProductButton type="button" className="button button-secondary" onClick={() => {
                setName(conflict.latest!.name || ""); setAction(conflict.latest!.action || ""); setMode(conflict.latest!.mode);
                setConfirmDirection(false); onResolveConflict();
              }}>최신 정보 사용</ProductButton>
            </div>
            <p>선택만으로 저장되지 않습니다. 내용을 확인한 뒤 직접 저장해 주세요.</p>
          </> : <ProductButton type="button" className="button button-secondary" onClick={onReadLatest} disabled={conflict.loading || blocked || busy}>{conflict.loading ? "최신 정보 확인 중…" : "최신 데스크 확인"}</ProductButton>}
        </section> : null}
        <fieldset className={styles.dialogFields} disabled={blocked || busy || Boolean(conflict)}>
        <legend className="sr-only">데스크 정보</legend>
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
          <ConsoleChoiceGroup id="desk-action" label="작업" value={action} onChange={setAction}
            hint={!['IN', 'OUT'].includes(action) ? "입장 또는 퇴장 방향을 직접 선택해 주세요." : undefined}
            options={[{ value: "IN", label: "입장" }, { value: "OUT", label: "퇴장" }]} />
        </div>
        <div>
          <ConsoleChoiceGroup id="desk-mode" label="화면" value={mode} onChange={setMode}
            hint={!['desk', 'tablet'].includes(mode) ? "사용할 화면 방식을 직접 선택해 주세요." : undefined}
            options={[{ value: "desk", label: "데스크" }, { value: "tablet", label: "태블릿" }]} />
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
        </fieldset>
        <DialogError failure={failure} id="desk-dialog-error" />
        {recovery}
        <ConsoleFormActions>
          <ProductButton type="button" className="button button-secondary" onClick={() => { if (canClose()) onClose(); }} disabled={busy}>
            취소
          </ProductButton>
          <ProductButton type="submit" className="button button-primary" disabled={busy || blocked || Boolean(conflict) || !name.trim() || !["IN", "OUT"].includes(action) || !["desk", "tablet"].includes(mode) || (directionChanged && !confirmDirection)}>
            {busy ? "저장 중입니다" : "데스크 저장"}
          </ProductButton>
        </ConsoleFormActions>
      </ValidatedForm>
    </ConsoleDialog>
  );
}

function BoothDialog({
  busy,
  blocked,
  recovery,
  failure,
  initial,
  conflict,
  onReadLatest,
  onResolveConflict,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  busy: boolean;
  blocked: boolean;
  recovery: ReactNode;
  failure: Failure | null;
  initial?: Booth | null;
  conflict: BoothConflict | null;
  onReadLatest: () => void;
  onResolveConflict: () => void;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [zone, setZone] = useState(initial?.zone ?? "");
  const [status, setStatus] = useState(initial?.status ?? "WAITING");
  const [capacity, setCapacity] = useState(String(initial?.capacity ?? 0));
  const [limit, setLimit] = useState(String(initial?.limit ?? 1));
  const [startTime, setStartTime] = useState<BoothTimeEdit>(() => ({ action: "keep", value: boothTimeInput(initial?.startsAt ?? "") }));
  const [endTime, setEndTime] = useState<BoothTimeEdit>(() => ({ action: "keep", value: boothTimeInput(initial?.endsAt ?? "") }));
  const [timeError, setTimeError] = useState("");
  const startDescription = boothTimeInputDescription(startTime.value);
  const endDescription = boothTimeInputDescription(endTime.value);
  const storedStart = boothScheduleTime(initial?.startsAt);
  const storedEnd = boothScheduleTime(initial?.endsAt);
  const storedOrderInvalid = storedStart !== null && storedEnd !== null && Number.isFinite(storedStart) &&
    Number.isFinite(storedEnd) && storedStart >= storedEnd;
  const dirty =
    name !== (initial?.name ?? "") ||
    zone !== (initial?.zone ?? "") ||
    status !== (initial?.status ?? "WAITING") ||
    capacity !== String(initial?.capacity ?? 0) ||
    limit !== String(initial?.limit ?? 1) ||
    startTime.action !== "keep" || endTime.action !== "keep";
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const canClose = () => {
    if (!dirty && !blocked && !conflict) return true;
    return window.confirm(blocked ? "처리 결과를 아직 확인하지 못했습니다. 닫아도 서버 처리는 취소되지 않으며 원래 요청은 유지됩니다. 닫을까요?" : "작성 중인 내용이 사라집니다. 닫을까요?");
  };
  return (
    <ConsoleDialog title={initial ? "부스 편집" : "부스 추가"} onClose={onClose} busy={busy} canClose={canClose}>
      <ValidatedForm
        className={uiStyles.formStack}
        onSubmit={(event) => {
          event.preventDefault();
          if (conflict) return;
          const changedTime = startTime.action !== "keep" || endTime.action !== "keep";
          const startValue = startTime.action === "set" ? boothTimeFromInput(startTime.value) : startTime.action === "clear" ? "" : initial?.startsAt ?? "";
          const endValue = endTime.action === "set" ? boothTimeFromInput(endTime.value) : endTime.action === "clear" ? "" : initial?.endsAt ?? "";
          if (startValue === null || endValue === null) {
            setTimeError("날짜와 시간을 모두 입력하거나 해당 시간 지우기를 선택하세요.");
            window.requestAnimationFrame(() => document.getElementById(startValue === null ? "booth-starts" : "booth-ends")?.focus());
            return;
          }
          if (changedTime && ((startTime.action === "keep" && boothTimeNeedsReview(startValue)) ||
              (endTime.action === "keep" && boothTimeNeedsReview(endValue)))) {
            setTimeError("기존 시간의 시간대나 형식을 확인할 수 없습니다. 시작과 종료를 각각 입력하거나 지워 주세요.");
            window.requestAnimationFrame(() => document.getElementById(startTime.action === "keep" && boothTimeNeedsReview(startValue) ? "booth-starts" : "booth-ends")?.focus());
            return;
          }
          if (changedTime && startValue && endValue && Date.parse(startValue) >= Date.parse(endValue)) {
            setTimeError("종료 시간은 시작 시간보다 늦어야 합니다.");
            window.requestAnimationFrame(() => document.getElementById("booth-ends")?.focus());
            return;
          }
          setTimeError("");
          onSubmit({
            ...(initial ? { id: initial.id } : null),
            name,
            zone,
            status,
            capacity: Number(capacity) || 0,
            limit: Number(limit) || 1,
            ...(startTime.action !== "keep" ? { startsAt: startValue } : null),
            ...(endTime.action !== "keep" ? { endsAt: endValue } : null),
            ...(initial ? { expectedBooth: { name: initial.name, zone: initial.zone, status: initial.status,
              capacity: initial.capacity, limit: initial.limit, startsAt: initial.startsAt, endsAt: initial.endsAt } } : null),
          });
        }}
      >
        {conflict ? <section className={styles.deskConflict} aria-labelledby="booth-conflict-heading">
          <h3 id="booth-conflict-heading" tabIndex={-1}>다른 작업에서 부스 정보가 변경됐습니다</h3>
          <p>이번 저장은 반영되지 않았습니다. 작성 중인 내용은 그대로 있습니다. 최신 정보와 비교해 주세요.</p>
          {conflict.error ? <p role="alert">{conflict.error}</p> : null}
          {conflict.latest ? <>
            <table className={styles.deskComparison}>
              <caption>최신 부스와 내 작성 내용 비교</caption>
              <thead><tr><th scope="col">항목</th><th scope="col">최신 부스</th><th scope="col">내 작성 내용</th></tr></thead>
              <tbody>
                {[
                  { label: "이름", latest: conflict.latest.name, draft: name, changed: conflict.latest.name !== name },
                  { label: "구역", latest: conflict.latest.zone || "미지정", draft: zone || "미지정", changed: conflict.latest.zone !== zone },
                  { label: "상태", latest: BOOTH_STATUS_LABEL[conflict.latest.status] || conflict.latest.status, draft: BOOTH_STATUS_LABEL[status] || status, changed: conflict.latest.status !== status },
                  { label: "수량", latest: conflict.latest.capacity || "제한 없음", draft: Number(capacity) || "제한 없음", changed: conflict.latest.capacity !== Number(capacity) },
                  { label: "1인 횟수", latest: conflict.latest.limit, draft: limit, changed: conflict.latest.limit !== Number(limit) },
                  { label: "시작 시간", latest: boothTimeLabel(conflict.latest.startsAt),
                    draft: startTime.action === "keep" ? `${boothTimeLabel(conflict.latest.startsAt)} (최신값 유지)` : startTime.action === "clear" ? "지움" : (boothTimeFromInput(startTime.value) ? boothTimeLabel(boothTimeFromInput(startTime.value)!) : "입력 확인 필요"),
                    changed: startTime.action !== "keep" },
                  { label: "종료 시간", latest: boothTimeLabel(conflict.latest.endsAt),
                    draft: endTime.action === "keep" ? `${boothTimeLabel(conflict.latest.endsAt)} (최신값 유지)` : endTime.action === "clear" ? "지움" : (boothTimeFromInput(endTime.value) ? boothTimeLabel(boothTimeFromInput(endTime.value)!) : "입력 확인 필요"),
                    changed: endTime.action !== "keep" },
                ].map(({ label, latest, draft, changed }) => <tr key={label} className={changed ? styles.comparisonChanged : undefined}>
                  <th scope="row">{label}{changed ? <span className={styles.comparisonDifference}>다름</span> : null}</th><td>{latest}</td><td>{draft}</td>
                </tr>)}
              </tbody>
            </table>
            <p>내 작성 내용으로 계속한 뒤 저장하면 위의 내 작성 내용이 적용됩니다. 직접 바꾸지 않은 시간은 최신 설정을 유지합니다.</p>
            <div className={styles.buttonRow}>
              <ProductButton type="button" className="button button-secondary" disabled={blocked || busy} onClick={() => {
                if (startTime.action === "keep") setStartTime({ action: "keep", value: boothTimeInput(conflict.latest!.startsAt) });
                if (endTime.action === "keep") setEndTime({ action: "keep", value: boothTimeInput(conflict.latest!.endsAt) });
                setTimeError(""); onResolveConflict();
              }}>내 작성 내용으로 계속</ProductButton>
              <ProductButton type="button" className="button button-secondary" disabled={blocked || busy} onClick={() => {
                setName(conflict.latest!.name); setZone(conflict.latest!.zone); setStatus(conflict.latest!.status);
                setCapacity(String(conflict.latest!.capacity)); setLimit(String(conflict.latest!.limit));
                setStartTime({ action: "keep", value: boothTimeInput(conflict.latest!.startsAt) });
                setEndTime({ action: "keep", value: boothTimeInput(conflict.latest!.endsAt) });
                setTimeError(""); onResolveConflict();
              }}>최신 정보 사용</ProductButton>
            </div>
            <p>선택만으로 저장되지 않습니다. 내용을 확인한 뒤 직접 저장해 주세요.</p>
          </> : <ProductButton type="button" className="button button-secondary" onClick={onReadLatest} disabled={conflict.loading || blocked || busy}>{conflict.loading ? "최신 정보 확인 중…" : "최신 부스 확인"}</ProductButton>}
        </section> : null}
        <fieldset className={styles.dialogFields} disabled={blocked || busy || Boolean(conflict)}>
        <legend className="sr-only">부스 정보</legend>
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
        <div>
          <p id="booth-time-help">운영 시간은 한국 시간입니다. 설정하지 않은 시작·종료에는 해당 시간 제한이 없습니다. 직접 변경한 시간만 저장됩니다.</p>
          {initial && (boothTimeNeedsReview(initial.startsAt) || boothTimeNeedsReview(initial.endsAt) || storedOrderInvalid) ? <p role="note">
            기존 운영 시간을 확인하기 전에는 부스 인증을 받을 수 없습니다. {storedOrderInvalid ? "저장된 종료가 시작보다 늦지 않습니다. " : ""}새 값을 입력하거나 지우고 저장해 주세요. 기존 값은 자동으로 바뀌지 않습니다.
          </p> : null}
          <label htmlFor="booth-starts">시작 시간 (선택)</label>
          {initial?.startsAt && boothTimeNeedsReview(initial.startsAt) ? <p>저장된 시작: {boothTimeLabel(initial.startsAt)}. 새 값을 입력하거나 지우기 전에는 그대로 유지됩니다.</p> : null}
          {storedStart !== null && Number.isFinite(storedStart) && storedStart % 60000 !== 0 ? <p>저장된 시작에는 초 단위가 있습니다. 수정하지 않으면 그대로 유지하고, 수정하면 입력한 분부터 적용합니다.</p> : null}
          <input id="booth-starts" type="datetime-local" value={startTime.value} aria-describedby={["booth-time-help", startDescription ? "booth-starts-confirm" : "", timeError ? "booth-time-error" : ""].filter(Boolean).join(" ")}
            aria-invalid={Boolean(timeError) || undefined} onChange={(event) => { setStartTime({ action: "set", value: event.target.value }); setTimeError(""); }} />
          {startDescription ? <p id="booth-starts-confirm">{startTime.action === "set" ? "변경할 시간" : "화면에 표시된 시간"}: {startDescription}</p> : null}
          {initial?.startsAt || startTime.value || startTime.action !== "keep" ? <ProductButton type="button" className="button button-quiet" onClick={() => { setStartTime({ action: "clear", value: "" }); setTimeError(""); }}>시작 시간 지우기</ProductButton> : null}
          {startTime.action === "clear" ? <p role="status">저장하면 시작 시간 제한을 지웁니다.</p> : null}
        </div>
        <div>
          <label htmlFor="booth-ends">종료 시간 (선택)</label>
          {initial?.endsAt && boothTimeNeedsReview(initial.endsAt) ? <p>저장된 종료: {boothTimeLabel(initial.endsAt)}. 새 값을 입력하거나 지우기 전에는 그대로 유지됩니다.</p> : null}
          {storedEnd !== null && Number.isFinite(storedEnd) && storedEnd % 60000 !== 0 ? <p>저장된 종료에는 초 단위가 있습니다. 수정하지 않으면 그대로 유지하고, 수정하면 입력한 분부터 적용합니다.</p> : null}
          <input id="booth-ends" type="datetime-local" value={endTime.value} aria-describedby={["booth-time-help", endDescription ? "booth-ends-confirm" : "", timeError ? "booth-time-error" : ""].filter(Boolean).join(" ")}
            aria-invalid={Boolean(timeError) || undefined} onChange={(event) => { setEndTime({ action: "set", value: event.target.value }); setTimeError(""); }} />
          {endDescription ? <p id="booth-ends-confirm">{endTime.action === "set" ? "변경할 시간" : "화면에 표시된 시간"}: {endDescription}</p> : null}
          {initial?.endsAt || endTime.value || endTime.action !== "keep" ? <ProductButton type="button" className="button button-quiet" onClick={() => { setEndTime({ action: "clear", value: "" }); setTimeError(""); }}>종료 시간 지우기</ProductButton> : null}
          {endTime.action === "clear" ? <p role="status">저장하면 종료 시간 제한을 지웁니다.</p> : null}
        </div>
        {timeError ? <p id="booth-time-error" role="alert">{timeError}</p> : null}
        </fieldset>
        <DialogError failure={failure} id="booth-dialog-error" />
        {recovery}
        <ConsoleFormActions>
          <ProductButton type="button" className="button button-secondary" onClick={() => { if (canClose()) onClose(); }} disabled={busy}>
            취소
          </ProductButton>
          <ProductButton type="submit" className="button button-primary" disabled={busy || blocked || Boolean(conflict) || !name.trim()}>
            {busy ? "저장 중입니다" : "부스 저장"}
          </ProductButton>
        </ConsoleFormActions>
      </ValidatedForm>
    </ConsoleDialog>
  );
}

function AssignDialog({
  busy,
  blocked,
  recovery,
  failure,
  staffAccounts,
  desks,
  booths,
  initialType,
  initialTargetId,
  initialAccountId,
  onClose,
  onSubmit,
  onDirtyChange,
}: {
  busy: boolean;
  blocked: boolean;
  recovery: ReactNode;
  failure: Failure | null;
  staffAccounts: Account[];
  desks: Desk[];
  booths: Booth[];
  initialType: string;
  initialTargetId?: string;
  initialAccountId?: string;
  onClose: () => void;
  onSubmit: (payload: Record<string, unknown>) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [accountId, setAccountId] = useState(initialAccountId ?? "");
  const [type, setType] = useState(initialType);
  // Row-level opens preselect their target, team handoffs preselect their
  // person; the dialog never submits on its
  // own, so the operator still picks staff and confirms. The pristine preset
  // (no staff chosen yet) is not dirty, keeping the canClose gate truthful.
  const [targetId, setTargetId] = useState(initialTargetId ?? "");
  const dirty = accountId !== (initialAccountId ?? "") || type !== initialType || targetId !== (initialTargetId ?? "");
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const canClose = () => {
    if (!dirty && !blocked) return true;
    return window.confirm(blocked ? "처리 결과를 아직 확인하지 못했습니다. 닫아도 서버 처리는 취소되지 않으며 원래 요청은 유지됩니다. 닫을까요?" : "작성 중인 내용이 사라집니다. 닫을까요?");
  };
  const targets = type === "DESK" ? desks : booths;
  const currentTarget = targets.some((target) => target.id === targetId) ? targetId : "";
  // A preset target can go stale while the dialog is open (deleted desk or
  // booth, or booths hidden after the feature switch): the save button would
  // only sit disabled with no reason, so the mismatch reads out loud.
  const targetStale = targetId !== "" && currentTarget === "";
  return (
    <ConsoleDialog title="스태프 배정" onClose={onClose} busy={busy} canClose={canClose}>
      <ValidatedForm
        className={uiStyles.formStack}
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit({ accountId, type, targetId: currentTarget });
        }}
      >
        <fieldset className={styles.dialogFields} disabled={blocked || busy}>
        <legend className="sr-only">스태프 배정 정보</legend>
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
              <ProductLink href="/console/team">팀·권한에서 현장 스태프 초대</ProductLink>하면
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
                {"action" in target ? ` · ${DESK_ACTION_LABEL[target.action || ""] ?? "방향 확인 필요"}` : ""}
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
        </fieldset>
        <DialogError failure={failure} id="assign-dialog-error" />
        {recovery}
        <ConsoleFormActions>
          <ProductButton type="button" className="button button-secondary" onClick={() => { if (canClose()) onClose(); }} disabled={busy}>
            취소
          </ProductButton>
          <ProductButton
            type="submit"
            className="button button-primary"
            disabled={busy || blocked || !accountId || !currentTarget}
          >
            {busy ? "배정 중입니다" : "배정 저장"}
          </ProductButton>
        </ConsoleFormActions>
      </ValidatedForm>
    </ConsoleDialog>
  );
}
