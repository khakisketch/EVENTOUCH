"use client";

import ValidatedForm from "../../../ui/ValidatedForm";


import { useCallback, useEffect, useRef, useState } from "react";
import ProductLink from "../../../ui/ProductLink";
import ProductButton from "../../../ui/ProductButton";
import { fetchWithDeadline, withRequestDeadline } from "../../../../lib/request-deadline";
import styles from "./engage.module.css";
import { normalizeHomeStyle, readableInk } from "../../../../lib/attendee-home";
import EventBanner from "../EventBanner";
import AttendeeIcon, { type AttendeeIconName } from "../AttendeeIcons";
import AttendeeSurface from "../ui/AttendeeSurface";
import AttendeeStateMessage from "../ui/AttendeeStateMessage";
import AttendeeFieldError from "../ui/AttendeeFieldError";
import { AttendeeList } from "../ui/AttendeeListRow";
import AttendeeListRow from "../ui/AttendeeListRow";
import BottomAction from "../ui/BottomAction";
import { attendeeLook } from "../../../../lib/attendee-look";
import { readAttendeeTheme, type AttendeeTheme } from "../event-theme";
import { isRecoveryBlocked, useVerificationMode } from "../../../../lib/use-verification-mode";
import { readGuestReceipts, writeGuestReceipts, type GuestReceiptPointer } from "../../../../lib/receipt-recovery";
import { confirmsGuestCommand, confirmsGuestPhotoUpload } from "../../../../lib/guest-command-result";
import { useUnsavedNavigationGuard } from "../../../../lib/use-unsaved-navigation-guard";
import { allowSessionForTab, clearSessionForTab, clearTicketRejected, getAllowedTicketForTab, isTicketRejected, markTicketRejected, REJECTED_TICKET_BEARER, ticketStorageAvailable } from "../../../../lib/attendee-ticket-identity";
import { clearStoredTicket, readStoredTicket, storeTicket } from "../../../../lib/attendee-ticket-storage";
import { randomCommandId } from "../../../../lib/command-id";
import { asRecord, text } from "../../../../lib/json-guards";

// Attendee engagement screen. Reads the public projection (published
// programs only; the server filters drafts, disabled features, and other
// attendees' content) and submits through the guest command path with the
// tab-kept ticket bearer. The bearer travels in the Authorization header
// only: it is never rendered, logged, or written to persistent storage.
// The ticket screen's existing session key is reused. A separate tab-local
// receipt pointer stores only event/command identifiers, never draft text.

type PublicModule = {
  id: string;
  type: string;
  title: string;
  contentVersion: number | null;
  status: string;
  options: string[];
  questions: string[];
  revealed: boolean;
  answer: string;
  counts: number[];
  drawHistory: Array<{ id: string; at: string; winners: Array<{ name: string; company: string }> }>;
};

type PublicQuestion = {
  id: string;
  moduleId: string;
  name: string;
  text: string;
  answer: string;
  approved: boolean;
  likes: number;
  likedByMe: boolean | null;
  own: boolean;
  pendingEdit: { id: string; text: string } | null;
  editRejection: { id: string; text: string; reason: string } | null;
};

type PublicPhoto = {
  id: string;
  name: string;
  caption: string;
  status: string;
  fileId: string;
  own: boolean;
};

type PublicPost = {
  id: string;
  name: string;
  body: string;
  status: string;
  own: boolean;
};

type EngageState =
  | { kind: "loading" }
  | { kind: "missing"; eventName: string }
  | { kind: "failed"; message: string; eventName: string; hasTicket: boolean }
  | {
      kind: "ready";
      eventId: string;
      eventName: string;
      participantId: string;
      participantName: string;
      hasTicket: boolean;
      approved: boolean;
      modules: PublicModule[];
      questions: PublicQuestion[];
      photos: PublicPhoto[];
      posts: PublicPost[];
      submittedModuleIds: string[];
      // The event's own home color: the page sits on it like the attendee home.
      ground: string;
      // The banner the agency published, for the page header.
      theme: AttendeeTheme;
    };

type FormError = { form: string; field: string | null; message: string; uncertain?: boolean };
type ContentConflict = { formKey: string; moduleId: string; viewedVersion: number | null; latest: PublicModule | null; latestSubmitted: boolean; loading: boolean; error: string | null };
type DraftContentBaseline = { version: number | null; title: string; type: string };
type PreviousResponseDraft = { type: string; text: string };
type PendingCommand = {
  eventId: string;
  eventName: string;
  participantId: string;
  participantName: string;
  slug: string;
  ticket: string;
  command: string;
  payload: Record<string, unknown>;
  commandId: string;
  attempts: number;
};
type PendingPhoto = {
  eventId: string;
  moduleKey: string;
  eventName: string;
  participantId: string;
  participantName: string;
  slug: string;
  ticket: string;
  file: File;
  caption: string;
  uploadId: string;
  uploadAttempts: number;
  fileId?: string;
};

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function parseModule(value: unknown, responses: Array<{ moduleId: string }>): PublicModule | null {
  const item = asRecord(value);
  if (!item || typeof item.id !== "string" || !item.id) return null;
  if (item.published !== true || text(item.status) === "DRAFT") return null;
  const options = Array.isArray(item.options)
    ? item.options.filter((option): option is string => typeof option === "string")
    : [];
  const questions = Array.isArray(item.questions)
    ? item.questions.filter((question): question is string => typeof question === "string")
    : [];
  // New servers explicitly project 0 for legacy rows. Missing/partial data
  // must not be interpreted as version 0: an older server would ignore the
  // guard, and an incomplete definition is not something a person reviewed.
  const completeDefinition = typeof item.title === "string" && Boolean(item.title.trim()) &&
    (item.type !== "poll" || (Array.isArray(item.options) && item.options.length >= 2 && item.options.every((option) => typeof option === "string"))) &&
    (item.type !== "survey" || (Array.isArray(item.questions) && item.questions.length > 0 && item.questions.every((question) => typeof question === "string")));
  const contentVersion = completeDefinition && Number.isSafeInteger(item.contentVersion) && Number(item.contentVersion) >= 0
    ? Number(item.contentVersion) : null;
  const drawHistory = Array.isArray(item.drawHistory)
    ? item.drawHistory.flatMap((row) => {
        const result = asRecord(row);
        if (!result || typeof result.id !== "string") return [];
        const winners = Array.isArray(result.winners)
          ? result.winners.flatMap((winner) => {
              const entry = asRecord(winner);
              if (!entry) return [];
              return [{ name: text(entry.name), company: text(entry.company) }];
            })
          : [];
        return [{ id: result.id, at: text(result.at), winners }];
      })
    : [];
  return {
    id: item.id,
    type: text(item.type),
    title: text(item.title, "제목 없는 프로그램"),
    contentVersion,
    status: text(item.status),
    options,
    questions,
    revealed: item.revealed === true,
    answer: text(item.answer),
    counts: Array.isArray(item.counts)
      ? item.counts.map((count) => (typeof count === "number" ? count : 0))
      : [],
    drawHistory,
  };
}

