// Minimal tab-local pointers for a status-only server lookup. Never store the
// submitted body, ticket, name, phone number, or server response here.
export type GuestReceiptPointer = { eventId: string; commandId: string; command: string };
const prefix = "eventouch.receipts.guest.";
const idPattern = /^[A-Za-z0-9_-]{8,128}$/;
const commandPattern = /^[a-z][a-z0-9.-]{0,79}$/;

function valid(value: unknown): value is GuestReceiptPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.eventId === "string" && item.eventId.length > 0 && item.eventId.length <= 160 &&
    typeof item.commandId === "string" && idPattern.test(item.commandId) &&
    typeof item.command === "string" && commandPattern.test(item.command);
}

export function readGuestReceipts(slug: string): { items: GuestReceiptPointer[]; available: boolean } {
  try {
    const raw = window.sessionStorage.getItem(prefix + slug);
    if (!raw) return { items: [], available: true };
    const parsed: unknown = JSON.parse(raw);
    return { items: Array.isArray(parsed) ? parsed.filter(valid).map(({ eventId, commandId, command }) => ({ eventId, commandId, command })) : [], available: true };
  } catch {
    return { items: [], available: false };
  }
}

export function writeGuestReceipts(slug: string, items: GuestReceiptPointer[]): boolean {
  try {
    if (items.length) window.sessionStorage.setItem(prefix + slug, JSON.stringify(items));
    else window.sessionStorage.removeItem(prefix + slug);
    return true;
  } catch { return false; }
}
