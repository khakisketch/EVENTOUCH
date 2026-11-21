"use client";

import ValidatedForm from "../../../../ui/ValidatedForm";
import ProductButton from "../../../../ui/ProductButton";

import { useEffect, useRef, useState, type ReactNode } from "react";
import ProductLink from "../../../../ui/ProductLink";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleDialog from "../../../console-ui/ConsoleDialog";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import PublicationReview, { type PublicationChange, type PublicationDestination } from "../../../console-ui/PublicationReview";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import ConsoleEmptyState from "../../../console-ui/ConsoleEmptyState";
import ListRow from "../../../console-ui/ListRow";
import CountTabs from "../../../console-ui/CountTabs";
import StatusPill, { type StatusPillTone } from "../../../console-ui/StatusPill";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./content.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsContentCommand, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import { normalizeHomeMenus } from "../../../../../lib/attendee-home-menus";
import { normalizeHomeImage, normalizeHomeStyle } from "../../../../../lib/attendee-home";
import RichEditor from "./RichEditor";
import { richSummary } from "../../../../../lib/rich-text";
import ContentPhonePreview, { type PreviewDesign, type PreviewNotice, type PreviewProgram, type PreviewScreen, type PreviewVenue } from "./ContentPhonePreview";
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
      design: PreviewDesign;
    };

type ContentTab = "notice" | "program" | "venue";
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

