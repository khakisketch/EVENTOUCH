"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { useConsoleDraftGuard } from "../../../console-draft-guard";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import uiStyles from "../../../console-ui/console-ui.module.css";
import styles from "./MessagingWorkspace.module.css";

type Template = {
  id: string;
  name: string;
  channel: string;
  body: string;
  solapiTemplateId: string;
};
type Participant = { id: string; name: string; company: string; phone: string; status: string };
type Delivery = { participantId: string; name: string; status: string; at: string };
type Campaign = {
  id: string;
  title: string;
  channel: string;
  body: string;
  templateId: string;
  recipientIds: string[];
  status: string;
  scheduled: string;
  simulate: boolean;
  at: string;
  attempts: number;
  imageFileId: string;
  imageName: string;
  deliveries: Delivery[];
};
type ReadyState = {
  kind: "ready";
  eventName: string;
  eventDate: string;
  stage: string;
  eventMeta: ConsoleEventMeta;
  canManage: boolean;
  participants: Participant[];
  templates: Template[];
  campaigns: Campaign[];
};
type WorkspaceState = { kind: "loading" } | { kind: "failed"; message: string } | ReadyState;
type TemplateDraft = {
  id: string;
  name: string;
  channel: string;
  body: string;
  solapiTemplateId: string;
};
type CampaignDraft = {
  title: string;
  channel: string;
  body: string;
  scheduled: string;
  simulate: boolean;
  imageFileId: string;
  imageName: string;
};
type CommandResult = Record<string, unknown>;
type ServerError = { message: string; field: string | null };
// In-place confirm for the compose submit: the validated payload snapshot
// plus the exact summary the operator confirms. Confirming runs the
// existing send and clears the slot; cancelling only clears it.
type SendPending = {
  payload: Record<string, unknown>;
  id: string;
  summary: string;
  confirmLabel: string;
};

const EMPTY_TEMPLATE: TemplateDraft = {
  id: "",
  name: "",
  channel: "SMS",
  body: "",
  solapiTemplateId: "",
};
const EMPTY_CAMPAIGN: CampaignDraft = {
  title: "",
  channel: "SMS",
  body: "",
  scheduled: "",
  simulate: false,
  imageFileId: "",
  imageName: "",
};
const FIELD_LABELS: Record<string, string> = {
  name: "템플릿 이름",
  channel: "메시지 채널",
  body: "메시지 내용",
  solapiTemplateId: "Solapi 승인 템플릿 ID",
  title: "발송 제목",
  templateId: "승인된 알림톡 템플릿",
  imageFileId: "첨부 이미지",
  ids: "발송 대상",
  scheduled: "예약 시각",
};
const ATTENTION_STATUSES = ["FAILED", "PARTIAL", "NEEDS_CONNECTION"];
const RECIPIENT_STATUS_OPTIONS = [
  { value: "APPROVED", label: "참가 확정" },
  { value: "PENDING", label: "승인 대기" },
  { value: "WAITLIST", label: "대기 명단" },
  { value: "ALL", label: "전체" },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function commandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function fingerprintFor(command: string, payload: Record<string, unknown>): string {
  return `${command}|${stableStringify(payload)}`;
}

// 408 and 5xx leave the outcome unknown (the receipt may exist), so the
// caller must keep the id and retry the same request. Other 4xx are settled
// rejections: the server did not apply anything, so a corrected request may
// use a fresh id.
function isAmbiguousStatus(status: number): boolean {
  return status >= 500 || status === 408;
}

function channelLabel(channel: string): string {
  switch (channel) {
    case "LMS": return "LMS · 장문";
    case "MMS": return "MMS · 사진";
    case "ALIMTALK": return "알림톡";
    case "SMS": return "SMS · 단문";
    default: return "채널 확인 필요";
  }
}

// Effect-command summaries, moved verbatim from the previous native
// confirms (counts, channel, cost, no-undo and schedule notices). Newlines
// render as breaks so no information is dropped inside the confirm region.
function confirmLines(message: string): ReactNode {
  const parts = message.split("\n");
  return parts.flatMap((line, index) => (index === 0 ? [line] : [<br key={index} />, line]));
}

function campaignCreateSummary(args: {
  scheduled: boolean;
  simulate: boolean;
  isMms: boolean;
  count: number;
  riskLine: string;
}): string {
  if (args.scheduled) {
    return `선택 ${args.count}명에게 예약 등록(수동 실행)을 진행할까요?\n\n예약 시각 이후 이 화면에서 발송 실행을 눌러야 합니다. 자동 발송은 지원하지 않습니다.${args.simulate ? " 실행해도 수신자에게 전달되지 않습니다." : ""}${args.isMms && !args.simulate ? " MMS 사진 문자로 발송되며 별도 요금이 발생합니다." : ""}${args.riskLine}`;
  }
  if (args.simulate) {
    return `선택 ${args.count}명에게 모의 발송 기록을 진행할까요?\n\n모의 발송은 실제로 전달되지 않습니다.${args.riskLine}`;
  }
  if (args.isMms) {
    return `선택 ${args.count}명에게 발송 요청을 진행할까요?\n\nMMS 사진 문자로 발송을 시도합니다. 별도 요금이 발생하며 발송은 되돌릴 수 없습니다.${args.riskLine}`;
  }
  return `선택 ${args.count}명에게 발송 요청을 진행할까요?\n\n공급사가 연결되어 있으면 즉시 실제 발송을 시도합니다. 발송은 되돌릴 수 없습니다.${args.riskLine}`;
}

function retrySummary(campaign: Campaign, label: "retry" | "execute"): string {
  // Stored mode, not the composer draft: a simulated reservation must never
  // execute under real-delivery/cost/no-undo wording.
  const storedSimulate = campaign.simulate === true;
  if (storedSimulate) {
    return "모의 예약을 실행할까요?\n\n예약 시각이 되어 실행하면 모의 기록으로 남습니다. 실행해도 수신자에게 전달되지 않습니다.";
  }
  if (label === "execute") {
    return "예약된 발송을 지금 실행할까요?\n\n공급사가 연결되어 있으면 즉시 실제 발송을 시도합니다. 발송은 되돌릴 수 없습니다.";
  }
  return "재시도하면 공급사가 연결된 경우 즉시 다시 발송합니다. 미연동이면 연결 필요 상태로 남습니다.\n발송은 되돌릴 수 없습니다. 계속할까요?";
}

function cancelSummary(campaign: Campaign): string {
  const scheduled = campaign.status === "SCHEDULED";
  return scheduled
    ? "예약을 취소할까요?\n\n취소하면 이후 발송 실행을 할 수 없습니다. 이미 공급사가 접수한 발송은 취소할 수 없습니다."
    : "발송 요청을 취소할까요?\n\n취소하면 이후 재시도로 발송되지 않습니다. 이미 공급사가 접수한 발송은 취소할 수 없습니다.";
}

function participantStatusLabel(status: string): string {
  switch (status) {
    case "APPROVED": return "참가 확정";
    case "WAITLIST": return "대기 명단";
    case "CANCELLED": return "신청 취소";
    case "PENDING": return "승인 대기";
    default: return "상태 확인 필요";
  }
}

// Mirrors ParticipantList maskPhone: same-name/same-company recipients stay
// distinguishable here without exposing full digits on the console.
function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length < 8) return "연락처 확인 필요";
  return `${digits.slice(0, 3)}-****-${digits.slice(-4)}`;
}

function messageStatusLabel(status: string): string {
  switch (status) {
    case "NEEDS_CONNECTION": return "연결 필요";
    case "SIMULATED": return "모의 발송 · 전달 없음";
    case "SCHEDULED": return "예약";
    case "SENDING": return "발송 중";
    case "SENT": return "발송 완료";
    case "PARTIAL": return "일부 실패";
    case "FAILED": return "발송 실패";
    case "CANCELLED": return "취소";
    default: return "상태 확인 필요";
  }
}

function deliveryStatusLabel(status: string): string {
  switch (status) {
    case "UNCONNECTED": return "공급자 미연동";
    case "SIMULATED": return "모의 발송 · 전달 없음";
    case "WAITING": return "예약 대기";
    case "SENDING": return "접수 · 도달 확인 중";
    case "SENT": return "전달 확인";
    case "FAILED": return "실패";
    case "CANCELLED": return "취소";
    default: return "상태 확인 필요";
  }
}

function statusTone(status: string): string {
  if (status === "SENT") return styles.statusGood;
  if (["FAILED", "PARTIAL"].includes(status)) return styles.statusBad;
  if (["NEEDS_CONNECTION", "UNCONNECTED", "SIMULATED"].includes(status)) return styles.statusWarning;
  return styles.statusNeutral;
}

function formatDate(value: string): string {
  if (!value) return "기록 시각 확인 중";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "기록 시각 확인 중";
  return new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function serverError(value: unknown): ServerError {
  const data = asRecord(value);
  return {
    message: text(data?.error, "요청을 처리하지 못했습니다."),
    field: typeof data?.field === "string" ? data.field : null,
  };
}

function parseTemplate(value: unknown): Template | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string") return null;
  return {
    id: item.id,
    name: text(item.name),
    channel: text(item.channel, "SMS"),
    body: text(item.body),
    solapiTemplateId: text(item.solapiTemplateId),
  };
}

function parseParticipant(value: unknown): Participant | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  return {
    id: item.id,
    name: text(item.name, "이름 미등록"),
    company: text(item.company),
    phone: text(item.phone),
    status: text(item.status, "PENDING"),
  };
}

function parseDelivery(value: unknown): Delivery | null {
  const item = asRecord(value);
  if (!item) return null;
  return {
    participantId: text(item.participantId),
    name: text(item.name, "이름 미등록"),
    status: text(item.status),
    at: text(item.at),
  };
}

