"use client";
import ProductButton from "../ui/ProductButton";

import ValidatedForm from "../ui/ValidatedForm";
import { revealDetailsFor } from "../ui/reveal-details";

import { consoleFetch as fetch } from "../../lib/console-api";
import { acknowledgeOperatorReceipt, confirmsClientSave, confirmsEventCreation, isOrganizationContextBlock, operatorFetch } from "../../lib/operator-context";
import { forgetOperatorReceipt } from "../../lib/operator-receipts";
import { useOrganizationReceipts } from "../../lib/use-organization-receipts";

import { useEffect, useRef, useState } from "react";
import styles from "./console-home.module.css";
import ConsoleDialog from "./console-ui/ConsoleDialog";
import ConsoleFormActions from "./console-ui/ConsoleFormActions";
import ui from "./console-ui/console-ui.module.css";
import { useConsoleDraftGuard } from "./console-draft-guard";
import { eventStageLabel } from "../event-stage";

type Client = { id: string; name: string };

// A duplicate candidate is any permission-available event the directory
// already loaded: no extra fetch, no new endpoint. The dialog posts to the
// source event's existing duplicate endpoint with the same data semantics
// as the former per-card duplicate (name/slug/date/times/capacity prefill,
// no clientId — the copy keeps the source's customer).
export type DuplicateCandidate = {
  id: string;
  name: string;
  slug: string;
  clientName: string;
  date: string;
  start: string;
  end: string;
  capacity: number;
  stage: string;
};
type DuplicateSource = {
  id: string;
  name: string;
  slug: string;
  clientName: string;
  date: string;
  start: string;
  end: string;
  capacity: number;
};

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function suggestedSlug(name: string, fallback: string): string {
  // Korean names cannot become URL codes directly; a Latin code (random once
  // per dialog, so the address shown while typing is the one that is sent)
  // keeps the operator moving and stays editable.
  const attempt = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  // A short or all-digit piece ("2027 …" becomes "2027", "AI 포럼" becomes "ai")
  // makes a poor, guessable address; those names get the random code instead.
  if (attempt.length >= 4 && /[a-z]/.test(attempt)) return attempt;
  return fallback;
}

function displayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value || "일정 미정";
}

const TIME_PRESETS = [
  { value: "full", label: "종일 9–18", start: "09:00", end: "18:00" },
  { value: "am", label: "오전 9–12", start: "09:00", end: "12:00" },
  { value: "pm", label: "오후 13–18", start: "13:00", end: "18:00" },
  { value: "eve", label: "저녁 18–21", start: "18:00", end: "21:00" },
] as const;
const DATE_PRESETS = [
  { value: "d1", label: "내일", days: 1, months: 0 },
  { value: "d7", label: "1주 뒤", days: 7, months: 0 },
  { value: "m1", label: "1개월 뒤", days: 0, months: 1 },
] as const;
const CAPACITY_PRESETS = ["50", "100", "300", "500"] as const;

function isoDate(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, "0");
  const day = String(value.getDate()).padStart(2, "0");
  return `${value.getFullYear()}-${month}-${day}`;
}

function shiftedDate(days: number, months: number): string {
  const next = new Date();
  next.setHours(12, 0, 0, 0);
  next.setDate(next.getDate() + days);
  if (months) next.setMonth(next.getMonth() + months);
  return isoDate(next);
}

// Days between today and the picked day, in whole local days.
function daysFromToday(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const picked = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return Math.round((picked.getTime() - today.getTime()) / 86400000);
}

function dateNote(value: string): string {
  const diff = daysFromToday(value);
  if (diff === null) return "달력에서 연도·월·일을 선택하세요.";
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)!;
  const weekday = "일월화수목금토"[new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getDay()];
  const relative = diff === 0 ? "오늘" : diff > 0 ? `${diff}일 뒤` : `${-diff}일 전`;
  return `선택한 날짜: ${displayDate(value)} (${weekday}) · ${relative}`;
}

function durationLabel(start: string, end: string): string | null {
  const from = /^(\d{2}):(\d{2})$/.exec(start);
  const to = /^(\d{2}):(\d{2})$/.exec(end);
  if (!from || !to) return null;
  const minutes = (Number(to[1]) * 60 + Number(to[2])) - (Number(from[1]) * 60 + Number(from[2]));
  if (minutes <= 0) return null;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return hours && rest ? `${hours}시간 ${rest}분` : hours ? `${hours}시간` : `${rest}분`;
}

