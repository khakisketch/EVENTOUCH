import { operatorFetch } from "../../lib/operator-context";
import { captureServerClock } from "../../lib/server-clock";

const STAFF_READ_TIMEOUT_MS = 8000;
const STAFF_READ_TIMEOUT_MESSAGE = "업무 정보 응답이 지연되고 있습니다. 다시 시도하세요.";

export function staffReadErrorMessage(error: unknown) {
  return error instanceof DOMException && error.name === "TimeoutError"
    ? STAFF_READ_TIMEOUT_MESSAGE
    : "연결하지 못했습니다. 다시 시도하세요.";
}

type StaffBootstrap = {
  serverTimeMs?: unknown;
  state?: {
    events?: Array<{ id?: unknown; name?: unknown; stage?: unknown; features?: unknown }>;
    workspaces?: Record<string, {
      desks?: unknown;
      booths?: unknown;
      assignments?: unknown;
      checks?: unknown;
      visits?: unknown;
      stampMode?: unknown;
      participants?: unknown;
      participantsAvailable?: unknown;
      checksAvailable?: unknown;
    }>;
  } | null;
};

export async function readStaffBootstrap(controller: AbortController, parentSignal?: AbortSignal) {
  const abort = () => controller.abort(new DOMException(STAFF_READ_TIMEOUT_MESSAGE, "TimeoutError"));
  if (parentSignal?.aborted) abort();
  else parentSignal?.addEventListener("abort", abort, { once: true });
  const timeout = window.setTimeout(abort, STAFF_READ_TIMEOUT_MS);
  try {
    const started = performance.now();
    const response = await operatorFetch("/api/bootstrap", { cache: "no-store", signal: controller.signal });
    const data = response.ok ? (await response.json().catch(() => null)) as StaffBootstrap | null : null;
    const clock = captureServerClock(data?.serverTimeMs, started, performance.now(), Date.now());
    if (!response.ok) void response.body?.cancel().catch(() => {});
    if (controller.signal.aborted) throw controller.signal.reason;
    return { status: response.status, state: data?.state, clock };
  } catch (error) {
    // The context adapter can reject after receiving headers. Close the body
    // even if it never reached the consumer.
    controller.abort();
    throw error;
  } finally {
    window.clearTimeout(timeout);
    parentSignal?.removeEventListener("abort", abort);
  }
}
