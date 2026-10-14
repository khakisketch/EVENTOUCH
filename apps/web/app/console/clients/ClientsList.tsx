"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type Client = {
  id: string;
  name: string;
  contact: string;
  email: string;
};

type ClientsState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; clients: Client[] };

export default function ClientsList() {
  const router = useRouter();
  const [state, setState] = useState<ClientsState>({ kind: "loading" });
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
        if (cancelled) return;
        if (res.status === 401) {
          router.push("/staff/login");
          return;
        }
        const data = (await res.json().catch(() => null)) as {
          state?: { clients?: unknown } | null;
        } | null;
        if (!res.ok || !data?.state) {
          setState({ kind: "failed", message: "고객사 목록을 불러오지 못했습니다." });
          return;
        }
        const clients: Client[] = Array.isArray(data.state.clients)
          ? data.state.clients.flatMap((item) => {
              if (typeof item !== "object" || item === null) return [];
              const client = item as Record<string, unknown>;
              if (typeof client.id !== "string" || typeof client.name !== "string") return [];
              return [{
                id: client.id,
                name: client.name,
                contact: typeof client.contact === "string" ? client.contact : "",
                email: typeof client.email === "string" ? client.email : "",
              }];
            })
          : [];
        setState({ kind: "ready", clients });
      } catch {
        if (!cancelled) {
          setState({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [router, reloadTick]);

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
  if (!state.clients.length) {
    return (
      <section className="state-panel">
        <p>등록된 고객사가 없습니다. 새 행사의 고객사는 행사 만들기에서 함께 지정할 수 있습니다.</p>
      </section>
    );
  }

  return (
    <ul className="client-list" aria-label="고객사 목록">
      {state.clients.map((client) => (
        <li key={client.id}>
          <article className="client-row">
            <h2>{client.name}</h2>
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
              </dl>
            ) : null}
          </article>
        </li>
      ))}
    </ul>
  );
}
