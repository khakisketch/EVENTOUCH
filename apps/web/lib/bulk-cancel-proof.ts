// A response is decisive only when it proves the original reviewed targets
// and each of those participants was returned as cancelled.
function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function cancellationProofMatches(payload: unknown, response: unknown): boolean {
  const input = record(payload), result = record(response), proof = record(result?.cancellationReview);
  if (input?.status !== "CANCELLED" || !Array.isArray(input.ids) || !Array.isArray(input.expectedCancellations) ||
      proof?.status !== "CANCELLED" || !Array.isArray(proof.targets) || !Array.isArray(result?.participants) ||
      !input.ids.length || input.ids.length !== input.expectedCancellations.length ||
      input.ids.length !== proof.targets.length || input.ids.length !== result.participants.length ||
      new Set(input.ids).size !== input.ids.length) return false;
  const expectedTargets = input.expectedCancellations, actualTargets = proof.targets, participants = result.participants;
  return input.ids.every((id, index) => {
    const expected = record(expectedTargets[index]), actual = record(actualTargets[index]);
    if (typeof id !== "string" || !id || expected?.id !== id || actual?.id !== id ||
        typeof expected.status !== "string" || actual.status !== expected.status ||
        typeof expected.inside !== "boolean" || actual.inside !== expected.inside ||
        !Array.isArray(expected.paidPaymentIds) || !Array.isArray(actual.paidPaymentIds) ||
        !expected.paidPaymentIds.every((value) => typeof value === "string") ||
        !actual.paidPaymentIds.every((value) => typeof value === "string") ||
        JSON.stringify([...expected.paidPaymentIds].sort()) !== JSON.stringify([...actual.paidPaymentIds].sort())) return false;
    return participants.some((value) => { const person = record(value); return person?.id === id && person.status === "CANCELLED"; });
  });
}
