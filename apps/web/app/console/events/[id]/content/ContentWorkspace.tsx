"use client";

import { useEffect, useRef, useState } from "react";
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
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./content.module.css";
import { consoleFetch } from "../../../../../lib/console-api";
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

type Attachment = { fileId: string; name: string };

type Notice = {
  id: string;
  title: string;
  body: string;
  published: boolean;
  pinned: boolean;
  at: string;
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
};

type Venue = {
  name: string;
  address: string;
  directions: string;
  contact: string;
  description: string;
};

type WorkspaceState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | {
      kind: "ready";
      eventName: string;
      stage: string;
      eventMeta: ConsoleEventMeta;
      features: string[];
      role: string;
      userId: string;
      memberships: Array<{ accountId: string; eventId: string; write?: unknown }>;
      notices: Notice[];
      program: ProgramItem[];
      venue: Venue;
      screenEnabled: boolean;
      display: { type: string; noticeId: string };
    };

type Failure = { message: string; field: string | null };

type NoticeDraft = {
  id: string;
  title: string;
  body: string;
  published: boolean;
  pinned: boolean;
};

type ProgramDraft = {
  id: string;
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
  title: "",
  body: "",
  published: false,
  pinned: false,
};

const EMPTY_PROGRAM_DRAFT: ProgramDraft = {
  id: "",
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
  };
}

