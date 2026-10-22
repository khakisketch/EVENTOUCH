"use client";

import { useEffect, useRef, useState } from "react";
import styles from "./console-home.module.css";
import ConsoleDialog from "./console-ui/ConsoleDialog";
import ConsoleFormActions from "./console-ui/ConsoleFormActions";
import ui from "./console-ui/console-ui.module.css";
import { useConsoleDraftGuard } from "./console-draft-guard";

type Client = { id: string; name: string };

// Duplicate mode reuses the create dialog: the operator confirms the new
// name/slug/date before the copy lands, and the dialog posts to the source
// event's duplicate endpoint instead of event creation.
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

function suggestedSlug(name: string): string {
  // Korean names cannot become URL codes directly; a random Latin code keeps
  // the operator moving and stays editable.
  const attempt = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 30);
  if (attempt.length >= 3) return attempt;
  return `event-${Math.random().toString(36).slice(2, 8)}`;
}

function displayDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  return match ? `${match[1]}.${match[2]}.${match[3]}` : value || "일정 미정";
}

export default function CreateEventDialog({
  clients,
  duplicateOf = null,
  onClose,
  onCreated,
  onClientRegistered,
}: {
  clients: Client[];
  duplicateOf?: DuplicateSource | null;
  onClose: () => void;
  onCreated: (eventId: string) => void;
  onClientRegistered?: (client: Client) => void;
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
  const [failure, setFailure] = useState<{ message: string; field?: string; retryable?: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [slugTouched, setSlugTouched] = useState(() => Boolean(duplicateOf));
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
  // Separate receipt from the event one: one command id per distinct
  // customer record, mirroring the customer directory save. An ambiguous
  // outcome keeps the id so the retry replays the same record instead of
  // adding a second one; editing the customer form after a failure mints a
  // new id via the fingerprint.
  const pendingClientRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  // Synchronous same-turn gate for the customer write, independent of the
  // event submit gate above.
  const clientWriteRef = useRef(false);
  const newClientNameRef = useRef<HTMLInputElement>(null);
  const clientSelectRef = useRef<HTMLSelectElement>(null);
  const returnFocusToSelectRef = useRef(false);
  // One command id per distinct payload: ambiguous outcomes (5xx, 408,
  // network loss, unparseable success body) keep the id so the retry replays
  // the same request and the server receipt replays the original event
  // instead of creating a second one. Proven success and definitive 4xx
  // clear it; editing the payload after a failure mints a new id via the
  // fingerprint. Never cleared on a bare HTTP response alone.
  const commandIdRef = useRef<{ fingerprint: string; commandId: string } | null>(null);
  // Auto-generated slug fallback is random for Korean names: freeze it for
  // the current inputs so a same-request retry sends the identical slug.
  const generatedSlugRef = useRef("");
  // Synchronous same-turn submit gate: `submitting` state flips only on
  // re-render, so a double activation in one turn would slip past it and
  // fire two fetches. Shared dialog dismissal consults the same ref.
  const submitGateRef = useRef(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const initialFields = useRef(JSON.stringify([name, slug, clientId, date, start, end, capacity]));
  const dirty = JSON.stringify([name, slug, clientId, date, start, end, capacity]) !== initialFields.current;
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
  // visible view.
  useEffect(() => {
    if (clientMode === "create") {
      newClientNameRef.current?.focus();
    } else if (returnFocusToSelectRef.current) {
      returnFocusToSelectRef.current = false;
      clientSelectRef.current?.focus();
    }
  }, [clientMode]);

  function canClose() {
    if (submitGateRef.current) return false;
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
    return status >= 400 && status < 500 && status !== 408;
  }

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitGateRef.current || submitting) return;
    submitGateRef.current = true;
    setSubmitting(true);
    setFailure(null);
    try {
      const effectiveSlug = slug || generatedSlugRef.current || suggestedSlug(name);
      if (!slug) generatedSlugRef.current = effectiveSlug;
      const payload = {
        name,
        slug: effectiveSlug,
        ...(duplicateOf ? {} : { clientId: clientId || null }),
        date,
        start,
        end,
        capacity: capacity ? Number(capacity) : 0,
      };
      const fingerprint = JSON.stringify([duplicateOf?.id ?? null, payload]);
      const attempt = commandIdRef.current?.fingerprint === fingerprint
        ? commandIdRef.current
        : { fingerprint, commandId: randomCommandId() };
      commandIdRef.current = attempt;
      const commandId = attempt.commandId;
      const res = await fetch(
        duplicateOf
          ? `/api/events/${encodeURIComponent(duplicateOf.id)}/duplicate`
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
            : duplicateOf
              ? "행사를 복제하지 못했습니다."
              : "행사를 만들지 못했습니다.";
        if (isDefinitiveClientError(res.status)) {
          commandIdRef.current = null;
          setFailure({
            message: serverMessage,
            field: typeof data?.field === "string" ? data.field : undefined,
          });
        } else {
          setFailure({
            message: `${serverMessage} 같은 요청으로 다시 시도하세요.`,
            field: typeof data?.field === "string" ? data.field : undefined,
            retryable: true,
          });
        }
        return;
      }
      if (!data?.event || typeof data.event.id !== "string") {
        // 2xx without the expected event body: the write may have landed, so
        // keep the id and retry the same request instead of minting a new one.
        setFailure({
          message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.",
          retryable: true,
        });
        return;
      }
      commandIdRef.current = null;
      generatedSlugRef.current = "";
      onCreated(data.event.id);
    } catch {
      setFailure({ message: "연결하지 못했습니다. 같은 요청으로 다시 시도하세요.", retryable: true });
    } finally {
      submitGateRef.current = false;
      setSubmitting(false);
    }
  }

  const invalid = (field: string) => failure?.field === field;
  const invalidClient = (field: string) => clientFailure?.field === field;

  // Posts the customer-directory record from inside the event dialog. The
  // event payload, its frozen auto-slug and its pending command id are
  // never touched here; only the customer options and the selection change.
  async function saveNewClient(formEvent: React.FormEvent) {
    formEvent.preventDefault();
    if (clientWriteRef.current || clientSaving) return;
    clientWriteRef.current = true;
    setClientSaving(true);
    setClientFailure(null);
    const payload = {
      name: newClientName.trim(),
      contact: newClientContact.trim(),
      email: newClientEmail.trim(),
    };
    const fingerprint = JSON.stringify(payload);
    const attempt = pendingClientRef.current?.fingerprint === fingerprint
      ? pendingClientRef.current
      : { fingerprint, commandId: randomCommandId() };
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
        if (isDefinitiveClientError(res.status)) {
          pendingClientRef.current = null;
          setClientFailure({
            message: serverMessage,
            field: typeof data?.field === "string" ? data.field : undefined,
          });
        } else {
          setClientFailure({
            message: `${serverMessage} 같은 요청으로 다시 시도하세요.`,
            field: typeof data?.field === "string" ? data.field : undefined,
            retryable: true,
          });
        }
        return;
      }
      const record = typeof data?.client === "object" && data?.client !== null ? data.client : null;
      if (!record || typeof record.id !== "string" || !record.id || record.name !== payload.name) {
        // 2xx without the echoed record: the write may have landed, so keep
        // the id and retry the same request instead of minting a new one.
        setClientFailure({
          message: "응답을 확인하지 못했습니다. 같은 요청으로 다시 시도하세요.",
          retryable: true,
        });
        return;
      }
      pendingClientRef.current = null;
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
    } catch {
      setClientFailure({ message: "연결하지 못했습니다. 같은 요청으로 다시 시도하세요.", retryable: true });
    } finally {
      clientWriteRef.current = false;
      setClientSaving(false);
    }
  }

  function cancelClientCreate() {
    if (clientWriteRef.current || clientSaving) return;
    if (pendingClientRef.current) {
      if (!window.confirm("고객사 등록 결과를 아직 확인하지 못했습니다. 이미 등록되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?")) return;
    } else if (clientDraftDirty) {
      if (!window.confirm("작성 중인 고객사 내용이 사라집니다. 닫을까요?")) return;
    }
    returnFocusToSelectRef.current = true;
    setClientMode("select");
  }

  return (
    <ConsoleDialog
      title={duplicateOf ? "행사 복제" : "새 행사 만들기"}
      titleId="create-event-title"
      onClose={onClose}
      canClose={canClose}
      busy={submitting}
      initialFocusRef={nameRef}
      description={duplicateOf ? (
          <div className={styles.duplicateContext} id="duplicate-scope">
            <p className={styles.duplicateSource}>
              원본 <strong>{duplicateOf.name}</strong>
              <span>· {displayDate(duplicateOf.date)}</span>
            </p>
            <dl className={styles.copyScope}>
              <div>
                <dt>복사</dt>
                <dd>행사 설정·참여 프로그램 정의</dd>
              </div>
              <div>
                <dt>복사 안 함</dt>
                <dd>참가자·티켓·입장·발송·당첨 기록</dd>
              </div>
            </dl>
          </div>
        ) : clientMode === "create" ? (
          "새 고객사를 등록하면 이 행사의 고객사로 바로 선택됩니다. 입력 중인 행사 정보는 그대로 유지됩니다. 등록한 고객사는 행사 작성을 취소해도 고객사 목록에 남습니다."
        ) : undefined}
    >
      {clientMode === "create" && !duplicateOf ? (
        <form onSubmit={saveNewClient} className={ui.formStack}>
          <div>
            <label htmlFor="create-new-client-name">고객사명 (필수)</label>
            <input
              id="create-new-client-name"
              ref={newClientNameRef}
              type="text"
              maxLength={80}
              value={newClientName}
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
              onChange={(event) => setNewClientEmail(event.target.value)}
              aria-invalid={invalidClient("email") || undefined}
            />
            {invalidClient("email") ? <p role="alert">{clientFailure?.message}</p> : null}
          </div>
          {clientFailure && !clientFailure.field ? <p role="alert">{clientFailure.message}</p> : null}
          <ConsoleFormActions>
            <button type="button" className="button button-secondary" onClick={cancelClientCreate} disabled={clientSaving}>
              행사 입력으로 돌아가기
            </button>
            <button type="submit" className="button button-primary" disabled={clientSaving}>
              {clientSaving ? "등록 중입니다" : clientFailure?.retryable ? "같은 요청 다시 시도" : "고객사 등록"}
            </button>
          </ConsoleFormActions>
        </form>
      ) : (
        <form onSubmit={onSubmit} className={ui.formStack}>
          <div>
            <label htmlFor="create-name">행사명</label>
            <input
              id="create-name"
              ref={nameRef}
              type="text"
              value={name}
              onChange={(event) => {
                setName(event.target.value);
                // A payload edit after a failure must mint a new command id
                // (fingerprint); drop the frozen auto-slug so the next submit
                // derives from the edited name.
                if (!slugTouched) generatedSlugRef.current = "";
              }}
              onBlur={() => {
                if (!slug && !slugTouched && name.trim()) setSlug(suggestedSlug(name));
              }}
              aria-invalid={invalid("name") || undefined}
              required
            />
            {invalid("name") ? <p role="alert">{failure?.message}</p> : null}
          </div>
          <div>
            <label htmlFor="create-slug">주소 코드</label>
            <input
              id="create-slug"
              type="text"
              value={slug}
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
            <p className={styles.slugHint}>참가자 주소에 쓰입니다. 영소문자·숫자·하이픈.</p>
            {invalid("slug") ? <p role="alert">{failure?.message}</p> : null}
          </div>
          {duplicateOf ? (
            <>
              <p className={styles.slugHint}>고객사: {duplicateOf.clientName || "선택하지 않음"}</p>
              <p className={styles.slugHint} role="note">복제 중에는 고객사를 새로 등록할 수 없습니다. 다른 고객사로 복제하려면 복제를 마친 뒤 행사 설정에서 바꾸거나, 고객사 화면에서 먼저 등록한 뒤 이 화면을 다시 여세요.</p>
            </>
          ) : clientMode === "create" ? null : (
            <div>
              <label htmlFor="create-client">고객사</label>
              <select
                id="create-client"
                ref={clientSelectRef}
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                aria-invalid={invalid("clientId") || undefined}
                aria-describedby={clientNotice ? "create-client-notice" : undefined}
              >
                <option value="">선택하지 않음</option>
                {allClients.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </select>
              {clientNotice ? (
                <p className={styles.slugHint} role="status" id="create-client-notice">{clientNotice}</p>
              ) : null}
              <p className={styles.slugHint}>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => { setClientFailure(null); setClientMode("create"); }}
                >
                  새 고객사 등록
                </button>
              </p>
              {invalid("clientId") ? <p role="alert">{failure?.message}</p> : null}
            </div>
          )}
          <div>
            <label htmlFor="create-date">행사 날짜</label>
            <input
              id="create-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
              aria-invalid={invalid("date") || undefined}
              required
            />
            {invalid("date") ? <p role="alert">{failure?.message}</p> : null}
          </div>
          <div className={ui.formGrid}>
            <div>
              <label htmlFor="create-start">시작</label>
              <input
                id="create-start"
                type="time"
                value={start}
                onChange={(event) => setStart(event.target.value)}
                aria-invalid={invalid("start") || invalid("end") || undefined}
              />
            </div>
            <div>
              <label htmlFor="create-end">종료</label>
              <input
                id="create-end"
                type="time"
                value={end}
                onChange={(event) => setEnd(event.target.value)}
                aria-invalid={invalid("start") || invalid("end") || undefined}
              />
            </div>
          </div>
          {invalid("start") || invalid("end") ? <p role="alert">{failure?.message}</p> : null}
          <div>
            <label htmlFor="create-capacity">정원 (선택)</label>
            <input
              id="create-capacity"
              type="number"
              min={0}
              inputMode="numeric"
              value={capacity}
              onChange={(event) => setCapacity(event.target.value)}
              aria-invalid={invalid("capacity") || undefined}
            />
            {invalid("capacity") ? <p role="alert">{failure?.message}</p> : null}
          </div>
          {failure && !failure.field ? <p role="alert">{failure.message}</p> : null}
          <ConsoleFormActions>
            <button type="button" className="button button-secondary" onClick={close} disabled={submitting}>
              취소
            </button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting
                ? duplicateOf ? "복제하는 중입니다" : "만드는 중입니다"
                : duplicateOf ? "행사 복제" : "행사 만들기"}
            </button>
          </ConsoleFormActions>
        </form>
      )}
    </ConsoleDialog>
  );
}
