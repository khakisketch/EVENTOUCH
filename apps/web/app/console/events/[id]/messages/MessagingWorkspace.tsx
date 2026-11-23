"use client";

import { measureMessage, messageContentIssue } from "../../../../../lib/message-composition";
import { findSmsTextIssue } from "../../../../../lib/sms-text-validation.cjs";
import ValidatedForm from "../../../../ui/ValidatedForm";
import ProductButton from "../../../../ui/ProductButton";

import { readCloseSnapshot, type CloseSnapshot } from "../../../console-event-close";

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import ProductLink from "../../../../ui/ProductLink";
import { useRouter, useSearchParams } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import { readRecipientStatusHandoff } from "../../../console-handoff";
import { useConsoleDraftGuard, useConsoleLeaveConfirmation, UNCONFIRMED_WRITE_CLOSE_MESSAGE } from "../../../console-draft-guard";
import StageTransitionConfirmation from "../../../console-ui/StageTransitionConfirmation";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleAvatar from "../../../console-ui/ConsoleAvatar";
import ConsoleEmptyState from "../../../console-ui/ConsoleEmptyState";
import StatusPill, { type StatusPillTone } from "../../../console-ui/StatusPill";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleChoiceGroup from "../../../console-ui/ConsoleChoiceGroup";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import ConsolePage from "../../../console-ui/ConsolePage";
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleRefreshButton from "../../../console-ui/ConsoleRefreshButton";
import { MessageIcon, UsersIcon } from "../../../admin-icons";
import ConsoleSectionNav, { requestConsoleTask } from "../../../console-ui/ConsoleSectionNav";
import CountTabs from "../../../console-ui/CountTabs";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import { consoleFetch, subscribeConsoleFreshness } from "../../../../../lib/console-api";
import { hasValidScheduledInstant, isOverdueManualMessage, messageNeedsAttention } from "../../../../../lib/message-attention";
import { canWriteEvent } from "../../../../../lib/event-capabilities";
import { abandonOperatorAttempt, acknowledgeOperatorReceipt, confirmsCharsetReviewedMessageCreate, confirmsProviderCheck, confirmsTemplateSave, confirmsTemplateArchive, isOrganizationContextBlock } from "../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../lib/use-event-receipts";
import uiStyles from "../../../console-ui/console-ui.module.css";
import { ArrowDownIcon, ArrowRightIcon, ArrowUpIcon, PencilIcon, PlusIcon, XIcon } from "../../../console-ui/ConsoleIcons";
import styles from "./MessagingWorkspace.module.css";

type Template = {
  id: string;
  name: string;
  channel: string;
  body: string;
  solapiTemplateId: string;
  archived: boolean;
  version: number;
};
// notEntered: a confirmed-known "never came in" state from the bootstrap's
// attendance fields (inside/everIn). Unknown or under-review presence is not
// counted, so the 미입장 preset never guesses.
type Participant = { id: string; name: string; company: string; group: string; phone: string; status: string; reviewVersion: string; ticketReview: string; notEntered: boolean };
function recipientEligible(person: Participant): boolean {
  return person.status.toUpperCase() !== "CANCELLED" && person.ticketReview !== "cancelled";
}
type Delivery = { participantId: string; name: string; status: string; at: string; resultMatchUnconfirmed: boolean; genericProviderResult: string; manualProviderReview: string; snapshotPhone: string; reference: string | null };
type Campaign = {
  id: string;
  title: string;
  channel: string;
  body: string;
  templateId: string;
  recipientIds: string[];
  status: string;
  scheduled: string;
  scheduleMode: "MANUAL" | "AUTO";
  simulate: boolean;
  smsFallback: boolean;
  at: string;
  attempts: number;
  acceptedCount: number | null;
  submissionUnconfirmed: boolean;
  recipientChangeCount: number;
  recipientRoutingReviewed: boolean;
  ticketLinkProblemCount: number;
  ticketLinkProblemUnknown: boolean;
  alimtalkUnsupported: boolean;
  mmsUnsupported: boolean;
  personalizedTextTooLongCount: number;
  smsTextProblemCount: number;
  smsTextProblemField: string;
  smsTextProblemUnknown: boolean;
  smsTextReloadSafe: boolean;
  deliveryUnconfirmed: boolean;
  providerGroupId: string;
  genericTransport: boolean;
  genericAttemptActive: boolean | null;
  genericSubmissionUnconfirmed: boolean;
  submissionId: string | null;
  providerKind: string;
  imageFileId: string;
  imageName: string;
  deliveries: Delivery[];
};
type ReadyState = {
  kind: "ready";
  closeSnapshot: CloseSnapshot;
  eventName: string;
  eventDate: string;
  stage: string;
  eventMeta: ConsoleEventMeta;
  canManage: boolean;
  canWriteMessages: boolean;
  canArchive: boolean;
  integrations: { connected: boolean; sender: string; provider: string; orgIsolated: boolean };
  messageSchedule: MessageSchedule | null;
  participants: Participant[];
  templates: Template[];
  campaigns: Campaign[];
};
type RecipientChange = { id: string; name: string; currentName: string | null; identityPhone: string; reasons: string[]; beforeStatus: string | null; afterStatus: string | null; beforeGroup: string | null; afterGroup: string | null; beforePhone: string | null; afterPhone: string | null };
type ChangeDetails = { available: boolean; changes: RecipientChange[] };
type MessageSchedule = { observedAt: string; autoConfigured: boolean; eligibleForAuto: boolean; workerStarted: boolean; lastAttemptAt: string; lastResult: string; blocked: Array<{ id: string; reason: string; missing: number }> };
type WorkspaceState = { kind: "loading" } | { kind: "failed"; message: string } | ReadyState;
type TemplateDraft = {
  id: string;
  name: string;
  channel: string;
  body: string;
  solapiTemplateId: string;
  version?: number;
};
type TemplateAttempt = { eventId: string; id: string; command: "template.save" | "template.archive"; fingerprint: string; payload: Record<string, unknown>; draft: TemplateDraft; target?: Template };
type CampaignDraft = {
  title: string;
  channel: string;
  body: string;
  scheduled: string;
  scheduleMode: "MANUAL" | "AUTO";
  simulate: boolean;
  smsFallback: boolean;
  imageFileId: string;
  imageName: string;
};
type CommandResult = Record<string, unknown>;
type ServerError = { message: string; field: string | null; index?: number };
type CampaignFieldError = { message: string; field: string; index?: number };
// In-place confirm for the compose submit: the validated payload snapshot
// plus the exact summary the operator confirms. Immutable state references
// bind that confirmation to the draft/selection the operator reviewed.
type SendPending = {
  eventId: string;
  payload: Record<string, unknown>;
  id: string;
  summary: string;
  confirmLabel: string;
  reviewedDraft: CampaignDraft;
  reviewedIds: string[];
  reviewedTemplateId: string;
  reviewedAttachmentRevision: number;
};
type ProviderCheckAttempt = {
  eventId: string; id: string; name: string; uncertain: boolean;
  payload: { id: string; participantId: string; outcome: "ACCEPTED" | "NOT_ACCEPTED"; expectedSubmissionId: string | null };
};

function recipientVersionsMatch(pending: SendPending, people: Participant[]): boolean {
  const versions = pending.payload.expectedRecipientVersions;
  const current = new Map(people.filter(recipientEligible).map(person => [person.id, person.reviewVersion]));
  return Array.isArray(versions) && pending.reviewedIds.every((id, index) => current.get(id) === versions[index]);
}

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
  scheduleMode: "MANUAL",
  simulate: false,
  smsFallback: true,
  imageFileId: "",
  imageName: "",
};

// Illustrative values never contain a real ticket bearer or recipient data.
// Sending and SMS/LMS classification still use the server's real values.
function previewMessageExample(body: string, eventName: string, eventDate: string): string {
  const values: Record<string, string> = {
    이름: "홍길동",
    행사명: eventName || "행사명",
    행사일: eventDate || "행사일",
    티켓링크: "[개별 티켓 링크]",
    럭키번호: "[배정된 번호]",
  };
  return body.replace(/\{\{(이름|행사명|행사일|티켓링크|럭키번호)\}\}/g, (_match, key: string) => values[key]);
}
// Reopened 2026-11-23 (owner decision): one-screen checklist composer.
// Audience presets come first (A), content can start from a purpose template
// (B's purposes as a loader, not a separate screen), and the four zones sit
// on one screen (C). Purpose templates are built-in starting text only: they
// never send, never bind a server template, and every field stays editable.
type AudiencePreset = "approved" | "not-entered" | "pending";
type EventOffset = { days: number; time: string };
type PurposeTemplate = { key: string; label: string; hint: string; body: string; audience: AudiencePreset | null; schedule: EventOffset | null };
const PURPOSE_TEMPLATES: readonly PurposeTemplate[] = [
  { key: "reminder", label: "전날 리마인드", hint: "참가 확정 · 행사 1일 전 18:00", audience: "approved", schedule: { days: 1, time: "18:00" },
    body: "안녕하세요 {{이름}}님, 내일 {{행사명}}에서 뵙겠습니다.\n일시: {{행사일}}\n입장할 때 아래 티켓의 QR을 보여 주세요.\n{{티켓링크}}" },
  { key: "entry", label: "입장 안내", hint: "확정자 중 미입장 · 지금", audience: "not-entered", schedule: null,
    body: "{{이름}}님, {{행사명}} 입장이 시작되었습니다.\n입구에서 아래 티켓의 QR을 보여 주세요.\n{{티켓링크}}" },
  { key: "change", label: "일정·장소 변경", hint: "참가 확정 · 지금", audience: "approved", schedule: null,
    body: "[{{행사명}}] 변경 안내\n{{이름}}님, 행사 정보가 바뀌어 알려 드립니다.\n- 변경 전: \n- 변경 후: \n문의: " },
  { key: "winner", label: "당첨 안내", hint: "직접 고른 당첨자 · 지금", audience: null, schedule: null,
    body: "{{이름}}님, 축하합니다! {{행사명}} 추첨에 당첨되었습니다.\n럭키 번호: {{럭키번호}}\n경품 수령처에서 티켓을 보여 주세요." },
  { key: "thanks", label: "감사 인사", hint: "참가 확정 · 행사 다음 날 10:00", audience: "approved", schedule: { days: -1, time: "10:00" },
    body: "{{이름}}님, {{행사명}}에 함께해 주셔서 감사합니다.\n다음 행사에서 다시 뵙겠습니다." },
];
const EVENT_OFFSET_CHOICES = [
  { days: 3, label: "행사 3일 전" },
  { days: 2, label: "행사 2일 전" },
  { days: 1, label: "행사 1일 전" },
  { days: 0, label: "행사 당일" },
  { days: -1, label: "행사 다음 날" },
] as const;
// Event-relative scheduling is a convenience over the existing absolute
// reservation: it computes one Korea-time datetime-local value from the event
// date. The server still stores that absolute time, so a later change to the
// event date does not move the reservation (stated next to the control).
export function eventRelativeSchedule(eventDate: string, offset: EventOffset): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(eventDate);
  if (!match || !/^([01]\d|2[0-3]):[0-5]\d$/.test(offset.time)) return "";
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) - offset.days));
  if (Number.isNaN(day.getTime())) return "";
  return `${day.toISOString().slice(0, 10)}T${offset.time}`;
}
function koreaToday(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}
// Records need a title; the operator no longer has to invent one. An empty
// title becomes "<purpose or 안내 메시지> · M/D" (the send day, Korea time).
export function autoCampaignTitle(purposeLabel: string, scheduled: string, today: string): string {
  const day = /^\d{4}-(\d{2})-(\d{2})/.exec(scheduled || today);
  return `${purposeLabel || "안내 메시지"}${day ? ` · ${Number(day[1])}/${Number(day[2])}` : ""}`;
}

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
// The shared attention contract includes overdue reservations, unconfirmed
// outcomes and server-reported blockers. Timezone-free dates are never due.
function isOverdue(campaign: Campaign, now: number): boolean {
  // An unzoned legacy value cannot be placed on a timeline reliably.
  if (campaign.scheduled && !hasValidScheduledInstant(campaign.scheduled)) return false;
  try {
    return isOverdueManualMessage(campaign as unknown, now);
  } catch {
    return (
      campaign.status === "SCHEDULED" &&
      Boolean(campaign.scheduled) &&
      Number.isFinite(Date.parse(campaign.scheduled)) &&
      Date.parse(campaign.scheduled) <= now
    );
  }
}
function needsAttention(campaign: Campaign, now: number): boolean {
  if (campaign.submissionUnconfirmed ||
    (campaign.status === "SENDING" && campaign.deliveries.some(delivery => delivery.resultMatchUnconfirmed))) return true;
  if (campaign.status === "SCHEDULED" && !hasValidScheduledInstant(campaign.scheduled)) return true;
  try {
    return messageNeedsAttention(campaign as unknown, now);
  } catch {
    return ATTENTION_STATUSES.includes(campaign.status) || isOverdue(campaign, now);
  }
}
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

// Transient responses cannot establish the outcome of an earlier attempt.
function isAmbiguousStatus(status: number): boolean {
  return status >= 500 || [408, 425, 429].includes(status);
}

const ALIMTALK_FALLBACK_NOTICE = "알림톡 미전달 시 문자(SMS/LMS)로 대체 발송을 시도합니다. 대체 문자 요금이 적용될 수 있습니다.";
const ALIMTALK_NO_FALLBACK_NOTICE = "알림톡을 전달하지 못해도 문자로 대체 발송하지 않습니다.";

// Only the Solapi integration uses the documented SMS restriction. This is a
// partial check, not proof that every other character can be delivered.
function campaignCharsetIssue(draft: CampaignDraft, provider: string): CampaignFieldError | null {
  if (provider !== "solapi" || draft.simulate || (draft.channel === "ALIMTALK" && !draft.smsFallback)) return null;
  const body = findSmsTextIssue(draft.body);
  if (body) return draft.channel === "ALIMTALK"
    ? { field: "smsFallback", message: "이 템플릿에는 대체 문자로 보낼 수 없는 문자 또는 제어문자가 있습니다. 문자 대체를 끄거나 다른 승인 템플릿을 선택하세요." }
    : { field: "body", index: body.index, message: "문자로 보낼 수 없는 문자 또는 제어문자가 있습니다. 표시된 위치를 확인하고 수정하세요." };
  // The title is truncated to 40 bytes and exists only for a recipient whose
  // final text becomes LMS/MMS. The server checks that actual sent prefix
  // after personalization, avoiding false rejections for short SMS.
  return null;
}
const MESSAGE_CHANNEL_CHOICES = [
  { value: "SMS", label: "문자", description: "내용 길이에 따라 SMS/LMS를 자동 결정합니다. 사진을 첨부하면 MMS로 보냅니다." },
  { value: "ALIMTALK", label: "카카오 알림톡", description: "승인된 알림톡 템플릿을 선택하고 미전달 시 문자 대체 여부를 정합니다." },
] as const;
const TEMPLATE_CHANNEL_CHOICES = MESSAGE_CHANNEL_CHOICES.map(choice => ({ ...choice,
  description: choice.value === "SMS" ? "사진은 발송할 때 첨부합니다. 내용과 사진에 따라 문자 유형이 자동 결정됩니다." : choice.description,
}));
function textFamilyChannel(channel: string, imageFileId: string): string {
  return channel === "ALIMTALK" ? "ALIMTALK" : imageFileId ? "MMS" : "SMS";
}
// 채널 표기 어휘(의도적 구분, 혼용 아님):
// - familyLabel: 과금·발송 계열 구분(문자 vs 카카오 알림톡). 수신자 선택·검토 요약에 사용.
// - channelLabel: 확정된 전송 유형 표시(SMS/LMS/MMS/알림톡). 발송 확인 문구·이력에 사용.
// - authoringTypeLabel: 작성 중 미리보기의 유형 힌트. 작성 화면에만 사용.
function familyLabel(channel: string): string {
  return channel === "ALIMTALK" ? "카카오 알림톡" : "문자";
}
function authoringTypeLabel(channel: string): string {
  return channel === "ALIMTALK" ? "카카오 알림톡" : channel === "MMS" ? "MMS · 사진 첨부" : "SMS/LMS · 내용에 따라 자동";
}