export default function EngageClient({ slug }: { slug: string }) {
  const [state, setState] = useState<EngageState>({ kind: "loading" });
  const [contentConflicts, setContentConflicts] = useState<Record<string, ContentConflict>>({});
  const [likeConflicts, setLikeConflicts] = useState<Record<string, { loading: boolean; error: string | null }>>({});
  const likeReadsRef = useRef<Record<string, AbortController>>({});
  const contentConflictsRef = useRef<Record<string, ContentConflict>>({});
  const contentReadsRef = useRef<Record<string, AbortController>>({});
  const [draftContentBaselines, setDraftContentBaselines] = useState<Record<string, DraftContentBaseline>>({});
  const draftContentBaselinesRef = useRef<Record<string, DraftContentBaseline>>({});
  const [previousResponseDrafts, setPreviousResponseDrafts] = useState<Record<string, PreviousResponseDraft[]>>({});
  useEffect(() => {
    setContentConflicts({});
    setLikeConflicts({});
    contentConflictsRef.current = {};
    setDraftContentBaselines({});
    draftContentBaselinesRef.current = {};
    setPreviousResponseDrafts({});
    return () => {
      Object.values(contentReadsRef.current).forEach((controller) => controller.abort());
      contentReadsRef.current = {};
      Object.values(likeReadsRef.current).forEach((controller) => controller.abort());
      likeReadsRef.current = {};
    };
  }, [slug]);
  // The ticket bearer lives in tab memory only for the session lifetime.
  const ticketRef = useRef<string>("");
  const ticketSlugRef = useRef(slug);
  const liveSlugRef = useRef(slug);
  // A route change invalidates the previous effect even before its cleanup.
  liveSlugRef.current = slug;
  const commandIdsRef = useRef<Record<string, string>>({});
  // Preserve the exact id + payload after an ambiguous response. A user may
  // keep editing the visible form, but replaying that id with changed data
  // would violate the server's idempotency contract.
  const pendingCommandsRef = useRef<Record<string, PendingCommand>>({});
  const pendingPhotosRef = useRef<Record<string, PendingPhoto>>({});
  const inFlightRef = useRef<{ formKey: string; token: number } | null>(null);
  const requestEpochRef = useRef<Record<string, number>>({});
  const [pendingRevision, setPendingRevision] = useState(0);
  const [submitting, setSubmitting] = useState<string | null>(null);
  const [formError, setFormError] = useState<FormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pollChoices, setPollChoices] = useState<Record<string, string>>({});
  const [quizAnswers, setQuizAnswers] = useState<Record<string, string>>({});
  const [ratings, setRatings] = useState<Record<string, Record<string, number>>>({});
  const [surveyComments, setSurveyComments] = useState<Record<string, string>>({});
  const [questionTexts, setQuestionTexts] = useState<Record<string, string>>({});
  const [postBodies, setPostBodies] = useState<Record<string, string>>({});
  const [captions, setCaptions] = useState<Record<string, string>>({});
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [photoSelected, setPhotoSelected] = useState<Record<string, boolean>>({});
  const [editDirty, setEditDirty] = useState<Record<string, boolean>>({});
  const [receipts, setReceipts] = useState<GuestReceiptPointer[]>([]);
  const receiptsRef = useRef<GuestReceiptPointer[]>([]);
  const [receiptStorageAvailable, setReceiptStorageAvailable] = useState(true);
  const [receiptMessage, setReceiptMessage] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  const [requestedProgram, setRequestedProgram] = useState("");
  const [activeType, setActiveType] = useState("");
  // Which programs were already finished when the page first rendered them (folded below the ones to do).
  const foldedAtOpenRef = useRef<Set<string> | null>(null);
  const recoveryBlocked = isRecoveryBlocked(useVerificationMode());

  useEffect(() => {
    const value = new URLSearchParams(window.location.search).get("program") ?? "";
    setRequestedProgram(/^[A-Za-z0-9_-]{1,120}$/.test(value) ? value : "");
  }, [slug]);

  useEffect(() => {
    if (!requestedProgram || state.kind !== "ready") return;
    if (!state.modules.some((module) => module.id === requestedProgram)) {
      setNotice("선택한 프로그램은 현재 표시할 수 없습니다. 이용 가능한 프로그램을 확인하세요.");
      return;
    }
    const target = document.getElementById(`engage-${requestedProgram}`);
    if (target instanceof HTMLElement) target.focus({ preventScroll: true });
    target?.scrollIntoView({ block: "start" });
  }, [requestedProgram, state.kind]);

  useEffect(() => {
    const saved = readGuestReceipts(slug);
    receiptsRef.current = saved.items;
    setReceipts(saved.items);
    setReceiptStorageAvailable(saved.available);
  }, [slug]);

  function saveReceipts(items: GuestReceiptPointer[]) {
    receiptsRef.current = items;
    setReceipts(items);
    if (!writeGuestReceipts(slug, items)) setReceiptStorageAvailable(false);
  }

  function rememberReceipt(pending: PendingCommand) {
    if (receiptsRef.current.some((item) => item.commandId === pending.commandId)) return;
    saveReceipts([...receiptsRef.current, { eventId: pending.eventId, commandId: pending.commandId, command: pending.command }]);
  }

  function forgetReceipt(commandId: string) {
    saveReceipts(receiptsRef.current.filter((item) => item.commandId !== commandId));
  }

  const setQuestionEditDirty = useCallback((id: string, dirty: boolean) => {
    setEditDirty((current) => {
      if (Boolean(current[id]) === dirty) return current;
      const next = { ...current };
      if (dirty) next[id] = true;
      else delete next[id];
      return next;
    });
  }, []);
  const hasInput = [pollChoices, quizAnswers, surveyComments, questionTexts, postBodies, captions]
    .some((items) => Object.values(items).some((value) => value.trim() !== "")) ||
    Object.values(ratings).some((values) => Object.keys(values).length > 0) ||
    Object.values(photoSelected).some(Boolean) || Object.values(editDirty).some(Boolean);
  const hasMemoryRequest = Object.keys(pendingCommandsRef.current).length > 0 || Object.keys(pendingPhotosRef.current).length > 0;
  useUnsavedNavigationGuard(hasInput || Object.keys(previousResponseDrafts).length > 0 || Object.keys(contentConflicts).length > 0 || hasMemoryRequest || submitting !== null,
    hasMemoryRequest || submitting !== null
      ? "확인 중인 요청과 작성한 입력이 있습니다. 이동하면 이 화면에서 원래 내용을 다시 보낼 수 없습니다. 서버 처리는 취소되지 않습니다."
      : "작성 중인 입력이 있습니다. 이동하면 저장하지 않은 내용이 사라집니다.");

  function commandIdFor(key: string): string {
    if (!commandIdsRef.current[key]) commandIdsRef.current[key] = randomCommandId();
    return commandIdsRef.current[key];
  }

  function markResponseDraft(formKey: string, module: PublicModule) {
    if (draftContentBaselinesRef.current[formKey]) return;
    const next = { ...draftContentBaselinesRef.current, [formKey]: { version: module.contentVersion, title: module.title, type: module.type } };
    draftContentBaselinesRef.current = next;
    setDraftContentBaselines(next);
  }

  function responseDraftText(moduleId: string, type: string): string {
    return [
      type === "poll" && pollChoices[moduleId] ? `선택: ${pollChoices[moduleId]}` : "",
      type === "quiz" && quizAnswers[moduleId] ? `답변: ${quizAnswers[moduleId]}` : "",
      type === "qa" && questionTexts[moduleId] ? `질문: ${questionTexts[moduleId]}` : "",
      ...(type === "survey" ? Object.entries(ratings[moduleId] ?? {}).map(([question, score]) => `${question}: ${score}점`) : []),
      type === "survey" && surveyComments[moduleId] ? `의견: ${surveyComments[moduleId]}` : "",
    ].filter(Boolean).join("\n");
  }

  function clearResponseBaseline(formKey: string) {
    if (!draftContentBaselinesRef.current[formKey]) return;
    const next = { ...draftContentBaselinesRef.current };
    delete next[formKey];
    draftContentBaselinesRef.current = next;
    setDraftContentBaselines(next);
  }

  function beginRequest(formKey: string): number | null {
    if (inFlightRef.current) return null;
    const token = (requestEpochRef.current[formKey] ?? 0) + 1;
    requestEpochRef.current[formKey] = token;
    inFlightRef.current = { formKey, token };
    setSubmitting(formKey);
    return token;
  }

  function isCurrentRequest(formKey: string, token: number): boolean {
    return requestEpochRef.current[formKey] === token;
  }

  function finishRequest(formKey: string, token: number) {
    if (inFlightRef.current?.formKey !== formKey || inFlightRef.current.token !== token) return;
    inFlightRef.current = null;
    setSubmitting(null);
  }

  function abandonPending(formKey: string) {
    if (inFlightRef.current?.formKey === formKey) return;
    requestEpochRef.current[formKey] = (requestEpochRef.current[formKey] ?? 0) + 1;
    const photo = pendingPhotosRef.current[formKey];
    if (photo) {
      delete commandIdsRef.current[`upload:${photo.slug}:${formKey}`];
      delete pendingPhotosRef.current[formKey];
    }
    const pending = pendingCommandsRef.current[formKey];
    if (pending) forgetReceipt(pending.commandId);
    delete pendingCommandsRef.current[formKey];
    delete commandIdsRef.current[formKey];
    setFormError((current) => current?.form === formKey ? null : current);
    setPendingRevision((revision) => revision + 1);
    setNotice("이전 요청을 포기했습니다. 현재 입력 내용으로 새 요청을 보낼 수 있습니다.");
  }

  // Clear only the exact input that was confirmed. Other forms and any newer
  // draft remain untouched.
  function clearSubmittedDraft(pending: PendingCommand, photo?: PendingPhoto, formKey?: string) {
    const moduleId = typeof pending.payload.moduleId === "string" ? pending.payload.moduleId
      : pending.command === "post.submit" && formKey?.startsWith(`${pending.eventId}:`) ? formKey.slice(pending.eventId.length + 1) : "";
    if (pending.command === "response.submit" && moduleId) {
      if (formKey) clearResponseBaseline(formKey);
      const answer = pending.payload.answer;
      if (typeof answer === "string") {
        setPollChoices((current) => current[moduleId] === answer ? { ...current, [moduleId]: "" } : current);
        setQuizAnswers((current) => current[moduleId]?.trim() === answer ? { ...current, [moduleId]: "" } : current);
      }
      if (pending.payload.ratings && typeof pending.payload.ratings === "object") {
        const submitted = pending.payload.ratings as Record<string, unknown>;
        // Old answers to removed questions remain available while reviewing,
        // but only current questions are sent. Once those exact answers are
        // confirmed, clear the completed draft, including obsolete entries.
        setRatings((current) => Object.entries(submitted).every(([key, value]) => current[moduleId]?.[key] === value)
          ? { ...current, [moduleId]: {} } : current);
        setSurveyComments((current) => current[moduleId] === pending.payload.comment ? { ...current, [moduleId]: "" } : current);
      }
    }
    if (pending.command === "question.submit" && moduleId) {
      if (formKey) clearResponseBaseline(formKey);
      setQuestionTexts((current) => current[moduleId]?.trim() === pending.payload.text ? { ...current, [moduleId]: "" } : current);
    }
    if (pending.command === "post.submit" && moduleId) {
      setPostBodies((current) => current[moduleId]?.trim() === pending.payload.body ? { ...current, [moduleId]: "" } : current);
    }
    if (pending.command === "photo.submit" && photo) {
      setCaptions((current) => current[photo.moduleKey]?.trim() === photo.caption ? { ...current, [photo.moduleKey]: "" } : current);
      setPhotoSelected((current) => ({ ...current, [photo.moduleKey]: false }));
      const input = document.getElementById(`photo-file-${photo.moduleKey}`);
      if (input instanceof HTMLInputElement) input.value = "";
    }
  }

  async function checkReceipt(pointer: GuestReceiptPointer) {
    const key = `receipt:${pointer.commandId}`;
    const requestToken = beginRequest(key);
    if (requestToken === null) return;
    setReceiptMessage(null);
    try {
      const response = await fetch(`/api/events/${encodeURIComponent(pointer.eventId)}/command-receipts/${encodeURIComponent(pointer.commandId)}`, {
        cache: "no-store", headers: { authorization: `Bearer ${ticketRef.current}` },
      });
      const body = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (!isCurrentRequest(key, requestToken)) return;
      if (response.ok && body?.status === "APPLIED" && body.command === pointer.command) {
        const entry = Object.entries(pendingCommandsRef.current).find(([, pending]) => pending.commandId === pointer.commandId);
        if (entry) {
          const [formKey, pending] = entry;
          const photo = pendingPhotosRef.current[formKey];
          clearSubmittedDraft(pending, photo, formKey);
          delete pendingCommandsRef.current[formKey];
          delete pendingPhotosRef.current[formKey];
          delete commandIdsRef.current[formKey];
          if (photo) delete commandIdsRef.current[`upload:${photo.slug}:${formKey}`];
          setPendingRevision((revision) => revision + 1);
          setFormError((current) => current?.form === formKey ? null : current);
        }
        forgetReceipt(pointer.commandId);
        setNotice("서버에 처리가 반영된 것을 확인했습니다. 최신 내용을 다시 불러옵니다.");
        setReloadTick((tick) => tick + 1);
      } else if (response.ok && body?.status === "UNCONFIRMED") {
        setReceiptMessage("아직 서버 처리 여부를 확인할 수 없습니다. 처리 중이거나 요청이 도착하지 않았을 수 있습니다. 잠시 후 다시 확인하세요.");
      } else {
        setReceiptMessage("현재 티켓과 연결 상태를 확인할 수 없습니다. 원래 참가자의 티켓으로 다시 확인하세요.");
      }
    } catch {
      if (isCurrentRequest(key, requestToken)) setReceiptMessage("연결하지 못했습니다. 요청은 다시 보내지 않았습니다. 연결 후 결과를 확인하세요.");
    } finally { finishRequest(key, requestToken); }
  }

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const live = () => !cancelled && !controller.signal.aborted && liveSlugRef.current === slug;
    async function load() {
      if (ticketSlugRef.current !== slug) {
        ticketSlugRef.current = slug;
        ticketRef.current = "";
      }
      const query = new URLSearchParams(window.location.search);
      const fromLink = query.get("ticket") || "";
      // Consume a linked bearer once, exactly like the ticket screen: it
      // must not linger in history. Tab-kept afterwards.
      const explicitSession = !fromLink && query.get("session") === "1";
      const rejected = !fromLink && !explicitSession && (query.get("ticket-error") === "1" || isTicketRejected(slug));
      if (fromLink) { clearSessionForTab(slug); clearTicketRejected(slug); storeTicket(slug, fromLink); }
      if (fromLink) {
        query.delete("ticket");
        query.delete("ticket-error");
        query.delete("session");
        const cleaned = `${window.location.pathname}${query.toString() ? `?${query.toString()}` : ""}${window.location.hash}`;
        window.history.replaceState(null, "", cleaned);
      }
      const storageUsable = ticketStorageAvailable(slug);
      const ticket = rejected ? REJECTED_TICKET_BEARER : explicitSession ? "" : fromLink || getAllowedTicketForTab(slug) || ticketRef.current || (storageUsable ? readStoredTicket(slug) : "");
      const allowSession = !rejected && explicitSession;
      ticketRef.current = ticket;
      try {
        const publicRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}`, {
          cache: "no-store",
          signal: controller.signal,
        });
        const publicData = (await publicRes.json().catch(() => null)) as {
          event?: { id?: unknown; name?: unknown } | null;
          workspace?: Record<string, unknown> | null;
        } | null;
        if (!live()) return;
        const eventName = text(publicData?.event?.name);
        if (!publicRes.ok || !publicData?.event) {
          if (!cancelled) setState({ kind: "failed", message: "행사 정보를 불러오지 못했습니다.", eventName, hasTicket: Boolean(ticket) });
          return;
        }
        const ticketRes = await fetch(`/api/public/events/${encodeURIComponent(slug)}/ticket`, {
          ...(ticket ? { headers: { authorization: `Bearer ${ticket}` } } : {}),
          credentials: ticket || storageUsable || allowSession ? "same-origin" : "omit",
          cache: "no-store",
          signal: controller.signal,
        });
        const ticketData = (await ticketRes.json().catch(() => null)) as {
          error?: unknown;
          event?: { id?: unknown; name?: unknown } | null;
          participant?: Record<string, unknown> | null;
          workspace?: Record<string, unknown> | null;
        } | null;
        if (!live()) return;
        if (!ticketRes.ok || !ticketData?.participant || !ticketData.workspace) {
          if (ticketRes.status === 404 && ticket) {
            markTicketRejected(slug);
            clearStoredTicket(slug);
            ticketRef.current = "";
          }
          if (!cancelled) {
            if (!ticket && (ticketRes.status === 401 || ticketRes.status === 404)) {
              setState({ kind: "missing", eventName });
              return;
            }
            setState({
              kind: "failed",
              message:
                typeof ticketData?.error === "string"
                  ? ticketData.error
                  : "티켓을 확인할 수 없습니다. 운영자에게 새 링크를 요청하세요.",
              eventName,
              hasTicket: true,
            });
          }
          return;
        }
        const workspace = ticketData.workspace;
        const eventId = typeof ticketData.event?.id === "string" ? ticketData.event.id : "";
        const participant = ticketData.participant;
        const restoredTicket = ticket || text(participant.ticket);
        if (!ticket && allowSession) {
          const current = new URLSearchParams(window.location.search);
          current.delete("ticket-error"); current.delete("session");
          window.history.replaceState(null, "", `${window.location.pathname}${current.toString() ? `?${current.toString()}` : ""}${window.location.hash}`);
        }
        if (restoredTicket) {
          clearTicketRejected(slug);
          ticketRef.current = restoredTicket;
          const stored = storeTicket(slug, restoredTicket);
          if (stored && storageUsable) clearSessionForTab(slug);
          else allowSessionForTab(slug, restoredTicket);
        }
        if (!restoredTicket && !ticket) markTicketRejected(slug);
        const ownResponses: Array<{ moduleId: string }> = Array.isArray(workspace.responses)
          ? workspace.responses.flatMap((value) => {
              const item = asRecord(value);
              return item && typeof item.moduleId === "string" ? [{ moduleId: item.moduleId }] : [];
            })
          : [];
        const submittedModuleIds = [...new Set(ownResponses.map((response) => response.moduleId))];
        const modules: PublicModule[] = Array.isArray(workspace.modules)
          ? workspace.modules.flatMap((value) => {
              const parsed = parseModule(value, ownResponses);
              return parsed ? [parsed] : [];
            })
          : [];
        const questions: PublicQuestion[] = Array.isArray(workspace.questions)
          ? workspace.questions.flatMap((value) => {
              const item = asRecord(value);
              if (!item || typeof item.id !== "string") return [];
              return [{
                id: item.id,
                moduleId: text(item.moduleId),
                name: text(item.name, "이름 미등록"),
                text: text(item.text),
                answer: text(item.answer),
                approved: item.approved === true,
                likes: Number.isSafeInteger(item.likedCount) && Number(item.likedCount) >= 0 ? Number(item.likedCount)
                  : Array.isArray(item.likes) ? item.likes.length : 0,
                likedByMe: typeof item.likedByMe === "boolean" ? item.likedByMe : null,
                own: item.own === true,
                pendingEdit: (() => {
                  const edit = asRecord(item.pendingEdit);
                  return edit && typeof edit.id === "string" && typeof edit.text === "string"
                    ? { id: edit.id, text: edit.text } : null;
                })(),
                editRejection: (() => {
                  const decision = asRecord(item.editRejection);
                  return decision && typeof decision.id === "string" && typeof decision.text === "string" && typeof decision.reason === "string"
                    ? { id: decision.id, text: decision.text, reason: decision.reason } : null;
                })(),
              }];
            })
          : [];
        const photos: PublicPhoto[] = Array.isArray(workspace.photos)
          ? workspace.photos.flatMap((value) => {
              const item = asRecord(value);
              if (!item || typeof item.id !== "string") return [];
              const image = asRecord(item.image);
              if (!image) return [];
              return [{
                id: item.id,
                name: text(item.name, "이름 미등록"),
                caption: text(item.caption),
                status: text(item.status, "PENDING").toUpperCase(),
                fileId: text(image.fileId),
                own: typeof item.participantId === "string" && item.participantId === participant.id,
              }];
            })
          : [];
        const posts: PublicPost[] = Array.isArray(workspace.posts)
          ? workspace.posts.flatMap((value) => {
              const item = asRecord(value);
              if (!item || typeof item.id !== "string") return [];
              return [{
                id: item.id,
                name: text(item.name, "이름 미등록"),
                body: text(item.body),
                status: text(item.status, "PENDING"),
                own: typeof item.participantId === "string" && item.participantId === participant.id,
              }];
            })
          : [];
        if (live()) {
          setState({
            kind: "ready",
            eventId,
            eventName: text(ticketData.event?.name, eventName),
            participantId: text(participant.id),
            participantName: text(participant.name, "참가자"),
            hasTicket: true,
            approved: text(participant.status) === "APPROVED",
            modules,
            questions,
            photos,
            posts,
            submittedModuleIds,
            ground: normalizeHomeStyle((publicData.workspace?.pageExperience as { published?: { homeStyle?: unknown } } | undefined)?.published?.homeStyle).backgroundColor,
            theme: readAttendeeTheme(slug, publicData.workspace),
          });
        }
      } catch {
        if (live()) setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요.", eventName: "", hasTicket: Boolean(ticketRef.current) });
      }
    }
    void withRequestDeadline(() => load(), controller).catch(() => {
      if (!cancelled && liveSlugRef.current === slug) {
        setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요.", eventName: "", hasTicket: Boolean(ticketRef.current) });
      }
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [slug, reloadTick]);

  async function postGuestCommand(
    eventId: string,
    formKey: string,
    command: string,
    payload: Record<string, unknown>,
    commandId = commandIdFor(formKey),
    ticket = ticketRef.current
  ): Promise<Record<string, unknown>> {
    const response = await fetchWithDeadline(`/api/events/${encodeURIComponent(eventId)}/commands`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${ticket}`,
      },
      body: JSON.stringify({ commandId, command, payload }),
    });
    const data = (await response.json()) as {
      error?: unknown;
      field?: unknown;
      code?: unknown;
    } & Record<string, unknown> | null;
    if (!response.ok) {
      const message = typeof data?.error === "string" ? data.error : "요청을 처리하지 못했습니다.";
      const field = typeof data?.field === "string" ? data.field : null;
      throw { message, field, code: typeof data?.code === "string" ? data.code : null, status: response.status, uncertain: isRetryableStatus(response.status) };
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || !confirmsGuestCommand(command, data, payload, commandId)) {
      throw { message: "서버 응답을 확인하지 못했습니다. 같은 요청으로 다시 확인하세요.", field: null, uncertain: true };
    }
    return data;
  }

  async function submitGuestForm(
    eventId: string,
    formKey: string,
    command: string,
    payload: Record<string, unknown>,
    successMessage: string
  ) {
    // One in-flight submission at a time and one command id per form: a
    // lost response replays the same request instead of double-submitting.
    const requestToken = beginRequest(formKey);
    if (requestToken === null) return;
    setFormError(null);
    setNotice(null);
    try {
      const pending = pendingCommandsRef.current[formKey] ?? {
        eventId,
        eventName: state.kind === "ready" ? state.eventName : "행사",
        participantId: state.kind === "ready" ? state.participantId : "",
        participantName: state.kind === "ready" ? state.participantName : "참가자",
        slug,
        ticket: ticketRef.current,
        command,
        payload: structuredClone(payload),
        commandId: commandIdFor(formKey),
        attempts: 0,
      };
      pendingCommandsRef.current[formKey] = pending;
      rememberReceipt(pending);
      pending.attempts += 1;
      const confirmed = await postGuestCommand(pending.eventId, formKey, pending.command, pending.payload, pending.commandId, pending.ticket);
      if (!isCurrentRequest(formKey, requestToken) || pending.slug !== liveSlugRef.current) return;
      if (pending.command === "question.like" && typeof confirmed.questionId === "string" && typeof confirmed.liked === "boolean" && Number.isInteger(confirmed.likes)) {
        const questionId = confirmed.questionId, likedByMe = confirmed.liked, likes = Number(confirmed.likes);
        setState((current) => current.kind !== "ready" || current.eventId !== pending.eventId || current.participantId !== pending.participantId ? current : {
          ...current, questions: current.questions.map((question) => question.id === questionId ? { ...question, likedByMe, likes } : question),
        });
      }
      clearSubmittedDraft(pending, undefined, formKey);
      forgetReceipt(pending.commandId);
      delete pendingCommandsRef.current[formKey];
      delete commandIdsRef.current[formKey];
      setPendingRevision((revision) => revision + 1);
      setNotice(successMessage);
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      if (!isCurrentRequest(formKey, requestToken)) return;
      const failure = error as { message?: unknown; field?: unknown; code?: unknown; status?: unknown; uncertain?: boolean };
      const field = typeof failure?.field === "string" ? failure.field : null;
      // A first, non-retryable 4xx definitively rejects the command. Once an
      // attempt was ambiguous, even a later 4xx cannot prove it never committed.
      const pending = pendingCommandsRef.current[formKey];
      if (pending && pending.slug !== liveSlugRef.current) return;
      if ((pending?.command === "response.submit" || pending?.command === "question.submit") && failure.status === 409 && failure.code === "MODULE_CONTENT_CHANGED" &&
          typeof pending.payload.moduleId === "string" && Number.isSafeInteger(pending.payload.expectedContentVersion)) {
        // This guard runs after the server checks the original receipt. Even
        // after a lost response, this specific code proves no write happened.
        forgetReceipt(pending.commandId);
        delete pendingCommandsRef.current[formKey];
        delete commandIdsRef.current[formKey];
        const conflict: ContentConflict = { formKey, moduleId: pending.payload.moduleId,
          viewedVersion: Number(pending.payload.expectedContentVersion), latest: null, latestSubmitted: false, loading: false, error: null };
        contentConflictsRef.current = { ...contentConflictsRef.current, [formKey]: conflict };
        setContentConflicts(contentConflictsRef.current);
        setFormError(null);
        setPendingRevision((revision) => revision + 1);
        window.requestAnimationFrame(() => document.getElementById(`content-conflict-${pending.payload.moduleId}`)?.focus());
        return;
      }
      if (pending?.command === "question.like" && failure.status === 409 &&
          (failure.code === "QUESTION_LIKE_CHANGED" || failure.code === "QUESTION_LIKE_CONTEXT_CHANGED") &&
          typeof pending.payload.id === "string" && typeof pending.payload.expectedLiked === "boolean") {
        // The guard follows receipt lookup, so this specific conflict proves
        // even a previously uncertain request was not applied.
        const questionId = pending.payload.id;
        forgetReceipt(pending.commandId);
        delete pendingCommandsRef.current[formKey];
        delete commandIdsRef.current[formKey];
        setLikeConflicts((current) => ({ ...current, [questionId]: { loading: false, error: null } }));
        setFormError(null);
        setPendingRevision((revision) => revision + 1);
        window.requestAnimationFrame(() => document.getElementById(`like-conflict-${questionId}`)?.focus());
        return;
      }
      if (failure?.uncertain === false && pending?.attempts === 1) {
        forgetReceipt(pending.commandId);
        delete pendingCommandsRef.current[formKey];
        delete commandIdsRef.current[formKey];
      }
      setPendingRevision((revision) => revision + 1);
      const uncertain = hasPendingRecord(formKey);
      const message = uncertain ? "요청 결과를 확인하지 못했습니다. 위에서 원래 요청을 다시 확인하세요." : typeof failure?.message === "string" ? failure.message : "요청을 처리하지 못했습니다.";
      setFormError({ form: formKey, field, message, uncertain });
    } finally {
      finishRequest(formKey, requestToken);
    }
  }

  async function readLatestLike(questionId: string) {
    if (state.kind !== "ready" || likeReadsRef.current[questionId]) return;
    const { eventId, participantId } = state;
    const existingQuestion = state.questions.find((question) => question.id === questionId);
    if (!existingQuestion) return;
    const requestedSlug = slug;
    const controller = new AbortController();
    likeReadsRef.current[questionId] = controller;
    setLikeConflicts((current) => ({ ...current, [questionId]: { loading: true, error: null } }));
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const aborted = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      const reading = (async () => {
        const response = await fetch(`/api/public/events/${encodeURIComponent(requestedSlug)}/ticket`, {
          cache: "no-store", headers: { authorization: `Bearer ${ticketRef.current}` }, signal: controller.signal,
        });
        return { response, data: asRecord(await response.json()) };
      })();
      const { response, data } = await Promise.race([reading, aborted]);
      const event = asRecord(data?.event);
      const participant = asRecord(data?.participant);
      const workspace = asRecord(data?.workspace);
      const matches = Array.isArray(workspace?.questions) ? workspace.questions.filter((item) => asRecord(item)?.id === questionId) : [];
      const latest = matches.length === 1 ? asRecord(matches[0]) : null;
      if (!response.ok || event?.id !== eventId || participant?.id !== participantId || participant?.status !== "APPROVED" ||
          !latest || latest.moduleId !== existingQuestion.moduleId || latest.approved !== true ||
          typeof latest.text !== "string" || typeof latest.answer !== "string" || typeof latest.name !== "string" ||
          typeof latest.likedByMe !== "boolean" || !Array.isArray(latest.likes)) throw new Error("incomplete response");
      if (controller.signal.aborted || liveSlugRef.current !== requestedSlug || likeReadsRef.current[questionId] !== controller) return;
      const likedByMe = latest.likedByMe;
      const likes = Number.isSafeInteger(latest.likedCount) && Number(latest.likedCount) >= 0 ? Number(latest.likedCount) : latest.likes.length;
      const latestText = latest.text, latestAnswer = latest.answer, latestName = latest.name;
      setState((current) => current.kind !== "ready" || current.eventId !== eventId || current.participantId !== participantId ? current : {
        ...current, questions: current.questions.map((question) => question.id === questionId ? { ...question, text: latestText, answer: latestAnswer, name: latestName, likedByMe, likes } : question),
      });
      setLikeConflicts((current) => { const next = { ...current }; delete next[questionId]; return next; });
      setNotice(likedByMe ? "최신 질문을 확인했습니다. 현재 좋아요를 누른 상태입니다." : "최신 질문을 확인했습니다. 현재 좋아요를 누르지 않은 상태입니다.");
      window.requestAnimationFrame(() => document.getElementById(`like-${questionId}`)?.focus());
    } catch {
      if (liveSlugRef.current !== requestedSlug || likeReadsRef.current[questionId] !== controller) return;
      setLikeConflicts((current) => ({ ...current, [questionId]: { loading: false, error: "최신 좋아요 상태를 확인하지 못했습니다. 연결과 질문의 공개 상태를 확인한 뒤 다시 시도하세요." } }));
    } finally {
      window.clearTimeout(timeout);
      if (likeReadsRef.current[questionId] === controller) delete likeReadsRef.current[questionId];
    }
  }

  async function readLatestContent(formKey: string) {
    const conflict = contentConflictsRef.current[formKey];
    if (!conflict || contentReadsRef.current[formKey] || state.kind !== "ready") return;
    const eventId = state.eventId;
    const participantId = state.participantId;
    const requestedSlug = slug;
    const controller = new AbortController();
    contentReadsRef.current[formKey] = controller;
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    const update = (value: ContentConflict) => {
      contentConflictsRef.current = { ...contentConflictsRef.current, [formKey]: value };
      setContentConflicts(contentConflictsRef.current);
    };
    update({ ...conflict, latest: null, latestSubmitted: false, loading: true, error: null });
    try {
      const response = await fetch(`/api/public/events/${encodeURIComponent(requestedSlug)}/ticket`, {
        cache: "no-store", headers: { authorization: `Bearer ${ticketRef.current}` }, signal: controller.signal,
      });
      const data = asRecord(await response.json());
      const event = asRecord(data?.event);
      const participant = asRecord(data?.participant);
      const workspace = asRecord(data?.workspace);
      if (!response.ok || event?.id !== eventId || participant?.id !== participantId || participant?.status !== "APPROVED" ||
          !workspace || !Array.isArray(workspace.modules) || !Array.isArray(workspace.responses)) throw new Error("incomplete response");
      const matching = workspace.modules.filter((value) => asRecord(value)?.id === conflict.moduleId);
      const latest = matching.length === 1 ? parseModule(matching[0], []) : null;
      if (!latest || latest.contentVersion === null || (conflict.viewedVersion !== null && latest.contentVersion <= conflict.viewedVersion) ||
          !["poll", "quiz", "survey", "qa", "draw", "photo", "board"].includes(latest.type)) throw new Error("unavailable or stale response");
      const latestSubmitted = workspace.responses.some((value) => asRecord(value)?.moduleId === conflict.moduleId);
      if (controller.signal.aborted || liveSlugRef.current !== requestedSlug || contentReadsRef.current[formKey] !== controller) return;
      update({ ...conflict, latest, latestSubmitted, loading: false, error: null });
    } catch {
      if (liveSlugRef.current !== requestedSlug || contentReadsRef.current[formKey] !== controller) return;
      update({ ...conflict, latest: null, latestSubmitted: false, loading: false,
        error: "최신 참여 내용을 확인하지 못했습니다. 작성한 답변은 그대로 있습니다. 연결을 확인한 뒤 다시 시도하세요." });
    } finally {
      window.clearTimeout(timeout);
      if (contentReadsRef.current[formKey] === controller) delete contentReadsRef.current[formKey];
    }
  }

  function acceptLatestContent(formKey: string, displayedLatest?: PublicModule) {
    const baseline = draftContentBaselinesRef.current[formKey];
    const conflict = contentConflictsRef.current[formKey] ?? (displayedLatest && baseline ? {
      formKey, moduleId: displayedLatest.id, viewedVersion: baseline.version, latest: displayedLatest,
      latestSubmitted: false, loading: false, error: null,
    } : null);
    const latest = conflict?.latest;
    if (!conflict || !latest || latest.contentVersion === null || state.kind !== "ready") return;
    const current = state.modules.find((module) => module.id === latest.id);
    if (!current || (current.contentVersion !== null && current.contentVersion > latest.contentVersion)) {
      const changed = { ...conflict, latest: null, loading: false, error: "참여 내용이 다시 바뀌었습니다. 최신 내용을 다시 확인하세요." };
      contentConflictsRef.current = { ...contentConflictsRef.current, [formKey]: changed };
      setContentConflicts(contentConflictsRef.current);
      return;
    }
    if (baseline && baseline.type !== latest.type) {
      const text = responseDraftText(latest.id, baseline.type);
      if (text) setPreviousResponseDrafts((previous) => ({ ...previous,
        [formKey]: [...(previous[formKey] ?? []), { type: baseline.type, text }] }));
      // The old answer stays copyable, but must never be silently reused if
      // this program later switches back to its old type.
      if (baseline.type === "poll") setPollChoices((previous) => ({ ...previous, [latest.id]: "" }));
      if (baseline.type === "quiz") setQuizAnswers((previous) => ({ ...previous, [latest.id]: "" }));
      if (baseline.type === "qa") setQuestionTexts((previous) => ({ ...previous, [latest.id]: "" }));
      if (baseline.type === "survey") {
        setRatings((previous) => ({ ...previous, [latest.id]: {} }));
        setSurveyComments((previous) => ({ ...previous, [latest.id]: "" }));
      }
    }
    setState((previous) => previous.kind !== "ready" || previous.eventId !== state.eventId ? previous : {
      ...previous, modules: previous.modules.map((module) => module.id === latest.id &&
        (module.contentVersion === null || module.contentVersion <= latest.contentVersion!) ? latest : module),
      submittedModuleIds: conflict.latestSubmitted ? [...new Set([...previous.submittedModuleIds, latest.id])] : previous.submittedModuleIds,
    });
    const next = { ...contentConflictsRef.current };
    delete next[formKey];
    contentConflictsRef.current = next;
    setContentConflicts(next);
    const baselines = { ...draftContentBaselinesRef.current };
    if (baseline && baseline.type !== latest.type) delete baselines[formKey];
    else baselines[formKey] = { version: latest.contentVersion, title: latest.title, type: latest.type };
    draftContentBaselinesRef.current = baselines;
    setDraftContentBaselines(baselines);
    setNotice(conflict.latestSubmitted ? "이미 제출한 답변이 있습니다. 최신 내용을 확인했습니다."
      : baseline && baseline.type !== latest.type ? "이전 답변을 보관했습니다. 새 참여 내용을 확인하세요."
      : "최신 내용으로 바뀌었습니다. 입력을 확인한 뒤 직접 제출하세요.");
    window.requestAnimationFrame(() => document.getElementById(`engage-${latest.id}`)?.focus());
  }

  function formMessage(formKey: string, field: string | null): string | null {
    if (formError?.form !== formKey) return null;
    if (formError.field !== field) return null;
    return formError.message;
  }

  function generalMessage(formKey: string): string | null {
    if (formError?.form !== formKey) return null;
    if (formError.field !== null) return null;
    return formError.message;
  }

  function hasPending(formKey: string): boolean {
    return submitting !== formKey && hasPendingRecord(formKey);
  }

  function hasPendingRecord(formKey: string): boolean {
    return Boolean(pendingCommandsRef.current[formKey] || pendingPhotosRef.current[formKey]);
  }

  const pendingKeys = [...new Set([
    ...Object.keys(pendingCommandsRef.current),
    ...Object.keys(pendingPhotosRef.current),
  ])].filter((formKey) => submitting !== formKey);
  const savedReceipts = receipts.filter((pointer) => !Object.values(pendingCommandsRef.current).some((pending) => pending.commandId === pointer.commandId));
  const receiptRecovery = savedReceipts.length ? (
    <section className={styles.warning} aria-labelledby="saved-receipts-title">
      <h2 id="saved-receipts-title">서버 처리 결과 확인</h2>
      <p>응답을 받지 못한 요청의 처리 여부를 확인합니다. 확인만 하며 요청을 다시 보내지 않습니다.</p>
      {savedReceipts.map((pointer) => (
        <div key={pointer.commandId}>
          <p>{({ "response.submit": "참여 응답", "question.submit": "질문 등록", "question.edit": "질문 수정", "question.like": "좋아요", "photo.submit": "사진 등록", "post.submit": "게시글 등록" } as Record<string, string>)[pointer.command] ?? "참여 요청"}</p>
          <p className={styles.actions}>
            <ProductButton type="button" className="button button-primary" disabled={submitting !== null || !ticketRef.current} onClick={() => void checkReceipt(pointer)}>서버 처리 확인</ProductButton>
            <ProductButton type="button" className="button button-secondary" disabled={submitting !== null} onClick={() => {
              if (!window.confirm("확인 목록에서 지워도 서버 처리는 취소되지 않습니다. 이미 반영됐을 수 있습니다. 목록에서 지울까요?")) return;
              const entry = Object.entries(pendingCommandsRef.current).find(([, pending]) => pending.commandId === pointer.commandId);
              if (entry) abandonPending(entry[0]);
              else forgetReceipt(pointer.commandId);
              setReceiptMessage("확인 목록에서 지웠습니다. 서버 처리는 취소되지 않았습니다.");
            }}>목록에서 지우기</ProductButton>
          </p>
        </div>
      ))}
      {receiptMessage ? <p role="status">{receiptMessage}</p> : null}
    </section>
  ) : null;
  const pendingRecovery = pendingKeys.length ? (
    <section className={styles.warning} aria-labelledby="pending-recovery-title" data-revision={pendingRevision}>
      <h2 id="pending-recovery-title">요청 결과 확인</h2>
      <p>입력과 사진은 이 화면에서만 유지됩니다. {receiptStorageAvailable ? "새로고침 후에는 처리 여부만 확인할 수 있습니다." : "화면을 떠나기 전에 결과를 확인하세요."}</p>
      {!receiptStorageAvailable ? <p role="alert">이 브라우저에서 결과 확인 정보를 저장할 수 없습니다. 화면을 떠나기 전에 원래 요청을 확인하세요.</p> : null}
      {receiptMessage ? <p role="status">{receiptMessage}</p> : null}
      {pendingKeys.map((formKey) => {
        const pending = pendingCommandsRef.current[formKey] ?? pendingPhotosRef.current[formKey];
        if (!pending) return null;
        const commandPending = pendingCommandsRef.current[formKey];
        const pointer = commandPending && receipts.find((item) => item.commandId === commandPending.commandId);
        const visibleInCurrentList = state.kind === "ready" && state.modules.some((module) => `${state.eventId}:${module.id}` === formKey);
        return (
          <div key={formKey}>
            <p>행사 <strong>{pending.eventName || "행사"}</strong> · 참가자 <strong>{pending.participantName || "참가자"}</strong>의 요청입니다.</p>
            {!visibleInCurrentList && formError?.form === formKey ? <p role="alert">{formError.message}</p> : null}
            <p className={styles.actions}>
              {pointer ? <ProductButton type="button" className="button button-primary" disabled={submitting !== null} onClick={() => void checkReceipt(pointer)}>서버 처리 확인</ProductButton> : null}
              <ProductButton
                type="button"
                className={pointer ? "button button-secondary" : "button button-primary"}
                disabled={submitting !== null}
                onClick={() => {
                  const photo = pendingPhotosRef.current[formKey];
                  if (photo) void submitPhoto(photo.eventId, photo.moduleKey, formKey, photo.file);
                  else void submitGuestForm(pending.eventId, formKey, "", {}, "요청 결과를 확인했습니다.");
                }}
              >
                원래 요청 다시 보내기
              </ProductButton>
              <ProductButton type="button" className="button button-secondary" disabled={submitting !== null} onClick={() => abandonPending(formKey)}>
                원래 요청 포기
              </ProductButton>
            </p>
            <p>포기해도 서버 처리는 취소되지 않습니다. 이미 반영됐을 수 있습니다.</p>
          </div>
        );
      })}
    </section>
  ) : null;

  async function submitPhoto(eventId: string, moduleKey: string, formKey: string, file: File) {
    if (uploadingPhoto) return;
    const prior = pendingPhotosRef.current[formKey];
    const photo = prior ?? {
      eventId,
      moduleKey,
      eventName: state.kind === "ready" ? state.eventName : "행사",
      participantId: state.kind === "ready" ? state.participantId : "",
      participantName: state.kind === "ready" ? state.participantName : "참가자",
      slug,
      ticket: ticketRef.current,
      file,
      caption: (captions[moduleKey] ?? "").trim(),
      uploadId: commandIdFor(`upload:${slug}:${formKey}`),
      uploadAttempts: 0,
    };
    const caption = photo.caption;
    if (!caption) {
      setFormError({ form: formKey, field: "caption", message: "사진 설명을 입력하세요." });
      return;
    }
    if (!["image/png", "image/jpeg", "image/webp"].includes(photo.file.type)) {
      setFormError({ form: formKey, field: "image", message: "사진 형식을 확인하세요." });
      return;
    }
    if (photo.file.size > 600000) {
      setFormError({ form: formKey, field: "image", message: "600KB 이하 사진을 올려주세요." });
      return;
    }
    const requestToken = beginRequest(formKey);
    if (requestToken === null) return;
    pendingPhotosRef.current[formKey] = photo;
    setUploadingPhoto(true);
    setFormError(null);
    setNotice(null);
    try {
      let uploadRes: Response | null = null;
      if (!photo.fileId) {
        // Count before awaiting: a rejected fetch is itself an ambiguous
        // attempt, so a later 4xx must not erase the retry snapshot.
        photo.uploadAttempts += 1;
        const slug = photo.slug;
        uploadRes = await fetch(
          `/api/public/events/${encodeURIComponent(slug)}/files?name=${encodeURIComponent(photo.file.name)}&commandId=${encodeURIComponent(photo.uploadId)}`,
          {
            method: "POST",
            headers: {
              "content-type": photo.file.type,
              authorization: `Bearer ${photo.ticket}`,
            },
            body: photo.file,
          }
        );
        if (!isCurrentRequest(formKey, requestToken)) return;
      }
      const uploadData = photo.fileId ? null : await uploadRes!.json().catch(() => null) as {
        error?: unknown;
        file?: { fileId?: unknown; name?: unknown; type?: unknown; size?: unknown; width?: unknown; height?: unknown } | null;
      } | null;
      const fileId = photo.fileId ?? (typeof uploadData?.file?.fileId === "string" ? uploadData.file.fileId : "");
      if ((!photo.fileId && (!uploadRes!.ok || !confirmsGuestPhotoUpload(uploadData, photo.file))) || !fileId) {
        if (uploadRes && !uploadRes.ok && !isRetryableStatus(uploadRes.status) && photo.uploadAttempts === 1) {
          delete pendingPhotosRef.current[formKey];
          delete commandIdsRef.current[`upload:${photo.slug}:${formKey}`];
        }
        setFormError({
          form: formKey,
          field: "image",
          message: hasPendingRecord(formKey) ? "사진 요청 결과를 확인하지 못했습니다. 위에서 원래 요청을 다시 확인하세요." : typeof uploadData?.error === "string" ? uploadData.error : "사진을 저장하지 못했습니다.",
        });
        return;
      }
      photo.fileId = fileId;
      const commandPending = pendingCommandsRef.current[formKey] ?? {
        eventId: photo.eventId,
        eventName: photo.eventName,
        participantId: photo.participantId,
        participantName: photo.participantName,
        slug: photo.slug,
        ticket: photo.ticket,
        command: "photo.submit",
        payload: { image: { fileId }, caption },
        commandId: commandIdFor(formKey),
        attempts: 0,
      };
      pendingCommandsRef.current[formKey] = commandPending;
      rememberReceipt(commandPending);
      commandPending.attempts += 1;
      await postGuestCommand(commandPending.eventId, formKey, commandPending.command, commandPending.payload, commandPending.commandId, commandPending.ticket);
      if (!isCurrentRequest(formKey, requestToken)) return;
      clearSubmittedDraft(commandPending, photo, formKey);
      forgetReceipt(commandPending.commandId);
      delete pendingCommandsRef.current[formKey];
      delete pendingPhotosRef.current[formKey];
      delete commandIdsRef.current[formKey];
      delete commandIdsRef.current[`upload:${photo.slug}:${formKey}`];
      setNotice("사진을 공유했습니다. 운영자 승인 후 공개됩니다.");
      setReloadTick((tick) => tick + 1);
    } catch (error) {
      if (!isCurrentRequest(formKey, requestToken)) return;
      const failure = error as { message?: unknown; field?: unknown; uncertain?: boolean };
      const commandPending = pendingCommandsRef.current[formKey];
      if (failure?.uncertain === false && commandPending?.attempts === 1) {
        forgetReceipt(commandPending.commandId);
        const pendingPhoto = pendingPhotosRef.current[formKey];
        delete pendingCommandsRef.current[formKey];
        delete pendingPhotosRef.current[formKey];
        delete commandIdsRef.current[formKey];
        if (pendingPhoto) delete commandIdsRef.current[`upload:${pendingPhoto.slug}:${formKey}`];
      }
      setPendingRevision((revision) => revision + 1);
      const uncertain = hasPendingRecord(formKey);
      setFormError({ form: formKey, field: typeof failure?.field === "string" ? failure.field : null, message: uncertain ? "사진 요청 결과를 확인하지 못했습니다. 위에서 원래 요청을 다시 확인하세요." : typeof failure?.message === "string" ? failure.message : "사진 요청을 처리하지 못했습니다.", uncertain });
    } finally {
      setUploadingPhoto(false);
      finishRequest(formKey, requestToken);
    }
  }

  // a1 white ground unless the agency picked a ground color (a2). Before the first read the look is the default.
  const look = state.kind === "ready" || state.kind === "missing" || state.kind === "failed" ? attendeeLook(
    state.kind === "ready" ? state.theme.homeStyle : undefined, state.kind === "ready" ? state.theme.accent : null) : attendeeLook(undefined, null);
  const surface = (children: React.ReactNode, style?: React.CSSProperties) => (
    <AttendeeSurface as="main" id="main-content" tabIndex={-1} color={look.color} mode={look.mode} ground={look.ground} className={styles.page} style={style}>
      {children}
    </AttendeeSurface>
  );

  if (state.kind === "loading") {
    return surface(<>{receiptRecovery}{pendingRecovery}<AttendeeStateMessage kind="info" icon="clock" title="참여 콘텐츠를 불러오고 있습니다." className={styles.state} /></>);
  }

  if (state.kind === "missing") {
    return surface(
      <>
        {receiptRecovery}{pendingRecovery}
        <header className={styles.pageHeader}>
          <span className={styles.wordmark}>EVENTOUCH</span>
          <span className="eyebrow">참여 콘텐츠</span>
          {state.eventName ? <h1>{state.eventName}</h1> : null}
        </header>
        <section className={styles.noticeCard}>
          <h2>티켓이 확인되지 않습니다</h2>
          <AttendeeStateMessage kind="info" icon="ticket" title="참여 콘텐츠에는 본인 티켓이 필요합니다.">
            {recoveryBlocked
              ? "이 행사는 문자로 다시 연결할 수 없으므로 신청을 완료한 브라우저 탭을 확인하세요. 탭을 찾을 수 없다면 행사 주최 측에 문의하세요."
              : "브라우저의 탭 보관이 차단되었거나 인증 세션이 없을 수 있습니다. 신청할 때 쓴 연락처를 인증해 티켓을 다시 연결하세요."}
          </AttendeeStateMessage>
          <p className={styles.actions}>
            <ProductLink variant="ghost" href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</ProductLink>
          </p>
        </section>
        {recoveryBlocked
          ? <BottomAction label="다음 행동" primary={{ label: "참가 메뉴로", href: `/event/${encodeURIComponent(slug)}/home` }} />
          : <BottomAction label="다음 행동" primary={{ label: "내 티켓 찾기", href: `/event/${encodeURIComponent(slug)}/ticket/recover` }} secondary={{ label: "참가 메뉴로", href: `/event/${encodeURIComponent(slug)}/home` }} />}
      </>,
    );
  }

  if (state.kind === "failed") {
    return surface(
      <>
        {receiptRecovery}{pendingRecovery}
        <header className={styles.pageHeader}>
          <span className={styles.wordmark}>EVENTOUCH</span>
          <span className="eyebrow">참여 콘텐츠</span>
          {state.eventName ? <h1>{state.eventName}</h1> : null}
        </header>
        <section className={styles.noticeCard}>
          <h2>참여 콘텐츠를 열 수 없습니다</h2>
          <AttendeeStateMessage kind="error" title={state.message} />
          <p className={styles.actions}>
            <ProductLink variant="ghost" href={`/event/${encodeURIComponent(slug)}/home`}>참가 메뉴로</ProductLink>
            {state.hasTicket ? null : recoveryBlocked ? null : (
              <ProductLink variant="ghost" href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>내 티켓 찾기</ProductLink>
            )}
            <ProductLink variant="ghost" href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</ProductLink>
          </p>
        </section>
        <BottomAction label="다음 행동" primary={{ label: "다시 시도", onClick: () => { setState({ kind: "loading" }); setReloadTick((tick) => tick + 1); } }} />
      </>,
    );
  }

  // Programs are grouped by kind; the tabs show only the kinds this event has.
  const typeOrder = [...new Set(state.modules.map((module) => module.type))];
  const requestedType = state.modules.find((module) => module.id === requestedProgram)?.type;
  const currentType = typeOrder.includes(activeType) ? activeType : requestedType ?? typeOrder[0] ?? "";
  const visibleModules = state.modules.filter((module) => module.type === currentType);
  // Poll, quiz and survey are the programs an attendee answers once; the
  // count is the participant's own, from the published modules and their
  // own submissions. A closed program they never answered no longer counts.
  const answerable = state.approved ? state.modules.filter((module) => ["poll", "quiz", "survey"].includes(module.type) && (module.status !== "CLOSED" || state.submittedModuleIds.includes(module.id))) : [];
  const progressTotal = answerable.length;
  const progressDone = answerable.filter((module) => state.submittedModuleIds.includes(module.id)).length;
  // Programs to do come first; the ones the attendee had finished (a submitted poll, quiz or
  // survey) or that were closed when the page opened fold into one list below. The set is taken
  // once per page: a program answered now keeps its place with its "제출 완료" feedback in view
  // and folds away on the next visit.
  const isDone = (module: PublicModule) => module.status === "CLOSED" || (["poll", "quiz", "survey"].includes(module.type) && state.submittedModuleIds.includes(module.id));
  if (foldedAtOpenRef.current === null) foldedAtOpenRef.current = new Set(state.modules.filter(isDone).map((module) => module.id));
  const foldedAtOpen = foldedAtOpenRef.current;
  const activeModules = visibleModules.filter((module) => !foldedAtOpen.has(module.id));
  const doneModules = visibleModules.filter((module) => foldedAtOpen.has(module.id));
  const renderModule = (module: PublicModule, index: number, folded: boolean) => (
      <li key={module.id} className={styles.moduleCard}>
        <section aria-labelledby={`engage-${module.id}`}>
        <details className={styles.programDisclosure} open={requestedProgram ? module.id === requestedProgram : !folded && index === 0}>
          <summary data-disclosure-indicator=""><span className={styles.kindIcon} aria-hidden="true"><AttendeeIcon name={typeIcon(module.type)} size={22} /></span><h2 id={`engage-${module.id}`} tabIndex={-1}>{module.title}</h2><span data-state={hasPending(`${state.eventId}:${module.id}`) ? "check" : state.submittedModuleIds.includes(module.id) ? "done" : module.status === "CLOSED" ? "end" : "todo"}>{typeLabel(module.type)} · {hasPending(`${state.eventId}:${module.id}`) ? "제출 확인 필요" : state.submittedModuleIds.includes(module.id) ? "제출 완료" : module.status === "CLOSED" ? "종료" : "참여하기"}</span></summary>
        {(() => {
          const formKey = `${state.eventId}:${module.id}`;
          const responseType = ["poll", "quiz", "survey"].includes(module.type);
          const requiresContentVersion = responseType || module.type === "qa";
          const baseline = draftContentBaselines[formKey];
          const isQuestionDraft = (baseline?.type ?? module.type) === "qa";
          // A different form may have caused an unrelated refresh while
          // this answer was being written. Do not silently rebase the
          // draft onto a newer question just because that read arrived.
          const staleDraft = baseline && baseline.version !== module.contentVersion && module.contentVersion !== null;
          const conflict = contentConflicts[formKey] ?? (staleDraft ? {
            formKey, moduleId: module.id, viewedVersion: baseline.version, latest: module,
            latestSubmitted: state.submittedModuleIds.includes(module.id), loading: false, error: null,
          } : null);
          return <>
          {(previousResponseDrafts[formKey] ?? []).map((draft, index) => <PreviousResponseDraft
            key={`${draft.type}-${index}`} value={draft.text} question={draft.type === "qa"}
            onDiscard={() => setPreviousResponseDrafts((previous) => {
              const next = { ...previous };
              const remaining = (next[formKey] ?? []).filter((_, itemIndex) => itemIndex !== index);
              if (remaining.length) next[formKey] = remaining; else delete next[formKey];
              return next;
            })} />)}
          {requiresContentVersion && (module.type === "qa" || !state.submittedModuleIds.includes(module.id)) && module.contentVersion === null ? <p className={styles.warning} role="alert">
            {isQuestionDraft ? "참여 내용을 확인할 수 없어 제출을 잠시 중단했습니다. 화면을 다시 불러오거나 행사 운영자에게 문의하세요. 작성 중인 질문은 이 화면에 남아 있습니다." : "참여 내용을 확인할 수 없어 제출을 잠시 중단했습니다. 화면을 다시 불러오거나 행사 운영자에게 문의하세요. 작성 중인 답변은 이 화면에 남아 있습니다."}
          </p> : null}
          {conflict ? <section className={styles.warning} aria-labelledby={`content-conflict-${module.id}`}>
            <h3 id={`content-conflict-${module.id}`} tabIndex={-1}>참여 내용이 변경됐습니다</h3>
            <p>{isQuestionDraft ? "작성 중인 질문은 아직 제출되지 않았습니다. 입력은 그대로 있습니다. 최신 내용을 확인한 뒤 다시 제출하세요." : "작성 중인 답변은 아직 제출되지 않았습니다. 입력은 그대로 있습니다. 최신 내용을 확인한 뒤 다시 제출하세요."}</p>
            {baseline ? <p>{isQuestionDraft ? "질문을 작성할 때의 제목:" : "답변을 작성할 때의 제목:"} {baseline.title}</p> : null}
            {conflict.error ? <p role="alert">{conflict.error}</p> : null}
            {conflict.latest ? <>
              <p><strong>최신 제목:</strong> {conflict.latest.title}</p>
              {baseline && baseline.type !== conflict.latest.type ? <>
                <p>참여 유형이 {typeLabel(baseline.type)}에서 {typeLabel(conflict.latest.type)}(으)로 바뀌어 {isQuestionDraft ? "이전 질문을 제출할 수 없습니다. 필요한 경우 질문을 복사한 뒤 최신 콘텐츠를 확인하세요." : "이전 답변을 제출할 수 없습니다. 필요한 경우 답변을 복사한 뒤 최신 콘텐츠를 확인하세요."}</p>
                {responseDraftText(module.id, baseline.type) ? <PreviousResponseDraft value={responseDraftText(module.id, baseline.type)} question={isQuestionDraft} /> : null}
              </> : null}
              {conflict.latest.type === "poll" ? <><p>최신 선택지</p><ul>{conflict.latest.options.map((option, index) => <li key={`${option}-${index}`}>{option}</li>)}</ul></> : null}
              {conflict.latest.type === "survey" ? <><p>최신 설문 항목</p><ul>{conflict.latest.questions.map((question, index) => <li key={`${question}-${index}`}>{question}</li>)}</ul></> : null}
              {conflict.latest.status !== "OPEN" ? <p>{isQuestionDraft ? "현재 참여가 종료되어 질문을 제출할 수 없습니다." : "현재 참여가 종료되어 답변을 제출할 수 없습니다."}</p> : null}
              {conflict.latestSubmitted ? <p>이 참가자는 이미 답변을 제출했습니다.</p> : null}
              <ProductButton type="button" className="button button-secondary" disabled={submitting !== null} onClick={() => acceptLatestContent(formKey, conflict.latest ?? undefined)}>{baseline && baseline.type !== conflict.latest.type ? "최신 콘텐츠 보기" : isQuestionDraft ? "최신 내용으로 질문 검토" : "최신 내용으로 답변 검토"}</ProductButton>
              <p>확인만으로 제출되지 않습니다.</p>
            </> : <ProductButton type="button" className="button button-secondary" disabled={conflict.loading || submitting !== null} onClick={() => void readLatestContent(formKey)}>{conflict.loading ? "최신 내용 확인 중…" : "최신 내용 확인"}</ProductButton>}
          </section> : null}
          <ModuleSection
            formKey={formKey}
            hasPending={hasPending(formKey)}
            module={module}
            canSubmit={state.approved && !conflict && (!requiresContentVersion || (module.contentVersion !== null && module.status === "OPEN"))}
            canInteractWithQuestions={state.approved && !conflict}
            approved={state.approved}
            submitted={state.submittedModuleIds.includes(module.id)}
            questions={state.questions.filter((question) => question.moduleId === module.id)}
            photos={state.photos}
            posts={state.posts}
            slug={slug}
            eventId={state.eventId}
            submitting={submitting}
            pollChoice={pollChoices[module.id] ?? ""}
            setPollChoice={(value) => { markResponseDraft(formKey, module); setPollChoices((current) => ({ ...current, [module.id]: value })); }}
            quizAnswer={quizAnswers[module.id] ?? ""}
            setQuizAnswer={(value) => { markResponseDraft(formKey, module); setQuizAnswers((current) => ({ ...current, [module.id]: value })); }}
            ratings={ratings[module.id] ?? {}}
            setRating={(question, value) => {
              markResponseDraft(formKey, module);
              setRatings((current) => ({ ...current, [module.id]: { ...(current[module.id] ?? {}), [question]: value } }));
            }}
            surveyComment={surveyComments[module.id] ?? ""}
            setSurveyComment={(value) => { markResponseDraft(formKey, module); setSurveyComments((current) => ({ ...current, [module.id]: value })); }}
            questionText={questionTexts[module.id] ?? ""}
            setQuestionText={(value) => { markResponseDraft(formKey, module); setQuestionTexts((current) => ({ ...current, [module.id]: value })); }}
            postBody={postBodies[module.id] ?? ""}
            setPostBody={(value) => setPostBodies((current) => ({ ...current, [module.id]: value }))}
            caption={captions[module.id] ?? ""}
            setCaption={(value) => setCaptions((current) => ({ ...current, [module.id]: value }))}
            setPhotoSelected={(value) => setPhotoSelected((current) => ({ ...current, [module.id]: value }))}
            setQuestionEditDirty={setQuestionEditDirty}
            formMessage={(field) => formMessage(formKey, field)}
            generalMessage={generalMessage(formKey)}
            onSubmit={(command, payload, successMessage) => {
              if (conflict) return;
              if (command === "response.submit" || command === "question.submit") {
                const currentBaseline = draftContentBaselinesRef.current[formKey];
                if (module.contentVersion === null || conflict || module.status !== "OPEN" ||
                    (currentBaseline && currentBaseline.version !== module.contentVersion)) return;
                payload = { ...payload, expectedContentVersion: module.contentVersion };
              }
              void submitGuestForm(state.eventId, formKey, command, payload, successMessage);
            }}
            likeConflict={(questionId) => likeConflicts[questionId] ?? null}
            likePending={(questionId) => hasPending(`${formKey}:like:${questionId}`)}
            likeError={(questionId) => formError?.form === `${formKey}:like:${questionId}` ? formError.message : null}
            onReadLatestLike={(questionId) => void readLatestLike(questionId)}
            onLike={(question) => {
              if (question.likedByMe === null || likeConflicts[question.id]) return;
              const liked = !question.likedByMe;
              void submitGuestForm(state.eventId, `${formKey}:like:${question.id}`, "question.like",
                { id: question.id, expectedLiked: question.likedByMe, liked, expectedQuestionText: question.text },
                liked ? "좋아요를 눌렀습니다." : "좋아요를 취소했습니다.");
            }}
            editPending={(questionId) => hasPending(`${formKey}:edit:${questionId}`)}
            editError={(questionId) => formError?.form === `${formKey}:edit:${questionId}` ? formError.message : null}
            onEditQuestion={(question, value) => {
              const editKey = `${formKey}:edit:${question.id}`;
              void submitGuestForm(state.eventId, editKey, "question.edit", {
                id: question.id, text: value.trim(), expectedText: question.text,
                expectedPendingId: question.pendingEdit?.id ?? "", expectedApproved: question.approved,
              }, question.approved ? "수정안을 등록했습니다. 운영자 승인 후 공개됩니다." : "질문을 수정했습니다. 운영자 승인 후 공개됩니다.");
            }}
            onPhoto={(file) => void submitPhoto(state.eventId, module.id, formKey, file)}
          /></>;
        })()}
        </details>
        </section>
      </li>
  );
  return surface(
    <>
      <header className={styles.pageHeader}>
        <span className={styles.wordmark}>EVENTOUCH</span>
        <span className="eyebrow">참여 콘텐츠</span>
        <ProductLink className={styles.returnLink} href={`/event/${encodeURIComponent(slug)}/home`}>← 참가 메뉴로</ProductLink>
        <EventBanner theme={state.theme} title={state.eventName} titleAs="h1" className={styles.banner} />
      </header>
      {receiptRecovery}{pendingRecovery}

      {notice ? <AttendeeStateMessage kind="info" icon="check" title={notice} /> : null}
      {!state.approved ? (
        <AttendeeStateMessage kind="info" title="참가 확정 후 참여할 수 있습니다.">프로그램 목록은 미리 확인할 수 있습니다.</AttendeeStateMessage>
      ) : null}

      {progressTotal > 0 ? (
        <section className={styles.progress} aria-label="내 참여 현황">
          <span className={styles.progressIcon} data-done={progressDone === progressTotal || undefined}><AttendeeIcon name={progressDone === progressTotal ? "check" : "user"} size={22} /></span>
          <div className={styles.progressText}>
            <p className={styles.progressTitle}>{progressDone === progressTotal ? "모두 참여했어요" : `참여 ${progressDone}/${progressTotal}`}</p>
            <p className={styles.progressSub}>{progressDone === progressTotal ? `투표·퀴즈·만족도 ${progressTotal}개를 마쳤습니다.` : `투표·퀴즈·만족도 ${progressTotal}개 중 ${progressDone}개를 마쳤습니다.`}</p>
          </div>
          <div className={styles.progressBar} role="progressbar" aria-label="참여 완료" aria-valuemin={0} aria-valuemax={progressTotal} aria-valuenow={progressDone}><i style={{ width: `${Math.round((progressDone / progressTotal) * 100)}%` }} /></div>
        </section>
      ) : null}

      {typeOrder.length > 1 ? (
        <nav className={styles.typeTabs} aria-label="참여 종류">
          {typeOrder.map((type) => {
            const todo = state.approved && state.modules.some((module) => module.type === type && ["poll", "quiz", "survey"].includes(module.type) && module.status !== "CLOSED" && !state.submittedModuleIds.includes(module.id));
            return <button key={type} type="button" className={styles.typeTab} aria-pressed={type === currentType} onClick={() => { setActiveType(type); setNotice(null); }}>
              <AttendeeIcon name={typeIcon(type)} size={18} />{typeLabel(type)}{todo ? <span className={styles.todoDot} role="img" aria-label="아직 참여하지 않은 프로그램이 있습니다" /> : null}
            </button>;
          })}
        </nav>
      ) : null}

      {state.modules.length ? (
        <ul className={styles.moduleList}>
          {activeModules.map((module, index) => renderModule(module, index, false))}
          {doneModules.length ? (
            <li className={styles.doneGroup}>
              {/* Finished programs fold away so the ones to do stay on top. With nothing left to do the list opens
                  by itself (the programs are all there is), and a ?program= link keeps its own open. */}
              <details open={activeModules.length === 0 || doneModules.some((module) => module.id === requestedProgram) || undefined}>
                <summary data-disclosure-indicator="">완료한 참여 {doneModules.length}개</summary>
                <ul className={styles.moduleList}>
                  {doneModules.map((module, index) => renderModule(module, index, true))}
                </ul>
              </details>
            </li>
          ) : null}
        </ul>
      ) : (
        <AttendeeStateMessage kind="empty" title="게시된 프로그램이 없습니다." />
      )}

      {/* The way out: one quiet list of rows. */}
      <footer className={styles.pageFooter}>
        <AttendeeList label="다른 화면">
          {state.modules.length || pendingKeys.length || savedReceipts.length ? <AttendeeListRow icon="board" title="참가 메뉴로" href={`/event/${encodeURIComponent(slug)}/home`} /> : null}
          <AttendeeListRow icon="ticket" title="내 티켓으로 이동" href={`/event/${encodeURIComponent(slug)}/ticket`} />
          <AttendeeListRow icon="info" title="행사 안내로" href={`/event/${encodeURIComponent(slug)}`} />
        </AttendeeList>
      </footer>
    </>,
  );
}

