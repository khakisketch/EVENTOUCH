// Pure scan-budget decisions for CameraScan. Kept free of DOM and React so
// the contract test executes this logic at runtime instead of only
// pattern-matching the component source.

export const MAX_DECODE_WIDTH = 640;
export const MAX_DECODE_HEIGHT = 480;
export const DECODE_INTERVAL_MS = 200;

// True only when the browser actually offers a camera entry point. A truthy
// media object without a getUserMedia function (or no media at all) must
// fall back to the manual code path.
export function isCameraApiAvailable(media: unknown): media is MediaDevices {
  return (
    typeof media === "object" &&
    media !== null &&
    typeof (media as { getUserMedia?: unknown }).getUserMedia === "function"
  );
}

// Downscale a camera frame to the decode budget, preserving aspect ratio
// and never upscaling a frame that is already smaller. Degenerate inputs
// collapse to a 1x1 frame instead of producing NaN or zero sizes.
export function decodeFrameSize(
  videoWidth: number,
  videoHeight: number
): { width: number; height: number } {
  if (
    !Number.isFinite(videoWidth) ||
    videoWidth <= 0 ||
    !Number.isFinite(videoHeight) ||
    videoHeight <= 0
  ) {
    return { width: 1, height: 1 };
  }
  const scale = Math.min(
    1,
    MAX_DECODE_WIDTH / videoWidth,
    MAX_DECODE_HEIGHT / videoHeight
  );
  return {
    width: Math.max(1, Math.floor(videoWidth * scale)),
    height: Math.max(1, Math.floor(videoHeight * scale)),
  };
}

// Throttle gate for the decode loop: the preview runs at display rate but
// the decoder only runs when the full interval has elapsed since the last
// attempt.
export function shouldAttemptDecode(
  nowMs: number,
  lastDecodeMs: number,
  intervalMs: number = DECODE_INTERVAL_MS
): boolean {
  return nowMs - lastDecodeMs >= intervalMs;
}