// Native radios own selection and keyboard behavior; each choice only
// shortcuts a value the form already holds, so nothing is saved by the chip.
function QuickPick({ name, label, options, value, onPick, disabled, legendVisible = false }: {
  name: string;
  label: string;
  options: readonly { value: string; label: string }[];
  value: string;
  onPick: (value: string) => void;
  disabled?: boolean;
  legendVisible?: boolean;
}) {
  return (
    <fieldset className={styles.quickPick} disabled={disabled}>
      <legend className={legendVisible ? undefined : "sr-only"}>{label}</legend>
      {options.map((option) => (
        <label key={option.value}>
          <input type="radio" name={name} value={option.value} checked={value === option.value} onChange={() => onPick(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  );
}

export default function CreateEventDialog({
  clients,
  duplicateOf = null,
  duplicateSources = [],
  onClose,
  onCreated,
  onClientRegistered,
  onConfirmedWithoutDetails,
}: {
  clients: Client[];
  duplicateOf?: DuplicateSource | null;
  duplicateSources?: DuplicateCandidate[];
  onClose: () => void;
  onCreated: (eventId: string) => void;
  onClientRegistered?: (client: Client) => void;
  onConfirmedWithoutDetails?: () => void;
}) {
  const [name, setName] = useState(() =>
    duplicateOf ? `${duplicateOf.name.slice(0, 95)} 복사본`.trim() : ""
  );
  const [slug, setSlug] = useState(() =>
    duplicateOf
      ? `${duplicateOf.slug.slice(0, 45).replace(/-+$/, "")}-copy`
      : ""
  );
  const [clientId, setClientId] = useState("");
  const [date, setDate] = useState(() => duplicateOf?.date ?? "");
  const [start, setStart] = useState(() => duplicateOf?.start || "09:00");
  const [end, setEnd] = useState(() => duplicateOf?.end || "18:00");
  const [capacity, setCapacity] = useState(() =>
    duplicateOf && duplicateOf.capacity ? String(duplicateOf.capacity) : ""
  );
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [failure, setFailure] = useState<{ message: string; field?: string; retryable?: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [eventUncertain, setEventUncertain] = useState(false);
  const [clientUncertain, setClientUncertain] = useState(false);
  const [checkingResult, setCheckingResult] = useState(false);
  const organizationReceipts = useOrganizationReceipts();
  const [slugTouched, setSlugTouched] = useState(() => Boolean(duplicateOf));
  // Duplication lives inside this dialog now (per-card duplicate removed):
  // "새 행사" is the fastest default path with fields immediate; "기존 행사
  // 복제" reveals a stage-labeled source select over the same fields. The
  // legacy `duplicateOf` prop still forces copy mode for compatibility.
  const canOfferCopy = duplicateOf === null && duplicateSources.length > 0;
  const [mode, setMode] = useState<"new" | "copy">("new");
  const [sourceId, setSourceId] = useState("");
  const sourceSelectRef = useRef<HTMLSelectElement>(null);
  // Mode/source transitions replace the event payload, so they must never
  // run while the event write is in flight or its outcome is unresolved:
  // replacing the fields would orphan the pending idempotency receipt and
  // desync the draft from the same-request retry the failure note points
  // at. These synchronous ref gates are authoritative; the disabled
  // attributes below are only their visual voice.
  const [modeNotice, setModeNotice] = useState<string | null>(null);

  function transitionBlocked(): "inflight" | "receipt-event" | "receipt-client" | null {
    if (submitGateRef.current || submitting || clientWriteRef.current || clientSaving || checkingResult) return "inflight";
    if (commandIdRef.current) return "receipt-event";
    if (pendingClientRef.current) return "receipt-client";
    return null;
  }

  function guardTransition(): boolean {
    const blocked = transitionBlocked();
    if (!blocked) {
      setModeNotice(null);
      return true;
    }
    if (blocked === "receipt-event") {
      setModeNotice("행사 생성 결과를 아직 확인하지 못했습니다. 같은 요청으로 다시 시도해 결과를 확인한 뒤에 바꾸세요.");
    } else if (blocked === "receipt-client") {
      setModeNotice("고객사 등록 결과를 아직 확인하지 못했습니다. 같은 요청으로 다시 시도해 결과를 확인한 뒤에 바꾸세요.");
    }
    return false;
  }
  // In-dialog customer registration: a "select" view with the existing
  // dropdown, and a "create" view that posts to the same organization REST
  // path the customer directory uses. One dialog, one focus trap — never a
  // nested modal. The event draft (name/slug/date/times/capacity and the
  // pending event command id below) is untouched by this flow; a successful
  // registration only appends the new customer to the options and selects
  // it before returning to the event form.
  const [clientMode, setClientMode] = useState<"select" | "create">("select");
  const [extraClients, setExtraClients] = useState<Client[]>([]);
  const [newClientName, setNewClientName] = useState("");
  const [newClientContact, setNewClientContact] = useState("");
  const [newClientEmail, setNewClientEmail] = useState("");
  const [clientFailure, setClientFailure] = useState<{ message: string; field?: string; retryable?: boolean } | null>(null);
  const [clientSaving, setClientSaving] = useState(false);
  const [clientNotice, setClientNotice] = useState<string | null>(null);
  // An uncertain customer request keeps its original inputs and identifier.
  const pendingClientRef = useRef<{ fingerprint: string; commandId: string; uncertain: boolean } | null>(null);
  // Synchronous same-turn gate for the customer write, independent of the
  // event submit gate above.
  const clientWriteRef = useRef(false);
  const newClientNameRef = useRef<HTMLInputElement>(null);
  const clientSelectRef = useRef<HTMLSelectElement>(null);
  const registerClientRef = useRef<HTMLButtonElement>(null);
  const returnFocusToSelectRef = useRef(false);
  // One command id per distinct payload: ambiguous outcomes (5xx, 408,
  // network loss, unparseable success body) keep the id so the retry replays
  // the same request and the server receipt replays the original event
  // instead of creating a second one. Proven success and definitive 4xx
  // clear it. Never cleared on a bare HTTP response alone.
  const commandIdRef = useRef<{ fingerprint: string; commandId: string; uncertain: boolean } | null>(null);
  const otherClientReceipt = organizationReceipts.some((item) => item.command === "client.save" && item.commandId !== pendingClientRef.current?.commandId);
  const otherEventReceipt = organizationReceipts.some((item) => (item.command === "event.create" || item.command === "event.duplicate") && item.commandId !== commandIdRef.current?.commandId);
  // Auto-generated slug fallback is random for Korean names: freeze it for
  // the current inputs so a same-request retry sends the identical slug.
  const generatedSlugRef = useRef("");
  const fallbackSlugRef = useRef(`event-${Math.random().toString(36).slice(2, 8)}`);
  // Synchronous same-turn submit gate: `submitting` state flips only on
  // re-render, so a double activation in one turn would slip past it and
  // fire two fetches. Shared dialog dismissal consults the same ref.
  const submitGateRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  // A failure that names no field (a server refusal such as missing
  // permission) sits at the top of the form; bring it into view so it is
  // not hidden under a long form or a sticky footer.
  const formFailureRef = useRef<HTMLParagraphElement>(null);
  const initialFields = useRef(JSON.stringify([name, slug, clientId, date, start, end, capacity]));
  const dirty = JSON.stringify([name, slug, clientId, date, start, end, capacity]) !== initialFields.current;
  // The last applied prefill (or the blank draft) is the baseline a mode or
  // source switch compares against: switching never silently wipes a typed
  // draft — a differing draft asks first via the existing confirm gate.
  const prefillBaselineRef = useRef(initialFields.current);
  const draftDiffersFromPrefill =
    JSON.stringify([name, slug, clientId, date, start, end, capacity]) !== prefillBaselineRef.current;

  function snapshotFields(next: { name: string; slug: string; clientId: string; date: string; start: string; end: string; capacity: string }): string {
    return JSON.stringify([next.name, next.slug, next.clientId, next.date, next.start, next.end, next.capacity]);
  }

  function applySourcePrefill(source: DuplicateCandidate) {
    const next = {
      name: `${source.name.slice(0, 95)} 복사본`.trim(),
      slug: `${source.slug.slice(0, 45).replace(/-+$/, "")}-copy`,
      clientId,
      date: source.date,
      start: source.start || "09:00",
      end: source.end || "18:00",
      capacity: source.capacity ? String(source.capacity) : "",
    };
    setName(next.name);
    setSlug(next.slug);
    setSlugTouched(true);
    setDate(next.date);
    setStart(next.start);
    setEnd(next.end);
    setCapacity(next.capacity);
    generatedSlugRef.current = "";
    commandIdRef.current = null;
    setFailure(null);
    prefillBaselineRef.current = snapshotFields(next);
    initialFields.current = snapshotFields(next);
  }

  function clearToBlankDraft() {
    const next = { name: "", slug: "", clientId, date: "", start: "09:00", end: "18:00", capacity: "" };
    setName(next.name);
    setSlug(next.slug);
    setSlugTouched(false);
    setDate(next.date);
    setStart(next.start);
    setEnd(next.end);
    setCapacity(next.capacity);
    generatedSlugRef.current = "";
    commandIdRef.current = null;
    setFailure(null);
    prefillBaselineRef.current = snapshotFields(next);
    initialFields.current = snapshotFields(next);
  }

  function requestMode(nextMode: "new" | "copy") {
    if (nextMode === mode) return;
    if (!guardTransition()) return;
    if (draftDiffersFromPrefill) {
      if (!window.confirm("입력한 행사 정보가 있습니다. 만들기 방식을 바꾸면 입력 내용이 바뀝니다. 바꾸시겠습니까?")) return;
    }
    if (nextMode === "new") {
      setSourceId("");
      clearToBlankDraft();
    } else {
      // Keep the typed draft visible until a source is actually chosen;
      // choosing the source is what replaces the fields (with its own ask).
      prefillBaselineRef.current = JSON.stringify([name, slug, clientId, date, start, end, capacity]);
      initialFields.current = prefillBaselineRef.current;
    }
    setMode(nextMode);
  }

  function requestSource(nextId: string) {
    if (nextId === sourceId) return;
    if (!guardTransition()) return;
    const source = duplicateSources.find((candidate) => candidate.id === nextId) ?? null;
    if (!source) {
      setSourceId("");
      return;
    }
    if (draftDiffersFromPrefill) {
      if (!window.confirm(`원본 "${source.name}"의 정보로 입력 내용이 바뀝니다. 바꾸시겠습니까?`)) return;
    }
    setSourceId(nextId);
    applySourcePrefill(source);
  }

  const selectedSource = mode === "copy"
    ? duplicateSources.find((candidate) => candidate.id === sourceId) ?? null
    : null;
  // The chosen source reuses the exact duplicate mechanism: same prefill
  // shape, same duplicate endpoint, same copy contract.
  const effectiveDuplicate: DuplicateSource | null = duplicateOf ?? (selectedSource
    ? {
        id: selectedSource.id,
        name: selectedSource.name,
        slug: selectedSource.slug,
        clientName: selectedSource.clientName,
        date: selectedSource.date,
        start: selectedSource.start,
        end: selectedSource.end,
        capacity: selectedSource.capacity,
      }
    : null);
  const clientDraftDirty =
    newClientName.trim() !== "" || newClientContact.trim() !== "" || newClientEmail.trim() !== "";
  const allClients = [...clients, ...extraClients.filter((extra) => !clients.some((client) => client.id === extra.id))]
    .sort((left, right) => left.name.localeCompare(right.name, "ko-KR"));
  useConsoleDraftGuard(dirty || submitting || Boolean(commandIdRef.current) || clientDraftDirty || clientSaving || Boolean(pendingClientRef.current),
    submitting ? "행사 생성 요청을 처리하고 있습니다. 이동해도 서버의 처리가 취소되지는 않습니다."
      : failure?.retryable ? "행사 생성 결과를 아직 확인하지 못했습니다. 이미 생성되었을 수 있으므로 같은 요청으로 결과를 확인하세요."
        : clientSaving || pendingClientRef.current ? "고객사 등록 결과를 아직 확인하지 못했습니다. 이미 등록되었을 수 있으므로 같은 요청으로 결과를 확인하세요."
          : clientDraftDirty ? "작성 중인 고객사 내용이 있습니다."
            : undefined);

  // The subview swap unmounts one form and mounts the other inside the same
  // dialog: move focus with it so keyboard operators never land behind the
  // visible view. The customer subview scrolls the shared dialog back to the
  // top and focuses without an extra jump so its description stays visible
  // above the first field instead of sliding under the sticky header.
  useEffect(() => {
    if (clientMode === "create") {
      const scroller = newClientNameRef.current?.closest(".dialog") as HTMLElement | null;
      newClientNameRef.current?.focus();
      scroller?.scrollTo({ top: 0 });
    } else if (returnFocusToSelectRef.current) {
      returnFocusToSelectRef.current = false;
      clientSelectRef.current?.focus();
      if (!clientSelectRef.current) registerClientRef.current?.focus();
    }
  }, [clientMode]);

  function canClose() {
    if (submitGateRef.current || checkingResult) return false;
    // The in-dialog customer write has its own same-turn gate: an in-flight
    // registration blocks dismissal exactly like an in-flight event write,
    // and the pending receipt below warns instead of fake-cancelling.
    if (clientWriteRef.current) return false;
    if (commandIdRef.current) return window.confirm("행사 생성 결과를 아직 확인하지 못했습니다. 이미 생성되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?");
    if (pendingClientRef.current) return window.confirm("고객사 등록 결과를 아직 확인하지 못했습니다. 이미 등록되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?");
    if (clientMode === "create" && clientDraftDirty) return window.confirm("작성 중인 고객사 내용이 사라집니다. 닫을까요?");
    return !dirty || window.confirm("입력한 행사 정보를 저장하지 않고 닫을까요?");
  }

  function close() {
    if (canClose()) onClose();
  }

  function isDefinitiveClientError(status: number): boolean {
    return status >= 400 && status < 500 && ![408, 425, 429].includes(status);
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitGateRef.current || submitting || checkingResult) return;
    if (pendingClientRef.current || otherClientReceipt || otherEventReceipt) {
      setFailure({ message: "미확인 요청을 먼저 확인하세요. 창을 닫으면 상단에서 서버 처리 여부를 확인할 수 있습니다." });
      return;
    }
    // A new submit attempt supersedes any transition-block note: the failure
    // message below (or the created event) is the current guidance.
    setModeNotice(null);
    // Copy mode without a chosen source is a definitive local error: no
    // request leaves, no receipt is minted.
    if (mode === "copy" && duplicateOf === null && !selectedSource) {
      setFailure({ message: "복제할 원본 행사를 선택하세요.", field: "source" });
      sourceSelectRef.current?.focus();
      return;
    }
    submitGateRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const effectiveSlug = slug || generatedSlugRef.current || suggestedSlug(name, fallbackSlugRef.current);
      if (!slug) generatedSlugRef.current = effectiveSlug;
      const payload = {
        name,
        slug: effectiveSlug,
        ...(effectiveDuplicate ? {} : { clientId: clientId || null }),
        date,
        start,
        end,
        capacity: capacity ? Number(capacity) : 0,
      };
      const fingerprint = JSON.stringify([effectiveDuplicate?.id ?? null, payload]);
      if (commandIdRef.current?.uncertain && commandIdRef.current.fingerprint !== fingerprint) {
        setFailure({ message: "이전 행사 생성 결과를 확인한 뒤 내용을 바꾸세요.", retryable: true });
        return;
      }
      const attempt = commandIdRef.current?.fingerprint === fingerprint
        ? commandIdRef.current
        : { fingerprint, commandId: randomCommandId(), uncertain: false };
      commandIdRef.current = attempt;
      const commandId = attempt.commandId;
      const res = await fetch(
        effectiveDuplicate
          ? `/api/events/${encodeURIComponent(effectiveDuplicate.id)}/duplicate`
          : "/api/events",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ commandId, ...payload }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        event?: { id?: unknown } | null;
      } | null;
      if (!res.ok) {
        const serverMessage =
          typeof data?.error === "string"
            ? data.error
            : effectiveDuplicate
              ? "행사를 복제하지 못했습니다."
              : "행사를 만들지 못했습니다.";
        if (isDefinitiveClientError(res.status) && !attempt.uncertain) {
          commandIdRef.current = null;
          setEventUncertain(false);
          setFailure({
            message: serverMessage,
            field: typeof data?.field === "string" ? data.field : undefined,
          });
        } else {
          attempt.uncertain = true;
          setEventUncertain(true);
          setFailure({
            message: "행사 생성 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.",
            retryable: true,
          });
        }
        return;
      }
      if (!data?.event || typeof data.event.id !== "string" || !data.event.id || !confirmsEventCreation(payload, data)) {
        // 2xx without the expected event body: the write may have landed, so
        // keep the id and retry the same request instead of minting a new one.
        attempt.uncertain = true;
        setEventUncertain(true);
        setFailure({
          message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.",
          retryable: true,
        });
        return;
      }
      commandIdRef.current = null;
      setEventUncertain(false);
      generatedSlugRef.current = "";
      onCreated(data.event.id);
    } catch (error) {
      const attempt = commandIdRef.current;
      if (attempt && !attempt.uncertain && isOrganizationContextBlock(error)) {
        commandIdRef.current = null;
        setFailure({ message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        if (attempt) attempt.uncertain = true;
        setEventUncertain(true);
        setFailure({ message: "연결하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.", retryable: true });
      }
    } finally {
      submitGateRef.current = false;
      setSubmitting(false);
    }
  }

  useEffect(() => {
    if (!failure || failure.field) return;
    const frame = requestAnimationFrame(() => {
      const note = formFailureRef.current;
      if (!note) return;
      note.scrollIntoView({ block: "nearest" });
      note.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [failure]);

  useEffect(() => {
    if (!failure?.field) return;
    const field = failure.field === "clientId" ? "client" : failure.field;
    if (["slug", "start", "end", "capacity"].includes(field)) setAdvancedOpen(true);
    const frame = requestAnimationFrame(() => {
      const input = document.getElementById(`create-${field}`);
      if (input) { revealDetailsFor(input); input.focus(); }
    });
    return () => cancelAnimationFrame(frame);
  }, [failure]);

  const invalid = (field: string) => failure?.field === field;
  const invalidClient = (field: string) => clientFailure?.field === field;

  // Posts the customer-directory record from inside the event dialog. The
  // event payload, its frozen auto-slug and its pending command id are
  // never touched here; only the customer options and the selection change.
  async function saveNewClient(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (clientWriteRef.current || clientSaving || checkingResult || otherClientReceipt) return;
    setModeNotice(null);
    clientWriteRef.current = true;
    setClientSaving(true);
    setClientFailure(null);
    const payload = {
      name: newClientName.trim(),
      contact: newClientContact.trim(),
      email: newClientEmail.trim(),
    };
    const fingerprint = JSON.stringify(payload);
    if (pendingClientRef.current?.uncertain && pendingClientRef.current.fingerprint !== fingerprint) {
      clientWriteRef.current = false;
      setClientSaving(false);
      setClientFailure({ message: "이전 고객사 등록 결과를 확인한 뒤 내용을 바꾸세요.", retryable: true });
      return;
    }
    const attempt = pendingClientRef.current?.fingerprint === fingerprint
      ? pendingClientRef.current
      : { fingerprint, commandId: randomCommandId(), uncertain: false };
    pendingClientRef.current = attempt;
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: attempt.commandId, ...payload }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        client?: { id?: unknown; name?: unknown } | null;
      } | null;
      if (!res.ok) {
        // 403 included: customer records are organization-level, so a
        // manager scoped to one event must not rewrite the list. The server
        // message names the gate; the event draft stays as typed.
        const serverMessage =
          typeof data?.error === "string" ? data.error : "고객사를 등록하지 못했습니다.";
        if (isDefinitiveClientError(res.status) && !attempt.uncertain) {
          pendingClientRef.current = null;
          setClientUncertain(false);
          setClientFailure({
            message: serverMessage,
            field: typeof data?.field === "string" ? data.field : undefined,
          });
        } else {
          attempt.uncertain = true;
          setClientUncertain(true);
          setClientFailure({
            message: "고객사 등록 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.",
            retryable: true,
          });
        }
        return;
      }
      const record = typeof data?.client === "object" && data?.client !== null ? data.client : null;
      if (!record || typeof record.id !== "string" || !record.id || !confirmsClientSave(payload, data)) {
        // 2xx without the echoed record: the write may have landed, so keep
        // the id and retry the same request instead of minting a new one.
        attempt.uncertain = true;
        setClientUncertain(true);
        setClientFailure({
          message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.",
          retryable: true,
        });
        return;
      }
      pendingClientRef.current = null;
      setClientUncertain(false);
      // Narrowing on `record.id` does not survive the updater closure below,
      // so capture the validated id in a local const first.
      const clientRecordId: string = record.id;
      // Customer registration is already committed even if this event draft
      // is later discarded. Keep the directory's options authoritative too.
      onClientRegistered?.({ id: clientRecordId, name: payload.name });
      setExtraClients((prev) =>
        prev.some((client) => client.id === clientRecordId)
          ? prev
          : [...prev, { id: clientRecordId, name: payload.name }]
      );
      setClientId(clientRecordId);
      setClientNotice(`${payload.name} 고객사를 등록하고 선택했습니다.`);
      setNewClientName("");
      setNewClientContact("");
      setNewClientEmail("");
      setClientFailure(null);
      returnFocusToSelectRef.current = true;
      setClientMode("select");
    } catch (error) {
      if (!attempt.uncertain && isOrganizationContextBlock(error)) {
        pendingClientRef.current = null;
        setClientFailure({ message: "현재 조직을 확인한 뒤 다시 시도하세요." });
      } else {
        attempt.uncertain = true;
        setClientUncertain(true);
        setClientFailure({ message: "연결하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.", retryable: true });
      }
    } finally {
      clientWriteRef.current = false;
      setClientSaving(false);
    }
  }

  async function checkResult(kind: "event" | "client") {
    const attempt = kind === "event" ? commandIdRef.current : pendingClientRef.current;
    if (!attempt?.uncertain || checkingResult || submitting || clientSaving) return;
    setCheckingResult(true);
    const report = (message: string) => kind === "event"
      ? setFailure({ message, retryable: true })
      : setClientFailure({ message, retryable: true });
    try {
      const response = await operatorFetch(`/api/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const result = await response.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      const expected = kind === "client" ? "client.save" : effectiveDuplicate ? "event.duplicate" : "event.create";
      if (response.ok && result?.status === "APPLIED" && result.command === expected) {
        if (kind === "client") {
          // The receipt intentionally contains no customer details. Reload
          // the authorized directory and let the operator choose a record;
          // names need not be unique and are never used as an identity.
          const directoryRes = await operatorFetch("/api/console/directory", { cache: "no-store" });
          const directory = await directoryRes.json().catch(() => null) as { directory?: { clients?: unknown } } | null;
          if (!directoryRes.ok || !Array.isArray(directory?.directory?.clients)) {
            report("등록은 확인했지만 고객사 목록을 불러오지 못했습니다. 다시 확인하세요.");
            return;
          }
          const refreshed: Client[] = directory.directory.clients.flatMap((value: unknown) => {
            if (!value || typeof value !== "object") return [];
            const item = value as Record<string, unknown>;
            return typeof item.id === "string" && typeof item.name === "string" ? [{ id: item.id, name: item.name }] : [];
          });
          setExtraClients(refreshed);
          refreshed.forEach((client) => onClientRegistered?.(client));
          setClientId("");
          setClientNotice("고객사 등록이 반영되었습니다. 목록에서 해당 고객사를 선택하세요.");
          setNewClientName(""); setNewClientContact(""); setNewClientEmail("");
          pendingClientRef.current = null;
          setClientUncertain(false);
          setClientFailure(null);
          returnFocusToSelectRef.current = true;
          setClientMode("select");
        } else {
          commandIdRef.current = null;
          setEventUncertain(false);
        }
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        if (kind === "event") (onConfirmedWithoutDetails ?? onClose)();
      } else if (response.ok && result?.status === "UNCONFIRMED") {
        report("아직 처리 여부를 확인할 수 없습니다. 잠시 후 다시 확인하거나 같은 요청을 다시 시도하세요.");
      } else if (response.status >= 500 || [425, 429].includes(response.status)) report("일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요.");
      else report("처리 결과를 확인하지 못했습니다. 현재 계정과 조직 권한을 확인하세요.");
    } catch {
      report("서버에 연결하지 못했습니다. 요청은 다시 보내지 않았습니다.");
    } finally { setCheckingResult(false); }
  }

  function cancelClientCreate() {
    if (clientWriteRef.current || clientSaving || checkingResult) return;
    if (pendingClientRef.current) {
      if (!window.confirm("고객사 등록 결과를 아직 확인하지 못했습니다. 이미 등록되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?")) return;
    } else if (clientDraftDirty) {
      if (!window.confirm("작성 중인 고객사 내용이 사라집니다. 닫을까요?")) return;
    }
    returnFocusToSelectRef.current = true;
    setClientMode("select");
  }

  // Mode switches land on the newly revealed control so keyboard
  // operators never lose their place; closing the dialog returns focus to
  // the create entry via the shared ConsoleDialog restore.
  useEffect(() => {
    if (mode === "copy" && duplicateOf === null) {
      sourceSelectRef.current?.focus();
    }
  }, [mode, duplicateOf]);

  const isClientCreate = clientMode === "create" && !effectiveDuplicate;
  const isCopyView = duplicateOf !== null || mode === "copy";
  const sameNameSource = name.trim()
    ? duplicateSources.find((candidate) => candidate.id !== effectiveDuplicate?.id && candidate.name.trim().toLowerCase() === name.trim().toLowerCase()) ?? null
    : null;
  // Shown while typing so the line never appears (and shifts the form) at the
  // moment the name field loses focus.
  const addressSlug = slug || (name.trim() ? suggestedSlug(name, fallbackSlugRef.current) : "");
  const pickedDays = daysFromToday(date);
  const dateFlag = pickedDays !== null && pickedDays < 0
    ? effectiveDuplicate && date === effectiveDuplicate.date
      ? "날짜가 원본과 같고 이미 지났어요. 새 행사 날짜로 바꾸세요."
      : "이미 지난 날짜예요."
    : effectiveDuplicate && date === effectiveDuplicate.date
      ? "날짜가 원본과 같아요. 새 행사 날짜로 바꾸세요."
      : null;
  const timeOrderWrong = Boolean(start && end && start >= end);
  const timeSummary = start && end ? `${start}–${end}${durationLabel(start, end) ? ` · ${durationLabel(start, end)}` : ""}` : "시작·종료 시간을 정하세요.";
  const eventFormId = "create-event-form";
  const clientFormId = "create-client-form";

  return (
    <ConsoleDialog
      title={isClientCreate ? "새 고객사 등록" : isCopyView ? "행사 복제" : "새 행사 만들기"}
      titleId="create-event-title"
      onClose={onClose}
      canClose={canClose}
      busy={submitting || clientSaving || checkingResult}
      initialFocusRef={nameRef}
      stickyChrome
      wide={!isClientCreate}
      footer={
        isClientCreate ? (
          <div className={styles.createFooter}>
          <ConsoleFormActions>
            <ProductButton type="button" className="button button-secondary" onClick={cancelClientCreate} disabled={clientSaving || checkingResult}>
              행사 입력으로 돌아가기
            </ProductButton>
            {clientUncertain ? <ProductButton type="button" className="button button-secondary" disabled={clientSaving || checkingResult} onClick={() => void checkResult("client")}>{checkingResult ? "확인 중…" : "서버 처리 확인"}</ProductButton> : null}
            <ProductButton type="submit" form={clientFormId} className="button button-primary" disabled={clientSaving || checkingResult || otherClientReceipt}>
              {clientSaving ? "등록 중입니다" : clientFailure?.retryable ? "같은 요청 다시 시도" : "고객사 등록"}
            </ProductButton>
          </ConsoleFormActions>
          </div>
        ) : (
          <div className={styles.createFooter}>
          <p className={styles.createSay}>{isCopyView ? "복제하면 새 행사가 생깁니다." : "저장하면 기획 상태의 행사가 생깁니다."}</p>
          <ConsoleFormActions>
            <ProductButton type="button" className="button button-secondary" onClick={close} disabled={submitting || checkingResult}>
              취소
            </ProductButton>
            {eventUncertain ? <ProductButton type="button" className="button button-secondary" disabled={submitting || checkingResult} onClick={() => void checkResult("event")}>{checkingResult ? "확인 중…" : "서버 처리 확인"}</ProductButton> : null}
            <ProductButton type="submit" form={eventFormId} className="button button-primary" disabled={submitting || checkingResult || Boolean(pendingClientRef.current) || otherClientReceipt || otherEventReceipt}>
              {submitting
                ? isCopyView ? "복제하는 중입니다" : "만드는 중입니다"
                : eventUncertain ? "같은 요청 다시 시도" : isCopyView ? "행사 복제" : "행사 만들기"}
            </ProductButton>
          </ConsoleFormActions>
          </div>
        )
      }
      description={effectiveDuplicate ? (
          <div className={styles.duplicateContext} id="duplicate-scope">
            <p className={styles.duplicateSource}>
              원본 <strong>{effectiveDuplicate.name}</strong>
              <span>· {displayDate(effectiveDuplicate.date)}</span>
            </p>
            <dl className={styles.copyScope}>
              <div>
                <dt>복사</dt>
                <dd>행사 설정·참여 콘텐츠 정의</dd>
              </div>
              <div>
                <dt>복사 안 함</dt>
                <dd>참가자·티켓·입장·발송·당첨 기록</dd>
              </div>
            </dl>
          </div>
        ) : clientMode === "create" ? (
          <span className={styles.createWrap}>새 고객사를 등록하면 이 행사의 고객사로 바로 선택됩니다. 입력 중인 행사 정보는 그대로 유지됩니다. 등록한 고객사는 행사 작성을 취소해도 고객사 목록에 남습니다.</span>
        ) : undefined}
    >
      {clientMode === "create" && !effectiveDuplicate ? (
        <ValidatedForm id={clientFormId} onSubmit={saveNewClient} className={`${ui.formStack} ${styles.createForm}`}>
          {otherClientReceipt ? <p role="alert">이전 고객사 저장을 먼저 확인하세요. 창을 닫으면 상단에서 서버 처리 여부를 확인할 수 있습니다.</p> : null}
          {clientUncertain ? <p role="status">결과를 확인할 때까지 원래 입력 내용을 유지합니다.</p> : null}
          <div>
            <label htmlFor="create-new-client-name">고객사명 (필수)</label>
            <input
              id="create-new-client-name"
              ref={newClientNameRef}
              type="text"
              maxLength={80}
              value={newClientName}
              readOnly={clientSaving || checkingResult || clientUncertain}
              onChange={(event) => setNewClientName(event.target.value)}
              aria-invalid={invalidClient("name") || undefined}
              required
            />
            {invalidClient("name") ? <p role="alert">{clientFailure?.message}</p> : null}
          </div>
          <div>
            <label htmlFor="create-new-client-contact">담당자</label>
            <input
              id="create-new-client-contact"
              type="text"
              maxLength={60}
              value={newClientContact}
              readOnly={clientSaving || checkingResult || clientUncertain}
              onChange={(event) => setNewClientContact(event.target.value)}
              aria-invalid={invalidClient("contact") || undefined}
            />
            {invalidClient("contact") ? <p role="alert">{clientFailure?.message}</p> : null}
          </div>
          <div>
            <label htmlFor="create-new-client-email">담당자 이메일</label>
            <input
              id="create-new-client-email"
              type="email"
              maxLength={120}
              value={newClientEmail}
              readOnly={clientSaving || checkingResult || clientUncertain}
              onChange={(event) => setNewClientEmail(event.target.value)}
              aria-invalid={invalidClient("email") || undefined}
            />
            {invalidClient("email") ? <p role="alert">{clientFailure?.message}</p> : null}
          </div>
          {clientFailure && !clientFailure.field ? <p role="alert">{clientFailure.message}</p> : null}
        </ValidatedForm>
      ) : (
        <ValidatedForm id={eventFormId} onSubmit={onSubmit} className={`${ui.formStack} ${styles.createForm}`}>
          {otherClientReceipt || otherEventReceipt ? <p role="alert">이전 생성·저장 요청을 먼저 확인하세요. 창을 닫으면 상단에서 서버 처리 여부를 확인할 수 있습니다.</p> : null}
          {pendingClientRef.current ? <p role="alert">고객사 등록 결과를 먼저 확인하세요. 추가 설정에서 고객사 등록 화면으로 돌아갈 수 있습니다.</p> : null}
          <div className={styles.createMain}>
          {failure && !failure.field ? <p role="alert" ref={formFailureRef} tabIndex={-1}>{failure.message}</p> : null}
          {eventUncertain ? <p role="status">결과를 확인할 때까지 원래 입력 내용을 유지합니다.</p> : null}
          {canOfferCopy ? (
            <fieldset className={styles.modeGroup} disabled={submitting || clientSaving || eventUncertain || checkingResult}>
              <legend className="sr-only">만들기 방식</legend>
              <label>
                <input
                  type="radio"
                  name="create-mode"
                  checked={mode === "new"}
                  onChange={() => requestMode("new")}
                />
                새로 만들기
              </label>
              <label>
                <input
                  type="radio"
                  name="create-mode"
                  checked={mode === "copy"}
                  onChange={() => requestMode("copy")}
                />
                기존 행사 복제
              </label>
            </fieldset>
          ) : null}
          {mode === "copy" && duplicateOf === null ? (
            <div>
              <label htmlFor="create-source">원본 행사</label>
              <select
                id="create-source"
                ref={sourceSelectRef}
                value={sourceId}
                onChange={(event) => requestSource(event.target.value)}
                disabled={submitting || clientSaving || eventUncertain || checkingResult}
                aria-invalid={invalid("source") || undefined}
                aria-describedby="create-source-help"
              >
                <option value="">원본 행사를 선택하세요</option>
                {duplicateSources.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name} · {eventStageLabel(candidate.stage) || "단계 미정"} · {displayDate(candidate.date)}
                  </option>
                ))}
              </select>
              <p className={styles.slugHint} id="create-source-help">권한 있는 행사만 나옵니다. 원본을 고르면 이름·주소·날짜·시간·정원이 들어갑니다.</p>
              {invalid("source") ? <p role="alert">{failure?.message}</p> : null}
            </div>
          ) : null}
          {modeNotice ? <p role="alert">{modeNotice}</p> : null}
          <div className={styles.createName}>
            <label htmlFor="create-name" className="sr-only">행사명</label>
            <input
              id="create-name"
              ref={nameRef}
              type="text"
              className={styles.createTitle}
              placeholder="행사 이름"
              value={name}
              readOnly={submitting || checkingResult || eventUncertain}
              onChange={(event) => {
                setName(event.target.value);
                // Unsent edits can refresh the generated slug.
                if (!slugTouched) generatedSlugRef.current = "";
              }}
              onBlur={() => {
                if (!submitting && !eventUncertain && !slug && !slugTouched && name.trim()) setSlug(suggestedSlug(name, fallbackSlugRef.current));
              }}
              aria-invalid={invalid("name") || undefined}
              required
            />
            {invalid("name") ? <p role="alert">{failure?.message}</p> : null}
            {sameNameSource ? (
              <p className={styles.createFlag} role="status">
                같은 이름의 행사가 있어요 · {displayDate(sameNameSource.date)}{eventStageLabel(sameNameSource.stage) ? `, ${eventStageLabel(sameNameSource.stage)}` : ""}
              </p>
            ) : null}
            {addressSlug ? (
              <p className={styles.createAddr}>
                참가자 페이지 주소 <strong>/event/{addressSlug}</strong>
                <button type="button" className={styles.addrChange} disabled={submitting || checkingResult || eventUncertain} onClick={() => {
                  setAdvancedOpen(true);
                  requestAnimationFrame(() => document.getElementById("create-slug")?.focus());
                }}>바꾸기</button>
              </p>
            ) : null}
          </div>
          <div>
            <label htmlFor="create-date">행사 날짜</label>
            <input
              id="create-date"
              type="date"
              className={styles.createDate}
              value={date}
              readOnly={submitting || checkingResult || eventUncertain}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={invalid("date") || undefined}
              aria-describedby={invalid("date") ? "create-date-help create-date-error" : "create-date-help"}
              required
            />
            <QuickPick
              name="create-quick-date"
              label="날짜 바로 고르기"
              options={DATE_PRESETS}
              value={DATE_PRESETS.find((preset) => shiftedDate(preset.days, preset.months) === date)?.value ?? ""}
              onPick={(value) => {
                const preset = DATE_PRESETS.find((candidate) => candidate.value === value);
                if (preset) setDate(shiftedDate(preset.days, preset.months));
              }}
              disabled={submitting || checkingResult || eventUncertain}
            />
            <p className={styles.slugHint} id="create-date-help" aria-live="polite">{dateNote(date)}</p>
            {dateFlag ? <p className={styles.createFlag} role="status">{dateFlag}</p> : null}
            {invalid("date") ? <p id="create-date-error" role="alert">{failure?.message}</p> : null}
          </div>
          <div>
            <QuickPick
              name="create-quick-time"
              label="시간"
              legendVisible
              options={TIME_PRESETS}
              value={TIME_PRESETS.find((preset) => preset.start === start && preset.end === end)?.value ?? ""}
              onPick={(value) => {
                const preset = TIME_PRESETS.find((candidate) => candidate.value === value);
                if (!preset) return;
                setStart(preset.start);
                setEnd(preset.end);
              }}
              disabled={submitting || checkingResult || eventUncertain}
            />
            {timeOrderWrong ? (
              <p className={styles.createFlag} data-tone="bad" role="status">종료 시간은 시작 시간보다 늦어야 합니다.</p>
            ) : (
              <p className={styles.slugHint} aria-live="polite">{timeSummary}</p>
            )}
          </div>
          {effectiveDuplicate ? (
            <div>
              <p className={styles.slugHint}>고객사: {effectiveDuplicate.clientName || "선택하지 않음"}</p>
              <p className={styles.slugHint} role="note">복제 중에는 고객사를 새로 등록할 수 없습니다. 다른 고객사로 복제하려면 복제를 마친 뒤 행사 설정에서 바꾸거나, 고객사 화면에서 먼저 등록한 뒤 이 화면을 다시 여세요.</p>
            </div>
          ) : (
            <div>
              {allClients.length ? (
                <>
                  <label htmlFor="create-client">고객사 (선택)</label>
                  <select
                    id="create-client"
                    ref={clientSelectRef}
                    value={clientId}
                    disabled={submitting || checkingResult || eventUncertain}
                    onChange={(event) => setClientId(event.target.value)}
                    aria-invalid={invalid("clientId") || undefined}
                    aria-describedby={clientNotice ? "create-client-notice" : undefined}
                  >
                    <option value="">선택하지 않음</option>
                    {allClients.map((client) => (
                      <option key={client.id} value={client.id}>{client.name}</option>
                    ))}
                  </select>
                </>
              ) : (
                <p className={styles.slugHint}>아직 등록된 고객사가 없어요. 고객사를 연결하면 행사 목록과 보고서에서 묶어 볼 수 있습니다.</p>
              )}
              {clientNotice ? (
                <p className={styles.slugHint} role="status" id="create-client-notice">{clientNotice}</p>
              ) : null}
              <p className={styles.slugHint}>
                <ProductButton
                  ref={registerClientRef}
                  type="button"
                  className="button button-secondary"
                  disabled={submitting || checkingResult || eventUncertain}
                  onClick={() => { if (!clientUncertain) setClientFailure(null); setClientMode("create"); }}
                >
                  새 고객사 등록
                </ProductButton>
              </p>
              {invalid("clientId") ? <p role="alert">{failure?.message}</p> : null}
            </div>
          )}
          <details data-create-settings className={styles.createAdvanced} open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
            <summary>추가 설정 <span className={styles.slugHint}>시간 직접 입력 · 정원 · 참가자 페이지 주소</span></summary>
            <div className={ui.formStack}>
              <div className={ui.formGrid}>
                <div>
                  <label htmlFor="create-start">시작</label>
                  <input
                    id="create-start"
                    type="time"
                    value={start}
                    readOnly={submitting || checkingResult || eventUncertain}
                    onChange={(event) => setStart(event.target.value)}
                    aria-invalid={invalid("start") || invalid("end") || timeOrderWrong || undefined}
                  />
                </div>
                <div>
                  <label htmlFor="create-end">종료</label>
                  <input
                    id="create-end"
                    type="time"
                    value={end}
                    readOnly={submitting || checkingResult || eventUncertain}
                    onChange={(event) => setEnd(event.target.value)}
                    aria-invalid={invalid("start") || invalid("end") || timeOrderWrong || undefined}
                  />
                </div>
              </div>
              {start && end ? <p className={styles.slugHint}>24시간 기준: {start}–{end}</p> : null}
              {invalid("start") || invalid("end") ? <p role="alert">{failure?.message}</p> : null}
              <div>
                <label htmlFor="create-capacity">정원 (선택)</label>
                <input
                  id="create-capacity"
                  type="number"
                  min={0}
                  inputMode="numeric"
                  value={capacity}
                  readOnly={submitting || checkingResult || eventUncertain}
                  onChange={(event) => setCapacity(event.target.value)}
                  aria-invalid={invalid("capacity") || undefined}
                />
                <QuickPick
                  name="create-quick-capacity"
                  label="정원 바로 고르기"
                  options={CAPACITY_PRESETS.map((value) => ({ value, label: value }))}
                  value={CAPACITY_PRESETS.find((value) => value === capacity) ?? ""}
                  onPick={setCapacity}
                  disabled={submitting || checkingResult || eventUncertain}
                />
                {invalid("capacity") ? <p role="alert">{failure?.message}</p> : null}
              </div>
              <div>
                <label htmlFor="create-slug">참가자 페이지 주소 코드</label>
                <input
                  id="create-slug"
                  type="text"
                  value={slug}
                  readOnly={submitting || checkingResult || eventUncertain}
                  placeholder="예: partner-conf-2026"
                  pattern="[a-z0-9][a-z0-9\-]{0,49}"
                  title="영소문자·숫자·하이픈 50자 이내"
                  onChange={(event) => {
                    setSlug(event.target.value);
                    setSlugTouched(true);
                    generatedSlugRef.current = "";
                  }}
                  aria-invalid={invalid("slug") || undefined}
                />
                <p className={`${styles.slugHint} ${styles.createWrap}`}>참가자 주소에 쓰입니다. 영소문자·숫자·하이픈.</p>
                {invalid("slug") ? <p role="alert">{failure?.message}</p> : null}
              </div>
            </div>
          </details>
          </div>
          <aside className={styles.createSummary} aria-label="만들어질 행사">
            <h4 className={styles.createSummaryHead}>만들어질 행사</h4>
            <div className={styles.createSummaryCard}>
              <b>{name.trim() || "이름을 입력하세요"}</b>
              <span>{date ? displayDate(date) : "날짜를 고르세요"}{timeSummary ? ` · ${timeSummary}` : ""}</span>
            </div>
            <dl className={styles.createSummaryList}>
              <dt>정원</dt><dd>{capacity ? `${capacity}명` : "정하지 않음"}</dd>
              <dt>고객사</dt><dd>{allClients.find((client) => client.id === clientId)?.name ?? "선택하지 않음"}</dd>
              <dt>시작 상태</dt><dd>{isCopyView ? "원본 설정 복제" : "기획"}</dd>
            </dl>
          </aside>
        </ValidatedForm>
      )}
    </ConsoleDialog>
  );
}