function PreviousResponseDraft({ value, onDiscard, question = false }: { value: string; onDiscard?: () => void; question?: boolean }) {
  const input = useRef<HTMLTextAreaElement>(null);
  const [message, setMessage] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  async function copy() {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setMessage(question ? "이전 질문을 복사했습니다." : "이전 답변을 복사했습니다.");
    } catch {
      input.current?.focus();
      input.current?.select();
      setMessage("텍스트를 선택했습니다. 기기의 복사 기능을 이용하세요.");
    }
  }
  return <div className={`${styles.help} ${styles.previousResponse}`}>
    <label>{question ? "이전에 작성한 질문" : "이전에 작성한 답변"}
      <textarea ref={input} data-resize-none="true" rows={3} readOnly value={value} />
    </label>
    <p>{question ? "이 질문은 새 콘텐츠에 자동으로 제출되지 않습니다." : "이 답변은 새 콘텐츠에 자동으로 제출되지 않습니다."}</p>
    <div className={styles.actions}>
      <ProductButton type="button" className="button button-secondary" onClick={() => void copy()}>{question ? "이전 질문 복사" : "이전 답변 복사"}</ProductButton>
      {onDiscard && !confirmDiscard ? <ProductButton type="button" className="button button-secondary" onClick={() => setConfirmDiscard(true)}>{question ? "이전 질문 지우기" : "이전 답변 지우기"}</ProductButton> : null}
    </div>
    {message ? <p role="status">{message}</p> : null}
    {onDiscard && confirmDiscard ? <div role="group" aria-label={question ? "이전 질문 삭제 확인" : "이전 답변 삭제 확인"}>
      <p>{question ? "이전 질문을 지울까요? 이 화면에서 다시 볼 수 없습니다." : "이전 답변을 지울까요? 이 화면에서 다시 볼 수 없습니다."}</p>
      <ProductButton type="button" className="button button-secondary" onClick={() => { setConfirmDiscard(false); onDiscard(); }}>{question ? "질문 지우기" : "답변 지우기"}</ProductButton>{" "}
      <ProductButton type="button" className="button button-secondary" onClick={() => setConfirmDiscard(false)}>계속 보관</ProductButton>
    </div> : null}
  </div>;
}

