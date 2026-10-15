"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { loginHrefForLocation } from "../../auth-redirect";

type Client = {
  id: string;
  name: string;
  contact: string;
  email: string;
  logoFileId: string;
  docFileId: string;
};

type ClientsState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; clients: Client[]; canManage: boolean };

type Draft = { id: string; name: string; contact: string; email: string };

const EMPTY_DRAFT: Draft = { id: "", name: "", contact: "", email: "" };

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

export default function ClientsList() {
  const router = useRouter();
  const [state, setState] = useState<ClientsState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState<{ field: string | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function load() {
    try {
      const [meRes, bootRes] = await Promise.all([
        fetch("/api/auth/me", { cache: "no-store" }),
        fetch("/api/bootstrap", { cache: "no-store" }),
      ]);
      if (meRes.status === 401 || bootRes.status === 401) {
        router.push(
          loginHrefForLocation(window.location.pathname, window.location.search)
        );
        return;
      }
      const me = (await meRes.json().catch(() => null)) as {
        user?: { role?: unknown } | null;
      } | null;
      const boot = (await bootRes.json().catch(() => null)) as {
        state?: { clients?: unknown } | null;
      } | null;
      if (!meRes.ok || !bootRes.ok || !me?.user || !boot?.state) {
        setState({ kind: "failed", message: "고객사 목록을 불러오지 못했습니다." });
        return;
      }
      const clients: Client[] = Array.isArray(boot.state.clients)
        ? boot.state.clients.flatMap((item) => {
            if (typeof item !== "object" || item === null) return [];
            const client = item as Record<string, unknown>;
            if (typeof client.id !== "string" || typeof client.name !== "string") return [];
            return [{
              id: client.id,
              name: client.name,
              contact: text(client.contact),
              email: text(client.email),
              logoFileId: text(client.logoFileId),
              docFileId: text(client.docFileId),
            }];
          })
        : [];
      setState({
        kind: "ready",
        clients,
        canManage: me.user.role === "AGENCY",
      });
    } catch {
      setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadTick]);

  async function saveClient(event: React.FormEvent) {
    event.preventDefault();
    if (!draft || saving) return;
    setSaving(true);
    setFormError(null);
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name,
          contact: draft.contact,
          email: draft.email,
        }),
      });
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        field?: unknown;
      } | null;
      if (!res.ok) {
        setFormError({
          field: typeof data?.field === "string" ? data.field : null,
          message: typeof data?.error === "string" ? data.error : "저장하지 못했습니다.",
        });
        return;
      }
      setNotice(draft.id ? "고객사 정보를 수정했습니다." : "고객사를 등록했습니다.");
      setDraft(null);
      await load();
    } catch {
      setFormError({ field: null, message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setSaving(false);
    }
  }

  // Logo and registration documents live on the customer record, outside any
  // event. The file id is what the record keeps; bytes travel the file route.
  async function uploadAttachment(client: Client, kind: "logo" | "doc", file: File) {
    const key = `${client.id}:${kind}`;
    if (kind === "logo" && file.type !== "image/jpeg" && file.type !== "image/png" && file.type !== "image/webp") {
      setFormError({ field: null, message: "로고는 JPG·PNG·WebP 이미지를 사용하세요." });
      return;
    }
    if (kind === "doc" && file.type !== "application/pdf") {
      setFormError({ field: null, message: "사업자등록증은 PDF로 올려주세요." });
      return;
    }
    if (file.size > 600000) {
      setFormError({ field: null, message: "600KB 이하 파일을 올려주세요." });
      return;
    }
    setUploading(key);
    setFormError(null);
    try {
      const res = await fetch(
        `/api/clients/${encodeURIComponent(client.id)}/files?name=${encodeURIComponent(file.name)}&commandId=${encodeURIComponent(randomCommandId())}`,
        { method: "POST", headers: { "content-type": file.type }, body: file }
      );
      const data = (await res.json().catch(() => null)) as {
        file?: { fileId?: unknown };
        error?: unknown;
      } | null;
      const fileId = typeof data?.file?.fileId === "string" ? data.file.fileId : "";
      if (!res.ok || !fileId) {
        setFormError({
          field: null,
          message: typeof data?.error === "string" ? data.error : "파일을 올리지 못했습니다.",
        });
        return;
      }
      const save = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          id: client.id,
          name: client.name,
          contact: client.contact,
          email: client.email,
          ...(kind === "logo" ? { logoFileId: fileId } : { docFileId: fileId }),
        }),
      });
      if (!save.ok) {
        setFormError({ field: null, message: "파일은 올렸으나 고객사에 연결하지 못했습니다. 다시 시도하세요." });
        return;
      }
      setNotice(kind === "logo" ? "로고를 등록했습니다." : "사업자등록증을 등록했습니다.");
      await load();
    } catch {
      setFormError({ field: null, message: "연결하지 못했습니다. 다시 시도하세요." });
    } finally {
      setUploading(null);
    }
  }

  async function removeAttachment(client: Client, kind: "logo" | "doc") {
    if (!window.confirm(kind === "logo" ? "로고를 제거할까요?" : "사업자등록증을 제거할까요?")) return;
    try {
      const res = await fetch("/api/clients", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          commandId: randomCommandId(),
          id: client.id,
          name: client.name,
          contact: client.contact,
          email: client.email,
          ...(kind === "logo" ? { logoFileId: "" } : { docFileId: "" }),
        }),
      });
      if (!res.ok) {
        setFormError({ field: null, message: "제거하지 못했습니다." });
        return;
      }
      setNotice(kind === "logo" ? "로고를 제거했습니다." : "사업자등록증을 제거했습니다.");
      await load();
    } catch {
      setFormError({ field: null, message: "연결하지 못했습니다. 다시 시도하세요." });
    }
  }

  if (state.kind === "loading") {
    return <p className="loading-state" role="status">고객사 목록을 불러오고 있습니다.</p>;
  }
  if (state.kind === "failed") {
    return (
      <section className="state-panel">
        <p className="state-error" role="alert">{state.message}</p>
        <p>
          <button type="button" className="button button-secondary" onClick={() => {
            setReloadTick((tick) => tick + 1);
            window.dispatchEvent(new CustomEvent("eventouch:shell-reload"));
          }}>
            다시 불러오기
          </button>
        </p>
      </section>
    );
  }

  return (
    <div>
      {notice ? <p className="state-success" role="status">{notice}</p> : null}
      {formError && !draft ? <p className="state-error" role="alert">{formError.message}</p> : null}
      {state.canManage ? (
        <p>
          <button type="button" className="button button-primary" onClick={() => { setDraft({ ...EMPTY_DRAFT }); setFormError(null); }}>
            고객사 등록
          </button>
        </p>
      ) : null}
      {!state.clients.length ? (
        <section className="state-panel">
          <p>등록된 고객사가 없습니다. 새 행사의 고객사는 행사 만들기에서 함께 지정할 수 있습니다.</p>
        </section>
      ) : (
        <ul className="client-list" aria-label="고객사 목록">
          {state.clients.map((client) => (
            <li key={client.id}>
              <article className="client-row">
                <h2>{client.name}</h2>
                {client.logoFileId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className="client-logo"
                    src={`/api/clients/${encodeURIComponent(client.id)}/files/${encodeURIComponent(client.logoFileId)}`}
                    alt={`${client.name} 로고`}
                  />
                ) : null}
                {client.contact || client.email ? (
                  <dl className="client-meta">
                    {client.contact ? (
                      <div>
                        <dt>담당자</dt>
                        <dd>{client.contact}</dd>
                      </div>
                    ) : null}
                    {client.email ? (
                      <div>
                        <dt>이메일</dt>
                        <dd>{client.email}</dd>
                      </div>
                    ) : null}
                    {client.docFileId ? (
                      <div>
                        <dt>사업자등록증</dt>
                        <dd>
                          <a href={`/api/clients/${encodeURIComponent(client.id)}/files/${encodeURIComponent(client.docFileId)}`}>
                            문서 보기
                          </a>
                        </dd>
                      </div>
                    ) : null}
                  </dl>
                ) : null}
                {state.canManage ? (
                  <div className="client-actions">
                    <button
                      type="button"
                      className="button button-secondary"
                      onClick={() => {
                        setDraft({ id: client.id, name: client.name, contact: client.contact, email: client.email });
                        setFormError(null);
                      }}
                    >
                      정보 수정
                    </button>
                    <label className="button button-secondary">
                      {uploading === `${client.id}:logo` ? "올리는 중…" : client.logoFileId ? "로고 교체" : "로고 등록"}
                      <input
                        type="file"
                        className="sr-only"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={uploading !== null}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadAttachment(client, "logo", file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {client.logoFileId ? (
                      <button type="button" className="button button-secondary" onClick={() => void removeAttachment(client, "logo")}>
                        로고 제거
                      </button>
                    ) : null}
                    <label className="button button-secondary">
                      {uploading === `${client.id}:doc` ? "올리는 중…" : client.docFileId ? "서류 교체" : "사업자등록증 등록"}
                      <input
                        type="file"
                        className="sr-only"
                        accept="application/pdf"
                        disabled={uploading !== null}
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (file) void uploadAttachment(client, "doc", file);
                          event.target.value = "";
                        }}
                      />
                    </label>
                    {client.docFileId ? (
                      <button type="button" className="button button-secondary" onClick={() => void removeAttachment(client, "doc")}>
                        서류 제거
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}
      {draft && state.canManage ? (
        <div className="dialog-backdrop" onClick={() => setDraft(null)}>
          <div
            className="dialog"
            role="dialog"
            aria-modal="true"
            aria-label={draft.id ? "고객사 정보 수정" : "고객사 등록"}
            onClick={(event) => event.stopPropagation()}
          >
            <h2>{draft.id ? "고객사 정보 수정" : "고객사 등록"}</h2>
            <form
              onSubmit={(event) => void saveClient(event)}
            >
              <div>
                <label htmlFor="client-name">고객사명 (필수)</label>
                <input
                  id="client-name"
                  type="text"
                  maxLength={80}
                  required
                  value={draft.name}
                  aria-invalid={formError?.field === "name"}
                  onChange={(event) => setDraft({ ...draft, name: event.target.value })}
                />
                {formError?.field === "name" ? <p className="state-error" role="alert">{formError.message}</p> : null}
              </div>
              <div>
                <label htmlFor="client-contact">담당자</label>
                <input
                  id="client-contact"
                  type="text"
                  maxLength={60}
                  value={draft.contact}
                  onChange={(event) => setDraft({ ...draft, contact: event.target.value })}
                />
              </div>
              <div>
                <label htmlFor="client-email">담당자 이메일</label>
                <input
                  id="client-email"
                  type="email"
                  maxLength={120}
                  value={draft.email}
                  aria-invalid={formError?.field === "email"}
                  onChange={(event) => setDraft({ ...draft, email: event.target.value })}
                />
                {formError?.field === "email" ? <p className="state-error" role="alert">{formError.message}</p> : null}
              </div>
              {formError && !formError.field ? <p className="state-error" role="alert">{formError.message}</p> : null}
              <div className="dialog-actions">
                <button type="submit" className="button button-primary" disabled={saving}>
                  {saving ? "저장 중…" : "저장"}
                </button>
                <button type="button" className="button button-secondary" onClick={() => setDraft(null)}>
                  취소
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}
