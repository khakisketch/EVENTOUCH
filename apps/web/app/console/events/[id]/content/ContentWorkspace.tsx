"use client";

import ValidatedForm from "../../../../ui/ValidatedForm";


import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import PublicationReview, { type PublicationChange, type PublicationDestination } from "../../../console-ui/PublicationReview";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import ConsoleSectionNav from "../../../console-ui/ConsoleSectionNav";
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./content.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsContentCommand, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import { normalizeHomeMenus } from "../../../../../lib/attendee-home-menus";
import { canWriteEvent } from "../../../../../lib/event-capabilities";

// Console authoring for notices, schedule programs, and venue guidance.
// Reads the operator bootstrap; every write goes through the idempotent
// event command path (server/commands/preparation.js stays authoritative on
// field names, limits, and the venue feature gate). Published items alone
// reach the public event page, so each section manages its own publish flag.

// Mirrors server/commands/preparation.js saveNotice.
const NOTICE_TITLE_MAX = 100;
const NOTICE_BODY_MAX = 3000;

// Mirrors server/commands/preparation.js saveProgram.
const PROGRAM_TITLE_MAX = 100;
const PROGRAM_PLACE_MAX = 160;
const PROGRAM_DESCRIPTION_MAX = 4000;

// Mirrors server/commands/preparation.js saveProgram attachment rules.
const PROGRAM_ATTACHMENT_TYPES = ["application/pdf"];
const PROGRAM_ATTACHMENT_MAX_BYTES = 600000;

// Mirrors server/commands/preparation.js saveVenue clean() limits.
const VENUE_LIMITS = { name: 100, address: 200, directions: 400, contact: 120, description: 400 };
const VENUE_MAP_MAX_BYTES = 500000;

type Attachment = { fileId: string; name: string };

type Notice = {
  id: string;
  title: string;
  body: string;
  published: boolean;
  pinned: boolean;
  at: string;
  version: number;
  draft: { title: string; body: string; pinned: boolean };
};

type ProgramItem = {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  place: string;
  description: string;
  published: boolean;
  attachment: Attachment | null;
  version: number;
  draft: { title: string; date: string; start: string; end: string; place: string; description: string; attachment: Attachment | null };
};

type Venue = {
  name: string;
  address: string;
  directions: string;
  contact: string;
  description: string;
  map: { image: Attachment | null; alt: string } | null;
};

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      slug: string;
      publishedPage: Record<string, unknown>;
      stage: string;
      eventMeta: ConsoleEventMeta;
      features: string[];
      role: string;
      userId: string;
      memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
      notices: Notice[];
      program: ProgramItem[];
      venue: Venue & { draft: Venue; version: number };
      screenEnabled: boolean;
      display: { type: string; noticeId: string };
    };

type Failure = { message: string; field: string | null };
type PublicationKind = "notice" | "program" | "venue";
type PublicationDestinations = { slug: string; public: boolean; home?: boolean; screen?: "off" | "available" | "selected" };
type ReadyWorkspace = Extract<WorkspaceState, { kind: "ready" }>;

function publicationDestinations(state: ReadyWorkspace, kind: PublicationKind, id: string): PublicationDestinations {
  if (kind === "notice") {
    const visible = state.publishedPage.showAnnouncements !== false;
    return { slug: state.slug, public: visible, home: visible && !normalizeHomeMenus(state.publishedPage.homeMenus).hidden.includes("notice"),
      screen: !state.screenEnabled ? "off" : state.display.type === "notice" && state.display.noticeId === id ? "selected" : "available" };
  }
  return { slug: state.slug, public: kind === "program" ? state.publishedPage.showPrograms !== false
    : state.features.includes("venue") && state.publishedPage.showVenue !== false };
}

function samePublicationDestinations(left: PublicationDestinations, right: PublicationDestinations): boolean {
  return left.slug === right.slug && left.public === right.public && left.home === right.home && left.screen === right.screen;
}
type ContentAttempt = {
  eventId: string;
  command: string;
  payload: Record<string, unknown>;
  fingerprint: string;
  commandId: string;
  origin: "notice" | "program" | "row";
  uncertain: boolean;
};

type NoticeDraft = {
  id: string;
  version: number;
  title: string;
  body: string;
  published: boolean;
  pinned: boolean;
};

type ProgramDraft = {
  id: string;
  version: number;
  title: string;
  date: string;
  start: string;
  end: string;
  place: string;
  description: string;
  published: boolean;
  attachment: Attachment | null;
  attachmentDirty: boolean;
};

const EMPTY_NOTICE_DRAFT: NoticeDraft = {
  id: "",
  version: 0,
  title: "",
  body: "",
  published: false,
  pinned: false,
};

const EMPTY_PROGRAM_DRAFT: ProgramDraft = {
  id: "",
  version: 0,
  title: "",
  date: "",
  start: "",
  end: "",
  place: "",
  description: "",
  published: false,
  attachment: null,
  attachmentDirty: false,
};

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentVersion(value: Record<string, unknown> | null): number {
  return Number.isSafeInteger(value?.version) && Number(value?.version) >= 0 ? Number(value?.version) : 0;
}

function parseNotice(value: unknown): Notice | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  if (typeof item.title !== "string") return null;
  return {
    id: item.id,
    title: item.title,
    body: text(item.body),
    published: item.published === true,
    pinned: item.pinned === true,
    at: text(item.at),
    version: contentVersion(item),
    draft: { title: text(asRecord(item.draft)?.title, item.title), body: text(asRecord(item.draft)?.body, text(item.body)), pinned: (asRecord(item.draft) ?? item).pinned === true },
  };
}

function parseAttachment(value: unknown): Attachment | null {
  const item = asRecord(value);
  if (!item || typeof item.fileId !== "string" || !item.fileId) return null;
  return { fileId: item.fileId, name: text(item.name) };
}

function parseProgram(value: unknown): ProgramItem | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  if (typeof item.title !== "string") return null;
  return {
    id: item.id,
    title: item.title,
    date: text(item.date),
    start: text(item.start),
    end: text(item.end),
    place: text(item.place),
    description: text(item.description),
    published: item.published === true,
    attachment: parseAttachment(item.attachment),
    version: contentVersion(item),
    draft: (() => { const d = asRecord(item.draft) ?? item; return { title: text(d.title), date: text(d.date), start: text(d.start), end: text(d.end), place: text(d.place), description: text(d.description), attachment: parseAttachment(d.attachment) }; })(),
  };
}

function parseVenue(value: unknown): Venue {
  const item = asRecord(value) ?? {};
  const map = asRecord(item.map);
  const image = asRecord(map?.image);
  const fileId = text(image?.fileId);
  return {
    name: text(item.name),
    address: text(item.address),
    directions: text(item.directions),
    contact: text(item.contact),
    description: text(item.description),
    map: map && fileId ? { image: { fileId, name: text(image?.name, "행사장 안내도") }, alt: text(map.alt) } : null,
  };
}

function noticeChanges(item: Notice, publish = true): PublicationChange[] {
  const next = publish ? item.draft : item;
  return [
    { label: "공개 상태", before: item.published ? "게시 중" : "비공개", after: publish ? "게시 중" : "비공개" },
    { label: "제목", before: item.published ? item.title : "", after: publish ? next.title : "참가자에게 보이지 않음" },
    { label: "내용", before: item.published ? item.body : "", after: publish ? next.body : "참가자에게 보이지 않음" },
    { label: "상단 고정", before: item.published && item.pinned ? "고정" : "고정 안 함", after: !publish ? "비공개 (설정 유지)" : next.pinned ? "고정" : "고정 안 함" },
  ];
}

function programChanges(item: ProgramItem, publish = true): PublicationChange[] {
  const next = publish ? item.draft : item;
  const fields = [
    ["제목", item.title, next.title],
    ["일정", `${item.date} ${item.start}–${item.end}`, `${next.date} ${next.start}–${next.end}`],
    ["장소", item.place, next.place], ["내용", item.description, next.description],
    ["첨부 자료", item.attachment?.name || (item.attachment ? "PDF 자료" : ""),
      (next.attachment?.name || (next.attachment ? "PDF 자료" : "")) + (item.attachment && next.attachment && item.attachment.fileId !== next.attachment.fileId ? " (교체)" : "")],
  ];
  return [{ label: "공개 상태", before: item.published ? "게시 중" : "비공개", after: publish ? "게시 중" : "비공개" },
    ...fields.map(([label, before, after]) => ({ label, before: item.published ? before : "", after: publish ? after : "참가자에게 보이지 않음" }))];
}

function venueChanges(item: Venue & { draft: Venue }): PublicationChange[] {
  return [
    ...([["장소 이름", "name"], ["주소", "address"], ["길찾기", "directions"], ["문의", "contact"], ["안내 문구", "description"]] as const)
      .map(([label, key]) => ({ label, before: item[key], after: item.draft[key] })),
    { label: "안내도", before: item.map ? `${item.map.image?.name || "안내도 이미지"}\n${item.map.alt}` : "",
      after: item.draft.map ? `${item.draft.map.image?.name || "안내도 이미지"}${item.map && item.map.image?.fileId !== item.draft.map.image?.fileId ? " (교체)" : ""}\n${item.draft.map.alt}` : "" },
  ];
}

function hasChanges(changes: PublicationChange[]): boolean {
  return changes.some(change => change.before !== change.after);
}

function sameVenueText(left: Venue, right: Venue): boolean {
  return (["name", "address", "directions", "contact", "description"] as const).every(key => left[key] === right[key]);
}

class CommandFailure extends Error {
  field: string | null;

  constructor(failure: Failure) {
    super(failure.message);
    this.field = failure.field;
  }
}

