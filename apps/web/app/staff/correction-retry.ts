// Pure identity rules for the staff check-correction retry. Kept free of
// DOM and React so the contract test executes this logic at runtime instead
// of only pattern-matching the component source.

export type CorrectionPending = {
  key: string;
  commandId: string;
  eventId: string;
  assignmentId: string;
  checkId: string;
  reason: string;
};

export function randomCorrectionId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return `web-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// The full assignment context is part of the key: the same command id must
// never cross into a different event, assignment, record, or payload. A
// desk switch therefore mints a different key (and id) instead of replaying
// an unrelated correction.
export function correctionAttemptKey(
  eventId: string,
  assignmentId: string,
  checkId: string,
  reason: string
): string {
  return JSON.stringify(["check.correct", eventId, assignmentId, checkId, reason]);
}

// Mint (or retain) one pending identity for a correction attempt. A stored
// entry with the same key keeps its command id; any change of context or
// payload mints a fresh one.
export function buildCorrectionPending(input: {
  eventId: string;
  assignmentId: string;
  checkId: string;
  reason: string;
  stored: CorrectionPending | null;
}): CorrectionPending {
  const { eventId, assignmentId, checkId, reason, stored } = input;
  const key = correctionAttemptKey(eventId, assignmentId, checkId, reason);
  const commandId =
    stored && stored.key === key ? stored.commandId : randomCorrectionId();
  return { key, commandId, eventId, assignmentId, checkId, reason };
}

// While a correction is in flight or its outcome is unknown, the desk, task,
// kiosk, and scan controls lock so the pending identity cannot be silently
// swapped underneath the retry. The retry control itself stays enabled.
export function isCorrectionLocked(
  correcting: boolean,
  correctUnknown: boolean
): boolean {
  return correcting || correctUnknown;
}
