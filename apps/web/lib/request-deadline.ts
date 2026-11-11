const REQUEST_TIMEOUT_MS = 12000;

// Race the complete operation, not just headers. Abort alone is insufficient
// when a body reader (or a browser/network adapter) does not reject promptly.
export async function withRequestDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  controller = new AbortController(),
  timeoutMs = REQUEST_TIMEOUT_MS
): Promise<T> {
  if (controller.signal.aborted) throw controller.signal.reason;
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => reject(controller.signal.reason);
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await Promise.race([operation(controller.signal), aborted]);
  } finally {
    window.clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectAbort!);
  }
}

// Deliver headers immediately: receipt observation must not hold the caller
// hostage. The returned stream and every clone still share the same deadline.
export async function fetchWithDeadline(
  input: string,
  init?: RequestInit,
  onBodyFailure?: () => void
): Promise<Response> {
  if (init?.signal?.aborted) throw init.signal.reason;
  const controller = new AbortController();
  const abort = () => controller.abort(init?.signal?.reason);
  let delivered = false;
  let bodyFailed = false;
  const failBody = () => {
    if (!delivered || bodyFailed) return;
    bodyFailed = true;
    onBodyFailure?.();
  };
  let rejectAbort: () => void;
  const aborted = new Promise<never>((_, reject) => {
    rejectAbort = () => { failBody(); reject(controller.signal.reason); };
    controller.signal.addEventListener("abort", rejectAbort, { once: true });
  });
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const dispose = () => {
    window.clearTimeout(timeout);
    init?.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", rejectAbort!);
  };
  init?.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await Promise.race([fetch(input, { ...init, signal: controller.signal }), aborted]);
    if (!response.body) { dispose(); return response; }
    const body = new TransformStream<Uint8Array, Uint8Array>();
    void response.body.pipeTo(body.writable, { signal: controller.signal })
      .catch(failBody)
      .finally(dispose);
    const bounded = new Response(body.readable, { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperties(bounded, {
      url: { value: response.url },
      redirected: { value: response.redirected },
      type: { value: response.type },
    });
    delivered = true;
    return bounded;
  } catch (error) {
    dispose();
    throw error;
  }
}