function typeIcon(type: string): AttendeeIconName {
  switch (type) {
    case "poll": return "poll";
    case "quiz": return "quiz";
    case "survey": return "survey";
    case "qa": return "qa";
    case "photo": return "photo";
    case "board": return "board";
    case "draw": return "draw";
    default: return "info";
  }
}

function typeLabel(type: string): string {
  switch (type) {
    case "poll":
      return "투표";
    case "quiz":
      return "퀴즈";
    case "qa":
      return "Q&A";
    case "draw":
      return "추첨";
    case "survey":
      return "만족도";
    case "photo":
      return "사진 공유";
    case "board":
      return "게시판";
    default:
      return "프로그램";
  }
}

function QuestionEdit({ question, busy, pending, error, onSubmit, onDirtyChange }: {
  question: PublicQuestion;
  busy: boolean;
  pending: boolean;
  error: string | null;
  onSubmit: (value: string, baseline: PublicQuestion) => void;
  onDirtyChange: (id: string, dirty: boolean) => void;
}) {
  const source = question.pendingEdit?.text ?? question.editRejection?.text ?? question.text;
  const [value, setValue] = useState(source);
  const [baseline, setBaseline] = useState(question);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    onDirtyChange(question.id, dirty);
    return () => onDirtyChange(question.id, false);
  }, [dirty, onDirtyChange, question.id]);
  const stale = baseline.text !== question.text || baseline.approved !== question.approved ||
    (baseline.pendingEdit?.id ?? "") !== (question.pendingEdit?.id ?? "");
  useEffect(() => {
    // A confirmed submission can update the source while this disclosure
    // remains open. Adopt that result without replacing an unsent draft.
    if (stale && !busy && !pending && (!dirty || value.trim() === source)) {
      setValue(source);
      setBaseline(question);
      setDirty(false);
    }
  }, [busy, dirty, pending, question, source, stale, value]);
  const inputId = `edit-question-${question.id}`;
  return (
    <details className={styles.editDisclosure}>
      <summary data-disclosure-indicator="" onClick={(event) => {
        if (!event.currentTarget.parentElement?.hasAttribute("open") && !pending && !dirty) {
          setValue(source);
          setBaseline(question);
        }
      }}>{question.pendingEdit ? "수정안 다시 작성" : question.editRejection ? "수정안 고쳐 다시 제출" : "내 질문 수정"}</summary>
      <p className={styles.help}>{question.approved
        ? "수정안은 운영자가 승인할 때까지 다른 참가자에게 보이지 않습니다. 기존 질문과 답변은 유지됩니다."
        : "수정한 질문은 운영자 승인 후 공개됩니다."}</p>
      {dirty && stale ? (
        <div className={styles.warning} role="status">
          <p>질문 상태가 바뀌었습니다. 최신 내용을 확인하고 계속 작성하세요. 입력한 내용은 유지됩니다.</p>
          <ProductButton type="button" className="button button-secondary" disabled={busy || pending}
            onClick={() => setBaseline(question)}>현재 질문에 맞춰 계속 작성</ProductButton>
        </div>
      ) : null}
      <ValidatedForm onSubmit={(event) => {
        event.preventDefault();
        if (value.trim() && !busy && !pending && !(dirty && stale)) onSubmit(value, baseline);
      }}>
        <label htmlFor={inputId}>수정할 질문</label>
        <textarea id={inputId} data-resize-none="true" rows={3} maxLength={500} value={value}
          disabled={busy || pending} aria-invalid={Boolean(error)} aria-describedby={error ? `${inputId}-error` : undefined}
          onChange={(event) => {
            setValue(event.target.value);
            setDirty(event.target.value !== (baseline.pendingEdit?.text ?? baseline.editRejection?.text ?? baseline.text));
          }} />
        {error ? <AttendeeFieldError id={`${inputId}-error`}>{error}</AttendeeFieldError> : null}
        <ProductButton type="submit" className="button button-secondary" disabled={!value.trim() || busy || pending || (dirty && stale)}>
          {question.approved ? "수정안 제출" : "질문 저장"}
        </ProductButton>
      </ValidatedForm>
    </details>
  );
}