function parseCampaign(value: unknown): Campaign | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string") return null;
  return {
    id: item.id,
    title: text(item.title, "제목 없는 발송"),
    channel: text(item.channel, "SMS"),
    recipientIds: Array.isArray(item.recipientIds)
      // Server dedupes ids by contract; dedupe here too so a stray
      // duplicate never inflates the reload exclusion count below.
      ? [...new Set(item.recipientIds.filter((id): id is string => typeof id === "string"))]
      : [],
    status: text(item.status),
    scheduled: text(item.scheduled),
    // Server persists simulate on every message (content-results.js); the
    // history and retry copy below must read this stored mode, never the
    // composer's draft flag, or a simulated reservation executes under
    // real-delivery wording.
    simulate: item.simulate === true,
    at: text(item.at),
    attempts: typeof item.attempts === "number" ? item.attempts : 0,
    // Server persists the full compose snapshot on every message
    // (content-results.js bootstrap): body, templateId and the MMS image
    // reference live here so a FAILED campaign can be reloaded without
    // retyping. The image may arrive nested (image.fileId/name) or flat.
    body: text(item.body),
    templateId: text(item.templateId),
    imageFileId: text(asRecord(item.image)?.fileId) || text(item.imageFileId),
    imageName: text(asRecord(item.image)?.name) || text(item.imageName),
    deliveries: Array.isArray(item.deliveries)
      ? item.deliveries.flatMap((delivery) => {
          const parsed = parseDelivery(delivery);
          return parsed ? [parsed] : [];
        })
      : [],
  };
}

class CommandFailure extends Error {
  field: string | null;

  constructor(error: ServerError) {
    super(error.message);
    this.field = error.field;
  }
}

