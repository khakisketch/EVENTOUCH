"use client";
import ProductButton from "../../../../../ui/ProductButton";

import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import ProductLink from "../../../../../ui/ProductLink";
import { loginHrefForLocation } from "../../../../../auth-redirect";
import ConsoleDialog from "../../../../console-ui/ConsoleDialog";
import ConsolePage from "../../../../console-ui/ConsolePage";
import ConsoleFeedback from "../../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../../console-ui/ConsoleFormActions";
import ConsoleConfirm from "../../../../console-ui/ConsoleConfirm";
import ConsoleAvatar from "../../../../console-ui/ConsoleAvatar";
import { CheckIcon, DocumentIcon, DownloadIcon, UploadIcon } from "../../../../console-ui/ConsoleIcons";
import {
  formatConsoleEventMeta,
  type ConsoleEventMeta,
} from "../../../../console-ui/ConsolePageHeader";
import ConsoleSection from "../../../../console-ui/ConsoleSection";
import ConsoleStatePanel from "../../../../console-ui/ConsoleStatePanel";
import { useConsoleDraftGuard } from "../../../../console-draft-guard";
import consoleUiStyles from "../../../../console-ui/console-ui.module.css";
import styles from "./import.module.css";
import { consoleFetch } from "../../../../../../lib/console-api";
import { canWriteEvent } from "../../../../../../lib/event-capabilities";
import { acknowledgeOperatorReceipt, confirmsParticipantImport, isOrganizationContextBlock } from "../../../../../../lib/operator-context";
import { forgetOperatorReceipt, manageOperatorReceipt } from "../../../../../../lib/operator-receipts";
import { useEventReceipts } from "../../../../../../lib/use-event-receipts";
import { suggestCompany } from "../../../../../../lib/contact-normalize.cjs";

type ImportMap = { name: string; phone: string; email: string; company: string };
// An extra field of the event's own form (식사 선택, 요청 사항 ...) that a file
// column can fill. Name, phone, email and company have their own columns.
type ExtraField = { id: string; label: string; type: "text" | "email" | "select" | "checkbox"; required: boolean; options: string[] };
type ExtraMap = Record<string, string>;
type Answers = Record<string, string | boolean>;
type ExtraImport = { fields: ExtraField[]; map: ExtraMap };
type ValidRow = { name: string; phone: string; email: string; company: string; line: number; answers?: Answers };
type ImportRow = { cells: string[]; line: number };
type RowError = { row: number; reason: string };
type PhoneReview = { row: number; name: string; phone: string; raw: string };
type EmailReview = { row: number; name: string; email: string };
type ImportPreview = { valid: ValidRow[]; errors: RowError[]; phoneReview: PhoneReview[]; emailReview: EmailReview[] };

type GateState =
  | { kind: "loading" }
  | { kind: "failed"; message: string }
  | { kind: "ready"; eventName: string; eventMeta: ConsoleEventMeta; eventStage: string; role: string; userId: string; memberships: Array<{ accountId: string; eventId: string; write?: unknown }>; extraFields: ExtraField[] };

const MAX_BYTES = 1048576;
const MAX_ROWS = 1000;
const MAX_WORKBOOK_COLUMNS = 256;
const FIELDS: Array<{ id: keyof ImportMap; label: string; required: boolean }> = [
  { id: "name", label: "이름", required: true },
  { id: "phone", label: "연락처", required: true },
  { id: "email", label: "이메일", required: false },
  { id: "company", label: "소속", required: false },
];
// Header words real spreadsheets use for each field. A compound header such
// as "회사/부서" counts when any of its parts matches.
const HEADER_WORDS: Record<keyof ImportMap, string[]> = {
  name: ["이름", "성명", "성함", "name", "fullname", "참가자", "참가자명", "참가자이름", "신청자", "신청자명"],
  phone: ["연락처", "휴대폰", "휴대폰번호", "휴대전화", "휴대전화번호", "핸드폰", "핸드폰번호", "전화", "전화번호", "모바일", "phone", "phonenumber", "mobile", "tel", "cell"],
  email: ["이메일", "이메일주소", "메일", "메일주소", "email", "e-mail", "mail"],
  company: ["소속", "소속명", "회사", "회사명", "기관", "기관명", "단체", "부서", "소속회사", "소속기관", "company", "org", "organization", "affiliation"],
};
const EMPTY_MAP: ImportMap = { name: "", phone: "", email: "", company: "" };
const NO_EXTRA_FIELDS: ExtraField[] = [];
// Ids the standard columns (and the answers carrier) own; never an extra field.
const OWN_FIELD_IDS = new Set(["name", "phone", "email", "company", "group", "answers"]);
// Yes/no words people actually type into a checkbox column. Anything else is a
// row error rather than a guess.
const CHECKED_WORDS = ["예", "네", "y", "yes", "true", "1", "o", "v", "✓", "체크", "동의"];
const UNCHECKED_WORDS = ["", "아니오", "아니요", "n", "no", "false", "0", "-"];

function headerParts(value: string): string[] {
  return value.toLowerCase().replace(/[\s_]/g, "").split(/[/·,]/).filter(Boolean);
}

