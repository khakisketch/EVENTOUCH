"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../../../auth-redirect";

type ImportMap = { name: string; phone: string; email: string; company: string };
type ValidRow = { name: string; phone: string; email: string; company: string };
type RowError = { row: number; reason: string };

type GateState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; eventName: string; canManage: boolean };

const MAX_BYTES = 1048576;
const MAX_ROWS = 1000;
const FIELDS: Array<{ id: keyof ImportMap; label: string; required: boolean }> = [
  { id: "name", label: "이름", required: true },
  { id: "phone", label: "연락처", required: true },
  { id: "email", label: "이메일", required: false },
  { id: "company", label: "소속", required: false },
];
const ALIASES: Record<keyof ImportMap, string[]> = {
  name: ["이름", "name"],
  phone: ["연락처", "phone", "전화번호"],
  email: ["이메일", "email"],
  company: ["소속", "company", "org"],
};

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function stripBom(text: string): string {
  return text.replace(/^﻿/, "");
}

// Same grammar as the legacy app: quoted cells, doubled quotes, CRLF.
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
    } else if (c === "," && !quoted) {
      row.push(cell);
      cell = "";
    } else if ((c === "\n" || c === "\r") && !quoted) {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += c;
    }
  }
  if (quoted) throw new Error("따옴표가 닫히지 않은 CSV입니다.");
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

// TXT: one participant per line — 이름, 연락처, 이메일(선택), 소속(선택).
// Comma/semicolon/tab preferred; bare whitespace splits name/phone/company.
function parseTxt(text: string): { headers: string[]; rows: string[][] } {
  const headers = ["이름", "연락처", "이메일", "소속"];
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = /[,;\t]/.test(line)
      ? line.split(/[,;\t]/).map((x) => x.trim())
      : line.trim().split(/\s+/);
    while (cells.length < 4) cells.push("");
    rows.push(cells.slice(0, 4));
  }
  return { headers, rows };
}

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

function validateRows(
  dataRows: string[][],
  map: ImportMap
): { valid: ValidRow[]; errors: RowError[] } {
  const valid: ValidRow[] = [];
  const errors: RowError[] = [];
  const seen = new Set<string>();
  dataRows.forEach((cols, index) => {
    const get = (key: keyof ImportMap) =>
      map[key] === "" ? "" : (cols[Number(map[key])] ?? "").trim();
    const name = get("name").slice(0, 60);
    const phone = normalizePhone(get("phone"));
    const email = get("email").slice(0, 120);
    const company = get("company").slice(0, 200);
    const line = index + 2;
    if (!name) {
      errors.push({ row: line, reason: "이름을 입력하세요" });
      return;
    }
    if (!/^\d{9,15}$/.test(phone)) {
      errors.push({ row: line, reason: "연락처를 숫자 9~15자리로 입력하세요" });
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: line, reason: "이메일 형식을 확인하세요" });
      return;
    }
    if (seen.has(phone)) {
      errors.push({ row: line, reason: "파일 안에서 연락처가 중복됩니다" });
      return;
    }
    seen.add(phone);
    valid.push({ name, phone, email, company });
  });
  return { valid, errors };
}

