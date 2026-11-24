// One snapshot is shared by CSV and XLSX so the visible filter/sort and
// published application fields cannot disagree between formats.
export type ExportField = { id: string; label: string; type: string };
export type ExportPerson = {
  name: string; company: string; phone: string; email: string; group: string;
  status: string; inside: boolean; everIn: boolean; presenceUnknown?: boolean;
  answers: Record<string, string | boolean>;
};

// Do not silently discard a malformed or truncated published field. A real
// empty list stays valid; an absent list is not evidence of an empty list.
export function exportFieldsComplete(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  return value.every((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const field = item as Record<string, unknown>;
    if (typeof field.id !== "string" || !field.id.trim() || field.id !== field.id.trim() || seen.has(field.id) ||
        typeof field.label !== "string" || !field.label.trim() || typeof field.type !== "string" ||
        !["text", "email", "select", "checkbox"].includes(field.type)) return false;
    seen.add(field.id);
    return true;
  });
}

export function exportParticipantComplete(value: unknown, fields: ExportField[]): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const person = value as Record<string, unknown>;
  if (!["name", "phone", "company", "email", "group", "status"].every((key) => typeof person[key] === "string") ||
      !(person.name as string).trim()) return false;
  if (!person.answers || typeof person.answers !== "object" || Array.isArray(person.answers)) return false;
  const answers = person.answers as Record<string, unknown>;
  if (!Array.isArray(person.rosterExportAnswerKeys) || !person.rosterExportAnswerKeys.every((key) => typeof key === "string")) return false;
  const keys = new Set(person.rosterExportAnswerKeys as string[]);
  const fieldIds = new Set(fields.map((field) => field.id));
  if (keys.size !== person.rosterExportAnswerKeys.length || [...keys].some((key) => !fieldIds.has(key))) return false;
  return fields.every((field) => {
    const present = Object.hasOwn(answers, field.id);
    return present === keys.has(field.id) && (!present || typeof answers[field.id] === "string" || typeof answers[field.id] === "boolean");
  });
}

export function exportFields(value: unknown): ExportField[] {
  if (!Array.isArray(value)) return [];
  const builtIn = new Set(["name", "company", "phone", "email", "group"]);
  const seen = new Set<string>();
  return value.flatMap((item): ExportField[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const field = item as Record<string, unknown>;
    if (typeof field.id !== "string" || !field.id || builtIn.has(field.id) || seen.has(field.id) ||
        typeof field.label !== "string" || !field.label.trim() ||
        typeof field.type !== "string" || !["text", "email", "select", "checkbox"].includes(field.type)) return [];
    seen.add(field.id);
    return [{ id: field.id, label: field.label.trim(), type: field.type }];
  });
}

export function exportAnswers(value: unknown): Record<string, string | boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string | boolean> = Object.create(null);
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === "string" || typeof item === "boolean") result[key] = item;
  }
  return result;
}

export function participantExportRows(people: ExportPerson[], fields: ExportField[], statusLabel: (status: string) => string): string[][] {
  const headers = ["이름", "소속", "연락처", "이메일", "그룹", "등록 상태", "현장 상태"];
  const used = new Set(headers);
  const labels = fields.map((field) => {
    // Keep repeated customer labels distinguishable without using them as
    // object keys. The field ID is stable and stays attached to its value.
    const base = used.has(field.label) ? `${field.label} (${field.id})` : field.label;
    let label = base;
    let suffix = 2;
    while (used.has(label)) label = `${base} ${suffix++}`;
    used.add(label);
    return label;
  });
  return [
    [...headers, ...labels],
    ...people.map((person) => [
      person.name, person.company, person.phone, person.email, person.group,
      statusLabel(person.status), person.presenceUnknown ? "확인 필요" : person.inside ? "입장 중" : person.everIn ? "퇴장" : "미도착",
      ...fields.map((field) => {
        const value = person.answers[field.id];
        return typeof value === "boolean" ? value ? "예" : "아니요" : typeof value === "string" ? value : "";
      }),
    ]),
  ];
}

// Excel reads an all-digit CSV cell as a number and drops the leading 0 of a
// phone number. A hyphenated number stays text, needs no formula wrapper and
// still imports back (the import screen reads digits only).
export function csvPhone(value: string): string {
  const digits = value.trim();
  if (/^010\d{8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7)}`;
  if (/^01[16789]\d{7,8}$/.test(digits)) return `${digits.slice(0, 3)}-${digits.slice(3, digits.length - 4)}-${digits.slice(-4)}`;
  return value;
}

// 연락처 is the third column of participantExportRows; the header row is left alone.
const PHONE_COLUMN = 2;

export function participantCsv(rows: string[][]): string {
  return "\uFEFF" + rows.map((row, rowIndex) => row.map((raw, columnIndex) => {
    const cell = rowIndex > 0 && columnIndex === PHONE_COLUMN ? csvPhone(raw) : raw;
    // Excel and other spreadsheet importers can evaluate attacker-controlled
    // text as a formula. Prefix even after leading whitespace/control chars.
    const safe = /^[\s\uFEFF]*[=+\-@]/u.test(cell) || /^[\t\r\n]/u.test(cell) ? `'${cell}` : cell;
    return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  }).join(",")).join("\r\n");
}

// `{행사명}_참가자명단_{YYYYMMDD}.{ext}`: the event name keeps a downloaded file
// recognisable among several events. Characters a file system rejects are
// dropped, and a name that is empty afterwards falls back to a generic word.
export function participantExportFilename(eventName: string, extension: "csv" | "xlsx", now: Date = new Date()): string {
  const cleaned = eventName
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|[. ]+$/g, "")
    .slice(0, 60)
    .trim();
  const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
  return `${cleaned || "행사"}_참가자명단_${day}.${extension}`;
}
