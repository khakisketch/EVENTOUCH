"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { loginHrefForLocation } from "../../../../../auth-redirect";
import ConsolePage from "../../../../console-ui/ConsolePage";
import ConsoleToolbar from "../../../../console-ui/ConsoleToolbar";
import ConsoleFeedback from "../../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../../console-ui/ConsoleFormActions";
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../../console-draft-guard";
import consoleUiStyles from "../../../../console-ui/console-ui.module.css";
import styles from "./import.module.css";
import * as XLSX from "xlsx";

type ImportMap = { name: string; phone: string; email: string; company: string };
type ValidRow = { name: string; phone: string; email: string; company: string };
type RowError = { row: number; reason: string };

type GateState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; eventName: string; eventMeta: ConsoleEventMeta; eventStage: string; canManage: boolean };

const MAX_BYTES = 1048576;
const MAX_ROWS = 1000;
const MAX_WORKBOOK_COLUMNS = 256;
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

// XLSX: the first worksheet becomes header + data rows. Values are read as
// displayed text (no formulas), trimmed to the same limits as CSV cells, and
// flow into the same column-mapping and validation below.
function parseWorkbook(buffer: ArrayBuffer): { headers: string[]; rows: string[][] } {
  const workbook = XLSX.read(buffer, {
    type: "array",
    cellDates: false,
    sheetStubs: false,
    cellFormula: false,
    cellHTML: false,
    sheets: 0,
    // Parse one excess data row so over-limit input is rejected, never
    // silently imported as a truncated list. Other worksheets are ignored.
    sheetRows: MAX_ROWS + 2,
  });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error("시트가 없는 엑셀 파일입니다.");
  const sheet = workbook.Sheets[sheetName];
  const bounds = XLSX.utils.decode_range(sheet["!fullref"] || sheet["!ref"] || "A1");
  if (bounds.e.r > MAX_ROWS) {
    throw new Error("엑셀 첫 시트는 헤더와 1~1,000개 데이터 행으로 정리하세요. 뒤쪽 빈 행도 확인하세요.");
  }
  if (bounds.e.c - bounds.s.c + 1 > MAX_WORKBOOK_COLUMNS) {
    throw new Error("엑셀은 256열 이하로 정리하세요. 사용하지 않는 뒤쪽 열을 제거하세요.");
  }
  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: "" });
  const rows = grid
    .map((line) =>
      (Array.isArray(line) ? line : []).map((cell) =>
        typeof cell === "string" ? cell.trim().slice(0, 4000)
        : typeof cell === "number" && Number.isFinite(cell) ? String(cell).slice(0, 4000)
        : ""
      )
    )
    .filter((line) => line.some((cell) => cell.trim()));
  if (rows.length < 2 || rows.length > MAX_ROWS + 1) {
    throw new Error("헤더와 1~1,000개 데이터 행이 필요합니다.");
  }
  const head = rows.shift() ?? [];
  return { headers: head, rows };
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
    // Server limits stay as-is (60/120/200), but over-limit values are
    // field errors with row numbers — never silently cut before validation.
    const name = get("name");
    const phone = normalizePhone(get("phone"));
    const email = get("email");
    const company = get("company");
    const line = index + 2;
    if (!name) {
      errors.push({ row: line, reason: "이름을 입력하세요" });
      return;
    }
    if (name.length > 60) {
      errors.push({ row: line, reason: `이름이 60자를 초과합니다(${name.length}자)` });
      return;
    }
    if (!/^\d{9,15}$/.test(phone)) {
      errors.push({ row: line, reason: "연락처를 숫자 9~15자리로 입력하세요" });
      return;
    }
    if (email.length > 120) {
      errors.push({ row: line, reason: `이메일이 120자를 초과합니다(${email.length}자)` });
      return;
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push({ row: line, reason: "이메일 형식을 확인하세요" });
      return;
    }
    if (company.length > 200) {
      errors.push({ row: line, reason: `소속이 200자를 초과합니다(${company.length}자)` });
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
  const [retryTick, setRetryTick] = useState(0);
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [dataRows, setDataRows] = useState<string[][]>([]);
  const [fileKind, setFileKind] = useState<"csv" | "txt" | null>(null);
  const [map, setMap] = useState<ImportMap>({ name: "", phone: "", email: "", company: "" });
  const [preview, setPreview] = useState<{ valid: ValidRow[]; errors: RowError[] } | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  // The wizard runs in three steps; the first screen shows where the
  // operator is and what is still ahead instead of only the current box.
  const importStep = preview ? 3 : headers ? 2 : 1;
  const submittingRef = useRef(false);
  const pendingImportRef = useRef<{ fingerprint: string; commandId: string } | null>(null);

  // Unsaved import work guards navigation: loaded rows, column mapping and
  // an uncommitted preview would be lost on leave. Filters are none here;
  // a committed import clears the draft and the page is clean again.
  useConsoleDraftGuard(headers !== null || preview !== null, "가져오기 위해 정리한 명단이 사라질 수 있습니다.");

  // Event switch resets explicit local file state (never a key remount):
  // rows mapped for another event must not commit into this one.
  useEffect(() => {
    setHeaders(null);
    setDataRows([]);
    setFileKind(null);
    setMap({ name: "", phone: "", email: "", company: "" });
    setPreview(null);
    setFileError(null);
    setCommitError(null);
    setCommitted(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

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
          state?: {
            events?: unknown;
            clients?: unknown;
            workspaces?: Record<string, Record<string, unknown>>;
            memberships?: unknown;
          } | null;
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
        const workspace = bootstrap.workspaces?.[eventId] ?? {};
        const client = Array.isArray(bootstrap.clients)
          ? bootstrap.clients.find(
              (item): item is Record<string, unknown> =>
                typeof item === "object" && item !== null && item.id === event?.clientId
            )
          : undefined;
        const venue = typeof workspace.venue === "object" && workspace.venue !== null
          ? workspace.venue as Record<string, unknown>
          : null;
        if (!cancelled) {
          setGate({
            kind: "ready",
            eventName:
              event && typeof event.name === "string" ? event.name : eventId,
            eventMeta: {
              clientName: typeof client?.name === "string" ? client.name : "",
              date: typeof event?.date === "string" ? event.date : "",
              start: typeof event?.start === "string" ? event.start : "",
              end: typeof event?.end === "string" ? event.end : "",
              venue: typeof venue?.name === "string"
                ? venue.name
                : typeof event?.venue === "string"
                  ? event.venue
                  : "",
            },
            // participant.import stops at ENDED/ARCHIVED on the server; the
            // commit control below mirrors that while preview reads stay.
            eventStage: typeof event?.stage === "string" ? event.stage : "",
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
  }, [eventId, retryTick, router]);

  async function readFile(file: File) {
    if (submittingRef.current) return;
    setFileError(null);
    setPreview(null);
    setCommitted(null);
    try {
      if (file.size > MAX_BYTES) throw new Error("1MB 이하 CSV·TXT·XLSX 파일을 선택하세요.");
      const looksWorkbook =
        /\.xlsx?$/i.test(file.name) ||
        file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.type === "application/vnd.ms-excel";
      if (looksWorkbook) {
        const parsed = parseWorkbook(await file.arrayBuffer());
        if (!parsed.rows.length || parsed.rows.length > MAX_ROWS) {
          throw new Error("1~1,000개 데이터 행이 필요합니다.");
        }
        const next: ImportMap = { name: "", phone: "", email: "", company: "" };
        (Object.keys(ALIASES) as Array<keyof ImportMap>).forEach((key) => {
          const at = parsed.headers.findIndex((h) =>
            ALIASES[key].includes(h.trim().toLowerCase())
          );
          next[key] = at < 0 ? "" : String(at);
        });
        setHeaders(parsed.headers);
        setDataRows(parsed.rows);
        setFileKind("csv");
        setMap(next);
        previewFor(parsed.rows, next);
        return;
      }
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
        const txtMap = { name: "0", phone: "1", email: "2", company: "3" };
        setMap(txtMap);
        previewFor(parsed.rows, txtMap);
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
        previewFor(rows, next);
      }
    } catch (error) {
      setHeaders(null);
      setDataRows([]);
      setFileKind(null);
      setFileError(error instanceof Error ? error.message : "파일을 읽지 못했습니다.");
    }
  }

  function previewFor(rows: string[][], nextMap: ImportMap) {
    if (nextMap.name === nextMap.phone && nextMap.name !== "") {
      setPreview(null);
      setFileError("이름과 연락처는 서로 다른 열을 선택하세요.");
      return;
    }
    setFileError(null);
    setPreview(validateRows(rows, nextMap));
  }

  function buildPreview(nextMap: ImportMap) {
    previewFor(dataRows, nextMap);
  }

  async function commit() {
    if (!preview || !preview.valid.length || submittingRef.current) return;
    submittingRef.current = true;
    setCommitting(true);
    setCommitError(null);
    const fingerprint = JSON.stringify([eventId, preview.valid]);
    const attempt = pendingImportRef.current?.fingerprint === fingerprint
      ? pendingImportRef.current
      : { fingerprint, commandId: randomCommandId() };
    pendingImportRef.current = attempt;
    const commandId = attempt.commandId;
    try {
      const res = await fetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId,
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
        if (res.status < 500) pendingImportRef.current = null;
        setCommitError(
          typeof data?.error === "string" ? data.error : "반영하지 못했습니다."
        );
        return;
      }
      if (!Array.isArray(data?.participants)) {
        setCommitError("반영 결과를 확인하지 못했습니다. 같은 명단으로 다시 시도하세요.");
        return;
      }
      const count = data.participants.length;
      pendingImportRef.current = null;
      setCommitted(count);
      setHeaders(null);
      setDataRows([]);
      setPreview(null);
      setFileKind(null);
    } catch {
      setCommitError("연결하지 못했습니다. 다시 시도하세요.");
    } finally {
      submittingRef.current = false;
      setCommitting(false);
    }
  }

  if (gate.kind === "loading") {
    return (
      <ConsolePage pageId="participantImport" eventId={eventId}>
        <ConsoleStatePanel
          kind="loading"
          message="가져오기 화면을 불러오고 있습니다."
          onRetry={() => setRetryTick((tick) => tick + 1)}
        />
      </ConsolePage>
    );
  }
  if (gate.kind === "failed") {
    return (
      <ConsolePage pageId="participantImport" eventId={eventId}>
        <ConsoleStatePanel
          kind="failed"
          message={gate.message}
          onRetry={() => {
            setGate({ kind: "loading" });
            setRetryTick((tick) => tick + 1);
          }}
          actions={(
            <Link
              className="button button-secondary"
              href={`/console/events/${encodeURIComponent(eventId)}/participants`}
            >
              참가자 목록으로
            </Link>
          )}
        />
      </ConsolePage>
    );
  }

  // participant.import stops at ENDED/ARCHIVED on the server: the commit
  // control mirrors that while the file/preview reads stay available.
  const stageKey = gate.eventStage.toUpperCase();
  const stageBlocked = stageKey === "ENDED" || stageKey === "ARCHIVED";
  return (
    <ConsolePage
      pageId="participantImport"
      eventId={eventId}
      eventName={gate.eventName}
      meta={formatConsoleEventMeta(gate.eventMeta)}
      feedback={
        <>
          {committed !== null ? (
            <ConsoleFeedback kind="success">{committed}명을 반영했습니다.</ConsoleFeedback>
          ) : null}
          {!gate.canManage ? (
            <ConsoleFeedback kind="warning">가져오기 권한이 없습니다. 변경이 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {gate.canManage && stageBlocked ? (
            <ConsoleFeedback kind="warning">종료된 행사에는 명단을 가져올 수 없습니다. 파일 검토까지만 확인할 수 있습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      {gate.canManage ? (
        <>
        {/* The step line is context, not a ceremony: import is an optional
            shortcut, so it appears once a file is actually chosen. */}
        {importStep > 1 ? (
          <ol className={styles.importSteps} aria-label="명단 가져오기 단계">
            {(["파일 선택", "열 연결", "검토 후 반영"] as const).map((label, index) => {
              const number = index + 1;
              const state = number < importStep ? "done" : number === importStep ? "current" : "todo";
              return (
                <li
                  key={label}
                  className={`${styles.importStep} ${styles[`importStep${state === "done" ? "Done" : state === "current" ? "Current" : "Todo"}`]}`}
                  aria-current={state === "current" ? "step" : undefined}
                >
                  <span className={styles.importStepNumber}>{number}</span>
                  <span className={styles.importStepLabel}>{label}</span>
                </li>
              );
            })}
          </ol>
        ) : null}
        <ConsoleSection
          headingId="participant-import-file-heading"
          title="1. 파일 선택"
          surface="panel"
        >
          <p className={styles.help}>
            가져오기는 선택적인 도구입니다. 참가자가 스스로 신청하도록 <b>참가 접수</b>를 열어 모으는 경로가
            기본이며, 여기서는 이미 확보한 명단을 한 번에 등록할 때 사용합니다.
          </p>
          <ConsoleToolbar
            filters={
              <label>
                <span className="sr-only">CSV·TXT·XLSX 파일 선택</span>
                <input
                  type="file"
                  disabled={committing}
                  accept=".csv,text/csv,.txt,text/plain,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void readFile(file);
                    event.target.value = "";
                  }}
                />
              </label>
            }
            actions={
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
            }
          />
          <p className="landing-note">CSV·TXT·XLSX · 최대 1MB, 1,000행. 엑셀은 첫 시트의 첫 행을 헤더로 읽으며 256열까지 연결할 수 있습니다. TXT는 한 줄에 한 명: 이름, 연락처, 이메일(선택), 소속(선택).</p>
          {fileError ? <ConsoleFeedback kind="error">{fileError}</ConsoleFeedback> : null}
        </ConsoleSection>
          {headers ? (
            <ConsoleSection
              headingId="participant-import-map-heading"
              title={`2. 열 연결 ${fileKind === "txt" ? "(TXT 고정 순서)" : ""}`}
              surface="panel"
            >
              <ConsoleToolbar
                filters={
                  <>
                    {FIELDS.map((field) => (
                      <label key={field.id}>
                        <span>{field.label}{field.required ? " *" : ""}</span>
                        <select
                          value={map[field.id]}
                          disabled={committing || fileKind === "txt"}
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
                  </>
                }
                actions={
                  <button type="button" className="button button-secondary" disabled={committing} onClick={() => buildPreview(map)}>
                    검토 결과 만들기
                  </button>
                }
              />
            </ConsoleSection>
          ) : null}
          {preview ? (
            <ConsoleSection
              headingId="participant-import-review-heading"
              title="3. 검토 후 반영"
              surface="panel"
            >
              <p className="landing-note" role="status">
                유효 {preview.valid.length}행 · 오류 {preview.errors.length}행. 오류 행은 제외되며 원본 파일에서 수정 후 다시 가져올 수 있습니다.
              </p>
              {preview.valid.length ? (
                <>
                  <p className="landing-note">
                    적용될 값 미리보기 (앞 {Math.min(5, preview.valid.length)}행) — 이름 · 숫자만 남긴 연락처 · 이메일 · 소속입니다.
                  </p>
                  <ul className={consoleUiStyles.collection} aria-label="적용될 값 미리보기">
                    {preview.valid.slice(0, 5).map((row, index) => (
                      <li className={consoleUiStyles.recordRow} key={`${row.phone}-${index}`}>
                        <div className={consoleUiStyles.recordMain}>
                          <span>{row.name}</span>
                          <p className={consoleUiStyles.recordMeta}>
                            {row.phone}
                            {row.email ? ` · ${row.email}` : ""}
                            {row.company ? ` · ${row.company}` : ""}
                          </p>
                        </div>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
              {preview.errors.length ? (
                <ul className={consoleUiStyles.collection} aria-label="가져오기 오류 목록">
                  {preview.errors.slice(0, 50).map((item) => (
                    <li className={consoleUiStyles.recordRow} key={item.row}>
                      <span className={consoleUiStyles.recordMain}>파일 {item.row}행</span>
                      <span className={consoleUiStyles.recordMeta}>{item.reason}</span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {commitError ? <ConsoleFeedback kind="error">{commitError}</ConsoleFeedback> : null}
              <ConsoleFormActions note="가져온 유효 행은 승인 검토 없이 참가 확정으로 등록됩니다. 동의 기록은 가져오기만으로 생성하지 않습니다.">
                <button
                  type="button"
                  className="button button-primary"
                  disabled={committing || !preview.valid.length || stageBlocked}
                  onClick={() => void commit()}
                >
                  {committing ? "반영 중입니다" : `유효 ${preview.valid.length}행 반영`}
                </button>
                <button
                  type="button"
                  className="button button-secondary"
                  disabled={committing}
                  onClick={() => {
                    setHeaders(null);
                    setDataRows([]);
                    setPreview(null);
                    setFileKind(null);
                  }}
                >
                  검토 취소
                </button>
              </ConsoleFormActions>
            </ConsoleSection>
          ) : null}
        </>
      ) : null}
      <p>
        <Link className="button button-secondary" href={`/console/events/${encodeURIComponent(eventId)}/participants`}>참가자 목록으로</Link>
      </p>
    </ConsolePage>
  );
}