// The display reference survives unpublishing (saveNotice never clears it)
// and the board only shows published notices, so a bare "출력 중" would
// falsely claim output. Name the actual state; no live polling — the
// bootstrap value is the truth for this screen.
function noticeDisplayLabel(state: ReadyWorkspace, item: Notice): string {
  if (!(state.display.type === "notice" && state.display.noticeId === item.id)) return "";
  if (!state.screenEnabled) return "전광판 선택됨 · 기능 꺼짐";
  if (!item.published) return "전광판 선택됨 · 비공개로 출력되지 않음";
  return "전광판 출력으로 선택됨";
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

function CrumbChevron() {
  return <svg className={styles.crumbIcon} viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="M14.5 6.5 9 12l5.5 5.5" /></svg>;
}

type ContentStatus = "live" | "edit" | "off";

// Ties the list to the phone: only published items reach attendees, so the
// ledger says how many of them the phone shows and how many drafts still wait.
function LedgerNote({ live, waiting, hint }: { live: number; waiting: number; hint?: string }) {
  return (
    <p className={styles.ledgerNote} data-ledger-note>
      <span>참가자 폰에는 <strong>게시 중 {live}개</strong>만 보입니다.</span>
      {waiting ? <span>수정본 {waiting}개는 게시 검토를 기다립니다.</span> : null}
      {hint ? <span>{hint}</span> : null}
    </p>
  );
}

// Reopened 2026-11-20 (디자인 시스템 적용): state is one StatusPill everywhere
// (ledger rows, editor head). 게시 중 = ok, 수정본 있음 = wait (the draft waits
// on a publish review), 비공개 = neutral. The text carries the meaning.
const STATUS_TONE: Record<ContentStatus, StatusPillTone> = { live: "ok", edit: "wait", off: "neutral" };
const STATUS_LABEL: Record<ContentStatus, string> = { live: "게시 중", edit: "수정본 있음", off: "비공개" };

function ContentStatusPill({ status, size = "md" }: { status: ContentStatus; size?: "sm" | "md" }) {
  return <StatusPill tone={STATUS_TONE[status]} size={size} dot>{STATUS_LABEL[status]}</StatusPill>;
}

// One flat ledger row for every content type (shared ListRow): a state tile,
// the title with a one-line summary, and the state pill on the right. The row
// itself opens the editor; there are no per-row buttons. A row that is shown
// on the attendee phone says so in its tile (green); the amber tile is an
// edited draft that still waits for a publish review.
function LedgerRow({ status, title, summary, pinned = false, attachment = false, note = "", onOpen, disabled, disabledReason }: {
  status: ContentStatus;
  title: string;
  summary: string;
  pinned?: boolean;
  attachment?: boolean;
  note?: string;
  onOpen?: () => void;
  disabled: boolean;
  disabledReason?: string;
}) {
  const open = onOpen && !disabled ? onOpen : undefined;
  return (
    <li className={styles.ledgerItem} data-ledger-status={status} data-disabled={disabled && onOpen ? "true" : undefined} title={disabled && onOpen ? disabledReason : undefined}>
      <ListRow
        as="div"
        title={title || "제목 없음"}
        meta={summary || note ? <span className={styles.rowSummary}>{[note, summary].filter(Boolean).join(" · ")}</span> : undefined}
        leading={<span className={styles.dot} data-status={status} aria-hidden="true" />}
        trailing={(
          <>
            {pinned ? <StatusPill tone="info" size="sm">고정</StatusPill> : null}
            {attachment ? <StatusPill tone="neutral" size="sm">PDF</StatusPill> : null}
            <ContentStatusPill status={status} />
          </>
        )}
        onClick={open}
        chevron={Boolean(open)}
        density="comfortable"
      />
    </li>
  );
}

class CommandFailure extends Error {
  field: string | null;

  constructor(failure: Failure) {
    super(failure.message);
    this.field = failure.field;
  }
}

export default function ContentWorkspace({ eventId, afterHeader }: { eventId: string; afterHeader?: ReactNode }) {
  const router = useRouter();
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // Which authoring tab is open and which attendee screen the phone shows.
  // Switching tabs moves the phone to the matching screen; the phone's own
  // tabs can still look at any other screen without leaving the editor.
  const [tab, setTab] = useState<ContentTab>("notice");
  const [previewScreen, setPreviewScreen] = useState<PreviewScreen>("notice");
  const [previewStageOpen, setPreviewStageOpen] = useState(false);

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
      const pageExperience = asRecord(workspace.pageExperience);
      const publishedDesign = asRecord(pageExperience?.published) ?? {};
      const branding = asRecord(workspace.branding) ?? {};
      const keyvisual = normalizeHomeImage(Object.hasOwn(publishedDesign, "keyvisual") ? publishedDesign.keyvisual : branding.keyvisual);
      // The phone previews the published 참가자 페이지 design; the same
      // normalizers and visibility rules the public pages use.
      const design: PreviewDesign = {
        homeStyle: normalizeHomeStyle(publishedDesign.homeStyle),
        homeMenus: normalizeHomeMenus(publishedDesign.homeMenus),
        accent: /^#[0-9a-f]{6}$/i.test(text(publishedDesign.accent)) ? text(publishedDesign.accent).toUpperCase() : "#E76D26",
        keyvisualUrl: keyvisual?.fileId ? `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(keyvisual.fileId)}` : keyvisual?.data || null,
        defaultHomeBanner: workspace.defaultHomeBanner === "neutral" ? "neutral" : "legacy",
        intro: text(publishedDesign.intro) || text(branding.tagline) || "참가에 필요한 안내를 확인하세요.",
        showSchedule: publishedDesign.showSchedule !== false,
        showAnnouncements: publishedDesign.showAnnouncements !== false,
        showPrograms: publishedDesign.showPrograms !== false,
        showVenue: publishedDesign.showVenue !== false && features.includes("venue"),
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
        design,
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

  // A clean open editor follows the saved record: a publish or a refresh
  // moves the item's version, and the next save must carry the new one. A
  // dirty editor is never overwritten.
  useEffect(() => {
    if (state.kind !== "ready" || !noticeDialogOpen || !noticeDraft.id || noticeDialogDirty) return;
    const item = state.notices.find((entry) => entry.id === noticeDraft.id);
    if (!item || (item.version === noticeDraft.version && item.published === noticeDraft.published)) return;
    const snapshot = { id: item.id, ...item.draft, version: item.version, published: item.published };
    noticeInitialRef.current = snapshot;
    setNoticeDraft(snapshot);
  }, [state, noticeDialogOpen, noticeDraft, noticeDialogDirty]);
  useEffect(() => {
    if (state.kind !== "ready" || !programDialogOpen || !programDraft.id || programDialogDirty) return;
    const item = state.program.find((entry) => entry.id === programDraft.id);
    if (!item || (item.version === programDraft.version && item.published === programDraft.published)) return;
    const snapshot = { id: item.id, ...item.draft, version: item.version, published: item.published, attachmentDirty: false };
    programInitialRef.current = snapshot;
    setProgramDraft(snapshot);
  }, [state, programDialogOpen, programDraft, programDialogDirty]);

  // Settings and other screens deep-link to the old section anchors
  // (#content-notices / #content-program / #content-venue); they now pick the
  // matching tab, on load and when the hash changes.
  useEffect(() => {
    const fromHash = () => {
      const target = ({ "#content-notices": "notice", "#content-program": "program", "#content-venue": "venue" } as Record<string, ContentTab>)[window.location.hash];
      if (target) { setTab(target); setPreviewScreen(target); }
    };
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  // Opening an editor moves focus to its first field; closing hands it back
  // to the tab it came from, so keyboard users never land on <body>.
  const editorOpenRef = useRef({ notice: false, program: false });
  useEffect(() => {
    const was = editorOpenRef.current;
    const frame = window.requestAnimationFrame(() => {
      if (noticeDialogOpen && !was.notice) document.getElementById("content-notice-title")?.focus();
      if (programDialogOpen && !was.program) document.getElementById("content-program-title")?.focus();
      if ((was.notice && !noticeDialogOpen) || (was.program && !programDialogOpen)) document.getElementById(was.notice && !noticeDialogOpen ? "content-tab-notice" : "content-tab-program")?.focus();
      editorOpenRef.current = { notice: noticeDialogOpen, program: programDialogOpen };
    });
    return () => window.cancelAnimationFrame(frame);
  }, [noticeDialogOpen, programDialogOpen]);

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

  // A picture for the notice body: the same stored-file upload the other
  // authoring screens use. One command id per picture; a lost response only
  // leaves an unused file, never a half-saved notice.
  async function uploadNoticeImage(file: File): Promise<{ fileId: string; name: string }> {
    let res: Response;
    try {
      res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/files?name=${encodeURIComponent(file.name)}&commandId=${encodeURIComponent(randomCommandId())}`,
        { method: "POST", headers: { "content-type": file.type }, body: file },
      );
    } catch (error) {
      throw new Error(isOrganizationContextBlock(error) ? "현재 조직을 확인한 뒤 다시 시도하세요." : "이미지를 올리지 못했습니다. 연결을 확인하세요.");
    }
    const data = (await res.json().catch(() => null)) as { file?: { fileId?: unknown; name?: unknown }; error?: unknown } | null;
    const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
    if (!res.ok || !/^[A-Za-z0-9_-]{1,160}$/.test(fileId)) {
      throw new Error(res.ok || typeof data?.error !== "string" ? "이미지 업로드 결과를 확인하지 못했습니다. 다시 시도하세요." : data.error);
    }
    return { fileId, name: typeof data?.file?.name === "string" ? data.file.name : file.name };
  }

  async function saveNotice(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setNoticeDialogFailure(null);
    // The rich editor is not a native field, so its limits are checked here.
    if (!noticeDraft.body.trim()) { setNoticeDialogFailure({ message: "공지 내용을 입력하세요", field: "body" }); return; }
    if (noticeDraft.body.length > NOTICE_BODY_MAX) { setNoticeDialogFailure({ message: `내용은 ${NOTICE_BODY_MAX}자까지 쓸 수 있습니다. 서식과 이미지도 글자 수에 포함됩니다.`, field: "body" }); return; }
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
      const data = await postCommand("notice.save", payload, undefined, "notice");
      // The editor stays open on the saved item so 게시 검토 is one tap away;
      // its snapshot moves to the server's new version so the next save
      // carries the right expectedVersion.
      const saved = parseNotice(data.notice);
      if (saved) {
        const snapshot = { id: saved.id, ...saved.draft, version: saved.version, published: saved.published };
        noticeInitialRef.current = snapshot;
        setNoticeDraft(snapshot);
      } else {
        setNoticeDialogOpen(false);
      }
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
      if (noticeDraft.id === item.id) setNoticeDialogOpen(false);
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
      const data = await postCommand("program.save", payload, undefined, "program");
      const saved = parseProgram(data.program);
      if (saved) {
        const snapshot = { id: saved.id, ...saved.draft, version: saved.version, published: saved.published, attachmentDirty: false };
        programInitialRef.current = snapshot;
        setProgramDraft(snapshot);
      } else {
        setProgramDialogOpen(false);
      }
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
      if (programDraft.id === item.id) setProgramDialogOpen(false);
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
          <ProductButton type="button" variant="secondary" disabled={checkingContent || abandonContentConfirm} onClick={() => void resolveContentAttempt("status")}>서버 처리 확인</ProductButton>
          <ProductButton type="button" variant="secondary" disabled={checkingContent || abandonContentConfirm} onClick={() => void resolveContentAttempt("retry")}>같은 요청 다시 시도</ProductButton>
          <ProductButton type="button" variant="secondary" disabled={checkingContent || abandonContentConfirm} onClick={() => setAbandonContentConfirm(true)}>확인 전 그만두기</ProductButton>
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
      <ConsolePage pageId="content" eventId={eventId} afterHeader={afterHeader}>
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
      <ConsolePage pageId="content" eventId={eventId} afterHeader={afterHeader}>
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

  const gated = busy !== null || archived || Boolean(pendingContent) || otherContentReceipt;
  const designHref = `/console/events/${encodeURIComponent(eventId)}/page`;
  const fileUrl = (file: Attachment | null | undefined) => file ? `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(file.fileId)}` : null;
  const programMeta = (value: { date: string; start: string; end: string; place: string }) =>
    [value.date, value.start && value.end ? `${value.start} ~ ${value.end}` : value.start, value.place].filter(Boolean).join(" · ");

  // Phone content: what attendees see now (published items) plus the one
  // item being edited, drawn from its live draft and outlined.
  const editingNotice = noticeDialogOpen && noticeDraft.id ? state.notices.find((item) => item.id === noticeDraft.id) : undefined;
  const editingProgram = programDialogOpen && programDraft.id ? state.program.find((item) => item.id === programDraft.id) : undefined;
  const previewNotices: PreviewNotice[] = [
    ...state.notices.flatMap((item): PreviewNotice[] => {
      if (noticeDialogOpen && noticeDraft.id === item.id) {
        return [{ id: item.id, title: noticeDraft.title, body: noticeDraft.body, pinned: noticeDraft.pinned, editing: true, unpublished: !item.published }];
      }
      return item.published ? [{ id: item.id, title: item.title, body: item.body, pinned: item.pinned, editing: false, unpublished: false }] : [];
    }),
    ...(noticeDialogOpen && !noticeDraft.id ? [{ id: "", title: noticeDraft.title, body: noticeDraft.body, pinned: noticeDraft.pinned, editing: true, unpublished: true }] : []),
  ].sort((left, right) => Number(right.pinned) - Number(left.pinned));
  const previewPrograms: PreviewProgram[] = [
    ...state.program.flatMap((item): PreviewProgram[] => {
      if (programDialogOpen && programDraft.id === item.id) {
        return [{ id: item.id, title: programDraft.title, date: programDraft.date, start: programDraft.start, end: programDraft.end, place: programDraft.place, description: programDraft.description, editing: true, unpublished: !item.published }];
      }
      return item.published ? [{ id: item.id, title: item.title, date: item.date, start: item.start, end: item.end, place: item.place, description: item.description, editing: false, unpublished: false }] : [];
    }),
    ...(programDialogOpen && !programDraft.id ? [{ id: "", title: programDraft.title, date: programDraft.date, start: programDraft.start, end: programDraft.end, place: programDraft.place, description: programDraft.description, editing: true, unpublished: true }] : []),
  ];
  const venueEditing = venueDraft !== null && (venueDirty || Boolean(venueFile));
  const venueShown = venueEditing && venueDraft ? venueDraft : state.venue;
  const previewVenue: PreviewVenue = {
    name: venueShown.name, address: venueShown.address, directions: venueShown.directions, contact: venueShown.contact, description: venueShown.description,
    mapUrl: venueEditing ? (venuePreview || fileUrl(venueShown.map?.image)) : fileUrl(state.venue.map?.image),
    mapAlt: venueShown.map?.alt ?? "", editing: venueEditing,
  };
  const renderPhone = (mode: "rail" | "stage") => (
    <ContentPhonePreview
      eventName={state.eventName}
      eventDate={state.eventMeta.date ?? ""}
      screen={previewScreen}
      onScreen={setPreviewScreen}
      design={state.design}
      notices={previewNotices}
      programs={previewPrograms}
      venue={previewVenue}
      designHref={designHref}
      imageSrc={(fileId) => `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(fileId)}`}
      mode={mode}
      onExpand={mode === "rail" ? () => setPreviewStageOpen(true) : undefined}
      onClose={mode === "stage" ? () => setPreviewStageOpen(false) : undefined}
    />
  );

  const tabs: Array<{ id: ContentTab; label: string; count?: number }> = [
    { id: "notice", label: "공지", count: state.notices.length },
    { id: "program", label: "일정", count: state.program.length },
    { id: "venue", label: "장소 안내" },
  ];
  const activeTab = tab;
  function selectTab(next: ContentTab) {
    // Pressing the open tab again is the way back from its editor.
    if (next === activeTab) {
      if (next === "notice" && noticeDialogOpen) closeNoticeEditor();
      if (next === "program" && programDialogOpen) closeProgramEditor();
      return;
    }
    setTab(next);
    setPreviewScreen(next);
  }
  function closeNoticeEditor() { if (canCloseNoticeDialog()) setNoticeDialogOpen(false); }
  function closeProgramEditor() { if (canCloseProgramDialog()) setProgramDialogOpen(false); }

  // Header primary: the one orange action of the open tab, hidden while that
  // tab's editor is open (the editor carries its own primary).
  const headerAdd = activeTab === "notice" && canWritePage && !noticeDialogOpen ? (
    <ProductButton type="button" variant="primary" disabled={archived || Boolean(pendingContent) || otherContentReceipt} title={archived ? archivedReason : undefined} onClick={openNoticeCreate}>공지 작성</ProductButton>
  ) : activeTab === "program" && canWritePrograms && !programDialogOpen ? (
    <ProductButton type="button" variant="primary" disabled={archived || Boolean(pendingContent) || otherContentReceipt} title={archived ? archivedReason : undefined} onClick={openProgramCreate}>일정 추가</ProductButton>
  ) : undefined;

  const noticeDirty = noticeDialogDirty;
  const programDirty = programDialogDirty;
  const displayNote = editingNotice ? noticeDisplayLabel(state, editingNotice) : "";

  return (
    <ConsolePage
      pageId="content"
      eventId={eventId} afterHeader={afterHeader}
      eventName={state.eventName}
      meta={formatConsoleEventMeta(state.eventMeta)}
      headerActions={headerAdd}
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
          <div className={styles.layout}>
            <div className={styles.work}>
              <div className={styles.tabBar}>
                <CountTabs
                  mode="tablist"
                  ariaLabel="콘텐츠 종류"
                  idPrefix="content-tab-"
                  controls="content-panel"
                  value={activeTab}
                  onChange={(key) => selectTab(key as ContentTab)}
                  items={tabs.map((item) => ({ key: item.id, label: item.label, count: item.count }))}
                />
                <ProductButton className={styles.phoneToggle} type="button" variant="secondary" onClick={() => setPreviewStageOpen(true)}>폰으로 보기</ProductButton>
              </div>
              <div id="content-panel" role="tabpanel" aria-labelledby={`content-tab-${activeTab}`} className={styles.panel}>
                {activeTab === "notice" ? (
                  noticeDialogOpen ? (
                    <div className={styles.editor}>
                      <div className={styles.editorHead}>
                        <button type="button" className={styles.crumb} disabled={noticeDialogBusy} onClick={closeNoticeEditor}><CrumbChevron />공지</button>
                        <span className={styles.editorState}>
                          {noticeDraft.id ? <ContentStatusPill status={!noticeDraft.published ? "off" : editingNotice && hasChanges(noticeChanges(editingNotice)) ? "edit" : "live"} /> : null}
                          {noticeDirty || !noticeDraft.id ? <StatusPill tone="info">{noticeDraft.id ? "저장 전 변경" : "새 항목 · 저장 전"}</StatusPill> : null}
                        </span>
                      </div>
                      <h2 id="content-notice-dialog-title" className={styles.editorTitle}><span className="sr-only">{noticeDraft.id ? "공지 편집: " : "공지 작성: "}</span>{noticeDraft.title || (noticeDraft.id ? "제목 없음" : "새 공지")}</h2>
                      <p className={styles.previewTie} data-preview-tie>편집 중인 내용은 폰 미리보기에 윤곽선으로 먼저 보입니다. 게시 전까지 참가자에게는 보이지 않습니다.</p>
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
                          <label id="content-notice-body-label" htmlFor="content-notice-body">내용</label>
                          <RichEditor
                            id="content-notice-body"
                            labelledBy="content-notice-body-label"
                            describedBy={noticeDialogFailure?.field === "body" ? "content-notice-body-error" : "content-notice-body-count"}
                            invalid={noticeDialogFailure?.field === "body"}
                            value={noticeDraft.body}
                            onChange={(body) => setNoticeDraft((current) => ({ ...current, body }))}
                            disabled={Boolean(pendingContent) || checkingContent || noticeDialogBusy || archived}
                            imageSrc={(fileId) => `/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(fileId)}`}
                            uploadImage={uploadNoticeImage}
                          />
                          <p className={`${styles.help} ${styles.fieldNote}`} id="content-notice-body-count">굵게·목록·링크·이미지를 쓸 수 있습니다. {noticeDraft.body.length} / {NOTICE_BODY_MAX}자</p>
                          {noticeDialogFailure?.field === "body" ? (
                            <p className={styles.fieldError} id="content-notice-body-error" role="alert">{noticeDialogFailure.message}</p>
                          ) : null}
                        </div>
                        <label className={styles.check}>
                          <input
                            type="checkbox"
                            checked={noticeDraft.pinned}
                            onChange={(event) => setNoticeDraft({ ...noticeDraft, pinned: event.target.checked })}
                          />
                          상단 고정
                        </label>
                        </fieldset>
                        {displayNote ? <p className={styles.help}>{displayNote}</p> : null}
                        {noticeDialogFailure && !["title", "body"].includes(noticeDialogFailure.field ?? "") && !(pendingContent?.origin === "notice" && contentRecoveryError) ? (
                          <p className={styles.fieldError} role="alert">{noticeDialogFailure.message}</p>
                        ) : null}
                        {noticeDialogFailure?.field === "expectedVersion" && !pendingContent ? <ProductButton type="button" variant="secondary" disabled={busy !== null} onClick={() => void reloadEditorDraft("notice")}>최신 초안 불러오기</ProductButton> : null}
                        {pendingContent?.origin === "notice" ? contentRecovery() : null}
                        <p className={styles.help}>{noticeDirty || !noticeDraft.id ? "초안을 저장하고 게시 검토를 거쳐 반영합니다. 게시 전까지 현재 내용이 유지됩니다." : "저장한 초안과 게시본을 비교한 뒤 게시 검토에서 참가자에게 반영합니다."}</p>
                        <ConsoleFormActions>
                          <ProductButton type="submit" variant={noticeDirty || !noticeDraft.id ? "primary" : "secondary"} disabled={noticeDialogBusy || archived || Boolean(pendingContent) || checkingContent || otherContentReceipt} title={archived ? archivedReason : undefined}>
                            {noticeDialogBusy ? "저장 중…" : "초안 저장"}
                          </ProductButton>
                          {editingNotice ? (
                            <>
                              <ProductButton type="button" variant={!noticeDirty && hasChanges(noticeChanges(editingNotice)) ? "primary" : "secondary"} disabled={gated || noticeDirty || noticeDialogBusy}
                                title={archived ? archivedReason : noticeDirty ? "초안을 먼저 저장하세요" : undefined}
                                onClick={() => openPublication("notice", editingNotice.id, editingNotice.version, true)}>게시 검토</ProductButton>
                              {editingNotice.published ? <ProductButton type="button" variant="ghost" disabled={gated || noticeDirty || noticeDialogBusy} onClick={() => openPublication("notice", editingNotice.id, editingNotice.version, false)}>게시 내리기</ProductButton> : null}
                              {canOutputNotice && editingNotice.published ? (
                                <ProductButton type="button" variant="ghost" disabled={gated || noticeDirty || noticeDialogBusy} title={archived ? archivedReason : undefined} onClick={() => requestNoticeDisplay(editingNotice)}>
                                  {busy === `notice-display:${editingNotice.id}` ? "처리 중…" : "전광판 출력"}
                                </ProductButton>
                              ) : null}
                              <ProductButton type="button" className={styles.dangerGhost} variant="destructive" disabled={gated || noticeDialogBusy} title={archived ? archivedReason : undefined} onClick={() => requestNoticeDelete(editingNotice)}>삭제</ProductButton>
                            </>
                          ) : null}
                        </ConsoleFormActions>
                        {editingNotice && noticeDisplayPendingId === editingNotice.id && canOutputNotice && editingNotice.published && noticeDeletePendingId !== editingNotice.id ? (
                          <ConsoleConfirm
                            summary={`“${editingNotice.title}” 공지를 행사장 전광판에 출력할까요? 참가자 화면과 같은 내용이 외부 화면에 나옵니다.`}
                            confirmLabel="전광판 출력"
                            busy={busy !== null}
                            onConfirm={() => void applyNoticeDisplay(editingNotice)}
                            onCancel={() => setNoticeDisplayPendingId(null)}
                          />
                        ) : null}
                        {editingNotice && noticeDeletePendingId === editingNotice.id && noticeDisplayPendingId !== editingNotice.id ? (
                          <ConsoleConfirm
                            summary={`“${editingNotice.title}” 공지를 삭제할까요?`}
                            confirmLabel="삭제한다"
                            confirmClassName="button button-danger"
                            busy={busy !== null}
                            onConfirm={() => void deleteNotice(editingNotice)}
                            onCancel={() => setNoticeDeletePendingId(null)}
                          />
                        ) : null}
                      </ValidatedForm>
                    </div>
                  ) : state.notices.length ? (
                    <>
                    <LedgerNote
                      live={state.notices.filter((item) => item.published).length}
                      waiting={state.notices.filter((item) => item.published && hasChanges(noticeChanges(item))).length}
                    />
                    <ul className={styles.ledger}>
                      {state.notices.map((item) => {
                        const edited = item.published && hasChanges(noticeChanges(item));
                        return (
                          <LedgerRow
                            key={item.id}
                            status={edited ? "edit" : item.published ? "live" : "off"}
                            title={item.draft.title}
                            summary={richSummary(item.draft.body)}
                            pinned={item.pinned}
                            note={noticeDisplayLabel(state, item)}
                            onOpen={canWritePage ? () => openNoticeEdit(item) : undefined}
                            disabled={gated}
                            disabledReason={archived ? archivedReason : undefined}
                          />
                        );
                      })}
                    </ul>
                    </>
                  ) : (
                    <ConsoleEmptyState title="등록된 공지가 없습니다." description={canWritePage ? "위 ‘공지 작성’으로 첫 공지를 작성하세요." : undefined} />
                  )
                ) : null}
                {activeTab === "program" ? (
                  programDialogOpen ? (
                    <div className={styles.editor}>
                      <div className={styles.editorHead}>
                        <button type="button" className={styles.crumb} disabled={programDialogBusy || uploadingAttachment} onClick={closeProgramEditor}><CrumbChevron />일정</button>
                        <span className={styles.editorState}>
                          {programDraft.id ? <ContentStatusPill status={!programDraft.published ? "off" : editingProgram && hasChanges(programChanges(editingProgram)) ? "edit" : "live"} /> : null}
                          {programDirty || !programDraft.id ? <StatusPill tone="info">{programDraft.id ? "저장 전 변경" : "새 항목 · 저장 전"}</StatusPill> : null}
                        </span>
                      </div>
                      <h2 id="content-program-dialog-title" className={styles.editorTitle}><span className="sr-only">{programDraft.id ? "일정 편집: " : "일정 추가: "}</span>{programDraft.title || (programDraft.id ? "제목 없음" : "새 일정")}</h2>
                      <p className={styles.previewTie} data-preview-tie>편집 중인 내용은 폰 미리보기에 윤곽선으로 먼저 보입니다. 게시 전까지 참가자에게는 보이지 않습니다.</p>
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
                                  <ProductLink href={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(programDraft.attachment.fileId)}`} target="_blank" rel="noopener noreferrer">{programDraft.attachment.name || "일정 자료(PDF)"}</ProductLink>
                                  <ProductButton
                                    type="button"
                                    variant="secondary"
                                    disabled={programDialogBusy || uploadingAttachment}
                                    onClick={() => setProgramDraft({ ...programDraft, attachment: null, attachmentDirty: true })}
                                  >
                                    첨부 제거
                                  </ProductButton>
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
                                    <ProductButton type="button" variant="secondary" disabled={uploadingAttachment || programUploadAbandonConfirm} onClick={() => { if (programUploadRef.current) void uploadProgramAttachment(programUploadRef.current.file); }}>같은 파일 요청 다시 확인</ProductButton>
                                    <ProductButton type="button" variant="secondary" disabled={uploadingAttachment || programUploadAbandonConfirm} onClick={() => setProgramUploadAbandonConfirm(true)}>파일 확인 그만두기</ProductButton>
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
                        </fieldset>
                        {programDialogFailure && !["title", "attachment"].includes(programDialogFailure.field ?? "") && !(pendingContent?.origin === "program" && contentRecoveryError) ? (
                          <p className={styles.fieldError} role="alert">{programDialogFailure.message}</p>
                        ) : null}
                        {programDialogFailure?.field === "expectedVersion" && !pendingContent ? <ProductButton type="button" variant="secondary" disabled={busy !== null} onClick={() => void reloadEditorDraft("program")}>최신 초안 불러오기</ProductButton> : null}
                        {pendingContent?.origin === "program" ? contentRecovery() : null}
                        <p className={styles.help}>{programDirty || !programDraft.id ? "초안을 저장하고 게시 검토를 거쳐 반영합니다. 게시 전까지 현재 내용이 유지됩니다." : "저장한 초안과 게시본을 비교한 뒤 게시 검토에서 참가자에게 반영합니다."}</p>
                        <ConsoleFormActions>
                          <ProductButton type="submit" variant={programDirty || !programDraft.id ? "primary" : "secondary"} disabled={programDialogBusy || uploadingAttachment || programUploadUncertain || archived || Boolean(pendingContent) || checkingContent || otherContentReceipt} title={archived ? archivedReason : undefined}>
                            {programDialogBusy ? "저장 중…" : "초안 저장"}
                          </ProductButton>
                          {editingProgram ? (
                            <>
                              <ProductButton type="button" variant={!programDirty && hasChanges(programChanges(editingProgram)) ? "primary" : "secondary"} disabled={gated || programDirty || programDialogBusy || uploadingAttachment}
                                title={archived ? archivedReason : programDirty ? "초안을 먼저 저장하세요" : undefined}
                                onClick={() => openPublication("program", editingProgram.id, editingProgram.version, true)}>게시 검토</ProductButton>
                              {editingProgram.published ? <ProductButton type="button" variant="ghost" disabled={gated || programDirty || programDialogBusy} onClick={() => openPublication("program", editingProgram.id, editingProgram.version, false)}>게시 내리기</ProductButton> : null}
                              <ProductButton type="button" className={styles.dangerGhost} variant="destructive" disabled={gated || programDialogBusy || uploadingAttachment} title={archived ? archivedReason : undefined} onClick={() => requestProgramDelete(editingProgram)}>삭제</ProductButton>
                            </>
                          ) : null}
                        </ConsoleFormActions>
                        {editingProgram && programDeletePendingId === editingProgram.id ? (
                          <ConsoleConfirm
                            summary={`“${editingProgram.title}” 일정을 삭제할까요?`}
                            confirmLabel="삭제한다"
                            confirmClassName="button button-danger"
                            busy={busy !== null}
                            onConfirm={() => void deleteProgram(editingProgram)}
                            onCancel={() => setProgramDeletePendingId(null)}
                          />
                        ) : null}
                      </ValidatedForm>
                    </div>
                  ) : state.program.length ? (
                    <>
                    <LedgerNote
                      live={state.program.filter((item) => item.published).length}
                      waiting={state.program.filter((item) => item.published && hasChanges(programChanges(item))).length}
                      hint="날짜·시작 시간 순으로 보입니다."
                    />
                    <ul className={styles.ledger}>
                      {state.program.map((item) => {
                        const edited = item.published && hasChanges(programChanges(item));
                        return (
                          <LedgerRow
                            key={item.id}
                            status={edited ? "edit" : item.published ? "live" : "off"}
                            title={item.draft.title}
                            summary={programMeta(item.draft)}
                            attachment={Boolean(item.draft.attachment)}
                            onOpen={canWritePrograms ? () => openProgramEdit(item) : undefined}
                            disabled={gated}
                            disabledReason={archived ? archivedReason : undefined}
                          />
                        );
                      })}
                    </ul>
                    </>
                  ) : (
                    <ConsoleEmptyState title="등록된 일정이 없습니다." description={canWritePrograms ? "위 ‘일정 추가’로 첫 일정을 추가하세요." : undefined} />
                  )
                ) : null}
                {activeTab === "venue" ? (
                  <div className={styles.venuePanel}>
                    {venueDirty || venueFile ? <StatusPill tone="info" align="start">저장 전 변경</StatusPill> : hasChanges(venueChanges(state.venue)) ? <StatusPill tone="wait" dot align="start">수정본 있음</StatusPill> : null}
                    <p className={styles.help}>{venueDirty || venueFile ? "작성 중입니다. 초안을 저장하면 게시 검토를 진행할 수 있습니다." : hasChanges(venueChanges(state.venue)) ? "저장한 초안이 있습니다. 게시 전까지 기존 장소 안내가 유지됩니다." : "게시된 장소 안내와 저장한 초안이 같습니다."}</p>
                    {!venueFeatureOn ? (
                      <p className={styles.featureOff} role="note">
                        장소 안내 기능이 꺼져 있습니다.{" "}
                        <ProductLink href={`/console/events/${encodeURIComponent(eventId)}/settings`}>행사 설정</ProductLink>에서
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
                            <ProductButton type="button" className={styles.venueMapRemove} variant="secondary" disabled={busy !== null || venueUploadUncertain}
                              onClick={() => { touchVenueMap(); setVenueFile(null); setVenueDraft({ ...venueDraft, map: null }); }}>안내도 제거</ProductButton>
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
                              : <ProductButton type="button" variant="secondary" disabled={busy !== null} onClick={() => setVenueUploadAbandonConfirm(true)}>파일 확인 중단</ProductButton>}
                          </div> : null}
                          {failure?.field === "map" && failure.message.includes("다른 운영자") ? venueRestoreConfirm
                            ? <ConsoleConfirm summary="작성한 안내도와 설명을 버리고 최신 안내도를 불러옵니다. 다른 장소 문구는 유지됩니다."
                                confirmLabel="최신 안내도 불러오기" onConfirm={() => void restoreLatestVenueMap()} onCancel={() => setVenueRestoreConfirm(false)} />
                            : <ProductButton type="button" className={styles.venueMapRemove} variant="secondary"
                                disabled={busy !== null} onClick={() => setVenueRestoreConfirm(true)}>최신 안내도 불러오기</ProductButton> : null}
                        </div>
                        {failure?.field === "expectedVersion" && !pendingContent ? <ProductButton type="button" variant="secondary" disabled={busy !== null} onClick={() => void reloadEditorDraft("venue")}>최신 장소 초안 불러오기</ProductButton> : null}
                        <ConsoleFormActions>
                          <ProductButton
                            type="submit"
                            variant="primary"
                            disabled={busy !== null || !venueFeatureOn || archived || Boolean(pendingContent) || otherContentReceipt}
                            title={archived ? archivedReason : venueFeatureOn ? undefined : "행사 설정에서 장소 안내 기능을 먼저 켜세요"}
                          >
                            {busy === "venue:save" ? "저장 중…" : "초안 저장"}
                          </ProductButton>
                          <ProductButton type="button" variant="secondary" disabled={busy !== null || !venueFeatureOn || archived || venueDirty || Boolean(venueFile) || venueUploadUncertain || Boolean(pendingContent) || otherContentReceipt || !hasChanges(venueChanges(state.venue))} onClick={() => openPublication("venue", "", state.venue.version, true)}>게시 검토</ProductButton>
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
                  </div>
                ) : null}
              </div>
            </div>
            <div className={styles.railHost}>{renderPhone("rail")}</div>
          </div>
        </>
      )}

      {previewStageOpen ? (
        <ConsoleDialog titleId="content-phone-title" title="참가자 폰 미리보기" presentation="stage" onClose={() => setPreviewStageOpen(false)}>
          {renderPhone("stage")}
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
        {publicationConflict && !review.stale ? <ProductButton type="button" variant="secondary" disabled={busy !== null} onClick={() => {
          setBusy("publication:reload");
          void load(true).finally(() => setBusy(null));
        }}>최신 내용 다시 불러오기</ProductButton> : null}
        {pendingContent ? contentRecovery() : null}
      </PublicationReview> : null}
    </ConsolePage>
  );
}

