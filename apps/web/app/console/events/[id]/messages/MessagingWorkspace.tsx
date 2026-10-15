"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../../../auth-redirect";
import ConsolePageHeader, {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../console-ui/ConsoleStatePanel";
import styles from "./MessagingWorkspace.module.css";

type Template = {
  id: string;
  name: string;
  channel: string;
  body: string;
  solapiTemplateId: string;
};
type Participant = { id: string; name: string; company: string; status: string };
type Delivery = { participantId: string; name: string; status: string; at: string };
type Campaign = {
  id: string;
  title: string;
  channel: string;
  recipientIds: string[];
  status: string;
  scheduled: string;
  at: string;
  attempts: number;
  imageName: string;
  deliveries: Delivery[];
};
type ReadyState = {
  kind: "ready";
  eventName: string;
  eventDate: string;
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
  title: "캠페인 제목",
  templateId: "승인된 알림톡 템플릿",
  imageFileId: "첨부 이미지",
  ids: "발송 대상",
  scheduled: "예약 시각",
};

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

function channelLabel(channel: string): string {
  switch (channel) {
    case "LMS": return "LMS · 장문";
    case "MMS": return "MMS · 사진";
    case "ALIMTALK": return "알림톡";
    case "SMS": return "SMS · 단문";
    default: return "채널 확인 필요";
  }
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
    title: text(item.title, "제목 없는 캠페인"),
    channel: text(item.channel, "SMS"),
    recipientIds: Array.isArray(item.recipientIds)
      ? item.recipientIds.filter((id): id is string => typeof id === "string")
      : [],
    status: text(item.status),
    scheduled: text(item.scheduled),
    at: text(item.at),
    attempts: typeof item.attempts === "number" ? item.attempts : 0,
    imageName: text(asRecord(item.image)?.name),
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
  const [state, setState] = useState<WorkspaceState>({ kind: "loading" });
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
  const [recipientQuery, setRecipientQuery] = useState("");
  const [uploadingImage, setUploadingImage] = useState(false);

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

  async function postCommand(command: string, payload: Record<string, unknown>): Promise<CommandResult> {
    const response = await fetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: commandId(), command, payload }),
    });
    const data = await response.json().catch(() => null) as unknown;
    if (!response.ok) throw new CommandFailure(serverError(data));
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
    setTemplateError(null);
    setTemplateFieldError(null);
    setTemplateNotice(null);
    setBusyAction("template");
    try {
      const payload: Record<string, unknown> = {
        name: templateDraft.name,
        channel: templateDraft.channel,
        body: templateDraft.body,
        solapiTemplateId: templateDraft.solapiTemplateId,
      };
      if (templateDraft.id) payload.id = templateDraft.id;
      const result = await postCommand("template.save", payload);
      const saved = parseTemplate(result.template);
      if (saved) {
        setTemplateDraft({ ...saved });
        setTemplateNotice("템플릿을 저장했습니다.");
      }
      await refresh(true);
    } catch (error) {
      handleCommandError(error, "template");
    } finally {
      setBusyAction(null);
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

  async function createCampaign(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCampaignError(null);
    setCampaignFieldError(null);
    setCampaignNotice(null);
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
    const actionLabel = campaignDraft.simulate
      ? "모의 발송 기록"
      : scheduledCampaign
        ? "예약 캠페인 등록"
        : "발송 요청";
    const accepted = window.confirm(
      `${selectedIds.length}명에게 ${actionLabel}을 진행할까요?\n\n` +
      (campaignDraft.simulate
        ? "모의 발송은 실제로 전달되지 않습니다."
        : scheduledCampaign
          ? "예약 시각에 발송을 시도합니다."
          : isMms
            ? "MMS 사진 문자로 발송을 시도합니다. 별도 요금이 발생하며 발송은 되돌릴 수 없습니다."
            : "공급사가 연결되어 있으면 즉시 실제 발송을 시도합니다. 발송은 되돌릴 수 없습니다.")
    );
    if (!accepted) return;

    setBusyAction("campaign");
    try {
      const payload: Record<string, unknown> = {
        ids: selectedIds,
        title: campaignDraft.title,
        channel: campaignDraft.channel,
        body: campaignDraft.body,
        simulate: campaignDraft.simulate,
      };
      if (selectedTemplateId) payload.templateId = selectedTemplateId;
      if (scheduled) payload.scheduled = scheduled;
      if (isMms) payload.imageFileId = campaignDraft.imageFileId;
      const result = await postCommand("message.create", payload);
      const created = asRecord(result.message);
      setCampaignNotice(
        campaignDraft.simulate
          ? "모의 발송을 기록했습니다. 수신자에게 전달되지 않았습니다."
          : scheduledCampaign
            ? "예약 캠페인을 등록했습니다."
            : "발송 요청을 기록했습니다. 결과는 아래 캠페인에서 확인하세요."
      );
      setCampaignDraft(EMPTY_CAMPAIGN);
      setSelectedTemplateId("");
      setSelectedIds([]);
      await refresh(true);
      if (created && typeof created.id === "string") {
        window.setTimeout(() => {
          document.getElementById(`campaign-${created.id as string}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 0);
      }
    } catch (error) {
      handleCommandError(error, "campaign");
    } finally {
      setBusyAction(null);
    }
  }

  async function retryCampaign(campaign: Campaign) {
    const accepted = window.confirm(
      "재시도하면 공급사가 연결된 경우 즉시 다시 발송합니다. 미연동이면 연결 필요 상태로 남습니다.\n발송은 되돌릴 수 없습니다. 계속할까요?"
    );
    if (!accepted) return;
    setBusyAction(`retry:${campaign.id}`);
    setCampaignError(null);
    setCampaignNotice(null);
    try {
      const result = await postCommand("message.retry", { id: campaign.id });
      const message = asRecord(result.message);
      const status = text(message?.status);
      setCampaignNotice(`재시도 결과: ${messageStatusLabel(status)}.`);
      await refresh(true);
    } catch (error) {
      const failure = error instanceof Error ? error.message : "재시도하지 못했습니다.";
      setCampaignError(failure);
    } finally {
      setBusyAction(null);
    }
  }

  async function syncCampaign(campaign: Campaign) {
    setBusyAction(`sync:${campaign.id}`);
    setCampaignError(null);
    setCampaignNotice(null);
    try {
      const result = await postCommand("message.sync", { id: campaign.id });
      const message = asRecord(result.message);
      setCampaignNotice(`발송 결과를 확인했습니다. 현재 상태: ${messageStatusLabel(text(message?.status))}.`);
      await refresh(true);
    } catch (error) {
      const failure = error instanceof Error ? error.message : "발송 결과를 확인하지 못했습니다.";
      setCampaignError(failure);
    } finally {
      setBusyAction(null);
    }
  }

  const pageHeader = (
    <ConsolePageHeader
      title={state.kind === "ready" ? state.eventName : "메시지"}
      meta={state.kind === "ready" ? formatConsoleEventMeta(state.eventMeta) : undefined}
      back={{
        href: `/console/events/${encodeURIComponent(eventId)}`,
        label: "← 운영 현황",
      }}
      actions={state.kind === "ready" ? (
        <Link
          className="button button-secondary"
          href={`/console/events/${encodeURIComponent(eventId)}/participants`}
        >
          참가자
        </Link>
      ) : null}
    />
  );

  if (state.kind === "loading") {
    return (
      <div className={styles.page}>
        {pageHeader}
        <ConsoleStatePanel
          kind="loading"
          message="메시지 정보를 불러오고 있습니다."
          onRetry={() => { void refresh(); }}
        />
      </div>
    );
  }
  if (state.kind === "failed") {
    return (
      <div className={styles.page}>
        {pageHeader}
        {/* ConsoleStatePanel dispatches eventouch:shell-reload and renders 다시 불러오기. */}
        <ConsoleStatePanel
          kind="failed"
          message={state.message}
          onRetry={() => { void refresh(); }}
        />
      </div>
    );
  }

  const activeParticipants = state.participants.filter((person) => person.status !== "CANCELLED");
  const recipientSearch = recipientQuery.trim().toLocaleLowerCase("ko-KR");
  const visibleRecipients = activeParticipants.filter((person) =>
    !recipientSearch ||
    `${person.name} ${person.company}`.toLocaleLowerCase("ko-KR").includes(recipientSearch)
  );
  const selectedCount = selectedIds.length;

  return (
    <div className={styles.page}>
      <div className={styles.pageHeading}>
        {pageHeader}
        <p className={styles.intro}>수신 대상을 확인하고 캠페인과 전달 상태를 관리합니다.</p>
      </div>

      {!state.canManage ? (
        <p className="state-error" role="alert">메시지 캠페인을 관리할 운영 권한이 없습니다.</p>
      ) : (
        <>
          <p className={styles.connectionNote}>
            <strong>발송 상태는 공급사 응답을 기준으로 표시합니다.</strong>
            공급사가 연결되지 않았으면 요청은 기록되지만 실제로 전달되지 않습니다. 모의 발송도 전달되지 않습니다.
          </p>
          {campaignNotice ? <p className="state-success" role="status">{campaignNotice}</p> : null}
          {campaignError ? <p className="state-error" role="alert">{campaignError}</p> : null}

          <div className={styles.workspace}>
            <ConsoleSection
              className={styles.panel}
              headingId="campaign-heading"
              title="메시지 작성"
              description="새 캠페인"
              action={<span className={styles.selectionCount}>{selectedCount}명 선택</span>}
              divider
            >
              <form className={styles.form} onSubmit={createCampaign}>
                <div>
                  <label htmlFor="campaign-title">캠페인 제목</label>
                  <input
                    id="campaign-title"
                    maxLength={100}
                    required
                    value={campaignDraft.title}
                    aria-invalid={campaignFieldError?.field === "title"}
                    aria-describedby={campaignFieldError?.field === "title" ? "campaign-title-error" : undefined}
                    onChange={(event) => setCampaignDraft({ ...campaignDraft, title: event.target.value })}
                  />
                  {campaignFieldError?.field === "title" ? <p className={styles.fieldError} id="campaign-title-error" role="alert">{campaignFieldError.message}</p> : null}
                </div>

                <div className={styles.twoFields}>
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
                    rows={5}
                    value={campaignDraft.body}
                    aria-invalid={campaignFieldError?.field === "body"}
                    aria-describedby={campaignFieldError?.field === "body" ? "campaign-body-error campaign-variables" : "campaign-variables"}
                    onChange={(event) => setCampaignDraft({ ...campaignDraft, body: event.target.value })}
                  />
                  <p className={styles.help} id="campaign-variables">사용 가능 변수: &#123;&#123;이름&#125;&#125;, &#123;&#123;행사명&#125;&#125;, &#123;&#123;행사일&#125;&#125;, &#123;&#123;티켓링크&#125;&#125;</p>
                  {campaignFieldError?.field === "body" ? <p className={styles.fieldError} id="campaign-body-error" role="alert">{campaignFieldError.message}</p> : null}
                </div>

                {campaignDraft.channel === "MMS" ? (
                  <div>
                    <label htmlFor="campaign-image">MMS 사진 · JPG 200KB 이하</label>
                    <input
                      id="campaign-image"
                      type="file"
                      accept="image/jpeg"
                      disabled={uploadingImage}
                      aria-invalid={campaignFieldError?.field === "imageFileId"}
                      aria-describedby={campaignFieldError?.field === "imageFileId" ? "campaign-image-error" : "campaign-image-help"}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (file) void uploadMmsImage(file);
                        event.target.value = "";
                      }}
                    />
                    <p className={styles.help} id="campaign-image-help">
                      {uploadingImage
                        ? "이미지를 올리는 중입니다."
                        : campaignDraft.imageFileId
                          ? `첨부됨: ${campaignDraft.imageName || "사진 1장"} · MMS는 별도 요금이 발생합니다.`
                          : "사진을 첨부해야 캠페인을 등록할 수 있습니다."}
                    </p>
                    {campaignFieldError?.field === "imageFileId" ? <p className={styles.fieldError} id="campaign-image-error" role="alert">{campaignFieldError.message}</p> : null}
                  </div>
                ) : null}

                <fieldset className={styles.recipientFieldset} aria-describedby={campaignFieldError?.field === "ids" ? "campaign-recipients-error" : undefined}>
                  <legend>발송 대상</legend>
                  <div className={styles.recipientTools}>
                    <span>{recipientSearch ? `검색 ${visibleRecipients.length}명` : `발송 가능 ${activeParticipants.length}명`}</span>
                    <div>
                      <button type="button" className={styles.textButton} onClick={() => setAllRecipients(true, visibleRecipients)}>표시된 대상 추가 선택</button>
                      <button type="button" className={styles.textButton} onClick={() => setAllRecipients(false, visibleRecipients)}>표시된 대상 선택 해제</button>
                    </div>
                  </div>
                  <div className={styles.recipientSearch}>
                    <label>
                      <span className="sr-only">수신자 이름·소속 검색</span>
                      <input
                        type="search"
                        placeholder="이름·소속 검색"
                        value={recipientQuery}
                        onChange={(event) => setRecipientQuery(event.target.value)}
                      />
                    </label>
                  </div>
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
                              {person.company ? `${person.company} · ` : ""}{participantStatusLabel(person.status)}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  ) : activeParticipants.length ? (
                    <p className={styles.empty}>조건에 맞는 수신자가 없습니다.</p>
                  ) : (
                    <p className={styles.empty}>등록된 참가자가 없습니다.</p>
                  )}
                  {campaignFieldError?.field === "ids" ? <p className={styles.fieldError} id="campaign-recipients-error" role="alert">{campaignFieldError.message}</p> : null}
                </fieldset>

                <div className={styles.twoFields}>
                  <div>
                    <label htmlFor="campaign-scheduled">예약 시각 · 선택</label>
                    <input
                      id="campaign-scheduled"
                      type="datetime-local"
                      value={campaignDraft.scheduled}
                      aria-invalid={campaignFieldError?.field === "scheduled"}
                      aria-describedby={campaignFieldError?.field === "scheduled" ? "campaign-scheduled-error" : undefined}
                      onChange={(event) => setCampaignDraft({ ...campaignDraft, scheduled: event.target.value })}
                    />
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
                <div className={styles.formActions}>
                  <button className="button button-primary" type="submit" disabled={busyAction !== null}>
                    {busyAction === "campaign" ? "요청 중…" : campaignDraft.simulate ? "모의 발송 기록" : campaignDraft.scheduled ? "예약 캠페인 등록" : "발송 요청"}
                  </button>
                  <span className={styles.help}>발송 요청 전 수신 인원과 내용을 확인합니다.</span>
                </div>
              </form>
            </ConsoleSection>

            <ConsoleSection
              className={styles.panel}
              headingId="templates-heading"
              title="메시지 템플릿"
              description="저장한 문구"
              divider
            >
              {templateNotice ? <p className="state-success" role="status">{templateNotice}</p> : null}
              {templateError ? <p className="state-error" role="alert">{templateError}</p> : null}
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

              <form className={styles.templateForm} onSubmit={saveTemplate}>
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
                    <option value="ALIMTALK">알림톡</option>
                  </select>
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
                    rows={4}
                    value={templateDraft.body}
                    aria-invalid={templateFieldError?.field === "body"}
                    aria-describedby={templateFieldError?.field === "body" ? "template-body-error template-variables" : "template-variables"}
                    onChange={(event) => setTemplateDraft({ ...templateDraft, body: event.target.value })}
                  />
                  <p className={styles.help} id="template-variables">사용 가능 변수: &#123;&#123;이름&#125;&#125;, &#123;&#123;행사명&#125;&#125;, &#123;&#123;행사일&#125;&#125;, &#123;&#123;티켓링크&#125;&#125;</p>
                  {templateFieldError?.field === "body" ? <p className={styles.fieldError} id="template-body-error" role="alert">{templateFieldError.message}</p> : null}
                </div>
                {templateFieldError && !FIELD_LABELS[templateFieldError.field] ? <p className={styles.fieldError} role="alert">{templateFieldError.message}</p> : null}
                <div className={styles.formActions}>
                  <button className="button button-secondary" type="submit" disabled={busyAction !== null}>
                    {busyAction === "template" ? "저장 중…" : templateDraft.id ? "템플릿 저장" : "템플릿 추가"}
                  </button>
                  {templateDraft.id ? (
                    <button type="button" className={styles.textButton} onClick={() => { setTemplateDraft(EMPTY_TEMPLATE); setTemplateFieldError(null); setTemplateError(null); setTemplateNotice(null); }}>새로 작성</button>
                  ) : null}
                </div>
              </form>
            </ConsoleSection>
          </div>

          <ConsoleSection
            className={styles.history}
            headingId="history-heading"
            title="캠페인과 수신 결과"
            description="전송 이력"
            action={(
              <button className="button button-secondary" type="button" disabled={busyAction !== null} onClick={() => void refresh(true)}>
                상태 새로고침
              </button>
            )}
            divider
          >
            <p className={styles.help}>캠페인 기록에는 참가자 티켓 링크가 표시되지 않습니다.</p>
            {state.campaigns.length ? (
              <ul className={styles.campaignList}>
                {state.campaigns.map((campaign) => {
                  const due = !campaign.scheduled || Date.parse(campaign.scheduled) <= Date.now();
                  const canRetry = campaign.status === "NEEDS_CONNECTION" || (campaign.status === "SCHEDULED" && due);
                  const canSync = campaign.status === "SENDING" || campaign.status === "PARTIAL";
                  return (
                    <li key={campaign.id} id={`campaign-${campaign.id}`}>
                      <article className={styles.campaignCard}>
                        <div className={styles.campaignTop}>
                          <div className={styles.campaignTitle}>
                            <h3>{campaign.title}</h3>
                            <span className={`${styles.status} ${statusTone(campaign.status)}`}>{messageStatusLabel(campaign.status)}</span>
                          </div>
                          <div className={styles.campaignActions}>
                            {canRetry ? (
                              <button type="button" className="button button-secondary" disabled={busyAction !== null} onClick={() => void retryCampaign(campaign)}>
                                {busyAction === `retry:${campaign.id}` ? "재시도 중…" : "재시도"}
                              </button>
                            ) : null}
                            {canSync ? (
                              <button type="button" className="button button-secondary" disabled={busyAction !== null} onClick={() => void syncCampaign(campaign)}>
                                {busyAction === `sync:${campaign.id}` ? "확인 중…" : "발송 결과 확인"}
                              </button>
                            ) : null}
                          </div>
                        </div>
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
                        {campaign.status === "SCHEDULED" && !due ? (
                          <p className={styles.campaignHint}>예약 시각이 되면 실행 요청을 할 수 있습니다.</p>
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
            ) : (
              <p className={styles.empty}>캠페인이 없습니다. 위에서 수신 대상을 선택해 첫 메시지를 준비하세요.</p>
            )}
          </ConsoleSection>
        </>
      )}
    </div>
  );
}
