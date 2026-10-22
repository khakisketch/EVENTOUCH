export type VerificationMode = "solapi" | "mock" | "none" | "unknown";

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

// Public attendee screens need to distinguish a real SMS route from the
// development mock before asking someone to enter a code that will not arrive.
export async function loadVerificationMode(): Promise<VerificationMode> {
  try {
    const response = await fetch(`${apiBase()}/api/health`, { cache: "no-store" });
    if (!response.ok) return "unknown";
    const data = (await response.json()) as { verification?: unknown };
    if (data.verification === "solapi" || data.verification === "mock" || data.verification === "none") {
      return data.verification;
    }
  } catch {
    // The flow can still surface the verification endpoint's own response.
  }
  return "unknown";
}