export default function MessagingWorkspace({ eventId }: { eventId: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const attentionParam = searchParams.get("attention");
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [templateDraft, setTemplateDraft] = useState<TemplateDraft>(EMPTY_TEMPLATE);
  const [campaignDraft, setCampaignDraft] = useState<CampaignDraft>(EMPTY_CAMPAIGN);
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [templateFieldError, setTemplateFieldError] = useState<{ field: string; message: string } | null>(null);
  const [campaignFieldError, setCampaignFieldError] = useState<{ field: string; message: string } | null>(null);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const [campaignNotice, setCampaignNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // Compose submit confirm (payload snapshot + summary) and one history-row
  // confirm at a time. Triggers stay; confirms render in place below them.
  const [sendPending, setSendPending] = useState<SendPending | null>(null);
  // The recipient list opens while someone is picking people and folds away
  // afterwards, so the send controls stay near the top of the composer.
  const [recipientListOpen, setRecipientListOpen] = useState(false);
  const [historyPending, setHistoryPending] = useState<{
    id: string;
    kind: "retry" | "execute" | "cancel";
  } | null>(null);
  // FAILED reload overwrite guard: set when the composer already holds a
  // draft/selection and the operator asks to load a failed campaign. The
  // in-place ConsoleConfirm below replaces the draft only on confirm.
  const [reloadPending, setReloadPending] = useState<{ id: string } | null>(null);
  // Reloaded-source summary: info (not success/sent) rendered immediately
  // before the composer title, so the source/counts stay visible where the
  // operator reviews them. Never duplicated into the global campaignNotice.
  const [reloadSummary, setReloadSummary] = useState<string | null>(null);
  const [recipientQuery, setRecipientQuery] = useState("");
  const [recipientStatus, setRecipientStatus] = useState("APPROVED");
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState(10);
  const handoffAppliedRef = useRef<string | null>(null);
  const historyListRef = useRef<HTMLUListElement | null>(null);
  // First newly revealed campaign to focus after 이전 발송 더 보기: rows
  // insert before the focused button, so without this the final reveal drops
  // focus when the button unmounts.
  const pendingHistoryFocusRef = useRef<number | null>(null);
  const [ambiguousRetryIds, setAmbiguousRetryIds] = useState<string[]>([]);
  const [ambiguousSyncIds, setAmbiguousSyncIds] = useState<string[]>([]);
  const [ambiguousCancelIds, setAmbiguousCancelIds] = useState<string[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  // Re-render clock so a future reservation becomes executable (발송 실행)
  // while the page stays open. No API polling — the operator refreshes
  // status explicitly — and no scheduler worker is implemented.
  const [nowTick, setNowTick] = useState(0);

  // Safe-repeat receipts. The id lives in a ref (not state) so a re-render
  // between submit and response cannot mint a second id for one request.
  // The same command+payload fingerprint reuses the id; any edit produces a
  // new fingerprint and therefore a fresh id. Entries clear only on proven
  // success or a settled non-retryable 4xx; network errors, >=500, 408 and
  // malformed success payloads keep the entry for a same-request retry.
  // The create slot additionally tracks attempted: false at confirm staging
  // (no bytes sent yet), true once executeCampaignCreate actually posts.
  // Guards that must distinguish "staged but unsent" from "transmitted but
  // unconfirmed" (failedReloadBlocked) key on attempted, never on mere
  // slot presence.
  const campaignCreateRef = useRef<{ fingerprint: string; commandId: string; attempted: boolean } | null>(null);
  const templateSaveRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  const retryRefs = useRef(new Map<string, { fingerprint: string; commandId: string }>());
  const syncRefs = useRef(new Map<string, { fingerprint: string; commandId: string }>());
  const cancelRefs = useRef(new Map<string, { fingerprint: string; commandId: string }>());

  // Synchronous in-flight gate shared by every command handler. React state
  // updates don't apply until the next render, so two same-turn submissions
  // (double-click, Enter key repeat) would both pass a `busyAction !== null`
  // check and overlap. This ref flips synchronously instead.
  const inFlightRef = useRef(false);

  function beginAction(label: string): boolean {
    if (inFlightRef.current) return false;
    inFlightRef.current = true;
    setBusyAction(label);
    return true;
  }

  function endAction() {
    inFlightRef.current = false;
    setBusyAction(null);
  }

  function takeCommandId(
    slot: { current: { fingerprint: string; commandId: string; attempted?: boolean } | null },
    fingerprint: string
  ): string {
    if (slot.current && slot.current.fingerprint === fingerprint) return slot.current.commandId;
    // A freshly staged id has not been transmitted: attempts stay false
    // until the executor actually posts (see executeCampaignCreate), so an
    // unsent or cancelled confirmation never reads as ambiguous.
    const next = { fingerprint, commandId: commandId(), attempted: false };
    slot.current = next;
    return next.commandId;
  }

  function takeMapCommandId(
    slot: { current: Map<string, { fingerprint: string; commandId: string }> },
    key: string,
    fingerprint: string
  ): string {
    const existing = slot.current.get(key);
    if (existing && existing.fingerprint === fingerprint) return existing.commandId;
    const next = { fingerprint, commandId: commandId() };
    slot.current.set(key, next);
    return next.commandId;
  }

  // MMS photo upload: raw bytes to the event file API (the same endpoint the
  // file contract covers). The returned file id is what the campaign sends;
  // bytes never travel through the command path.
  async function uploadMmsImage(file: File) {
    if (file.size > 200 * 1024) {
      setCampaignFieldError({ field: "imageFileId", message: "MMS 이미지는 JPG 200KB 이하만 가능합니다." });
      return;
    }
    if (file.type !== "image/jpeg") {
      setCampaignFieldError({ field: "imageFileId", message: "MMS 이미지는 JPG 형식을 사용하세요." });
      return;
    }
    setUploadingImage(true);
    setCampaignFieldError(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/files?name=${encodeURIComponent(file.name)}&commandId=${encodeURIComponent(commandId())}`,
        { method: "POST", headers: { "content-type": file.type }, body: file }
      );
      const data = (await res.json().catch(() => null)) as {
        file?: { fileId?: unknown; name?: unknown };
        error?: unknown;
      } | null;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      if (!res.ok || !fileId) {
        setCampaignFieldError({
          field: "imageFileId",
          message: typeof data?.error === "string" ? data.error : "이미지를 올리지 못했습니다.",
        });
        return;
      }
      setCampaignDraft((current) => ({
        ...current,
        imageFileId: fileId,
        imageName: typeof data?.file?.name === "string" ? data.file.name : file.name,
      }));
    } catch {
      setCampaignFieldError({ field: "imageFileId", message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setUploadingImage(false);
    }
  }

  async function refresh(silent = false) {
    if (!silent) setState({ kind: "loading" });
    try {
      const [meResponse, bootstrapResponse] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/bootstrap", { cache: "no-store" }),
      ]);
      if (meResponse.status === 401 || bootstrapResponse.status === 401) {
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return;
      }
      const meData = await meResponse.json().catch(() => null) as unknown;
      const bootstrapData = await bootstrapResponse.json().catch(() => null) as unknown;
      const user = asRecord(asRecord(meData)?.user);
      const root = asRecord(bootstrapData);
      const bootstrap = asRecord(root?.state);
      if (!meResponse.ok || !bootstrapResponse.ok || !user || !bootstrap) {
        setState({ kind: "failed", message: "메시지 정보를 불러오지 못했습니다." });
        return;
      }
      const role = text(user.role);
      const myId = text(user.id);
      const memberships = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((value) => {
            const item = asRecord(value);
            if (!item || typeof item.accountId !== "string" || typeof item.eventId !== "string") return [];
            return [{ accountId: item.accountId, eventId: item.eventId }];
          })
        : [];
      const canManage = role === "AGENCY" || (role === "MANAGER" && memberships.some(
        (membership) => membership.accountId === myId && membership.eventId === eventId
      ));
      const events = Array.isArray(bootstrap.events) ? bootstrap.events : [];
      const event = events.map(asRecord).find((item) => item?.id === eventId);
      const workspaces = asRecord(bootstrap.workspaces);
      const workspace = asRecord(workspaces?.[eventId]);
      if (!event || !workspace) {
        setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        return;
      }
      const clients = Array.isArray(bootstrap.clients) ? bootstrap.clients : [];
      const client = clients.map(asRecord).find((item) => item?.id === event.clientId);
      const venue = asRecord(workspace.venue);
      setState({
        kind: "ready",
        eventName: text(event.name, eventId),
        eventDate: text(event.date),
        stage: text(event.stage).toUpperCase(),
        eventMeta: {
          clientName: text(client?.name),
          date: text(event.date),
          start: text(event.start),
          end: text(event.end),
          venue: text(venue?.name) || text(event.venue),
        },
        canManage,
        participants: Array.isArray(workspace.participants)
          ? workspace.participants.flatMap((value) => {
              const parsed = parseParticipant(value);
              return parsed ? [parsed] : [];
            })
          : [],
        templates: Array.isArray(workspace.templates)
          ? workspace.templates.flatMap((value) => {
              const parsed = parseTemplate(value);
              return parsed ? [parsed] : [];
            })
          : [],
        campaigns: Array.isArray(workspace.messages)
          ? workspace.messages.flatMap((value) => {
              const parsed = parseCampaign(value);
              return parsed ? [parsed] : [];
            })
          : [],
      });
    } catch {
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  useEffect(() => {
    void refresh();
    // Bootstrap is scoped by this event; the session cookie is same-origin.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => {
    setAttentionOnly(attentionParam === "1");
  }, [attentionParam]);

  // Event switch resets the handoff/history workspace slice (never a key
  // remount): a stale handoff banner or expanded history from the previous
  // event must not leak into this one. Drafts, filters and selection keep
  // their existing behavior.
  useEffect(() => {
    handoffAppliedRef.current = null;
    setHandoffNotice(null);
    setReloadSummary(null);
    setHistoryLimit(10);
    pendingHistoryFocusRef.current = null;
  }, [eventId]);

  // Keyboard reveal: move focus to the first newly revealed campaign row
  // after 이전 발송 더 보기, including the final reveal where the button
  // disappears. Counts and the attention anchor semantics stay untouched.
  useEffect(() => {
    const target = pendingHistoryFocusRef.current;
    if (target === null) return;
    pendingHistoryFocusRef.current = null;
    const row = historyListRef.current?.children[target] as HTMLElement | undefined;
    row?.focus?.();
  }, [historyLimit]);

  // Roster→message handoff: read ?to=<comma-separated ids> once after the
  // workspace loads, intersect with loaded participants, preselect existing
  // ones (PENDING/WAITLIST included — the operator chose them), report
  // missing/cancelled/duplicates, and turn on the existing selected-only
  // review mode so the operator sees exactly the handoff set. Filters stay
  // untouched. The param is removed with history.replaceState (no router
  // navigation). No auto-send, no new API; without canManage the existing
  // permission feedback stands and the handoff is ignored.
  useEffect(() => {
    if (state.kind !== "ready") return;
    if (handoffAppliedRef.current === eventId) return;
    let raw: string[] = [];
    try {
      const params = new URLSearchParams(window.location.search);
      const to = params.get("to");
      if (!to) {
        handoffAppliedRef.current = eventId;
        return;
      }
      raw = to.split(",").map((part) => part.trim()).filter(Boolean);
    } catch {
      handoffAppliedRef.current = eventId;
      return;
    }
    const stripToParam = () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("to");
        const next = `${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ""}${url.hash}`;
        window.history.replaceState(null, "", next);
      } catch {
        // Handoff still applies; only the shareable URL keeps the param.
      }
    };
    handoffAppliedRef.current = eventId;
    if (!raw.length) {
      stripToParam();
      return;
    }
    if (!state.canManage) {
      stripToParam();
      return;
    }
    const unique = [...new Set(raw)];
    const byId = new Map(state.participants.map((person) => [person.id, person]));
    const valid: string[] = [];
    let excluded = raw.length - unique.length;
    for (const id of unique) {
      const person = byId.get(id);
      if (!person || person.status === "CANCELLED") excluded += 1;
      else valid.push(id);
    }
    setSelectedIds(valid);
    if (valid.length > 0) setShowSelectedOnly(true);
    setHandoffNotice(
      excluded > 0
        ? `명단에서 ${valid.length}명을 인계받았습니다 · 제외 ${excluded}명(취소·삭제)`
        : `명단에서 ${valid.length}명을 인계받았습니다`
    );
    stripToParam();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, eventId]);

  useEffect(() => {
    if (!attentionOnly || state.kind !== "ready") return;
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        document.getElementById("history-heading")?.scrollIntoView({ block: "start" });
      });
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [attentionOnly, state.kind]);

  // Draft-guard dirty state, evaluated before every early return below. True
  // diffs against the empty compose/template baselines (or the opened saved
  // template when editing), plus pending ambiguous intent and in-flight
  // uploads. Read filters (search/status/selected-only) never count, and a
  // clean post-save screen navigates without a confirm.
  const editingTemplate = state.kind === "ready" && templateDraft.id
    ? state.templates.find((item) => item.id === templateDraft.id)
    : undefined;
  const templateDirty = editingTemplate
    ? templateDraft.name !== editingTemplate.name ||
      templateDraft.channel !== editingTemplate.channel ||
      templateDraft.body !== editingTemplate.body ||
      templateDraft.solapiTemplateId !== editingTemplate.solapiTemplateId
    : JSON.stringify(templateDraft) !== JSON.stringify(EMPTY_TEMPLATE);
  const composeDirty =
    campaignDraft.title !== "" ||
    campaignDraft.body !== "" ||
    campaignDraft.scheduled !== "" ||
    campaignDraft.imageFileId !== "" ||
    campaignDraft.simulate ||
    campaignDraft.channel !== EMPTY_CAMPAIGN.channel ||
    selectedIds.length > 0 ||
    selectedTemplateId !== "";
  const pendingIntent =
    uploadingImage ||
    campaignCreateRef.current !== null ||
    templateSaveRef.current !== null ||
    retryRefs.current.size > 0 ||
    syncRefs.current.size > 0 ||
    cancelRefs.current.size > 0 ||
    ambiguousRetryIds.length > 0 ||
    ambiguousSyncIds.length > 0 ||
    ambiguousCancelIds.length > 0;
  useConsoleDraftGuard(
    composeDirty || templateDirty || pendingIntent,
    "작성 중인 발송 내용이나 응답을 확인하지 못한 발송 요청이 있습니다. 페이지를 떠나면 사라집니다."
  );

  const hasFutureScheduled = state.kind === "ready" && state.campaigns.some((campaign) =>
    campaign.status === "SCHEDULED" &&
    campaign.scheduled &&
    Number.isFinite(Date.parse(campaign.scheduled)) &&
    Date.parse(campaign.scheduled) > Date.now()
  );

  useEffect(() => {
    if (!hasFutureScheduled) return;
    const timer = window.setInterval(() => {
      setNowTick((tick) => tick + 1);
    }, 30_000);
    return () => {
      window.clearInterval(timer);
    };
  }, [hasFutureScheduled]);

  async function postCommand(command: string, payload: Record<string, unknown>, id: string): Promise<CommandResult> {
    // Defense in depth: write buttons already disable on archived events,
    // and the server rejects them; this keeps a stale in-flight path from
    // sending after a background refresh flips the stage.
    if (archived) {
      throw new CommandFailure({ message: "보관된 행사는 읽기 전용입니다.", field: null });
    }
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: id, command, payload }),
    });
    const data = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const failure = serverError(data);
      const scoped = new CommandFailure(failure) as CommandFailure & { status?: number };
      scoped.status = response.status;
      throw scoped;
    }
    return asRecord(data) ?? {};
  }

  function handleCommandError(error: unknown, kind: "template" | "campaign") {
    const message = error instanceof Error ? error.message : "연결하지 못했습니다. 다시 시도하세요.";
    const field = error instanceof CommandFailure ? error.field : null;
    if (kind === "template") {
      setTemplateFieldError(field ? { field, message } : null);
      setTemplateError(field ? null : message);
    } else {
      setCampaignFieldError(field ? { field, message } : null);
      setCampaignError(field ? null : message);
    }
  }

  async function saveTemplate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current) return;
    setTemplateError(null);
    setTemplateFieldError(null);
    setTemplateNotice(null);
    // Snapshot: a background refresh must not mutate this pending payload.
    const payload: Record<string, unknown> = {
      name: templateDraft.name,
      channel: templateDraft.channel,
      body: templateDraft.body,
      solapiTemplateId: templateDraft.solapiTemplateId,
    };
    if (templateDraft.id) payload.id = templateDraft.id;
    const fingerprint = fingerprintFor("template.save", payload);
    const id = takeCommandId(templateSaveRef, fingerprint);
    if (!beginAction("template")) return;
    try {
      const result = await postCommand("template.save", payload, id);
      const saved = parseTemplate(result.template);
      // Proven success is a complete template record. Anything else —
      // including an empty object — is malformed, not success.
      if (!saved || !saved.id) {
        setTemplateError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
        return;
      }
      templateSaveRef.current = null;
      setTemplateDraft({ ...saved });
      setTemplateNotice("템플릿을 저장했습니다.");
      await refresh(true);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number" && isAmbiguousStatus(status)) {
        setTemplateError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      } else if (error instanceof CommandFailure) {
        // Settled 4xx: the server applied nothing, so the next corrected
        // request takes a fresh id.
        templateSaveRef.current = null;
        handleCommandError(error, "template");
      } else {
        setTemplateError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      }
    } finally {
      endAction();
    }
  }

  function useTemplate(template: Template) {
    setSelectedTemplateId(template.id);
    setCampaignDraft((current) => ({ ...current, channel: template.channel, body: template.body }));
    setCampaignFieldError(null);
    setCampaignError(null);
  }

  function toggleRecipient(id: string) {
    setSelectedIds((current) => current.includes(id)
      ? current.filter((selected) => selected !== id)
      : [...current, id]);
    setCampaignFieldError(null);
  }

  function setAllRecipients(checked: boolean, people: Participant[]) {
    const ids = people.map((person) => person.id);
    setSelectedIds((current) => checked
      // Union: selecting a filtered view must not drop recipients chosen
      // in another view. Deselecting removes only the visible ones.
      ? [...new Set([...current, ...ids])]
      : current.filter((selected) => !ids.includes(selected)));
    setCampaignFieldError(null);
  }

  function clearAllRecipients() {
    setSelectedIds([]);
    setCampaignFieldError(null);
  }

  // Keyboard path: after picking recipients the composer still holds N
  // checkbox stops, a 6-segment datetime-local and the option row before
  // the submit. This jump moves focus straight onto the real submit
  // button, so the next Tab leaves it (no re-finding) and Enter/Space
  // activates it immediately. Scroll follows for sighted operators.
  function jumpToCampaignSubmit() {
    const target = document.getElementById("campaign-submit") as HTMLElement | null;
    target?.scrollIntoView({ block: "center" });
    target?.focus({ preventScroll: true });
  }

  function requestCampaignCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current || uploadingImage) return;
    setCampaignError(null);
    setCampaignFieldError(null);
    setCampaignNotice(null);
    // A re-submit invalidates any earlier pending summary: validation below
    // either replaces it or leaves it cleared.
    setSendPending(null);
    if (!selectedIds.length) {
      setCampaignFieldError({ field: "ids", message: "발송 대상을 선택하세요." });
      return;
    }
    const isAlimtalk = campaignDraft.channel === "ALIMTALK";
    const boundTemplate = state.kind === "ready"
      ? state.templates.find((template) => template.id === selectedTemplateId)
      : undefined;
    if (isAlimtalk && !boundTemplate?.solapiTemplateId) {
      setCampaignFieldError({
        field: "templateId",
        message: "알림톡은 Solapi 승인 ID가 있는 템플릿을 선택해야 합니다.",
      });
      return;
    }
    const isMms = campaignDraft.channel === "MMS";
    if (isMms && !campaignDraft.imageFileId) {
      setCampaignFieldError({
        field: "imageFileId",
        message: "MMS는 JPG 이미지(200KB 이하)를 첨부해야 합니다.",
      });
      return;
    }
    const scheduled = campaignDraft.scheduled
      ? new Date(campaignDraft.scheduled).toISOString()
      : "";
    const scheduledCampaign = Boolean(scheduled);
    const riskCount = state.kind === "ready"
      ? selectedIds.filter((id) => {
          const person = state.participants.find((item) => item.id === id);
          return person?.status === "PENDING" || person?.status === "WAITLIST";
        }).length
      : 0;
    const riskLine = riskCount > 0
      ? `\n선택 대상 중 승인 대기·대기 명단이 ${riskCount}명 포함되어 있습니다.`
      : "";
    // Snapshot the pending payload: background refresh, later draft edits
    // and error handling must not mutate what this request sends. Drafts
    // and selection clear only on proven success below, never on failure.
    const payload: Record<string, unknown> = {
      ids: [...selectedIds],
      title: campaignDraft.title,
      channel: campaignDraft.channel,
      body: campaignDraft.body,
      simulate: campaignDraft.simulate,
    };
    if (selectedTemplateId) payload.templateId = selectedTemplateId;
    if (scheduled) payload.scheduled = scheduled;
    if (isMms) payload.imageFileId = campaignDraft.imageFileId;
    const fingerprint = fingerprintFor("message.create", payload);
    const id = takeCommandId(campaignCreateRef, fingerprint);
    // Server precedence (content-results.js): scheduled wins over simulate —
    // scheduled+simulate creates a SCHEDULED reservation that never delivers.
    // The confirmation leads with the schedule in every scheduled case and
    // states the simulation outcome explicitly.
    setSendPending({
      payload,
      id,
      summary: campaignCreateSummary({
        scheduled: scheduledCampaign,
        simulate: campaignDraft.simulate,
        isMms,
        count: selectedIds.length,
        riskLine,
      }),
      confirmLabel: scheduledCampaign
        ? "예약 등록한다"
        : campaignDraft.simulate
          ? "모의 발송을 기록한다"
          : "발송 요청한다",
    });
  }

  async function executeCampaignCreate(pending: SendPending) {
    if (!beginAction("campaign")) return;
    // The receipt only turns ambiguous once bytes actually leave: mark the
    // staged slot attempted here, keyed on our own commandId identity, so a
    // later FAILED reload blocks only on a real transmission. A same-fingerprint
    // restage reuses the id and keeps the marker; a different payload stages
    // a fresh unattempted id.
    if (campaignCreateRef.current?.commandId === pending.id) {
      campaignCreateRef.current.attempted = true;
    }
    try {
      const result = await postCommand("message.create", pending.payload, pending.id);
      const created = asRecord(result.message);
      // The server keys the created message by our commandId, so an id that
      // echoes it proves this response belongs to our request. Anything
      // else — including an empty object — is malformed, not success.
      if (!created || created.id !== pending.id) {
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
        return;
      }
      campaignCreateRef.current = null;
      // Copy follows the returned record's status, not the draft flags:
      // scheduled+simulate comes back SCHEDULED, never SIMULATED.
      const createdStatus = text(created.status);
      setCampaignNotice(
        createdStatus === "SCHEDULED"
          ? pending.payload.simulate === true
            ? "모의 예약을 등록했습니다. 예약 시각 이후 이 화면에서 발송 실행을 눌러야 하며, 실행해도 수신자에게 전달되지 않습니다."
            : "예약 등록했습니다. 예약 시각 이후 이 화면에서 발송 실행을 눌러야 합니다."
          : createdStatus === "SIMULATED"
            ? "모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다."
            : "발송 요청을 기록했습니다. 결과는 아래 발송 기록에서 확인하세요."
      );
      setCampaignDraft(EMPTY_CAMPAIGN);
      setSelectedTemplateId("");
      setSelectedIds([]);
      // Proven send consumes the reloaded source: its summary must not
      // linger above the next blank composer.
      setReloadSummary(null);
      await refresh(true);
      window.setTimeout(() => {
        document.getElementById(`campaign-${pending.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      }, 0);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number" && isAmbiguousStatus(status)) {
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      } else if (error instanceof CommandFailure) {
        // Settled 4xx: nothing was applied, so the next corrected request
        // takes a fresh id.
        campaignCreateRef.current = null;
        handleCommandError(error, "campaign");
      } else {
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      }
    } finally {
      endAction();
    }
  }

  async function executeRetry(campaign: Campaign, label: "retry" | "execute") {
    if (inFlightRef.current) return;
    // Stored mode, not the composer draft: a simulated reservation must
    // never execute under real-delivery/cost/no-undo wording. Per server
    // truth only SCHEDULED rows can carry simulate=true here (SIMULATED
    // rows are terminal, NEEDS_CONNECTION implies simulate=false).
    const storedSimulate = campaign.simulate === true;
    const payload = { id: campaign.id };
    const fingerprint = fingerprintFor("message.retry", payload);
    const id = takeMapCommandId(retryRefs, campaign.id, fingerprint);
    if (!beginAction(`retry:${campaign.id}`)) return;
    setCampaignError(null);
    setCampaignNotice(null);
    try {
      const result = await postCommand("message.retry", payload, id);
      const message = asRecord(result.message);
      const status = text(message?.status);
      // The retried campaign echoes its own id; require it so a stray
      // payload can't read as success.
      if (!message || message.id !== campaign.id || !status) {
        setAmbiguousRetryIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
        return;
      }
      retryRefs.current.delete(campaign.id);
      setAmbiguousRetryIds((current) => current.filter((item) => item !== campaign.id));
      setCampaignNotice(
        storedSimulate
          ? `모의 실행 결과: ${messageStatusLabel(status)}. 수신자에게 전달되지 않았습니다.`
          : `재시도 결과: ${messageStatusLabel(status)}.`
      );
      await refresh(true);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number" && isAmbiguousStatus(status)) {
        setAmbiguousRetryIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      } else if (error instanceof CommandFailure) {
        retryRefs.current.delete(campaign.id);
        setAmbiguousRetryIds((current) => current.filter((item) => item !== campaign.id));
        const failure = error.message || "재시도하지 못했습니다.";
        setCampaignError(failure);
      } else {
        setAmbiguousRetryIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      }
    } finally {
      endAction();
    }
  }

  async function syncCampaign(campaign: Campaign) {
    if (inFlightRef.current) return;
    const payload = { id: campaign.id };
    const fingerprint = fingerprintFor("message.sync", payload);
    const id = takeMapCommandId(syncRefs, campaign.id, fingerprint);
    if (!beginAction(`sync:${campaign.id}`)) return;
    setCampaignError(null);
    setCampaignNotice(null);
    try {
      const result = await postCommand("message.sync", payload, id);
      const message = asRecord(result.message);
      // message.sync may answer with a fallback SENDING campaign instead of
      // the requested one, so require a complete record (id + status)
      // rather than an id echo.
      if (!message || typeof message.id !== "string" || !message.id || !text(message?.status)) {
        setAmbiguousSyncIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
        return;
      }
      syncRefs.current.delete(campaign.id);
      setAmbiguousSyncIds((current) => current.filter((item) => item !== campaign.id));
      setCampaignNotice(`발송 결과를 확인했습니다. 현재 상태: ${messageStatusLabel(text(message?.status))}.`);
      await refresh(true);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number" && isAmbiguousStatus(status)) {
        setAmbiguousSyncIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      } else if (error instanceof CommandFailure) {
        syncRefs.current.delete(campaign.id);
        setAmbiguousSyncIds((current) => current.filter((item) => item !== campaign.id));
        const failure = error.message || "발송 결과를 확인하지 못했습니다.";
        setCampaignError(failure);
      } else {
        setAmbiguousSyncIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      }
    } finally {
      endAction();
    }
  }

  async function executeCancel(campaign: Campaign) {
    if (inFlightRef.current) return;
    const scheduled = campaign.status === "SCHEDULED";
    // Only SCHEDULED and NEEDS_CONNECTION are offered here. Anything already
    // accepted by the provider (SENDING and beyond) is not cancellable, and
    // the server still authorizes every message.cancel.
    const payload = { id: campaign.id };
    const fingerprint = fingerprintFor("message.cancel", payload);
    const id = takeMapCommandId(cancelRefs, campaign.id, fingerprint);
    if (!beginAction(`cancel:${campaign.id}`)) return;
    setCampaignError(null);
    setCampaignNotice(null);
    try {
      const result = await postCommand("message.cancel", payload, id);
      const message = asRecord(result.message);
      if (!message || message.id !== campaign.id || text(message?.status) !== "CANCELLED") {
        setAmbiguousCancelIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
        return;
      }
      cancelRefs.current.delete(campaign.id);
      setAmbiguousCancelIds((current) => current.filter((item) => item !== campaign.id));
      setCampaignNotice(
        scheduled
          ? "예약을 취소했습니다. 이후 발송 실행을 할 수 없습니다."
          : "발송 요청을 취소했습니다. 이후 재시도로 발송되지 않습니다."
      );
      await refresh(true);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (typeof status === "number" && isAmbiguousStatus(status)) {
        setAmbiguousCancelIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      } else if (error instanceof CommandFailure) {
        cancelRefs.current.delete(campaign.id);
        setAmbiguousCancelIds((current) => current.filter((item) => item !== campaign.id));
        const failure = error.message || "취소하지 못했습니다.";
        setCampaignError(failure);
      } else {
        setAmbiguousCancelIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
      }
    } finally {
      endAction();
    }
  }

  // FAILED-only reload: message.retry intentionally rejects FAILED, so the
  // safe repeat is a new composer draft preloaded from the persisted
  // campaign. PARTIAL/SENDING rows are excluded (duplicate-delivery safety
  // unclear). Never auto-sends: the existing submit ConsoleConfirm still
  // gates the new send, and the old campaign id is never reused as a new
  // create command id (fresh fingerprint → fresh id on submit).
  function failedReloadBlocked(): boolean {
    return (
      // Create slot blocks only once actually transmitted: an unsent staged
      // id (or a cancelled confirmation) is not an unconfirmed receipt.
      // After a real post the marker stays until proven success or a
      // settled 4xx clears the slot, so later attempts stay blocked even
      // when no send confirm remains open.
      campaignCreateRef.current?.attempted === true ||
      retryRefs.current.size > 0 ||
      syncRefs.current.size > 0 ||
      cancelRefs.current.size > 0 ||
      ambiguousRetryIds.length > 0 ||
      ambiguousSyncIds.length > 0 ||
      ambiguousCancelIds.length > 0
    );
  }

  // Blocked-reload recovery: the history button that reported the block is
  // far from the composer, so the error text alone strands the operator
  // with no visible reason or next action. Surface the existing
  // campaignError copy, drop any overwrite confirm, then land on the real
  // submit instantly (no auto-submit): the inline error renders immediately
  // above ConsoleFormActions, so reason and next action stay visible
  // together. Instant only for this discrete error context transfer; the
  // global jump/motion behavior is untouched.
  function reportBlockedReload() {
    setReloadPending(null);
    setCampaignError("응답을 확인하지 못한 발송 요청이 있습니다. 결과를 먼저 확인한 뒤 내용을 불러오세요.");
    window.setTimeout(() => {
      document.getElementById("campaign-submit")?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      document.getElementById("campaign-submit")?.focus({ preventScroll: true });
    }, 0);
  }

  function applyFailedReload(campaign: Campaign) {
    if (state.kind !== "ready") return;
    // Re-validate at confirm time: the overwrite confirm is nonmodal, so
    // the operator may have submitted, started an upload, lost permission,
    // or left an ambiguous receipt open while it stayed on screen. The
    // request-time guard alone cannot cover that race.
    if (!state.canManage || archived) return;
    if (inFlightRef.current || uploadingImage) return;
    if (failedReloadBlocked()) {
      reportBlockedReload();
      return;
    }
    // Reload from the current history row, not a stale snapshot: a
    // background refresh may have changed or removed it while the confirm
    // stayed open.
    const source = state.campaigns.find((item) => item.id === campaign.id);
    if (!source || source.status !== "FAILED") {
      setReloadPending(null);
      setCampaignError("발송 기록이 바뀌었습니다. 상태를 새로고침한 뒤 다시 시도하세요.");
      return;
    }
    // Live roster wins: keep only current non-CANCELLED participants.
    // Missing/deleted count as excluded, never as silent carries. Ids are
    // already deduped by the parser; the seen guard below only skips.
    const byId = new Map(state.participants.map((person) => [person.id, person]));
    const seen = new Set<string>();
    const eligible: string[] = [];
    let excluded = 0;
    for (const id of source.recipientIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const person = byId.get(id);
      if (!person || person.status === "CANCELLED") excluded += 1;
      else eligible.push(id);
    }
    const allowedChannels = ["SMS", "LMS", "MMS", "ALIMTALK"];
    const channel = allowedChannels.includes(source.channel) ? source.channel : "SMS";
    const boundTemplate = source.templateId
      ? state.templates.find((template) => template.id === source.templateId)
      : undefined;
    // Never assume a stale ALIMTALK binding: without a current template
    // carrying a Solapi approval id the composer stays unbound so the
    // existing submit validation asks for a reselection.
    const templateUsable = Boolean(
      boundTemplate && (channel !== "ALIMTALK" || boundTemplate.solapiTemplateId)
    );
    const isMms = channel === "MMS";
    setCampaignDraft({
      title: source.title === "제목 없는 발송" ? "" : source.title,
      channel,
      body: source.body,
      // A stale reservation must never replay: the operator re-picks it.
      scheduled: "",
      simulate: source.simulate === true,
      imageFileId: isMms ? source.imageFileId : "",
      imageName: isMms ? source.imageName : "",
    });
    setSelectedTemplateId(templateUsable && boundTemplate ? boundTemplate.id : "");
    setSelectedIds(eligible);
    // Reveal the reloaded set for review: clear the search/status filters
    // and turn on the existing selected-only mode. The saved template
    // draft (templateDraft) is intentionally untouched.
    setRecipientQuery("");
    setRecipientStatus("ALL");
    setShowSelectedOnly(true);
    setRecipientListOpen(true);
    setSendPending(null);
    setHistoryPending(null);
    setReloadPending(null);
    setCampaignFieldError(null);
    setCampaignError(null);
    const sourceLabel = `〈${source.title}〉`;
    const reselectLine = channel === "ALIMTALK" && !templateUsable
      ? " 승인된 알림톡 템플릿을 다시 선택하세요."
      : "";
    // The summary lives only in the composer, next to the title — never as
    // a global success notice above the header.
    setCampaignNotice(null);
    if (eligible.length === 0) {
      setReloadSummary(
        `${sourceLabel} 내용을 불러왔습니다 · 선택 가능한 대상이 없습니다 · 제외 ${excluded}명(취소·삭제). 수신자를 새로 선택하세요. 바로 발송되지 않습니다. 새 발송 전 내용·대상을 확인하세요. 예약 시각은 다시 지정하세요.${reselectLine}`
      );
    } else {
      setReloadSummary(
        `${sourceLabel} 내용을 불러왔습니다 · 선택 ${eligible.length}명 · 제외 ${excluded}명(취소·삭제). 바로 발송되지 않습니다. 새 발송 전 내용·대상을 확인하세요. 예약 시각은 다시 지정하세요.${reselectLine}`
      );
    }
    window.setTimeout(() => {
      // Discrete task context transfer: land on the in-form summary
      // instantly (no smooth-scroll race), then focus the title without
      // moving the viewport again.
      document.getElementById("campaign-reload-summary")?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
      document.getElementById("campaign-title")?.focus({ preventScroll: true });
    }, 0);
  }

  function requestFailedReload(campaign: Campaign) {
    if (inFlightRef.current || uploadingImage) return;
    if (state.kind !== "ready" || !state.canManage || archived) return;
    // An unconfirmed create/retry/sync/cancel receipt owns its command id
    // for a same-request retry. Replacing the draft first would strand
    // that recovery, so block until it resolves.
    if (failedReloadBlocked()) {
      reportBlockedReload();
      return;
    }
    setCampaignError(null);
    setCampaignFieldError(null);
    setHistoryPending(null);
    // Never silently overwrite operator input: reuse the existing
    // ConsoleConfirm grammar when the composer holds anything (draft,
    // selection, template choice) or an unconfirmed send summary.
    if (composeDirty || sendPending !== null) {
      setReloadPending({ id: campaign.id });
      return;
    }
    applyFailedReload(campaign);
  }

  if (state.kind === "loading") {
    return (
      <ConsolePage pageId="messages" eventId={eventId}>
        <ConsoleStatePanel
          kind="loading"
          message="메시지 정보를 불러오고 있습니다."
          onRetry={() => { void refresh(); }}
        />
      </ConsolePage>
    );
  }
  if (state.kind === "failed") {
    return (
      <ConsolePage pageId="messages" eventId={eventId}>
        {/* ConsoleStatePanel dispatches eventouch:shell-reload and renders 다시 불러오기. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void refresh(); }}
        />
      </ConsolePage>
    );
  }

  // 보관된 행사는 서버가 모든 쓰기를 409로 거부하므로 쓰기 affordance를
  // 미리 잠그고 이유를 밝힌다. 조회·기록 확인은 그대로 둔다.
  const archived = state.stage === "ARCHIVED";
  const archivedReason = "보관된 행사는 읽기 전용입니다";
  const activeParticipants = state.participants.filter((person) => person.status !== "CANCELLED");
  const statusFiltered = recipientStatus === "ALL"
    ? activeParticipants
    : activeParticipants.filter((person) => person.status === recipientStatus);
  const recipientSearch = recipientQuery.trim().toLocaleLowerCase("ko-KR");
  const searchedRecipients = !recipientSearch
    ? statusFiltered
    : statusFiltered.filter((person) =>
        `${person.name} ${person.company} ${person.phone}`.toLocaleLowerCase("ko-KR").includes(recipientSearch)
      );
  // 선택 대상만 보기는 상태/검색 필터를 우회하는 전체 선택 검토 모드다:
  // 체크하는 동안 목록에는 선택된 전원이 뜨고, 필터 입력은 그대로 둔다.
  const visibleRecipients = showSelectedOnly
    ? activeParticipants.filter((person) => selectedIds.includes(person.id))
    : searchedRecipients;
  const selectedCount = selectedIds.length;
  const selectedSet = new Set(selectedIds);
  const selectedPeople = activeParticipants.filter((person) => selectedSet.has(person.id));
  const visibleSelectedCount = visibleRecipients.filter((person) => selectedSet.has(person.id)).length;
  const outsideVisibleCount = selectedCount - visibleSelectedCount;
  const selectedApproved = selectedPeople.filter((person) => person.status === "APPROVED").length;
  const selectedPending = selectedPeople.filter((person) => person.status === "PENDING").length;
  const selectedWaitlist = selectedPeople.filter((person) => person.status === "WAITLIST").length;
  const selectedMissing = selectedCount - selectedPeople.length;
  const pendingRiskCount = selectedPending + selectedWaitlist;
  const attentionCampaigns = state.campaigns.filter((campaign) => ATTENTION_STATUSES.includes(campaign.status));
  const visibleCampaigns = attentionOnly ? attentionCampaigns : state.campaigns;
  // Long history reveals incrementally: first 10, then 10 per click. Filters,
  // refresh, retry/sync/cancel and the attention deep link keep their semantics.
  const shownCampaigns = visibleCampaigns.slice(0, historyLimit);
  const remainingCampaigns = visibleCampaigns.length - shownCampaigns.length;
  // Subscribe this render to the 30s clock so a due reservation flips to
  // 발송 실행 while the page stays open.
  void nowTick;
  const scheduledDraft = Boolean(campaignDraft.scheduled);
  const simulateDraft = campaignDraft.simulate === true;
  // Scheduled-first, mirroring server precedence: a scheduled draft is a
  // reservation even when the simulate box is checked.
  const submitModeLabel = scheduledDraft
    ? simulateDraft
      ? "모의 예약·수동 실행·전달 없음"
      : "예약 등록(수동 실행)"
    : simulateDraft
      ? "모의 발송(전달 없음)"
      : "실제 발송 시도";
  const submitButtonLabel = busyAction === "campaign"
    ? "요청 중…"
    : scheduledDraft
      ? "예약 등록(수동 실행)"
      : simulateDraft
        ? "모의 발송 기록"
        : "발송 요청";

  return (
    <ConsolePage
      pageId="messages"
      eventId={eventId}
      eventName={state.eventName}
      meta={formatConsoleEventMeta(state.eventMeta)}
      headerActions={(
        <Link
          className="button button-secondary"
          href={`/console/events/${encodeURIComponent(eventId)}/participants`}
        >
          참가자
        </Link>
      )}
      feedback={(
        <>
          {archived ? (
            <ConsoleFeedback kind="warning">
              보관된 행사는 읽기 전용입니다. 발송 기록은 볼 수 있지만 새로 발송·예약·취소할 수 없습니다.
            </ConsoleFeedback>
          ) : null}
          {handoffNotice ? <ConsoleFeedback kind="info" id="handoff-notice">{handoffNotice}</ConsoleFeedback> : null}
          {campaignNotice ? <ConsoleFeedback kind="success">{campaignNotice}</ConsoleFeedback> : null}
          {campaignError ? <ConsoleFeedback kind="error">{campaignError}</ConsoleFeedback> : null}
        </>
      )}
    >
      {!state.canManage ? (
        <ConsoleFeedback kind="error">메시지 발송을 관리할 운영 권한이 없습니다.</ConsoleFeedback>
      ) : (
        <>
          <ConsoleFeedback kind="warning">
            <strong>발송 상태는 공급사 응답을 기준으로 표시합니다.</strong>{" "}
            공급사가 연결되지 않았으면 요청은 기록되지만 실제로 전달되지 않습니다. 모의 발송도 전달되지 않습니다.
          </ConsoleFeedback>

          <ConsoleSection
            headingId="campaign-heading"
              title="메시지 작성"
              action={<span className={styles.selectionCount}>{selectedCount}명 선택</span>}
              width="form"
              surface="panel"
              divider
            >
              <form className={uiStyles.formStack} onSubmit={requestCampaignCreate}>
                {/* Long-form guard: the recipient picker sits far below, so the
                    compose head restates who this goes to and jumps straight
                    there. Counts stay detailed in the 발송 대상 summary. */}
                {/* In-form skip: recipients chosen means "confirmed" — one
                    stop jumps straight onto the real submit button. It sits
                    with the recipient summary so the shortcut is found
                    before the long recipient list. */}
                <div className={styles.sendSkip}>
                  <button
                    type="button"
                    id="campaign-send-skip"
                    data-skip-to="campaign-submit"
                    className={styles.textButton}
                    onClick={jumpToCampaignSubmit}
                  >
                    발송 요청으로 이동
                  </button>
                  <span className={styles.help}>수신자 선택을 마쳤으면 바로 발송 버튼으로 포커스를 옮깁니다.</span>
                </div>
                <div className={styles.recipientTopBar}>
                  <span>
                    {selectedCount > 0
                      ? `수신자 ${selectedCount}명 선택 · 확정 ${selectedApproved}명`
                      : "수신자 0명 선택 · 수신자를 먼저 고르세요"}
                  </span>
                  <button
                    type="button"
                    className={styles.textButton}
                    onClick={() => {
                      document.getElementById("campaign-recipients")?.scrollIntoView({ block: "start" });
                      document.getElementById("recipient-status-filter")?.focus({ preventScroll: true });
                    }}
                  >
                    수신자 선택으로 이동
                  </button>
                </div>
                <div>
                  {reloadSummary ? (
                    <ConsoleFeedback kind="info" id="campaign-reload-summary">{reloadSummary}</ConsoleFeedback>
                  ) : null}
                  <label htmlFor="campaign-title">발송 제목</label>
                  <input
                    id="campaign-title"
                    maxLength={100}
                    required
                    value={campaignDraft.title}
                    aria-invalid={campaignFieldError?.field === "title"}
                    aria-describedby={campaignFieldError?.field === "title" ? (reloadSummary ? "campaign-reload-summary campaign-title-error" : "campaign-title-error") : (reloadSummary ? "campaign-reload-summary" : undefined)}
                    onChange={(event) => setCampaignDraft({ ...campaignDraft, title: event.target.value })}
                  />
                  {campaignFieldError?.field === "title" ? <p className={styles.fieldError} id="campaign-title-error" role="alert">{campaignFieldError.message}</p> : null}
                </div>

                <div className={uiStyles.formGrid}>
                  <div>
                    <label htmlFor="campaign-template">저장 템플릿</label>
                    <select
                      id="campaign-template"
                      value={selectedTemplateId}
                      aria-invalid={campaignFieldError?.field === "templateId"}
                      aria-describedby={campaignFieldError?.field === "templateId" ? "campaign-template-error" : undefined}
                      onChange={(event) => {
                        const template = state.templates.find((item) => item.id === event.target.value);
                        if (template) useTemplate(template);
                        else setSelectedTemplateId("");
                      }}
                    >
                      <option value="">직접 작성</option>
                      {state.templates.map((template) => (
                        <option value={template.id} key={template.id}>
                          {template.name} · {channelLabel(template.channel)}
                        </option>
                      ))}
                    </select>
                    {campaignFieldError?.field === "templateId" ? <p className={styles.fieldError} id="campaign-template-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                  <div>
                    <label htmlFor="campaign-channel">발송 채널</label>
                    <select
                      id="campaign-channel"
                      value={campaignDraft.channel}
                      aria-invalid={campaignFieldError?.field === "channel"}
                      aria-describedby={campaignFieldError?.field === "channel" ? "campaign-channel-error" : undefined}
                      onChange={(event) => {
                        setCampaignDraft({ ...campaignDraft, channel: event.target.value });
                        const template = state.templates.find((item) => item.id === selectedTemplateId);
                        if (template && template.channel !== event.target.value) setSelectedTemplateId("");
                      }}
                    >
                      <option value="SMS">SMS · 단문</option>
                      <option value="LMS">LMS · 장문</option>
                      <option value="MMS">MMS · 사진</option>
                      <option value="ALIMTALK">알림톡</option>
                    </select>
                    {campaignFieldError?.field === "channel" ? <p className={styles.fieldError} id="campaign-channel-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                </div>

                <div>
                  <label htmlFor="campaign-body">메시지 내용</label>
                  <textarea
                    id="campaign-body"
                    maxLength={2000}
                    required
                    rows={4}
                    value={campaignDraft.body}
                    aria-invalid={campaignFieldError?.field === "body"}
                    aria-describedby={campaignFieldError?.field === "body" ? "campaign-body-error campaign-variables" : "campaign-variables"}
                    onChange={(event) => setCampaignDraft({ ...campaignDraft, body: event.target.value })}
                  />
                  <p className={styles.help} id="campaign-variables">
                    사용 가능 변수: &#123;&#123;이름&#125;&#125;, &#123;&#123;행사명&#125;&#125;, &#123;&#123;행사일&#125;&#125;, &#123;&#123;티켓링크&#125;&#125;, &#123;&#123;럭키번호&#125;&#125;.
                    럭키번호는 <Link href={`/console/events/${encodeURIComponent(eventId)}/draws`}>추첨·투표에서 먼저 발급</Link>하세요.
                  </p>
                  {campaignFieldError?.field === "body" ? <p className={styles.fieldError} id="campaign-body-error" role="alert">{campaignFieldError.message}</p> : null}
                </div>

                {campaignDraft.channel === "MMS" ? (
                  <div>
                    <label htmlFor="campaign-image">MMS 사진 · JPG 200KB 이하</label>
                    <input
                      id="campaign-image"
                      type="file"
                      accept="image/jpeg"
                      disabled={uploadingImage || archived}
                      title={archived ? archivedReason : undefined}
                      aria-invalid={campaignFieldError?.field === "imageFileId"}
                      aria-describedby={campaignFieldError?.field === "imageFileId" ? "campaign-image-error" : "campaign-image-help"}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file && !archived) void uploadMmsImage(file);
                        event.target.value = "";
                      }}
                    />
                    <p className={styles.help} id="campaign-image-help">
                      {uploadingImage
                        ? "이미지를 올리는 중입니다."
                        : campaignDraft.imageFileId
                          ? `첨부됨: ${campaignDraft.imageName || "사진 1장"} · MMS는 별도 요금이 발생합니다.`
                          : "사진을 첨부해야 발송을 등록할 수 있습니다."}
                    </p>
                    {campaignFieldError?.field === "imageFileId" ? <p className={styles.fieldError} id="campaign-image-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                ) : null}

                <fieldset id="campaign-recipients" className={styles.recipientFieldset} aria-describedby={campaignFieldError?.field === "ids" ? "campaign-recipients-error" : "recipient-summary"}>
                  <legend>발송 대상</legend>
                  <div className={styles.recipientFilters}>
                    <div>
                      <label htmlFor="recipient-status-filter">상태</label>
                      <select
                        id="recipient-status-filter"
                        value={recipientStatus}
                        onChange={(event) => setRecipientStatus(event.target.value)}
                      >
                        {RECIPIENT_STATUS_OPTIONS.map((option) => (
                          <option value={option.value} key={option.value}>{option.label}</option>
                        ))}
                      </select>
                    </div>
                    <div className={styles.recipientSearch}>
                      <label htmlFor="recipient-search">
                        <span className="sr-only">수신자 이름·소속·연락처 검색</span>
                      </label>
                      <input
                        id="recipient-search"
                        type="search"
                        placeholder="이름·소속·연락처 검색"
                        value={recipientQuery}
                        onChange={(event) => setRecipientQuery(event.target.value)}
                      />
                    </div>
                  </div>
                  <p className={styles.selectionSummary} id="recipient-summary" role="status">
                    선택 {selectedCount}명 · 확정 {selectedApproved}명 · 승인 대기 {selectedPending}명 · 대기 명단 {selectedWaitlist}명
                    {selectedMissing > 0 ? ` · 목록 제외 ${selectedMissing}명` : ""}
                    {outsideVisibleCount > 0 ? ` · 화면 밖 선택 ${outsideVisibleCount}명 유지 중` : ""}
                  </p>
                  {pendingRiskCount > 0 ? (
                    <p className={styles.riskWarning} id="recipient-risk-warning" role="alert">
                      선택 대상 중 승인 대기·대기 명단이 {pendingRiskCount}명 있습니다. 발송 전에 대상을 다시 확인하세요.
                    </p>
                  ) : null}
                  <details className={styles.recipientDetails} open={recipientListOpen} onToggle={(event) => setRecipientListOpen((event.target as HTMLDetailsElement).open)}>
                    <summary className={styles.recipientSummaryButton}>
                      수신자 목록 열기·닫기
                      <span className={styles.recipientSummaryCount}>
                        {recipientSearch || showSelectedOnly || recipientStatus !== "ALL"
                          ? `표시 ${visibleRecipients.length}명`
                          : `발송 가능 ${activeParticipants.length}명`}
                      </span>
                    </summary>
                    <div className={styles.recipientTools}>
                      <span>{recipientSearch || showSelectedOnly || recipientStatus !== "ALL" ? `표시 ${visibleRecipients.length}명` : `발송 가능 ${activeParticipants.length}명`}</span>
                      <div>
                        <button type="button" className={styles.textButton} onClick={() => setAllRecipients(true, visibleRecipients)}>표시 추가</button>
                        <button type="button" className={styles.textButton} onClick={() => setAllRecipients(false, visibleRecipients)}>표시 해제</button>
                        <button type="button" className={styles.textButton} id="recipient-clear-all" onClick={clearAllRecipients}>전체 선택 해제</button>
                      </div>
                    </div>
                  <label className={styles.selectedOnlyOption}>
                    <input
                      id="recipient-selected-only"
                      type="checkbox"
                      checked={showSelectedOnly}
                      onChange={(event) => setShowSelectedOnly(event.target.checked)}
                    />
                    선택 대상만 보기({selectedCount}명)
                  </label>
                  {visibleRecipients.length ? (
                    <ul className={styles.recipientList} aria-label="참가자 선택">
                      {visibleRecipients.map((person) => (
                        <li key={person.id}>
                          <label className={styles.recipientRow}>
                            <input
                              type="checkbox"
                              checked={selectedIds.includes(person.id)}
                              onChange={() => toggleRecipient(person.id)}
                            />
                            <span className={styles.recipientName}>{person.name}</span>
                            <span className={styles.recipientMeta}>
                              {person.company ? `${person.company} · ` : ""}{maskPhone(person.phone)} · {participantStatusLabel(person.status)}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : showSelectedOnly ? (
                    <p className={styles.empty}>선택한 대상이 없습니다.</p>
                  ) : activeParticipants.length ? (
                    <p className={styles.empty}>조건에 맞는 수신자가 없습니다.</p>
                  ) : (
                    <p className={styles.empty}>등록된 참가자가 없습니다.</p>
                  )}
                  </details>
                  {campaignFieldError?.field === "ids" ? <p className={styles.fieldError} id="campaign-recipients-error" role="alert">{campaignFieldError.message}</p> : null}
                </fieldset>



                <div className={uiStyles.formGrid}>
                  <div>
                    <label htmlFor="campaign-scheduled">예약 등록(수동 실행) · 선택</label>
                    <input
                      id="campaign-scheduled"
                      type="datetime-local"
                      value={campaignDraft.scheduled}
                      aria-invalid={campaignFieldError?.field === "scheduled"}
                      aria-describedby={campaignFieldError?.field === "scheduled" ? "campaign-scheduled-error campaign-scheduled-help" : "campaign-scheduled-help"}
                      onChange={(event) => setCampaignDraft({ ...campaignDraft, scheduled: event.target.value })}
                    />
                    <p className={styles.help} id="campaign-scheduled-help">
                      예약 시각 이후 이 화면에서 발송 실행을 눌러야 합니다. 자동 발송은 지원하지 않습니다.
                    </p>
                    {campaignFieldError?.field === "scheduled" ? <p className={styles.fieldError} id="campaign-scheduled-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                  <label className={styles.simulateOption}>
                    <input
                      type="checkbox"
                      checked={campaignDraft.simulate}
                      onChange={(event) => setCampaignDraft({ ...campaignDraft, simulate: event.target.checked })}
                    />
                    <span><strong>모의 발송으로 기록</strong><small>실제 수신자에게 전달되지 않습니다.</small></span>
                  </label>
                </div>

                {campaignError ? <p className={styles.fieldError} role="alert">{campaignError}</p> : null}
                <ConsoleFormActions
                  note={(
                    <span id="campaign-submit-warning">
                      선택 {selectedCount}명 · {channelLabel(campaignDraft.channel)} · {submitModeLabel}{simulateDraft ? "" : " · 발송은 되돌릴 수 없습니다."}
                      {campaignDraft.channel === "MMS" && !simulateDraft ? " 별도 요금이 발생합니다." : ""}
                      {selectedCount === 0 ? " 수신자를 먼저 고르세요." : ""}
                    </span>
                  )}
                >
                  <button
                    id="campaign-submit"
                    className="button button-primary"
                    type="submit"
                    disabled={busyAction !== null || uploadingImage || archived}
                    title={archived ? archivedReason : undefined}
                  >
                    {submitButtonLabel}
                  </button>
                </ConsoleFormActions>
                {sendPending ? (
                  <ConsoleConfirm
                    summary={confirmLines(sendPending.summary)}
                    confirmLabel={sendPending.confirmLabel}
                    busy={busyAction === "campaign"}
                    onConfirm={() => {
                      const pending = sendPending;
                      setSendPending(null);
                      void executeCampaignCreate(pending);
                    }}
                    onCancel={() => setSendPending(null)}
                  />
                ) : null}
              </form>
            </ConsoleSection>

            <ConsoleSection
              headingId="templates-heading"
              title="메시지 템플릿"
              description="필요할 때 펼쳐서 관리"
              divider
            >
              {templateNotice ? <ConsoleFeedback kind="success">{templateNotice}</ConsoleFeedback> : null}
              {templateError ? <ConsoleFeedback kind="error">{templateError}</ConsoleFeedback> : null}
              <details className={styles.templateDetails} id="template-details">
                <summary>템플릿 관리 열기</summary>
                {state.templates.length ? (
                  <ul className={styles.templateList}>
                    {state.templates.map((template) => (
                      <li key={template.id} className={styles.templateRow}>
                        <div className={styles.templateSummary}>
                          <strong>{template.name}</strong>
                          <span>{channelLabel(template.channel)}</span>
                          {template.channel === "ALIMTALK" ? <small>승인 ID {template.solapiTemplateId ? "등록됨" : "미등록"}</small> : null}
                        </div>
                        <div className={styles.templateActions}>
                          <button type="button" className="button button-secondary" onClick={() => useTemplate(template)}>사용</button>
                          <button
                            type="button"
                            className={styles.textButton}
                            onClick={() => {
                              setTemplateDraft({ ...template });
                              setTemplateError(null);
                              setTemplateFieldError(null);
                              setTemplateNotice(null);
                            }}
                          >편집</button>
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className={styles.empty}>저장된 템플릿이 없습니다. 자주 쓰는 안내 문구를 등록하세요.</p>
                )}

                <form className={uiStyles.formStack} onSubmit={saveTemplate}>
                  <h3>{templateDraft.id ? "템플릿 수정" : "새 템플릿"}</h3>
                  <div>
                    <label htmlFor="template-name">템플릿 이름</label>
                    <input
                      id="template-name"
                      maxLength={80}
                      required
                      value={templateDraft.name}
                      aria-invalid={templateFieldError?.field === "name"}
                      aria-describedby={templateFieldError?.field === "name" ? "template-name-error" : undefined}
                      onChange={(event) => setTemplateDraft({ ...templateDraft, name: event.target.value })}
                    />
                    {templateFieldError?.field === "name" ? <p className={styles.fieldError} id="template-name-error" role="alert">{templateFieldError.message}</p> : null}
                  </div>
                  <div>
                    <label htmlFor="template-channel">채널</label>
                    <select
                      id="template-channel"
                      value={templateDraft.channel}
                      aria-invalid={templateFieldError?.field === "channel"}
                      aria-describedby={templateFieldError?.field === "channel" ? "template-channel-error" : undefined}
                      onChange={(event) => setTemplateDraft({ ...templateDraft, channel: event.target.value })}
                    >
                      <option value="SMS">SMS · 단문</option>
                      <option value="LMS">LMS · 장문</option>
                      <option value="MMS">MMS · 이미지</option>
                      <option value="ALIMTALK">알림톡</option>
                    </select>
                    {templateDraft.channel === "MMS" ? (
                      <p className={styles.help}>MMS 이미지는 발송할 때 첨부합니다. 템플릿에는 문구만 저장됩니다.</p>
                    ) : null}
                    {templateFieldError?.field === "channel" ? <p className={styles.fieldError} id="template-channel-error" role="alert">{templateFieldError.message}</p> : null}
                  </div>
                  {templateDraft.channel === "ALIMTALK" ? (
                    <div>
                      <label htmlFor="template-solapi-id">Solapi 승인 템플릿 ID</label>
                      <input
                        id="template-solapi-id"
                        maxLength={120}
                        required
                        value={templateDraft.solapiTemplateId}
                        aria-invalid={templateFieldError?.field === "solapiTemplateId"}
                        aria-describedby={templateFieldError?.field === "solapiTemplateId" ? "template-solapi-id-error" : undefined}
                        onChange={(event) => setTemplateDraft({ ...templateDraft, solapiTemplateId: event.target.value })}
                      />
                      {templateFieldError?.field === "solapiTemplateId" ? <p className={styles.fieldError} id="template-solapi-id-error" role="alert">{templateFieldError.message}</p> : null}
                    </div>
                  ) : null}
                  <div>
                    <label htmlFor="template-body">메시지 내용</label>
                    <textarea
                      id="template-body"
                      maxLength={2000}
                      required
                      rows={3}
                      value={templateDraft.body}
                      aria-invalid={templateFieldError?.field === "body"}
                      aria-describedby={templateFieldError?.field === "body" ? "template-body-error template-variables" : "template-variables"}
                      onChange={(event) => setTemplateDraft({ ...templateDraft, body: event.target.value })}
                    />
                    <p className={styles.help} id="template-variables">사용 가능 변수: &#123;&#123;이름&#125;&#125;, &#123;&#123;행사명&#125;&#125;, &#123;&#123;행사일&#125;&#125;, &#123;&#123;티켓링크&#125;&#125;, &#123;&#123;럭키번호&#125;&#125;(미발급 시 빈칸)</p>
                    {templateFieldError?.field === "body" ? <p className={styles.fieldError} id="template-body-error" role="alert">{templateFieldError.message}</p> : null}
                  </div>
                  {templateFieldError && !FIELD_LABELS[templateFieldError.field] ? <p className={styles.fieldError} role="alert">{templateFieldError.message}</p> : null}
                  <ConsoleFormActions>
                    <button className="button button-secondary" type="submit" disabled={busyAction !== null || archived} title={archived ? archivedReason : undefined}>
                      {busyAction === "template" ? "저장 중…" : templateDraft.id ? "템플릿 저장" : "템플릿 추가"}
                    </button>
                    {templateDraft.id ? (
                      <button type="button" className={styles.textButton} onClick={() => { setTemplateDraft(EMPTY_TEMPLATE); setTemplateFieldError(null); setTemplateError(null); setTemplateNotice(null); }}>새로 작성</button>
                    ) : null}
                  </ConsoleFormActions>
                </form>
              </details>
            </ConsoleSection>

          <ConsoleSection
            headingId="history-heading"
            title="발송 기록"
            action={(
              <button className="button button-secondary" type="button" disabled={busyAction !== null} onClick={() => void refresh(true)}>
                상태 새로고침
              </button>
            )}
            divider
          >
            <p className={styles.help}>발송 기록에는 참가자 티켓 링크가 표시되지 않습니다.</p>
            {attentionOnly ? (
              <div className={styles.attentionFilter}>
                <p role="status">발송 확인이 필요한 발송만 보고 있습니다 · {visibleCampaigns.length}건</p>
                <Link
                  className="button button-secondary"
                  href={`/console/events/${encodeURIComponent(eventId)}/messages`}
                >
                  전체 발송 기록 보기
                </Link>
              </div>
            ) : null}
            {visibleCampaigns.length ? (
              <>
              <ul ref={historyListRef} className={styles.campaignList}>
                {shownCampaigns.map((campaign) => {
                  const due = !campaign.scheduled || Date.parse(campaign.scheduled) <= Date.now();
                  const canExecute = campaign.status === "SCHEDULED" && due;
                  const canRetry = campaign.status === "NEEDS_CONNECTION";
                  const canSync = campaign.status === "SENDING" || campaign.status === "PARTIAL";
                  const canCancel = campaign.status === "SCHEDULED" || campaign.status === "NEEDS_CONNECTION";
                  const retryAmbiguous = ambiguousRetryIds.includes(campaign.id);
                  const syncAmbiguous = ambiguousSyncIds.includes(campaign.id);
                  const cancelAmbiguous = ambiguousCancelIds.includes(campaign.id);
                  return (
                    <li key={campaign.id} id={`campaign-${campaign.id}`} tabIndex={-1} data-history-row>
                      <article className={styles.campaignCard}>
                        <div className={styles.campaignTop}>
                          <div className={styles.campaignTitle}>
                            <h3>{campaign.title}</h3>
                            <span className={`${styles.status} ${statusTone(campaign.status)}`}>{messageStatusLabel(campaign.status)}</span>
                            {campaign.status === "SCHEDULED" && campaign.simulate ? (
                              <span className={`${styles.status} ${styles.statusNeutral}`}>모의 예약·전달 없음</span>
                            ) : null}
                          </div>
                          <div className={styles.campaignActions}>
                            {canExecute ? (
                              <button type="button" className="button button-secondary" disabled={busyAction !== null || archived} title={archived ? archivedReason : undefined} onClick={() => { setReloadPending(null); setHistoryPending({ id: campaign.id, kind: "execute" }); }}>
                                {busyAction === `retry:${campaign.id}` ? "실행 중…" : retryAmbiguous ? "같은 요청 다시 시도" : "발송 실행"}
                              </button>
                            ) : null}
                            {canRetry ? (
                              <button type="button" className="button button-secondary" disabled={busyAction !== null || archived} title={archived ? archivedReason : undefined} onClick={() => { setReloadPending(null); setHistoryPending({ id: campaign.id, kind: "retry" }); }}>
                                {busyAction === `retry:${campaign.id}` ? "재시도 중…" : retryAmbiguous ? "같은 요청 다시 시도" : "재시도"}
                              </button>
                            ) : null}
                            {canSync ? (
                              <button type="button" className="button button-secondary" disabled={busyAction !== null || archived} title={archived ? archivedReason : undefined} onClick={() => void syncCampaign(campaign)}>
                                {busyAction === `sync:${campaign.id}` ? "확인 중…" : syncAmbiguous ? "같은 요청 다시 확인" : "발송 결과 확인"}
                              </button>
                            ) : null}
                            {canCancel ? (
                              <button type="button" className="button button-secondary" disabled={busyAction !== null || archived} title={archived ? archivedReason : undefined} onClick={() => { setReloadPending(null); setHistoryPending({ id: campaign.id, kind: "cancel" }); }}>
                                {busyAction === `cancel:${campaign.id}` ? "취소 중…" : cancelAmbiguous ? "같은 요청 다시 시도" : campaign.status === "SCHEDULED" ? "예약 취소" : "발송 취소"}
                              </button>
                            ) : null}
                          </div>
                        </div>
                        {historyPending?.id === campaign.id ? (
                          <ConsoleConfirm
                            summary={confirmLines(
                              historyPending.kind === "cancel"
                                ? cancelSummary(campaign)
                                : retrySummary(campaign, historyPending.kind)
                            )}
                            confirmLabel={
                              historyPending.kind === "cancel"
                                ? campaign.status === "SCHEDULED" ? "예약을 취소한다" : "발송 요청을 취소한다"
                                : historyPending.kind === "execute"
                                  ? "실행한다"
                                  : "재시도한다"
                            }
                            busy={busyAction === `retry:${campaign.id}` || busyAction === `cancel:${campaign.id}`}
                            onConfirm={() => {
                              const pending = historyPending;
                              setHistoryPending(null);
                              if (pending.kind === "cancel") void executeCancel(campaign);
                              else void executeRetry(campaign, pending.kind);
                            }}
                            onCancel={() => setHistoryPending(null)}
                          />
                        ) : null}
                        <dl className={styles.campaignMeta}>
                          <div><dt>채널</dt><dd>{channelLabel(campaign.channel)}</dd></div>
                          {campaign.imageName ? <div><dt>첨부 이미지</dt><dd>{campaign.imageName}</dd></div> : null}
                          <div><dt>대상</dt><dd>{campaign.recipientIds.length}명</dd></div>
                          <div><dt>요청 시각</dt><dd>{formatDate(campaign.at)}</dd></div>
                          {campaign.scheduled ? <div><dt>예약 시각</dt><dd>{formatDate(campaign.scheduled)}</dd></div> : null}
                          <div><dt>시도</dt><dd>{campaign.attempts}회</dd></div>
                        </dl>
                        {campaign.status === "NEEDS_CONNECTION" ? (
                          <p className={styles.campaignHint}>공급사 연결 전입니다. 재시도해도 연결되지 않으면 실제로 전송되지 않습니다.</p>
                        ) : null}
                        {campaign.status === "FAILED" ? (
                          <>
                            <p className={styles.campaignHint}>발송이 실패했습니다. 같은 내용으로 다시 보내려면 위에서 새 캠페인을 만드세요. 아래 버튼으로 실패한 내용·대상을 불러오면 다시 입력하지 않아도 됩니다.</p>
                            <div>
                              <button
                                type="button"
                                className="button button-secondary"
                                disabled={busyAction !== null || uploadingImage || archived || !state.canManage}
                                title={archived ? archivedReason : undefined}
                                onClick={() => requestFailedReload(campaign)}
                              >
                                내용·대상 불러오기
                              </button>
                            </div>
                            {reloadPending?.id === campaign.id ? (
                              <ConsoleConfirm
                                summary={confirmLines(`〈${campaign.title}〉 내용을 작성 중인 화면에 불러올까요?\n\n작성 중인 발송 내용·선택이 교체됩니다. 예약 시각은 다시 지정해야 하며, 바로 발송되지 않습니다.`)}
                                confirmLabel="불러온다"
                                // Nonmodal confirm: stay disabled while any
                                // action or upload runs so the overwrite
                                // cannot race a competing submit. The
                                // confirm handler re-validates before
                                // replacing the draft.
                                busy={busyAction !== null || uploadingImage}
                                onConfirm={() => applyFailedReload(campaign)}
                                onCancel={() => setReloadPending(null)}
                              />
                            ) : null}
                          </>
                        ) : null}
                        {campaign.status === "SCHEDULED" && !due ? (
                          <p className={styles.campaignHint}>
                            예약 시각 이후에 발송 실행을 눌러야 {campaign.simulate ? "기록됩니다. 실행해도 수신자에게 전달되지 않습니다." : "발송됩니다."} 자동 발송은 지원하지 않습니다.
                          </p>
                        ) : null}
                        <details className={styles.deliveries}>
                          <summary>수신자별 처리 상태 <span>{campaign.deliveries.length}명</span></summary>
                          {campaign.deliveries.length ? (
                            <ul>
                              {campaign.deliveries.map((delivery, index) => (
                                <li key={`${delivery.participantId}-${index}`}>
                                  <span className={styles.deliveryName}>{delivery.name || "이름 미등록"}</span>
                                  <span className={`${styles.status} ${statusTone(delivery.status)}`}>{deliveryStatusLabel(delivery.status)}</span>
                                  <time dateTime={delivery.at || undefined}>{formatDate(delivery.at)}</time>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <p className={styles.empty}>표시할 수신 처리 내역이 없습니다.</p>
                          )}
                        </details>
                      </article>
                    </li>
                  );
                })}
              </ul>
              {remainingCampaigns > 0 ? (
                <button
                  id="campaign-history-more"
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    pendingHistoryFocusRef.current = shownCampaigns.length;
                    setHistoryLimit((current) => current + 10);
                  }}
                >
                  {`이전 발송 더 보기 (${remainingCampaigns})`}
                </button>
              ) : null}
              </>
            ) : (
              <p className={styles.empty}>
                {attentionOnly
                  ? "확인이 필요한 발송이 없습니다. 전체 발송 기록에서 최근 상태를 확인할 수 있습니다."
                  : "발송 기록이 없습니다. 위에서 수신 대상을 선택해 첫 발송을 준비하세요."}
              </p>
            )}
          </ConsoleSection>
        </>
      )}
    </ConsolePage>
  );
}
