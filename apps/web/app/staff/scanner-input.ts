// A USB or Bluetooth barcode scanner types like a keyboard and ends with Enter (or Tab).
// This turns that burst back into the ticket text without any input field being focused.
// The typed character is used when it is plain ASCII (with Caps Lock undone). With a Korean
// input method on, the browser reports Hangul or "Process" instead, so the character is
// rebuilt from the physical key (US layout).

const SYMBOL_KEYS: Record<string, [string, string]> = {
  Digit0: ["0", ")"], Digit1: ["1", "!"], Digit2: ["2", "@"], Digit3: ["3", "#"], Digit4: ["4", "$"],
  Digit5: ["5", "%"], Digit6: ["6", "^"], Digit7: ["7", "&"], Digit8: ["8", "*"], Digit9: ["9", "("],
  Minus: ["-", "_"], Equal: ["=", "+"], Semicolon: [";", ":"], Quote: ["'", "\""], Comma: [",", "<"],
  Period: [".", ">"], Slash: ["/", "?"], Backslash: ["\\", "|"], BracketLeft: ["[", "{"], BracketRight: ["]", "}"],
};

export function scanCharacter(key: string, code: string, shift: boolean, capsLock = false): string {
  if (/^[\x21-\x7e]$/u.test(key)) {
    if (!capsLock || !/^[a-z]$/iu.test(key)) return key;
    return key === key.toLowerCase() ? key.toUpperCase() : key.toLowerCase();
  }
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return shift ? letter[1] : letter[1].toLowerCase();
  const pad = /^Numpad([0-9])$/.exec(code);
  if (pad) return pad[1];
  const symbol = SYMBOL_KEYS[code];
  return symbol ? symbol[shift ? 1 : 0] : "";
}

// Only ticket-shaped text is treated as a scan, so ordinary typing (a name, a reason)
// never submits anything.
export function looksLikeTicket(value: string): boolean {
  return /^(ET:|T-).{4,}|[?&]ticket=/i.test(value);
}

export type ScanKey = {
  key: string; code: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; timeStamp: number;
  getModifierState?: (name: string) => boolean;
};

// Returns the finished ticket when this key ends one, otherwise null. A pause longer than
// `gapMs` starts over: scanners send a whole code in one burst.
export function createScanBuffer(gapMs = 500) {
  let text = "";
  let last = 0;
  return (key: ScanKey): string | null => {
    if (key.ctrlKey || key.metaKey || key.altKey) { text = ""; return null; }
    if (key.code === "ShiftLeft" || key.code === "ShiftRight" || key.code === "CapsLock") return null;
    if (text && key.timeStamp - last > gapMs) text = "";
    last = key.timeStamp;
    if (key.code === "Enter" || key.code === "NumpadEnter" || key.code === "Tab") {
      const done = text;
      text = "";
      return looksLikeTicket(done) ? done : null;
    }
    const character = scanCharacter(key.key, key.code, key.shiftKey, key.getModifierState?.("CapsLock") === true);
    text = character ? (text + character).slice(-2048) : "";
    return null;
  };
}