function ModuleSection(props: {
  formKey: string;
  hasPending: boolean;
  module: PublicModule;
  canSubmit: boolean;
  canInteractWithQuestions: boolean;
  approved: boolean;
  submitted: boolean;
  questions: PublicQuestion[];
  photos: PublicPhoto[];
  posts: PublicPost[];
  slug: string;
  eventId: string;
  submitting: string | null;
  pollChoice: string;
  setPollChoice: (value: string) => void;
  quizAnswer: string;
  setQuizAnswer: (value: string) => void;
  ratings: Record<string, number>;
  setRating: (question: string, value: number) => void;
  surveyComment: string;
  setSurveyComment: (value: string) => void;
  questionText: string;
  setQuestionText: (value: string) => void;
  postBody: string;
  setPostBody: (value: string) => void;
  caption: string;
  setCaption: (value: string) => void;
  setPhotoSelected: (value: boolean) => void;
  setQuestionEditDirty: (id: string, dirty: boolean) => void;
  formMessage: (field: string | null) => string | null;
  generalMessage: string | null;
  onSubmit: (command: string, payload: Record<string, unknown>, successMessage: string) => void;
  likeConflict: (questionId: string) => { loading: boolean; error: string | null } | null;
  likePending: (questionId: string) => boolean;
  likeError: (questionId: string) => string | null;
  onReadLatestLike: (questionId: string) => void;
  onLike: (question: PublicQuestion) => void;
  editPending: (questionId: string) => boolean;
  editError: (questionId: string) => string | null;
  onEditQuestion: (question: PublicQuestion, value: string) => void;
  onPhoto: (file: File) => void;
}) {
  const { module } = props;
  const busy = props.submitting !== null;
  return (
    <div>
      {module.type === "poll" ? (
        props.submitted ? (
          <>
            <p className={styles.submitted} role="status">이미 제출했습니다. 참여해 주셔서 감사합니다.</p>
            {(() => {
              // The counts are already public on every poll; after voting they read as bars.
              const total = module.counts.reduce((sum, count) => sum + count, 0);
              return total > 0 ? <ul className={styles.results} aria-label="투표 결과">
                {module.options.map((option, index) => {
                  const count = module.counts[index] ?? 0;
                  const percent = Math.round((count / total) * 100);
                  return <li key={`${option}-${index}`} className={styles.resultRow} data-mine={props.pollChoice === option || undefined}>
                    <i style={{ width: `${percent}%` }} aria-hidden="true" />
                    <span>{option}{props.pollChoice === option ? " · 내 선택" : ""}</span><span>{count}표 · {percent}%</span>
                  </li>;
                })}
              </ul> : null;
            })()}
          </>
        ) : (
          <ValidatedForm
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.pollChoice || !module.options.includes(props.pollChoice) || !props.canSubmit || busy || props.hasPending) return;
              props.onSubmit("response.submit", { moduleId: module.id, answer: props.pollChoice }, "투표를 제출했습니다.");
            }}
          >
            <fieldset className={styles.fieldset} disabled={!props.canSubmit || busy || props.hasPending}>
              <legend>투표 항목 선택</legend>
              {module.options.map((option, index) => (
                <label key={`${option}-${index}`} className={styles.choiceRow}>
                  <input
                    type="radio"
                    name={`poll-${module.id}`}
                    value={option}
                    checked={props.pollChoice === option}
                    onChange={() => props.setPollChoice(option)}
                  />
                  <span>{option} · {module.counts[index] ?? 0}표</span>
                </label>
              ))}
            </fieldset>
            {props.formMessage("answer") ? <AttendeeFieldError>{props.formMessage("answer")}</AttendeeFieldError> : null}
            {props.pollChoice && !module.options.includes(props.pollChoice) ? <p className={styles.help} role="status">이전에 고른 ‘{props.pollChoice}’ 선택지가 없습니다. 최신 선택지에서 다시 골라 주세요.</p> : null}
            {props.generalMessage ? <AttendeeFieldError>{props.generalMessage}</AttendeeFieldError> : null}
            <ProductButton type="submit" className="button button-primary" disabled={!props.pollChoice || !module.options.includes(props.pollChoice) || !props.canSubmit || busy || props.hasPending}>
              {props.submitting === props.formKey ? "제출 중…" : "투표하기"}
            </ProductButton>
          </ValidatedForm>
        )
      ) : null}

      {module.type === "quiz" ? (
        <>
          {module.revealed && module.answer ? <p className={styles.revealed}>공개된 정답: {module.answer}</p> : null}
          {props.submitted ? (
            <p className={styles.submitted} role="status">이미 제출했습니다. 참여해 주셔서 감사합니다.</p>
          ) : (
            <ValidatedForm
              onSubmit={(event) => {
                event.preventDefault();
                if (!props.quizAnswer.trim() || !props.canSubmit || busy || props.hasPending) return;
                props.onSubmit("response.submit", { moduleId: module.id, answer: props.quizAnswer.trim() }, "퀴즈 답안을 제출했습니다.");
              }}
            >
              <div>
                <label htmlFor={`quiz-${module.id}`}>내 답안</label>
                <input
                  id={`quiz-${module.id}`}
                  maxLength={200}
                  value={props.quizAnswer}
                  disabled={props.hasPending || busy}
                  aria-invalid={Boolean(props.formMessage("answer"))}
                  aria-describedby={props.formMessage("answer") ? `quiz-${module.id}-error` : undefined}
                  onChange={(event) => props.setQuizAnswer(event.target.value)}
                />
                {props.formMessage("answer") ? <AttendeeFieldError id={`quiz-${module.id}-error`}>{props.formMessage("answer")}</AttendeeFieldError> : null}
              </div>
              {props.generalMessage ? <AttendeeFieldError>{props.generalMessage}</AttendeeFieldError> : null}
              <ProductButton type="submit" className="button button-primary" disabled={!props.quizAnswer.trim() || !props.canSubmit || busy || props.hasPending}>
                {props.submitting === props.formKey ? "제출 중…" : "답안 제출"}
              </ProductButton>
            </ValidatedForm>
          )}
        </>
      ) : null}

      {module.type === "survey" ? (
        props.submitted ? (
          <p className={styles.submitted} role="status">이미 제출했습니다. 참여해 주셔서 감사합니다.</p>
        ) : (
          <ValidatedForm
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.canSubmit || busy || props.hasPending) return;
              props.onSubmit(
                "response.submit",
                { moduleId: module.id, ratings: Object.fromEntries(module.questions.filter((question) => Object.hasOwn(props.ratings, question)).map((question) => [question, props.ratings[question]])), comment: props.surveyComment },
                "만족도를 제출했습니다."
              );
            }}
          >
            {Object.keys(props.ratings).some((question) => !module.questions.includes(question)) ? <div className={styles.help} role="note">
              <p>이전에 작성한 항목은 최신 설문에 없어 제출되지 않습니다.</p>
              <ul>{Object.entries(props.ratings).filter(([question]) => !module.questions.includes(question)).map(([question, score]) => <li key={question}>{question}: {score}점</li>)}</ul>
            </div> : null}
            {module.questions.map((question) => (
              <fieldset key={question} className={styles.fieldset}>
                <legend>{question}</legend>
                <div className={styles.scoreRow} role="radiogroup" aria-label={`${question} 점수`}>
                  {[1, 2, 3, 4, 5].map((score) => (
                    <label key={score} className={styles.scoreChoice}>
                      <input
                        type="radio"
                        name={`survey-${module.id}-${question}`}
                        value={score}
                        checked={props.ratings[question] === score}
                        disabled={!props.canSubmit || busy || props.hasPending}
                        onChange={() => props.setRating(question, score)}
                      />
                      <span>{score}점</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ))}
            <div>
              <label htmlFor={`survey-comment-${module.id}`}>의견 · 선택</label>
              <textarea data-resize-none="true"
                id={`survey-comment-${module.id}`}
                rows={3}
                maxLength={1000}
                value={props.surveyComment}
                disabled={props.hasPending || busy}
                onChange={(event) => props.setSurveyComment(event.target.value)}
              />
            </div>
            {props.formMessage("ratings") ? <AttendeeFieldError>{props.formMessage("ratings")}</AttendeeFieldError> : null}
            {props.generalMessage ? <AttendeeFieldError>{props.generalMessage}</AttendeeFieldError> : null}
            <ProductButton type="submit" className="button button-primary" disabled={!props.canSubmit || busy || props.hasPending}>
              {props.submitting === props.formKey ? "제출 중…" : "만족도 제출"}
            </ProductButton>
          </ValidatedForm>
        )
      ) : null}

      {module.type === "qa" ? (
        <>
          <ValidatedForm
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.questionText.trim() || !props.canSubmit || busy || props.hasPending) return;
              props.onSubmit("question.submit", { moduleId: module.id, text: props.questionText.trim() }, "질문을 등록했습니다. 운영자 승인 후 공개됩니다.");
            }}
          >
            <div>
              <label htmlFor={`question-${module.id}`}>질문하기</label>
              <textarea data-resize-none="true"
                id={`question-${module.id}`}
                rows={3}
                maxLength={500}
                value={props.questionText}
                disabled={props.hasPending || busy}
                aria-invalid={Boolean(props.formMessage("text"))}
                aria-describedby={props.formMessage("text") ? `question-${module.id}-error` : undefined}
                onChange={(event) => props.setQuestionText(event.target.value)}
              />
              {props.formMessage("text") ? <AttendeeFieldError id={`question-${module.id}-error`}>{props.formMessage("text")}</AttendeeFieldError> : null}
            </div>
            {props.generalMessage ? <AttendeeFieldError>{props.generalMessage}</AttendeeFieldError> : null}
            <ProductButton type="submit" className="button button-primary" disabled={!props.questionText.trim() || !props.canSubmit || busy || props.hasPending}>
              {props.submitting === props.formKey ? "제출 중…" : "질문 등록"}
            </ProductButton>
          </ValidatedForm>
          {props.questions.length ? (
            <ul className={styles.entryList}>
              {props.questions.map((question) => (
                <li key={question.id}>
                  <p><strong>{question.name}</strong> · {question.text}</p>
                  {question.answer ? <p className={styles.answer}>답변: {question.answer}</p> : null}
                  {question.own && question.pendingEdit ? <p className={styles.help}>수정안 승인 대기: {question.pendingEdit.text}</p> : null}
                  {question.own && question.editRejection ? (
                    <div className={styles.help}>
                      <p><strong>수정안이 반려되었습니다.</strong> 기존 질문과 답변은 그대로 공개됩니다.</p>
                      <p>반려 사유: {question.editRejection.reason}</p>
                      <p>반려된 수정안: {question.editRejection.text}</p>
                    </div>
                  ) : null}
                  <p className={styles.entryMeta}>
                    {question.approved ? "공개됨" : "승인 대기 중"} · {props.likeConflict(question.id) || props.likePending(question.id) ? "좋아요 상태 확인 필요" : `좋아요 ${question.likes}개`}
                    {question.approved && props.canInteractWithQuestions ? (
                      <ProductButton
                        type="button"
                        id={`like-${question.id}`}
                        className={styles.inlineButton}
                        aria-pressed={question.likedByMe === null || props.likeConflict(question.id) || props.likePending(question.id) ? undefined : question.likedByMe}
                        disabled={busy || props.hasPending || props.likePending(question.id) || question.likedByMe === null || Boolean(props.likeConflict(question.id))}
                        onClick={() => props.onLike(question)}
                      >
                        좋아요{question.likedByMe && !props.likeConflict(question.id) && !props.likePending(question.id) ? " · 누름" : ""}
                      </ProductButton>
                    ) : null}
                  </p>
                  {question.approved && props.canInteractWithQuestions && question.likedByMe === null ? <p className={styles.help}>좋아요 상태를 확인할 수 없습니다. 화면을 다시 불러오거나 행사 운영자에게 문의하세요.</p> : null}
                  {props.likeError(question.id) ? <AttendeeFieldError>{props.likeError(question.id)}</AttendeeFieldError> : null}
                  {props.likeConflict(question.id) ? <div className={styles.help}>
                    <p id={`like-conflict-${question.id}`} tabIndex={-1} role="status">질문 또는 좋아요 상태가 바뀌었습니다. 위 질문은 확인 전 내용입니다. 최신 내용을 먼저 확인하세요.</p>
                    {props.likeConflict(question.id)?.error ? <p role="alert">{props.likeConflict(question.id)?.error}</p> : null}
                    <ProductButton type="button" className="button button-secondary" disabled={busy || props.likeConflict(question.id)?.loading}
                      onClick={() => props.onReadLatestLike(question.id)}>{props.likeConflict(question.id)?.loading ? "확인 중…" : "최신 질문과 좋아요 확인"}</ProductButton>
                  </div> : null}
                  {question.own && props.canInteractWithQuestions && module.status === "OPEN" ? (
                    <QuestionEdit question={question} busy={busy} pending={props.editPending(question.id)}
                      error={props.editError(question.id)} onDirtyChange={props.setQuestionEditDirty}
                      onSubmit={(value, baseline) => props.onEditQuestion(baseline, value)} />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.help}>아직 공개된 질문이 없습니다.</p>
          )}
        </>
      ) : null}

      {module.type === "photo" ? (
        <>
          <ValidatedForm
            onSubmit={(event) => {
              event.preventDefault();
              const file = (event.currentTarget.elements.namedItem(`photo-file-${module.id}`) as HTMLInputElement | null)?.files?.[0];
              if (!file || !props.canSubmit || props.hasPending) return;
              props.onPhoto(file);
            }}
          >
            <div>
              <label htmlFor={`photo-file-${module.id}`}>사진 선택 · 600KB 이하</label>
              <input id={`photo-file-${module.id}`} name={`photo-file-${module.id}`} type="file" accept="image/png,image/jpeg,image/webp" disabled={!props.canSubmit || busy || props.hasPending}
                onChange={(event) => props.setPhotoSelected(Boolean(event.currentTarget.files?.length))} />
              {props.formMessage("image") ? <AttendeeFieldError>{props.formMessage("image")}</AttendeeFieldError> : null}
            </div>
            <div>
              <label htmlFor={`photo-caption-${module.id}`}>사진 설명</label>
              <input
                id={`photo-caption-${module.id}`}
                maxLength={300}
                value={props.caption}
                disabled={props.hasPending || busy}
                aria-invalid={Boolean(props.formMessage("caption"))}
                aria-describedby={props.formMessage("caption") ? `photo-caption-${module.id}-error` : undefined}
                onChange={(event) => props.setCaption(event.target.value)}
              />
              {props.formMessage("caption") ? <AttendeeFieldError id={`photo-caption-${module.id}-error`}>{props.formMessage("caption")}</AttendeeFieldError> : null}
            </div>
            {props.generalMessage ? <AttendeeFieldError>{props.generalMessage}</AttendeeFieldError> : null}
            <ProductButton type="submit" className="button button-primary" disabled={!props.canSubmit || busy || props.hasPending}>
              {props.submitting === props.formKey ? "제출 중…" : "사진 공유"}
            </ProductButton>
          </ValidatedForm>
          {props.photos.length ? (
            <ul className={styles.photoGrid}>
              {props.photos.map((photo) => (
                <li key={photo.id}>
                  {photo.status === "APPROVED" && photo.fileId ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={`/api/public/events/${encodeURIComponent(props.slug)}/files/${encodeURIComponent(photo.fileId)}`}
                      alt={photo.caption || "참가자가 공유한 사진"}
                      loading="lazy"
                    />
                  ) : null}
                  <p><strong>{photo.name}</strong> · {photo.caption}</p>
                  {photo.status === "PENDING" ? <p className={styles.entryMeta}>운영자 승인 대기 중</p> : null}
                  {photo.status === "HIDDEN" ? <p className={styles.entryMeta}>비공개 처리됨</p> : null}
                  {!['APPROVED', 'PENDING', 'HIDDEN'].includes(photo.status) ? <p className={styles.entryMeta}>비공개</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.help}>아직 공유된 사진이 없습니다.</p>
          )}
        </>
      ) : null}

      {module.type === "board" ? (
        <>
          <ValidatedForm
            onSubmit={(event) => {
              event.preventDefault();
              if (!props.postBody.trim() || !props.canSubmit || busy || props.hasPending) return;
              props.onSubmit("post.submit", { body: props.postBody.trim() }, "게시글을 등록했습니다. 운영자 승인 후 공개됩니다.");
            }}
          >
            <div>
              <label htmlFor={`post-${module.id}`}>게시글 작성</label>
              <textarea data-resize-none="true"
                id={`post-${module.id}`}
                rows={3}
                maxLength={500}
                value={props.postBody}
                disabled={props.hasPending || busy}
                aria-invalid={Boolean(props.formMessage("body"))}
                aria-describedby={props.formMessage("body") ? `post-${module.id}-error` : undefined}
                onChange={(event) => props.setPostBody(event.target.value)}
              />
              {props.formMessage("body") ? <AttendeeFieldError id={`post-${module.id}-error`}>{props.formMessage("body")}</AttendeeFieldError> : null}
            </div>
            {props.generalMessage ? <AttendeeFieldError>{props.generalMessage}</AttendeeFieldError> : null}
            <ProductButton type="submit" className="button button-primary" disabled={!props.postBody.trim() || !props.canSubmit || busy || props.hasPending}>
              {props.submitting === props.formKey ? "제출 중…" : "게시글 등록"}
            </ProductButton>
          </ValidatedForm>
          {props.posts.length ? (
            <ul className={styles.entryList}>
              {props.posts.map((post) => (
                <li key={post.id}>
                  <p><strong>{post.name}</strong> · {post.body}</p>
                  {post.status !== "APPROVED" ? <p className={styles.entryMeta}>승인 대기 중</p> : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.help}>아직 작성된 게시글이 없습니다.</p>
          )}
        </>
      ) : null}

      {module.type === "draw" ? (
        module.drawHistory.length ? (
          <ul className={styles.entryList}>
            {module.drawHistory.map((result) => (
              <li key={result.id}>
                <p>당첨자: {result.winners.map((winner) => winner.name || "이름 미등록").join(", ") || "당첨자 없음"}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.help}>아직 공개된 추첨 결과가 없습니다.</p>
        )
      ) : null}

      {!props.approved && ["poll", "quiz", "survey", "qa", "photo", "board"].includes(module.type) ? (
        <p className={styles.help}>참가 확정 후 제출할 수 있습니다.</p>
      ) : null}
      {props.approved && !props.submitted && ["poll", "quiz", "survey"].includes(module.type) && module.status !== "OPEN" ? (
        <p className={styles.help}>현재 참여가 종료되어 답변을 제출할 수 없습니다.</p>
      ) : null}
    </div>
  );
}
