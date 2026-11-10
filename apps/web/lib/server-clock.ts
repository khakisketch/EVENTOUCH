// A response timestamp is an estimate, not authority for a write. The
// request duration bounds the unknown return transit; a clock adjustment or
// a suspended monotonic clock invalidates the estimate until the next read.
export type ServerClock = {
  serverTimeMs: number;
  receivedMonotonicMs: number;
  receivedWallMs: number;
  uncertaintyMs: number;
};

export type ServerClockReading = { now: number; uncertaintyMs: number };

export function captureServerClock(value: unknown, started: number, received: number, wall: number): ServerClock | null {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 946684800000 || value >= 4102444800000 ||
      !Number.isFinite(started) || !Number.isFinite(received) || !Number.isFinite(wall) || received < started || received - started > 8000) return null;
  const uncertaintyMs = (received - started) / 2 + 1;
  return { serverTimeMs: value + uncertaintyMs, receivedMonotonicMs: received, receivedWallMs: wall, uncertaintyMs };
}

export function readServerClock(clock: ServerClock | null): ServerClockReading | null {
  if (!clock) return null;
  const elapsed = performance.now() - clock.receivedMonotonicMs;
  const wallElapsed = Date.now() - clock.receivedWallMs;
  const discrepancy = Math.abs(wallElapsed - elapsed);
  if (!Number.isFinite(elapsed) || elapsed < 0 || !Number.isFinite(wallElapsed) || discrepancy > 5000) return null;
  return { now: clock.serverTimeMs + elapsed, uncertaintyMs: clock.uncertaintyMs + elapsed * 0.0001 + discrepancy };
}
