const ATTENDEE_REQUEST_TIMEOUT_MS = 12000;

export async function postAttendeeRequest<T>(url: string, body: unknown) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), ATTENDEE_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null) as T | null;
    if (controller.signal.aborted) throw controller.signal.reason;
    return { res, data };
  } finally {
    window.clearTimeout(timeout);
  }
}
