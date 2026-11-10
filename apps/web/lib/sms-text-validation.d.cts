export type SmsTextIssue = {
  kind: "supplementary" | "control" | "invalid_unicode";
  /** UTF-16 offset into the original, unmodified text. */
  index: number;
};

/** Detects documented unsupported cases, not the complete provider charset. */
export function findSmsTextIssue(value: unknown): SmsTextIssue | null;