function downloadCsv(filename: string, rows: string[][]) {
  const escaped = rows
    .map((row) =>
      row
        .map((cell) =>
          /[",\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell
        )
        .join(",")
    )
    .join("\r\n");
  const blob = new Blob(["﻿" + escaped], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export default function ImportWizard({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [gate, setGate] = useState<GateState>({ kind: "loading" });
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [fileKind, setFileKind] = useState<"csv" | "txt" | null>(null);
  const [map, setMap] = useState<ImportMap>({ name: "", phone: "", email: "", company: "" });
  const [preview, setPreview] = useState<{ valid: ValidRow[]; errors: RowError[] } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<number | null>(null);
  const submittingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, bootRes] = await Promise.all([
          fetch("/api/auth/me", { cache: "no-store" }),
          fetch("/api/bootstrap", { cache: "no-store" }),
        ]);
        if (cancelled) return;
        if (meRes.status === 401 || bootRes.status === 401) {
          router.push(
            loginHrefForLocation(window.location.pathname, window.location.search)
          );
          return;
        }
        const me = (await meRes.json().catch(() => null)) as {
          user?: { id?: unknown; role?: unknown } | null;
        } | null;
        const boot = (await bootRes.json().catch(() => null)) as {
          state?: { events?: unknown; memberships?: unknown } | null;
        } | null;
        const bootstrap = boot?.state;
        if (!meRes.ok || !bootRes.ok || !me?.user || !bootstrap) {
          if (!cancelled) setGate({ kind: "failed", message: "가져오기 화면을 불러오지 못했습니다." });
          return;
        }
        const role = typeof me.user.role === "string" ? me.user.role : "";
        const myId = typeof me.user.id === "string" ? me.user.id : "";
        const memberships = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.filter(
              (item): item is Record<string, unknown> =>
                typeof item === "object" && item !== null
            )
          : [];
        const canManage =
          role === "AGENCY" ||
          (role === "MANAGER" &&
            memberships.some(
              (membership) =>
                membership.accountId === myId && membership.eventId === eventId
            ));
        const event = Array.isArray(bootstrap.events)
          ? bootstrap.events.find(
              (item): item is Record<string, unknown> =>
                typeof item === "object" &&
                item !== null &&
                (item as Record<string, unknown>).id === eventId
            )
          : undefined;
        if (!cancelled) {
          setGate({
            kind: "ready",
            eventName:
              event && typeof event.name === "string" ? event.name : eventId,
            canManage,
          });
        }
      } catch {
        if (!cancelled) setGate({ kind: "failed", message: "연결하지 못했습니다. 다시 시도하세요." });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [eventId, router]);

  async function readFile(file: File) {
    setFileError(null);
    setPreview(null);
    setCommitted(null);
    try {
      if (file.size > MAX_BYTES) throw new Error("1MB 이하 CSV·TXT 파일을 선택하세요.");
      const text = stripBom(await file.text());
      const looksTxt =
        /\.txt$/i.test(file.name) ||
        file.type.startsWith("text/plain");
      if (looksTxt) {
        const parsed = parseTxt(text);
        if (!parsed.rows.length || parsed.rows.length > MAX_ROWS) {
          throw new Error("1~1,000개 데이터 행이 필요합니다.");
        }
        setHeaders(parsed.headers);
        setDataRows(parsed.rows);
        setFileKind("txt");
        setMap({ name: "0", phone: "1", email: "2", company: "3" });
      } else {
        const rows = parseCsv(text);
        if (rows.length < 2 || rows.length > MAX_ROWS + 1) {
          throw new Error("헤더와 1~1,000개 데이터 행이 필요합니다.");
        }
        const head = rows.shift() ?? [];
        const next: ImportMap = { name: "", phone: "", email: "", company: "" };
        (Object.keys(ALIASES) as Array<keyof ImportMap>).forEach((key) => {
          const at = head.findIndex((h) =>
            ALIASES[key].includes(h.trim().toLowerCase())
          );
          next[key] = at < 0 ? "" : String(at);
        });
        setHeaders(head);
        setDataRows(rows);
        setFileKind("csv");
        setMap(next);
      }
    } catch (error) {
      setHeaders(null);
      setDataRows([]);
      setFileKind(null);
      setFileError(error instanceof Error ? error.message : "파일을 읽지 못했습니다.");
    }
  }

  function buildPreview(nextMap: ImportMap) {
    if (nextMap.name === nextMap.phone && nextMap.name !== "") {
      setPreview(null);
      setFileError("이름과 연락처는 서로 다른 열을 선택하세요.");
      return;
    }
    setFileError(null);
    setPreview(validateRows(dataRows, nextMap));
  }

  async function commit() {
    if (!preview || !preview.valid.length || submittingRef.current) return;
    submittingRef.current = true;
    setCommitError(null);
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId: randomCommandId(),
            command: "participant.import",
            payload: { rows: preview.valid },
          }),
        }
      );
      const data = (await res.json().catch(() => null)) as {
        error?: unknown;
        participants?: unknown[];
      } | null;
      if (!res.ok) {
        setCommitError(
          typeof data?.error === "string" ? data.error : "반영하지 못했습니다."
        );
        return;
      }
      const count = Array.isArray(data?.participants) ? data.participants.length : preview.valid.length;
      setCommitted(count);
      setHeaders(null);
      setDataRows([]);
      setPreview(null);
      setFileKind(null);
    } catch {
      setCommitError("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      submittingRef.current = false;
    }
  }

  if (gate.kind === "loading") {
    return <p className="loading-state" role="status">가져오기 화면을 불러오고 있습니다.</p>;
  }
  if (gate.kind === "failed") {
    return (
      <section className="state-panel">
        <p role="alert">{gate.message}</p>
        <p><Link href={`/console/events/${encodeURIComponent(eventId)}/participants`}>참가자 목록으로</Link></p>
      </section>
    );
  }

  return (
    <section className="participants-content">
      <header className="participants-heading">
        <h1>명단 가져오기</h1>
        <p className="landing-note">{gate.eventName} · CSV·TXT 파일의 열을 연결하고 오류를 확인한 뒤 반영합니다.</p>
      </header>
      {!gate.canManage ? (
        <p className="notice" role="status">가져오기 권한이 없습니다. 변경이 필요하면 담당 행사 운영자에게 요청하세요.</p>
      ) : null}
      {committed !== null ? (
        <p className="state-success" role="status">{committed}명을 반영했습니다.</p>
      ) : null}
      {gate.canManage ? (
        <>
          <section className="state-panel" aria-label="1단계 파일 선택">
            <h2>1. 파일 선택</h2>
            <div className="participant-toolbar">
              <label>
                <span className="sr-only">CSV·TXT 파일 선택</span>
                <input
                  type="file"
                  accept=".csv,text/csv,.txt,text/plain"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file);
                    event.target.value = "";
                  }}
                />
              </label>
              <button
                type="button"
                className="button button-secondary"
                onClick={() =>
                  downloadCsv("EVENTOUCH_import_template.csv", [
                    ["이름", "연락처", "이메일", "소속"],
                    ["예시 참가자", "01000009999", "sample@example.demo", "예시 조직"],
                  ])
                }
              >
                양식 CSV
              </button>
            </div>
            <p className="landing-note">UTF-8 CSV·TXT · 최대 1MB, 1,000행. XLSX는 CSV로 저장한 뒤 사용하세요. TXT는 한 줄에 한 명: 이름, 연락처, 이메일(선택), 소속(선택).</p>
            {fileError ? <p className="state-error" role="alert">{fileError}</p> : null}
          </section>
          {headers ? (
            <section className="state-panel" aria-label="2단계 열 매핑">
              <h2>2. 열 연결 {fileKind === "txt" ? "(TXT 고정 순서)" : ""}</h2>
              <div className="participant-toolbar">
                {FIELDS.map((field) => (
                  <label key={field.id}>
                    <span>{field.label}{field.required ? " *" : ""}</span>
                    <select
                      value={map[field.id]}
                      disabled={fileKind === "txt"}
                      onChange={(event) => {
                        const next = { ...map, [field.id]: event.target.value };
                        setMap(next);
                        buildPreview(next);
                      }}
                    >
                      <option value="">사용하지 않음</option>
                      {headers.map((head, index) => (
                        <option key={index} value={String(index)}>
                          {head || `열 ${index + 1}`}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
              <p>
                <button type="button" className="button button-secondary" onClick={() => buildPreview(map)}>
                  검토 결과 만들기
                </button>
              </p>
            </section>
          ) : null}
          {preview ? (
            <section className="state-panel" aria-label="3단계 검토 후 반영">
              <h2>3. 검토 후 반영</h2>
              <p className="landing-note" role="status">
                유효 {preview.valid.length}행 · 오류 {preview.errors.length}행. 오류 행은 제외되며 원본 파일에서 수정 후 다시 가져올 수 있습니다.
              </p>
              {preview.errors.length ? (
                <ul className="participant-list">
                  {preview.errors.slice(0, 50).map((item) => (
                    <li className="participant-row" key={item.row}>
                      <span className="participant-summary">파일 {item.row}행</span>
                      <span>{item.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {commitError ? <p className="state-error" role="alert">{commitError}</p> : null}
              <p className="landing-note">동의 기록은 가져오기만으로 생성하지 않습니다.</p>
              <div className="participant-toolbar">
                <button
                  type="button"
                  className="button"
                  disabled={!preview.valid.length}
                  onClick={() => void commit()}
                >
                  유효 행 반영
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  onClick={() => {
                    setHeaders(null);
                    setDataRows([]);
                    setPreview(null);
                    setFileKind(null);
                  }}
                >
                  검토 취소
                </button>
              </div>
            </section>
          ) : null}
        </>
      ) : null}
      <p>
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>참가자 목록으로</Link>
      </p>
    </section>
  );
}