// Picks the file column for each field: the header word first, then (for
// phone and email, which are recognizable by shape) what the first rows
// look like. A column is never used for two fields. Name and company are
// never guessed from values, so an unrecognized name column is asked, not
// silently chosen.
function detectColumns(headers: string[], rows: ImportRow[]): ImportMap {
  const next: ImportMap = { ...EMPTY_MAP };
  const taken = new Set<number>();
  const take = (key: keyof ImportMap, at: number) => { next[key] = String(at); taken.add(at); };
  (Object.keys(HEADER_WORDS) as Array<keyof ImportMap>).forEach((key) => {
    const at = headers.findIndex((head, index) => !taken.has(index) && headerParts(head).some((part) => HEADER_WORDS[key].includes(part)));
    if (at >= 0) take(key, at);
  });
  const sample = rows.slice(0, 50);
  const shareOf = (index: number, test: (value: string) => boolean) => {
    const values = sample.map((row) => (row.cells[index] ?? "").trim()).filter(Boolean);
    return values.length ? values.filter(test).length / values.length : 0;
  };
  const byShape = (key: keyof ImportMap, test: (value: string) => boolean) => {
    if (next[key]) return;
    const at = headers.findIndex((_, index) => !taken.has(index) && shareOf(index, test) >= 0.6);
    if (at >= 0) take(key, at);
  };
  byShape("phone", (value) => /^[\d\s\-().+]+$/.test(value) && /^\d{9,15}$/.test(normalizePhone(value)));
  byShape("email", (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
  return next;
}

// The event's extra form fields, read defensively from the bootstrap draft form.
function parseExtraFields(value: unknown): ExtraField[] {
  if (!Array.isArray(value)) return [];
  const fields: ExtraField[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    const type = entry.type;
    if (!id || !label || OWN_FIELD_IDS.has(id) || fields.some((field) => field.id === id)) continue;
    if (type !== "text" && type !== "email" && type !== "select" && type !== "checkbox") continue;
    fields.push({
      id, label, type,
      required: entry.required === true,
      options: Array.isArray(entry.options) ? entry.options.filter((option): option is string => typeof option === "string") : [],
    });
  }
  return fields;
}

// Matches a file header to an extra field by its label, ignoring case, spaces and
// "_" (a compound header such as "식사/알레르기" counts when a part matches). Only
// columns the standard fields did not already take are offered, so this never
// changes how the four standard columns are found.
function detectExtraColumns(headers: string[], fields: ExtraField[], taken: Set<string>): ExtraMap {
  const next: ExtraMap = {};
  const used = new Set(taken);
  for (const field of fields) {
    const key = field.label.toLowerCase().replace(/[\s_]/g, "");
    const at = headers.findIndex((head, index) => !used.has(String(index))
      && (head.toLowerCase().replace(/[\s_]/g, "") === key || headerParts(head).includes(key)));
    if (at >= 0) { next[field.id] = String(at); used.add(String(at)); }
  }
  return next;
}

function parseChecked(raw: string): boolean | null {
  const word = raw.trim().toLowerCase();
  if (CHECKED_WORDS.includes(word)) return true;
  if (UNCHECKED_WORDS.includes(word)) return false;
  return null;
}

// One cell of an extra-field column, held to the same rules the server applies to
// operator registration (select choices, email shape, required, checkbox boolean).
function readAnswer(field: ExtraField, raw: string): { value: string | boolean } | { error: string } {
  if (field.type === "checkbox") {
    const checked = parseChecked(raw);
    if (checked === null) return { error: `${field.label}은(는) 예·아니오로 입력하세요(${raw.slice(0, 20)})` };
    if (field.required && !checked) return { error: `${field.label}에 동의(체크)해야 합니다` };
    return { value: checked };
  }
  if (!raw) return field.required ? { error: `${field.label}을(를) 입력하세요` } : { value: "" };
  if (raw.length > 4000) return { error: `${field.label}이(가) 4,000자를 초과합니다` };
  if (field.type === "select" && !field.options.includes(raw)) return { error: `${field.label}의 선택지에 없는 값입니다(${raw.slice(0, 20)})` };
  if (field.type === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { error: `${field.label} 형식을 확인하세요` };
  return { value: raw };
}

// Display only: the stored value stays the digits.
function formatPhone(digits: string): string {
  return /^010\d{8}$/.test(digits) ? `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}` : digits;
}

function sampleOf(rows: ImportRow[], index: number): string {
  const seen: string[] = [];
  for (const row of rows) {
    const value = (row.cells[index] ?? "").trim();
    if (value && !seen.includes(value)) seen.push(value);
    if (seen.length === 3) break;
  }
  return seen.join(", ");
}

function randomCommandId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function stripBom(text: string): string {
  return text.replace(/^﻿/, "");
}

// Same grammar as the legacy app: quoted cells, doubled quotes, CRLF.
function parseCsv(text: string): ImportRow[] {
  const rows: ImportRow[] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let rowLine = 1;
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
      if (row.some((x) => x.trim())) rows.push({ cells: row, line: rowLine });
      row = [];
      cell = "";
      line++;
      rowLine = line;
    } else {
      cell += c;
      if (c === "\n" || (c === "\r" && text[i + 1] !== "\n")) line++;
    }
  }
  if (quoted) throw new Error("따옴표가 닫히지 않은 CSV입니다.");
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push({ cells: row, line: rowLine });
  return rows;
}

// XLSX: the first worksheet becomes header + data rows. Values are read as
// displayed text (no formulas), trimmed to the same limits as CSV cells, and
// flow into the same column-mapping and validation below. The parser loads
// lazily — only an actual Excel file downloads it; CSV·TXT·template flows
// never pay for it. No new dependency: the declared xlsx build is split
// into its own chunk by the dynamic import below.
async function parseWorkbook(buffer: ArrayBuffer): Promise<{ headers: string[]; rows: ImportRow[] }> {
  const XLSX = await import("xlsx");
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
    .map((line, index) => ({ line: bounds.s.r + index + 1, cells:
      (Array.isArray(line) ? line : []).map((cell) =>
        typeof cell === "string" ? cell.trim().slice(0, 4000)
        : typeof cell === "number" && Number.isFinite(cell) ? String(cell).slice(0, 4000)
        : ""
      ) }))
    .filter((row) => row.cells.some((cell) => cell.trim()));
  if (rows.length < 2 || rows.length > MAX_ROWS + 1) {
    throw new Error("헤더와 1~1,000개 데이터 행이 필요합니다.");
  }
  const head = rows.shift()?.cells ?? [];
  return { headers: head, rows };
}

// TXT: one participant per line — 이름, 연락처, 이메일(선택), 소속(선택).
// Comma/semicolon/tab preferred; bare whitespace splits name/phone/company.
function parseTxt(text: string): { headers: string[]; rows: ImportRow[] } {
  const headers = ["이름", "연락처", "이메일", "소속"];
  const rows: ImportRow[] = [];
  for (const [index, line] of text.split(/\r\n|\r|\n/).entries()) {
    if (!line.trim()) continue;
    const cells = /[,;\t]/.test(line)
      ? line.split(/[,;\t]/).map((x) => x.trim())
      : line.trim().split(/\s+/);
    while (cells.length < 4) cells.push("");
    rows.push({ cells: cells.slice(0, 4), line: index + 1 });
  }
  return { headers, rows };
}

// Same rule as lib/contact-normalize.cjs (the server stores what this shows):
// digits only, "+82" and a spreadsheet-dropped leading 0 restored. Kept inline
// so the preview logic stays self-contained.
function normalizePhone(value: string): string {
  const digits = value.replace(/\D/g, "");
  const international = /^82(0?)([1-9]\d{7,9})$/.exec(digits);
  if (international) return `0${international[2]}`;
  if (/^[1-9]\d{8,9}$/.test(digits)) return `0${digits}`;
  return digits;
}

function validateRows(
  dataRows: ImportRow[],
  map: ImportMap,
  extra?: ExtraImport
): ImportPreview {
  const valid: ValidRow[] = [];
  const errors: RowError[] = [];
  const phoneReview: PhoneReview[] = [];
  const emailReview: EmailReview[] = [];
  const seen = new Set<string>();
  dataRows.forEach(({ cells: cols, line }) => {
    const get = (key: keyof ImportMap) =>
      map[key] === "" ? "" : (cols[Number(map[key])] ?? "").trim();
    // Server limits stay as-is (60/120/200), but over-limit values are
    // field errors with row numbers — never silently cut before validation.
    const name = get("name");
    const rawPhone = get("phone");
    const phone = normalizePhone(rawPhone);
    const email = get("email");
    const company = get("company");
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
    if (company.length > 200) {
      errors.push({ row: line, reason: `소속이 200자를 초과합니다(${company.length}자)` });
      return;
    }
    // Answers for the extra form fields this file carries. A field with no
    // column is left out entirely (never "required"), so a form field the file
    // does not include cannot block every row.
    const collected: Answers = {};
    if (extra) {
      for (const field of extra.fields) {
        const column = extra.map[field.id];
        if (!column) continue;
        const result = readAnswer(field, (cols[Number(column)] ?? "").trim());
        if ("error" in result) {
          errors.push({ row: line, reason: result.error });
          return;
        }
        if (result.value !== "") collected[field.id] = result.value;
      }
    }
    if (seen.has(phone)) {
      errors.push({ row: line, reason: "파일 안에서 연락처가 중복됩니다" });
      return;
    }
    seen.add(phone);
    valid.push({ name, phone, email, company, line, ...(Object.keys(collected).length ? { answers: collected } : {}) });
    // A spreadsheet drops the first 0 of a numeric cell. The number is restored
    // and listed so the operator can see exactly what changed (never silent).
    if (phone !== rawPhone.replace(/\D/g, "")) phoneReview.push({ row: line, name, phone, raw: rawPhone });
    // A malformed email does not block registration; the roster flags it for review.
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) emailReview.push({ row: line, name, email });
  });
  return { valid, errors, phoneReview, emailReview };
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

type ImportFrameProps = ComponentProps<typeof ConsolePage> & { onDismiss?: () => void; busy?: boolean; canClose?: () => boolean; footer?: ReactNode };
function ImportFrame({ onDismiss, busy, canClose, footer, ...page }: ImportFrameProps) {
  if (!onDismiss) return <ConsolePage {...page} />;
  return <ConsoleDialog title="명단 가져오기" wide stickyChrome busy={busy} canClose={canClose} onClose={onDismiss} footer={footer}>
    <div className={styles.modalContent}>{page.feedback}{page.children}</div>
  </ConsoleDialog>;
}

export default function ImportWizard({ eventId, onDismiss, onCommitted, knownCompanies = [] }: { eventId: string; onDismiss?: () => void; onCommitted?: () => void; knownCompanies?: string[] }) {
  const router = useRouter();
  const [dragging, setDragging] = useState(false);
  const [dismissConfirm, setDismissConfirm] = useState(false);
  const committedCallback = useRef(onCommitted);
  committedCallback.current = onCommitted;
  const [gate, setGate] = useState<GateState>({ kind: "loading" });
  const [retryTick, setRetryTick] = useState(0);
  const [headers, setHeaders] = useState<string[] | null>(null);
  const [dataRows, setDataRows] = useState<ImportRow[]>([]);
  const [fileKind, setFileKind] = useState<"csv" | "txt" | null>(null);
  const [map, setMap] = useState<ImportMap>({ ...EMPTY_MAP });
  const [extraMap, setExtraMap] = useState<ExtraMap>({});
  const extraFields = gate.kind === "ready" ? gate.extraFields : NO_EXTRA_FIELDS;
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [, setPhoneReviewed] = useState(false);
  // Opt-in spelling fixes for a rare 소속 that looks like a common one (삼상전자 → 삼성전자).
  const [companyFixes, setCompanyFixes] = useState<Record<string, boolean>>({});
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [readingFile, setReadingFile] = useState(false);
  const fileReadingRef = useRef(false);
  const fileReadIdRef = useRef(0);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<number | null>(null);
  const [committing, setCommitting] = useState(false);
  const [importUncertain, setImportUncertain] = useState(false);
  const [checkingImport, setCheckingImport] = useState(false);
  const [errorsOpen, setErrorsOpen] = useState(false);
  useEffect(() => { if (committed !== null) committedCallback.current?.(); }, [committed]);
  function canDismiss() {
    if (submittingRef.current || committing || checkingImport) return false;
    if (importUncertain || headers || preview) { setDismissConfirm(true); return false; }
    return true;
  }
  const submittingRef = useRef(false);
  const pendingImportRef = useRef<{ fingerprint: string; commandId: string; rows: ValidRow[]; uncertain: boolean } | null>(null);
  const otherImportReceipt = useEventReceipts(eventId).some((item) => item.command === "participant.import" && item.commandId !== pendingImportRef.current?.commandId);
  const importLocked = committing || checkingImport || importUncertain || otherImportReceipt || readingFile;

  // Unsaved import work guards navigation: loaded rows, column mapping and
  // an uncommitted preview would be lost on leave. Filters are none here;
  // a committed import clears the draft and the page is clean again.
  useConsoleDraftGuard(headers !== null || preview !== null || importUncertain || committing || checkingImport || readingFile,
    importUncertain ? "명단이 이미 반영되었을 수 있습니다. 화면을 떠나면 같은 입력으로 다시 확인하기 어렵습니다." : "가져오기 위해 정리한 명단이 사라질 수 있습니다.");

  // The inline recovery offers both read-only status and the frozen retry.
  // After leaving this screen its cleanup reveals the shared status panel.
  useEffect(() => {
    const attempt = pendingImportRef.current;
    if (!importUncertain || !attempt) return;
    return manageOperatorReceipt(attempt.commandId);
  }, [eventId, importUncertain]);

  // Event switch resets explicit local file state (never a key remount):
  // rows mapped for another event must not commit into this one.
  useEffect(() => {
    fileReadIdRef.current += 1;
    fileReadingRef.current = false;
    setReadingFile(false);
    setHeaders(null);
    setDataRows([]);
    setFileKind(null);
    setFileName(null);
    setMap({ ...EMPTY_MAP });
    setExtraMap({});
    setPreview(null);
    setPhoneReviewed(false);
    setErrorsOpen(false);
    setFileError(null);
    setCommitError(null);
    setCommitted(null);
    pendingImportRef.current = null;
    setImportUncertain(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eventId]);

  useEffect(() => () => { fileReadIdRef.current += 1; fileReadingRef.current = false; }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const [meRes, bootRes] = await Promise.all([
          consoleFetch("/api/auth/me", { cache: "no-store" }),
          consoleFetch(`/api/events/${encodeURIComponent(eventId)}/bootstrap`, { cache: "no-store" }),
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
        // Raw membership grants ride along untouched: omitted write reads as
        // full access, an explicit [] as read-only. The render gate below
        // re-checks the participant.import scope through the capability
        // helper (server/event-permissions.js stays the authority).
        const memberships = Array.isArray(bootstrap.memberships)
          ? bootstrap.memberships.flatMap((item): Array<{ accountId: string; eventId: string; write?: unknown }> => {
              if (typeof item !== "object" || item === null) return [];
              const membership = item as Record<string, unknown>;
              if (typeof membership.accountId !== "string" || typeof membership.eventId !== "string") return [];
              return [{ accountId: membership.accountId, eventId: membership.eventId, write: membership.write }];
            })
          : [];
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
            role,
            userId: myId,
            memberships,
            extraFields: parseExtraFields(workspace.fields),
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
    if (submittingRef.current || importLocked || fileReadingRef.current) return;
    const readId = ++fileReadIdRef.current;
    fileReadingRef.current = true;
    setReadingFile(true);
    setFileError(null);
    setFileName(file.name);
    setHeaders(null);
    setDataRows([]);
    setPreview(null);
    setPhoneReviewed(false);
    setCommitted(null);
    try {
      if (file.size > MAX_BYTES) throw new Error("1MB 이하 CSV·TXT·XLS·XLSX 파일을 선택하세요.");
      const extension = /\.(csv|txt|xlsx?)$/i.exec(file.name)?.[1].toLowerCase();
      // A recognized filename is authoritative; browser MIME is advisory.
      const looksWorkbook = /\.xlsx?$/i.test(file.name) || (!extension && (
        file.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
        file.type === "application/vnd.ms-excel"
      ));
      if (looksWorkbook) {
        const parsed = await parseWorkbook(await file.arrayBuffer());
        if (fileReadIdRef.current !== readId) return;
        if (!parsed.rows.length || parsed.rows.length > MAX_ROWS) {
          throw new Error("1~1,000개 데이터 행이 필요합니다.");
        }
        const next = detectColumns(parsed.headers, parsed.rows);
        const nextExtra = detectExtraColumns(parsed.headers, extraFields, new Set(Object.values(next).filter(Boolean)));
        setHeaders(parsed.headers);
        setDataRows(parsed.rows);
        setFileKind("csv");
        setMap(next);
        setExtraMap(nextExtra);
        previewFor(parsed.rows, next, nextExtra);
        setFileName(file.name);
        return;
      }
      const text = stripBom(await file.text());
      if (fileReadIdRef.current !== readId) return;
      const looksTxt = extension ? extension === "txt" : file.type.startsWith("text/plain");
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
        setExtraMap({});
        previewFor(parsed.rows, txtMap, {});
        setFileName(file.name);
      } else {
        const rows = parseCsv(text);
        if (rows.length < 2 || rows.length > MAX_ROWS + 1) {
          throw new Error("헤더와 1~1,000개 데이터 행이 필요합니다.");
        }
        const head = rows.shift()?.cells ?? [];
        const next = detectColumns(head, rows);
        const nextExtra = detectExtraColumns(head, extraFields, new Set(Object.values(next).filter(Boolean)));
        setHeaders(head);
        setDataRows(rows);
        setFileKind("csv");
        setMap(next);
        setExtraMap(nextExtra);
        previewFor(rows, next, nextExtra);
        setFileName(file.name);
      }
    } catch (error) {
      if (fileReadIdRef.current !== readId) return;
      setHeaders(null);
      setDataRows([]);
      setFileKind(null);
      setFileName(null);
      setFileError(error instanceof Error ? error.message : "파일을 읽지 못했습니다.");
    } finally {
      if (fileReadIdRef.current === readId) {
        fileReadingRef.current = false;
        setReadingFile(false);
      }
    }
  }

  function previewFor(rows: ImportRow[], nextMap: ImportMap, nextExtra: ExtraMap) {
    setPhoneReviewed(false);
    setErrorsOpen(false);
    if (nextMap.name === nextMap.phone && nextMap.name !== "") {
      setPreview(null);
      setFileError("이름과 연락처는 서로 다른 열을 선택하세요.");
      return;
    }
    setFileError(null);
    setPreview(validateRows(rows, nextMap, extraFields.length ? { fields: extraFields, map: nextExtra } : undefined));
  }

  function buildPreview(nextMap: ImportMap, nextExtra: ExtraMap) {
    if (importLocked || fileReadingRef.current) return;
    previewFor(dataRows, nextMap, nextExtra);
  }

  async function commit() {
    if (!preview || !preview.valid.length || submittingRef.current || checkingImport || otherImportReceipt || fileReadingRef.current) return;
    submittingRef.current = true;
    setCommitting(true);
    setCommitError(null);
    const rowsToSend = preview.valid.map((row) => companyFixes[row.company] && companySuggestions.some((item) => item.from === row.company) ? { ...row, company: companySuggestions.find((item) => item.from === row.company)!.to } : row);
    const fingerprint = JSON.stringify([eventId, rowsToSend]);
    if (pendingImportRef.current?.uncertain && pendingImportRef.current.fingerprint !== fingerprint) {
      submittingRef.current = false;
      setCommitting(false);
      setCommitError("이전 명단 반영 결과를 먼저 확인하세요.");
      return;
    }
    const attempt = pendingImportRef.current?.fingerprint === fingerprint
      ? pendingImportRef.current
      : { fingerprint, commandId: randomCommandId(), rows: rowsToSend.map((row) => ({ ...row })), uncertain: false };
    pendingImportRef.current = attempt;
    const commandId = attempt.commandId;
    try {
      const res = await consoleFetch(
        `/api/events/${encodeURIComponent(eventId)}/commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commandId,
            command: "participant.import",
            payload: { rows: attempt.rows },
          }),
        }
      );
      const data = (await res.json()) as {
        error?: unknown;
        participants?: unknown[];
      } | null;
      if (!res.ok) {
        const definitive = res.status >= 400 && res.status < 500 && ![408, 425, 429].includes(res.status) && !attempt.uncertain;
        if (definitive) { pendingImportRef.current = null; setImportUncertain(false); }
        else { attempt.uncertain = true; setImportUncertain(true); }
        setCommitError(definitive ? (typeof data?.error === "string" ? data.error : "반영하지 못했습니다.")
          : "명단 반영 결과를 확인하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.");
        return;
      }
      if (!confirmsParticipantImport({ rows: attempt.rows }, data)) {
        attempt.uncertain = true;
        setImportUncertain(true);
        setCommitError("반영 결과를 확인하지 못했습니다. 같은 명단으로 다시 시도하세요.");
        return;
      }
      const count = attempt.rows.length;
      pendingImportRef.current = null;
      setImportUncertain(false);
      setCommitted(count);
      setHeaders(null);
      setDataRows([]);
      setPreview(null);
      setFileKind(null);
      setFileName(null);
    } catch (error) {
      if (!attempt.uncertain && isOrganizationContextBlock(error)) {
        pendingImportRef.current = null;
        setCommitError("현재 조직을 확인한 뒤 다시 시도하세요.");
      } else {
        attempt.uncertain = true;
        setImportUncertain(true);
        setCommitError("연결하지 못했습니다. 서버 처리 확인 또는 같은 요청 다시 시도를 선택하세요.");
      }
    } finally {
      submittingRef.current = false;
      setCommitting(false);
    }
  }

  // Back to the file picker. Locked while a write is in flight or uncertain,
  // so a pending attempt is never dropped from here.
  function changeFile() {
    if (importLocked) return;
    pendingImportRef.current = null;
    setHeaders(null);
    setDataRows([]);
    setPreview(null);
    setFileKind(null);
    setFileName(null);
  }

  async function checkImportResult() {
    const attempt = pendingImportRef.current;
    if (!attempt?.uncertain || committing || checkingImport) return;
    setCheckingImport(true);
    setCommitError(null);
    try {
      const res = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/command-receipts/${encodeURIComponent(attempt.commandId)}`, { cache: "no-store" });
      const data = await res.json().catch(() => null) as { status?: unknown; command?: unknown } | null;
      if (res.ok && data?.status === "APPLIED" && data.command === "participant.import") {
        acknowledgeOperatorReceipt(attempt.commandId);
        forgetOperatorReceipt(attempt.commandId);
        pendingImportRef.current = null;
        setImportUncertain(false);
        setCommitted(attempt.rows.length);
        setHeaders(null); setDataRows([]); setPreview(null); setFileKind(null); setFileName(null);
      } else if (res.ok && data?.status === "UNCONFIRMED") setCommitError("아직 반영 여부를 확인할 수 없습니다. 잠시 후 다시 확인하거나 같은 요청을 다시 시도하세요.");
      else if (res.status >= 500 || [425, 429].includes(res.status)) setCommitError("일시적으로 처리 결과를 확인하지 못했습니다. 잠시 후 다시 확인하세요.");
      else setCommitError("결과를 확인하지 못했습니다. 현재 계정과 행사 접근 권한을 확인하세요.");
    } catch { setCommitError("서버에 연결하지 못했습니다. 명단을 다시 보내지 않았습니다."); }
    finally { setCheckingImport(false); }
  }

  if (gate.kind === "loading") {
    return (
      <ImportFrame pageId="participantImport" eventId={eventId} onDismiss={onDismiss} busy={committing || checkingImport} canClose={canDismiss}>
        <ConsoleStatePanel
          kind="loading" shape="form"
          message="가져오기 화면을 불러오고 있습니다."
          onRetry={() => setRetryTick((tick) => tick + 1)}
        />
      </ImportFrame>
    );
  }
  if (gate.kind === "failed") {
    return (
      <ImportFrame pageId="participantImport" eventId={eventId} onDismiss={onDismiss} busy={committing || checkingImport} canClose={canDismiss}>
        <ConsoleStatePanel
          kind="failed"
          message={gate.message}
          onRetry={() => {
            setGate({ kind: "loading" });
            setRetryTick((tick) => tick + 1);
          }}
          actions={(
            <ProductLink
              className="button button-secondary"
              href={`/console/events/${encodeURIComponent(eventId)}/participants`}
            >
              참가자 목록으로
            </ProductLink>
          )}
        />
      </ImportFrame>
    );
  }

  // participant.import stops at ENDED/ARCHIVED on the server: the commit
  // control mirrors that while the file/preview reads stay available.
  // The write gate mirrors the server's per-command scope map: only a
  // participants grant (or full access) opens the wizard. Reads — the
  // template download and the back link — stay on every membership.
  const stageKey = gate.eventStage.toUpperCase();
  const stageBlocked = stageKey === "ENDED" || stageKey === "ARCHIVED";
  const canWriteImport = canWriteEvent(
    { role: gate.role, userId: gate.userId, memberships: gate.memberships, eventId },
    "participant.import"
  );

  // A required field with no column is asked first; nothing else is worth
  // reviewing until the operator chooses it. TXT has a fixed order.
  const missingField: "name" | "phone" | null = headers && fileKind !== "txt"
    ? (!map.name ? "name" : !map.phone ? "phone" : null)
    : null;
  const missingLabel = missingField === "name" ? "이름" : "연락처";
  const missingUse = missingField === "name" ? "이름으로" : "연락처로";
  const usedColumns = new Set([...Object.values(map), ...Object.values(extraMap)].filter(Boolean));
  // Required form fields the file has no column for: their answer stays empty.
  const unmappedRequired = extraFields.filter((field) => field.required && !extraMap[field.id]);
  const reviewing = Boolean(headers && preview && !missingField);
  // 소속 spellings already in this event plus the file's, by head count.
  const companyCounts = new Map<string, number>();
  for (const name of [...knownCompanies, ...(preview?.valid ?? []).map((row) => row.company)]) {
    const value = name.trim();
    if (value) companyCounts.set(value, (companyCounts.get(value) ?? 0) + 1);
  }
  const fileCompanyCounts = new Map<string, number>();
  for (const row of preview?.valid ?? []) if (row.company) fileCompanyCounts.set(row.company, (fileCompanyCounts.get(row.company) ?? 0) + 1);
  const companySuggestions = [...fileCompanyCounts.keys()].flatMap((from) => {
    const hit = suggestCompany(from, companyCounts);
    return hit ? [{ from, to: hit.company, rows: fileCompanyCounts.get(from) ?? 0, toCount: hit.count }] : [];
  });
  const cleanCount = preview ? preview.valid.length - preview.emailReview.length : 0;
  const commitDisabled = committing || checkingImport || otherImportReceipt || !preview?.valid.length || stageBlocked;

  function changeColumn(field: keyof ImportMap, value: string) {
    const next = { ...map, [field]: value };
    setMap(next);
    buildPreview(next, extraMap);
  }

  function changeExtraColumn(fieldId: string, value: string) {
    const next = { ...extraMap, [fieldId]: value };
    setExtraMap(next);
    buildPreview(map, next);
  }

  const listHref = `/console/events/${encodeURIComponent(eventId)}/participants`;
  const actions = canWriteImport && headers ? (
    <div className={styles.actions}><ConsoleFormActions note="가져온 유효 행은 승인 검토 없이 참가 확정으로 등록됩니다. 동의 기록은 가져오기만으로 생성하지 않습니다. 열 제목이 행사의 신청 항목 이름과 같으면 그 응답도 함께 가져옵니다.">
      {onDismiss ? null : <ProductLink className={`button button-ghost ${styles.outlinedAction}`} variant="ghost" href={listHref}>참가자 목록으로</ProductLink>}
      {importUncertain ? <ProductButton type="button" variant="secondary" disabled={committing || checkingImport} onClick={() => void checkImportResult()}>{checkingImport ? "확인 중입니다" : "서버 처리 확인"}</ProductButton> : null}
      {reviewing ? <ProductButton type="button" variant="primary" disabled={commitDisabled} onClick={() => void commit()}>
        {committing ? "등록 중입니다" : importUncertain ? "같은 요청 다시 시도" : `${preview?.valid.length ?? 0}명 등록`}
      </ProductButton> : null}
    </ConsoleFormActions></div>
  ) : null;

  return (
    <ImportFrame onDismiss={onDismiss} busy={committing || checkingImport} canClose={canDismiss}
      pageId="participantImport"
      eventId={eventId}
      eventName={gate.eventName}
      meta={formatConsoleEventMeta(gate.eventMeta)}
      footer={actions}
      feedback={
        <>
          {committed !== null ? (
            <ConsoleFeedback kind="success">{committed}명을 반영했습니다. 참가자 명단에 참가 확정으로 추가했습니다.</ConsoleFeedback>
          ) : null}
          {otherImportReceipt ? <ConsoleFeedback kind="warning">이전 명단 반영 결과를 위의 처리 결과 확인에서 확인한 뒤 새 명단을 가져올 수 있습니다.</ConsoleFeedback> : null}
          {importUncertain ? <ConsoleFeedback kind="warning">명단 반영 결과 확인이 필요합니다. <a className="button button-secondary" href="#participant-import-review-heading">결과 확인으로 이동</a></ConsoleFeedback> : null}
          {!canWriteImport ? (
            <ConsoleFeedback kind="warning">가져오기 권한이 없습니다. 변경이 필요하면 담당 행사 운영자에게 요청하세요.</ConsoleFeedback>
          ) : null}
          {canWriteImport && stageBlocked ? (
            <ConsoleFeedback kind="warning">종료된 행사에는 명단을 가져올 수 없습니다. 파일 검토까지만 확인할 수 있습니다.</ConsoleFeedback>
          ) : null}
        </>
      }
    >
      {canWriteImport ? (
        <>
        <ol className={styles.steps} aria-label="가져오기 단계">
          {["파일 선택", "열 연결·확인", "등록 완료"].map((label, index) => {
            const stepNow = committed !== null && !headers ? 3 : headers ? 2 : 1;
            const state = index + 1 < stepNow ? "done" : index + 1 === stepNow ? "current" : "todo";
            return (
              <li key={label} data-step={state} aria-current={state === "current" ? "step" : undefined}>
                <span className={styles.stepMark} aria-hidden="true">{state === "done" ? <CheckIcon /> : index + 1}</span>
                <span>{label}</span>
              </li>
            );
          })}
        </ol>
        {fileError ? <ConsoleFeedback kind="error">{fileError}</ConsoleFeedback> : null}
        {readingFile ? <ConsoleFeedback kind="info">{fileName} 파일을 읽고 있습니다. 읽기가 끝나면 내용을 확인할 수 있습니다.</ConsoleFeedback> : null}

        {!headers ? (
          <ConsoleSection headingId="participant-import-file-heading" title="파일 선택" className={styles.stage}>
            {committed !== null ? (
              <div className={styles.doneActions}>
                <ProductButton type="button" variant="ghost" onClick={() => setCommitted(null)}>다른 파일 가져오기</ProductButton>
                {onDismiss
                  ? <ProductButton type="button" variant="primary" onClick={onDismiss}>참가자 명단 보기</ProductButton>
                  : <ProductLink className="button button-primary" variant="primary" href={listHref}>참가자 목록으로</ProductLink>}
              </div>
            ) : (
              <>
                <label data-import-dropzone data-dragging={dragging || undefined}
                  onDragOver={(event) => { event.preventDefault(); if (!importLocked) setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={(event) => {
                    event.preventDefault(); setDragging(false);
                    if (importLocked) return;
                    if (event.dataTransfer.files.length !== 1) { setFileError("파일을 한 개씩 넣어 주세요."); return; }
                    const file = event.dataTransfer.files[0];
                    if (file) void readFile(file);
                  }}
                  className={importLocked ? `${styles.filePicker} ${styles.filePickerDisabled}` : styles.filePicker}>
                  <span className="sr-only">CSV·TXT·XLS·XLSX 파일 선택</span>
                  <span className={styles.dropIcon} aria-hidden="true"><UploadIcon /></span>
                  <span className={styles.dropTitle} aria-hidden="true">엑셀이나 CSV 파일을 여기에 끌어 놓으세요</span>
                  <span className={styles.fileButton} aria-hidden="true">파일 선택</span>
                  <input
                    className={styles.fileInput}
                    type="file"
                    disabled={importLocked}
                    accept=".csv,text/csv,.txt,text/plain,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void readFile(file);
                      event.target.value = "";
                    }}
                  />
                </label>
                <p className={styles.fileMeta}>
                  <span>CSV·TXT·XLS·XLSX · 최대 1MB, 1,000행. 첫 행은 제목 줄로 읽습니다. TXT는 한 줄에 한 명: 이름, 연락처, 이메일(선택), 소속(선택). 이메일이 없으면 쉼표·탭으로 구분하고 이메일 칸을 비우세요(예: 홍길동,01012345678,,회사명). 띄어쓰기만으로는 소속을 구분할 수 없습니다.</span>
                  <ProductButton
                    type="button"
                    variant="ghost"
                    className={styles.outlinedAction}
                    icon={<DownloadIcon />}
                    onClick={() =>
                      downloadCsv("EVENTOUCH_import_template.csv", [
                        ["이름", "연락처", "이메일", "소속", ...extraFields.map((field) => field.label)],
                        ["예시 참가자", "010-0000-9999", "sample@example.demo", "예시 조직", ...extraFields.map((field) =>
                          field.type === "select" ? field.options[0] ?? "" : field.type === "checkbox" ? "예" : field.type === "email" ? "sample@example.demo" : "예시")],
                      ])
                    }
                  >
                    양식 CSV 받기
                  </ProductButton>
                </p>
              </>
            )}
          </ConsoleSection>
        ) : (
          <ConsoleSection headingId="participant-import-review-heading" title="가져올 명단 확인" className={styles.stage}>
            <div className={styles.fileLine}>
              <span className={styles.fileIcon} aria-hidden="true"><DocumentIcon /></span>
              <div className={styles.fileText}>
                <b>{fileName}</b>
                <small>{dataRows.length}행을 읽었어요</small>
              </div>
              <ProductButton type="button" variant="ghost" disabled={importLocked} onClick={changeFile}>파일 바꾸기</ProductButton>
            </div>

            {missingField ? (
              <fieldset className={styles.pick} disabled={importLocked}>
                <legend className={styles.pickTitle}>어느 열이 {missingLabel}인가요?</legend>
                <p className={styles.pickSub}>
                  {missingField === "phone" && map.name ? "이름은 연결했어요. " : ""}
                  제목으로 알아보지 못했어요. {missingUse} 쓸 열을 하나 골라 주세요.
                </p>
                <div className={styles.pickList}>
                  {headers.map((head, index) => usedColumns.has(String(index)) ? null : (
                    <label key={index} className={styles.pickRow}>
                      <input type="radio" name="import-missing-column" value={String(index)} checked={false} onChange={() => changeColumn(missingField, String(index))} />
                      <span><b>{head || `열 ${index + 1}`}</b><small>{sampleOf(dataRows, index) || "비어 있음"}</small></span>
                    </label>
                  ))}
                </div>
              </fieldset>
            ) : preview ? (
              <>
                <div className={styles.hero} data-empty={preview.valid.length ? undefined : "true"} role="status">
                  <h3 className={styles.heroLabel}>{preview.valid.length ? "등록할 수 있어요" : "등록할 수 있는 행이 없어요"}</h3>
                  <p className={styles.heroNumber}><b>{preview.valid.length}</b><span>명</span></p>
                  <div className={styles.bar} role="img" aria-label={`바로 등록 ${cleanCount}명, 등록 후 확인 ${preview.emailReview.length}명, 제외 ${preview.errors.length}행`}>
                    {cleanCount ? <i data-kind="clean" style={{ flexGrow: cleanCount }} /> : null}
                    {preview.emailReview.length ? <i data-kind="check" style={{ flexGrow: preview.emailReview.length }} /> : null}
                    {preview.errors.length ? <i data-kind="skip" style={{ flexGrow: preview.errors.length }} /> : null}
                  </div>
                  <p className={styles.legend}>
                    <span data-kind="clean">바로 등록<b>{cleanCount}</b></span>
                    <span data-kind="check">등록 후 확인<b>{preview.emailReview.length}</b></span>
                    <span data-kind="skip">제외<b>{preview.errors.length}</b></span>
                  </p>
                </div>

                {preview.valid.length ? (
                  <div className={styles.sample}>
                    <p className={styles.sampleLabel}>이렇게 등록돼요<small>앞 {Math.min(3, preview.valid.length)}명</small></p>
                    <ul className={styles.sampleList} aria-label="적용될 값 미리보기">
                      {preview.valid.slice(0, 3).map((row, index) => (
                        <li key={`${row.phone}-${index}`}>
                          <ConsoleAvatar name={row.name} tone="ok" />
                          <span className={styles.sampleWho}>
                            <b>{row.name}</b>
                            {row.company || row.email ? <small>{[row.company, row.email].filter(Boolean).join(" · ")}</small> : null}
                          </span>
                          <span className={styles.samplePhone}>{formatPhone(row.phone)}</span>
                        </li>
                      ))}
                      {preview.valid.length > 3 ? <li className={styles.sampleMore}>외 {preview.valid.length - 3}명</li> : null}
                    </ul>
                  </div>
                ) : null}

                {preview.phoneReview.length ? (
                  <details className={styles.autoFix}>
                    <summary>자동으로 맞춘 항목 {preview.phoneReview.length}건<small>연락처 앞자리 0 복원</small></summary>
                      <div className={styles.notice} data-tone="info">
                        <h4>연락처 {preview.phoneReview.length}건은 앞자리 0을 붙여 등록해요</h4>
                        <p>엑셀이 숫자 칸의 첫 0을 지운 번호입니다. 하이픈(-)이나 +82가 있어도 그대로 받아들입니다.</p>
                        <ul className={styles.chips} aria-label="앞자리 0을 붙인 연락처 목록">
                          {preview.phoneReview.slice(0, 5).map((item) => <li key={item.row}>파일 {item.row}행 · {item.name} <small>{item.raw} → {formatPhone(item.phone)}</small></li>)}
                        </ul>
                        {preview.phoneReview.length > 5 ? (
                          <details className={styles.more}>
                            <summary>나머지 {preview.phoneReview.length - 5}건 보기</summary>
                            <ul className={styles.chips} aria-label="앞자리 0을 붙인 연락처 나머지 목록">
                              {preview.phoneReview.slice(5).map((item) => <li key={item.row}>파일 {item.row}행 · {item.name} <small>{item.raw} → {formatPhone(item.phone)}</small></li>)}
                            </ul>
                          </details>
                        ) : null}
                      </div>
                  </details>
                ) : null}

                {preview.emailReview.length ? (
                  <div className={styles.notice} data-tone="check">
                    <h4>이메일 {preview.emailReview.length}건은 형식이 맞지 않아요</h4>
                    <p>참가자는 그대로 등록하고, 명단에 "이메일 확인 필요"로 표시합니다. 나중에 참가자 상세에서 고칠 수 있습니다.</p>
                    <ul className={styles.chips} aria-label="형식이 맞지 않는 이메일 목록">
                      {preview.emailReview.slice(0, 5).map((item) => <li key={item.row}>파일 {item.row}행 · {item.name} <small>{item.email}</small></li>)}
                    </ul>
                    {preview.emailReview.length > 5 ? <p className={styles.moreNote}>외 {preview.emailReview.length - 5}건</p> : null}
                  </div>
                ) : null}

                {companySuggestions.length ? (
                  <fieldset className={styles.notice} data-tone="check">
                    <legend><h4>비슷한 소속 {companySuggestions.length}건이 있어요</h4></legend>
                    <p>오타일 수도, 실제로 다른 곳일 수도 있습니다. 같은 곳이면 체크해서 많이 쓰는 이름으로 맞추세요. 체크하지 않으면 파일 그대로 등록합니다.</p>
                    <ul className={styles.companyFixes}>
                      {companySuggestions.map((item) => (
                        <li key={item.from}>
                          <label>
                            <input type="checkbox" checked={Boolean(companyFixes[item.from])} disabled={importLocked}
                              onChange={(event) => setCompanyFixes((current) => ({ ...current, [item.from]: event.target.checked }))} />
                            <span><b>{item.from}</b> <small>{item.rows}명</small> → <b>{item.to}</b> <small>{item.toCount}명</small> 이름으로 맞추기</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  </fieldset>
                ) : null}

                {preview.errors.length ? (
                  <div className={styles.notice} data-tone="skip">
                    <h4>{preview.errors.length}행은 등록하지 않아요</h4>
                    <p>오류 행은 제외되며 원본 파일에서 수정 후 다시 가져올 수 있습니다.</p>
                    <ProductButton type="button" variant="ghost" aria-expanded={errorsOpen} aria-controls="participant-import-errors" onClick={() => setErrorsOpen((open) => !open)}>
                      {errorsOpen ? "오류 행 접기" : `오류 ${preview.errors.length}행 보기`}
                    </ProductButton>
                    {errorsOpen ? (
                      <ul id="participant-import-errors" className={styles.errorList} aria-label="가져오기 오류 목록">
                        {preview.errors.slice(0, 50).map((item) => (
                          <li key={item.row}><b>파일 {item.row}행</b><span>{item.reason}</span></li>
                        ))}
                        {preview.errors.length > 50 ? <li className={styles.errorMore}>외 {preview.errors.length - 50}행</li> : null}
                      </ul>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}

            {!missingField ? (
              <div className={styles.mapLine}>
                <p className={styles.mapTitle}>{fileKind === "txt" ? "한 줄의 순서대로 읽었어요" : "파일의 열을 이렇게 연결했어요"}</p>
                <div className={styles.mapChips}>
                  {FIELDS.map((field) => (
                    <label key={field.id} className={styles.mapChip} data-empty={map[field.id] === "" ? "true" : undefined}>
                      <span>{field.label}</span>
                      <select
                        aria-label={`${field.label}에 연결할 열`}
                        value={map[field.id]}
                        disabled={importLocked || fileKind === "txt"}
                        onChange={(event) => changeColumn(field.id, event.target.value)}
                      >
                        {field.required ? null : <option value="">사용 안 함</option>}
                        {headers.map((head, index) => (
                          <option key={index} value={String(index)}>{head || `열 ${index + 1}`}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                  {fileKind !== "txt" ? extraFields.map((field) => (
                    <label key={`extra-${field.id}`} className={styles.mapChip} data-empty={extraMap[field.id] ? undefined : "true"}>
                      <span>{field.label}</span>
                      <select
                        aria-label={`${field.label}에 연결할 열`}
                        value={extraMap[field.id] ?? ""}
                        disabled={importLocked}
                        onChange={(event) => changeExtraColumn(field.id, event.target.value)}
                      >
                        <option value="">사용 안 함</option>
                        {headers.map((head, index) => (
                          <option key={index} value={String(index)}>{head || `열 ${index + 1}`}</option>
                        ))}
                      </select>
                    </label>
                  )) : null}
                </div>
                {unmappedRequired.length ? (
                  <ConsoleFeedback kind="info">
                    필수 신청 항목 {unmappedRequired.map((field) => field.label).join("·")}은(는) 연결된 열이 없어 가져온 참가자의 답이 비어 있습니다. 파일에 같은 제목의 열을 넣거나, 가져온 뒤 참가자 정보에서 채울 수 있습니다.
                  </ConsoleFeedback>
                ) : null}
              </div>
            ) : null}
            {commitError ? <ConsoleFeedback kind="error">{commitError}</ConsoleFeedback> : null}
            {importUncertain ? <p role="status">결과를 확인할 때까지 원래 파일과 열 연결을 유지합니다.</p> : null}
          </ConsoleSection>
        )}
        </>
      ) : null}
      {onDismiss && dismissConfirm ? <ConsoleConfirm
        summary={importUncertain ? "명단이 이미 반영되었을 수 있습니다. 닫아도 서버 처리는 취소되지 않습니다. 처리 결과 확인에서 이어갈 수 있습니다." : "가져오기 위해 정리한 명단이 사라집니다. 닫을까요?"}
        confirmLabel="가져오기 닫기" cancelLabel="계속 작성하기"
        onConfirm={onDismiss} onCancel={() => setDismissConfirm(false)}
      /> : null}
      {onDismiss ? null : <>
        {actions}
        {!headers && committed === null ? <p><ProductLink className={`button button-ghost ${styles.outlinedAction}`} variant="ghost" href={listHref}>참가자 목록으로</ProductLink></p> : null}
      </>}
    </ImportFrame>
  );
}
