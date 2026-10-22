"use client";

import { useRef, useState } from "react";
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
}: {
  clients: Client[];
  duplicateOf?: DuplicateSource | null;
  onClose: () => void;
  onCreated: (eventId: string) => void;
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
  useConsoleDraftGuard(dirty || submitting || Boolean(commandIdRef.current),
    submitting ? "행사 생성 요청을 처리하고 있습니다. 이동해도 서버의 처리가 취소되지는 않습니다."
      : failure?.retryable ? "행사 생성 결과를 아직 확인하지 못했습니다. 이미 생성되었을 수 있으므로 같은 요청으로 결과를 확인하세요."
        : undefined);

  function canClose() {
    if (submitGateRef.current) return false;
    if (commandIdRef.current) return window.confirm("행사 생성 결과를 아직 확인하지 못했습니다. 이미 생성되었을 수 있습니다. 결과를 확인하지 않고 닫을까요?");
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
        ) : undefined}
    >
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
            <p className={styles.slugHint}>고객사: {duplicateOf.clientName || "선택하지 않음"}</p>
          ) : (
            <div>
              <label htmlFor="create-client">고객사</label>
              <select
                id="create-client"
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                aria-invalid={invalid("clientId") || undefined}
              >
                <option value="">선택하지 않음</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>{client.name}</option>
                ))}
              </select>
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
    </ConsoleDialog>
  );
}
