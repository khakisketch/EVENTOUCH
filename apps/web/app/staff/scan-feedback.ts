// Sound and vibration for the field scan result. Both are optional extras:
// a missing AudioContext or vibrate API (iPhone has no vibration) never
// affects scanning. The AudioContext is created from a user gesture
// (starting the camera) so browsers allow it to play later.

export type ScanTone = "ok" | "info" | "bad";

let context: AudioContext | null = null;

export function primeScanFeedback(): void {
  try {
    if (typeof window === "undefined" || typeof window.AudioContext !== "function") return;
    context ??= new window.AudioContext();
    void context.resume();
  } catch {
    context = null;
  }
}

function beep(frequency: number, start: number, length: number, type: OscillatorType) {
  if (!context) return;
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.exponentialRampToValueAtTime(0.2, start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + length + 0.02);
}

export function playScanFeedback(tone: ScanTone, enabled: boolean): void {
  if (!enabled) return;
  try {
    navigator.vibrate?.(tone === "ok" ? 60 : tone === "info" ? [40, 60, 40] : [200, 80, 200]);
  } catch {
    // Vibration is best effort.
  }
  try {
    if (!context) return;
    const now = context.currentTime;
    if (tone === "ok") beep(880, now, 0.12, "sine");
    else if (tone === "info") { beep(660, now, 0.1, "sine"); beep(660, now + 0.16, 0.1, "sine"); }
    else beep(200, now, 0.4, "square");
  } catch {
    // Sound is best effort.
  }
}