function parseVenue(value: unknown): Venue {
  const item = asRecord(value) ?? {};
  return {
    name: text(item.name),
    address: text(item.address),
    directions: text(item.directions),
    contact: text(item.contact),
    description: text(item.description),
  };
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

  const [venueDraft, setVenueDraft] = useState<Venue | null>(null);

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

  async function load(silent = false) {
    if (!silent) setState({ kind: "loading" });
    try {
      const [meRes, bootRes] = await Promise.all([
        consoleFetch("/api/auth/me", { cache: "no-store" }),
        consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
      ]);
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(loginHrefForLocation(window.location.pathname, window.location.search));
        return;
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
      const bootstrap = boot?.state;
      if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
        setState({ kind: "failed", message: "콘텐츠 정보를 불러오지 못했습니다." });
        return;
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
        setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        return;
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
      const venue = parseVenue(workspace.venue);
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
        if (current && baseline && JSON.stringify(current) !== JSON.stringify(baseline)) return current;
        return venue;
      });
      venueBaselineRef.current = venue;
    } catch {
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

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
    noticeDialogDirty || programDialogDirty || venueDirty || uploadingAttachment,
    "작성 중인 콘텐츠나 저장하지 않은 장소 안내가 있습니다. 페이지를 떠나면 사라집니다."
  );

  async function postCommand(command: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (archived) {
      throw new CommandFailure({ message: "보관된 행사는 읽기 전용입니다.", field: null });
    }
    if (commandBusyRef.current) {
      throw new CommandFailure({ message: "처리 중입니다. 잠시 뒤 다시 시도하세요.", field: null });
    }
    commandBusyRef.current = true;
    const fingerprint = `${command}:${JSON.stringify(payload)}`;
    let commandId = commandIdCache.current.get(fingerprint);
    if (!commandId) {
      commandId = randomCommandId();
      commandIdCache.current.set(fingerprint, commandId);
    }
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId, command, payload }),
      });
      const data = (await response.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } & Record<string, unknown> | null;
      if (!response.ok) {
        throw new CommandFailure({
          message: typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : null,
        });
      }
      commandIdCache.current.delete(fingerprint);
      return data ?? {};
    } finally {
      commandBusyRef.current = false;
    }
  }

  function openNoticeCreate() {
    noticeInitialRef.current = { ...EMPTY_NOTICE_DRAFT };
    setNoticeDraft(EMPTY_NOTICE_DRAFT);
    setNoticeDialogFailure(null);
    setNoticeDialogOpen(true);
  }

  function openNoticeEdit(item: Notice) {
    const snapshot = {
      id: item.id,
      title: item.title,
      body: item.body,
      published: item.published,
      pinned: item.pinned,
    };
    noticeInitialRef.current = snapshot;
    setNoticeDraft(snapshot);
    setNoticeDialogFailure(null);
    setNoticeDialogOpen(true);
  }

  // Dismissal gate for the shared dialog (Escape/backdrop/Cancel): a dirty
  // draft asks once instead of silently discarding typed input.
  function canCloseNoticeDialog(): boolean {
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
        published: noticeDraft.published,
        pinned: noticeDraft.pinned,
      };
      if (noticeDraft.id) payload.id = noticeDraft.id;
      await postCommand("notice.save", payload);
      setNoticeDialogOpen(false);
      setNotice(noticeDraft.id ? "공지를 저장했습니다." : "공지를 만들었습니다.");
      setFailure(null);
      await load(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장하지 못했습니다.";
      const field = error instanceof CommandFailure ? error.field : null;
      setNoticeDialogFailure({ message, field });
    } finally {
      setNoticeDialogBusy(false);
    }
  }

  async function toggleNoticePublish(item: Notice) {
    const action = item.published ? "비게시" : "게시";
    setBusy(`notice-publish:${item.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("notice.save", {
        id: item.id,
        title: item.title,
        body: item.body,
        published: !item.published,
        pinned: item.pinned,
      });
      setNotice(`공지를 ${action}했습니다.${item.published ? "" : " 참가자 화면에 보입니다."}`);
      await load(true);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "게시 상태를 바꾸지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
    }
  }

  async function toggleNoticePin(item: Notice) {
    const action = item.pinned ? "고정 해제" : "고정";
    setBusy(`notice-pin:${item.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("notice.save", {
        id: item.id,
        title: item.title,
        body: item.body,
        published: item.published,
        pinned: !item.pinned,
      });
      setNotice(`공지를 ${action}했습니다.`);
      await load(true);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "고정 상태를 바꾸지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
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
    programInitialRef.current = { ...EMPTY_PROGRAM_DRAFT };
    setProgramDraft({ ...EMPTY_PROGRAM_DRAFT });
    setProgramDialogFailure(null);
    setProgramDialogOpen(true);
  }

  function openProgramEdit(item: ProgramItem) {
    const snapshot = {
      id: item.id,
      title: item.title,
      date: item.date,
      start: item.start,
      end: item.end,
      place: item.place,
      description: item.description,
      published: item.published,
      attachment: item.attachment,
      attachmentDirty: false,
    };
    programInitialRef.current = snapshot;
    setProgramDraft(snapshot);
    setProgramDialogFailure(null);
    setProgramDialogOpen(true);
  }

  function canCloseProgramDialog(): boolean {
    if (JSON.stringify(programDraft) === JSON.stringify(programInitialRef.current)) return true;
    return window.confirm("작성 중인 내용이 사라집니다. 닫을까요?");
  }

  async function uploadProgramAttachment(file: File) {
    if (!PROGRAM_ATTACHMENT_TYPES.includes(file.type)) {
      setProgramDialogFailure({ message: "일정 자료는 PDF로 올려주세요.", field: "attachment" });
      return;
    }
    if (file.size > PROGRAM_ATTACHMENT_MAX_BYTES) {
      setProgramDialogFailure({ message: "600KB 이하 파일을 올려주세요.", field: "attachment" });
      return;
    }
    setUploadingAttachment(true);
    setProgramDialogFailure(null);
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/files?name=${encodeURIComponent(file.name)}&commandId=${encodeURIComponent(randomCommandId())}`,
        { method: "POST", headers: { "content-type": file.type }, body: file }
      );
      const data = (await res.json().catch(() => null)) as {
        file?: { fileId?: unknown; name?: unknown };
        error?: unknown;
      } | null;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      if (!res.ok || !fileId) {
        setProgramDialogFailure({
          message: typeof data?.error === "string" ? data.error : "파일을 올리지 못했습니다.",
          field: "attachment",
        });
        return;
      }
      setProgramDraft((current) => ({
        ...current,
        attachment: {
          fileId,
          name: typeof data?.file?.name === "string" ? data.file.name : file.name,
        },
        attachmentDirty: true,
      }));
    } catch {
      setProgramDialogFailure({ message: "연결하지 못했습니다. 다시 시도하세요.", field: "attachment" });
    } finally {
      setUploadingAttachment(false);
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
        published: programDraft.published,
      };
      if (programDraft.id) payload.id = programDraft.id;
      // The server keeps the stored attachment unless the key is present:
      // absent means untouched, null means cleared, { fileId } means replaced.
      if (programDraft.attachmentDirty) {
        payload.attachment = programDraft.attachment
          ? { fileId: programDraft.attachment.fileId }
          : null;
      }
      await postCommand("program.save", payload);
      setProgramDialogOpen(false);
      setNotice(programDraft.id ? "일정을 저장했습니다." : "일정을 만들었습니다.");
      setFailure(null);
      await load(true);
    } catch (error) {
      const message = error instanceof Error ? error.message : "저장하지 못했습니다.";
      const field = error instanceof CommandFailure ? error.field : null;
      setProgramDialogFailure({ message, field });
    } finally {
      setProgramDialogBusy(false);
    }
  }

  async function toggleProgramPublish(item: ProgramItem) {
    const action = item.published ? "비게시" : "게시";
    setBusy(`program-publish:${item.id}`);
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("program.save", {
        id: item.id,
        title: item.title,
        date: item.date,
        start: item.start,
        end: item.end,
        place: item.place,
        description: item.description,
        published: !item.published,
      });
      setNotice(`일정을 ${action}했습니다.${item.published ? "" : " 참가자 화면에 보입니다."}`);
      await load(true);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "게시 상태를 바꾸지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
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

  async function saveVenue(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!venueDraft) return;
    setBusy("venue:save");
    setNotice(null);
    setFailure(null);
    try {
      await postCommand("venue.save", { ...venueDraft });
      setNotice("장소 안내를 저장했습니다.");
      await load(true);
    } catch (error) {
      setFailure({
        message: error instanceof Error ? error.message : "저장하지 못했습니다.",
        field: error instanceof CommandFailure ? error.field : null,
      });
    } finally {
      setBusy(null);
    }
  }

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
          <p className={styles.navIndexLabel} aria-hidden="true">콘텐츠 목차</p>
          <ConsoleSectionNav
            label="콘텐츠 구역"
            items={[
              { id: "content-notices", label: "공지" },
              { id: "content-program", label: "프로그램 일정" },
              { id: "content-venue", label: "장소 안내" },
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
          {failure && !noticeDialogOpen && !programDialogOpen ? (
            <ConsoleFeedback kind="error" id="content-error">{failure.message}</ConsoleFeedback>
          ) : null}
        </>
      )}
    >
      {!canWritePage && !canWritePrograms ? (
        <ConsoleFeedback kind="error">콘텐츠를 관리할 운영 권한이 없습니다.</ConsoleFeedback>
      ) : (
        <>
          {!canWritePage ? (
            <ConsoleFeedback kind="warning">공지·장소 쓰기 권한이 없습니다. 일정만 볼 수 있으며, 변경이 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {!canWritePrograms ? (
            <ConsoleFeedback kind="warning">프로그램 일정 변경은 참여 프로그램 쓰기 권한이 필요합니다. 일정 목록은 볼 수 있으며, 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          <ConsoleSection
            headingId="content-notices"
            title="공지"
            description="게시한 항목만 참가자에게 보입니다."
            action={canWritePage ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={archived}
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
                        {item.title}
                      </h3>
                      <p className={`${uiStyles.recordMeta} ${styles.badgeRow}`}>
                        <span className={`${styles.badge} ${item.published ? styles.badgeOn : styles.badgeOff}`}>
                          {item.published ? "게시 중" : "비공개"}
                        </span>
                        {item.pinned ? <span className={styles.badge}>고정됨</span> : null}                        {displayBadge ? (
                          <span className={`${styles.badge} ${displayBadge.live ? styles.badgeOn : ""}`}>
                            {displayBadge.text}
                          </span>
                        ) : null}
                      </p>
                      {item.body ? <p className={`${styles.body} preserve-lines`}>{item.body}</p> : null}
                    </div>
                    {canWritePage ? (
                    <div className={`${uiStyles.recordActions} ${styles.compactActions}`}>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived}
                        title={archived ? archivedReason : undefined}
                        onClick={() => openNoticeEdit(item)}
                      >
                        편집
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived}
                        title={archived ? archivedReason : undefined}
                        onClick={() => void toggleNoticePublish(item)}
                      >
                        {busy === `notice-publish:${item.id}` ? "처리 중…" : item.published ? "비게시" : "게시"}
                      </button>
                      <span className={styles.actionSeparator} aria-hidden="true" />
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived}
                        title={archived ? archivedReason : undefined}
                        onClick={() => void toggleNoticePin(item)}
                      >
                        {item.pinned ? "고정 해제" : "고정"}
                      </button>
                      {canOutput ? (
                        <>
                        <span className={styles.actionSeparator} aria-hidden="true" />
                        <button
                          type="button"
                          className="button button-secondary"
                          disabled={busy !== null || archived}
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
                        disabled={busy !== null || archived}
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
            description="날짜·시작 시간 순으로 정렬되어 참가자에게 보입니다."
            action={canWritePrograms ? (
              <button
                type="button"
                className="button button-secondary"
                disabled={archived}
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
                      <h3 className={styles.recordTitle}>{item.title}</h3>
                      <p className={`${uiStyles.recordMeta} ${styles.badgeRow}`}>
                        <span className={`${styles.badge} ${item.published ? styles.badgeOn : styles.badgeOff}`}>
                          {item.published ? "게시 중" : "비공개"}
                        </span>
                        <span>
                          {[item.date, item.start && item.end ? `${item.start} ~ ${item.end}` : item.start, item.place]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </p>
                      {item.description ? <p className={styles.body}>{item.description}</p> : null}
                      {item.attachment ? (
                        <p className={styles.attachment}>
                          첨부:{" "}
                          <Link href={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(item.attachment.fileId)}`}>
                            {item.attachment.name || "일정 자료(PDF)"}
                          </Link>
                        </p>
                      ) : null}
                    </div>
                    {canWritePrograms ? (
                    <div className={`${uiStyles.recordActions} ${styles.compactActions}`}>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived}
                        title={archived ? archivedReason : undefined}
                        onClick={() => openProgramEdit(item)}
                      >
                        편집
                      </button>
                      <button
                        type="button"
                        className="button button-secondary"
                        disabled={busy !== null || archived}
                        title={archived ? archivedReason : undefined}
                        onClick={() => void toggleProgramPublish(item)}
                      >
                        {busy === `program-publish:${item.id}` ? "처리 중…" : item.published ? "비게시" : "게시"}
                      </button>
                      <span className={styles.actionSeparator} aria-hidden="true" />
                      <button
                        type="button"
                        className={`button button-secondary ${styles.dangerGhost}`}
                        disabled={busy !== null || archived}
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

          <ConsoleSection headingId="content-venue" title="장소 안내" width="form">
            {!venueFeatureOn ? (
              <p className={styles.featureOff} role="note">
                장소 안내 기능이 꺼져 있습니다.{" "}
                <Link href={`/console/events/${encodeURIComponent(eventId)}/settings`}>행사 설정</Link>에서
                기능을 먼저 켜세요. 켜기 전에는 저장이 반영되지 않습니다.
              </p>
            ) : null}
            {venueDraft && canWritePage ? (
              <form className={uiStyles.formStack} onSubmit={(event) => void saveVenue(event)}>
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
                  <textarea
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
                  <textarea
                    id="content-venue-description"
                    rows={3}
                    maxLength={VENUE_LIMITS.description}
                    value={venueDraft.description}
                    onChange={(event) => setVenueDraft({ ...venueDraft, description: event.target.value })}
                  />
                </div>
                </div>
                <ConsoleFormActions>
                  <button
                    type="submit"
                    className="button button-secondary"
                    disabled={busy !== null || !venueFeatureOn || archived}
                    title={archived ? archivedReason : venueFeatureOn ? undefined : "행사 설정에서 장소 안내 기능을 먼저 켜세요"}
                  >
                    {busy === "venue:save" ? "저장 중…" : "장소 안내 저장"}
                  </button>
                </ConsoleFormActions>
              </form>
            ) : !canWritePage ? (
              <div className={uiStyles.recordMain}>
                <span>장소 이름: {state.venue.name || "미등록"}</span>
                <p className={uiStyles.recordMeta}>주소: {state.venue.address || "미등록"}</p>
                <p className={uiStyles.recordMeta}>길찾기: {state.venue.directions || "미등록"}</p>
                <p className={uiStyles.recordMeta}>문의: {state.venue.contact || "미등록"}</p>
                <p className={uiStyles.recordMeta}>안내 문구: {state.venue.description || "미등록"}</p>
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
          <form className={uiStyles.formStack} onSubmit={(event) => void saveNotice(event)}>
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
              <textarea
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
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={noticeDraft.published}
                onChange={(event) => setNoticeDraft({ ...noticeDraft, published: event.target.checked })}
              />
              게시함 (참가자 화면에 보임)
            </label>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={noticeDraft.pinned}
                onChange={(event) => setNoticeDraft({ ...noticeDraft, pinned: event.target.checked })}
              />
              상단 고정
            </label>
            {noticeDialogFailure && !noticeDialogFailure.field ? (
              <p className={styles.fieldError} role="alert">{noticeDialogFailure.message}</p>
            ) : null}
            <ConsoleFormActions>
              <button
                type="button"
                className="button button-secondary"
                disabled={noticeDialogBusy}
                onClick={() => { if (canCloseNoticeDialog()) setNoticeDialogOpen(false); }}
              >
                취소
              </button>
              <button type="submit" className="button button-primary" disabled={noticeDialogBusy || archived} title={archived ? archivedReason : undefined}>
                {noticeDialogBusy ? "저장 중…" : noticeDraft.id ? "저장" : "만들기"}
              </button>
            </ConsoleFormActions>
          </form>
        </ConsoleDialog>
      ) : null}

      {programDialogOpen && state.kind === "ready" ? (
        <ConsoleDialog
          titleId="content-program-dialog-title"
          title={programDraft.id ? "일정 편집" : "일정 추가"}
          busy={programDialogBusy}
          canClose={canCloseProgramDialog}
          onClose={() => setProgramDialogOpen(false)}
        >
          <form className={uiStyles.formStack} onSubmit={(event) => void saveProgram(event)}>
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
              <textarea
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
                  disabled={programDialogBusy || uploadingAttachment || archived}
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
              {programDialogFailure?.field === "attachment" ? (
                <p className={styles.fieldError} id="content-program-attachment-error" role="alert">{programDialogFailure.message}</p>
              ) : null}
            </div>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={programDraft.published}
                onChange={(event) => setProgramDraft({ ...programDraft, published: event.target.checked })}
              />
              게시함 (참가자 화면에 보임)
            </label>
            {programDialogFailure && !programDialogFailure.field ? (
              <p className={styles.fieldError} role="alert">{programDialogFailure.message}</p>
            ) : null}
            <ConsoleFormActions>
              <button
                type="button"
                className="button button-secondary"
                disabled={programDialogBusy || uploadingAttachment}
                onClick={() => { if (canCloseProgramDialog()) setProgramDialogOpen(false); }}
              >
                취소
              </button>
              <button type="submit" className="button button-primary" disabled={programDialogBusy || uploadingAttachment || archived} title={archived ? archivedReason : undefined}>
                {programDialogBusy ? "저장 중…" : programDraft.id ? "저장" : "만들기"}
              </button>
            </ConsoleFormActions>
          </form>
        </ConsoleDialog>
      ) : null}
    </ConsolePage>
  );
}