function channelLabel(channel: string): string {
  switch (channel) {
    case "LMS": return "LMS · 장문";
    case "MMS": return "MMS · 사진";
    case "ALIMTALK": return "알림톡";
    case "SMS": return "문자(SMS/LMS 자동 결정)";
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

function scheduleModeNotice(mode: "MANUAL" | "AUTO"): string {
  return mode === "AUTO"
    ? "예약 시각 이후 자동 발송을 시도합니다. 자동 실행 설정이나 발송 연결이 꺼져 있으면 처리되지 않으며, 나중에 설정을 켜면 발송될 수 있습니다."
    : "예약 시각 이후 직접 발송 실행을 눌러야 합니다. 자동 실행 설정을 켜도 이 예약은 자동 발송되지 않습니다.";
}

function scheduleServerStatus(value: MessageSchedule | null): string {
  if (!value) return "이 서버의 예약 실행 설정을 확인할 수 없습니다.";
  const checked = value.observedAt ? ` (${formatDate(value.observedAt)} 조회)` : "";
  if (!value.eligibleForAuto) return `이 운영사는 현재 자동 예약 실행 대상이 아닙니다.${checked}`;
  if (!value.autoConfigured) return `이 서버의 예약 자동 실행 설정이 꺼져 있습니다.${checked}`;
  if (!value.workerStarted) return `이 서버에서 자동 실행 설정은 켜져 있으나 작업자 시작을 확인하지 못했습니다.${checked}`;
  const result = value.lastResult === "ok" ? "최근 점검 완료"
    : value.lastResult === "failed" ? "최근 점검 실패"
      : value.lastResult === "skipped" ? "최근 점검 건너뜀"
        : value.lastResult === "running" ? "점검 중" : "아직 점검 전";
  return `이 서버의 예약 자동 실행 설정이 켜져 있습니다. ${result}${value.lastAttemptAt ? ` · ${formatDate(value.lastAttemptAt)}` : ""}.${checked}`;
}

function campaignCreateSummary(args: {
  channel?: string;
  scheduled: boolean;
  scheduledAt: string;
  simulate: boolean;
  isMms: boolean;
  count: number;
  riskLine: string;
  scheduleStatus: string;
  scheduleMode: "MANUAL" | "AUTO";
  smsFallback: boolean;
}): string {
  const fallbackLine = args.channel === "ALIMTALK" && !args.simulate ? `\n${args.smsFallback ? ALIMTALK_FALLBACK_NOTICE : ALIMTALK_NO_FALLBACK_NOTICE}` : "";
  if (args.scheduled) {
    const execution = args.simulate
      ? "모의 예약은 시각 이후 직접 실행하며, 실행해도 수신자에게 전달되지 않습니다."
      : `${args.scheduleMode === "AUTO" ? "자동 실행" : "수동 실행"} · ${args.scheduleStatus} ${scheduleModeNotice(args.scheduleMode)} 발송 후에는 되돌릴 수 없습니다.`;
    return `선택 ${args.count}명에게 ${args.simulate ? "모의 예약" : "예약"} 등록을 진행할까요?\n\n예약 시각: ${formatDate(args.scheduledAt)}\n${execution}${args.isMms && !args.simulate ? " MMS 사진 문자로 발송되며 별도 요금이 발생합니다." : ""}${args.riskLine}${fallbackLine}`;
  }
  if (args.simulate) {
    return `선택 ${args.count}명에게 모의 발송 기록을 진행할까요?\n\n모의 발송은 실제로 전달되지 않습니다.${args.riskLine}${fallbackLine}`;
  }
  if (args.isMms) {
    return `선택 ${args.count}명에게 발송 요청을 진행할까요?\n\nMMS 사진 문자로 발송을 시도합니다. 별도 요금이 발생하며 발송은 되돌릴 수 없습니다.${args.riskLine}${fallbackLine}`;
  }
  return `선택 ${args.count}명에게 발송 요청을 진행할까요?\n\n공급사가 연결되어 있으면 즉시 실제 발송을 시도합니다. 발송은 되돌릴 수 없습니다.${args.riskLine}${fallbackLine}`;
}

function retrySummary(campaign: Campaign, label: "retry" | "execute"): string {
  // Stored mode, not the composer draft: a simulated reservation must never
  // execute under real-delivery/cost/no-undo wording.
  const storedSimulate = campaign.simulate === true;
  if (storedSimulate) {
    return "모의 예약을 실행할까요?\n\n예약 시각이 되어 실행하면 모의 기록으로 남습니다. 실행해도 수신자에게 전달되지 않습니다.";
  }
  if (label === "execute") {
    return `예약된 발송을 지금 실행할까요?\n\n공급사가 연결되어 있으면 즉시 실제 발송을 시도합니다. 발송은 되돌릴 수 없습니다.${campaign.channel === "ALIMTALK" ? `\n${campaign.smsFallback ? ALIMTALK_FALLBACK_NOTICE : ALIMTALK_NO_FALLBACK_NOTICE}` : ""}`;
  }
  return `재시도하면 공급사가 연결된 경우 즉시 다시 발송합니다. 미연동이면 연결 필요 상태로 남습니다.\n발송은 되돌릴 수 없습니다. 계속할까요?${campaign.channel === "ALIMTALK" ? `\n${campaign.smsFallback ? ALIMTALK_FALLBACK_NOTICE : ALIMTALK_NO_FALLBACK_NOTICE}` : ""}`;
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

function parseRecipientChanges(value: unknown, count: number): ChangeDetails | null {
  const data = asRecord(value);
  if (!data || typeof data.available !== "boolean" || !Array.isArray(data.changes)) return null;
  if (!data.available) return { available: false, changes: [] };
  if (!Number.isSafeInteger(count) || count < 1 || data.changes.length !== count) return null;
  const allowed = new Set(["missing", "ambiguous", "cancelled", "unavailable", "routing", "status", "group", "phone", "name", "name-unavailable"]);
  const ids = new Set<string>();
  const changes: RecipientChange[] = [];
  for (const item of data.changes) {
    const entry = asRecord(item);
    if (!entry || typeof entry.id !== "string" || !entry.id || ids.has(entry.id) || typeof entry.name !== "string" ||
      typeof entry.identityPhone !== "string" || !Array.isArray(entry.reasons) || !entry.reasons.length ||
      entry.reasons.some((reason) => typeof reason !== "string" || !allowed.has(reason))) return null;
    for (const [reason, before, after] of [["status", "beforeStatus", "afterStatus"], ["group", "beforeGroup", "afterGroup"], ["phone", "beforePhone", "afterPhone"]]) {
      if (entry.reasons.includes(reason) && (typeof entry[before] !== "string" || typeof entry[after] !== "string")) return null;
    }
    ids.add(entry.id);
    changes.push({ id: entry.id, name: entry.name, currentName: typeof entry.currentName === "string" ? entry.currentName : null, identityPhone: entry.identityPhone, reasons: entry.reasons as string[],
      beforeStatus: typeof entry.beforeStatus === "string" ? entry.beforeStatus : null, afterStatus: typeof entry.afterStatus === "string" ? entry.afterStatus : null,
      beforeGroup: typeof entry.beforeGroup === "string" ? entry.beforeGroup : null, afterGroup: typeof entry.afterGroup === "string" ? entry.afterGroup : null,
      beforePhone: typeof entry.beforePhone === "string" ? entry.beforePhone : null, afterPhone: typeof entry.afterPhone === "string" ? entry.afterPhone : null });
  }
  return { available: true, changes };
}

function RecipientChangeReview({ eventId, campaignId, observedAt, onRefresh }: { eventId: string; campaignId: string; observedAt: string; onRefresh: () => void }) {
  const [limit, setLimit] = useState(10);
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ kind: "loading" } | { kind: "failed" } | { kind: "unchanged" } | { kind: "ready"; details: ChangeDetails; observedAt: string }>({ kind: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    setResult({ kind: "loading" });
    void (async () => {
      try {
        const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap?messageRecipientReview=1&messageChangeId=${encodeURIComponent(campaignId)}`, { cache: "no-store", signal: controller.signal });
        const body = asRecord(await response.json().catch(() => null));
        const state = asRecord(body?.state);
        const review = asRecord(state?.messageChangeReview);
        if (!active) return;
        if (!response.ok || !review || review.id !== campaignId || typeof review.observedAt !== "string" || !Number.isFinite(Date.parse(review.observedAt))) {
          setResult({ kind: "failed" }); return;
        }
        if (review.status === "unchanged") { setResult({ kind: "unchanged" }); return; }
        const details = review.status === "changed" && typeof review.count === "number" ? parseRecipientChanges(review.details, review.count) : null;
        if (!details) { setResult({ kind: "failed" }); return; }
        setResult({ kind: "ready", details, observedAt: review.observedAt });
      } catch {
        if (active) setResult({ kind: "failed" });
      } finally { window.clearTimeout(timeout); }
    })();
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [eventId, campaignId, observedAt, attempt]);
  if (result.kind === "loading") return <p className={styles.comparisonNote} role="status">변경된 수신자를 확인하고 있습니다.</p>;
  if (result.kind === "failed") return <div className={styles.changedRecipients}><p className={styles.campaignHint} role="status">변경 내역을 확인하지 못했습니다. 발송은 계속 보류됩니다.</p><ProductButton type="button" variant="ghost" onClick={() => setAttempt((value) => value + 1)}>변경 내역 다시 확인</ProductButton></div>;
  if (result.kind === "unchanged") return <div className={styles.changedRecipients}><p className={styles.campaignHint} role="status">최신 명단에서는 변경된 수신자가 없습니다. 발송 기록을 새로고침해 상태를 다시 확인하세요.</p><ProductButton type="button" variant="ghost" onClick={onRefresh}>발송 기록 새로고침</ProductButton></div>;
  const { details } = result;
  if (!details.available) return <p className={styles.campaignHint}>변경된 수신자 상세를 확인할 수 없습니다. 참가자 명단을 다시 확인하세요.</p>;
  return <div className={styles.changedRecipients}>
    <h4>변경된 수신자 {details.changes.length}명</h4>
    <ul aria-label="변경된 수신자 목록" aria-live="polite">
      {details.changes.slice(0, limit).map((entry) => <li key={entry.id}>
        <div><strong>{entry.currentName && entry.currentName !== entry.name ? `요청 당시: ${entry.name}` : entry.name}</strong> <span>{entry.identityPhone}</span></div>
        {entry.currentName && entry.currentName !== entry.name ? <p>현재 이름: {entry.currentName}</p> : null}
        {entry.reasons.includes("name") ? <p>메시지에 삽입할 이름이 변경됐습니다.</p> : null}
        {entry.reasons.includes("name-unavailable") ? <p>메시지에 삽입할 이름을 확인할 수 없습니다.</p> : null}
        {entry.reasons.includes("status") ? <p>참가 상태: {participantStatusLabel(entry.beforeStatus ?? "")} → {participantStatusLabel(entry.afterStatus ?? "")}</p> : null}
        {entry.reasons.includes("group") ? <p>그룹: {entry.beforeGroup} → {entry.afterGroup}</p> : null}
        {entry.reasons.includes("phone") ? <p>연락처: {entry.beforePhone} → {entry.afterPhone}{entry.beforePhone === entry.afterPhone ? " (표시되지 않은 자리 포함)" : ""}</p> : null}
        {entry.reasons.includes("routing") ? <p>참가 상태 또는 그룹이 변경됐습니다. 이전 값은 확인할 수 없습니다.</p> : null}
        {entry.reasons.includes("cancelled") ? <p>취소 또는 티켓 상태를 확인하세요.</p> : null}
        {entry.reasons.includes("missing") ? <p>현재 참가자 명단에서 찾을 수 없습니다.</p> : null}
        {entry.reasons.includes("ambiguous") ? <p>같은 식별자의 참가자가 여러 명이라 확인할 수 없습니다.</p> : null}
        {entry.reasons.includes("unavailable") ? <p>예약 당시 수신자 검토 정보를 확인할 수 없습니다.</p> : null}
      </li>)}
    </ul>
    {limit < details.changes.length ? <ProductButton type="button" variant="ghost" onClick={() => setLimit((current) => current + 10)}>수신자 더 보기 · {details.changes.length - limit}명 남음</ProductButton> : null}
    <p className={styles.comparisonNote}>{formatDate(result.observedAt)} 확인한 명단 기준입니다. 이후 변경은 다시 확인해야 합니다.</p>
  </div>;
}

// This is only a lookup aid. The reference is neither proof of provider
// acceptance nor authority to unlock or resend an unresolved submission.
function LockedProviderReference({ name, phone, reference }: { name: string; phone: string; reference: string | null }) {
  const [copied, setCopied] = useState<"" | "success" | "failed">("");
  async function copyReference() {
    if (!reference) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(reference);
      setCopied("success");
    } catch {
      setCopied("failed");
    }
  }
  return <details className={styles.providerReference}>
    <summary data-disclosure-indicator="">공급사 대조 정보</summary>
    <div>
      <p>발송 당시 연락처 · {phone || "확인할 수 없음"}</p>
      {reference ? <>
        <p>공급사 요청에 사용되는 대조 ID</p>
        <textarea aria-label={`${name} ${phone || "연락처 확인 불가"} 대조 ID`} readOnly rows={2} value={reference} onFocus={(event) => event.currentTarget.select()} />
        <ProductButton type="button" variant="secondary" aria-label={`${name} ${phone || "연락처 확인 불가"} 대조 ID 복사`} onClick={() => void copyReference()}>대조 ID 복사</ProductButton>
        <p role="status">{copied === "success" ? "대조 ID를 복사했습니다." : copied === "failed" ? "복사하지 못했습니다. 위 대조 ID를 직접 선택해 복사하세요." : ""}</p>
        <p>이 값은 요청에 사용되는 대조 ID이며, 전송이나 접수의 증거가 아닙니다. 발송 종료와 접수 여부를 각각 확인하세요.</p>
      </> : <p>이전 발송의 참조 정보를 확인할 수 없습니다. 운영 담당자에게 문의하세요.</p>}
    </div>
  </details>;
}

function messageStatusLabel(status: string): string {
  switch (status) {
    case "NEEDS_CONNECTION": return "연결 필요";
    case "SIMULATED": return "모의 발송 · 전달 없음";
    case "SCHEDULED": return "예약";
    case "SENDING": return "발송 중";
    case "ACCEPTED": return "공급사 접수 · 전달 미확인";
    case "SENT": return "전달 확인";
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
    case "SENDING": return "접수·전달 상태 확인 중";
    case "ACCEPTED": return "공급사 접수 · 전달 미확인";
    case "SENT": return "전달 확인";
    case "FAILED": return "실패";
    case "CANCELLED": return "취소";
    default: return "상태 확인 필요";
  }
}

function statusTone(status: string): StatusPillTone {
  if (status === "SENT") return "ok";
  if (["FAILED", "PARTIAL"].includes(status)) return "danger";
  if (["NEEDS_CONNECTION", "UNCONNECTED", "SIMULATED", "ACCEPTED"].includes(status)) return "wait";
  return "neutral";
}

function hasExplicitTimeZone(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

// The composer accepts Korean wall-clock time regardless of the device zone.
// Validate calendar fields before adding the offset: Date.parse alone silently
// normalizes dates such as February 30.
function scheduledInstant(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const calendar = new Date(`${value}:00Z`);
  if (!Number.isFinite(calendar.getTime()) || calendar.toISOString().slice(0, 16) !== value) return null;
  const instant = new Date(`${value}:00+09:00`);
  return Number.isFinite(instant.getTime()) ? instant.toISOString() : null;
}

function formatDate(value: string): string {
  if (!value) return "기록 시각 확인 중";
  if (!hasExplicitTimeZone(value)) return `시간대 미기록 · 원본 ${value} (확인 필요)`;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return `기록 시각 확인 필요 · 원본 ${value}`;
  return `${new Intl.DateTimeFormat("ko-KR", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Asia/Seoul",
  }).format(date)} (한국 시간)`;
}

function formatScheduledInput(value: string): string {
  const instant = scheduledInstant(value);
  return instant ? formatDate(instant) : "예약 날짜와 시간 확인 필요";
}

function formatSavedSchedule(value: string): string {
  if (!value) return "예약 시각 미기록 (확인 필요)";
  if (!hasExplicitTimeZone(value)) return `시간대 미기록 · 원본 ${value} (확인 필요)`;
  return hasValidScheduledInstant(value) ? formatDate(value) : `예약 시각 확인 필요 · 원본 ${value}`;
}

function serverError(value: unknown): ServerError {
  const data = asRecord(value);
  return {
    message: text(data?.error, "요청을 처리하지 못했습니다."),
    field: typeof data?.field === "string" ? data.field : null,
  };
}

// __PARSE_ORG_INTEGRATIONS_BEGIN__
// Current-org messaging authority: the scoped event bootstrap's
// `state.integrations` (legacy org reports the deployment provider state,
// new orgs report disconnected). /api/health is process-shared and never
// consulted here. Unknown shapes read as disconnected, never connected.
export function parseOrgIntegrations(value: unknown): { connected: boolean; sender: string; provider: string; orgIsolated: boolean } {
  const record = (typeof value === "object" && value !== null && !Array.isArray(value) ? value : null) as Record<string, unknown> | null;
  return {
    connected: record?.connected === true,
    sender: typeof record?.sender === "string" ? record.sender : "",
    provider: typeof record?.provider === "string" ? record.provider : "",
    orgIsolated: record?.orgIsolated === true,
  };
}
// __PARSE_ORG_INTEGRATIONS_END__

// __ORG_SIM_ONLY_BEGIN__
// New-org simulation-only gate: a fresh org never inherits the deployment
// provider, so its composer is simulation-only (default and payload), never
// auto-enabled for real sends. Legacy orgs are unaffected: their real
// attempts keep the NEEDS_CONNECTION path.
export function isNewOrgSimOnly(integrations: { orgIsolated: boolean; connected: boolean }): boolean {
  return integrations.orgIsolated === true && integrations.connected !== true;
}
// __ORG_SIM_ONLY_END__

function parseTemplate(value: unknown): Template | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string") return null;
  return {
    id: item.id,
    name: text(item.name),
    channel: text(item.channel, "SMS"),
    body: text(item.body),
    solapiTemplateId: text(item.solapiTemplateId),
    archived: item.archived === true,
    version: Number.isSafeInteger(item.version) && Number(item.version) >= 0 ? Number(item.version) : 0,
  };
}

function parseParticipant(value: unknown, reviewVersions: Record<string, unknown> | null): Participant | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  return {
    id: item.id,
    name: text(item.name, "이름 미등록"),
    company: text(item.company),
    group: text(item.group).trim() || "일반",
    phone: text(item.phone),
    status: text(item.status, "PENDING"),
    reviewVersion: text(reviewVersions?.[item.id]),
    ticketReview: text(item.ticketReview, "unknown"),
    notEntered: item.inside === false && item.everIn !== true && item.attendanceReview !== true &&
      (!Object.hasOwn(item, "everIn") || typeof item.everIn === "boolean"),
  };
}

function parseDelivery(value: unknown): Delivery | null {
  const item = asRecord(value);
  if (!item) return null;
  const lookup = asRecord(item.providerLookup);
  const phone = text(lookup?.maskedPhone);
  return {
    participantId: text(item.participantId),
    name: text(item.name, "이름 미등록"),
    status: text(item.status),
    at: text(item.at),
    resultMatchUnconfirmed: item.resultMatchUnconfirmed === true,
    genericProviderResult: text(item.genericProviderResult),
    manualProviderReview: text(asRecord(item.manualProviderReview)?.outcome),
    snapshotPhone: /^\d{3}-\*{4}-\d{4}$/.test(phone) ? phone : "",
    reference: typeof lookup?.reference === "string" ? lookup.reference : null,
  };
}

function parseCampaign(value: unknown): Campaign | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string") return null;
  const ids = Array.isArray(item.recipientIds) ? item.recipientIds.filter((id): id is string => typeof id === "string") : [];
  const deliveries = Array.isArray(item.deliveries) ? item.deliveries.flatMap((delivery) => {
    const parsed = parseDelivery(delivery);
    return parsed ? [parsed] : [];
  }) : [];
  const isRecordedHttpAttempt = asRecord(item.providerSubmission)?.kind === "HTTP" &&
    typeof asRecord(item.providerSubmission)?.id === "string" && Boolean(text(asRecord(item.providerSubmission)?.id));
  for (const delivery of deliveries) {
    // A truncated or mismatched response cannot invent a reference. The
    // server projection already removed ambiguous snapshot information.
    if (!isRecordedHttpAttempt || !delivery.participantId || delivery.participantId.length > 120 ||
        !/^[A-Za-z0-9_-]{8,128}$/.test(item.id) || delivery.reference !== `${item.id}:${delivery.participantId}`) delivery.reference = null;
  }
  return {
    id: item.id,
    title: text(item.title, "제목 없는 발송"),
    channel: text(item.channel, "SMS"),
    // A stray duplicate never inflates the reload exclusion count.
    recipientIds: [...new Set(ids)],
    status: text(item.status),
    scheduled: text(item.scheduled),
    scheduleMode: item.scheduleMode === "AUTO" && item.autoScheduleIntent === "confirmed-v1" ? "AUTO" : "MANUAL",
    // Server persists simulate on every message (content-results.js); the
    // history and retry copy below must read this stored mode, never the
    // composer's draft flag, or a simulated reservation executes under
    // real-delivery wording.
    simulate: item.simulate === true,
    smsFallback: item.smsFallback !== false,
    at: text(item.at),
    attempts: typeof item.attempts === "number" ? item.attempts : 0,
    acceptedCount: Number.isSafeInteger(item.acceptedCount) && Number(item.acceptedCount) >= 0 ? Number(item.acceptedCount) : null,
    submissionUnconfirmed: item.submissionUnconfirmed === true || item.genericSubmissionUnconfirmed === true || Boolean(text(asRecord(item.providerSubmission)?.id)),
    recipientChangeCount: Number.isSafeInteger(item.recipientChangeCount) && Number(item.recipientChangeCount) > 0 ? Number(item.recipientChangeCount) : 0,
    recipientRoutingReviewed: item.recipientRoutingReviewVersion === 1,
    ticketLinkProblemCount: Number.isSafeInteger(item.ticketLinkProblemCount) && Number(item.ticketLinkProblemCount) > 0 ? Number(item.ticketLinkProblemCount) : 0,
    ticketLinkProblemUnknown: item.ticketLinkProblemUnknown === true,
    alimtalkUnsupported: item.alimtalkUnsupported === true,
    mmsUnsupported: item.mmsUnsupported === true,
    personalizedTextTooLongCount: Number.isSafeInteger(item.personalizedTextTooLongCount) && Number(item.personalizedTextTooLongCount) > 0 ? Number(item.personalizedTextTooLongCount) : 0,
    smsTextProblemCount: Number.isSafeInteger(item.smsTextProblemCount) && Number(item.smsTextProblemCount) > 0 ? Number(item.smsTextProblemCount) : 0,
    smsTextProblemField: text(item.smsTextProblemField),
    smsTextProblemUnknown: item.smsTextProblemUnknown === true,
    smsTextReloadSafe: item.smsTextReloadSafe === true,
    deliveryUnconfirmed: item.deliveryUnconfirmed === true,
    providerGroupId: text(item.providerGroupId),
    genericTransport: item.genericTransport === true || asRecord(item.providerSubmission)?.kind === "HTTP",
    genericAttemptActive: typeof item.genericAttemptActive === "boolean" ? item.genericAttemptActive : null,
    genericSubmissionUnconfirmed: item.genericSubmissionUnconfirmed === true,
    submissionId: text(asRecord(item.providerSubmission)?.id) || null,
    providerKind: text(item.providerKind),
    // Server persists the full compose snapshot on every message
    // (content-results.js bootstrap): body, templateId and the MMS image
    // reference live here so a FAILED campaign can be reloaded without
    // retyping. The image may arrive nested (image.fileId/name) or flat.
    body: text(item.body),
    templateId: text(item.templateId),
    imageFileId: text(asRecord(item.image)?.fileId) || text(item.imageFileId),
    imageName: text(asRecord(item.image)?.name) || text(item.imageName),
    deliveries,
  };
}

class CommandFailure extends Error {
  field: string | null;

  constructor(error: ServerError) {
    super(error.message);
    this.field = error.field;
  }
}

function MessageWorkbench({ history, composer, templates, composerOpen, templateAttention }: { history: ReactNode; composer: ReactNode; templates: ReactNode; composerOpen: boolean; templateAttention: boolean }) {
  useEffect(() => { if (composerOpen) requestConsoleTask("history-heading"); }, [composerOpen]);
  return <>
    <div className={styles.inkTabs} hidden={composerOpen}><ConsoleSectionNav mode="tabs" label="메시지 업무" initialId="history-heading" items={[
      { id: "history-heading", label: "발송 기록" },
      { id: "templates-heading", label: templateAttention ? "템플릿 관리 · 확인 필요" : "템플릿 관리" },
    ]} /></div>
    {history}{composer}{templates}
  </>;
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
  const [pendingTemplateUse, setPendingTemplateUse] = useState<Template | null>(null);
  const [templateQuery, setTemplateQuery] = useState("");
  const [templateScope, setTemplateScope] = useState("ACTIVE");
  const [templateArchiveConfirm, setTemplateArchiveConfirm] = useState<Template | null>(null);
  const [templateResetConfirm, setTemplateResetConfirm] = useState(false);
  const [templateEditConfirm, setTemplateEditConfirm] = useState<Template | null>(null);
  const [imagePreviewFailed, setImagePreviewFailed] = useState(false);
  const [imagePreviewRevision, setImagePreviewRevision] = useState(0);
  useEffect(() => { setImagePreviewFailed(false); setImagePreviewRevision(0); }, [campaignDraft.imageFileId]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [templateFieldError, setTemplateFieldError] = useState<{ field: string; message: string } | null>(null);
  const [campaignFieldError, setCampaignFieldError] = useState<CampaignFieldError | null>(null);
  const campaignBodyRef = useRef<HTMLTextAreaElement>(null);
  const scheduleInputRef = useRef<HTMLInputElement>(null);
  const [scheduleBadInput, setScheduleBadInput] = useState(false);
  // 보낼 때: 지금 / 행사 기준 / 날짜·시각. Only the choice lives here; the
  // reservation itself is still campaignDraft.scheduled.
  const [scheduleChoice, setScheduleChoice] = useState<"NOW" | "EVENT" | "DATE">("NOW");
  const [eventOffset, setEventOffset] = useState<EventOffset>({ days: 1, time: "18:00" });
  const [loadedPurpose, setLoadedPurpose] = useState<PurposeTemplate | null>(null);
  const [pendingPurpose, setPendingPurpose] = useState<PurposeTemplate | null>(null);
  const [composeNotice, setComposeNotice] = useState<string | null>(null);
  // Two presets can hold the same people (no one has entered yet); only the
  // one the operator chose reads as chosen.
  const [chosenPreset, setChosenPreset] = useState<AudiencePreset | null>(null);
  useEffect(() => {
    if (campaignFieldError?.field !== "scheduled") return;
    setScheduleChoice(current => current === "EVENT" ? current : "DATE");
    requestAnimationFrame(() => document.getElementById(scheduleChoice === "EVENT" ? "campaign-event-offset" : "campaign-scheduled")?.focus());
  }, [campaignFieldError]);
  const [templateNotice, setTemplateNotice] = useState<string | null>(null);
  const [campaignNotice, setCampaignFeedback] = useState<{ message: string; kind: "success" | "warning" } | null>(null);
  function setCampaignNotice(message: string | null, kind: "success" | "warning" = "success") {
    setCampaignFeedback(message ? { message, kind } : null);
  }
  const [closeNoticeStatus, setCloseNoticeStatus] = useState<string | undefined>(undefined);
  const [archiveConfirm, setArchiveConfirm] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null);
  const [archiveUnresolved, setArchiveUnresolved] = useState(false);
  const archiveCommandRef = useRef<string | null>(null);
  const confirmLeaveForArchive = useConsoleLeaveConfirmation();
  useConsoleDraftGuard(archiveUnresolved, UNCONFIRMED_WRITE_CLOSE_MESSAGE);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  // Compose submit confirm (payload snapshot + summary) and one history-row
  // confirm at a time. Triggers stay; confirms render in place below them.
  const [sendPending, setSendPending] = useState<SendPending | null>(null);
  const [uncertainCreate, setUncertainCreate] = useState<SendPending | null>(null);
  const [providerCheck, setProviderCheck] = useState<ProviderCheckAttempt | null>(null);
  const [providerCheckChoice, setProviderCheckChoice] = useState<"ACCEPTED" | "NOT_ACCEPTED" | "">("");
  const [providerCheckConfirm, setProviderCheckConfirm] = useState(false);
  const [providerCheckError, setProviderCheckError] = useState<string | null>(null);
  useConsoleDraftGuard(Boolean(providerCheck?.uncertain), UNCONFIRMED_WRITE_CLOSE_MESSAGE);
  useEffect(() => providerCheck?.uncertain ? manageOperatorReceipt(providerCheck.id) : undefined, [providerCheck?.id, providerCheck?.uncertain]);
  const uncertainCreateRef = useRef<SendPending | null>(null);
  const [checkingCreate, setCheckingCreate] = useState(false);
  const [abandonCreateConfirm, setAbandonCreateConfirm] = useState(false);
  const [pendingTemplate, setPendingTemplate] = useState<TemplateAttempt | null>(null);
  const pendingTemplateRef = useRef<TemplateAttempt | null>(null);
  const [checkingTemplate, setCheckingTemplate] = useState(false);
  const [refreshingOtherTemplate, setRefreshingOtherTemplate] = useState(false);
  const [abandonTemplateConfirm, setAbandonTemplateConfirm] = useState(false);
  const templateFocusOriginRef = useRef<Element | null>(null);
  const eventReceipts = useEventReceipts(eventId);
  const otherCreateReceipt = eventReceipts.some((entry) => ["message.create", "message.create-reviewed", "message.create-charset-reviewed"].includes(entry.command) && entry.commandId !== uncertainCreate?.id);
  const activeMessageEventRef = useRef(eventId);
  const loadedMessageEventRef = useRef<string | null>(null);
  const messageClockRef = useRef<{ eventId: string; serverMs: number; receivedAt: number } | null>(null);
  function messageNow(): number {
    const clock = messageClockRef.current;
    return clock && clock.eventId === eventId && typeof performance !== "undefined"
      ? clock.serverMs + Math.max(0, performance.now() - clock.receivedAt)
      : Date.now();
  }
  activeMessageEventRef.current = eventId;
  useEffect(() => uncertainCreate && state.kind === "ready" ? manageOperatorReceipt(uncertainCreate.id) : undefined, [uncertainCreate, state.kind]);
  useEffect(() => pendingTemplate && state.kind === "ready" ? manageOperatorReceipt(pendingTemplate.id) : undefined, [pendingTemplate, state.kind]);
  useEffect(() => {
    if (!pendingTemplate) return;
    const frame = window.requestAnimationFrame(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== templateFocusOriginRef.current && active.isConnected) return;
      const heading = document.getElementById("template-recovery-heading");
      heading?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
      heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pendingTemplate?.id]);
  // The recipient list: desktop unfolds it next to the draft by default
  // (see below); mobile starts folded and unfolds on demand.
  const [recipientListOpen, setRecipientListOpen] = useState(false);
  const [recipientReviewRequired, setRecipientReviewRequired] = useState(false);
  // Desktop starts with the recipient list unfolded next to the draft so
  // counts, off-screen picks and caution targets stay visible. Mobile
  // starts folded and can unfold on demand; the handoff/reload paths
  // below still force it open when they select a set for review.
  // Desktop starts with the recipient list unfolded under the audience
  // presets (the list is height-capped) so counts, off-screen picks and
  // caution targets stay visible. Mobile starts folded and unfolds from
  // 직접 고르기; handoff/reload paths still force it open for review.
  const desktopListOpenAppliedRef = useRef(false);
  useEffect(() => {
    if (desktopListOpenAppliedRef.current) return;
    desktopListOpenAppliedRef.current = true;
    if (window.matchMedia("(min-width: 1025px)").matches) setRecipientListOpen(true);
  }, []);
  const [historyPending, setHistoryPending] = useState<{
    id: string;
    kind: "retry" | "execute" | "cancel";
  } | null>(null);
  // History folds under the composer in a native details region. It opens
  // on the attention deep link and after a successful send that needs to
  // show its row; the operator can fold it otherwise.
  const [historyOpen, setHistoryOpen] = useState(true);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composeStep, setComposeStep] = useState<1 | 2 | 3>(1);
  useEffect(() => {
    if (!campaignFieldError) return;
    const step = campaignFieldError.field === "ids" ? 1 : campaignFieldError.field === "scheduled" ? 3 : 2;
    setComposeStep(step);
    if (recipientReviewRequired) return;
    const focusOrigin = document.activeElement;
    const timer = window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== focusOrigin && active.isConnected) return;
      const ids: Record<string, string> = { ids: "recipient-status-filter", title: "campaign-title", body: "campaign-body", smsFallback: "campaign-sms-fallback", templateId: "campaign-template", imageFileId: "campaign-image", scheduled: "campaign-scheduled" };
      const element = document.getElementById(ids[campaignFieldError.field] || "campaign-title");
      element?.focus();
      if (typeof campaignFieldError.index === "number" && (element instanceof HTMLTextAreaElement || element instanceof HTMLInputElement)) {
        const code = element.value.codePointAt(campaignFieldError.index) ?? 0;
        element.setSelectionRange(campaignFieldError.index, campaignFieldError.index + (code > 0xffff ? 2 : 1));
      }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [campaignFieldError, recipientReviewRequired]);
  useEffect(() => {
    if (recipientReviewRequired && composeStep === 1 && busyAction === null) {
      document.getElementById("recipient-review-refresh")?.focus();
    }
  }, [busyAction, composeStep, recipientReviewRequired]);
  useEffect(() => { setComposeStep(1); setPendingTemplateUse(null); setRecipientGroup(""); setCharsetCandidatesOnly(false); setScheduleChoice("NOW"); setEventOffset({ days: 1, time: "18:00" }); setLoadedPurpose(null); setPendingPurpose(null); setComposeNotice(null); }, [eventId]);
  useEffect(() => { if (uncertainCreate) setComposeStep(3); }, [uncertainCreate]);

  // Reopened 2026-11-23: one screen, so moving between zones never gates or
  // validates; the submit (발송 검토) keeps every check and field error.
  function goComposeStep(next: 1 | 2 | 3) {
    if (inFlightRef.current || uncertainCreateRef.current || uncertainMmsUpload) return;
    const focusOrigin = document.activeElement;
    setComposeStep(next);
    window.setTimeout(() => {
      const active = document.activeElement;
      if (active && active !== document.body && active !== focusOrigin && active.isConnected) return;
      const target = messagesLocked ? document.querySelector<HTMLElement>('nav[aria-label="메시지 작성 항목"] a[aria-current="true"]') : document.getElementById(composeFocusId(next));
      target?.focus({ preventScroll: true });
      document.getElementById(next === 1 ? "campaign-recipients" : next === 2 ? "campaign-content" : "campaign-review-heading")?.scrollIntoView({ block: "start" });
    }, 0);
  }
  function composeFocusId(step: 1 | 2 | 3): string {
    return step === 1 ? "recipient-heading" : step === 2 ? "campaign-body" : "campaign-review-heading";
  }

  const focusComposerOnOpenRef = useRef(false);
  const focusHistoryOnCloseRef = useRef(false);
  // Focus as part of the opening commit, before a later user keystroke can
  // move elsewhere. A deferred timer can steal focus back from the skip link.
  useLayoutEffect(() => {
    if (!composerOpen || !focusComposerOnOpenRef.current) return;
    focusComposerOnOpenRef.current = false;
    document.getElementById("campaign-heading")?.scrollIntoView({ block: "start" });
    document.getElementById(composeFocusId(composeStep))?.focus({ preventScroll: true });
  }, [composerOpen, composeStep]);
  useLayoutEffect(() => {
    if (composerOpen || !historyOpen || !focusHistoryOnCloseRef.current) return;
    focusHistoryOnCloseRef.current = false;
    document.getElementById("message-compose-open")?.focus();
  }, [composerOpen, historyOpen]);
  const [expandedCampaignId, setExpandedCampaignId] = useState<string | null>(null);
  const [historyQuery, setHistoryQuery] = useState("");
  const [historyStatus, setHistoryStatus] = useState("ALL");
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
  const [recipientGroup, setRecipientGroup] = useState("");
  const [showSelectedOnly, setShowSelectedOnly] = useState(false);
  const [charsetCandidatesOnly, setCharsetCandidatesOnly] = useState(false);
  const [handoffNotice, setHandoffNotice] = useState<string | null>(null);
  const [historyLimit, setHistoryLimit] = useState(10);
  const handoffAppliedRef = useRef<string | null>(null);
  const historyListRef = useRef<HTMLTableSectionElement | null>(null);
  // First newly revealed campaign to focus after 이전 발송 더 보기: rows
  // insert before the focused button, so without this the final reveal drops
  // focus when the button unmounts.
  const pendingHistoryFocusRef = useRef<number | null>(null);
  // After a successful retry/execute/sync/cancel, focus the next logical
  // history row (or the notice region when none remains).
  const historyActionFocusRef = useRef<string | null>(null);
  const [ambiguousRetryIds, setAmbiguousRetryIds] = useState<string[]>([]);
  const [ambiguousSyncIds, setAmbiguousSyncIds] = useState<string[]>([]);
  const [ambiguousCancelIds, setAmbiguousCancelIds] = useState<string[]>([]);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [uncertainMmsUpload, setUncertainMmsUpload] = useState(false);
  const [mmsUploadError, setMmsUploadError] = useState<string | null>(null);
  const [abandonMmsUploadConfirm, setAbandonMmsUploadConfirm] = useState(false);
  const mmsUploadRef = useRef<{ eventId: string; file: File; commandId: string; uncertain: boolean } | null>(null);
  const mmsUploadGateRef = useRef(false);
  // The file control sits far down the composer. Move focus to the recovery
  // explanation when it appears so an operator does not encounter a locked
  // form without seeing why.
  useEffect(() => {
    if (!uncertainMmsUpload) return;
    const frame = window.requestAnimationFrame(() => {
      const heading = document.getElementById("mms-upload-recovery-heading");
      heading?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "center" });
      heading?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [uncertainMmsUpload]);
  // Even a failed new file selection must invalidate an older confirmation.
  const [attachmentRevision, setAttachmentRevision] = useState(0);
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
  useEffect(() => {
    const id = templateSaveRef.current?.commandId;
    return busyAction === "template" && id ? manageOperatorReceipt(id) : undefined;
  }, [busyAction]);
  const otherTemplateReceipt = eventReceipts.some((entry) => ["template.save", "template.archive"].includes(entry.command) &&
    entry.commandId !== pendingTemplate?.id && entry.commandId !== templateSaveRef.current?.commandId);
  const retryRefs = useRef(new Map<string, { fingerprint: string; commandId: string }>());
  const syncRefs = useRef(new Map<string, { fingerprint: string; commandId: string }>());
  const cancelRefs = useRef(new Map<string, { fingerprint: string; commandId: string }>());
  const seenHistoryReceiptsRef = useRef(new Set<string>());
  const otherHistoryReceipt = eventReceipts.some((entry) => {
    if (entry.command === "message.record-provider-check") return entry.commandId !== providerCheck?.id;
    const slot = ["message.retry", "message.retry-charset-reviewed"].includes(entry.command) ? retryRefs.current : entry.command === "message.sync" ? syncRefs.current : entry.command === "message.cancel" ? cancelRefs.current : null;
    return slot !== null && ![...slot.values()].some((item) => item.commandId === entry.commandId);
  });
  const previousMessageEventRef = useRef(eventId);
  const hadOtherTemplateReceiptRef = useRef(false);
  const templateRecoveryLocked = Boolean(pendingTemplate || otherTemplateReceipt || refreshingOtherTemplate || (hadOtherTemplateReceiptRef.current && !otherTemplateReceipt));
  useEffect(() => {
    if (previousMessageEventRef.current === eventId) return;
    previousMessageEventRef.current = eventId;
    loadedMessageEventRef.current = null;
    hadOtherTemplateReceiptRef.current = false;
    setRefreshingOtherTemplate(false);
    pendingTemplateRef.current = null;
    setPendingTemplate(null); setCheckingTemplate(false); setAbandonTemplateConfirm(false);
    templateSaveRef.current = null; setTemplateDraft(EMPTY_TEMPLATE); setTemplateError(null);
    setTemplateFieldError(null); setTemplateNotice(null);
    setTemplateQuery(""); setTemplateScope("ACTIVE"); setTemplateArchiveConfirm(null); setTemplateResetConfirm(false); setTemplateEditConfirm(null);
    setCampaignDraft(EMPTY_CAMPAIGN); setSelectedIds([]); setSelectedTemplateId("");
    setRecipientReviewRequired(false);
    setCampaignError(null); setCampaignFieldError(null); setCampaignNotice(null);
    uncertainCreateRef.current = null;
    setUncertainCreate(null);
    setAbandonCreateConfirm(false);
    campaignCreateRef.current = null;
    setSendPending(null);
    retryRefs.current.clear();
    syncRefs.current.clear();
    cancelRefs.current.clear();
    seenHistoryReceiptsRef.current.clear();
    setAmbiguousRetryIds([]);
    setAmbiguousSyncIds([]);
    setAmbiguousCancelIds([]);
    mmsUploadRef.current = null;
    mmsUploadGateRef.current = false;
    setUploadingImage(false);
    setUncertainMmsUpload(false);
    setMmsUploadError(null);
    setAbandonMmsUploadConfirm(false);
  }, [eventId]);
  useEffect(() => {
    if (hadOtherTemplateReceiptRef.current && !otherTemplateReceipt && !pendingTemplate) {
      setRefreshingOtherTemplate(true);
      const previousEvent = eventId;
      void refresh(true).finally(() => { if (activeMessageEventRef.current === previousEvent) setRefreshingOtherTemplate(false); });
    }
    hadOtherTemplateReceiptRef.current = otherTemplateReceipt;
    // A shared, status-only confirmation after reload never repeats the save.
  }, [otherTemplateReceipt, pendingTemplate]);
  useEffect(() => {
    const present = new Set(eventReceipts.map((entry) => entry.commandId));
    for (const entry of eventReceipts) {
      if (["message.retry", "message.retry-charset-reviewed", "message.sync", "message.cancel"].includes(entry.command)) seenHistoryReceiptsRef.current.add(entry.commandId);
    }
    if (busyAction !== null) return;
    let changed = false;
    const prune = (slot: Map<string, { commandId: string }>, ids: string[]) => ids.filter((id) => {
      const request = slot.get(id);
      if (!request || !seenHistoryReceiptsRef.current.has(request.commandId) || present.has(request.commandId)) return true;
      slot.delete(id);
      seenHistoryReceiptsRef.current.delete(request.commandId);
      changed = true;
      return false;
    });
    const retry = prune(retryRefs.current, ambiguousRetryIds);
    const sync = prune(syncRefs.current, ambiguousSyncIds);
    const cancel = prune(cancelRefs.current, ambiguousCancelIds);
    if (retry.length !== ambiguousRetryIds.length) setAmbiguousRetryIds(retry);
    if (sync.length !== ambiguousSyncIds.length) setAmbiguousSyncIds(sync);
    if (cancel.length !== ambiguousCancelIds.length) setAmbiguousCancelIds(cancel);
    if (changed) { setCampaignError(null); void refresh(true); }
  }, [eventReceipts, busyAction, ambiguousRetryIds, ambiguousSyncIds, ambiguousCancelIds]);

  useEffect(() => {
    const onApplied = (event: Event) => {
      const detail = (event as CustomEvent<{ eventId?: string; command?: string; commandId?: string }>).detail;
      if (detail?.eventId !== eventId || detail.command !== "message.retry-charset-reviewed" ||
          ![...retryRefs.current.values()].some(item => item.commandId === detail.commandId)) return;
      // This is only a read of the latest history. The frozen request and
      // receipt remain until the original payload is verified separately.
      void refresh(true);
    };
    window.addEventListener("eventouch:operator-receipt-applied", onApplied);
    return () => window.removeEventListener("eventouch:operator-receipt-applied", onApplied);
  }, [eventId]);

  // Synchronous in-flight gate shared by every command handler. React state
  // updates don't apply until the next render, so two same-turn submissions
  // (double-click, Enter key repeat) would both pass a `busyAction !== null`
  // check and overlap. This ref flips synchronously instead.
  const inFlightRef = useRef(false);
  const seenArchiveReceiptRef = useRef<{ eventId: string; commandId: string } | null>(null);
  useEffect(() => {
    const id = archiveCommandRef.current;
    if (!archiveUnresolved || !id) { seenArchiveReceiptRef.current = null; return; }
    if (eventReceipts.some((entry) => entry.command === "event.stage" && entry.commandId === id)) {
      seenArchiveReceiptRef.current = { eventId, commandId: id };
      return;
    }
    if (seenArchiveReceiptRef.current?.eventId === eventId && seenArchiveReceiptRef.current.commandId === id && busyAction === null) {
      seenArchiveReceiptRef.current = null;
      // A shared status check does not resend the request. Refresh the
      // authoritative event state before clearing the local archive guard.
      void refresh(true);
    }
  }, [archiveUnresolved, eventReceipts, busyAction, eventId]);

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
    if (inFlightRef.current || mmsUploadGateRef.current || (mmsUploadRef.current && mmsUploadRef.current.file !== file)) return;
    if (file.size > 200 * 1024) {
      setCampaignFieldError({ field: "imageFileId", message: "MMS 이미지는 JPG 200KB 이하만 가능합니다." });
      return;
    }
    if (file.type !== "image/jpeg") {
      setCampaignFieldError({ field: "imageFileId", message: "MMS 이미지는 JPG 형식을 사용하세요." });
      return;
    }
    const attempt = mmsUploadRef.current ?? { eventId, file, commandId: commandId(), uncertain: false };
    mmsUploadRef.current = attempt;
    mmsUploadGateRef.current = true;
    setUploadingImage(true);
    setCampaignFieldError(null);
    setMmsUploadError(null);
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(attempt.eventId)}/files?name=${encodeURIComponent(attempt.file.name)}&commandId=${encodeURIComponent(attempt.commandId)}`,
        { method: "POST", headers: { "content-type": attempt.file.type }, body: attempt.file }
      );
      const data = (await res.json().catch(() => null)) as {
        file?: { fileId?: unknown; name?: unknown; type?: unknown; size?: unknown; width?: unknown; height?: unknown };
        error?: unknown;
      } | null;
      if (activeMessageEventRef.current !== attempt.eventId) return;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      if (!res.ok || !/^[A-Za-z0-9_-]{1,160}$/.test(fileId) || data?.file?.name !== attempt.file.name ||
          data?.file?.type !== attempt.file.type || data?.file?.size !== attempt.file.size ||
          !Number.isInteger(data?.file?.width) || Number(data?.file?.width) < 1 ||
          !Number.isInteger(data?.file?.height) || Number(data?.file?.height) < 1) {
        const definitive = !attempt.uncertain && !res.ok && res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status);
        if (definitive) {
          mmsUploadRef.current = null;
          setCampaignFieldError({ field: "imageFileId", message: typeof data?.error === "string" ? data.error : "이미지를 올리지 못했습니다." });
        } else {
          attempt.uncertain = true;
          setUncertainMmsUpload(true);
          setMmsUploadError("업로드 결과를 확인하지 못했습니다. 같은 사진 요청을 다시 시도하세요.");
        }
        return;
      }
      mmsUploadRef.current = null;
      setUncertainMmsUpload(false);
      setAbandonMmsUploadConfirm(false);
      setCampaignDraft((current) => ({
        ...current,
        channel: current.channel === "ALIMTALK" ? "ALIMTALK" : "MMS",
        imageFileId: fileId,
        imageName: typeof data?.file?.name === "string" ? data.file.name : attempt.file.name,
      }));
    } catch (error) {
      if (activeMessageEventRef.current !== attempt.eventId) return;
      if (!attempt.uncertain && isOrganizationContextBlock(error)) {
        mmsUploadRef.current = null;
        setCampaignFieldError({ field: "imageFileId", message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        attempt.uncertain = true;
        setUncertainMmsUpload(true);
        setMmsUploadError("업로드 결과를 확인하지 못했습니다. 같은 사진 요청을 다시 시도하세요.");
      }
    } finally {
      mmsUploadGateRef.current = false;
      if (activeMessageEventRef.current === attempt.eventId) setUploadingImage(false);
    }
  }

  async function refresh(silent = false, recheckRecipients = false) {
    const requestEventId = eventId;
    if (!silent) setState({ kind: "loading" });
    try {
      const [meResponse, bootstrapResponse] = await Promise.all([
        consoleFetch("/api/auth/me", { cache: "no-store" }),
        consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap?messageRecipientReview=1`, { cache: "no-store" }),
      ]);
      if (activeMessageEventRef.current !== requestEventId) return false;
      if (meResponse.status === 401 || bootstrapResponse.status === 401) {
        if (recheckRecipients) return false;
        if (silent && pendingTemplateRef.current) {
          setTemplateError("서버의 최신 템플릿을 불러오지 못했습니다. 현재 계정과 행사 권한을 확인하세요.");
          return false;
        }
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return false;
      }
      const meData = await meResponse.json().catch(() => null) as unknown;
      const bootstrapData = await bootstrapResponse.json().catch(() => null) as unknown;
      const user = asRecord(asRecord(meData)?.user);
      const root = asRecord(bootstrapData);
      const bootstrap = asRecord(root?.state);
      if (activeMessageEventRef.current !== requestEventId) return false;
      if (!meResponse.ok || !bootstrapResponse.ok || !user || !bootstrap) {
        if (recheckRecipients) return false;
        if (silent && pendingTemplateRef.current) { setTemplateError("최신 템플릿을 불러오지 못했습니다. 잠시 후 다시 확인하세요."); return false; }
        setState({ kind: "failed", message: "메시지 정보를 불러오지 못했습니다." });
        return false;
      }
      const role = text(user.role);
      const myId = text(user.id);
      // Retain the raw membership grant: omitted write means full access,
      // [] means read-only. Never default a missing grant to [] here.
      const memberships: Array<{ accountId: string; eventId: string; write?: unknown }> = Array.isArray(bootstrap.memberships)
        ? bootstrap.memberships.flatMap((value) => {
            const item = asRecord(value);
            if (!item || typeof item.accountId !== "string" || typeof item.eventId !== "string") return [];
            return [{ accountId: item.accountId, eventId: item.eventId, write: item.write }];
          })
        : [];
      const canManage = role === "AGENCY" || (role === "MANAGER" && memberships.some(
        (membership) => membership.accountId === myId && membership.eventId === eventId
      ));
      // messages scope for sends/templates, settings scope for event.stage
      // archive (server/event-permissions.js authority). Unknown membership
      // shapes are accepted by the helper; a throw never blocks reads.
      let canWriteMessages = canManage;
      let canArchive = canManage;
      try {
        canWriteMessages = canWriteEvent({ role, userId: myId, memberships, eventId }, "message.create-reviewed");
      } catch {
        canWriteMessages = canManage;
      }
      try {
        canArchive = canWriteEvent({ role, userId: myId, memberships, eventId }, "event.stage");
      } catch {
        canArchive = canManage;
      }
      const events = Array.isArray(bootstrap.events) ? bootstrap.events : [];
      const event = events.map(asRecord).find((item) => item?.id === eventId);
      const workspaces = asRecord(bootstrap.workspaces);
      const workspace = asRecord(workspaces?.[eventId]);
      if (!event || !workspace) {
        if (recheckRecipients) return false;
        if (silent && pendingTemplateRef.current) { setTemplateError("최신 템플릿을 불러오지 못했습니다. 행사 접근 권한을 확인하세요."); return false; }
        setState({ kind: "failed", message: "행사를 찾을 수 없습니다." });
        return false;
      }
      const clients = Array.isArray(bootstrap.clients) ? bootstrap.clients : [];
      const client = clients.map(asRecord).find((item) => item?.id === event.clientId);
      const venue = asRecord(workspace.venue);
      // New-org simulation lock: a fresh org never inherits the deployment
      // provider, so its composer defaults to (and stays) simulated. Only
      // the flag is forced — title/body/selection/template drafts are
      // untouched — and a later connection never unchecks it (the toggle
      // stays user-owned; see the compose section).
      const scopedIntegrations = parseOrgIntegrations(bootstrap.integrations);
      const schedule = asRecord(bootstrap.messageSchedule);
      const messageSchedule: MessageSchedule | null = schedule && typeof schedule.autoConfigured === "boolean" &&
        typeof schedule.eligibleForAuto === "boolean" && typeof schedule.workerStarted === "boolean"
        ? { observedAt: text(schedule.observedAt), autoConfigured: schedule.autoConfigured, eligibleForAuto: schedule.eligibleForAuto,
            workerStarted: schedule.workerStarted, lastAttemptAt: text(schedule.lastAttemptAt), lastResult: text(schedule.lastResult),
            blocked: Array.isArray(schedule.blocked) ? schedule.blocked.flatMap((value) => {
              const item = asRecord(value);
              return item && typeof item.id === "string" && typeof item.reason === "string" && item.reason.length > 0
                ? [{ id: item.id, reason: item.reason, missing: typeof item.missing === "number" ? item.missing : 0 }] : [];
            }) : [] }
        : null;
      const serverMs = Date.parse(messageSchedule?.observedAt ?? "");
      messageClockRef.current = Number.isFinite(serverMs) && typeof performance !== "undefined"
        ? { eventId: requestEventId, serverMs, receivedAt: performance.now() } : null;
      if (isNewOrgSimOnly(scopedIntegrations)) {
        setCampaignDraft((current) => (current.simulate && current.scheduleMode === "MANUAL" ? current : { ...current, simulate: true, scheduleMode: "MANUAL" }));
      }
      // A deliberate refresh may prove the intended terminal state even
      // when the original receipt response was lost. Resolve only from the
      // authoritative same-event bootstrap, not from closing the panel.
      if (text(event.stage).toUpperCase() === "ARCHIVED" && archiveCommandRef.current) {
        archiveCommandRef.current = null;
        setArchiveUnresolved(false);
        setArchiveConfirm(false);
        setArchiveError(null);
        setArchiveNotice("서버 재조회에서 보관된 행사임을 확인했습니다.");
        window.dispatchEvent(new Event("eventouch:shell-reload"));
      }
      loadedMessageEventRef.current = requestEventId;
      const recipientReviewVersions = asRecord(bootstrap.recipientReviewVersions);
      if (recheckRecipients && !recipientReviewVersions) return false;
      const participants = Array.isArray(workspace.participants) ? workspace.participants.flatMap((value) => {
        const parsed = parseParticipant(value, recipientReviewVersions);
        return parsed ? [parsed] : [];
      }) : [];
      if (recheckRecipients) {
        const available = new Set(participants.filter(person => recipientEligible(person) && person.reviewVersion).map(person => person.id));
        const retained = selectedIds.filter(id => available.has(id));
        setSelectedIds(retained);
        setShowSelectedOnly(retained.length > 0);
        setCharsetCandidatesOnly(false);
        if (!retained.length) {
          setRecipientStatus("ALL");
          setRecipientGroup("");
          setRecipientQuery("");
        }
        const removed = selectedIds.length - retained.length;
        setCampaignNotice(removed > 0 ? `최신 수신자를 불러왔습니다. 발송할 수 없는 ${removed}명을 선택에서 제외했습니다.` : "최신 수신자를 불러왔습니다. 상태와 그룹을 다시 확인하세요.");
      }
      setState({
        kind: "ready",
        closeSnapshot: readCloseSnapshot(event, workspace),
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
        canWriteMessages,
        canArchive,
        // Display authority for the send path below: the current org's
        // scoped integrations. Never /api/health (process-shared legacy
        // state). Sending behavior is untouched by this value, except the
        // new-org simulation lock applied in refresh().
        integrations: scopedIntegrations,
        messageSchedule,
        participants,
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
      return true;
    } catch {
      if (activeMessageEventRef.current !== requestEventId) return false;
      if (recheckRecipients) return false;
      if (silent && pendingTemplateRef.current) { setTemplateError("최신 템플릿을 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요."); return false; }
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      return false;
    }
  }

  useEffect(() => {
    void refresh();
    setCloseNoticeStatus(undefined);
    setArchiveConfirm(false);
    setArchiveError(null);
    setArchiveNotice(null);
    setArchiveUnresolved(false);
    archiveCommandRef.current = null;
    // Bootstrap is scoped by this event; the session cookie is same-origin.
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
    setHistoryQuery("");
    setHistoryStatus("ALL");
    setExpandedCampaignId(null);
    pendingHistoryFocusRef.current = null;
  }, [eventId]);

  // Keyboard reveal: move focus to the first newly revealed campaign row
  // after 이전 발송 더 보기, including the final reveal where the button
  // disappears. Counts and the attention anchor semantics stay untouched.
  useEffect(() => {
    const target = pendingHistoryFocusRef.current;
    if (target === null) return;
    pendingHistoryFocusRef.current = null;
    const row = historyListRef.current?.querySelectorAll<HTMLElement>("[data-history-row]")[target];
    row?.focus?.();
  }, [historyLimit]);

  // Keep history focus on the row chosen by the completed action.
  useEffect(() => {
    if (state.kind !== "ready") return;
    const id = historyActionFocusRef.current;
    if (!id) return;
    historyActionFocusRef.current = null;
    const row = document.getElementById(`campaign-${id}`);
    if (row) {
      row.scrollIntoView({ block: "nearest" });
      row.focus({ preventScroll: true });
    }
  }, [state]);

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
    const stripHandoffParams = () => {
      try {
        const url = new URL(window.location.href);
        url.searchParams.delete("to");
        url.searchParams.delete("status");
        const next = `${url.pathname}${url.search ? `?${url.searchParams.toString()}` : ""}${url.hash}`;
        window.history.replaceState(null, "", next);
      } catch {
        // Handoff still applies; only the shareable URL keeps the params.
      }
    };
    handoffAppliedRef.current = eventId;
    if (!raw.length) {
      stripHandoffParams();
      return;
    }
    if (!state.canManage) {
      stripHandoffParams();
      return;
    }
    const unique = [...new Set(raw)];
    const byId = new Map(state.participants.map((person) => [person.id, person]));
    const valid: string[] = [];
    let excluded = raw.length - unique.length;
    let conflictExcluded = 0;
    for (const id of unique) {
      const person = byId.get(id);
      if (!person || !recipientEligible(person)) {
        excluded += 1;
        if (person && person.status.toUpperCase() !== "CANCELLED" && person.ticketReview === "cancelled") conflictExcluded += 1;
      }
      else valid.push(id);
    }
    setSelectedIds(valid);
    setComposeStep(valid.length > 0 && excluded === 0 ? 2 : 1);
    setComposerOpen(true);
    setHistoryOpen(false);
    window.setTimeout(() => document.getElementById("campaign-heading")?.scrollIntoView({ block: "start" }), 0);
    if (valid.length > 0) { setShowSelectedOnly(true); setCharsetCandidatesOnly(false); }
    // The approval follow-up names its filter explicitly (?status=); any
    // other ?to= link leaves the filter alone. Unknown values fall back to
    // the composer default. Selection mechanics are untouched: no auto-send.
    const handoffStatus = readRecipientStatusHandoff(window.location.search);
    if (handoffStatus !== null) setRecipientStatus(handoffStatus);
    setHandoffNotice(
      excluded > 0
        ? conflictExcluded ? `명단에서 ${valid.length}명을 인계받았습니다 · 제외 ${excluded}명(취소·삭제·상태 확인 필요)`
          : `명단에서 ${valid.length}명을 인계받았습니다 · 제외 ${excluded}명(취소·삭제)`
        : `명단에서 ${valid.length}명을 인계받았습니다`
    );
    stripHandoffParams();
  }, [state, eventId]);

  useEffect(() => {
    if (!attentionOnly || state.kind !== "ready") return;
    setHistoryOpen(true);
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
    uncertainMmsUpload ||
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
    uncertainMmsUpload
      ? "MMS 사진이 이미 올라갔을 수 있습니다. 화면을 떠나면 같은 사진 요청을 다시 시도할 수 없습니다."
      : "작성 중인 발송 내용이나 응답을 확인하지 못한 발송 요청이 있습니다. 페이지를 떠나면 사라집니다."
  );

  // Shared freshness: history-only silent refresh. Drafts, selections and
  // unconfirmed receipts must never be blindly reloaded.
  const historyGuardDirty =
    composeDirty || templateDirty || pendingIntent || sendPending !== null || historyPending !== null || reloadPending !== null;
  useEffect(() => {
    return subscribeConsoleFreshness(() => {
      if (historyGuardDirty || busyAction !== null || inFlightRef.current || uploadingImage) return;
      void refresh(true);
    });
  }, [eventId, historyGuardDirty, busyAction, uploadingImage]);

  const hasFutureScheduled = state.kind === "ready" && state.campaigns.some((campaign) =>
    campaign.status === "SCHEDULED" &&
    campaign.scheduled &&
    hasValidScheduledInstant(campaign.scheduled) &&
    Date.parse(campaign.scheduled) > messageNow()
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
    const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
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

  async function submitProviderCheck(attempt: ProviderCheckAttempt) {
    if (attempt.eventId !== activeMessageEventRef.current || !beginAction("provider-check")) return;
    setProviderCheckError(null);
    try {
      const result = await postCommand("message.record-provider-check", attempt.payload, attempt.id);
      if (activeMessageEventRef.current !== attempt.eventId) return;
      if (!confirmsProviderCheck(attempt.payload, result)) {
        setProviderCheck({ ...attempt, uncertain: true });
        setProviderCheckError("기록 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요.");
        return;
      }
      acknowledgeOperatorReceipt(attempt.id); forgetOperatorReceipt(attempt.id);
      setProviderCheck(null); setProviderCheckChoice(""); setProviderCheckConfirm(false);
      setCampaignNotice("공급사 확인 결과를 운영자 기록으로 저장했습니다. 실제 단말 전달을 확인한 것은 아닙니다.");
      await refresh(true);
    } catch (error) {
      if (activeMessageEventRef.current !== attempt.eventId) return;
      const status = error instanceof CommandFailure ? (error as CommandFailure & { status?: number }).status : undefined;
      if (!attempt.uncertain && typeof status === "number" && !isAmbiguousStatus(status)) {
        setProviderCheckError(error instanceof Error ? error.message : "공급사 확인 기록을 저장하지 못했습니다.");
        setProviderCheckConfirm(false);
      } else {
        setProviderCheck({ ...attempt, uncertain: true });
        setProviderCheckError("기록 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하세요.");
      }
    } finally { endAction(); }
  }

  async function archiveFromCloseFlow() {
    if (state.kind !== "ready" || !state.canManage || state.stage !== "ENDED" || !state.closeSnapshot.archiveAvailable || state.closeSnapshot.registrationOpen || state.closeSnapshot.openModules.length || !archiveConfirm || !beginAction("archive")) return;
    const wasUnresolved = archiveUnresolved && archiveCommandRef.current !== null;
    const id = archiveCommandRef.current ?? commandId();
    archiveCommandRef.current = id;
    setArchiveUnresolved(true);
    setArchiveError(null);
    try {
      const result = await postCommand("event.stage", { stage: "ARCHIVED" }, id);
      const event = asRecord(result.event);
      if (!event || event.id !== eventId || text(event.stage).toUpperCase() !== "ARCHIVED") {
        setArchiveError("보관 응답을 확인하지 못했습니다. 이미 보관됐을 수 있습니다. 같은 요청으로 다시 확인하세요.");
        return;
      }
      archiveCommandRef.current = null;
      setArchiveUnresolved(false);
      setArchiveNotice("행사를 보관했습니다.");
      await refresh(true);
      setArchiveConfirm(false);
      window.dispatchEvent(new Event("eventouch:shell-reload"));
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!wasUnresolved && typeof status === "number" && !isAmbiguousStatus(status)) {
        archiveCommandRef.current = null;
        setArchiveUnresolved(false);
        setArchiveConfirm(false);
        setArchiveError(error instanceof Error ? error.message : "보관하지 못했습니다.");
        await refresh(true);
      } else {
        setArchiveError("보관 응답을 확인하지 못했습니다. 이미 보관됐을 수 있습니다. 같은 요청으로 다시 확인하세요.");
      }
    } finally {
      endAction();
    }
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
    if (inFlightRef.current || pendingTemplateRef.current || templateRecoveryLocked || state.kind !== "ready" || !state.canWriteMessages || state.stage === "ARCHIVED") return;
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
    if (templateDraft.id) { payload.id = templateDraft.id; payload.expectedVersion = templateDraft.version ?? 0; }
    const fingerprint = fingerprintFor("template.save", payload);
    const id = takeCommandId(templateSaveRef, fingerprint);
    const attempt: TemplateAttempt = { eventId, id, command: "template.save", fingerprint, payload, draft: { ...templateDraft } };
    templateFocusOriginRef.current = document.activeElement;
    await executeTemplateSave(attempt, false);
  }

  async function executeTemplateSave(attempt: TemplateAttempt, retry: boolean) {
    if (attempt.eventId !== activeMessageEventRef.current || otherTemplateReceipt || refreshingOtherTemplate ||
        (pendingTemplateRef.current && pendingTemplateRef.current.id !== attempt.id) ||
        state.kind !== "ready" || !state.canWriteMessages || state.stage === "ARCHIVED" || !beginAction("template")) return;
    const wasUnconfirmed = retry && pendingTemplateRef.current?.id === attempt.id;
    // A freshness read may finish before the write response. Keep its frozen
    // owner now so a failed background read cannot replace the workspace.
    pendingTemplateRef.current = attempt;
    const focusOrigin = document.activeElement;
    const markUnconfirmed = () => {
      pendingTemplateRef.current = attempt;
      setPendingTemplate(attempt);
      setTemplateError("결과를 확인하지 못했습니다. 서버에서 확인하거나 원래 요청을 다시 시도하세요.");
      if (wasUnconfirmed) window.requestAnimationFrame(() => {
        const active = document.activeElement;
        if (active && active !== document.body && active !== focusOrigin && active.isConnected) return;
        const heading = document.getElementById("template-recovery-heading");
        heading?.scrollIntoView({ block: "center", behavior: "instant" as ScrollBehavior });
        heading?.focus({ preventScroll: true });
      });
    };
    try {
      const result = await postCommand(attempt.command, attempt.payload, attempt.id);
      if (activeMessageEventRef.current !== attempt.eventId) return;
      const saved = parseTemplate(result.template);
      if (!saved || !(attempt.command === "template.archive" ? confirmsTemplateArchive(attempt.payload, result, attempt.target) : confirmsTemplateSave(attempt.payload, result))) {
        markUnconfirmed();
        return;
      }
      // Keep the original attempt until the refreshed list is available.
      pendingTemplateRef.current = attempt;
      const refreshed = await refresh(true);
      if (activeMessageEventRef.current !== attempt.eventId) return;
      if (!refreshed) { setPendingTemplate(attempt); return; }
      acknowledgeOperatorReceipt(attempt.id); forgetOperatorReceipt(attempt.id);
      templateSaveRef.current = null;
      pendingTemplateRef.current = null; setPendingTemplate(null); setTemplateError(null);
      if (attempt.command === "template.save") setTemplateDraft((current) => JSON.stringify(current) === JSON.stringify(attempt.draft) ? { ...saved } : current);
      setTemplateNotice(attempt.command === "template.save" ? "템플릿을 저장했습니다." : saved.archived ? "템플릿을 보관했습니다. 기존 발송 기록과 등록된 예약은 유지됩니다." : "템플릿을 복원했습니다. 새 메시지에서 다시 선택할 수 있습니다.");
    } catch (error) {
      if (activeMessageEventRef.current !== attempt.eventId) return;
      const status = (error as { status?: unknown }).status;
      if (wasUnconfirmed || typeof status === "number" && isAmbiguousStatus(status)) {
        markUnconfirmed();
      } else if (isOrganizationContextBlock(error)) {
        templateSaveRef.current = null;
        pendingTemplateRef.current = null;
        setTemplateError("현재 조직을 확인한 뒤 다시 시도하세요. 요청은 보내지 않았습니다.");
      } else if (error instanceof CommandFailure) {
        templateSaveRef.current = null;
        pendingTemplateRef.current = null;
        handleCommandError(error, "template");
      } else {
        markUnconfirmed();
      }
    } finally {
      endAction();
    }
  }

  async function checkTemplateSave() {
    const attempt = pendingTemplateRef.current;
    if (!attempt || attempt.eventId !== activeMessageEventRef.current || checkingTemplate || !beginAction("template-check")) return;
    setCheckingTemplate(true); setTemplateError(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(attempt.eventId)}/command-receipts/${encodeURIComponent(attempt.id)}`, { cache: "no-store" });
      const result = asRecord(await response.json().catch(() => null));
      if (activeMessageEventRef.current !== attempt.eventId) return;
      if (response.ok && result?.status === "APPLIED" && result.command === attempt.command) {
        if (!await refresh(true) || activeMessageEventRef.current !== attempt.eventId) return;
        acknowledgeOperatorReceipt(attempt.id); forgetOperatorReceipt(attempt.id);
        templateSaveRef.current = null; pendingTemplateRef.current = null; setPendingTemplate(null);
        const settled = attempt.draft.id ? {
          ...attempt.draft, name: attempt.draft.name.trim(), body: attempt.draft.body.trim(),
          solapiTemplateId: attempt.draft.solapiTemplateId.trim(),
          version: typeof attempt.payload.expectedVersion === "number" ? attempt.payload.expectedVersion + 1 : attempt.draft.version,
        } : EMPTY_TEMPLATE;
        if (attempt.command === "template.save") setTemplateDraft((current) => JSON.stringify(current) === JSON.stringify(attempt.draft) ? settled : current);
        setTemplateNotice("서버에 반영된 것을 확인했습니다. 최신 템플릿 목록을 확인하세요.");
      } else setTemplateError(response.ok && result?.status === "UNCONFIRMED"
        ? "아직 처리 여부를 확인할 수 없습니다. 요청이 처리 중이거나 도착하지 않았을 수 있습니다."
        : "결과를 확인하지 못했습니다. 연결과 현재 행사 접근 권한을 확인하세요.");
    } catch {
      if (activeMessageEventRef.current === attempt.eventId) setTemplateError("서버에 연결하지 못했습니다. 저장 요청은 다시 보내지 않았습니다.");
    } finally {
      if (activeMessageEventRef.current === attempt.eventId) setCheckingTemplate(false);
      endAction();
    }
  }

  function applyTemplate(template: Template) {
    setReloadSummary(null);
    if (template.archived) { setTemplateError("보관된 템플릿은 복원한 뒤 사용하세요."); return; }
    setComposeStep(selectedIds.length ? 2 : 1);
    focusComposerOnOpenRef.current = true;
    revealComposer();
    setSelectedTemplateId(template.id);
    setCampaignDraft((current) => ({ ...current, channel: textFamilyChannel(template.channel, current.imageFileId), body: template.body }));
    setPendingTemplateUse(null);
    setCampaignFieldError(null);
    setCampaignError(null);
  }
  function useTemplate(template: Template) {
    if (inFlightRef.current || uncertainCreateRef.current || uncertainMmsUpload) return;
    if (template.archived) { setTemplateError("보관된 템플릿은 복원한 뒤 사용하세요."); return; }
    if (campaignDraft.body.trim() && campaignDraft.body !== template.body) {
      setPendingTemplateUse({ ...template });
      setComposeStep(2);
      revealComposer();
      return;
    }
    applyTemplate(template);
  }
  function audienceIds(preset: AudiencePreset): string[] {
    if (state.kind !== "ready") return [];
    return state.participants.filter(person => recipientEligible(person) && (
      preset === "pending" ? person.status === "PENDING"
        : person.status === "APPROVED" && (preset === "approved" || person.notEntered)
    )).map(person => person.id);
  }
  // A preset replaces the selection with that whole group; 직접 고르기 keeps
  // today's filter-and-check list for anything finer.
  function selectAudience(preset: AudiencePreset, label: string) {
    if (inFlightRef.current || uncertainCreateRef.current || uncertainMmsUpload || messagesLocked) return;
    const ids = audienceIds(preset);
    if (!ids.length) return;
    setSelectedIds(ids); setChosenPreset(preset);
    setShowSelectedOnly(false); setCharsetCandidatesOnly(false);
    setCampaignFieldError(current => current?.field === "ids" ? null : current);
    setComposeNotice(`${label} ${ids.length}명을 받는 사람으로 골랐습니다.`);
  }
  function applyPurpose(purpose: PurposeTemplate) {
    setPendingPurpose(null);
    setReloadSummary(null);
    setSelectedTemplateId(""); setPendingTemplateUse(null);
    setCampaignDraft(current => ({ ...current, channel: textFamilyChannel("SMS", current.imageFileId), body: purpose.body }));
    setLoadedPurpose(purpose);
    setCampaignFieldError(null); setCampaignError(null);
    const filled: string[] = [];
    if (!selectedIds.length && purpose.audience) {
      const ids = audienceIds(purpose.audience);
      if (ids.length) {
        setSelectedIds(ids); setChosenPreset(purpose.audience);
        filled.push(`받는 사람(${purpose.audience === "approved" ? "참가 확정" : purpose.audience === "pending" ? "승인 대기" : "확정자 중 미입장"} ${ids.length}명)`);
      }
    }
    if (!campaignDraft.scheduled && purpose.schedule && state.kind === "ready") {
      const scheduled = eventRelativeSchedule(state.eventDate, purpose.schedule);
      const instant = scheduled ? scheduledInstant(scheduled) : null;
      if (instant && Date.parse(instant) > messageNow()) {
        setScheduleChoice("EVENT"); setEventOffset(purpose.schedule);
        setCampaignDraft(current => ({ ...current, scheduled }));
        filled.push(`보낼 때(${formatScheduledInput(scheduled).replace(" (한국 시간)", "")})`);
      }
    }
    setComposeNotice(`〈${purpose.label}〉 문구를 불러왔습니다.${filled.length ? ` ${filled.join("와 ")}도 채웠습니다.` : ""} 모두 고칠 수 있고, 발송 검토 전에는 보내지 않습니다.`);
    window.requestAnimationFrame(() => campaignBodyRef.current?.focus({ preventScroll: true }));
  }
  function requestPurpose(purpose: PurposeTemplate) {
    if (inFlightRef.current || uncertainCreateRef.current || uncertainMmsUpload || messagesLocked) return;
    if (campaignDraft.body.trim() && campaignDraft.body !== purpose.body) { setPendingPurpose(purpose); return; }
    applyPurpose(purpose);
  }
  function chooseSchedule(choice: "NOW" | "EVENT" | "DATE") {
    if (messagesLocked) return;
    setScheduleChoice(choice);
    setScheduleBadInput(false);
    setCampaignFieldError(current => current?.field === "scheduled" ? null : current);
    if (choice === "NOW") setCampaignDraft(current => ({ ...current, scheduled: "", scheduleMode: "MANUAL" }));
    else if (choice === "EVENT" && state.kind === "ready") setCampaignDraft(current => ({ ...current, scheduled: eventRelativeSchedule(state.eventDate, eventOffset) }));
  }
  function changeEventOffset(next: EventOffset) {
    setEventOffset(next);
    if (state.kind === "ready") setCampaignDraft(current => ({ ...current, scheduled: eventRelativeSchedule(state.eventDate, next) }));
    setCampaignFieldError(current => current?.field === "scheduled" ? null : current);
  }
  function openDirectPick() {
    setRecipientListOpen(true);
    window.setTimeout(() => document.getElementById("recipient-status-filter")?.focus(), 0);
  }

  function openTemplateManager() {
    if (inFlightRef.current || uploadingImage) return;
    focusHistoryOnCloseRef.current = false;
    setComposerOpen(false);
    setHistoryOpen(true);
    window.requestAnimationFrame(() => requestConsoleTask("templates-heading", true));
  }

  async function changeTemplateArchive(template: Template, archived: boolean) {
    if (inFlightRef.current || templateRecoveryLocked || state.kind !== "ready" || !state.canWriteMessages || state.stage === "ARCHIVED") return;
    const current = state.templates.find(item => item.id === template.id);
    setTemplateArchiveConfirm(null); setTemplateError(null); setTemplateFieldError(null); setTemplateNotice(null);
    if (!current || current.version !== template.version) {
      setTemplateError("템플릿이 변경됐습니다. 목록을 새로고침한 뒤 다시 확인하세요."); return;
    }
    const payload = { id: template.id, archived, expectedVersion: template.version };
    const fingerprint = fingerprintFor("template.archive", payload);
    const id = takeCommandId(templateSaveRef, fingerprint);
    templateFocusOriginRef.current = document.activeElement;
    await executeTemplateSave({ eventId, id, command: "template.archive", fingerprint, payload, draft: { ...templateDraft }, target: { ...template } }, false);
  }

  function clearTemplateDraft() {
    setTemplateDraft(EMPTY_TEMPLATE); setTemplateError(null); setTemplateFieldError(null); setTemplateNotice(null); setTemplateResetConfirm(false); setTemplateEditConfirm(null);
  }
  function requestNewTemplate() {
    if (inFlightRef.current || templateRecoveryLocked) return;
    setTemplateArchiveConfirm(null); setTemplateEditConfirm(null);
    if (templateDirty) setTemplateResetConfirm(true); else clearTemplateDraft();
  }
  function openTemplateEditor(template: Template) {
    setTemplateDraft({ ...template }); setTemplateError(null); setTemplateFieldError(null); setTemplateNotice(null); setTemplateEditConfirm(null);
  }
  function requestTemplateEdit(template: Template) {
    if (inFlightRef.current || templateRecoveryLocked || template.archived) return;
    setTemplateResetConfirm(false); setTemplateArchiveConfirm(null);
    if (templateDirty) setTemplateEditConfirm({ ...template }); else openTemplateEditor(template);
  }

  function insertPersonalization(name: string) {
    if (inFlightRef.current || uncertainCreateRef.current || uncertainMmsUpload || messagesLocked || campaignDraft.channel === "ALIMTALK") return;
    const textarea = campaignBodyRef.current;
    if (!textarea) return;
    const token = `{{${name}}}`;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const nextBody = campaignDraft.body.slice(0, start) + token + campaignDraft.body.slice(end);
    if (nextBody.length > 2000) {
      setCampaignFieldError({ field: "body", message: "개인화 정보를 넣으려면 내용을 줄여 주세요. 최대 2,000자까지 작성할 수 있습니다." });
      textarea.focus();
      return;
    }
    setCampaignDraft(current => ({ ...current, body: nextBody }));
    setCampaignFieldError(current => current?.field === "body" ? null : current);
    window.requestAnimationFrame(() => {
      if (activeMessageEventRef.current !== eventId || textarea.value !== nextBody) return;
      textarea.focus();
      textarea.setSelectionRange(start + token.length, start + token.length);
    });
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
  // activates it immediately. Scroll follows for sighted operators. When
  // the submit is disabled (zero recipients, or the locked compose) the
  // button focus is a silent no-op, so land on the review summary instead:
  // the blocker reason already reads there and is announced on focus.
  function jumpToCampaignSubmit() { goComposeStep(3); }

  // Forward exit from the recipient picker into the draft: from the first
  // checkboxes Tab would otherwise walk every remaining recipient before
  // reaching the title. One move back to this exit (it sits ahead of the
  // list) then Enter lands in the title. Never sends.
  function jumpToCampaignTitle() { goComposeStep(2); }

  // Back path from the review bar to the picker: the draft sits between
  // them, so Shift+Tab from the submit would otherwise walk the whole
  // draft backwards. Filters live inside the native disclosure now, so
  // reveal it first and land after React commits — never into hidden
  // content. Never sends.
  function jumpToRecipientFilter() {
    setComposeStep(1);
    setRecipientListOpen(true);
    window.setTimeout(() => {
      document.getElementById("campaign-recipients")?.scrollIntoView({ block: "start", behavior: "instant" });
      document.getElementById("recipient-status-filter")?.focus({ preventScroll: true });
    }, 0);
  }

  function requestCampaignCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current || uploadingImage || uncertainMmsUpload || recipientReviewRequired) return;
    if (uncertainCreateRef.current || otherCreateReceipt) {
      setCampaignError("이전 발송 요청의 서버 처리 결과를 먼저 확인하세요.");
      return;
    }
    setCampaignError(null);
    setCampaignFieldError(null);
    setCampaignNotice(null);
    if (sendPending && state.kind === "ready" && !recipientVersionsMatch(sendPending, state.participants)) {
      requireRecipientReview();
      return;
    }
    // A re-submit invalidates any earlier pending summary: validation below
    // either replaces it or leaves it cleared.
    setSendPending(null);
    if (!selectedIds.length) {
      setCampaignFieldError({ field: "ids", message: "발송 대상을 선택하세요." });
      return;
    }
    const reviewedPeople = new Map(state.kind === "ready" ? state.participants.map(person => [person.id, person]) : []);
    if (selectedIds.some(id => { const person = reviewedPeople.get(id); return !person || !recipientEligible(person); })) {
      requireRecipientReview("발송할 수 없는 수신자가 있습니다. 최신 목록을 불러와 대상을 다시 확인하세요.");
      return;
    }
    const invalidTickets = campaignDraft.body.includes("{{티켓링크}}")
      ? selectedIds.filter(id => reviewedPeople.get(id)?.ticketReview !== "valid").length : 0;
    if (!campaignDraft.simulate && invalidTickets) {
      setCampaignError(`티켓을 사용할 수 없거나 상태를 확인할 수 없는 수신자가 ${invalidTickets}명입니다. 참가자 명단에서 티켓을 확인한 뒤 다시 검토하세요.`);
      return;
    }
    const expectedRecipientVersions = selectedIds.map(id => reviewedPeople.get(id)?.reviewVersion ?? "");
    if (expectedRecipientVersions.some(version => !/^[a-f0-9]{64}$/.test(version))) {
      requireRecipientReview("발송 대상의 최신 정보가 필요합니다. 수신자 목록을 다시 불러오세요.");
      return;
    }
    if (!campaignDraft.body.trim()) {
      setCampaignFieldError({ field: campaignDraft.channel === "ALIMTALK" ? "templateId" : "body", message: campaignDraft.channel === "ALIMTALK" ? "승인된 알림톡 템플릿을 선택하세요." : "메시지 내용을 입력하세요." }); return;
    }
    // An empty record title is filled, never asked for (Reopened 2026-11-23).
    const campaignTitle = campaignDraft.title.trim() ? campaignDraft.title : autoCampaignTitle(loadedPurpose?.label ?? "", campaignDraft.scheduled, koreaToday());
    const isAlimtalk = campaignDraft.channel === "ALIMTALK";
    const boundTemplate = state.kind === "ready"
      ? state.templates.find((template) => template.id === selectedTemplateId)
      : undefined;
    const contentIssue = messageContentIssue(campaignDraft, boundTemplate);
    if (contentIssue) { setCampaignFieldError(contentIssue); return; }
    const charsetIssue = campaignCharsetIssue(campaignDraft, state.kind === "ready" ? state.integrations.provider : "");
    if (charsetIssue) { setCampaignFieldError(charsetIssue); return; }
    if (boundTemplate?.archived) {
      setCampaignFieldError({ field: "templateId", message: "보관된 템플릿입니다. 복원하거나 다른 템플릿을 선택하세요." });
      setComposeStep(2); return;
    }
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
    if (scheduleBadInput || scheduleInputRef.current?.validity.badInput) {
      setCampaignFieldError({ field: "scheduled", message: "예약 날짜와 시간을 모두 입력하거나 지워 주세요." });
      return;
    }
    const scheduled = campaignDraft.scheduled ? scheduledInstant(campaignDraft.scheduled) : "";
    if (scheduled === null) {
      setCampaignFieldError({ field: "scheduled", message: "올바른 예약 날짜와 시간을 입력하세요." });
      return;
    }
    if (scheduled && Date.parse(scheduled) <= messageNow()) {
      setCampaignFieldError({ field: "scheduled", message: "예약 시각은 현재 이후로 설정하세요." });
      return;
    }
    const scheduledCampaign = Boolean(scheduled);
    const riskCount = selectedIds.filter(id => {
      const status = reviewedPeople.get(id)?.status;
      return status === "PENDING" || status === "WAITLIST";
    }).length;
    const riskLine = riskCount > 0
      ? `\n선택 대상 중 승인 대기·대기 명단이 ${riskCount}명 포함되어 있습니다.`
      : "";
    // Snapshot the pending payload: background refresh, later draft edits
    // and error handling must not mutate what this request sends. Drafts
    // and selection clear only on proven success below, never on failure.
    const payload: Record<string, unknown> = {
      ids: [...selectedIds],
      expectedRecipientVersions,
      title: campaignTitle,
      channel: campaignDraft.channel,
      body: campaignDraft.body,
      simulate: campaignDraft.simulate,
    };
    if (selectedTemplateId) payload.templateId = selectedTemplateId;
    if (isAlimtalk) payload.smsFallback = campaignDraft.smsFallback;
    if (scheduled) { payload.scheduled = scheduled; payload.scheduleMode = campaignDraft.scheduleMode; }
    if (isMms) payload.imageFileId = campaignDraft.imageFileId;
    const fingerprint = fingerprintFor("message.create-charset-reviewed", payload);
    const id = takeCommandId(campaignCreateRef, fingerprint);
    // Server precedence (content-results.js): scheduled wins over simulate —
    // scheduled+simulate creates a SCHEDULED reservation that never delivers.
    // The confirmation leads with the schedule in every scheduled case and
    // states the simulation outcome explicitly.
    setSendPending({
      eventId,
      payload,
      id,
      reviewedDraft: campaignDraft,
      reviewedIds: selectedIds,
      reviewedTemplateId: selectedTemplateId,
      reviewedAttachmentRevision: attachmentRevision,
      summary: campaignCreateSummary({
        channel: campaignDraft.channel,
        scheduled: scheduledCampaign,
        scheduledAt: scheduled,
        simulate: campaignDraft.simulate,
        isMms,
        count: selectedIds.length,
        riskLine,
        scheduleStatus: state.kind === "ready" ? scheduleServerStatus(state.messageSchedule) : "이 서버의 예약 실행 설정을 확인할 수 없습니다.",
        scheduleMode: campaignDraft.scheduleMode,
        smsFallback: campaignDraft.smsFallback,
      }),
      confirmLabel: scheduledCampaign
        ? "예약 등록한다"
        : campaignDraft.simulate
          ? "모의 발송을 기록한다"
          : "발송 요청한다",
    });
  }

  function requireRecipientReview(message = "검토 후 수신자 정보가 바뀌었습니다. 최신 목록을 불러와 대상을 다시 확인하세요.") {
    setSendPending(null);
    setRecipientReviewRequired(true);
    setRecipientListOpen(true);
    setCampaignFieldError({ field: "ids", message });
  }

  async function reloadReviewedRecipients() {
    if (!beginAction("recipient-review")) return;
    try {
      const refreshed = await refresh(true, true);
      if (activeMessageEventRef.current !== eventId) return;
      if (!refreshed) {
        setCampaignFieldError({ field: "ids", message: "최신 수신자를 불러오지 못했습니다. 연결을 확인한 뒤 다시 시도하세요." });
        return;
      }
      setRecipientReviewRequired(false);
      setCampaignFieldError(null);
      requestAnimationFrame(() => document.getElementById("recipient-status-filter")?.focus());
    } finally {
      endAction();
    }
  }

  async function executeCampaignCreate(pending: SendPending) {
    if (pending.eventId !== activeMessageEventRef.current) return;
    if (!beginAction("campaign")) return;
    const wasUnconfirmed = uncertainCreateRef.current?.id === pending.id;
    const markUnconfirmed = () => {
      uncertainCreateRef.current = pending;
      setUncertainCreate(pending);
      setCampaignError("발송 요청 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.");
    };
    // The receipt only turns ambiguous once bytes actually leave: mark the
    // staged slot attempted here, keyed on our own commandId identity, so a
    // later FAILED reload blocks only on a real transmission. A same-fingerprint
    // restage reuses the id and keeps the marker; a different payload stages
    // a fresh unattempted id.
    if (campaignCreateRef.current?.commandId === pending.id) {
      campaignCreateRef.current.attempted = true;
    }
    try {
      const result = await postCommand("message.create-charset-reviewed", pending.payload, pending.id);
      if (activeMessageEventRef.current !== pending.eventId) return;
      const created = asRecord(result.message);
      // The server keys the created message by our commandId, so an id that
      // echoes it proves this response belongs to our request. Anything
      // else — including an empty object — is malformed, not success.
      if (!created || created.id !== pending.id || !confirmsCharsetReviewedMessageCreate(pending.id, pending.payload, result)) {
        markUnconfirmed();
        return;
      }
      campaignCreateRef.current = null;
      uncertainCreateRef.current = null;
      setUncertainCreate(null);
      setAbandonCreateConfirm(false);
      acknowledgeOperatorReceipt(pending.id);
      forgetOperatorReceipt(pending.id);
      setCampaignError(null);
      // Copy follows the returned record's status, not the draft flags:
      // scheduled+simulate comes back SCHEDULED, never SIMULATED.
      const createdStatus = text(created.status);
      setCloseNoticeStatus(createdStatus);
      setCampaignNotice(
        createdStatus === "SCHEDULED"
          ? pending.payload.simulate === true
            ? "모의 예약을 등록했습니다. 예약 시각 이후 이 화면에서 발송 실행을 눌러야 하며, 실행해도 수신자에게 전달되지 않습니다."
            : `예약 등록했습니다. ${scheduleModeNotice(created.scheduleMode === "AUTO" ? "AUTO" : "MANUAL")}`
          : createdStatus === "SIMULATED"
            ? "모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다."
            : "발송 요청을 기록했습니다. 결과는 아래 발송 기록에서 확인하세요."
      );
      setCampaignDraft(EMPTY_CAMPAIGN);
      setSelectedTemplateId("");
      setPendingTemplateUse(null);
      setSelectedIds([]);
      setComposeStep(1);
      setShowSelectedOnly(false);
      setCharsetCandidatesOnly(false);
      // Proven send consumes the reloaded source: its summary must not
      // linger above the next blank composer.
      setReloadSummary(null);
      setScheduleChoice("NOW"); setLoadedPurpose(null); setPendingPurpose(null); setComposeNotice(null);
      // Proven send consumes the draft and returns to the ledger: closing
      // the compose surface reveals the new row below. Failures never
      // reach here — the draft, selection and receipts stay for retry.
      setComposerOpen(false);
      setHistoryQuery("");
      setHistoryStatus("ALL");
      setHistoryLimit(10);
      await refresh(true);
      // The composer closed above, so the ledger is visible again: unfold
      // so the scroll below lands on the new row.
      setHistoryOpen(true);
      window.setTimeout(() => {
        const next = document.querySelector<HTMLAnchorElement>("[data-close-linear-next]");
        if (next) {
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: "center" });
          return;
        }
        // The confirmed submit unmounted with the composer, so land focus
        // on the just-created ledger row (already tabIndex={-1}): keyboard
        // and SR users arrive at the recorded result instead of body text.
        // One frame lets the reopened ledger commit the row first.
        requestAnimationFrame(() => {
          const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
          const row = document.getElementById(`campaign-${pending.id}`);
          if (row) {
            row.focus({ preventScroll: true });
            row.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
            return;
          }
          // The row may be filtered out or not yet rendered — fall back to
          // the visible create control rather than leaving focus hidden.
          const open = document.getElementById("message-compose-open");
          open?.scrollIntoView({ block: "center" });
          open?.focus({ preventScroll: true });
        });
      }, 0);
    } catch (error) {
      if (activeMessageEventRef.current !== pending.eventId) return;
      const status = (error as { status?: unknown }).status;
      if (error instanceof CommandFailure && status === 409 && error.field === "expectedRecipientVersions") {
        // The server checked the same command receipt before this guard.
        // This rejection also settles a previously unconfirmed attempt.
        campaignCreateRef.current = null;
        uncertainCreateRef.current = null;
        setUncertainCreate(null);
        setAbandonCreateConfirm(false);
        setCampaignError(null);
        forgetOperatorReceipt(pending.id);
        requireRecipientReview();
      } else if (!wasUnconfirmed && isOrganizationContextBlock(error)) {
        campaignCreateRef.current = null;
        setCampaignError("현재 조직을 확인한 뒤 다시 시도하세요.");
      } else if (!wasUnconfirmed && error instanceof CommandFailure && typeof status === "number" && !isAmbiguousStatus(status)) {
        // A definitive first response cannot resolve an earlier lost one.
        campaignCreateRef.current = null;
        handleCommandError(error, "campaign");
      } else {
        markUnconfirmed();
      }
    } finally {
      endAction();
    }
  }

  async function checkCampaignCreate() {
    const pending = uncertainCreateRef.current;
    if (!pending || pending.eventId !== activeMessageEventRef.current || !beginAction("campaign-check")) return;
    setCheckingCreate(true);
    setCampaignError(null);
    try {
      const response = await consoleFetch(`/api/events/${encodeURIComponent(pending.eventId)}/command-receipts/${encodeURIComponent(pending.id)}`, { cache: "no-store" });
      const data = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (activeMessageEventRef.current !== pending.eventId) return;
      if (response.ok && data?.status === "APPLIED" && data.command === "message.create-charset-reviewed") {
        setCampaignError("서버에 발송 요청 기록이 있습니다. 같은 요청을 다시 확인해 원래 대상과 내용을 확인하세요.");
      } else {
        setCampaignError(response.ok && data?.status === "UNCONFIRMED"
          ? "아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하세요."
          : "처리 결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인한 뒤 다시 확인하세요.");
      }
    } catch {
      if (activeMessageEventRef.current === pending.eventId) setCampaignError("서버에 연결하지 못했습니다. 발송 요청을 다시 보내지 않았습니다.");
    } finally {
      setCheckingCreate(false);
      endAction();
    }
  }

  async function executeRetry(campaign: Campaign, label: "retry" | "execute") {
    if (inFlightRef.current || otherHistoryReceipt || ambiguousSyncIds.includes(campaign.id) || ambiguousCancelIds.includes(campaign.id)) return;
    const wasUnconfirmed = ambiguousRetryIds.includes(campaign.id);
    // Stored mode, not the composer draft: a simulated reservation must
    // never execute under real-delivery/cost/no-undo wording. Per server
    // truth only SCHEDULED rows can carry simulate=true here (SIMULATED
    // rows are terminal, NEEDS_CONNECTION implies simulate=false).
    const storedSimulate = campaign.simulate === true;
    const payload = { id: campaign.id };
    const fingerprint = fingerprintFor("message.retry-charset-reviewed", payload);
    const id = takeMapCommandId(retryRefs, campaign.id, fingerprint);
    if (!beginAction(`retry:${campaign.id}`)) return;
    setCampaignError(null);
    setCampaignNotice(null);
    try {
      const result = await postCommand("message.retry-charset-reviewed", payload, id);
      const message = asRecord(result.message);
      const status = text(message?.status);
      // The retried campaign echoes its own id; require it so a stray
      // payload can't read as success.
      if (!message || message.id !== campaign.id || !status || result.messageCharsetPolicyVersion !== 1) {
        setAmbiguousRetryIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
        return;
      }
      retryRefs.current.delete(campaign.id);
      setAmbiguousRetryIds((current) => current.filter((item) => item !== campaign.id));
      const submissionUnconfirmed = Boolean(asRecord(message.providerSubmission));
      setCampaignNotice(
        Number(message.recipientChangeCount) > 0
          ? "수신자 정보가 변경되어 발송을 중단했습니다. 발송 기록에서 최신 대상을 다시 검토하세요."
          : storedSimulate
          ? `모의 실행 결과: ${messageStatusLabel(status)}. 수신자에게 전달되지 않았습니다.`
          : submissionUnconfirmed
            ? "공급사 접수 여부를 아직 확인하지 못했습니다. 발송 기록에서 결과를 다시 조회하세요."
            : `재시도 결과: ${messageStatusLabel(status)}.`,
        submissionUnconfirmed ? "warning" : "success"
      );
      // Next-logical focus: park the following history row before the
      // refresh so keyboard operators land on the next review target.
      if (Number(message.recipientChangeCount) > 0) {
        historyActionFocusRef.current = campaign.id;
        setHistoryStatus("ALL");
        setExpandedCampaignId(campaign.id);
      } else if (state.kind === "ready") {
        const at = state.campaigns.findIndex((item) => item.id === campaign.id);
        const next = (at >= 0 ? state.campaigns.slice(at + 1).concat(state.campaigns.slice(0, at)) : state.campaigns)
          .find((item) => item.id !== campaign.id) ?? campaign;
        historyActionFocusRef.current = next.id;
      } else {
        historyActionFocusRef.current = campaign.id;
      }
      await refresh(true);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (error instanceof CommandFailure && status === 409 && error.field === "recipientChange") {
        retryRefs.current.delete(campaign.id);
        setAmbiguousRetryIds((current) => current.filter((item) => item !== campaign.id));
        setCampaignError(error.message);
        setExpandedCampaignId(campaign.id);
        historyActionFocusRef.current = campaign.id;
        await refresh(true);
      } else if (wasUnconfirmed || typeof status === "number" && isAmbiguousStatus(status)) {
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
    if (inFlightRef.current || otherHistoryReceipt || ambiguousRetryIds.includes(campaign.id) || ambiguousCancelIds.includes(campaign.id)) return;
    const wasUnconfirmed = ambiguousSyncIds.includes(campaign.id);
    const payload = { id: campaign.id };
    const fingerprint = fingerprintFor("message.sync", payload);
    const id = takeMapCommandId(syncRefs, campaign.id, fingerprint);
    if (!beginAction(`sync:${campaign.id}`)) return;
    setCampaignError(null);
    setCampaignNotice(null);
    try {
      const result = await postCommand("message.sync", payload, id);
      const message = asRecord(result.message);
      if (!message || message.id !== campaign.id || typeof message.status !== "string" || !message.status) {
        setAmbiguousSyncIds((current) => [...new Set([...current, campaign.id])]);
        setCampaignError("응답을 확인하지 못했습니다. 내용을 바꾸지 않고 같은 요청으로 다시 시도하세요.");
        return;
      }
      syncRefs.current.delete(campaign.id);
      setAmbiguousSyncIds((current) => current.filter((item) => item !== campaign.id));
      historyActionFocusRef.current = campaign.id;
      if (typeof asRecord(result.sync)?.total !== "number") {
        if (await refresh(true)) {
          setCampaignNotice("발송 기록을 갱신했습니다. 선택한 발송 건의 최신 상태를 확인하세요.");
        }
        return;
      }
      const submissionUnconfirmed = Boolean(asRecord(message.providerSubmission));
      const resultMatchUnconfirmed = Array.isArray(message.deliveries) &&
        message.deliveries.some(delivery => asRecord(delivery)?.resultMatchUnconfirmed === true);
      const awaitingDelivery = message.status === "SENDING";
      setCampaignNotice(
        submissionUnconfirmed
          ? "공급사 접수 여부를 아직 확인하지 못했습니다. 잠시 후 다시 조회하세요."
          : resultMatchUnconfirmed
            ? "일부 수신자의 결과를 구분하지 못했습니다. 발송 상세에서 확인하세요."
            : awaitingDelivery
              ? "아직 전달 결과가 확정되지 않은 수신자가 있습니다. 잠시 후 다시 확인하세요."
              : `발송 결과를 확인했습니다. ${messageStatusLabel(text(message.status))} 상태입니다.`,
        submissionUnconfirmed || resultMatchUnconfirmed || awaitingDelivery ? "warning" : "success"
      );
      await refresh(true);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (error instanceof CommandFailure && error.field === "id" && (status === 404 || status === 409)) {
        syncRefs.current.delete(campaign.id);
        setAmbiguousSyncIds((current) => current.filter((item) => item !== campaign.id));
        abandonOperatorAttempt(id);
        forgetOperatorReceipt(id);
        setCampaignError(error.message);
        await refresh(true);
      } else if (wasUnconfirmed || typeof status === "number" && isAmbiguousStatus(status)) {
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
    if (inFlightRef.current || otherHistoryReceipt || ambiguousRetryIds.includes(campaign.id) || ambiguousSyncIds.includes(campaign.id)) return;
    const wasUnconfirmed = ambiguousCancelIds.includes(campaign.id);
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
        Number(message.recipientChangeCount) > 0
          ? "기존 요청을 취소했습니다. 내용·대상 불러오기로 새 검토를 시작하세요."
          : scheduled
          ? "예약을 취소했습니다. 이후 발송 실행을 할 수 없습니다."
          : "발송 요청을 취소했습니다. 이후 재시도로 발송되지 않습니다."
      );
      if (Number(message.recipientChangeCount) > 0) {
        setAttentionOnly(false);
        setHistoryStatus("ALL");
        historyActionFocusRef.current = campaign.id;
        setExpandedCampaignId(campaign.id);
      } else if (state.kind === "ready") {
        const at = state.campaigns.findIndex((item) => item.id === campaign.id);
        const next = (at >= 0 ? state.campaigns.slice(at + 1).concat(state.campaigns.slice(0, at)) : state.campaigns)
          .find((item) => item.id !== campaign.id) ?? null;
        historyActionFocusRef.current = next ? next.id : campaign.id;
      } else {
        historyActionFocusRef.current = campaign.id;
      }
      await refresh(true);
    } catch (error) {
      const status = (error as { status?: unknown }).status;
      if (wasUnconfirmed || typeof status === "number" && isAmbiguousStatus(status)) {
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

  // Reload terminal records as a new draft. In-flight and partially delivered
  // records cannot use this path because some recipients may already have it.
  function canReloadCampaign(campaign: Campaign) {
    const noAcceptanceTrace = !campaign.submissionUnconfirmed && !campaign.genericSubmissionUnconfirmed &&
      !campaign.deliveryUnconfirmed && !campaign.providerGroupId && (campaign.acceptedCount === null || campaign.acceptedCount === 0);
    const safeCharsetCancellation = campaign.status === "CANCELLED" && campaign.smsTextReloadSafe &&
      (campaign.smsTextProblemCount > 0 || campaign.smsTextProblemUnknown) &&
      noAcceptanceTrace;
    return (campaign.status === "FAILED" && noAcceptanceTrace) || (campaign.status === "CANCELLED" && campaign.recipientChangeCount > 0 && noAcceptanceTrace) || safeCharsetCancellation;
  }

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
      ambiguousCancelIds.length > 0 ||
      otherCreateReceipt || otherHistoryReceipt || uncertainMmsUpload
    );
  }

  // Blocked-reload recovery: the history button that reported the block is
  // far from the composer, so the error text alone strands the operator
  // with no visible reason or next action. Surface the existing
  // campaignError copy, drop any overwrite confirm, then land on the real
  // submit instantly (no auto-submit): the inline error renders immediately
  // after the review bar, so reason and next action stay visible
  // together. Instant only for this discrete error context transfer; the
  // global jump/motion behavior is untouched.
  function reportBlockedReload() {
    setComposeStep(3);
    setComposerOpen(true);
    setHistoryOpen(false);
    setReloadPending(null);
    if (uncertainMmsUpload) {
      window.requestAnimationFrame(() => document.getElementById("mms-upload-recovery-heading")?.focus());
      return;
    }
    setCampaignError("응답을 확인하지 못한 발송 요청이 있습니다. 결과를 먼저 확인한 뒤 내용을 불러오세요.");
    if (uncertainCreateRef.current) {
      // The original create owns a locked form. Land on its usable recovery
      // controls instead of trying to focus the disabled submit button.
      window.requestAnimationFrame(() => {
        const heading = document.getElementById("message-recovery-heading");
        heading?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
        heading?.focus({ preventScroll: true });
      });
      return;
    }
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
    if (!state.canManage || !state.canWriteMessages || state.stage === "ARCHIVED") return;
    if (inFlightRef.current || uploadingImage) return;
    if (failedReloadBlocked()) {
      reportBlockedReload();
      return;
    }
    // Reload from the current history row, not a stale snapshot: a
    // background refresh may have changed or removed it while the confirm
    // stayed open.
    const source = state.campaigns.find((item) => item.id === campaign.id);
    if (!source || !canReloadCampaign(source)) {
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
    let conflictExcluded = 0;
    for (const id of source.recipientIds) {
      if (seen.has(id)) continue;
      seen.add(id);
      const person = byId.get(id);
      if (!person || !recipientEligible(person)) {
        excluded += 1;
        if (person && person.status.toUpperCase() !== "CANCELLED" && person.ticketReview === "cancelled") conflictExcluded += 1;
      }
      else eligible.push(id);
    }
    const allowedChannels = ["SMS", "LMS", "MMS", "ALIMTALK"];
    const storedChannel = allowedChannels.includes(source.channel) ? source.channel : "SMS";
    const channel = textFamilyChannel(storedChannel, source.imageFileId);
    const boundTemplate = source.templateId
      ? state.templates.find((template) => template.id === source.templateId)
      : undefined;
    // Never assume a stale ALIMTALK binding: without a current template
    // carrying a Solapi approval id the composer stays unbound so the
    // existing submit validation asks for a reselection.
    const templateUsable = Boolean(
      boundTemplate && !boundTemplate.archived && (channel !== "ALIMTALK" || (boundTemplate.channel === "ALIMTALK" && boundTemplate.solapiTemplateId && source.body.trim() === boundTemplate.body.trim()))
    );
    const isMms = channel === "MMS";
    setCampaignDraft({
      title: source.title === "제목 없는 발송" ? "" : source.title,
      channel,
      body: source.body,
      // A stale reservation must never replay: the operator re-picks it.
      scheduled: "",
      scheduleMode: "MANUAL",
      simulate: source.simulate === true,
      smsFallback: source.smsFallback,
      imageFileId: isMms ? source.imageFileId : "",
      imageName: isMms ? source.imageName : "",
    });
    setSelectedTemplateId(templateUsable && boundTemplate ? boundTemplate.id : "");
    setPendingTemplateUse(null);
    setSelectedIds(eligible);
    const nextStep = eligible.length && !excluded && !source.recipientChangeCount ? 2 : 1;
    setComposeStep(nextStep);
    setComposerOpen(true);
    setHistoryOpen(false);
    // Reveal the reloaded set for review: clear the search/status filters
    // and turn on the existing selected-only mode. The saved template
    // draft (templateDraft) is intentionally untouched.
    setRecipientQuery("");
    setRecipientStatus("ALL");
    setRecipientGroup("");
    setShowSelectedOnly(eligible.length > 0);
    setCharsetCandidatesOnly(false);
    setRecipientListOpen(true);
    setSendPending(null);
    setHistoryPending(null);
    setReloadPending(null);
    setCampaignFieldError(null);
    setCampaignError(null);
    const sourceLabel = `〈${source.title}〉`;
    const reservationLine = source.scheduled ? " 예약 시각은 다시 지정하세요." : "";
    const exclusionLine = conflictExcluded ? ` · 제외 ${excluded}명(취소·삭제·상태 확인 필요)` : excluded ? ` · 제외 ${excluded}명(취소·삭제)` : "";
    const missingPhotoLine = storedChannel === "MMS" && !source.imageFileId ? " 기존 사진이 없어 일반 문자로 불러왔습니다. 사진 문자가 필요하면 사진을 다시 첨부하세요." : "";
    const reselectLine = channel === "ALIMTALK" && !templateUsable
      ? " 승인된 알림톡 템플릿을 다시 선택하세요."
      : "";
    // The summary lives only in the composer, next to the title — never as
    // a global success notice above the header.
    setCampaignNotice(null);
    if (eligible.length === 0) {
      setReloadSummary(conflictExcluded
        ? `${sourceLabel} 내용을 불러왔습니다 · 선택 가능한 대상이 없습니다 · 제외 ${excluded}명(취소·삭제·상태 확인 필요). 수신자를 새로 선택하세요. 바로 발송되지 않습니다. 새 발송 전 내용·대상을 확인하세요.${reservationLine}${reselectLine}${missingPhotoLine}`
        : `${sourceLabel} 내용을 불러왔습니다 · 선택 가능한 대상이 없습니다 · 제외 ${excluded}명(취소·삭제). 수신자를 새로 선택하세요. 바로 발송되지 않습니다. 새 발송 전 내용·대상을 확인하세요.${reservationLine}${reselectLine}${missingPhotoLine}`
      );
    } else {
      setReloadSummary(
        `${sourceLabel} 내용을 불러왔습니다 · 선택 ${eligible.length}명${exclusionLine}. 바로 발송되지 않습니다. 새 발송 전 내용·대상을 확인하세요.${reservationLine}${reselectLine}${missingPhotoLine}`
      );
    }
    window.setTimeout(() => {
      // Discrete task context transfer: land on the in-form summary
      // instantly (no smooth-scroll race), then focus the title without
      // moving the viewport again.
      document.getElementById("campaign-reload-summary")?.scrollIntoView({ behavior: "instant" as ScrollBehavior, block: "start" });
      document.getElementById(nextStep === 1 ? "recipient-search" : "campaign-title")?.focus({ preventScroll: true });
    }, 0);
  }

  function requestFailedReload(campaign: Campaign) {
    if (inFlightRef.current || uploadingImage) return;
    if (state.kind !== "ready" || !state.canManage || !state.canWriteMessages || state.stage === "ARCHIVED") return;
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

  if (state.kind === "loading" || (state.kind === "ready" && loadedMessageEventRef.current !== eventId)) {
    return (
      <ConsolePage pageId="messages" eventId={eventId}>
        <ConsoleStatePanel
          kind="loading" shape="list"
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
  // 미리 잠그고 이유를 밝힌다. messages 스코프가 없는 멤버십도 읽기 전용
  // 취급하며, 조회·기록 확인·내보내기는 그대로 둔다.
  const archived = state.stage === "ARCHIVED";
  const archivedReason = "보관된 행사는 읽기 전용입니다";
  const messagesLocked = archived || !state.canWriteMessages;
  const compositionPending = Boolean(uncertainCreate) || busyAction === "campaign" || busyAction === "recipient-review" || checkingCreate || uncertainMmsUpload;
  const reviewRecipientsCurrent = !sendPending || recipientVersionsMatch(sendPending, state.participants);
  // React state updates replace the draft and selection, so even editing and
  // then reverting to identical text cannot resurrect an old confirmation.
  const reviewIsCurrent = sendPending !== null &&
    sendPending.reviewedDraft === campaignDraft &&
    sendPending.reviewedIds === selectedIds &&
    sendPending.reviewedTemplateId === selectedTemplateId &&
    sendPending.reviewedAttachmentRevision === attachmentRevision &&
    reviewRecipientsCurrent &&
    !messagesLocked && !uploadingImage && !uncertainMmsUpload;
  const messagesLockReason = archived ? archivedReason : "메시지 쓰기 권한이 없습니다. 기록은 볼 수 있습니다";
  const activeTemplates = state.templates.filter(template => !template.archived);
  const templateSearch = templateQuery.trim().normalize("NFKC").toLocaleLowerCase("ko-KR");
  const visibleTemplates = state.templates.filter(template =>
    (templateScope === "ALL" || (templateScope === "ARCHIVED" ? template.archived : !template.archived)) &&
    (!templateSearch || `${template.name} ${template.body}`.normalize("NFKC").toLocaleLowerCase("ko-KR").includes(templateSearch)));
  const activeParticipants = state.participants.filter(recipientEligible);
  const conflictingRecipients = state.participants.filter(person => person.status.toUpperCase() !== "CANCELLED" && person.ticketReview === "cancelled").length;
  const statusFiltered = recipientStatus === "ALL"
    ? activeParticipants
    : activeParticipants.filter((person) => person.status === recipientStatus);
  const recipientGroups = [...new Set(activeParticipants.map(person => person.group || "일반"))].sort((a, b) => a.localeCompare(b, "ko-KR"));
  const groupFiltered = recipientGroup ? statusFiltered.filter(person => person.group === recipientGroup) : statusFiltered;
  const recipientSearch = recipientQuery.trim().toLocaleLowerCase("ko-KR");
  const searchedRecipients = !recipientSearch
    ? groupFiltered
    : groupFiltered.filter((person) =>
        `${person.name} ${person.company} ${person.group} ${person.phone}`.toLocaleLowerCase("ko-KR").includes(recipientSearch)
      );
  // 선택 대상만 보기는 상태·그룹·검색 필터를 우회하는 전체 선택 검토 모드다:
  // 체크하는 동안 목록에는 선택된 전원이 뜨고, 필터 입력은 그대로 둔다.
  const selectedSet = new Set(selectedIds);
  const charsetCheckEnabled = state.integrations.provider === "solapi" && !campaignDraft.simulate &&
    (campaignDraft.channel !== "ALIMTALK" || campaignDraft.smsFallback);
  const charsetCandidateIds = new Set(charsetCheckEnabled && campaignDraft.body.includes("{{이름}}")
    ? activeParticipants.filter(person => selectedSet.has(person.id) && findSmsTextIssue(person.name)).map(person => person.id) : []);
  const eventNameCharsetIssue = charsetCheckEnabled && campaignDraft.body.includes("{{행사명}}") && Boolean(findSmsTextIssue(state.eventName));
  const visibleRecipients = charsetCandidatesOnly
    ? activeParticipants.filter(person => charsetCandidateIds.has(person.id))
    : showSelectedOnly
    ? activeParticipants.filter((person) => selectedSet.has(person.id))
    : searchedRecipients;
  const selectedCount = selectedIds.length;
  const selectedPeople = activeParticipants.filter((person) => selectedSet.has(person.id));
  const ticketLinkInvalidCount = campaignDraft.body.includes("{{티켓링크}}")
    ? selectedPeople.filter(person => person.ticketReview !== "valid").length + selectedCount - selectedPeople.length : 0;
  const visibleSelectedCount = visibleRecipients.filter((person) => selectedSet.has(person.id)).length;
  const outsideVisibleCount = selectedCount - visibleSelectedCount;
  const selectedApproved = selectedPeople.filter((person) => person.status === "APPROVED").length;
  const selectedPending = selectedPeople.filter((person) => person.status === "PENDING").length;
  const selectedWaitlist = selectedPeople.filter((person) => person.status === "WAITLIST").length;
  const selectedMissing = selectedCount - selectedPeople.length;
  const pendingRiskCount = selectedPending + selectedWaitlist;
  const bodyMeasure = measureMessage(campaignDraft.body);
  const contentIssue = messageContentIssue(campaignDraft, state.templates.find(item => item.id === selectedTemplateId));
  const charsetIssue = campaignCharsetIssue(campaignDraft, state.integrations.provider);

  // Bulk select for the visible (filtered) set only: checking adds the
  // visible recipients without touching other views (union, never replace),
  // unchecking removes only the visible ones. The separate full clear below
  // stays explicit. Same three operations as before, one native control.
  const allVisibleSelected = visibleRecipients.length > 0 && visibleSelectedCount === visibleRecipients.length;
  const someVisibleSelected = visibleSelectedCount > 0 && !allVisibleSelected;
  // Subscribe this render to the 30s clock so a due reservation flips to
  // 발송 실행 while the page stays open. The shared helper owns the
  // overdue definition; ?attention=1 includes overdue SCHEDULED.
  // New-org simulation-only composer: a fresh org never inherits the
  // deployment provider. Distinct from process health and from a legacy
  // org's real NEEDS_CONNECTION attempt path.
  void nowTick;
  const nowMs = messageNow();
  const newOrgSimOnly = state.kind === "ready" && isNewOrgSimOnly(state.integrations);
  const blockedById = new Map(state.messageSchedule?.blocked.map(item => [item.id, item]));
  const attentionCampaigns = state.campaigns.filter((campaign) => needsAttention(campaign, nowMs) || blockedById.has(campaign.id));
  const scheduledCount = state.campaigns.filter((campaign) => campaign.status === "SCHEDULED").length;
  const overdueCampaigns = state.campaigns.filter((campaign) => isOverdue(campaign, nowMs));
  const historyScope = attentionOnly ? attentionCampaigns : state.campaigns;
  const historySearch = historyQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleCampaigns = historyScope.filter((campaign) =>
    (historyStatus === "ALL" || campaign.status === historyStatus) &&
    (!historySearch || campaign.title.toLocaleLowerCase("ko-KR").includes(historySearch))
  );
  // Long history reveals incrementally: first 10, then 10 per click. Filters,
  // refresh, retry/sync/cancel and the attention deep link keep their semantics.
  const shownCampaigns = visibleCampaigns.slice(0, historyLimit);
  const remainingCampaigns = visibleCampaigns.length - shownCampaigns.length;
  const scheduledDraft = Boolean(campaignDraft.scheduled);
  const simulateDraft = campaignDraft.simulate === true;
  // Scheduled-first, mirroring server precedence: a scheduled draft is a
  // reservation even when the simulate box is checked.
  const submitModeLabel = scheduleBadInput ? "예약 날짜·시간 확인 필요" : scheduledDraft
    ? simulateDraft
      ? "모의 예약·수동 실행·전달 없음"
      : campaignDraft.scheduleMode === "AUTO" ? "예약 등록·자동 실행" : "예약 등록·수동 실행"
    : simulateDraft
      ? "모의 발송(전달 없음)"
      : "실제 발송 시도";
  const eventDateKnown = Boolean(eventRelativeSchedule(state.eventDate, { days: 0, time: "09:00" }));
  const effectiveScheduleChoice: "NOW" | "EVENT" | "DATE" = scheduleChoice === "EVENT" && eventDateKnown ? "EVENT"
    : campaignDraft.scheduled || scheduleBadInput || scheduleChoice !== "NOW" ? "DATE" : "NOW";
  const autoTitlePreview = autoCampaignTitle(loadedPurpose?.label ?? "", campaignDraft.scheduled, koreaToday());
  const audiencePresets = ([
    { key: "approved", label: "참가 확정 전원", hint: "가장 많이 쓰는 대상" },
    { key: "not-entered", label: "확정자 중 아직 입장 안 함", hint: "입장 기록이 확인된 사람만 셉니다" },
    { key: "pending", label: "승인 대기", hint: "승인 전 안내" },
  ] as const).map(preset => {
    const ids = audienceIds(preset.key);
    return { ...preset, count: ids.length, active: chosenPreset === preset.key && ids.length > 0 && ids.length === selectedCount && ids.every(id => selectedSet.has(id)) };
  });
  const scheduleSummary = scheduleBadInput ? "날짜·시각 확인 필요" : campaignDraft.scheduled
    ? `예약 ${formatScheduledInput(campaignDraft.scheduled).replace(" (한국 시간)", "")}` : effectiveScheduleChoice === "NOW" ? "지금 바로" : "시각을 정하세요";
  const checklistItems = [
    { key: "recipients", step: 1 as const, target: "campaign-recipients", label: "받는 사람", done: selectedCount > 0, summary: selectedCount > 0 ? `${selectedCount}명${pendingRiskCount ? ` · 대기 ${pendingRiskCount}명 포함` : ""}` : "아직 0명" },
    { key: "content", step: 2 as const, target: "campaign-content", label: "내용", done: Boolean(campaignDraft.body.trim()) && !contentIssue, summary: campaignDraft.body.trim() ? `${familyLabel(campaignDraft.channel)}${loadedPurpose && campaignDraft.body === loadedPurpose.body ? ` · ${loadedPurpose.label}` : ""}${contentIssue ? " · 확인 필요" : ""}` : "작성 전" },
    { key: "schedule", step: 2 as const, target: "campaign-schedule", label: "보낼 때", done: !scheduleBadInput && (effectiveScheduleChoice === "NOW" || Boolean(campaignDraft.scheduled)), summary: `${scheduleSummary}${simulateDraft ? " · 모의" : ""}` },
    { key: "review", step: 3 as const, target: "campaign-review-heading", label: "검토·발송", done: false, summary: selectedCount > 0 && campaignDraft.body.trim() ? "검토할 수 있음" : "앞 항목을 채우세요" },
  ];
  const checklistActive = composeStep === 1 ? 0 : composeStep === 2 ? 1 : 3;

  function revealComposer() {
    if (messagesLocked && !composeDirty && !uncertainCreate) return;
    if (messagesLocked) {
      setComposeStep(2); setShowSelectedOnly(true); setRecipientListOpen(true);
      window.requestAnimationFrame(() => {
        const heading = document.getElementById("campaign-heading");
        heading?.setAttribute("tabindex", "-1"); heading?.focus({ preventScroll: true });
      });
    }
    setHistoryOpen(false);
    if (composerOpen) {
      document.getElementById("campaign-heading")?.scrollIntoView({ block: "start" });
      document.getElementById(composeFocusId(composeStep))?.focus({ preventScroll: true });
      return;
    }
    focusComposerOnOpenRef.current = true;
    setComposerOpen(true);
  }

  return (
    <ConsolePage
      pageId="messages"
      className={styles.workbenchPage}
      closeSnapshot={state.closeSnapshot}
      closeNoticeStatus={closeNoticeStatus}
      closeArchiveOpen={archiveConfirm}
      closeArchiveControl={state.canManage && state.canArchive && state.stage === "ENDED" && state.closeSnapshot.archiveAvailable && !state.closeSnapshot.registrationOpen && state.closeSnapshot.openModules.length === 0 ? (
        <div className={styles.closeArchive}>
          {archiveConfirm ? <StageTransitionConfirmation label="보관" busy={busyAction === "archive"} disabled={busyAction !== null} cancelDisabled={busyAction !== null} retry={archiveUnresolved}
            onConfirm={() => void archiveFromCloseFlow()}
            onCancel={() => {
              if (inFlightRef.current || archiveUnresolved && !confirmLeaveForArchive()) return;
              setArchiveConfirm(false);
              requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-close-inline-archive]")?.focus());
            }}>
            <p>보관 후에는 메시지를 포함한 모든 쓰기가 잠깁니다. 작성 중이거나 예약·연결 대기인 안내도 더 실행할 수 없으므로 대상·내용·발송 결과를 먼저 확인하세요.</p>
          </StageTransitionConfirmation> : <ProductButton type="button" variant="secondary" data-close-inline-archive data-close-linear-next
            disabled={busyAction !== null}
            onClick={() => {
              if (inFlightRef.current || !confirmLeaveForArchive()) return;
              setArchiveError(null);
              setArchiveConfirm(true);
            }}>다음: 보관</ProductButton>}
        </div>
      ) : undefined}
      eventId={eventId}
      eventName={state.eventName}
      meta={formatConsoleEventMeta(state.eventMeta)}
      headerActions={(
        <ProductLink
          className={styles.inkLink}
          variant="ghost"
          href={`/console/events/${encodeURIComponent(eventId)}/participants`}
        >
          참가자 명단
        </ProductLink>
      )}
      feedback={(
        <>
          {archiveError ? <ConsoleFeedback kind="error">{archiveError}</ConsoleFeedback> : null}
          {archiveNotice && !archived ? <ConsoleFeedback kind="success">{archiveNotice}</ConsoleFeedback> : null}
          {archived ? (
            <ConsoleFeedback kind={archiveNotice ? "success" : "info"}>
              {archiveNotice ? `${archiveNotice} ` : ""}보관된 행사는 읽기 전용입니다. 발송 기록은 볼 수 있지만 새로 발송·예약·취소할 수 없습니다.
            </ConsoleFeedback>
          ) : null}
          {state.canManage && !state.canWriteMessages && !archived ? (
            <ConsoleFeedback kind="warning">
              이 행사에 대한 메시지 쓰기 권한이 없습니다. 새로 작성·발송·취소할 수 없습니다. 발송 기록과 템플릿 내용은 확인할 수 있습니다.
            </ConsoleFeedback>
          ) : null}
          {state.canManage && !state.canArchive && !archived && state.stage === "ENDED" ? (
            <ConsoleFeedback kind="warning">
              보관(행사 단계 변경) 권한이 없습니다. 마감 보관은 설정 쓰기 권한이 있는 운영자에게 요청하세요.
            </ConsoleFeedback>
          ) : null}
          {handoffNotice ? <ConsoleFeedback kind="info" id="handoff-notice">{handoffNotice}</ConsoleFeedback> : null}
          {campaignNotice && !archived ? <ConsoleFeedback kind={campaignNotice.kind}>{campaignNotice.message}</ConsoleFeedback> : null}
          {campaignError && !composerOpen && !uncertainCreate ? <ConsoleFeedback kind="error">{campaignError}</ConsoleFeedback> : null}
        </>
      )}
    >
          {uncertainCreate ? (
            <section className={styles.sendRecovery} aria-labelledby="message-recovery-heading">
              <h2 id="message-recovery-heading" tabIndex={-1}>발송 요청 확인 필요</h2>
              <p>이미 요청이 기록됐을 수 있습니다. 서버 확인은 메시지를 다시 보내지 않습니다. 같은 요청 재시도는 아직 처리되지 않은 경우 발송을 진행할 수 있습니다.</p>
              {campaignError ? <p className={styles.fieldError} role="alert">{campaignError}</p> : null}
              <div className={styles.sendRecoveryActions}>
                <ProductButton type="button" variant="secondary" disabled={busyAction !== null || checkingCreate || abandonCreateConfirm} onClick={() => void checkCampaignCreate()}>{checkingCreate ? "확인 중…" : "서버 처리 확인"}</ProductButton>
                <ProductButton type="button" variant="secondary" disabled={busyAction !== null || checkingCreate || abandonCreateConfirm || messagesLocked} onClick={() => void executeCampaignCreate(uncertainCreate)}>같은 요청 다시 시도</ProductButton>
                <ProductButton type="button" variant="secondary" disabled={busyAction !== null || checkingCreate || abandonCreateConfirm} onClick={() => setAbandonCreateConfirm(true)}>확인 전 그만두기</ProductButton>
              </div>
              {abandonCreateConfirm ? <ConsoleConfirm
                summary="이전 요청이 이미 발송됐을 수 있습니다. 확인을 그만둬도 요청은 취소되지 않습니다. 발송 기록을 확인하기 전 같은 안내를 다시 보내지 마세요."
                confirmLabel="확인 그만두기"
                onConfirm={() => {
                  const attempt = uncertainCreateRef.current;
                  if (!attempt) return;
                  abandonOperatorAttempt(attempt.id);
                  forgetOperatorReceipt(attempt.id);
                  campaignCreateRef.current = null;
                  uncertainCreateRef.current = null;
                  setUncertainCreate(null);
                  setAbandonCreateConfirm(false);
                  setCampaignError("이전 요청이 발송됐을 수 있습니다. 발송 기록을 확인한 뒤 다시 진행하세요.");
                }}
                onCancel={() => setAbandonCreateConfirm(false)}
              /> : null}
            </section>
          ) : otherCreateReceipt ? (
            <ConsoleFeedback kind="warning">이전에 요청한 발송의 처리 결과를 먼저 확인하세요. 화면 위의 처리 결과 확인에서 서버에 다시 보내지 않고 조회할 수 있습니다.</ConsoleFeedback>
          ) : null}
          {otherHistoryReceipt ? <ConsoleFeedback kind="warning">이전 발송 기록 작업의 처리 결과를 먼저 확인하세요. 화면 위의 처리 결과 확인에서 서버에 다시 보내지 않고 조회할 수 있습니다.</ConsoleFeedback> : null}

      {uncertainMmsUpload ? <section className={styles.sendRecovery} aria-labelledby="mms-upload-recovery-heading">
        <h2 id="mms-upload-recovery-heading" tabIndex={-1}>MMS 사진 확인 필요</h2>
        <p>사진이 이미 올라갔을 수 있습니다. 같은 사진 요청을 다시 시도해 확인하세요. 이 동작은 메시지를 발송하지 않습니다. 선택한 사진은 이 화면에만 유지됩니다.</p>
        {mmsUploadError ? <p className={styles.fieldError} role="alert">{mmsUploadError}</p> : null}
        <div className={styles.sendRecoveryActions}>
          <ProductButton type="button" variant="secondary" disabled={uploadingImage || busyAction !== null || messagesLocked || abandonMmsUploadConfirm} onClick={() => { const attempt = mmsUploadRef.current; if (attempt) void uploadMmsImage(attempt.file); }}>같은 사진 요청 다시 시도</ProductButton>
          <ProductButton type="button" variant="secondary" disabled={uploadingImage || busyAction !== null || abandonMmsUploadConfirm} onClick={() => setAbandonMmsUploadConfirm(true)}>확인 전 그만두기</ProductButton>
        </div>
        {abandonMmsUploadConfirm ? <ConsoleConfirm
          summary="확인을 그만둬도 이미 업로드된 사진이 서버에 남을 수 있습니다. 발송할 사진을 다시 선택해야 합니다. 그만둘까요?"
          confirmLabel="확인 그만두기"
          onConfirm={() => {
            mmsUploadRef.current = null;
            setUncertainMmsUpload(false);
            setMmsUploadError(null);
            setAbandonMmsUploadConfirm(false);
            setCampaignDraft((current) => ({ ...current, imageFileId: "", imageName: "" }));
            setCampaignFieldError({ field: "imageFileId", message: "발송할 사진을 다시 선택하세요." });
          }}
          onCancel={() => setAbandonMmsUploadConfirm(false)}
        /> : null}
      </section> : null}
      {!state.canManage ? (
        <ConsoleFeedback kind="error">메시지 발송을 관리할 운영 권한이 없습니다.</ConsoleFeedback>
      ) : (
        <>
          <details className={`${styles.templateDetails} ${styles.connectionDetails} ${state.integrations.connected ? styles.connectionOk : newOrgSimOnly ? styles.connectionSim : styles.connectionOff}`}>
            <summary data-disclosure-indicator="">발송 연결 · {state.integrations.connected ? "연결됨" : "미연동 · 실제 전달 안 됨"}</summary>
            <p className={styles.help}>
              발송 상태는 공급사 응답을 기준으로 표시합니다.{" "}
              {state.integrations.connected
                ? `현재 조직 발송 연결: 발신 ${state.integrations.sender || "설정됨"}${state.integrations.provider ? ` (${state.integrations.provider})` : ""}. 모의 발송은 전달되지 않습니다.`
                : newOrgSimOnly
                  ? "현재 조직 발송 연결: 새 운영사에는 발송 수단이 없으므로 모의 기록만 남습니다. 실제 발송으로 자동 전환되지 않습니다."
                  : "현재 조직 발송 연결: 공급사가 연결되지 않았습니다. 요청은 연결 필요 상태로 기록됩니다(모의 기록이 아닙니다). 실제로 전달되지 않습니다."}
            </p>
            <p className={styles.help}>{scheduleServerStatus(state.messageSchedule)} 현재 서버 기준이며 점검 완료가 실제 발송이나 수신을 뜻하지 않습니다.</p>
          </details>


          <MessageWorkbench composerOpen={composerOpen} templateAttention={Boolean(pendingTemplate)} composer={(
          <div id="message-composer" hidden={!composerOpen}>
          <ConsoleSection
            headingId="campaign-heading"
              title={messagesLocked ? "작성 내용 확인" : "메시지 작성"}
              surface="plain"
              className={styles.composeSection}
              action={<div className={styles.composeReturn}><ProductButton id="message-compose-close" type="button" variant="ghost" aria-describedby="compose-return-help" disabled={busyAction !== null || uploadingImage} onClick={() => {
                focusHistoryOnCloseRef.current = true;
                setComposerOpen(false);
                setHistoryOpen(true);
                requestConsoleTask("history-heading");
                window.history.replaceState(window.history.state, "", "#history-heading");
              }}>발송 기록 보기</ProductButton><small id="compose-return-help">입력·선택 유지</small></div>}
            >
              <ValidatedForm className={uiStyles.formStack} onSubmit={requestCampaignCreate}>
                {/* Reopened 2026-11-23: a checklist of the four zones replaces the 3-step tabs.
                    Each item says what is filled; nothing is hidden or gated. */}
                <nav className={styles.composeChecklist} aria-label="메시지 작성 항목">
                  <ol>
                    {checklistItems.map((item, index) => <li key={item.key} data-done={item.done ? "true" : undefined}>
                      <a href={`#${item.target}`} aria-current={composeStep === item.step && index === checklistActive ? "true" : undefined} onClick={(event) => { event.preventDefault(); if (item.key === "schedule") { setComposeStep(2); document.getElementById("campaign-schedule")?.scrollIntoView({ block: "start" }); document.getElementById("campaign-schedule-heading")?.focus({ preventScroll: true }); } else goComposeStep(item.step); }}>
                        <span className={styles.checkMark} aria-hidden="true">{item.done ? "✓" : index + 1}</span>
                        <span><strong>{item.label}</strong><small>{item.summary}</small></span>
                      </a>
                    </li>)}
                  </ol>
                </nav>
                {composeNotice ? <p className={styles.composeNotice} role="status">{composeNotice}</p> : null}
                <fieldset className={styles.composeLock} disabled={messagesLocked || compositionPending}>
                <legend className="sr-only">발송 내용과 수신자</legend>

                <a
                  className="skip-link"
                  href="#campaign-body"
                  data-skip-to="campaign-body"
                  onClick={(event) => {
                    event.preventDefault();
                    goComposeStep(2);
                  }}
                >
                  메시지 작성으로 건너뛰기
                </a>
                <div className={styles.composeGrid} data-layout="checklist">
                  <fieldset id="campaign-recipients" className={styles.recipientFieldset} aria-describedby={campaignFieldError?.field === "ids" ? "campaign-recipients-error" : "recipient-summary"}>
                    <legend className="sr-only">받는 사람</legend>
                    <h3 className={styles.zoneHead} id="recipient-heading" tabIndex={-1}><span aria-hidden="true">1</span>받는 사람</h3>
                    {reloadSummary ? (
                      <ConsoleFeedback kind="info" id="campaign-reload-summary">{reloadSummary}</ConsoleFeedback>
                    ) : null}
                    <div className={styles.audiencePresets} role="group" aria-label="받는 사람 묶음">
                      {audiencePresets.map(preset => <button key={preset.key} type="button" id={`recipient-preset-${preset.key}`} className={styles.audienceCard} aria-pressed={preset.active} disabled={preset.count === 0 || messagesLocked} onClick={() => selectAudience(preset.key, preset.label)}>
                        <span><strong>{preset.label}</strong><small>{preset.hint}</small></span>
                        <b>{preset.count}</b>
                      </button>)}
                    </div>
                    <p className={styles.selectionSummary} id="recipient-summary" role="status" data-empty={selectedCount === 0 ? "true" : undefined}>
                      <strong className={styles.selectionCount}>선택 {selectedCount}명</strong>
                      {selectedApproved > 0 ? <> · 확정 {selectedApproved}명</> : null}
                      {selectedPending > 0 ? <> · 승인 대기 {selectedPending}명</> : null}
                      {selectedWaitlist > 0 ? <> · 대기 명단 {selectedWaitlist}명</> : null}
                      {selectedMissing > 0 ? ` · 목록 제외 ${selectedMissing}명` : ""}
                      {outsideVisibleCount > 0 ? ` · 화면 밖 선택 ${outsideVisibleCount}명 유지 중` : ""}
                    </p>
                    {conflictingRecipients > 0 ? <p className={styles.help} role="note">
                      신청 상태와 취소 기록이 일치하지 않는 {conflictingRecipients}명은 수신 대상에서 제외했습니다. {" "}
                      <ProductLink className={styles.inkLink} variant="ghost" href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>참가자 명단에서 확인</ProductLink>
                    </p> : null}
                    {recipientReviewRequired ? (
                      <div className={uiStyles.formStack}>
                        <ConsoleFeedback kind="warning" id="campaign-recipients-error">{campaignFieldError?.message ?? "최신 목록을 불러와 발송 대상을 다시 확인하세요."}</ConsoleFeedback>
                        <div><ProductButton id="recipient-review-refresh" type="button" variant="secondary" onClick={() => void reloadReviewedRecipients()}>
                          {busyAction === "recipient-review" ? "수신자 불러오는 중" : "최신 수신자 불러오기"}
                        </ProductButton></div>
                      </div>
                    ) : null}
                    {pendingRiskCount > 0 ? (
                      <p className={styles.riskWarning} id="recipient-risk-warning" role="alert">
                        선택 대상 중 승인 대기·대기 명단이 {pendingRiskCount}명 있습니다. 발송 전에 대상을 다시 확인하세요.
                      </p>
                    ) : null}
                    <div className={styles.recipientTopBar}>
                    <ProductButton
                      type="button"
                      className={styles.textButton} variant="ghost"
                      disabled={recipientReviewRequired}
                      data-skip-to="campaign-title"
                      onClick={jumpToCampaignTitle} icon={<PencilIcon />}
                    >

                      내용 작성으로 계속
                    </ProductButton>
                    <ProductButton type="button" id="campaign-send-skip" data-skip-to="campaign-submit" className={styles.textButton} variant="ghost" aria-describedby="campaign-submit-warning" disabled={recipientReviewRequired} onClick={jumpToCampaignSubmit} icon={<ArrowDownIcon />}>
                      발송 검토로 이동
                    </ProductButton>
                    </div>
                    <details
                      className={styles.recipientDetails}
                      open={recipientListOpen}
                      onToggle={(event) => setRecipientListOpen((event.target as HTMLDetailsElement).open)}
                      onKeyDown={(event) => {
                        if (event.key === "Escape" && event.currentTarget.open) {
                          event.preventDefault();
                          event.stopPropagation();
                          const summary = event.currentTarget.querySelector<HTMLElement>("summary");
                          setRecipientListOpen(false);
                          summary?.focus();
                          // Closing a long list can shift the page after focus
                          // lands. Follow the focused summary after the DOM
                          // update, but never steal focus if the user moved on.
                          requestAnimationFrame(() => {
                            if (summary && document.activeElement === summary) summary.scrollIntoView({ block: "center", behavior: "instant" });
                          });
                        }
                      }}
                    >
                      <summary id="recipient-list-summary" className={styles.recipientSummaryButton} aria-describedby={recipientListOpen ? "recipient-list-keyboard-help" : undefined}>
                        <span className={styles.recipientSummaryLabel}>{recipientListOpen ? "직접 고르기 · 목록 닫기" : "직접 고르기 · 상태·그룹·이름으로 한 명씩"}</span>
                        <span className={styles.recipientSummaryCount}>
                          {recipientSearch || showSelectedOnly || recipientStatus !== "ALL" || recipientGroup
                            ? `표시 ${visibleRecipients.length}명`
                            : `발송 가능 ${activeParticipants.length}명`}
                        </span>
                      </summary>
                      <p className={styles.help} id="recipient-list-keyboard-help">Esc를 누르면 선택은 유지하고 목록을 닫습니다.</p>
                      <div className={styles.recipientFilters}>
                        <div>
                          <label htmlFor="recipient-status-filter">수신자 상태</label>
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
                        <div>
                          <label htmlFor="recipient-group-filter">수신자 그룹</label>
                          <select id="recipient-group-filter" value={recipientGroup} onChange={event => setRecipientGroup(event.target.value)}>
                            <option value="">전체 그룹</option>
                            {recipientGroups.map(group => <option key={group} value={group}>{group}</option>)}
                          </select>
                        </div>
                        <div className={styles.recipientSearch}>
                          <label htmlFor="recipient-search">
                            <span className="sr-only">수신자 이름·소속·연락처 검색</span>
                          </label>
                          <input
                            id="recipient-search"
                            type="search"
                            placeholder="수신자 이름·소속·연락처 검색"
                            value={recipientQuery}
                            onChange={(event) => setRecipientQuery(event.target.value)}
                          />
                        </div>
                      </div>
                      <div className={styles.recipientTools}>
                        <label className={styles.selectAllOption}>
                          <input
                            type="checkbox"
                            checked={allVisibleSelected}
                            disabled={visibleRecipients.length === 0}
                            ref={(node) => { if (node) node.indeterminate = someVisibleSelected; }}
                            onChange={(event) => setAllRecipients(event.target.checked, visibleRecipients)}
                          />
                          표시 {visibleRecipients.length}명 모두 선택
                        </label>
                        <ProductButton type="button" className={styles.textButton} variant="ghost" id="recipient-clear-all" onClick={clearAllRecipients} icon={<XIcon />}>전체 선택 해제</ProductButton>
                      </div>
                    <label className={styles.selectedOnlyOption}>
                      <input
                        id="recipient-selected-only"
                        type="checkbox"
                        checked={showSelectedOnly}
                        aria-describedby={showSelectedOnly ? "recipient-selected-help" : undefined}
                        onChange={(event) => { setShowSelectedOnly(event.target.checked); if (event.target.checked) setCharsetCandidatesOnly(false); }}
                      />
                      선택 대상만 보기
                    </label>
                    {showSelectedOnly ? <p className={styles.help} id="recipient-selected-help">상태·그룹·검색 조건에 관계없이 선택한 {selectedCount}명 전체를 표시합니다. 조건으로 찾으려면 선택 대상만 보기를 끄세요.</p> : null}
                    {charsetCandidatesOnly ? <p className={styles.help} role="status">현재 선택한 참가자 중 이름에 확인이 필요한 {charsetCandidateIds.size}명을 표시합니다. <ProductButton id="recipient-charset-reset" type="button" className={styles.textButton} variant="ghost" onClick={() => setCharsetCandidatesOnly(false)}>전체 명단으로</ProductButton></p> : null}
                    {visibleRecipients.length ? (
                      <ul className={styles.recipientList} aria-label="참가자 선택">
                        {visibleRecipients.map((person) => (
                          <li key={person.id}>
                            <label className={styles.recipientRow}>
                              <input
                                type="checkbox"
                                checked={selectedSet.has(person.id)}
                                onChange={() => toggleRecipient(person.id)}
                              />
                              <span className={styles.recipientName}>{person.name}</span><ConsoleAvatar className={styles.recipientAvatar} name={person.name} tone={person.status === "APPROVED" ? "ok" : person.status === "PENDING" ? "wait" : person.status === "WAITLIST" ? "info" : "neutral"} />
                              <span className={styles.recipientMeta} data-recipient-meta>
                                {person.company ? `${person.company} · ` : ""}{person.group} · {maskPhone(person.phone)} · {participantStatusLabel(person.status)}
                              </span>
                            </label>
                          </li>
                        ))}
                      </ul>
                    ) : showSelectedOnly ? (
                      <ConsoleEmptyState kind="filtered" title="선택한 대상이 없습니다." />
                    ) : activeParticipants.length ? (
                      <ConsoleEmptyState kind="filtered" title="조건에 맞는 수신자가 없습니다." />
                    ) : (
                      <ConsoleEmptyState title="등록된 참가자가 없습니다." />
                    )}
                    </details>
                    {campaignFieldError?.field === "ids" && !recipientReviewRequired ? <p className={styles.fieldError} id="campaign-recipients-error" role="alert">{campaignFieldError.message}</p> : null}
                  </fieldset>

                  <div className={`${uiStyles.formStack} ${styles.composeDraft}`}>
                    <div className={styles.contentFields}>
                    <h3 className={styles.zoneHead} id="campaign-content" tabIndex={-1}><span aria-hidden="true">2</span>내용</h3>
                <div className={uiStyles.formStack}>
                  <div className={styles.purposeLoader} role="group" aria-labelledby="campaign-purpose-label">
                    <p id="campaign-purpose-label" className={styles.purposeLabel}>목적으로 불러오기</p>
                    <div className={styles.purposeChips}>
                      {PURPOSE_TEMPLATES.map(purpose => <button key={purpose.key} type="button" className={styles.purposeChip} aria-pressed={loadedPurpose?.key === purpose.key && campaignDraft.body === purpose.body} disabled={messagesLocked} title={purpose.hint} onClick={() => requestPurpose(purpose)}>
                        <strong>{purpose.label}</strong><small>{purpose.hint}</small>
                      </button>)}
                    </div>
                    {pendingPurpose ? <ConsoleConfirm
                      summary={confirmLines(`〈${pendingPurpose.label}〉 문구로 작성 내용을 바꿀까요?\n\n현재 문구가 교체됩니다. 이미 고른 받는 사람과 예약은 유지되며 발송되지는 않습니다.`)}
                      confirmLabel="문구 바꾸기" cancelLabel="현재 내용 유지"
                      busy={busyAction !== null || uncertainMmsUpload || Boolean(uncertainCreate)}
                      onConfirm={() => applyPurpose(pendingPurpose)} onCancel={() => setPendingPurpose(null)} /> : null}
                  </div>
                  <div>
                    <div className={styles.templatePickerLabel}><label htmlFor="campaign-template">저장한 템플릿</label><ProductButton type="button" className={styles.textButton} variant="ghost" disabled={busyAction !== null || uploadingImage} onClick={openTemplateManager}>템플릿 관리</ProductButton></div>
                    <select
                      id="campaign-template"
                      value={selectedTemplateId}
                      aria-invalid={campaignFieldError?.field === "templateId"}
                      aria-describedby={campaignFieldError?.field === "templateId" ? "campaign-template-error" : undefined}
                      onChange={(event) => {
                        const template = state.templates.find((item) => item.id === event.target.value);
                        if (template) useTemplate(template);
                        else { setSelectedTemplateId(""); setPendingTemplateUse(null); }
                      }}
                    >
                      <option value="">{campaignDraft.channel === "ALIMTALK" ? "승인 템플릿 선택" : "직접 작성"}</option>
                      {state.templates.filter(template => !template.archived || template.id === selectedTemplateId).map((template) => (
                        <option value={template.id} key={template.id}>
                          {template.name} · {template.archived ? "보관됨 · 다시 선택하세요" : familyLabel(template.channel)}
                        </option>
                      ))}
                    </select>
                    {campaignFieldError?.field === "templateId" ? <p className={styles.fieldError} id="campaign-template-error" role="alert">{campaignFieldError.message}</p> : null}
                    {pendingTemplateUse ? <ConsoleConfirm
                      summary={confirmLines(`〈${pendingTemplateUse.name}〉 문구로 작성 내용을 바꿀까요?\n\n현재 문구가 교체됩니다. 수신자·제목·사진은 유지되며 발송되지는 않습니다.`)}
                      confirmLabel="템플릿 적용" cancelLabel="현재 내용 유지"
                      busy={busyAction !== null || uncertainMmsUpload || Boolean(uncertainCreate)}
                      onConfirm={() => {
                        const latest = state.templates.find(item => item.id === pendingTemplateUse.id);
                        if (!latest || latest.archived || latest.body !== pendingTemplateUse.body || latest.channel !== pendingTemplateUse.channel || latest.solapiTemplateId !== pendingTemplateUse.solapiTemplateId) {
                          setPendingTemplateUse(null); setCampaignError("템플릿이 변경됐습니다. 최신 템플릿을 다시 선택하세요."); return;
                        }
                        applyTemplate(pendingTemplateUse);
                      }} onCancel={() => setPendingTemplateUse(null)} /> : null}
                  </div>
                  <div>
                    <ConsoleChoiceGroup layout="compare" id="campaign-channel" label="보내는 방법" value={campaignDraft.channel === "ALIMTALK" ? "ALIMTALK" : "SMS"}
                      options={MESSAGE_CHANNEL_CHOICES} invalid={campaignFieldError?.field === "channel"}
                      describedBy={campaignFieldError?.field === "channel" ? "campaign-channel-error" : undefined}
                      onChange={(channel) => {
                        const nextChannel = textFamilyChannel(channel, campaignDraft.imageFileId);
                        setCampaignDraft({ ...campaignDraft, channel: nextChannel });
                        const template = state.templates.find((item) => item.id === selectedTemplateId);
                        if (template && (template.channel === "ALIMTALK") !== (channel === "ALIMTALK")) setSelectedTemplateId("");
                      }} />
                    {campaignFieldError?.field === "channel" ? <p className={styles.fieldError} id="campaign-channel-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                  {campaignDraft.channel === "ALIMTALK" ? <div>
                    <ConsoleChoiceGroup id="campaign-sms-fallback" label="알림톡 미전달 시" value={campaignDraft.smsFallback ? "on" : "off"} disabled={messagesLocked}
                      options={[
                        { value: "on", label: "문자로 대체", description: ALIMTALK_FALLBACK_NOTICE },
                        { value: "off", label: "대체하지 않음", description: ALIMTALK_NO_FALLBACK_NOTICE },
                      ]}
                      invalid={campaignFieldError?.field === "smsFallback"}
                      describedBy={campaignFieldError?.field === "smsFallback" ? "campaign-sms-fallback-error" : undefined}
                      onChange={(value) => { setCampaignDraft({ ...campaignDraft, smsFallback: value === "on" }); setCampaignFieldError(current => current?.field === "smsFallback" ? null : current); }} />
                    {campaignFieldError?.field === "smsFallback" ? <p id="campaign-sms-fallback-error" className={styles.fieldError} role="alert">{campaignFieldError.message}</p> : null}
                  </div> : null}
                </div>

                <div>
                  <label htmlFor="campaign-body">메시지 내용</label>
                  <textarea data-resize-none="true"
                    id="campaign-body"
                    ref={campaignBodyRef}
                    maxLength={2000}
                    rows={5}
                    value={campaignDraft.body}
                    readOnly={campaignDraft.channel === "ALIMTALK"}
                    aria-invalid={campaignFieldError?.field === "body"}
                    aria-describedby={campaignFieldError?.field === "body" ? "campaign-body-error campaign-variables campaign-body-length" : "campaign-variables campaign-body-length"}
                    onChange={(event) => {
                      setCampaignDraft({ ...campaignDraft, body: event.target.value });
                      setCampaignFieldError(current => current?.field === "body" ? null : current);
                    }}
                  />
                  {campaignFieldError?.field === "body" ? <p className={styles.fieldError} id="campaign-body-error" role="alert">{campaignFieldError.message}</p> : null}
                  <p id="campaign-body-length" className={contentIssue?.field === "body" ? styles.fieldError : styles.help}>
                    {campaignDraft.channel === "ALIMTALK" ? `원문 ${bodyMeasure.characters.toLocaleString("ko-KR")}자 · 알림톡 최대 1,000자` : `원문 ${bodyMeasure.bytes.toLocaleString("ko-KR")}byte · 문자 최대 2,000byte`}
                    {bodyMeasure.personalized ? " · 개인화 후 길이와 문자 유형은 수신자별로 확인합니다." : campaignDraft.channel === "SMS" ? ` · ${bodyMeasure.bytes <= 90 ? "단문 SMS" : "장문 LMS"}로 자동 결정` : ""}
                  </p>
                  {state.integrations.provider === "solapi" && !campaignDraft.simulate && (campaignDraft.channel !== "ALIMTALK" || campaignDraft.smsFallback) ? <p className={styles.help}>문자로 보낼 수 없는 일부 이모지·제어문자를 확인합니다. 개인화 후 내용과 예약 시점의 수신자 정보도 발송 전에 다시 확인합니다. 다른 문자까지 모두 전달된다는 보장은 아닙니다.</p> : null}
                  {charsetIssue && !campaignFieldError ? <p className={styles.fieldError} role="status">{charsetIssue.message}</p> : null}
                  {eventNameCharsetIssue ? <p className={styles.fieldError} role="note">현재 행사명에 문자로 보낼 수 없는 글자가 있습니다. 행사 설정에서 이름을 확인하거나 행사명 삽입을 지워 주세요. 최종 내용은 발송 전에 다시 확인합니다.</p> : null}
                  {charsetCandidateIds.size ? <p className={styles.fieldError} role="note">현재 화면 기준으로 선택한 참가자 {charsetCandidateIds.size}명의 이름에 문자로 보낼 수 없는 글자가 있습니다. 발송 전 서버에서 다시 확인합니다. {" "}<ProductButton type="button" className={styles.textButton} variant="ghost" onClick={() => { setShowSelectedOnly(false); setCharsetCandidatesOnly(true); jumpToRecipientFilter(); window.setTimeout(() => document.getElementById("recipient-charset-reset")?.focus(), 0); }}>이름 확인이 필요한 참가자 보기</ProductButton></p> : null}
                  {campaignDraft.channel !== "ALIMTALK" ? <div className={styles.personalizationTools} role="group" aria-label="개인화 정보 넣기">
                    <span>개인화 정보</span>
                    {["이름", "행사명", "행사일", "티켓링크", "럭키번호"].map(name => {
                      const label = name === "티켓링크" ? "티켓 링크" : name === "럭키번호" ? "럭키 번호" : name;
                      return <ProductButton key={name} type="button" variant="ghost" aria-label={`${label} 넣기`} disabled={messagesLocked} onClick={() => insertPersonalization(name)}>{label}</ProductButton>;
                    })}
                  </div> : null}
                  <p className={styles.help} id="campaign-variables">
                    {campaignDraft.channel === "ALIMTALK" ? "선택한 템플릿 문구를 그대로 사용하고 개인화 정보만 자동으로 바꿉니다. 문구를 바꾸려면 템플릿 관리에서 승인 내용과 맞추거나 문자로 전환하세요." : "받는 사람의 정보로 자동 바뀝니다."} 럭키 번호는 추첨·투표에서 먼저 발급하세요.
                  </p>
                  <ProductLink className={styles.guideAction} variant="ghost" href={`/console/events/${encodeURIComponent(eventId)}/draws`}>추첨·투표 열기 <ArrowRightIcon /></ProductLink>
                </div>
                <div className={styles.titleField}>
                  <label htmlFor="campaign-title">기록용 제목 · 비우면 자동</label>
                  <input
                    id="campaign-title"
                    maxLength={100}
                    value={campaignDraft.title}
                    placeholder={autoTitlePreview}
                    aria-invalid={campaignFieldError?.field === "title"}
                    aria-describedby={campaignFieldError?.field === "title" ? "campaign-title-help campaign-title-error" : "campaign-title-help"}
                    onChange={(event) => setCampaignDraft({ ...campaignDraft, title: event.target.value })}
                  />
                  <p className={styles.help} id="campaign-title-help">발송 기록을 구분하는 이름입니다. 비워 두면 “{autoTitlePreview}”로 저장합니다. 장문·사진 문자에는 앞부분이 제목으로 표시됩니다.</p>
                  {campaignFieldError?.field === "title" ? <p className={styles.fieldError} id="campaign-title-error" role="alert">{campaignFieldError.message}</p> : null}
                </div>
                    </div>

                <section className={styles.draftPreview} aria-labelledby="message-preview-heading">
                  <div className={styles.draftPreviewHead}>
                    <h3 id="message-preview-heading">받는 화면 예시</h3>
                    <span>{authoringTypeLabel(campaignDraft.channel)}</span>
                  </div>
                  <div className={campaignDraft.channel === "ALIMTALK" ? styles.kakaoExample : styles.textExample}>
                    {campaignDraft.channel === "ALIMTALK" ? <div className={styles.kakaoExampleHeader}>알림톡 도착 예시</div> : null}
                    {campaignDraft.channel === "MMS" && campaignDraft.imageFileId ? <div className={styles.attachmentPreview}>
                      <img key={`${campaignDraft.imageFileId}-${imagePreviewRevision}`} hidden={imagePreviewFailed} src={`/api/events/${encodeURIComponent(eventId)}/files/${encodeURIComponent(campaignDraft.imageFileId)}?preview=${imagePreviewRevision}`} alt={`첨부 사진: ${campaignDraft.imageName || "사진 1장"}`} onError={() => setImagePreviewFailed(true)} onLoad={() => setImagePreviewFailed(false)} />
                      {imagePreviewFailed ? <p className={styles.help}>첨부 사진 미리보기를 불러오지 못했습니다. <ProductButton type="button" className={styles.textButton} variant="ghost" onClick={() => { setImagePreviewFailed(false); setImagePreviewRevision(value => value + 1); }}>사진 다시 보기</ProductButton></p> : null}
                    </div> : null}
                    <p className={`${styles.draftPreviewBody} ${campaignDraft.channel === "ALIMTALK" ? styles.kakaoExampleBody : ""}`} id="message-draft-preview">
                      {campaignDraft.body ? previewMessageExample(campaignDraft.body, state.eventName, state.eventDate) : "메시지 내용을 입력하면 여기에 표시됩니다."}
                    </p>
                  </div>
                  <p className={styles.help}>{campaignDraft.channel === "ALIMTALK" ? "문구와 개인화 예시입니다. 채널명·버튼·이미지는 실제 승인 템플릿에 따릅니다." : "이름·티켓 링크·번호는 예시입니다. 실제 내용과 길이, 문자 유형은 수신자별로 달라질 수 있습니다."}</p>
                </section>

                {campaignDraft.channel !== "ALIMTALK" ? (
                  <div className={styles.sendBlock} data-message-attachment>
                    <label htmlFor="campaign-image">사진 첨부 · 선택 · JPG 200KB 이하</label>
                    <input
                      id="campaign-image"
                      type="file"
                      accept="image/jpeg"
                      disabled={uploadingImage || messagesLocked}
                      title={messagesLocked ? messagesLockReason : undefined}
                      aria-invalid={campaignFieldError?.field === "imageFileId"}
                      aria-describedby={campaignFieldError?.field === "imageFileId" ? "campaign-image-error" : "campaign-image-help"}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file && !messagesLocked) {
                          setAttachmentRevision((revision) => revision + 1);
                          void uploadMmsImage(file);
                        }
                        event.target.value = "";
                      }}
                    />
                    <p className={styles.help} id="campaign-image-help">
                      {uploadingImage
                        ? "이미지를 올리는 중입니다."
                        : campaignDraft.imageFileId
                          ? `첨부됨: ${campaignDraft.imageName || "사진 1장"} · MMS는 별도 요금이 발생합니다.`
                          : "사진 없이 보내면 SMS/LMS가 자동 결정됩니다. 첨부하면 MMS로 전환됩니다."}
                    </p>
                    {campaignDraft.imageFileId ? <ProductButton type="button" className={styles.textButton} variant="ghost" disabled={uploadingImage || messagesLocked || uncertainMmsUpload} onClick={() => {
                      if (inFlightRef.current || mmsUploadGateRef.current) return;
                      setAttachmentRevision(revision => revision + 1);
                      setCampaignDraft(current => ({ ...current, channel: current.channel === "ALIMTALK" ? "ALIMTALK" : "SMS", imageFileId: "", imageName: "" }));
                      setCampaignFieldError(current => current?.field === "imageFileId" ? null : current);
                    }}>사진 첨부 해제</ProductButton> : null}
                    {campaignFieldError?.field === "imageFileId" ? <p className={styles.fieldError} id="campaign-image-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                ) : null}

                <div className={styles.sendCard} id="campaign-schedule">
                <h3 className={styles.zoneHead} id="campaign-schedule-heading" tabIndex={-1}><span aria-hidden="true">3</span>보낼 때</h3>
                <div className={uiStyles.formGrid}>
                  <div className={styles.scheduleFields}>
                    <ConsoleChoiceGroup id="campaign-schedule-choice" label="보내는 시점" value={effectiveScheduleChoice} disabled={messagesLocked}
                      options={[
                        { value: "NOW", label: "지금", description: "발송 검토 후 바로 처리합니다." },
                        { value: "EVENT", label: "행사 기준", description: eventDateKnown ? "행사일에서 며칠 전·후 시각으로 예약합니다." : "행사일이 없어 쓸 수 없습니다." },
                        { value: "DATE", label: "날짜·시각 지정", description: "원하는 날짜와 시각으로 예약합니다." },
                      ]}
                      onChange={(value) => chooseSchedule(value === "EVENT" ? (eventDateKnown ? "EVENT" : "DATE") : value === "DATE" ? "DATE" : "NOW")} />
                    {effectiveScheduleChoice === "EVENT" ? <div className={styles.eventOffsetRow}>
                      <div>
                        <label htmlFor="campaign-event-offset">행사 기준</label>
                        <select id="campaign-event-offset" value={eventOffset.days} onChange={(event) => changeEventOffset({ ...eventOffset, days: Number(event.target.value) })}>
                          {EVENT_OFFSET_CHOICES.map(choice => <option key={choice.days} value={choice.days}>{choice.label}</option>)}
                        </select>
                      </div>
                      <div>
                        <label htmlFor="campaign-event-time">시각 (한국 시간)</label>
                        <input id="campaign-event-time" type="time" step={60} value={eventOffset.time} onChange={(event) => { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(event.target.value)) changeEventOffset({ ...eventOffset, time: event.target.value }); }} />
                      </div>
                      <p className={styles.eventOffsetResult} id="campaign-event-result" aria-live="polite">{campaignDraft.scheduled ? `→ ${formatScheduledInput(campaignDraft.scheduled)}` : "행사일을 확인할 수 없습니다."}</p>
                      <p className={styles.help}>예약 시각은 지금 계산해 저장합니다. 나중에 행사 일정이 바뀌어도 이 예약은 자동으로 옮겨지지 않습니다.</p>
                    </div> : null}
                    {effectiveScheduleChoice === "DATE" ? <div>
                    <label htmlFor="campaign-scheduled">예약 시각 (한국 시간)</label>
                    <input
                      id="campaign-scheduled"
                      ref={scheduleInputRef}
                      type="datetime-local"
                      step={60}
                      value={campaignDraft.scheduled}
                      aria-invalid={campaignFieldError?.field === "scheduled"}
                      aria-describedby={campaignFieldError?.field === "scheduled" ? "campaign-scheduled-error campaign-scheduled-help" : "campaign-scheduled-help"}
                      onChange={(event) => {
                        setScheduleBadInput(event.target.validity.badInput);
                        setCampaignDraft({ ...campaignDraft, scheduled: event.target.value, scheduleMode: event.target.value ? campaignDraft.scheduleMode : "MANUAL" });
                        setCampaignFieldError((current) => current?.field === "scheduled" ? null : current);
                      }}
                      onInput={(event) => {
                        if (!event.currentTarget.validity.badInput) {
                          setScheduleBadInput(false);
                          setCampaignFieldError((current) => current?.field === "scheduled" ? null : current);
                        }
                      }}
                      onKeyUp={(event) => setScheduleBadInput(event.currentTarget.validity.badInput)}
                      onBlur={(event) => {
                        if (event.target.validity.badInput) {
                          setScheduleBadInput(true);
                          setCampaignFieldError({ field: "scheduled", message: "예약 날짜와 시간을 모두 입력하거나 지워 주세요." });
                        }
                      }}
                    />
                    <p className={styles.help} id="campaign-scheduled-help">
                      {!campaignDraft.scheduled
                        ? "한국 시간 기준입니다. 시각을 입력하지 않으면 즉시 처리합니다."
                        : campaignDraft.simulate
                        ? "한국 시간 기준입니다. 모의 예약은 시각 이후 직접 실행하며, 실행해도 수신자에게 전달되지 않습니다."
                        : "한국 시간 기준입니다. 선택한 실행 방식과 서버 상태는 아래 발송 전 확인에서 볼 수 있습니다."}
                    </p>
                    </div> : null}
                    {campaignDraft.scheduled && !campaignDraft.simulate ? <ConsoleChoiceGroup id="campaign-schedule-mode" label="예약 실행 방식"
                      value={campaignDraft.scheduleMode} onChange={(value) => setCampaignDraft({ ...campaignDraft, scheduleMode: value === "AUTO" ? "AUTO" : "MANUAL" })}
                      options={[{ value: "MANUAL", label: "수동 실행" }, { value: "AUTO", label: "자동 실행" }]} /> : null}
                    {campaignFieldError?.field === "scheduled" ? <p className={styles.fieldError} id="campaign-scheduled-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                  <label className={styles.simulateOption}>
                    <input
                      type="checkbox"
                      checked={campaignDraft.simulate}
                      disabled={newOrgSimOnly}
                      title={newOrgSimOnly ? "새 운영사에는 발송 수단이 없으므로 모의 기록만 가능합니다. 연결돼도 자동으로 바뀌지 않습니다." : undefined}
                      onChange={(event) => setCampaignDraft({ ...campaignDraft, simulate: event.target.checked, scheduleMode: event.target.checked ? "MANUAL" : campaignDraft.scheduleMode })}
                    />
                    <span><strong>모의 발송으로 기록</strong><small>{newOrgSimOnly ? "새 운영사는 미연동이라 모의 기록만 가능합니다. 연결돼도 자동으로 실제 발송으로 바뀌지 않습니다." : "실제 수신자에게 전달되지 않습니다."}</small></span>
                  </label>
                </div>
                </div>
                  </div>
                </div>

                {campaignError && !uncertainCreate ? <p className={styles.fieldError} id="campaign-request-error" role="alert">{campaignError}</p> : null}
                <section className={styles.reviewCard} aria-labelledby="campaign-review-heading">
                  <div className={styles.reviewHeading}>
                    <h3 className={styles.zoneHead} id="campaign-review-heading" tabIndex={-1}><span aria-hidden="true">4</span>발송 전 검토</h3>
                    <p>대상과 내용을 확인한 뒤 발송 확인을 진행합니다.</p>
                  </div>
                  {/* Reopened 2026-11-20: who gets it, how, what it costs and the exact wording sit in one summary card. */}
                  <div className={styles.summaryCard}>
                    <div className={styles.summaryHead}>
                      <p className={styles.summaryCount}><strong>{selectedCount}</strong><span>명에게 {channelLabel(campaignDraft.channel)} · {submitModeLabel}</span></p>
                      <StatusPill tone={simulateDraft ? "info" : "wait"} dot>{simulateDraft ? "모의 발송 · 실제 전달 없음" : "실제 발송 · 되돌릴 수 없음"}</StatusPill>
                    </div>
                    <ul className={styles.draftSummary} aria-label="작성 요약">
                      <li>
                        {selectedCount > 0
                          ? `수신자 ${selectedCount}명 선택${pendingRiskCount > 0 ? ` · 승인 대기·대기 ${pendingRiskCount}명 포함` : ""}${outsideVisibleCount > 0 ? ` · 화면 밖 ${outsideVisibleCount}명 유지` : ""}`
                          : "수신자를 선택하세요 · 아직 0명입니다"}
                      </li>
                      <li>
                        {campaignDraft.body.trim()
                          ? `${channelLabel(campaignDraft.channel)} · 내용 입력됨 · 기록 제목 “${campaignDraft.title.trim() || autoTitlePreview}”`
                          : "메시지 내용을 입력하세요"}
                      </li>
                      <li>
                        {scheduleBadInput ? "예약 날짜와 시간을 확인하세요" : scheduledDraft
                          ? simulateDraft
                            ? `모의 예약 · ${formatScheduledInput(campaignDraft.scheduled)} · 수동 실행 · 전달 없음`
                            : `예약 ${formatScheduledInput(campaignDraft.scheduled)} · ${campaignDraft.scheduleMode === "AUTO" ? "자동 실행" : "수동 실행"}`
                          : simulateDraft
                            ? "모의 발송 · 실제 전달 없음"
                            : "즉시 발송 시도"}
                      </li>
                      <li>
                        {campaignDraft.imageFileId
                          ? `첨부 사진: ${campaignDraft.imageName || "사진 1장"} · MMS로 발송`
                          : "첨부 사진 없음"}
                      </li>
                      <li>
                        {simulateDraft
                          ? "비용 · 모의 발송은 요금이 발생하지 않습니다"
                          : campaignDraft.channel === "MMS"
                            ? "비용 · 사진 문자는 별도 요금이 발생합니다"
                            : "비용 · 발송 요금은 공급사 요금제를 따릅니다"}
                      </li>
                    </ul>
                    <div className={styles.summaryBody}>
                      <p className={styles.summaryBodyLabel}>보낼 문구</p>
                      <p className={styles.finalBody}>{campaignDraft.body}</p>
                    </div>
                  </div>
                  {ticketLinkInvalidCount > 0 ? <p className={styles.help} role="note">
                    티켓을 사용할 수 없거나 상태를 확인할 수 없는 수신자 {ticketLinkInvalidCount}명 · {simulateDraft ? "모의 기록은 가능하지만 실제 발송 전 확인이 필요합니다." : "실제 발송 전에 티켓을 확인해 주세요."}{" "}
                    <ProductLink variant="ghost" href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>티켓 확인이 필요한 참가자 보기</ProductLink>
                  </p> : null}
                  {scheduledDraft && !simulateDraft ? <p className={styles.help} role="note">{scheduleModeNotice(campaignDraft.scheduleMode)}</p> : null}
                  {campaignDraft.channel === "ALIMTALK" && !simulateDraft ? <p className={styles.help} role="note">{campaignDraft.smsFallback ? ALIMTALK_FALLBACK_NOTICE : ALIMTALK_NO_FALLBACK_NOTICE}</p> : null}
                  {scheduledDraft && !simulateDraft ? <p className={styles.help}>{scheduleServerStatus(state.messageSchedule)} 현재 서버 기준이며 실제 발송 성공을 보장하지 않습니다.</p> : null}
                <div className={styles.reviewBar}>
                  <p className={styles.reviewSummary} id="campaign-submit-warning" tabIndex={-1}>
                    선택 {selectedCount}명 · {channelLabel(campaignDraft.channel)} · {submitModeLabel}{simulateDraft ? "" : " · 발송은 되돌릴 수 없습니다."}
                    {campaignDraft.channel === "MMS" && !simulateDraft ? " 별도 요금이 발생합니다." : ""}
                    {selectedCount === 0 ? " 수신자를 먼저 고르세요." : ""}
                    {messagesLocked ? ` ${messagesLockReason}` : ""}
                  </p>
                  <ProductButton
                    type="button"
                    className={styles.textButton} variant="ghost"
                    onClick={jumpToRecipientFilter} icon={<ArrowUpIcon />}
                  >

                    수신자 다시 확인
                  </ProductButton>
                  <ProductButton
                    id="campaign-submit"
                    variant="primary"
                    type="submit"
                    disabled={selectedCount === 0 || busyAction !== null || uploadingImage || messagesLocked || otherCreateReceipt || uncertainMmsUpload}
                    aria-describedby={campaignError && !uncertainCreate ? "campaign-submit-warning campaign-request-error" : "campaign-submit-warning"}
                    title={messagesLocked ? messagesLockReason : selectedCount === 0 ? "수신자를 먼저 고르세요." : undefined}
                  >
                    {busyAction === "campaign" ? "요청 중…" : "발송 검토"}
                  </ProductButton>
                </div>

                <p className={styles.reviewInvalidated} id="campaign-review-status" role="status" aria-atomic="true">
                  {sendPending && !reviewIsCurrent ? "수신자·발송 내용이나 발송 가능 상태가 바뀌었습니다. 발송 검토를 다시 눌러 주세요." : ""}
                </p>
                {sendPending && reviewIsCurrent ? (
                  <ConsoleConfirm
                    summary={confirmLines(sendPending.summary)}
                    confirmLabel={sendPending.confirmLabel}
                    busy={busyAction === "campaign"}
                    onConfirm={() => {
                      if (!reviewIsCurrent) return;
                      const pending = sendPending;
                      setSendPending(null);
                      void executeCampaignCreate(pending);
                    }}
                    onCancel={() => setSendPending(null)}
                  />
                ) : null}
                </section>
                </fieldset>
              </ValidatedForm>
            </ConsoleSection>
            </div>
            )} templates={(
            <ConsoleSection
              headingId="templates-heading"
              title="메시지 템플릿"
              description="자주 쓰는 문자 문구와 승인된 알림톡 정보를 관리합니다."
              action={<ConsoleRefreshButton label="목록 새로고침" disabled={busyAction !== null || refreshingOtherTemplate} onRefresh={() => refresh(true)} />}
              divider
              className={styles.templateSection}
            >
              {templateNotice ? <ConsoleFeedback kind="success">{templateNotice}</ConsoleFeedback> : null}
              {templateError && !pendingTemplate ? <ConsoleFeedback kind="error">{templateError}</ConsoleFeedback> : null}
              {pendingTemplate ? <section className={styles.sendRecovery} aria-labelledby="template-recovery-heading">
                <h2 id="template-recovery-heading" tabIndex={-1}>{pendingTemplate.command === "template.save" ? "템플릿 저장 확인 필요" : pendingTemplate.payload.archived ? "템플릿 보관 확인 필요" : "템플릿 복원 확인 필요"}</h2>
                <p>변경이 이미 반영됐을 수 있습니다. 서버 처리 확인은 변경 요청을 다시 보내지 않습니다.</p>
                {templateError ? <p role="alert">{templateError}</p> : null}
                <div className={styles.sendRecoveryActions}>
                  <ProductButton type="button" variant="secondary" disabled={busyAction !== null || checkingTemplate || abandonTemplateConfirm} onClick={() => void checkTemplateSave()}>{checkingTemplate ? "확인 중…" : "서버 처리 확인"}</ProductButton>
                  <ProductButton type="button" variant="secondary" disabled={busyAction !== null || checkingTemplate || abandonTemplateConfirm || messagesLocked} onClick={() => void executeTemplateSave(pendingTemplate, true)}>같은 요청 다시 시도</ProductButton>
                  <ProductButton type="button" variant="secondary" disabled={busyAction !== null || checkingTemplate || abandonTemplateConfirm} onClick={() => setAbandonTemplateConfirm(true)}>확인 전 그만두기</ProductButton>
                </div>
                {abandonTemplateConfirm ? <ConsoleConfirm summary="이미 반영된 변경은 취소되지 않습니다. 확인을 그만두고 목록을 확인할까요?" confirmLabel="확인 그만두기" onConfirm={() => {
                  const attempt = pendingTemplateRef.current;
                  if (!attempt) return;
                  abandonOperatorAttempt(attempt.id); forgetOperatorReceipt(attempt.id);
                  templateSaveRef.current = null; pendingTemplateRef.current = null; setPendingTemplate(null);
                  setAbandonTemplateConfirm(false); setTemplateError("이전 변경이 반영됐을 수 있습니다. 목록을 확인한 뒤 다시 진행하세요.");
                  setRefreshingOtherTemplate(true);
                  void refresh(true).finally(() => { if (activeMessageEventRef.current === attempt.eventId) setRefreshingOtherTemplate(false); });
                }} onCancel={() => setAbandonTemplateConfirm(false)} /> : null}
              </section> : otherTemplateReceipt ? <ConsoleFeedback kind="warning">이전 템플릿 변경 결과를 화면 위의 ‘처리 결과 확인’에서 먼저 확인하세요.</ConsoleFeedback> : null}
              {refreshingOtherTemplate ? <ConsoleFeedback kind="info">최신 템플릿 목록을 불러오고 있습니다.</ConsoleFeedback> : null}
              <div className={styles.templateManager} id="template-details" data-empty={state.templates.length === 0 ? true : undefined}>
                <div className={styles.templateLibraryTools}>
                  <label><span className="sr-only">템플릿 이름·내용 검색</span><input id="template-search" type="search" maxLength={120} placeholder="이름·내용으로 템플릿 찾기" value={templateQuery} onChange={event => setTemplateQuery(event.target.value)} /></label>
                  <label><span className="sr-only">템플릿 상태</span><select id="template-scope" value={templateScope} onChange={event => setTemplateScope(event.target.value)}>
                    <option value="ACTIVE">사용 중 ({activeTemplates.length})</option><option value="ARCHIVED">보관됨 ({state.templates.length - activeTemplates.length})</option><option value="ALL">전체 ({state.templates.length})</option>
                  </select></label>
                  <span role="status" aria-live="polite">{visibleTemplates.length}개</span>
                </div>
                {templateArchiveConfirm ? <div className={styles.templateArchiveReview}>
                  <ConsoleConfirm summary={confirmLines(`〈${templateArchiveConfirm.name}〉 템플릿을 보관할까요?\n\n새 메시지의 선택 목록에서 숨깁니다. 기존 발송 기록과 등록된 예약은 바뀌지 않으며 보관 목록에서 복원할 수 있습니다. 작성 중인 내용은 이 화면에 유지합니다.`)} confirmLabel="템플릿 보관" busy={busyAction !== null || templateRecoveryLocked || messagesLocked} onConfirm={() => { void changeTemplateArchive(templateArchiveConfirm, true); }} onCancel={() => setTemplateArchiveConfirm(null)} />
                </div> : null}
                <div className={styles.templateListPanel}>
                  {visibleTemplates.length ? <ul className={styles.templateList} tabIndex={0} aria-label="메시지 템플릿 목록">
                    {visibleTemplates.map(template => <li key={template.id} className={styles.templateRow} data-template-id={template.id}>
                      <div className={styles.templateSummary}>
                        <strong>{template.name}</strong><span>{familyLabel(template.channel)}</span>
                        {template.archived ? <small>보관됨</small> : null}
                        {template.channel === "ALIMTALK" ? <small>승인 ID {template.solapiTemplateId ? "등록됨" : "미등록"}</small> : null}
                      </div>
                      <div className={styles.templateActions}>
                        {!template.archived ? <ProductButton type="button" variant="secondary" disabled={messagesLocked || templateRecoveryLocked || busyAction !== null} onClick={() => useTemplate(template)}>사용</ProductButton> : null}
                        <ProductButton type="button" variant="secondary" disabled={template.archived || templateRecoveryLocked || busyAction !== null} onClick={() => requestTemplateEdit(template)} icon={<PencilIcon />}>{messagesLocked ? "내용 보기" : "편집"}</ProductButton>
                        <ProductButton type="button" variant="secondary" disabled={messagesLocked || templateRecoveryLocked || busyAction !== null} onClick={() => { if (template.archived) void changeTemplateArchive(template, false); else { setTemplateEditConfirm(null); setTemplateResetConfirm(false); setTemplateArchiveConfirm({ ...template }); } }}>{template.archived ? "복원" : "보관"}</ProductButton>
                      </div>
                    </li>)}
                  </ul> : <div className={styles.templateLibraryEmpty}>
                    <p className={styles.help}>{state.templates.length === 0 ? "자주 쓰는 안내를 저장해 두면 다음 발송에 다시 사용할 수 있습니다." : templateScope === "ARCHIVED" && !templateSearch ? "보관된 템플릿이 없습니다. 사용하지 않는 문구를 보관하면 여기에 표시됩니다." : "조건에 맞는 템플릿이 없습니다."}</p>
                    {state.templates.length > 0 ? <ProductButton type="button" className={styles.textButton} variant="ghost" onClick={() => { setTemplateQuery(""); setTemplateScope("ACTIVE"); }}>검색·필터 초기화</ProductButton> : null}
                  </div>}
                </div>

                <ValidatedForm className={uiStyles.formStack} onSubmit={saveTemplate}>
                  {templateEditConfirm ? <ConsoleConfirm summary={`작성 중인 내용을 비우고 〈${templateEditConfirm.name}〉 템플릿을 편집할까요?`} confirmLabel="선택한 템플릿 편집" onConfirm={() => {
                    const latest = state.templates.find(item => item.id === templateEditConfirm.id);
                    if (!latest || latest.archived || latest.version !== templateEditConfirm.version) { setTemplateEditConfirm(null); setTemplateError("템플릿이 변경됐습니다. 목록을 새로고침한 뒤 다시 선택하세요."); return; }
                    openTemplateEditor(latest);
                  }} onCancel={() => setTemplateEditConfirm(null)} /> : null}
                  {templateResetConfirm ? <ConsoleConfirm summary="작성 중인 템플릿 내용을 비우고 새로 작성할까요? 저장된 템플릿은 바뀌지 않습니다." confirmLabel="내용 비우고 새로 작성" onConfirm={clearTemplateDraft} onCancel={() => setTemplateResetConfirm(false)} /> : null}
                  {editingTemplate?.archived ? <div className={styles.templateLibraryEmpty}><p className={styles.help}>보관된 템플릿입니다. 입력은 유지하며 복원한 뒤 수정할 수 있습니다.</p><ProductButton type="button" variant="secondary" disabled={messagesLocked || templateRecoveryLocked || busyAction !== null} onClick={requestNewTemplate}>새 템플릿 작성</ProductButton></div> : null}
                  <fieldset className={styles.composeLock} disabled={messagesLocked || templateRecoveryLocked || busyAction === "template" || editingTemplate?.archived}>
                  <h3>{messagesLocked ? "템플릿 내용" : templateDraft.id ? "템플릿 수정" : "새 템플릿"}</h3>
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
                    <ConsoleChoiceGroup layout="compare" id="template-channel" label="보내는 방법" value={templateDraft.channel === "ALIMTALK" ? "ALIMTALK" : "SMS"}
                      options={TEMPLATE_CHANNEL_CHOICES} invalid={templateFieldError?.field === "channel"}
                      describedBy={templateFieldError?.field === "channel" ? "template-channel-error" : undefined}
                      onChange={(channel) => setTemplateDraft({ ...templateDraft, channel })} />
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
                    <textarea data-resize-none="true"
                      id="template-body"
                      maxLength={2000}
                      required
                      rows={3}
                      value={templateDraft.body}
                      aria-invalid={templateFieldError?.field === "body"}
                      aria-describedby={templateFieldError?.field === "body" ? "template-body-error template-variables" : "template-variables"}
                      onChange={(event) => setTemplateDraft({ ...templateDraft, body: event.target.value })}
                    />
                    <p className={styles.help} id="template-variables">사용 가능 변수: &#123;&#123;이름&#125;&#125;, &#123;&#123;행사명&#125;&#125;, &#123;&#123;행사일&#125;&#125;, &#123;&#123;티켓링크&#125;&#125;, &#123;&#123;럭키번호&#125;&#125; · 럭키번호는 추첨·투표에서 먼저 발급하세요.</p>
                    {templateDraft.channel === "ALIMTALK" ? <p className={styles.help}>Solapi에서 승인받은 ID와 문구를 확인해 등록하세요. 승인 문구의 {"#{이름}"} 같은 변수는 위의 {"{{이름}}"} 형식으로 입력하며, 변수명은 제공된 개인화 정보와 같아야 합니다.</p> : null}
                    {templateFieldError?.field === "body" ? <p className={styles.fieldError} id="template-body-error" role="alert">{templateFieldError.message}</p> : null}
                  </div>
                  {templateFieldError && !FIELD_LABELS[templateFieldError.field] ? <p className={styles.fieldError} role="alert">{templateFieldError.message}</p> : null}
                  <ConsoleFormActions>
                    <ProductButton variant="primary" type="submit" disabled={busyAction !== null || messagesLocked} title={messagesLocked ? messagesLockReason : undefined}>
                      {busyAction === "template" ? "저장 중…" : templateDraft.id ? "템플릿 저장" : "템플릿 추가"}
                    </ProductButton>
                    {templateDraft.id ? (
                      <ProductButton type="button" className={styles.textButton} variant="ghost" onClick={requestNewTemplate} icon={<PlusIcon />}>새로 작성</ProductButton>
                    ) : null}
                  </ConsoleFormActions>
                  </fieldset>
                </ValidatedForm>
              </div>
            </ConsoleSection>
            )} history={(
          <ConsoleSection
            headingId="history-heading"
            title="발송 기록"
            className={styles.historySection}
            action={(
              <div className={styles.historyTools}>
              <ConsoleRefreshButton label="상태 새로고침" disabled={busyAction !== null} onRefresh={() => refresh(true)} />
              <ProductButton id="message-compose-open" type="button" variant={composerOpen || messagesLocked ? "secondary" : "primary"} disabled={messagesLocked && !composeDirty && !uncertainCreate} title={messagesLocked ? messagesLockReason : undefined} aria-expanded={composerOpen} aria-controls="message-composer" onClick={revealComposer}>
                {messagesLocked && composeDirty ? "작성 내용 보기" : composerOpen ? "작성 화면으로" : composeDirty ? "작성 이어가기" : "메시지 작성"}
              </ProductButton>
              </div>
            )}
            divider
          >
            {archived && campaignNotice ? <p className={styles.help} role="status">{campaignNotice.message}</p> : null}
            {state.campaigns.length === 0 && !attentionOnly ? (
              <div className={styles.firstMessage}>
                <strong>아직 발송 기록이 없습니다</strong>
                <p>{messagesLocked ? "등록된 발송 기록은 이곳에서 확인합니다." : "메시지를 작성하고 수신자를 선택하면 발송 전에 내용을 확인할 수 있습니다."}</p>
              </div>
            ) : (<>
            <CountTabs
              className={styles.historyTabs}
              ariaLabel="발송 빠른 필터"
              value={attentionOnly ? "attention" : historyStatus === "ALL" ? "all" : historyStatus === "SCHEDULED" ? "scheduled" : null}
              onChange={(key) => {
                if (key === "all") {
                  setAttentionOnly(false);
                  setHistoryStatus("ALL"); setHistoryQuery(""); setHistoryLimit(10);
                } else if (key === "scheduled") {
                  setAttentionOnly(false);
                  setHistoryStatus((current) => !attentionOnly && current === "SCHEDULED" ? "ALL" : "SCHEDULED");
                  setHistoryQuery(""); setHistoryLimit(10); setHistoryOpen(true);
                } else {
                  setAttentionOnly((current) => !current);
                  setHistoryStatus("ALL"); setHistoryQuery(""); setHistoryLimit(10); setHistoryOpen(true);
                }
              }}
              items={[
                { key: "all", label: "전체", count: state.campaigns.length, srLabel: `전체 발송 ${state.campaigns.length}건` },
                { key: "scheduled", label: "예약", count: scheduledCount, srLabel: `예약된 발송 ${scheduledCount}건` },
                { key: "attention", label: "확인 필요", count: attentionCampaigns.length, tone: "wait", srLabel: `확인 필요한 발송 ${attentionCampaigns.length}건` },
              ]}
            />
            <div className={styles.historyFilters}>
              <label><span className="sr-only">발송 제목 검색</span><input id="message-history-search" type="search" placeholder="발송 제목 검색" value={historyQuery} onChange={(event) => { setHistoryQuery(event.target.value); setHistoryLimit(10); }} /></label>
              <label><span className="sr-only">발송 상태</span><select id="message-history-status" value={historyStatus} onChange={(event) => { setHistoryStatus(event.target.value); setHistoryLimit(10); }}>
                <option value="ALL">모든 상태</option>
                {["SCHEDULED", "NEEDS_CONNECTION", "SENDING", "ACCEPTED", "PARTIAL", "FAILED", "SENT", "SIMULATED", "CANCELLED"].map((status) => <option key={status} value={status}>{messageStatusLabel(status)}</option>)}
              </select></label>
              <span role="status">{historyQuery || historyStatus !== "ALL" ? `검색 결과 ${visibleCampaigns.length}건 · 전체 ${historyScope.length}건` : `총 ${historyScope.length}건`}</span>
            </div>
            <details className={styles.historyDetails} open={historyOpen} onToggle={(event) => setHistoryOpen((event.target as HTMLDetailsElement).open)}>
              <summary>
                {historyOpen ? "기록 목록 접기" : `기록 목록 펼치기 (${visibleCampaigns.length}건)`}
              </summary>
            {attentionOnly ? (
              <div className={styles.attentionFilter}>
                <p role="status">발송 확인이 필요한 발송만 보고 있습니다 · {visibleCampaigns.length}건{overdueCampaigns.length ? ` · 실행 시점 지난 예약 ${overdueCampaigns.length}건 포함` : ""}</p>
                <ProductButton type="button" variant="ghost" onClick={() => { setAttentionOnly(false); setHistoryStatus("ALL"); setHistoryQuery(""); }}>
                  전체 발송 기록 보기
                </ProductButton>
              </div>
            ) : null}
            {visibleCampaigns.length ? (
              <>
              <div className={styles.historyScroll}>
              <table className={styles.historyTable}>
                <caption className="sr-only">발송 기록 비교. 제목, 채널, 대상, 요청·예약 시각, 상태와 작업.</caption>
                <thead><tr><th scope="col">발송 제목</th><th scope="col">채널</th><th scope="col">대상</th><th scope="col">요청·예약</th><th scope="col">상태</th><th scope="col">작업</th></tr></thead>
                <tbody ref={historyListRef}>
                {shownCampaigns.map((campaign) => {
                  const due = hasValidScheduledInstant(campaign.scheduled) && Date.parse(campaign.scheduled) <= nowMs;
                  const overdue = campaign.status === "SCHEDULED" && isOverdue(campaign, nowMs);
                  const blocked = blockedById.get(campaign.id);
                  const recipientChanged = blocked?.reason === "RECIPIENT_CHANGED";
                  const charsetBlocked = blocked?.reason === "SMS_CHARSET_UNSUPPORTED" || blocked?.reason === "SMS_CHARSET_REVIEW_UNAVAILABLE" || campaign.smsTextProblemCount > 0 || campaign.smsTextProblemUnknown;
                  const resultMatchUnconfirmed = campaign.deliveries.some(delivery => delivery.resultMatchUnconfirmed);
                  const reloadable = canReloadCampaign(campaign);
                  const invalidSchedule = (campaign.status === "SCHEDULED" || Boolean(campaign.scheduled)) && !hasValidScheduledInstant(campaign.scheduled);
                  const canSync = !campaign.genericTransport && (campaign.status === "SENDING" || campaign.status === "PARTIAL");
                  const canCancel = campaign.status === "SCHEDULED" || campaign.status === "NEEDS_CONNECTION";
                  const retryAmbiguous = ambiguousRetryIds.includes(campaign.id);
                  const canRetry = retryAmbiguous ? campaign.status !== "SCHEDULED" : campaign.status === "NEEDS_CONNECTION" && !invalidSchedule;
                  const canExecute = campaign.status === "SCHEDULED" && (due || retryAmbiguous);
                  const syncAmbiguous = ambiguousSyncIds.includes(campaign.id);
                  const cancelAmbiguous = ambiguousCancelIds.includes(campaign.id);
                  const detailOpen = expandedCampaignId === campaign.id || historyPending?.id === campaign.id || reloadPending?.id === campaign.id;
                  return (
                    <Fragment key={campaign.id}>
                    <tr id={`campaign-${campaign.id}`} tabIndex={-1} data-history-row>
                          <td className={styles.historyIdentity}><h3>{campaign.title}</h3>
                            {campaign.simulate && !["SIMULATED", "SCHEDULED"].includes(campaign.status) ? <small>모의 · 실제 전달 없음</small> : null}
                          </td>
                          <td className={styles.historyChannel} data-history-channel><span className={styles.mobileCellLabel}>채널 </span><span className={styles.channelChip}><MessageIcon />{channelLabel(campaign.channel)}</span></td>
                          <td className={styles.historyCount} data-history-count><span className={styles.mobileCellLabel}>대상 </span><span className={styles.countChip}><UsersIcon />{campaign.recipientIds.length}명</span></td>
                          <td className={styles.historyTime} data-history-time><span><span className={styles.mobileCellLabel}>요청 </span><time dateTime={campaign.at || undefined}>{formatDate(campaign.at)}</time></span>
                            {campaign.scheduled || campaign.status === "SCHEDULED" ? <small>예약 {formatSavedSchedule(campaign.scheduled)}</small> : null}
                          </td>
                          <td className={styles.historyStatus} data-history-status>
                            <StatusPill tone={resultMatchUnconfirmed ? "wait" : statusTone(campaign.status)}>
                              {campaign.submissionUnconfirmed ? "공급사 접수 미확인" : resultMatchUnconfirmed ? "수신자 결과 확인 필요" : campaign.status === "SENT" && campaign.providerKind !== "solapi" ? "발송 기록 · 전달 근거 미확인" : messageStatusLabel(campaign.status)}
                            </StatusPill>
                            {overdue ? (
                              <StatusPill tone="wait">{campaign.simulate ? "실행 시점 지남·수동 실행 필요" : "실행 시점 지남·상태 확인"}</StatusPill>
                            ) : null}
                            {campaign.status === "SCHEDULED" && campaign.simulate ? (
                              <StatusPill tone="neutral">모의 예약·전달 없음</StatusPill>
                            ) : null}
                            {["SCHEDULED", "NEEDS_CONNECTION"].includes(campaign.status) && invalidSchedule ? (
                              <StatusPill tone="wait">예약 시각 확인 필요</StatusPill>
                            ) : null}
                            {blocked ? <span id={`campaign-blocked-${campaign.id}`}><StatusPill tone="wait">{recipientChanged ? "수신자 변경 · 발송 보류" : "실행 전 확인 필요"}</StatusPill></span> : null}
                            {!campaign.simulate && ["SCHEDULED", "NEEDS_CONNECTION"].includes(campaign.status) && !campaign.recipientRoutingReviewed && !blocked ? <StatusPill tone="wait">참가 상태·그룹 직접 확인</StatusPill> : null}
                            {campaign.status === "SENDING" && campaign.recipientChangeCount > 0 ? <StatusPill tone="wait">수신자 변경 · 재제출 중단</StatusPill> : null}
                            {retryAmbiguous || syncAmbiguous || cancelAmbiguous ? <StatusPill tone="wait">이전 작업 처리 확인 필요</StatusPill> : null}
                          </td>
                          <td className={styles.historyActionCell}><div className={styles.campaignActions}>
                            {canExecute ? (
                              <ProductButton type="button" variant="secondary" disabled={busyAction !== null || messagesLocked || otherHistoryReceipt || syncAmbiguous || cancelAmbiguous || (Boolean(blocked) && !retryAmbiguous)} aria-describedby={blocked ? `campaign-blocked-${campaign.id}` : undefined} title={messagesLocked ? messagesLockReason : blocked && !retryAmbiguous ? "상세에서 사유를 확인하고 해결한 뒤 상태를 새로고침하세요." : undefined} onClick={() => { setReloadPending(null); setHistoryPending({ id: campaign.id, kind: "execute" }); }}>
                                {busyAction === `retry:${campaign.id}` ? "실행 중…" : retryAmbiguous ? "같은 요청 다시 시도" : "발송 실행"}
                              </ProductButton>
                            ) : null}
                            {canRetry ? (
                              <ProductButton type="button" variant="secondary" disabled={busyAction !== null || messagesLocked || otherHistoryReceipt || syncAmbiguous || cancelAmbiguous || ((Boolean(blocked) || charsetBlocked) && !retryAmbiguous)} aria-describedby={blocked ? `campaign-blocked-${campaign.id}` : undefined} title={messagesLocked ? messagesLockReason : blocked && !retryAmbiguous ? "상세에서 사유를 확인하고 해결한 뒤 상태를 새로고침하세요." : undefined} onClick={() => { setReloadPending(null); setHistoryPending({ id: campaign.id, kind: "retry" }); }}>
                                {busyAction === `retry:${campaign.id}` ? "재시도 중…" : retryAmbiguous ? "같은 요청 다시 시도" : "재시도"}
                              </ProductButton>
                            ) : null}
                            {canSync ? (
                              <ProductButton type="button" variant="ghost" disabled={busyAction !== null || messagesLocked || otherHistoryReceipt || retryAmbiguous || cancelAmbiguous} title={messagesLocked ? messagesLockReason : undefined} onClick={() => void syncCampaign(campaign)}>
                                {busyAction === `sync:${campaign.id}` ? "확인 중…" : syncAmbiguous ? "같은 요청 다시 확인" : "발송 결과 확인"}
                              </ProductButton>
                            ) : null}
                            {canCancel ? (
                              <ProductButton type="button" variant="destructive" disabled={busyAction !== null || messagesLocked || otherHistoryReceipt || retryAmbiguous || syncAmbiguous || (blocked?.reason === "AUDIT_UNAVAILABLE" && !cancelAmbiguous)} title={messagesLocked ? messagesLockReason : blocked?.reason === "AUDIT_UNAVAILABLE" && !cancelAmbiguous ? "행사 활동 기록을 확인한 뒤 취소할 수 있습니다." : undefined} aria-describedby={blocked?.reason === "AUDIT_UNAVAILABLE" ? `campaign-blocked-${campaign.id}` : undefined} onClick={() => { setReloadPending(null); setHistoryPending({ id: campaign.id, kind: "cancel" }); }}>
                                {busyAction === `cancel:${campaign.id}` ? "취소 중…" : cancelAmbiguous ? "같은 요청 다시 시도" : campaign.status === "SCHEDULED" ? "예약 취소" : "발송 취소"}
                              </ProductButton>
                            ) : null}
                            {reloadable ? <ProductButton type="button" variant="secondary" disabled={busyAction !== null || uploadingImage || messagesLocked || !state.canManage || otherHistoryReceipt || otherCreateReceipt || uncertainMmsUpload} title={messagesLocked ? messagesLockReason : undefined} onClick={() => requestFailedReload(campaign)}>내용·대상 불러오기</ProductButton> : null}
                            <ProductButton type="button" variant="secondary" aria-label={`${campaign.title} ${detailOpen ? "상세 닫기" : "상세"}`} aria-expanded={detailOpen} aria-controls={`campaign-detail-${campaign.id}`} onClick={() => {
                              setHistoryPending(null); setReloadPending(null);
                              setExpandedCampaignId(expandedCampaignId === campaign.id ? null : campaign.id);
                            }}>{detailOpen ? "상세 닫기" : "상세"}</ProductButton>
                          </div>
                          </td>
                    </tr>
                    <tr id={`campaign-detail-${campaign.id}`} hidden={!detailOpen} className={styles.historyDetailRow}>
                      <td colSpan={6}><div className={styles.campaignCard}>
                        {historyPending?.id === campaign.id ? (
                          <ConsoleConfirm
                            summary={confirmLines(
                              historyPending.kind === "cancel"
                                ? cancelSummary(campaign)
                                : retryAmbiguous ? "이전과 같은 요청을 다시 확인할까요?\n\n원래 요청이 처리되지 않았다면 발송이 시작될 수 있습니다. 이전 요청의 식별자와 대상을 그대로 사용합니다."
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
                          {campaign.scheduled || campaign.status === "SCHEDULED" ? <div><dt>예약 시각</dt><dd>{formatSavedSchedule(campaign.scheduled)}</dd></div> : null}
                          {campaign.scheduled ? <div><dt>예약 실행</dt><dd>{campaign.scheduleMode === "AUTO" && !campaign.simulate ? "자동 실행" : "수동 실행"}</dd></div> : null}
                          <div><dt>시도</dt><dd>{campaign.attempts}회</dd></div>
                        </dl>
                        {!campaign.simulate && ["SCHEDULED", "NEEDS_CONNECTION"].includes(campaign.status) && !campaign.recipientRoutingReviewed && !blocked ? <p className={styles.campaignHint} role="note">이전 발송 요청은 예약 당시의 참가 상태와 그룹을 확인할 수 없어 변경 여부를 자동으로 비교하지 않습니다. {campaign.status === "SCHEDULED" && campaign.scheduleMode === "AUTO" ? "자동 실행 시에도 이 비교 없이 발송될 수 있으므로 참가자 명단을 확인하세요." : "발송 실행 전에 참가자 명단을 직접 확인하세요."} <ProductLink variant="secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>참가자 명단 보기</ProductLink></p> : null}
                        {campaign.genericTransport && campaign.genericSubmissionUnconfirmed && campaign.genericAttemptActive !== false ? <p className={styles.campaignHint} role="note">이전 발송 작업이 끝났는지 확인할 수 없어 수동 기록을 잠갔습니다. 공급사 내역과 서버 운영 상태를 확인하세요.</p> : null}
                        {!campaign.genericTransport && campaign.providerKind !== "solapi" && campaign.deliveries.some(delivery => delivery.status === "SENT") ? <p className={styles.campaignHint} role="note">이전 기록의 발송 연결과 전달 근거를 확인할 수 없습니다. 공급사 내역을 확인하세요.</p> : null}
                        {["SENDING", "ACCEPTED", "SENT", "PARTIAL", "FAILED"].includes(campaign.status) && campaign.deliveries.length ? (
                          <p className={styles.campaignHint}>
                            {!campaign.genericTransport && campaign.acceptedCount !== null ? `공급사 접수 ${campaign.acceptedCount}명 · ` : ""}
                            {campaign.genericTransport ? `공급사 접수 ${campaign.deliveries.filter(delivery => delivery.status === "ACCEPTED").length}명 · 미접수 ${campaign.deliveries.filter(delivery => delivery.status === "FAILED").length}명 · 접수 미확인 ${campaign.deliveries.filter(delivery => delivery.status === "SENDING").length}명.` : `${campaign.providerKind === "solapi" ? "전달 확인" : "전달 근거 미확인"} ${campaign.deliveries.filter(delivery => delivery.status === "SENT").length}명 · 실패 ${campaign.deliveries.filter(delivery => delivery.status === "FAILED").length}명 · 확인 중 ${campaign.deliveries.filter(delivery => delivery.status !== "SENT" && delivery.status !== "FAILED").length}명.`}
                            {campaign.genericTransport ? " 이 연결에서는 실제 단말 전달을 조회하지 않습니다." : ""}
                            {campaign.submissionUnconfirmed
                              ? campaign.genericTransport ? " 공급사 접수 여부는 직접 확인해야 합니다. 중복 발송하지 마세요." : " 공급사 응답을 확인하지 못했습니다. 발송 결과 확인은 접수 내역만 다시 조회합니다."
                              : resultMatchUnconfirmed ? " 공급사 내역과 명단의 연락처를 확인하세요."
                              : campaign.status === "SENDING" ? " 공급사 접수는 최종 전달과 다릅니다. 발송 결과 확인으로 다시 조회하세요." : null}
                          </p>
                        ) : null}
                        {campaign.status === "NEEDS_CONNECTION" && !invalidSchedule ? (
                          <p className={styles.campaignHint}>공급사 연결 전입니다. 재시도해도 연결되지 않으면 실제로 전송되지 않습니다.</p>
                        ) : null}
                        {campaign.status === "SENDING" && campaign.recipientChangeCount > 0 ? (
                          <p className={styles.campaignHint}>수신자 변경으로 재제출을 중단했습니다. 이전 요청의 접수 여부는 발송 공급사에서 확인하세요.</p>
                        ) : null}
                        {(campaign.ticketLinkProblemCount > 0 || campaign.ticketLinkProblemUnknown) && ["SENDING", "FAILED"].includes(campaign.status) ? <p className={styles.campaignHint} role="note">
                          {campaign.ticketLinkProblemUnknown ? "수신자와 티켓 상태를 확인할 수 없어" : `사용할 수 없는 티켓이 ${campaign.ticketLinkProblemCount}명 있어`}
                          {campaign.status === "SENDING" ? " 추가 재제출을 중단했습니다. 이전 요청은 접수됐을 수 있으므로 발송 공급사에서 확인하세요." : " 발송하지 않았습니다. 티켓을 확인한 뒤 새 발송을 검토하세요."}{" "}
                          <ProductLink variant="secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>티켓 확인이 필요한 참가자 보기</ProductLink>
                        </p> : null}
                        {campaign.alimtalkUnsupported ? <p className={styles.campaignHint} role="note">현재 발송 연결은 승인된 알림톡 템플릿을 지원하지 않아 발송하지 않았습니다. 알림톡을 지원하는 발송 연결을 확인하세요.</p> : null}
                        {campaign.mmsUnsupported ? <p className={styles.campaignHint} role="note">현재 발송 연결은 사진 문자를 지원하지 않아 발송하지 않았습니다. 사진 문자 발송이 가능한 연결을 확인하세요.</p> : null}
                        {campaign.personalizedTextTooLongCount > 0 ? <p className={styles.campaignHint} role="note">수신자 {campaign.personalizedTextTooLongCount}명의 개인화된 문자 내용이 발송 한도를 넘어 전송하지 않았습니다. 내용을 줄인 뒤 다시 검토하세요.</p> : null}
                        {campaign.smsTextProblemCount > 0 || campaign.smsTextProblemUnknown ? <p className={styles.campaignHint} role="note">{campaign.smsTextProblemUnknown ? "수신자별 문자 내용을 확인할 수 없어 발송을 보류했습니다." : `수신자 ${campaign.smsTextProblemCount}명의 문자에 지원하지 않는 문자 또는 제어문자가 있어 발송을 보류했습니다.`} {reloadable ? "기존 발송의 내용과 대상을 불러와 수정한 뒤 새 요청으로 검토하세요." : "기존 내용을 확인하고, 접수 여부가 불확실하면 공급사에서 먼저 확인하세요."}</p> : null}
                        {(charsetBlocked || campaign.submissionUnconfirmed || campaign.deliveryUnconfirmed || campaign.status === "CANCELLED") && campaign.body ? <details className={styles.deliveries}><summary>기존 내용 보기</summary><p className={styles.finalBody}>{campaign.body}</p>{!reloadable ? <p className={styles.campaignHint}>접수 여부를 확인할 수 없으면 공급사에서 먼저 확인하세요. 이 내용 보기는 발송하지 않습니다.</p> : null}</details> : null}
                        {reloadable ? (
                          <>
                            {!campaign.genericTransport && !campaign.alimtalkUnsupported && !campaign.mmsUnsupported && !campaign.ticketLinkProblemCount && !campaign.ticketLinkProblemUnknown && !campaign.personalizedTextTooLongCount ? <p className={styles.campaignHint}>{campaign.recipientChangeCount > 0
                              ? "내용·대상 불러오기를 선택하면 기존 본문과 최신 명단을 새 작성 화면에서 검토할 수 있습니다."
                              : "발송이 실패했습니다. 행의 내용·대상 불러오기로 새 발송을 준비하세요. 바로 발송되지 않습니다."}</p> : null}
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
                        {campaign.status === "SCHEDULED" && overdue && !blocked ? (
                          <p className={styles.campaignHint}>
                            {campaign.simulate
                              ? "예약 시각이 지났습니다. 발송 실행을 눌러 모의 기록을 남기세요. 실행해도 수신자에게 전달되지 않습니다."
                              : campaign.scheduleMode === "AUTO" ? "예약 시각이 지났습니다. 발송 상태와 자동 실행 설정을 확인하세요." : "예약 시각이 지났습니다. 발송 실행을 눌러 주세요."}
                          </p>
                        ) : null}
                        {blocked ? <p className={styles.campaignHint} role="note">
                          {recipientChanged
                            ? "수신자의 이름·참가 상태·그룹·연락처가 달라졌거나 확인할 수 없습니다. 기존 요청을 취소한 뒤 내용·대상을 불러와 다시 검토하세요."
                            : blocked.reason === "LUCKY_NUMBER_MISSING"
                            ? `수신자 ${blocked.missing}명의 럭키번호가 배정되지 않았습니다. 번호를 배정한 뒤 다시 확인하세요.`
                            : blocked.reason === "TICKET_UNAVAILABLE"
                            ? `티켓을 사용할 수 없는 수신자가 ${blocked.missing}명입니다. 티켓을 확인한 뒤 다시 실행하세요.`
                            : blocked.reason === "TICKET_RECIPIENTS_UNAVAILABLE" ? "수신자와 티켓 상태를 확인할 수 없습니다. 기존 요청을 취소하고 대상을 다시 선택하세요."
                            : blocked.reason === "SMS_CHARSET_UNSUPPORTED" ? `수신자 ${blocked.missing}명의 문자에 지원하지 않는 문자 또는 제어문자가 있습니다. ${campaign.status === "SCHEDULED" ? "예약을 취소한 뒤 안전하게 확인된 경우에만 내용·대상을 불러올 수 있습니다." : "기존 발송 요청의 내용을 확인하고, 접수 여부가 불확실하면 공급사에서 먼저 확인하세요."}`
                            : blocked.reason === "SMS_CHARSET_REVIEW_UNAVAILABLE" ? "수신자별 문자 내용을 확인할 수 없습니다. 기존 내용을 확인하고 운영 담당자와 대상을 다시 확인하세요. 접수 여부가 불확실하면 공급사에서 먼저 확인하세요."
                            : blocked.reason === "AUDIT_UNAVAILABLE" ? "행사 활동 기록을 확인할 수 없어 예약 발송과 취소를 할 수 없습니다. 시스템 관리자에게 문의하세요."
                            : blocked.reason === "INVALID_SCHEDULE" ? "예약 시각을 확인할 수 없습니다. 예약을 취소하고 다시 등록하세요."
                            : blocked.reason === "NO_PUBLIC_ORIGIN" ? "티켓 링크의 공개 주소가 설정되지 않았습니다. 운영 담당자에게 공개 주소 설정을 요청하세요."
                            : "발송을 실행하기 전 확인이 필요합니다. 발송 상태를 확인하고 운영 담당자에게 문의하세요."}
                          {blocked.reason === "TICKET_UNAVAILABLE" || blocked.reason === "TICKET_RECIPIENTS_UNAVAILABLE" ? <> <ProductLink variant="secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants?ticket=review`}>티켓 확인이 필요한 참가자 보기</ProductLink></> : null}
                        </p> : null}
                        {recipientChanged && detailOpen ? <RecipientChangeReview key={`${eventId}:${campaign.id}`} eventId={eventId} campaignId={campaign.id} observedAt={state.messageSchedule?.observedAt ?? ""} onRefresh={() => void refresh(true)} /> : null}
                        {["SCHEDULED", "NEEDS_CONNECTION"].includes(campaign.status) && invalidSchedule ? (
                          <p className={styles.campaignHint} role="note">예약 날짜 또는 시간대를 확인할 수 없습니다. {campaign.status === "SCHEDULED" ? "예약" : "발송 요청"}을 취소한 뒤 시각을 확인하여 다시 등록하세요.</p>
                        ) : null}
                        {campaign.status === "SCHEDULED" && !due && !blocked && hasValidScheduledInstant(campaign.scheduled) ? (
                          <p className={styles.campaignHint}>
                            {campaign.simulate
                              ? "예약 시각 이후 발송 실행을 눌러야 기록됩니다. 실행해도 수신자에게 전달되지 않습니다."
                              : scheduleModeNotice(campaign.scheduleMode)}
                          </p>
                        ) : null}
                        <details className={styles.deliveries}>
                          <summary>수신자별 처리 상태 <span>{campaign.deliveries.length}명</span></summary>
                          {campaign.deliveries.length ? (
                            <ul>
                              {campaign.deliveries.map((delivery, index) => (
                                <li key={`${delivery.participantId}-${index}`}>
                                  <span className={styles.deliveryName}>{delivery.name || "이름 미등록"}</span>
                                  <StatusPill tone={statusTone(delivery.status)}>{delivery.manualProviderReview ? `운영자 기록 · ${delivery.manualProviderReview === "ACCEPTED" ? "공급사 접수" : "공급사 미접수"}` : delivery.status === "SENT" && campaign.providerKind !== "solapi" ? "전달 근거 미확인" : delivery.resultMatchUnconfirmed ? "결과 연결 미확인" : deliveryStatusLabel(delivery.status)}</StatusPill>
                                  <time dateTime={delivery.at || undefined}>{formatDate(delivery.at)}</time>
                                  {campaign.genericTransport && campaign.genericSubmissionUnconfirmed && campaign.genericAttemptActive !== false && delivery.status === "SENDING" ? <LockedProviderReference name={delivery.name} phone={delivery.snapshotPhone} reference={delivery.reference} /> : null}
                                  {campaign.genericTransport && campaign.genericAttemptActive === false && delivery.status === "SENDING" && !delivery.manualProviderReview && !messagesLocked && !(providerCheck?.payload.id === campaign.id && providerCheck.payload.participantId === delivery.participantId) ? <ProductButton id={`provider-check-trigger-${campaign.id}-${delivery.participantId}`} type="button" variant="secondary" disabled={Boolean(providerCheck) || otherHistoryReceipt || busyAction !== null} onClick={() => {
                                    setProviderCheck({ eventId, id: commandId(), name: delivery.name, uncertain: false, payload: { id: campaign.id, participantId: delivery.participantId, outcome: "ACCEPTED", expectedSubmissionId: campaign.submissionId } });
                                    setProviderCheckChoice(""); setProviderCheckError(null); setProviderCheckConfirm(false);
                                    window.requestAnimationFrame(() => document.getElementById("provider-check-heading")?.focus());
                                  }}>{`${delivery.name} 공급사 확인 기록`}</ProductButton> : null}
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <ConsoleEmptyState kind="filtered" title="표시할 수신 처리 내역이 없습니다." />
                          )}
                        </details>
                        {providerCheck?.payload.id === campaign.id ? <section aria-label="공급사 확인 결과 기록" className={styles.providerCheck}>
                          <h4 id="provider-check-heading" tabIndex={-1}>공급사 확인 결과 기록</h4>
                          <p><strong>{providerCheck.name}</strong> · 공급사 참조 ID <code>{`${providerCheck.payload.id}:${providerCheck.payload.participantId}`}</code></p>
                          <p>공급사에서 최종 접수 또는 미접수를 직접 확인한 결과만 기록하세요. 목록에 보이지 않는 것만으로 미접수를 확정할 수 없습니다. 실제 단말 전달을 확인하는 기능은 아닙니다.</p>
                          <ConsoleChoiceGroup id="provider-check-outcome" label="공급사에서 확인한 결과" value={providerCheckChoice} disabled={Boolean(providerCheck.uncertain) || busyAction !== null} options={[
                            { value: "ACCEPTED", label: "공급사 접수 확인" }, { value: "NOT_ACCEPTED", label: "공급사 미접수 확인" },
                          ]} onChange={(value) => setProviderCheckChoice(value === "ACCEPTED" || value === "NOT_ACCEPTED" ? value : "")} />
                          {providerCheckError ? <p role="alert">{providerCheckError}</p> : null}
                          {providerCheck.uncertain ? <ProductButton type="button" variant="secondary" disabled={busyAction !== null} onClick={() => void submitProviderCheck(providerCheck)}>같은 요청 다시 확인</ProductButton> : <>
                            <ProductButton type="button" variant="secondary" disabled={!providerCheckChoice || busyAction !== null} onClick={() => setProviderCheckConfirm(true)}>기록 내용 확인</ProductButton>{" "}
                            <ProductButton type="button" variant="ghost" disabled={busyAction !== null} onClick={() => {
                              const triggerId = `provider-check-trigger-${providerCheck.payload.id}-${providerCheck.payload.participantId}`;
                              setProviderCheck(null); setProviderCheckConfirm(false);
                              window.requestAnimationFrame(() => document.getElementById(triggerId)?.focus());
                            }}>나중에 확인</ProductButton>
                            {providerCheckConfirm && providerCheckChoice ? <ConsoleConfirm summary={confirmLines(`${providerCheck.name}님의 공급사 ${providerCheckChoice === "ACCEPTED" ? "접수" : "미접수"}를 직접 확인했나요?\n\n이 결과는 운영자 확인 기록이며 실제 단말 전달을 뜻하지 않습니다. 이 동작은 메시지를 다시 보내지 않습니다.`)} confirmLabel="확인 결과 기록" busy={busyAction !== null} onCancel={() => setProviderCheckConfirm(false)} onConfirm={() => {
                              const attempt = { ...providerCheck, payload: { ...providerCheck.payload, outcome: providerCheckChoice } };
                              setProviderCheck(attempt); void submitProviderCheck(attempt);
                            }} /> : null}
                          </>}
                        </section> : null}
                      </div></td>
                    </tr>
                    </Fragment>
                  );
                })}
                </tbody>
              </table>
              </div>
              {remainingCampaigns > 0 ? (
                <ProductButton
                  id="campaign-history-more"
                  type="button"
                  variant="secondary"
                  onClick={() => {
                    pendingHistoryFocusRef.current = shownCampaigns.length;
                    setHistoryLimit((current) => current + 10);
                  }}
                >
                  {`이전 발송 더 보기 (${remainingCampaigns})`}
                </ProductButton>
              ) : null}
              </>
            ) : (
              <ConsoleEmptyState
                kind={historyQuery || historyStatus !== "ALL" || attentionOnly ? "filtered" : "empty"}
                title={historyQuery || historyStatus !== "ALL" ? "조건에 맞는 발송이 없습니다." : attentionOnly ? "확인이 필요한 발송이 없습니다." : "아직 발송 기록이 없습니다."}
                description={historyQuery || historyStatus !== "ALL" ? undefined : attentionOnly ? "전체 발송 기록에서 최근 상태를 확인할 수 있습니다." : "메시지 작성에서 첫 안내를 준비하세요."}
              />
            )}
            {historyQuery || historyStatus !== "ALL" ? <ProductButton type="button" variant="ghost" onClick={() => { setHistoryQuery(""); setHistoryStatus("ALL"); setHistoryLimit(10); }}>기록 검색·필터 초기화</ProductButton> : null}
            </details>
            <p className={`${styles.help} ${styles.historyFootnote}`}>발송 기록에는 참가자 티켓 링크가 표시되지 않습니다.</p>
            </>)}
          </ConsoleSection>
          )} />
        </>
      )}
    </ConsolePage>
  );
}
