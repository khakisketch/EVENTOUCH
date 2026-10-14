"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import styles from "./console-home.module.css";

type Client = { id: string; name: string };

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

export default function CreateEventDialog({
  clients,
  onClose,
  onCreated,
}: {
  clients: Client[];
  onClose: () => void;
  onCreated: (eventId: string) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [clientId, setClientId] = useState("");
  const [date, setDate] = useState("");
  const [start, setStart] = useState("09:00");
  const [end, setEnd] = useState("18:00");
  const [capacity, setCapacity] = useState("");
  const [failure, setFailure] = useState<{ message: string; field?: string } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const commandIdRef = useRef<string | null>(null);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setFailure(null);
    try {
      const commandId = commandIdRef.current ?? randomCommandId();
      commandIdRef.current = commandId;
      const res = await fetch("/api/events", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId,
          name,
          slug: slug || suggestedSlug(name),
          clientId: clientId || null,
          date,
          start,
          end,
          capacity: capacity ? Number(capacity) : 0,
        }),
      });
      commandIdRef.current = null;
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
        event?: { id?: unknown } | null;
      } | null;
      if (!res.ok || !data?.event || typeof data.event.id !== "string") {
        setFailure({
          message:
            typeof data?.error === "string"
              ? data.error
              : "행사를 만들지 못했습니다.",
          field: typeof data?.field === "string" ? data.field : undefined,
        });
        return;
      }
      onCreated(data.event.id);
    } catch {
      setFailure({ message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setSubmitting(false);
    }
  }

  const invalid = (field: string) => failure?.field === field;

  return (
    <div className={styles.dialogBackdrop} role="presentation" onClick={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="create-event-title">
        <h2 id="create-event-title">새 행사 만들기</h2>
        <form onSubmit={onSubmit}>
          <div>
            <label htmlFor="create-name">행사명</label>
            <input
              id="create-name"
              type="text"
              value={name}
              onChange={(event) => setName(event.target.value)}
              onBlur={() => {
                if (!slug) setSlug(suggestedSlug(name));
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
              pattern="[a-z0-9][a-z0-9-]{0,49}"
              onChange={(event) => setSlug(event.target.value)}
              aria-invalid={invalid("slug") || undefined}
            />
            <p className={styles.slugHint}>참가자 주소에 쓰입니다. 영소문자·숫자·하이픈.</p>
            {invalid("slug") ? <p role="alert">{failure?.message}</p> : null}
          </div>
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
          <div className={styles.gridTwo}>
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
          <div className={styles.dialogActions}>
            <button type="button" className="button button-secondary" onClick={onClose} disabled={submitting}>
              취소
            </button>
            <button type="submit" className="button button-primary" disabled={submitting}>
              {submitting ? "만드는 중입니다" : "행사 만들기"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
