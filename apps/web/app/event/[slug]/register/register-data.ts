import { publicRecoveryContact } from "../../../../lib/public-recovery-contact";

export type PublishedField = {
  id: string;
  label: string;
  type: string;
  required: boolean;
  options: string[];
};

export type RegisterData = {
  name: string;
  stage: string;
  consentText: string;
  consentVersion: number;
  registrationOpen: boolean;
  publishedVersion: number;
  verificationRequired: boolean;
  approvalRequired: boolean;
  paymentPending: boolean;
  recoveryContact: string;
  fields: PublishedField[];
};

export const BUILT_IN_FIELDS: PublishedField[] = [
  { id: "name", label: "이름", type: "text", required: true, options: [] },
  { id: "phone", label: "연락처", type: "text", required: true, options: [] },
  { id: "company", label: "소속", type: "text", required: false, options: [] },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asField(value: unknown): PublishedField | null {
  const field = asRecord(value);
  if (!field || typeof field.id !== "string" || !field.id.trim() ||
      typeof field.label !== "string" || !field.label.trim() || typeof field.type !== "string" ||
      typeof field.required !== "boolean" || !Array.isArray(field.options) ||
      !field.options.every((option) => typeof option === "string")) return null;
  const type = field.type.trim().toLowerCase();
  if (!["text", "email", "select", "checkbox"].includes(type)) return null;
  if (type === "select" && field.required &&
      (!field.options.length || field.options.some((option) => !option.trim()))) return null;
  return {
    // The signup validator also trims field IDs before looking up answers.
    id: field.id.trim(),
    label: field.label,
    type,
    required: field.required,
    options: field.options as string[],
  };
}

// The server render and in-place conflict recovery consume exactly the same
// public projection. Never replace the live form with a partial response.
export function parseRegisterData(value: unknown): RegisterData | null {
  const source = asRecord(value);
  const event = asRecord(source?.event);
  const workspace = asRecord(source?.workspace);
  if (!event || !workspace || typeof event.name !== "string" || typeof event.stage !== "string" ||
      !["READY", "LIVE", "ENDED"].includes(event.stage.toUpperCase()) ||
      !Array.isArray(event.features) || !event.features.every((feature) => typeof feature === "string") ||
      !Array.isArray(workspace.publishedFields) ||
      !Number.isSafeInteger(workspace.publishedVersion) || Number(workspace.publishedVersion) < 0 ||
      !Number.isSafeInteger(workspace.formVersion) || workspace.formVersion !== workspace.publishedVersion ||
      typeof workspace.registrationOpen !== "boolean" || typeof workspace.approvalRequired !== "boolean" ||
      typeof workspace.verificationRequired !== "boolean" || typeof workspace.consentText !== "string" ||
      workspace.consentText.length > 3000 || !Number.isSafeInteger(workspace.consentVersion) ||
      Number(workspace.consentVersion) < 1 || typeof workspace.price !== "number" ||
      !Number.isFinite(workspace.price) || workspace.price < 0) return null;
  const fields: PublishedField[] = [];
  const ids = new Set<string>();
  for (const value of workspace.publishedFields) {
    const field = asRecord(value);
    if (!field || typeof field.id !== "string" || !field.id.trim() ||
        typeof field.label !== "string" || !field.label.trim() || typeof field.type !== "string" ||
        typeof field.required !== "boolean" || !Array.isArray(field.options) ||
        !field.options.every((option) => typeof option === "string")) return null;
    // These server-projected fields are rendered by the fixed built-in
    // controls. Their legacy type values never change signup validation.
    if (["name", "phone", "company"].includes(field.id.trim())) continue;
    const parsed = asField(field);
    if (!parsed || ids.has(parsed.id)) return null;
    ids.add(parsed.id);
    fields.push(parsed);
  }
  return {
    name: event.name,
    stage: event.stage.toUpperCase(),
    consentText: workspace.consentText,
    consentVersion: Number(workspace.consentVersion),
    registrationOpen: workspace.registrationOpen,
    publishedVersion: Number(workspace.publishedVersion),
    verificationRequired: workspace.verificationRequired,
    approvalRequired: workspace.approvalRequired,
    paymentPending: event.features.includes("payment") && workspace.price > 0,
    recoveryContact: publicRecoveryContact(workspace, event.features),
    fields,
  };
}