export default function ContentWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [noticeDialogOpen, setNoticeDialogOpen] = useState(false);
  const [noticeDraft, setNoticeDraft] = useState<NoticeDraft>(EMPTY_NOTICE_DRAFT);
  const [noticeDialogFailure, setNoticeDialogFailure] = useState<Failure | null>(null);
  const [noticeDialogBusy, setNoticeDialogBusy] = useState(false);

  const [programDialogOpen, setProgramDialogOpen] = useState(false);
  const [programDraft, setProgramDraft] = useState<ProgramDraft>(EMPTY_PROGRAM_DRAFT);
  const [programDialogFailure, setProgramDialogFailure] = useState<Failure | null>(null);
  const [programDialogBusy, setProgramDialogBusy] = useState(false);
  const [uploadingAttachment, setUploadingAttachment] = useState(false);
  const [programUploadUncertain, setProgramUploadUncertain] = useState(false);
  const [programUploadAbandonConfirm, setProgramUploadAbandonConfirm] = useState(false);
  const programUploadRef = useRef<{ eventId: string; file: File; commandId: string; uncertain: boolean } | null>(null);
  const programUploadGateRef = useRef(false);
  const [pendingContent, setPendingContent] = useState<ContentAttempt | null>(null);
  const pendingContentRef = useRef<ContentAttempt | null>(null);
  const activeEventRef = useRef(eventId);
  activeEventRef.current = eventId;
  const [checkingContent, setCheckingContent] = useState(false);
  const [abandonContentConfirm, setAbandonContentConfirm] = useState(false);
  const [contentRecoveryError, setContentRecoveryError] = useState<string | null>(null);
  const otherContentReceipt = useEventReceipts(eventId).some((item) =>
    ["notice.save", "program.save", "venue.save", "notice.publish", "program.publish", "venue.publish", "notice.publish-reviewed", "program.publish-reviewed", "venue.publish-reviewed"].includes(item.command) && item.commandId !== pendingContentRef.current?.commandId);
  useEffect(() => {
    if (!pendingContent || pendingContent.eventId !== eventId) return;
    return manageOperatorReceipt(pendingContent.commandId);
  }, [eventId, pendingContent]);

  const [publication, setPublication] = useState<{ kind: PublicationKind; id: string; version: number; published: boolean; destinations: PublicationDestinations } | null>(null);
  const [publicationError, setPublicationError] = useState<string | null>(null);
  const [publicationConflict, setPublicationConflict] = useState(false);
  const venueDraftVersionRef = useRef(0);
  const [venueDraft, setVenueDraft] = useState<Venue | null>(null);
  const [venueFile, setVenueFile] = useState<File | null>(null);
  const [venuePreview, setVenuePreview] = useState<string | null>(null);
  const [venueUploadUncertain, setVenueUploadUncertain] = useState(false);
  const [venueUploadAbandonConfirm, setVenueUploadAbandonConfirm] = useState(false);
  const [venueRestoreConfirm, setVenueRestoreConfirm] = useState(false);
  const venueUploadRef = useRef<{ file: File; commandId: string; attempts: number } | null>(null);
  const venueSaveGateRef = useRef(false);
  const mapTouchedRef = useRef(false);
  const mapEditBaselineRef = useRef<{ fileId: string; alt: string } | null>(null);

  useEffect(() => {
    if (!venueFile) { setVenuePreview(null); return; }
    const url = URL.createObjectURL(venueFile);
    setVenuePreview(url);
    return () => URL.revokeObjectURL(url);
  }, [venueFile]);

  // In-place confirmations for the irreversible deletes (one open at a time,
  // holding only the target id). Dialog dismissal gates stay on
  // window.confirm via canCloseNoticeDialog/canCloseProgramDialog.
  const [noticeDeletePendingId, setNoticeDeletePendingId] = useState<string | null>(null);
  const [programDeletePendingId, setProgramDeletePendingId] = useState<string | null>(null);
  // Direct output of a published notice to the venue screen (UI only): holds
  // only the target id while the shared ConsoleConfirm asks once. The actual
  // write reuses postCommand("display.set") with the same idempotency and
  // busy discipline as every other command here.
  const [noticeDisplayPendingId, setNoticeDisplayPendingId] = useState<string | null>(null);

  // One idempotency id per command+payload fingerprint. Payload literals are
  // rebuilt identically on retry, so the same logical write reuses its id;
  // any edit fingerprints differently and takes a fresh id. Entries clear
  // only on success; ambiguous or rejected responses keep them harmlessly
  // (a corrected payload is a new fingerprint). Toggles and deletes
  // overwrite by id, so a same-payload replay converges instead of doubling.
  const commandIdCache = useRef(new Map<string, string>());
  // Synchronous in-flight gate: state flags flip only after rerender, so
  // same-turn double submits would overlap without this ref.
  const commandBusyRef = useRef(false);
  // Dirty-dismiss baselines: dialog snapshots for canClose, server baseline
  // for the venue draft so silent reloads never wipe unsaved edits.
  const noticeInitialRef = useRef<NoticeDraft>(EMPTY_NOTICE_DRAFT);
  const programInitialRef = useRef<ProgramDraft>(EMPTY_PROGRAM_DRAFT);
  const venueBaselineRef = useRef<Venue | null>(null);

  async function load(silent = false, adoptVenue = false): Promise<boolean> {
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        consoleFetch("/api/auth/me", { cache: "no-store" }),
        consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
      ]);
      if (activeEventRef.current !== eventId) return false;
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(loginHrefForLocation(window.location.pathname, window.location.search));
        return false;
      }
      const me = (await meRes.json().catch(() => null)) as {
        user?: { id?: unknown; role?: unknown } | null;
      } | null;
      const boot = (await bootRes.json().catch(() => null)) as {
        state?: {
          events?: unknown;
          clients?: unknown;
          memberships?: unknown;
          workspaces?: Record<string, unknown>;
        } | null;
      } | null;
      if (activeEventRef.current !== eventId) return false;
      const bootstrap = boot?.state;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        if (!silent) setState({ kind: "failed", message: "콘텐츠 정보를 불러오지 못했습니다." });
        else setFailure({ message: "최신 콘텐츠를 불러오지 못했습니다. 다시 확인하세요.", field: null });
        return false;
      }
      const role = typeof me.user.role === "string" ? me.user.role : "";
      const myId = typeof me.user.id === "string" ? me.user.id : "";
      // Raw membership grants ride along untouched: omitted write reads as
      // full access, an explicit [] as read-only. Gates below re-check per
      // section (notice.save for 공지·장소, program.save for 일정) through
      // the capability helper; server/event-permissions.js stays authoritative.
      const memberships: Array<{ accountId: string; eventId: string; write?: unknown }> = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((item) => {
            const membership = asRecord(item);
            if (!membership || typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
            return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
          })
        : [];
      const event = Array.isArray(bootstrap.events)
        ? bootstrap.events.flatMap((item) => {
            const record = asRecord(item);
            return record && record.id === eventId ? [record] : [];
          })[0]
        : undefined;
      const workspace = asRecord(bootstrap.workspaces?.[eventId]);
      if (!event || !workspace) {
        if (!silent) setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        else setFailure({ message: "최신 행사 정보를 확인하지 못했습니다. 다시 확인하세요.", field: null });
        return false;
      }
      if (!Array.isArray(workspace.notices) || !Array.isArray(workspace.program) || !asRecord(workspace.venue)) {
        if (!silent) setState({ kind: "failed", message: "콘텐츠 정보가 불완전합니다. 다시 불러오세요." });
        else setFailure({ message: "최신 콘텐츠 정보가 불완전합니다. 다시 확인하세요.", field: null });
        return false;
      }
      const notices = Array.isArray(workspace.notices)
        ? workspace.notices.flatMap((value) => {
            const parsed = parseNotice(value);
            return parsed ? [parsed] : [];
          })
        : [];
      // The server keeps program sorted by date+start; mirror it so the
      // console reads in the same order attendees see.
      const program = (Array.isArray(workspace.program)
        ? workspace.program.flatMap((value) => {
            const parsed = parseProgram(value);
            return parsed ? [parsed] : [];
          })
        : []).sort((left, right) => (left.date + left.start).localeCompare(right.date + right.start));
      const venueRecord = asRecord(workspace.venue);
      const venue = { ...parseVenue(venueRecord), draft: parseVenue(asRecord(venueRecord?.draft) ?? venueRecord), version: contentVersion(venueRecord) };
      const features = Array.isArray(event.features)
        ? event.features.filter((feature): feature is string => typeof feature === "string")
        : [];
      const displayRecord = asRecord(workspace.display);
      const display = {
        type: typeof displayRecord?.type === "string" ? String(displayRecord.type) : "idle",
        noticeId: typeof displayRecord?.noticeId === "string" ? String(displayRecord.noticeId) : "",
      };
      const client = Array.isArray(bootstrap.clients)
        ? bootstrap.clients.map(asRecord).find((item) => item?.id === event.clientId)
        : undefined;
      setState({
        kind: "ready",
        eventName: text(event.name, eventId),
        slug: text(event.slug),
        publishedPage: asRecord(asRecord(workspace.pageExperience)?.published) ?? {},
        stage: text(event.stage).toUpperCase(),
        eventMeta: {
          clientName: text(client?.name),
          date: text(event.date),
          start: text(event.start),
          end: text(event.end),
          venue: venue.name || text(event.venue),
        },
        features,
        role,
        userId: myId,
        memberships,
        notices,
        program,
        venue,
        screenEnabled: features.includes("screen"),
        display,
      });
      // An accepted canonical refresh invalidates a pending output intent: a
      // notice edited or unpublished-then-republished underneath would
      // otherwise leave a confirm against changed state. Failed loads keep
      // the pending confirm so the operator can still retry it.
      setNoticeDisplayPendingId(null);
      setVenueDraft((current) => {
        // Preserve an independently dirty venue draft across silent reloads
        // (e.g. a notice publish refreshing state must not wipe typed input).
        const baseline = venueBaselineRef.current;
        if (!adoptVenue && current && baseline && JSON.stringify(current) !== JSON.stringify(baseline)) {
          // Rebase an untouched map only when the remote text is unchanged.
          // Concurrent text edits keep their original revision and conflict
          // rather than silently overwriting the other operator's work.
          if (!mapTouchedRef.current && sameVenueText(baseline, venue.draft)) {
            venueBaselineRef.current = venue.draft;
            venueDraftVersionRef.current = venue.version;
            return { ...current, map: venue.draft.map };
          }
          return current;
        }
        venueBaselineRef.current = venue.draft;
        venueDraftVersionRef.current = venue.version;
        return venue.draft;
      });
      return true;
    } catch {
      if (activeEventRef.current !== eventId) return false;
      if (!silent) setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      else setFailure({ message: "최신 콘텐츠를 불러오지 못했습니다. 다시 확인하세요.", field: null });
      return false;
    }
  }

  useEffect(() => {
    setPublication(null);
    setPublicationError(null); setPublicationConflict(false);
    setNoticeDialogOpen(false);
    setProgramDialogOpen(false);
    setVenueDraft(null);
    venueBaselineRef.current = null;
    venueDraftVersionRef.current = 0;
    mapTouchedRef.current = false;
    mapEditBaselineRef.current = null;
    venueUploadRef.current = null;
    setVenueFile(null);
    setVenueUploadUncertain(false);
    setVenueRestoreConfirm(false);
    setFailure(null);
    setNotice(null);
    if (pendingContentRef.current && pendingContentRef.current.eventId !== eventId) {
      pendingContentRef.current = null;
      setPendingContent(null);
      setContentRecoveryError(null);
      setAbandonContentConfirm(false);
      commandIdCache.current.clear();
    }
    if (programUploadRef.current && programUploadRef.current.eventId !== eventId) {
      programUploadRef.current = null;
      setProgramUploadUncertain(false);
      setProgramUploadAbandonConfirm(false);
      setUploadingAttachment(false);
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  const hadOtherContentReceipt = useRef(false);
  useEffect(() => {
    if (hadOtherContentReceipt.current && !otherContentReceipt && !pendingContentRef.current) void load(true);
    hadOtherContentReceipt.current = otherContentReceipt && !commandBusyRef.current;
    // The scoped receipt's removal requires a fresh canonical list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId, otherContentReceipt]);

  // Draft-guard dirty state, evaluated before every early return below. True
  // diffs against the dialog open-snapshots and the venue server baseline
  // (not merely open dialogs), plus in-flight uploads. Clean post-save
  // screens navigate without a confirm.
  const noticeDialogDirty =
    noticeDialogOpen &&
    JSON.stringify(noticeDraft) !== JSON.stringify(noticeInitialRef.current);
  const programDialogDirty =
    programDialogOpen &&
    JSON.stringify(programDraft) !== JSON.stringify(programInitialRef.current);
  const venueDirty =
    state.kind === "ready" &&
    venueDraft !== null &&
    venueBaselineRef.current !== null &&
    JSON.stringify(venueDraft) !== JSON.stringify(venueBaselineRef.current);
  useConsoleDraftGuard(
    noticeDialogDirty || programDialogDirty || venueDirty || uploadingAttachment || programUploadUncertain || Boolean(venueFile) || venueUploadUncertain || Boolean(pendingContent),
    pendingContent || programUploadUncertain
      ? "저장 또는 업로드가 이미 처리됐을 수 있습니다. 화면을 떠나면 원래 입력과 파일은 복원되지 않습니다."
      : "작성 중인 콘텐츠나 저장하지 않은 장소 안내가 있습니다. 페이지를 떠나면 사라집니다."
  );

  async function postCommand(command: string, payload: Record<string, unknown>, validate?: (data: Record<string, unknown> | null) => boolean, origin: ContentAttempt["origin"] = "row"): Promise<Record<string, unknown>> {
    if (archived) {
      throw new CommandFailure({ message: "보관된 행사는 읽기 전용입니다.", field: null });
    }
    if (commandBusyRef.current) {
      throw new CommandFailure({ message: "처리 중입니다. 잠시 뒤 다시 시도하세요.", field: null });
    }
    commandBusyRef.current = true;
    const fingerprint = `${command}:${JSON.stringify(payload)}`;
    const protectsCreate = ["notice.save", "program.save", "venue.save", "notice.publish", "program.publish", "venue.publish", "notice.publish-reviewed", "program.publish-reviewed", "venue.publish-reviewed"].includes(command);
    const prior = pendingContentRef.current;
    if ((prior && prior.fingerprint !== fingerprint) || (!prior && otherContentReceipt)) {
      commandBusyRef.current = false;
      throw new CommandFailure({ message: "이전 콘텐츠 저장 결과를 먼저 확인하세요.", field: null });
    }
    let commandId = commandIdCache.current.get(fingerprint);
    if (!commandId) {
      commandId = randomCommandId();
      commandIdCache.current.set(fingerprint, commandId);
    }
    const attempt: ContentAttempt = prior ?? { eventId, command, payload: structuredClone(payload), fingerprint, commandId, origin, uncertain: false };
    const markUncertain = () => {
      attempt.uncertain = true;
      if (activeEventRef.current === attempt.eventId) {
        pendingContentRef.current = attempt;
        setPendingContent(attempt);
      }
    };
    if (protectsCreate) { pendingContentRef.current = attempt; setPendingContent(attempt); }
    const releaseDefinitive = () => {
      commandIdCache.current.delete(fingerprint);
      if (activeEventRef.current === attempt.eventId) { pendingContentRef.current = null; setPendingContent(null); }
    };
    try {
      let response: Response;
      try {
        response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId, command, payload }),
        });
      } catch (error) {
        if (protectsCreate && !(isOrganizationContextBlock(error) && !attempt.uncertain)) markUncertain();
        else if (protectsCreate) releaseDefinitive();
        throw new CommandFailure({ message: protectsCreate && attempt.uncertain
          ? "저장 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요."
          : "연결하지 못했습니다. 다시 시도하세요.", field: null });
      }
      const data = (await response.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } & Record<string, unknown> | null;
      if (activeEventRef.current !== attempt.eventId) throw new CommandFailure({ message: "이전 행사에서 시작한 요청입니다. 해당 행사에서 처리 결과를 확인하세요.", field: null });
      if (!response.ok) {
        const uncertain = attempt.uncertain || response.status >= 500 || [408, 425, 429].includes(response.status);
        if (protectsCreate && uncertain) markUncertain();
        else if (protectsCreate) releaseDefinitive();
        throw new CommandFailure({
          message: protectsCreate && uncertain ? "저장 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요."
            : typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : null,
        });
      }
      if ((protectsCreate && !confirmsContentCommand(command, payload, data)) || (validate && !validate(data))) {
        if (protectsCreate) markUncertain();
        throw new CommandFailure({ message: "서버 처리 결과를 확인하지 못했습니다. 같은 내용으로 다시 확인하세요.", field: null });
      }
      if (protectsCreate) {
        if (command === "venue.save") {
          const saved = asRecord(data?.venue);
          const draft = parseVenue(asRecord(saved?.draft) ?? saved);
          venueBaselineRef.current = draft;
          venueDraftVersionRef.current = contentVersion(saved);
          setVenueDraft(draft);
        }
        if (!(await load(true))) {
          markUncertain();
          throw new CommandFailure({ message: "요청은 처리됐지만 최신 내용을 불러오지 못했습니다. 서버 처리 확인으로 다시 확인하세요.", field: null });
        }
      }
      commandIdCache.current.delete(fingerprint);
      if (protectsCreate) {
        if (activeEventRef.current === attempt.eventId) {
          pendingContentRef.current = null;
          setPendingContent(null);
        }
        acknowledgeOperatorReceipt(commandId);
        forgetOperatorReceipt(commandId);
      }
      return data ?? {};
    } finally {
      commandBusyRef.current = false;
    }
  }

  function openNoticeCreate() {
    if (pendingContentRef.current || otherContentReceipt) { setFailure({ message: "이전 콘텐츠 저장 결과를 먼저 확인하세요.", field: null }); return; }
    noticeInitialRef.current = { ...EMPTY_NOTICE_DRAFT };
    setNoticeDraft(EMPTY_NOTICE_DRAFT);
    setNoticeDialogFailure(null);
    setNoticeDialogOpen(true);
  }

  function openNoticeEdit(item: Notice) {
    if (pendingContentRef.current || otherContentReceipt) { setFailure({ message: "이전 콘텐츠 저장 결과를 먼저 확인하세요.", field: null }); return; }
    const snapshot = {
      id: item.id,
      ...item.draft,
      version: item.version,
      published: item.published,
    };
    noticeInitialRef.current = snapshot;
    setNoticeDraft(snapshot);
    setNoticeDialogFailure(null);
    setNoticeDialogOpen(true);
  }

  // Dismissal gate for the shared dialog (Escape/backdrop/Cancel): a dirty
  // draft asks once instead of silently discarding typed input.
  function canCloseNoticeDialog(): boolean {
    if (pendingContentRef.current?.origin === "notice") return window.confirm("저장 결과를 확인하지 못했습니다. 이미 저장되었을 수 있습니다. 확인 전 닫을까요?");
    if (JSON.stringify(noticeDraft) === JSON.stringify(noticeInitialRef.current)) return true;
    return window.confirm("작성 중인 내용이 사라집니다. 닫을까요?");
  }

  async function saveNotice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNoticeDialogFailure(null);
    setNoticeDialogBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: noticeDraft.title,
        body: noticeDraft.body,
        mode: "draft",
        expectedVersion: noticeDraft.version,
        pinned: noticeDraft.pinned,
      };
      if (noticeDraft.id) payload.id = noticeDraft.id;
      await postCommand("notice.save", payload, undefined, "notice");
      setNoticeDialogOpen(false);
      setNotice("공지 초안을 저장했습니다. 게시 검토 후 참가자 화면에 반영할 수 있습니다.");
      setFailure(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장하지 못했습니다.";
      const field = error instanceof CommandFailure ? error.field : null;
      setNoticeDialogFailure({ message, field });
    } finally {
      setNoticeDialogBusy(false);
    }
  }

  function requestNoticeDelete(item: Notice) {
    if (busy !== null || archived) return;
    setNoticeDisplayPendingId(null);
    setNoticeDeletePendingId(item.id);
  }

  async function deleteNotice(item: Notice) {
    setBusy(`notice-delete:${item.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("notice.delete", { id: item.id });
      setNotice("공지를 삭제했습니다.");
      await load(true);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "삭제하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
      setNoticeDeletePendingId(null);
    }
  }

  // Direct output from the authoring row: no auto-publish and no auto-output.
  // The operator picks a published notice here, confirms the external-screen
  // effect in place, and the same display.set path the operations screen uses
  // applies it. Silent reload keeps an independently dirty venue draft.
  // Output and delete confirms stay mutually exclusive: opening one clears
  // the other, and the render guards below never show both on a row. Either
  // write still runs under the shared busy + idempotency gates, so a second
  // apply elsewhere cannot overlap it.
  function requestNoticeDisplay(item: Notice) {
    if (busy !== null || archived) return;
    setNoticeDeletePendingId(null);
    setNoticeDisplayPendingId(item.id);
  }

  async function applyNoticeDisplay(item: Notice) {
    setBusy(`notice-display:${item.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("display.set", { type: "notice", noticeId: item.id });
      setNotice("전광판 출력을 바꿨습니다.");
      await load(true);
      // Own success clears explicitly (load already invalidates on accept);
      // a rejected write keeps the confirm open for retry.
      setNoticeDisplayPendingId(null);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "전광판 출력을 바꾸지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
    }
  }

  function openProgramCreate() {
    if (pendingContentRef.current || otherContentReceipt) { setFailure({ message: "이전 콘텐츠 저장 결과를 먼저 확인하세요.", field: null }); return; }
    programInitialRef.current = { ...EMPTY_PROGRAM_DRAFT };
    setProgramDraft({ ...EMPTY_PROGRAM_DRAFT });
    setProgramDialogFailure(null);
    setProgramDialogOpen(true);
  }

  function openProgramEdit(item: ProgramItem) {
    if (pendingContentRef.current || otherContentReceipt) { setFailure({ message: "이전 콘텐츠 저장 결과를 먼저 확인하세요.", field: null }); return; }
    const snapshot = {
      id: item.id,
      ...item.draft,
      version: item.version,
      published: item.published,
      attachmentDirty: false,
    };
    programInitialRef.current = snapshot;
    setProgramDraft(snapshot);
    setProgramDialogFailure(null);
    setProgramDialogOpen(true);
  }

  function canCloseProgramDialog(): boolean {
    if (uploadingAttachment) return false;
    if (programUploadUncertain) {
      if (!window.confirm("작성 중인 일정과 원래 파일을 잃으며, 업로드가 이미 처리되어 서버에 파일이 남을 수 있습니다. 닫을까요?")) return false;
      if (programUploadRef.current) abandonOperatorAttempt(programUploadRef.current.commandId);
      programUploadRef.current = null;
      setProgramUploadUncertain(false);
      setProgramUploadAbandonConfirm(false);
      return true;
    }
    if (pendingContentRef.current?.origin === "program") return window.confirm("저장 결과를 확인하지 못했습니다. 이미 저장되었을 수 있습니다. 확인 전 닫을까요?");
    if (JSON.stringify(programDraft) === JSON.stringify(programInitialRef.current)) return true;
    return window.confirm("작성 중인 내용이 사라집니다. 닫을까요?");
  }

  async function uploadProgramAttachment(file: File) {
    if (programUploadGateRef.current) return;
    if (!PROGRAM_ATTACHMENT_TYPES.includes(file.type)) {
      setProgramDialogFailure({ message: "일정 자료는 PDF로 올려주세요.", field: "attachment" });
      return;
    }
    if (file.size > PROGRAM_ATTACHMENT_MAX_BYTES) {
      setProgramDialogFailure({ message: "600KB 이하 파일을 올려주세요.", field: "attachment" });
      return;
    }
    const attempt = programUploadRef.current ?? { eventId, file, commandId: randomCommandId(), uncertain: false };
    programUploadRef.current = attempt;
    programUploadGateRef.current = true;
    setUploadingAttachment(true);
    setProgramDialogFailure(null);
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/files?name=${encodeURIComponent(attempt.file.name)}&commandId=${encodeURIComponent(attempt.commandId)}`,
        { method: "POST", headers: { "content-type": attempt.file.type }, body: attempt.file }
      );
      const data = (await res.json().catch(() => null)) as {
        file?: { fileId?: unknown; name?: unknown };
        error?: unknown;
      } | null;
      if (activeEventRef.current !== attempt.eventId) return;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      if (!res.ok || !/^[A-Za-z0-9_-]{1,160}$/.test(fileId)) {
        const definitive = !attempt.uncertain && !res.ok && res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
        if (definitive) programUploadRef.current = null;
        else { attempt.uncertain = true; setProgramUploadUncertain(true); }
        setProgramDialogFailure({
          message: definitive && typeof data?.error === "string" ? data.error : "업로드 결과를 확인하지 못했습니다. 같은 파일 요청을 다시 확인하세요.",
          field: "attachment",
        });
        return;
      }
      programUploadRef.current = null;
      setProgramUploadUncertain(false);
      setProgramUploadAbandonConfirm(false);
      setProgramDraft((current) => ({
        ...current,
        attachment: {
          fileId,
          name: typeof data?.file?.name === "string" ? data.file.name : attempt.file.name,
        },
        attachmentDirty: true,
      }));
    } catch (error) {
      if (activeEventRef.current !== attempt.eventId) return;
      if (isOrganizationContextBlock(error) && !attempt.uncertain) {
        programUploadRef.current = null;
        setProgramDialogFailure({ message: "현재 조직을 확인한 뒤 다시 시도하세요.", field: "attachment" });
      } else {
        attempt.uncertain = true;
        setProgramUploadUncertain(true);
        setProgramDialogFailure({ message: "업로드 결과를 확인하지 못했습니다. 같은 파일 요청을 다시 확인하세요.", field: "attachment" });
      }
    } finally {
      programUploadGateRef.current = false;
      if (activeEventRef.current === attempt.eventId) setUploadingAttachment(false);
    }
  }

  async function saveProgram(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setProgramDialogFailure(null);
    setProgramDialogBusy(true);
    try {
      const payload: Record<string, unknown> = {
        title: programDraft.title,
        date: programDraft.date,
        start: programDraft.start,
        end: programDraft.end,
        place: programDraft.place,
        description: programDraft.description,
        mode: "draft",
        expectedVersion: programDraft.version,
      };
      if (programDraft.id) payload.id = programDraft.id;
      // The server keeps the stored attachment unless the key is present:
      // absent means untouched, null means cleared, { fileId } means replaced.
      if (programDraft.attachmentDirty) {
        payload.attachment = programDraft.attachment
          ? { fileId: programDraft.attachment.fileId }
          : null;
      }
      await postCommand("program.save", payload, undefined, "program");
      setProgramDialogOpen(false);
      setNotice("일정 초안을 저장했습니다. 게시 검토 후 참가자 화면에 반영할 수 있습니다.");
      setFailure(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장하지 못했습니다.";
      const field = error instanceof CommandFailure ? error.field : null;
      setProgramDialogFailure({ message, field });
    } finally {
      setProgramDialogBusy(false);
    }
  }

  function requestProgramDelete(item: ProgramItem) {
    if (busy !== null || archived) return;
    setProgramDeletePendingId(item.id);
  }

  async function deleteProgram(item: ProgramItem) {
    setBusy(`program-delete:${item.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("program.delete", { id: item.id });
      setNotice("일정을 삭제했습니다.");
      await load(true);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "삭제하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
      setProgramDeletePendingId(null);
    }
  }

  async function uploadVenueMap(file: File): Promise<Attachment> {
    const attempt = venueUploadRef.current ?? { file, commandId: randomCommandId(), attempts: 0 };
    venueUploadRef.current = attempt;
    attempt.attempts += 1;
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/files?name=${encodeURIComponent(attempt.file.name)}&commandId=${encodeURIComponent(attempt.commandId)}`, {
        method: "POST", headers: { "content-type": attempt.file.type }, body: attempt.file,
      });
      const data = await response.json().catch(() => null) as { file?: { fileId?: unknown; name?: unknown }; error?: unknown } | null;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      if (!response.ok || !fileId) {
        const definitive = !response.ok && response.status >= 400 && response.status < 500 && ![408, 425, 429].includes(response.status);
        if (definitive && attempt.attempts === 1) {
          venueUploadRef.current = null;
          setVenueUploadUncertain(false);
        } else setVenueUploadUncertain(true);
        throw new CommandFailure({ message: definitive && attempt.attempts === 1 && typeof data?.error === "string"
          ? data.error : "안내도 업로드 결과를 확인하지 못했습니다. 같은 파일로 다시 저장하세요.", field: "map" });
      }
      venueUploadRef.current = null;
      setVenueUploadUncertain(false);
      return { fileId, name: typeof data?.file?.name === "string" ? data.file.name : attempt.file.name };
    } catch (error) {
      if (error instanceof CommandFailure) throw error;
      setVenueUploadUncertain(true);
      throw new CommandFailure({ message: "안내도 업로드 결과를 확인하지 못했습니다. 같은 파일로 다시 저장하세요.", field: "map" });
    }
  }

  function touchVenueMap() {
    setVenueRestoreConfirm(false);
    if (mapTouchedRef.current) return;
    const prior = venueBaselineRef.current?.map;
    mapEditBaselineRef.current = { fileId: prior?.image?.fileId ?? "", alt: prior?.alt ?? "" };
    mapTouchedRef.current = true;
  }

  async function restoreLatestVenueMap() {
    if (busy !== null) return;
    setVenueRestoreConfirm(false);
    setBusy("venue:reload");
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" });
      const data = asRecord(await response.json().catch(() => null));
      const state = asRecord(data?.state);
      const workspaces = asRecord(state?.workspaces);
      const workspace = asRecord(workspaces?.[eventId]);
      if (!response.ok || !workspace) throw new Error("최신 안내도를 불러오지 못했습니다.");
      const venueRecord = asRecord(workspace.venue);
      const latest = parseVenue(asRecord(venueRecord?.draft) ?? venueRecord);
      setVenueDraft((current) => current ? { ...current, map: latest.map } : current);
      if (venueBaselineRef.current) {
        if (sameVenueText(venueBaselineRef.current, latest)) venueDraftVersionRef.current = contentVersion(venueRecord);
        venueBaselineRef.current = { ...venueBaselineRef.current, map: latest.map };
      }
      setVenueFile(null);
      venueUploadRef.current = null;
      setVenueUploadUncertain(false);
      mapTouchedRef.current = false;
      mapEditBaselineRef.current = null;
      setFailure(null);
      setNotice("최신 안내도를 불러왔습니다. 다른 장소 문구는 유지했습니다.");
    } catch {
      setFailure({ message: "다른 운영자가 변경한 최신 안내도를 불러오지 못했습니다. 연결을 확인하고 다시 시도하세요.", field: "map" });
    } finally { setBusy(null); }
  }

  function abandonVenueUpload() {
    if (busy !== null) return;
    const attempt = venueUploadRef.current;
    if (attempt) abandonOperatorAttempt(attempt.commandId);
    venueUploadRef.current = null;
    setVenueUploadUncertain(false);
    setVenueUploadAbandonConfirm(false);
    setVenueFile(null);
    mapTouchedRef.current = false;
    mapEditBaselineRef.current = null;
    setVenueDraft((current) => current ? { ...current, map: venueBaselineRef.current?.map ?? null } : current);
  }

  async function saveVenue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!venueDraft || venueSaveGateRef.current) return;
    if (venueDraft.map && !venueDraft.map.alt.trim()) {
      setFailure({ message: "안내도에 대한 설명을 입력하세요.", field: "mapAlt" });
      document.getElementById("content-venue-map-alt")?.focus();
      return;
    }
    venueSaveGateRef.current = true;
    setVenueUploadAbandonConfirm(false);
    setVenueRestoreConfirm(false);
    setBusy("venue:save");
    setNotice(null);
    setFailure(null);
    try {
      const snapshot = structuredClone(venueDraft);
      const baseline = venueBaselineRef.current;
      const mapChanged = mapTouchedRef.current || Boolean(venueFile);
      if (venueFile) {
        const image = await uploadVenueMap(venueFile);
        snapshot.map = { image, alt: snapshot.map?.alt ?? "" };
        setVenueDraft((current) => current ? { ...current, map: { image, alt: current.map?.alt ?? snapshot.map!.alt } } : current);
        setVenueFile(null);
      }
      const { map, ...details } = snapshot;
      const expectedMap = mapEditBaselineRef.current ?? { fileId: baseline?.map?.image?.fileId ?? "", alt: baseline?.map?.alt ?? "" };
      const payload = { ...details, mode: "draft", expectedVersion: venueDraftVersionRef.current, ...(mapChanged ? { map, expectedMap } : {}) };
      const validate = (data: Record<string, unknown> | null) => {
        const saved = asRecord(asRecord(data?.venue)?.draft);
        if (!saved || Object.entries(details).some(([key, value]) => saved[key] !== value.trim())) return false;
        if (!mapChanged) return true;
        if (!map) return !saved.map;
        const savedMap = asRecord(saved.map);
        return asRecord(savedMap?.image)?.fileId === map.image?.fileId && savedMap?.alt === map.alt.trim();
      };
      try {
        await postCommand("venue.save", payload, validate);
      } catch (error) {
        // A definitive stale revision may come from an unrelated map edit.
        // Rebase only that untouched asset, only if no remote text changed,
        // and retry once under the newer revision. Uncertain writes never
        // enter this path and retain their original command id.
        if (!(error instanceof CommandFailure) || error.field !== "expectedVersion" || mapChanged || !baseline || pendingContentRef.current) throw error;
        const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" });
        const data = asRecord(await response.json().catch(() => null));
        const latest = asRecord(asRecord(asRecord(asRecord(data?.state)?.workspaces)?.[eventId])?.venue);
        const latestDraft = parseVenue(asRecord(latest?.draft) ?? latest);
        if (!response.ok || !latest || !sameVenueText(baseline, latestDraft)) throw error;
        await postCommand("venue.save", { ...payload, expectedVersion: contentVersion(latest) }, validate);
      }
      if (mapChanged) { mapTouchedRef.current = false; mapEditBaselineRef.current = null; }
      setNotice("장소 안내 초안을 저장했습니다. 게시 검토 후 참가자 화면에 반영할 수 있습니다.");
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "저장하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      venueSaveGateRef.current = false;
      setBusy(null);
    }
  }

  async function reloadEditorDraft(kind: "notice" | "program" | "venue") {
    if (busy !== null || pendingContentRef.current || otherContentReceipt || !window.confirm("작성 중인 변경을 버리고 다른 운영자가 저장한 최신 초안을 불러올까요?")) return;
    setBusy("draft:reload");
    if (kind === "notice") setNoticeDialogBusy(true);
    if (kind === "program") setProgramDialogBusy(true);
    try {
      if (kind === "venue") {
        if (!(await load(true, true))) throw new Error("최신 초안을 불러오지 못했습니다.");
      } else {
        const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" });
        const data = asRecord(await response.json().catch(() => null));
        const workspace = asRecord(asRecord(asRecord(data?.state)?.workspaces)?.[eventId]);
        const items = workspace?.[kind === "notice" ? "notices" : "program"];
        const id = kind === "notice" ? noticeDraft.id : programDraft.id;
        const raw = Array.isArray(items) ? items.find(item => asRecord(item)?.id === id) : null;
        if (!response.ok || !raw) throw new Error("최신 초안을 찾을 수 없습니다. 목록을 다시 확인하세요.");
        if (kind === "notice") { const item = parseNotice(raw); if (!item) throw new Error("공지 형식을 확인하지 못했습니다."); openNoticeEdit(item); }
        else { const item = parseProgram(raw); if (!item) throw new Error("일정 형식을 확인하지 못했습니다."); openProgramEdit(item); }
        await load(true);
      }
      setFailure(null);
    } catch (error) {
      const failure = { message: error instanceof Error ? error.message : "최신 초안을 불러오지 못했습니다.", field: null };
      if (kind === "notice") setNoticeDialogFailure(failure);
      else if (kind === "program") setProgramDialogFailure(failure);
      else setFailure(failure);
    } finally {
      setBusy(null);
      if (kind === "notice") setNoticeDialogBusy(false);
      if (kind === "program") setProgramDialogBusy(false);
    }
  }

  async function resolveContentAttempt(mode: "status" | "retry") {
    const attempt = pendingContentRef.current;
    if (!attempt || attempt.eventId !== eventId || checkingContent || commandBusyRef.current) return;
    setCheckingContent(true);
    setContentRecoveryError(null);
    try {
      if (mode === "status") {
        const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
        const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
        if (activeEventRef.current !== attempt.eventId) return;
        if (response.ok && data?.status === "UNCONFIRMED") {
          setContentRecoveryError("아직 저장 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요.");
          return;
        }
        if (!response.ok || data?.status !== "APPLIED" || data.command !== attempt.command) {
          setContentRecoveryError(response.status >= 500 || [425, 429].includes(response.status)
            ? "일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요."
            : "처리 결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
          return;
        }
        if (!(await load(true, attempt.command === "venue.save"))) throw new Error("처리는 확인됐지만 최신 콘텐츠를 불러오지 못했습니다. 다시 확인하세요.");
        commandIdCache.current.delete(attempt.fingerprint);
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        pendingContentRef.current = null;
        setPendingContent(null);
      } else {
        await postCommand(attempt.command, attempt.payload, undefined, attempt.origin);
      }
      if (activeEventRef.current !== attempt.eventId) return;
      if (attempt.origin === "notice") setNoticeDialogOpen(false);
      if (attempt.origin === "program") setProgramDialogOpen(false);
      setNoticeDialogFailure(null);
      setProgramDialogFailure(null);
      setFailure(null);
      setNotice("콘텐츠 변경이 반영된 것을 확인했습니다. 최신 목록을 확인하세요.");
      setPublication(null);
    } catch (error) {
      setContentRecoveryError(error instanceof Error ? error.message : "처리 결과를 확인하지 못했습니다.");
    } finally { setCheckingContent(false); }
  }

  function contentRecovery() {
    if (!pendingContent?.uncertain) return null;
    return (
      <section aria-labelledby="content-recovery-heading" className={styles.recovery}>
        <h2 id="content-recovery-heading">콘텐츠 저장 확인 필요</h2>
        <p>이전 저장이 반영됐을 수 있습니다. 서버 확인은 내용을 다시 보내지 않습니다.</p>
        {contentRecoveryError ? <p role="alert">{contentRecoveryError}</p> : null}
        <div className={styles.recoveryActions}>
          <button type="button" className="button button-secondary" disabled={checkingContent || abandonContentConfirm} onClick={() => void resolveContentAttempt("status")}>서버 처리 확인</button>
          <button type="button" className="button button-secondary" disabled={checkingContent || abandonContentConfirm} onClick={() => void resolveContentAttempt("retry")}>같은 요청 다시 시도</button>
          <button type="button" className="button button-secondary" disabled={checkingContent || abandonContentConfirm} onClick={() => setAbandonContentConfirm(true)}>확인 전 그만두기</button>
        </div>
        {abandonContentConfirm ? <ConsoleConfirm
          summary="이미 저장된 내용은 취소되지 않습니다. 입력 화면을 닫고 최신 목록을 확인할까요?"
          confirmLabel="확인 그만두기"
          onConfirm={() => {
            const attempt = pendingContentRef.current;
            if (!attempt) return;
            commandIdCache.current.delete(attempt.fingerprint);
            abandonOperatorAttempt(attempt.commandId);
            forgetOperatorReceipt(attempt.commandId);
            pendingContentRef.current = null;
            setPendingContent(null);
            setAbandonContentConfirm(false);
            if (attempt.origin === "notice") setNoticeDialogOpen(false);
            if (attempt.origin === "program") setProgramDialogOpen(false);
            setFailure(null);
            setNotice("확인을 그만두었습니다. 서버 처리는 취소되지 않았으므로 최신 목록을 확인하세요.");
            void load(true);
          }}
          onCancel={() => setAbandonContentConfirm(false)}
        /> : null}
      </section>
    );
  }

  function openPublication(kind: PublicationKind, id: string, version: number, published: boolean) {
    if (state.kind !== "ready") return;
    setPublicationError(null);
    setPublicationConflict(false);
    setPublication({ kind, id, version, published, destinations: publicationDestinations(state, kind, id) });
  }

  function publicationDetails(): { title: string; changes: PublicationChange[]; destinations: PublicationDestination[]; stale: boolean; destinationsChanged: boolean } | null {
    if (!publication || state.kind !== "ready") return null;
    const eventUrl = `/event/${encodeURIComponent(state.slug)}`;
    const hidden = !publication.published ? "게시를 내리면 이 내용이 보이지 않습니다." : "";
    const destinationsChanged = !samePublicationDestinations(publication.destinations, publicationDestinations(state, publication.kind, publication.id));
    if (publication.kind === "notice") {
      const item = state.notices.find(item => item.id === publication.id);
      if (!item) return null;
      const showNotice = state.publishedPage.showAnnouncements !== false;
      const homeHidden = !showNotice || normalizeHomeMenus(state.publishedPage.homeMenus).hidden.includes("notice");
      const selected = state.display.type === "notice" && state.display.noticeId === item.id;
      return {
        title: publication.published ? "공지 게시 검토" : "공지 게시 내리기",
        changes: noticeChanges(item, publication.published), stale: item.version !== publication.version || destinationsChanged, destinationsChanged,
        destinations: [
          { label: "행사 안내 · 공지", detail: showNotice ? hidden || "게시 후 공개됩니다." : "참가자 페이지 설정에서 공지 표시가 꺼져 있어 현재 보이지 않습니다.", href: `${eventUrl}#public-notices`, warning: !showNotice },
          { label: "참가자 홈 · 공지", detail: homeHidden ? "참가자 페이지의 공지 메뉴가 숨겨져 있습니다. 게시 후에도 메뉴를 켜야 보입니다." : hidden || "게시 후 같은 내용이 보입니다.", href: `${eventUrl}/home`, warning: homeHidden },
          { label: "행사장 전광판", detail: selected && state.screenEnabled
            ? publication.published ? "이 공지가 출력으로 선택되어 있어 게시하면 전광판 내용도 즉시 바뀝니다." : "이 공지가 출력으로 선택되어 있습니다. 게시를 내리면 전광판에서도 공지가 사라집니다."
            : state.screenEnabled ? "게시 후 ‘전광판 출력’에서 따로 선택하세요." : "전광판 기능이 꺼져 있습니다.",
            ...(state.screenEnabled ? { href: `/screen/${encodeURIComponent(state.slug)}` } : {}), warning: selected && state.screenEnabled },
        ],
      };
    }
    if (publication.kind === "program") {
      const item = state.program.find(item => item.id === publication.id);
      if (!item) return null;
      const visible = state.publishedPage.showPrograms !== false;
      return { title: publication.published ? "일정 게시 검토" : "일정 게시 내리기", changes: programChanges(item, publication.published), stale: item.version !== publication.version || destinationsChanged, destinationsChanged,
        destinations: [{ label: "행사 안내 · 프로그램", detail: visible ? hidden || "게시하면 행사 안내의 프로그램 일정과 첨부 자료에 반영됩니다." : "참가자 페이지 설정에서 프로그램 표시가 꺼져 있어 현재 보이지 않습니다.", href: `${eventUrl}#public-program`, warning: !visible }] };
    }
    const venueEnabled = state.features.includes("venue");
    const visible = venueEnabled && state.publishedPage.showVenue !== false;
    return { title: "장소 안내 게시 검토", changes: venueChanges(state.venue), stale: state.venue.version !== publication.version || destinationsChanged, destinationsChanged,
      destinations: [{ label: "행사 안내 · 장소 안내", detail: visible ? "장소 문구와 안내도가 행사 안내에 반영됩니다. 초안의 안내도 파일은 게시 전까지 공개되지 않습니다." : !venueEnabled ? "행사 설정에서 장소 안내 기능이 꺼져 있어 현재 보이지 않습니다." : "참가자 페이지 설정에서 장소 안내 표시가 꺼져 있어 현재 보이지 않습니다.", href: `${eventUrl}#public-venue`, warning: !visible }] };
  }

  async function applyPublication() {
    if (!publication || publicationConflict || busy !== null || archived || pendingContentRef.current || otherContentReceipt) return;
    const review = publicationDetails();
    if (!review || review.stale) { setPublicationError("내용이 바뀌었습니다. 돌아가서 최신 내용을 다시 검토하세요."); return; }
    setBusy("publication");
    setPublicationError(null); setPublicationConflict(false);
    try {
      await postCommand(`${publication.kind}.publish-reviewed`, {
        ...(publication.kind !== "venue" ? { id: publication.id, published: publication.published } : {}),
        expectedVersion: publication.version,
        expectedDestinations: publication.destinations,
      });
      if (activeEventRef.current !== eventId) return;
      setPublication(null);
      setFailure(null);
      setNotice(publication.published ? "검토한 내용을 게시했습니다. 반영 위치에서 확인하세요." : "게시를 내렸습니다. 저장한 초안은 유지됩니다.");
    } catch (error) {
      if (activeEventRef.current !== eventId) return;
      setPublicationError(error instanceof Error ? error.message : "게시 결과를 확인하지 못했습니다.");
      if (error instanceof CommandFailure && (error.field === "expectedVersion" || error.field === "expectedDestinations")) {
        setPublicationConflict(true);
        await load(true);
      }
    } finally { setBusy(null); }
  }

  const review = publicationDetails();

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="content" eventId={eventId}>
        <ConsoleStatePanel
          kind="loading"
          message="콘텐츠 정보를 불러오고 있습니다."
          onRetry={() => { void load(); }}
        />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="content" eventId={eventId}>
        {/* ConsoleStatePanel dispatches eventouch:shell-reload and renders 다시 불러오기. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void load(); }}
        />
      </ConsolePage>
    );
  }

  const venueFeatureOn = state.features.includes("venue");
  const archived = state.stage === "ARCHIVED";
  const archivedReason = "보관된 행사는 읽기 전용입니다";
  // Direct output is a same-screen shortcut for the operations display: only
  // when the screen feature is on, the operator holds the programs grant for
  // display.set, and the row is published. Unpublished rows, a switched-off
  // screen, and readonly states hide the action instead of disabling it.
  // Section gates mirror the server scope map: 공지·장소는 page (notice.save),
  // 프로그램 일정은 programs (program.save). Neither gate invents access;
  // the server re-checks every command.
  const capabilities = { role: state.role, userId: state.userId, memberships: state.memberships, eventId };
  const canWritePage = canWriteEvent(capabilities, "notice.save");
  const canWritePrograms = canWriteEvent(capabilities, "program.save");
  const canOutputNotice = state.screenEnabled && canWritePrograms && !archived;

  return (
    <ConsolePage
      pageId="content"
      eventId={eventId}
      eventName={state.eventName}
      meta={formatConsoleEventMeta(state.eventMeta)}
      headerActions={(
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/settings`}>
          행사 설정
        </Link>
      )}
      sectionNav={(
        <div className={styles.navIndex}>
          <p className={styles.navIndexLabel} aria-hidden="true">콘텐츠 작업</p>
          <ConsoleSectionNav mode="tabs"
            label="콘텐츠 구역"
            items={[
              ...(canWritePage ? [{ id: "content-notices", label: "공지" }] : []),
              ...(canWritePrograms ? [{ id: "content-program", label: "프로그램 일정" }] : []),
              ...(canWritePage ? [{ id: "content-venue", label: "장소 안내" }] : []),
            ]}
          />
        </div>
      )}
      feedback={(
        <>
          {archived ? (
            <ConsoleFeedback kind="warning">
              보관된 행사는 읽기 전용입니다. 콘텐츠는 볼 수 있지만 작성·게시·저장할 수 없습니다.
            </ConsoleFeedback>
          ) : null}
          {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
          {otherContentReceipt && !pendingContent ? <ConsoleFeedback kind="warning">이전 콘텐츠 저장 결과를 위의 처리 결과 확인에서 확인해 주세요.</ConsoleFeedback> : null}
          {failure && !noticeDialogOpen && !programDialogOpen ? (
            <ConsoleFeedback kind="error" id="content-error">{failure.message}</ConsoleFeedback>
          ) : null}
        </>
      )}
    >
      {pendingContent && !((pendingContent.origin === "notice" && noticeDialogOpen) || (pendingContent.origin === "program" && programDialogOpen) || Boolean(publication)) ? contentRecovery() : null}
      {!canWritePage && !canWritePrograms ? (
        <ConsoleFeedback kind="error">콘텐츠를 관리할 운영 권한이 없습니다.</ConsoleFeedback>
      ) : (
        <>
          {!canWritePage ? (
            <ConsoleFeedback kind="warning">공지·장소 쓰기 권한이 없습니다. 일정만 볼 수 있으며, 변경이 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {!canWritePrograms ? (
            <ConsoleFeedback kind="warning">프로그램 일정 변경은 참여 콘텐츠 쓰기 권한이 필요합니다. 일정 목록은 볼 수 있으며, 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          <ConsoleSection
            headingId="content-notices"
            title="공지"
            description="초안을 저장하고 게시 검토를 거쳐 반영합니다. 게시 전까지 현재 내용이 유지됩니다."
            action={canWritePage ? (
              <button
                type="button"
                className={`button ${state.notices.length ? "button-secondary" : "button-primary"}`}
                disabled={archived || Boolean(pendingContent) || otherContentReceipt}
                title={archived ? archivedReason : undefined}
                onClick={openNoticeCreate}
              >
                공지 작성
              </button>
            ) : undefined}
          >
            {state.notices.length ? (
              <ul className={uiStyles.collection}>
                {state.notices.map((item) => {
                  const onDisplay = state.display.type === "notice" && state.display.noticeId === item.id;
                  // The display reference survives unpublishing (saveNotice
                  // never clears it) and the board only shows published
                  // notices, so a bare "출력 중" would falsely claim output.
                  // Name the actual state: selected + published + screen on
                  // means chosen for output; a stale selection says why it
                  // no longer reaches the screen. No live polling — the
                  // bootstrap value is the truth for this screen.
                  const displayBadge = !onDisplay
                    ? null
                    : !state.screenEnabled
                      ? { text: "전광판 선택됨 · 기능 꺼짐", live: false }
                      : !item.published
                        ? { text: "전광판 선택됨 · 비공개로 출력되지 않음", live: false }
                        : { text: "전광판 출력으로 선택됨", live: true };
                  const canOutput = canOutputNotice && item.published;
                  return (
                  <li key={item.id} className={`${uiStyles.recordRow} ${styles.recordRow} ${styles.stackedRow}`}>
                    <div className={uiStyles.recordMain}>
                      <h3 className={styles.recordTitle}>
                        {item.draft.title}
                      </h3>
                      <p className={`${uiStyles.recordMeta} ${styles.badgeRow}`}>
                        <span className={`${styles.badge} ${item.published ? styles.badgeOn : styles.badgeOff}`}>
                          {item.published ? "게시 중" : "비공개"}
                        </span>
                        {item.published && hasChanges(noticeChanges(item)) ? <span className={styles.badge}>수정 초안 있음</span> : null}
                        {item.pinned ? <span className={styles.badge}>고정됨</span> : null}                        {displayBadge ? (
                          <span className={`${styles.badge} ${displayBadge.live ? styles.badgeOn : ""}`}>
                            {displayBadge.text}
                          </span>
                        ) : null}
                      </p>
                      {item.draft.body ? <p className={`${styles.body} preserve-lines`}>{item.draft.body}</p> : null}
                    </div>
                    {canWritePage ? (
                    <div className={`${uiStyles.recordActions} ${styles.compactActions}`}>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt}
                        title={archived ? archivedReason : undefined}
                        onClick={() => openNoticeEdit(item)}
                      >
                        편집
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt}
                        title={archived ? archivedReason : undefined}
                        onClick={() => openPublication("notice", item.id, item.version, true)}
                      >
                        게시 검토
                      </button>
                      {item.published ? <button type="button" className="button button-secondary" disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt} onClick={() => openPublication("notice", item.id, item.version, false)}>게시 내리기</button> : null}
                      {canOutput ? (
                        <>
                        <span className={styles.actionSeparator} aria-hidden="true" />
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt}
                          title={archived ? archivedReason : undefined}
                          onClick={() => requestNoticeDisplay(item)}
                        >
                          {busy === `notice-display:${item.id}` ? "처리 중…" : "전광판 출력"}
                        </button>
                        </>
                      ) : null}
                      <span className={styles.actionSeparator} aria-hidden="true" />
                      <button
                        type="button"
                        className={`button button-secondary ${styles.dangerGhost}`}
                        disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt}
                        title={archived ? archivedReason : undefined}
                        onClick={() => requestNoticeDelete(item)}
                      >
                        삭제
                      </button>
                    </div>
                    ) : null}
                    {noticeDisplayPendingId === item.id && canOutput && noticeDeletePendingId !== item.id ? (
                      <ConsoleConfirm
                        summary={`“${item.title}” 공지를 행사장 전광판에 출력할까요? 참가자 화면과 같은 내용이 외부 화면에 나옵니다.`}
                        confirmLabel="전광판 출력"
                        busy={busy !== null}
                        onConfirm={() => void applyNoticeDisplay(item)}
                        onCancel={() => setNoticeDisplayPendingId(null)}
                      />
                    ) : null}
                    {noticeDeletePendingId === item.id && noticeDisplayPendingId !== item.id ? (
                      <ConsoleConfirm
                        summary={`“${item.title}” 공지를 삭제할까요?`}
                        confirmLabel="삭제한다"
                        confirmClassName={`button button-secondary ${styles.dangerGhost}`}
                        busy={busy !== null}
                        onConfirm={() => void deleteNotice(item)}
                        onCancel={() => setNoticeDeletePendingId(null)}
                      />
                    ) : null}
                  </li>
                  );
                })}
              </ul>
            ) : (
              <p className={styles.empty}>등록된 공지가 없습니다.{canWritePage ? " 위에서 첫 공지를 작성하세요." : ""}</p>
            )}
          </ConsoleSection>

          {/* Supporting work shares one row on desktop: 일정 (wider ledger)
              beside 장소 안내 (narrower form), DOM order stacked on phones.
              Section anchors, order, gates and commands are unchanged. */}
          <div className={styles.supportGrid}>
          <ConsoleSection
            headingId="content-program"
            title="프로그램 일정"
            description="초안을 저장한 뒤 게시하세요. 게시된 일정은 날짜·시작 시간 순으로 보입니다."
            action={canWritePrograms ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={archived || Boolean(pendingContent) || otherContentReceipt}
                title={archived ? archivedReason : undefined}
                onClick={() => openProgramCreate()}
              >
                일정 추가
              </button>
            ) : undefined}
          >
            {state.program.length ? (
              <ul className={uiStyles.collection}>
                {state.program.map((item) => (
                  <li key={item.id} className={`${uiStyles.recordRow} ${styles.recordRow}`}>
                    <div className={uiStyles.recordMain}>
                      <h3 className={styles.recordTitle}>{item.draft.title}</h3>
                      <p className={`${uiStyles.recordMeta} ${styles.badgeRow}`}>
                        <span className={`${styles.badge} ${item.published ? styles.badgeOn : styles.badgeOff}`}>
                          {item.published ? "게시 중" : "비공개"}
                        </span>
                        {item.published && hasChanges(programChanges(item)) ? <span className={styles.badge}>수정 초안 있음</span> : null}
                        <span>
                          {[item.draft.date, item.draft.start && item.draft.end ? `${item.draft.start} ~ ${item.draft.end}` : item.draft.start, item.draft.place]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </p>
                      {item.draft.description ? <p className={styles.body}>{item.draft.description}</p> : null}
                      {item.draft.attachment ? (
                        <p className={styles.attachment}>
                          첨부:{" "}
                          <Link href={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(item.draft.attachment.fileId)}`}>
                            {item.draft.attachment.name || "일정 자료(PDF)"}
                          </Link>
                        </p>
                      ) : null}
                    </div>
                    {canWritePrograms ? (
                    <div className={`${uiStyles.recordActions} ${styles.compactActions}`}>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt}
                        title={archived ? archivedReason : undefined}
                        onClick={() => openProgramEdit(item)}
                      >
                        편집
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt}
                        title={archived ? archivedReason : undefined}
                        onClick={() => openPublication("program", item.id, item.version, true)}
                      >
                        게시 검토
                      </button>
                      {item.published ? <button type="button" className="button button-secondary" disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt} onClick={() => openPublication("program", item.id, item.version, false)}>게시 내리기</button> : null}
                      <span className={styles.actionSeparator} aria-hidden="true" />
                      <button
                        type="button"
                        className={`button button-secondary ${styles.dangerGhost}`}
                        disabled={busy !== null || archived || Boolean(pendingContent) || otherContentReceipt}
                        title={archived ? archivedReason : undefined}
                        onClick={() => requestProgramDelete(item)}
                      >
                        삭제
                      </button>
                    </div>
                    ) : null}
                    {programDeletePendingId === item.id ? (
                      <ConsoleConfirm
                        summary={`“${item.title}” 일정을 삭제할까요?`}
                        confirmLabel="삭제한다"
                        confirmClassName={`button button-secondary ${styles.dangerGhost}`}
                        busy={busy !== null}
                        onConfirm={() => void deleteProgram(item)}
                        onCancel={() => setProgramDeletePendingId(null)}
                      />
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className={styles.empty}>등록된 일정이 없습니다.{canWritePrograms ? " 위에서 첫 일정을 추가하세요." : ""}</p>
            )}
          </ConsoleSection>

          <ConsoleSection headingId="content-venue" title="장소 안내" width="form" description={venueDirty || venueFile ? "작성 중입니다. 초안을 저장하면 게시 검토를 진행할 수 있습니다." : hasChanges(venueChanges(state.venue)) ? "저장한 초안이 있습니다. 게시 전까지 기존 장소 안내가 유지됩니다." : "게시된 장소 안내와 저장한 초안이 같습니다."}>
            {!venueFeatureOn ? (
              <p className={styles.featureOff} role="note">
                장소 안내 기능이 꺼져 있습니다.{" "}
                <Link href={`/console/events/${encodeURIComponent(eventId)}/settings`}>행사 설정</Link>에서
                기능을 먼저 켜세요. 켜기 전에는 저장이 반영되지 않습니다.
              </p>
            ) : null}
            {venueDraft && canWritePage ? (
              <ValidatedForm className={uiStyles.formStack} onSubmit={(event) => void saveVenue(event)}>
                <fieldset className={styles.draftFields} disabled={Boolean(pendingContent) || checkingContent || busy !== null}><legend className="sr-only">장소 안내 초안</legend>
                <div className={styles.fieldGroup}>
                  <h3 className={styles.groupTitle}>장소 기본</h3>
                <div>
                  <label htmlFor="content-venue-name">장소 이름</label>
                  <input
                    id="content-venue-name"
                    type="text"
                    maxLength={VENUE_LIMITS.name}
                    value={venueDraft.name}
                    onChange={(event) => setVenueDraft({ ...venueDraft, name: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="content-venue-address">주소</label>
                  <input
                    id="content-venue-address"
                    type="text"
                    maxLength={VENUE_LIMITS.address}
                    value={venueDraft.address}
                    onChange={(event) => setVenueDraft({ ...venueDraft, address: event.target.value })}
                  />
                </div>
                </div>
                <div className={styles.fieldGroup}>
                  <h3 className={styles.groupTitle}>참가자 안내 문구</h3>
                <div>
                  <label htmlFor="content-venue-directions">길찾기</label>
                  <textarea data-resize-none="true"
                    id="content-venue-directions"
                    rows={3}
                    maxLength={VENUE_LIMITS.directions}
                    value={venueDraft.directions}
                    onChange={(event) => setVenueDraft({ ...venueDraft, directions: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="content-venue-contact">문의</label>
                  <input
                    id="content-venue-contact"
                    type="text"
                    maxLength={VENUE_LIMITS.contact}
                    value={venueDraft.contact}
                    onChange={(event) => setVenueDraft({ ...venueDraft, contact: event.target.value })}
                  />
                </div>
                <div>
                  <label htmlFor="content-venue-description">안내 문구</label>
                  <textarea data-resize-none="true"
                    id="content-venue-description"
                    rows={3}
                    maxLength={VENUE_LIMITS.description}
                    value={venueDraft.description}
                    onChange={(event) => setVenueDraft({ ...venueDraft, description: event.target.value })}
                  />
                </div>
                </div>
                <div className={styles.fieldGroup}>
                  <h3 className={styles.groupTitle}>행사장 안내도 · 선택</h3>
                  <p className={styles.help} id="content-venue-map-help">JPG 또는 PNG, 500KB 미만. 공개 행사에서 장소 안내가 켜져 있으면 표시됩니다.</p>
                  {venueDraft.map ? <>
                    {(venuePreview || venueDraft.map.image?.fileId) ? <figure className={styles.venueMapPreview}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={venuePreview || `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(venueDraft.map.image!.fileId)}`} alt={venueDraft.map.alt || "선택한 안내도 미리보기"} />
                    </figure> : null}
                    <div>
                      <label htmlFor="content-venue-map-alt">안내도 설명</label>
                      <textarea id="content-venue-map-alt" data-resize-none="true" rows={2} maxLength={240}
                        value={venueDraft.map.alt} disabled={busy !== null} aria-invalid={failure?.field === "mapAlt" || undefined}
                        onChange={(event) => {
                          touchVenueMap();
                          setVenueDraft({ ...venueDraft, map: { ...venueDraft.map!, alt: event.target.value } });
                          setFailure((current) => current?.field === "mapAlt" ? null : current);
                        }} />
                      <p className={styles.help}>이미지가 보이지 않아도 알 수 있도록 주요 동선을 적어주세요.</p>
                    </div>
                    <button type="button" className={`button button-secondary ${styles.venueMapRemove}`} disabled={busy !== null || venueUploadUncertain}
                      onClick={() => { touchVenueMap(); setVenueFile(null); setVenueDraft({ ...venueDraft, map: null }); }}>안내도 제거</button>
                  </> : null}
                  <div>
                    <label htmlFor="content-venue-map-file">{venueDraft.map ? "안내도 바꾸기" : "안내도 선택"}</label>
                    <input id="content-venue-map-file" type="file" accept="image/jpeg,image/png"
                      aria-describedby="content-venue-map-help" disabled={busy !== null || venueUploadUncertain || !venueFeatureOn || archived}
                      onChange={(event) => {
                        const file = event.currentTarget.files?.[0];
                        event.currentTarget.value = "";
                        if (!file) return;
                        if (!["image/jpeg", "image/png"].includes(file.type) || file.size <= 0 || file.size >= VENUE_MAP_MAX_BYTES) {
                          setFailure({ message: "JPG 또는 PNG 중 500KB 미만 파일을 선택하세요.", field: "map" });
                          return;
                        }
                        setFailure(null);
                        touchVenueMap();
                        setVenueFile(file);
                        setVenueDraft({ ...venueDraft, map: { image: null, alt: venueDraft.map?.alt ?? "" } });
                      }} />
                    {venueFile ? <p className={styles.help}>선택한 파일: {venueFile.name}</p> : null}
                  </div>
                  {venueUploadUncertain ? <div className={styles.help} role="alert">
                    <p>업로드 결과가 확인되지 않았습니다. 같은 파일로 다시 저장할 수 있습니다.</p>
                    {venueUploadAbandonConfirm ? <ConsoleConfirm
                      summary="업로드는 이미 완료됐을 수 있습니다. 선택한 파일과 설명을 되돌립니다."
                      confirmLabel="파일 확인 중단" onConfirm={abandonVenueUpload} onCancel={() => setVenueUploadAbandonConfirm(false)} />
                      : <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => setVenueUploadAbandonConfirm(true)}>파일 확인 중단</button>}
                  </div> : null}
                  {failure?.field === "map" && failure.message.includes("다른 운영자") ? venueRestoreConfirm
                    ? <ConsoleConfirm summary="작성한 안내도와 설명을 버리고 최신 안내도를 불러옵니다. 다른 장소 문구는 유지됩니다."
                        confirmLabel="최신 안내도 불러오기" onConfirm={() => void restoreLatestVenueMap()} onCancel={() => setVenueRestoreConfirm(false)} />
                    : <button type="button" className={`button button-secondary ${styles.venueMapRemove}`}
                        disabled={busy !== null} onClick={() => setVenueRestoreConfirm(true)}>최신 안내도 불러오기</button> : null}
                </div>
                {failure?.field === "expectedVersion" && !pendingContent ? <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => void reloadEditorDraft("venue")}>최신 장소 초안 불러오기</button> : null}
                <ConsoleFormActions>
                  <button
                    type="submit"
                    className="button button-secondary"
                    disabled={busy !== null || !venueFeatureOn || archived || Boolean(pendingContent) || otherContentReceipt}
                    title={archived ? archivedReason : venueFeatureOn ? undefined : "행사 설정에서 장소 안내 기능을 먼저 켜세요"}
                  >
                    {busy === "venue:save" ? "저장 중…" : "초안 저장"}
                  </button>
                  <button type="button" className="button button-secondary" disabled={busy !== null || !venueFeatureOn || archived || venueDirty || Boolean(venueFile) || venueUploadUncertain || Boolean(pendingContent) || otherContentReceipt || !hasChanges(venueChanges(state.venue))} onClick={() => openPublication("venue", "", state.venue.version, true)}>게시 검토</button>
                </ConsoleFormActions>
                </fieldset>
              </ValidatedForm>
            ) : !canWritePage ? (
              <div className={uiStyles.recordMain}>
                <span>장소 이름: {state.venue.name || "미등록"}</span>
                <p className={uiStyles.recordMeta}>주소: {state.venue.address || "미등록"}</p>
                <p className={uiStyles.recordMeta}>길찾기: {state.venue.directions || "미등록"}</p>
                <p className={uiStyles.recordMeta}>문의: {state.venue.contact || "미등록"}</p>
                <p className={uiStyles.recordMeta}>안내 문구: {state.venue.description || "미등록"}</p>
                {state.venue.map?.image?.fileId ? <p className={uiStyles.recordMeta}>
                  안내도: <a href={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(state.venue.map.image.fileId)}`} target="_blank" rel="noopener noreferrer">보기 (새 탭)</a> · {state.venue.map.alt}
                </p> : null}
              </div>
            ) : null}
          </ConsoleSection>
          </div>
        </>
      )}

      {noticeDialogOpen && state.kind === "ready" ? (
        <ConsoleDialog
          titleId="content-notice-dialog-title"
          title={noticeDraft.id ? "공지 편집" : "공지 작성"}
          busy={noticeDialogBusy}
          canClose={canCloseNoticeDialog}
          onClose={() => setNoticeDialogOpen(false)}
        >
          <ValidatedForm className={uiStyles.formStack} onSubmit={(event) => void saveNotice(event)}>
            <fieldset className={styles.draftFields} disabled={Boolean(pendingContent) || checkingContent || noticeDialogBusy}>
            <legend className="sr-only">공지 내용</legend>
            <div>
              <label htmlFor="content-notice-title">제목</label>
              <input
                id="content-notice-title"
                type="text"
                maxLength={NOTICE_TITLE_MAX}
                required
                value={noticeDraft.title}
                aria-invalid={noticeDialogFailure?.field === "title"}
                aria-describedby={noticeDialogFailure?.field === "title" ? "content-notice-title-error" : undefined}
                onChange={(event) => setNoticeDraft({ ...noticeDraft, title: event.target.value })}
              />
              {noticeDialogFailure?.field === "title" ? (
                <p className={styles.fieldError} id="content-notice-title-error" role="alert">{noticeDialogFailure.message}</p>
              ) : null}
            </div>
            <div>
              <label htmlFor="content-notice-body">내용</label>
              <textarea data-resize-none="true"
                id="content-notice-body"
                rows={5}
                maxLength={NOTICE_BODY_MAX}
                required
                value={noticeDraft.body}
                aria-invalid={noticeDialogFailure?.field === "body"}
                aria-describedby={noticeDialogFailure?.field === "body" ? "content-notice-body-error" : undefined}
                onChange={(event) => setNoticeDraft({ ...noticeDraft, body: event.target.value })}
              />
              {noticeDialogFailure?.field === "body" ? (
                <p className={styles.fieldError} id="content-notice-body-error" role="alert">{noticeDialogFailure.message}</p>
              ) : null}
            </div>
            <p className={styles.help}>초안 저장 후 게시 검토에서 참가자에게 반영할 내용을 확인하세요. 현재 게시본은 유지됩니다.</p>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={noticeDraft.pinned}
                onChange={(event) => setNoticeDraft({ ...noticeDraft, pinned: event.target.checked })}
              />
              상단 고정
            </label>
            </fieldset>
            {noticeDialogFailure && !["title", "body"].includes(noticeDialogFailure.field ?? "") && !(pendingContent?.origin === "notice" && contentRecoveryError) ? (
              <p className={styles.fieldError} role="alert">{noticeDialogFailure.message}</p>
            ) : null}
            {noticeDialogFailure?.field === "expectedVersion" && !pendingContent ? <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => void reloadEditorDraft("notice")}>최신 초안 불러오기</button> : null}
            {pendingContent?.origin === "notice" ? contentRecovery() : null}
            <ConsoleFormActions>
              <button
                type="button"
                className="button button-secondary"
                disabled={noticeDialogBusy}
                onClick={() => { if (canCloseNoticeDialog()) setNoticeDialogOpen(false); }}
              >
                취소
              </button>
              <button type="submit" className="button button-primary" disabled={noticeDialogBusy || archived || Boolean(pendingContent) || checkingContent || otherContentReceipt} title={archived ? archivedReason : undefined}>
                {noticeDialogBusy ? "저장 중…" : "초안 저장"}
              </button>
            </ConsoleFormActions>
          </ValidatedForm>
        </ConsoleDialog>
      ) : null}

      {programDialogOpen && state.kind === "ready" ? (
        <ConsoleDialog
          titleId="content-program-dialog-title"
          title={programDraft.id ? "일정 편집" : "일정 추가"}
          busy={programDialogBusy || uploadingAttachment}
          canClose={canCloseProgramDialog}
          onClose={() => setProgramDialogOpen(false)}
        >
          <ValidatedForm className={uiStyles.formStack} onSubmit={(event) => void saveProgram(event)}>
            <fieldset className={styles.draftFields} disabled={Boolean(pendingContent) || checkingContent || programDialogBusy}>
            <legend className="sr-only">일정 내용</legend>
            <div>
              <label htmlFor="content-program-title">제목</label>
              <input
                id="content-program-title"
                type="text"
                maxLength={PROGRAM_TITLE_MAX}
                required
                value={programDraft.title}
                aria-invalid={programDialogFailure?.field === "title"}
                aria-describedby={programDialogFailure?.field === "title" ? "content-program-title-error" : undefined}
                onChange={(event) => setProgramDraft({ ...programDraft, title: event.target.value })}
              />
              {programDialogFailure?.field === "title" ? (
                <p className={styles.fieldError} id="content-program-title-error" role="alert">{programDialogFailure.message}</p>
              ) : null}
            </div>
            <div>
              <label htmlFor="content-program-date">날짜 (비우면 행사일)</label>
              <input
                id="content-program-date"
                type="date"
                value={programDraft.date}
                onChange={(event) => setProgramDraft({ ...programDraft, date: event.target.value })}
              />
            </div>
            <div className={uiStyles.formGrid}>
              <div>
                <label htmlFor="content-program-start">시작</label>
                <input
                  id="content-program-start"
                  type="time"
                  required
                  value={programDraft.start}
                  onChange={(event) => setProgramDraft({ ...programDraft, start: event.target.value })}
                />
              </div>
              <div>
                <label htmlFor="content-program-end">종료</label>
                <input
                  id="content-program-end"
                  type="time"
                  required
                  value={programDraft.end}
                  onChange={(event) => setProgramDraft({ ...programDraft, end: event.target.value })}
                />
              </div>
            </div>
            <div>
              <label htmlFor="content-program-place">장소</label>
              <input
                id="content-program-place"
                type="text"
                maxLength={PROGRAM_PLACE_MAX}
                value={programDraft.place}
                onChange={(event) => setProgramDraft({ ...programDraft, place: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="content-program-description">상세 설명</label>
              <textarea data-resize-none="true"
                id="content-program-description"
                rows={4}
                maxLength={PROGRAM_DESCRIPTION_MAX}
                value={programDraft.description}
                onChange={(event) => setProgramDraft({ ...programDraft, description: event.target.value })}
              />
            </div>
            <div>
              <label htmlFor="content-program-attachment">일정 자료 (PDF, 600KB 이하)</label>
              {programDraft.attachment ? (
                <p className={styles.attachmentRow}>
                  <span>{programDraft.attachment.name || "일정 자료(PDF)"}</span>
                  <button
                    type="button"
                    className="button button-secondary"
                    disabled={programDialogBusy || uploadingAttachment}
                    onClick={() => setProgramDraft({ ...programDraft, attachment: null, attachmentDirty: true })}
                  >
                    첨부 제거
                  </button>
                </p>
              ) : (
                <input
                  id="content-program-attachment"
                  type="file"
                  accept="application/pdf"
                  disabled={programDialogBusy || uploadingAttachment || programUploadUncertain || archived}
                  title={archived ? archivedReason : undefined}
                  aria-invalid={programDialogFailure?.field === "attachment"}
                  aria-describedby={programDialogFailure?.field === "attachment" ? "content-program-attachment-error" : undefined}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file && !archived) void uploadProgramAttachment(file);
                    event.target.value = "";
                  }}
                />
              )}
              {uploadingAttachment ? <p className={styles.help} role="status">파일을 올리고 있습니다.</p> : null}
              {programUploadUncertain ? (
                <div className={styles.recovery}>
                  <p>결과를 확인할 때까지 원래 파일을 유지합니다. 화면을 떠나면 파일을 다시 선택해야 합니다.</p>
                  <div className={styles.recoveryActions}>
                    <button type="button" className="button button-secondary" disabled={uploadingAttachment || programUploadAbandonConfirm} onClick={() => { if (programUploadRef.current) void uploadProgramAttachment(programUploadRef.current.file); }}>같은 파일 요청 다시 확인</button>
                    <button type="button" className="button button-secondary" disabled={uploadingAttachment || programUploadAbandonConfirm} onClick={() => setProgramUploadAbandonConfirm(true)}>파일 확인 그만두기</button>
                  </div>
                  {programUploadAbandonConfirm ? <ConsoleConfirm
                    summary="파일이 이미 서버에 저장됐을 수 있습니다. 확인을 그만둬도 서버 파일은 삭제되지 않습니다."
                    confirmLabel="확인 그만두기"
                    onConfirm={() => {
                      if (programUploadRef.current) abandonOperatorAttempt(programUploadRef.current.commandId);
                      programUploadRef.current = null;
                      setProgramUploadUncertain(false);
                      setProgramUploadAbandonConfirm(false);
                      setProgramDialogFailure(null);
                    }}
                    onCancel={() => setProgramUploadAbandonConfirm(false)}
                  /> : null}
                </div>
              ) : null}
              {programDialogFailure?.field === "attachment" ? (
                <p className={styles.fieldError} id="content-program-attachment-error" role="alert">{programDialogFailure.message}</p>
              ) : null}
            </div>
            <p className={styles.help}>초안 저장 후 게시 검토에서 참가자에게 반영할 내용을 확인하세요. 현재 게시본은 유지됩니다.</p>
            </fieldset>
            {programDialogFailure && !["title", "attachment"].includes(programDialogFailure.field ?? "") && !(pendingContent?.origin === "program" && contentRecoveryError) ? (
              <p className={styles.fieldError} role="alert">{programDialogFailure.message}</p>
            ) : null}
            {programDialogFailure?.field === "expectedVersion" && !pendingContent ? <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => void reloadEditorDraft("program")}>최신 초안 불러오기</button> : null}
            {pendingContent?.origin === "program" ? contentRecovery() : null}
            <ConsoleFormActions>
              <button
                type="button"
                className="button button-secondary"
                disabled={programDialogBusy || uploadingAttachment}
                onClick={() => { if (canCloseProgramDialog()) setProgramDialogOpen(false); }}
              >
                취소
              </button>
              <button type="submit" className="button button-primary" disabled={programDialogBusy || uploadingAttachment || programUploadUncertain || archived || Boolean(pendingContent) || checkingContent || otherContentReceipt} title={archived ? archivedReason : undefined}>
                {programDialogBusy ? "저장 중…" : "초안 저장"}
              </button>
            </ConsoleFormActions>
          </ValidatedForm>
        </ConsoleDialog>
      ) : null}
      {publication && review ? <PublicationReview title={review.title}
        description={publication.published ? "저장한 초안과 현재 게시본을 비교하세요. 게시하기를 누르면 아래 위치에 반영됩니다." : "아래 위치에서 게시가 내려갑니다. 작성한 초안과 기존 내용은 보존됩니다."}
        changes={review.changes} destinations={review.destinations} busy={busy !== null || checkingContent}
        disabled={archived || Boolean(pendingContent) || otherContentReceipt || publicationConflict || review.stale || (publication.published && !hasChanges(review.changes))}
        error={review.stale ? review.destinationsChanged ? "게시 위치가 변경되었습니다. 돌아가서 최신 설정을 다시 검토하세요." : "검토 중 내용이 바뀌었습니다. 돌아가서 최신 내용을 다시 검토하세요." : publicationError}
        confirmLabel={publication.published ? "게시하기" : "게시 내리기"}
        onConfirm={() => void applyPublication()} onClose={() => setPublication(null)}>
        {publication.published && !hasChanges(review.changes) ? <p className={styles.help}>게시본과 같은 내용입니다. 먼저 초안을 편집해 저장하세요.</p> : null}
        {publicationConflict && !review.stale ? <button type="button" className="button button-secondary" disabled={busy !== null} onClick={() => {
          setBusy("publication:reload");
          void load(true).finally(() => setBusy(null));
        }}>최신 내용 다시 불러오기</button> : null}
        {pendingContent ? contentRecovery() : null}
      </PublicationReview> : null}
    </ConsolePage>
  );
}
