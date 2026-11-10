"use client";

// Pointers carry no request body or response. The server independently checks
// the current account, organization, and event before returning a receipt.
export type OperatorReceiptPointer = {
  userId: string; organizationId: string; eventId: string | null;
  commandId: string; command: string;
};
type SessionPointer = OperatorReceiptPointer & { _sharedV2?: true };
type SharedPointer = { pointer: OperatorReceiptPointer; legacy: boolean };
const KEY = "eventouch.receipts.operator";
const SESSION_SHARED_KEY = "eventouch.receipts.operator.shared-v2";
const SHARED_PREFIX = "eventouch.receipt.operator.v2.";
const EVENT = "eventouch:operator-receipts";
// A legacy sessionStorage snapshot can survive in a sleeping or duplicated
// tab. Short-lived tombstones stop it from reviving an acknowledged pointer.
// They contain only a command ID and timestamp. After 30 days an old tab can
// at worst show a stale item again; it must never infer success from absence.
const LEGACY_TOMBSTONE_MS = 30 * 24 * 60 * 60 * 1000;
const active = new Map<string, number>();
const activePointers = new Map<string, OperatorReceiptPointer>();
const managed = new Map<string, number>();
let sessionAvailable = true;
let sharingAvailable = true;
let sessionWritable = true;
let sharingWritable = true;
const idPattern = /^[A-Za-z0-9_-]{8,128}$/;
const commandPattern = /^[a-z][a-z0-9.-]{0,79}$/;

function isPointer(value: unknown): value is OperatorReceiptPointer {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return typeof item.userId === "string" && item.userId.length > 0 && item.userId.length <= 160 &&
    typeof item.organizationId === "string" && item.organizationId.length > 0 && item.organizationId.length <= 160 &&
    (item.eventId === null || (typeof item.eventId === "string" && item.eventId.length > 0 && item.eventId.length <= 160)) &&
    typeof item.commandId === "string" && idPattern.test(item.commandId) &&
    typeof item.command === "string" && commandPattern.test(item.command);
}
function pointerOf(item: OperatorReceiptPointer): OperatorReceiptPointer {
  const { userId, organizationId, eventId, commandId, command } = item;
  return { userId, organizationId, eventId, commandId, command };
}
function samePointer(a: OperatorReceiptPointer, b: OperatorReceiptPointer): boolean {
  return a.userId === b.userId && a.organizationId === b.organizationId && a.eventId === b.eventId &&
    a.commandId === b.commandId && a.command === b.command;
}
function pointerKey(item: OperatorReceiptPointer): string {
  return JSON.stringify([item.userId, item.organizationId, item.eventId, item.commandId, item.command]);
}
function announce(): void { window.dispatchEvent(new Event(EVENT)); }
function sessionItems(): SessionPointer[] {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    const sharedRaw = window.sessionStorage.getItem(SESSION_SHARED_KEY);
    const sharedParsed: unknown = sharedRaw ? JSON.parse(sharedRaw) : [];
    const sharedIds = new Set(Array.isArray(sharedParsed) ? sharedParsed.filter((id) => typeof id === "string" && idPattern.test(id)) : []);
    sessionAvailable = sessionWritable;
    return Array.isArray(parsed) ? parsed.filter(isPointer).map((item) => ({
      ...pointerOf(item), ...(sharedIds.has(item.commandId) ? { _sharedV2: true as const } : {}),
    })) : [];
  } catch { sessionAvailable = false; return []; }
}
function saveSession(items: SessionPointer[]): boolean {
  try {
    const sharedIds = items.filter((item) => item._sharedV2).map((item) => item.commandId);
    if (sharedIds.length) window.sessionStorage.setItem(SESSION_SHARED_KEY, JSON.stringify(sharedIds));
    else window.sessionStorage.removeItem(SESSION_SHARED_KEY);
    if (items.length) window.sessionStorage.setItem(KEY, JSON.stringify(items.map(pointerOf)));
    else window.sessionStorage.removeItem(KEY);
    sessionWritable = true;
    sessionAvailable = true;
    return true;
  } catch { sessionWritable = false; sessionAvailable = false; return false; }
}
function sharedKey(commandId: string): string { return SHARED_PREFIX + commandId; }
function legacyKey(commandId: string): string { return SHARED_PREFIX + "legacy." + commandId; }
function tombstoneKey(commandId: string): string { return SHARED_PREFIX + "done." + commandId; }
function sharedItems(): Map<string, SharedPointer | "done"> | null {
  try {
    const result = new Map<string, SharedPointer | "done">();
    const store = window.localStorage;
    // Snapshot the keys: removal while iterating Storage changes its indices.
    const keys: string[] = [];
    for (let index = 0; index < store.length; index++) {
      const key = store.key(index);
      if (key?.startsWith(SHARED_PREFIX)) keys.push(key);
    }
    const tombstones = new Set<string>();
    // A tombstone has its own key. A sleeping tab's simultaneous legacy
    // import cannot overwrite it, and it suppresses legacy records only.
    for (const key of keys.filter((name) => name.startsWith(SHARED_PREFIX + "done."))) {
      const commandId = key.slice((SHARED_PREFIX + "done.").length);
      if (!idPattern.test(commandId)) continue;
      let item: unknown;
      try { item = JSON.parse(store.getItem(key) || "null"); } catch { continue; }
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const value = item as Record<string, unknown>;
      if (value.done === true && typeof value.at === "number" && Number.isFinite(value.at)) {
        if (Date.now() - value.at > LEGACY_TOMBSTONE_MS) {
          // The legacy key is separate from a new retry, so pruning it cannot
          // erase a newer request using the same command ID.
          store.removeItem(legacyKey(commandId));
          store.removeItem(key);
        } else tombstones.add(commandId);
      }
    }
    for (const key of keys.filter((name) => name.startsWith(SHARED_PREFIX + "legacy."))) {
      const commandId = key.slice((SHARED_PREFIX + "legacy.").length);
      if (!idPattern.test(commandId) || tombstones.has(commandId)) continue;
      let item: unknown;
      try { item = JSON.parse(store.getItem(key) || "null"); } catch { continue; }
      if (item && typeof item === "object" && !Array.isArray(item) && isPointer((item as Record<string, unknown>).pointer)) {
        const pointer = (item as { pointer: OperatorReceiptPointer }).pointer;
        if (pointer.commandId === commandId) result.set(commandId, { pointer: pointerOf(pointer), legacy: true });
      }
    }
    for (const key of keys) {
      const commandId = key.slice(SHARED_PREFIX.length);
      if (!idPattern.test(commandId)) continue;
      let item: unknown;
      try { item = JSON.parse(store.getItem(key) || "null"); } catch { continue; }
      if (item && typeof item === "object" && !Array.isArray(item) && isPointer((item as Record<string, unknown>).pointer)) {
        const pointer = (item as { pointer: OperatorReceiptPointer }).pointer;
        if (pointer.commandId === commandId) result.set(commandId, { pointer: pointerOf(pointer), legacy: false });
      }
    }
    for (const commandId of tombstones) if (!result.has(commandId)) result.set(commandId, "done");
    sharingAvailable = sharingWritable;
    return result;
  } catch { sharingAvailable = false; return null; }
}
function saveShared(pointer: OperatorReceiptPointer, legacy: boolean): boolean {
  try {
    window.localStorage.setItem(legacy ? legacyKey(pointer.commandId) : sharedKey(pointer.commandId), JSON.stringify({ pointer: pointerOf(pointer) }));
    sharingWritable = true;
    sharingAvailable = true;
    return true;
  } catch { sharingWritable = false; sharingAvailable = false; return false; }
}
function removeShared(commandId: string, legacy: boolean): boolean {
  try {
    if (legacy || window.localStorage.getItem(legacyKey(commandId)) !== null) {
      window.localStorage.setItem(tombstoneKey(commandId), JSON.stringify({ done: true, at: Date.now() }));
      window.localStorage.removeItem(legacyKey(commandId));
    }
    window.localStorage.removeItem(sharedKey(commandId));
    sharingWritable = true;
    sharingAvailable = true;
    return true;
  } catch { sharingWritable = false; sharingAvailable = false; return false; }
}

export function operatorReceipts(): OperatorReceiptPointer[] {
  const session = sessionItems();
  const shared = sharedItems();
  const output = new Map<string, OperatorReceiptPointer>();
  if (shared) for (const record of shared.values()) if (record !== "done") output.set(pointerKey(record.pointer), record.pointer);
  let changed = false;
  const next: SessionPointer[] = [];
  for (const entry of session) {
    const stored = shared?.get(entry.commandId);
    if (shared && stored === "done") { changed = true; continue; }
    if (shared && entry._sharedV2 && !stored) { changed = true; continue; }
    if (stored && stored !== "done") {
      if (!samePointer(stored.pointer, entry)) {
        // A conflicting ID is never overwritten or silently discarded.
        sharingAvailable = false;
        next.push(entry);
        output.set(pointerKey(entry), pointerOf(entry));
        continue;
      }
      next.push({ ...pointerOf(entry), _sharedV2: true });
      if (!entry._sharedV2) changed = true;
      continue;
    }
    // Old or local-only session pointers migrate one by one. If sharing is
    // denied, keep the original session entry for same-tab recovery.
    const migrated = Boolean(shared && saveShared(entry, true));
    if (migrated) { next.push({ ...pointerOf(entry), _sharedV2: true }); changed = true; }
    else next.push(entry);
    output.set(pointerKey(entry), pointerOf(entry));
  }
  if (changed) saveSession(next);
  return [...output.values()];
}
export function operatorReceiptStorageAvailable(): boolean { return sessionAvailable || sharingAvailable; }
export function operatorReceiptSharingAvailable(): boolean { return sharingAvailable; }
export function subscribeOperatorReceipts(listener: () => void): () => void {
  const onStorage = (event: StorageEvent) => { if (event.key === null || event.key.startsWith(SHARED_PREFIX)) listener(); };
  const onFocus = () => listener();
  window.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  window.addEventListener("focus", onFocus);
  return () => { window.removeEventListener(EVENT, listener); window.removeEventListener("storage", onStorage); window.removeEventListener("focus", onFocus); };
}

// Do not acknowledge a confirmed result while the response-clone observer
// is still active: its eventual unknown result would restore the pointer.
export function waitForOperatorReceiptIdle(commandId: string): Promise<void> {
  if (!active.has(commandId)) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (active.has(commandId)) return;
      unsubscribe();
      resolve();
    };
    const unsubscribe = subscribeOperatorReceipts(check);
    check();
  });
}
export function visibleOperatorReceipts(): OperatorReceiptPointer[] {
  return operatorReceipts().filter((item) => !active.has(item.commandId) && !managed.has(item.commandId));
}
// A screen with an in-place recovery flow owns its pointer until it leaves.
// Ownership only hides the local presentation; another tab can see the ID.
export function manageOperatorReceipt(commandId: string): () => void {
  managed.set(commandId, (managed.get(commandId) ?? 0) + 1);
  announce();
  return () => {
    const count = (managed.get(commandId) ?? 1) - 1;
    if (count > 0) managed.set(commandId, count); else managed.delete(commandId);
    announce();
  };
}
// null means neither store is available or a pre-existing pointer belongs to
// another request; the caller must not erase that pointer on completion.
export function beginOperatorReceipt(pointer: OperatorReceiptPointer): boolean | null {
  if (!isPointer(pointer)) return null;
  const items = operatorReceipts();
  const existing = items.find((item) => item.commandId === pointer.commandId);
  if (existing && !samePointer(existing, pointer)) return null;
  const prior = Boolean(existing);
  active.set(pointer.commandId, (active.get(pointer.commandId) ?? 0) + 1);
  activePointers.set(pointer.commandId, pointerOf(pointer));
  if (!prior) {
    const stored = saveShared(pointer, false);
    const local = saveSession([...sessionItems().filter((item) => item.commandId !== pointer.commandId),
      { ...pointerOf(pointer), ...(stored ? { _sharedV2: true as const } : {}) }]);
    if (!stored && !local) {
      const count = (active.get(pointer.commandId) ?? 1) - 1;
      if (count) active.set(pointer.commandId, count); else { active.delete(pointer.commandId); activePointers.delete(pointer.commandId); }
      announce();
      return null;
    }
  }
  announce();
  return prior;
}
export function endOperatorReceipt(commandId: string, forget: boolean): void {
  const count = (active.get(commandId) ?? 1) - 1;
  const pointer = activePointers.get(commandId);
  if (count > 0) active.set(commandId, count); else { active.delete(commandId); activePointers.delete(commandId); }
  if (forget) forgetOperatorReceipt(commandId, pointer);
  else {
    // Another tab may have explicitly removed this entry while our request
    // was still in flight. An unknown result must become visible again.
    if (pointer && !operatorReceipts().some((item) => item.commandId === commandId)) {
      const stored = saveShared(pointer, false);
      saveSession([...sessionItems().filter((item) => item.commandId !== commandId),
        { ...pointer, ...(stored ? { _sharedV2: true as const } : {}) }]);
    }
    announce();
  }
}
export function forgetOperatorReceipt(commandId: string, expected?: OperatorReceiptPointer): boolean {
  const session = sessionItems();
  const shared = sharedItems();
  const record = shared?.get(commandId);
  const owner = expected ?? activePointers.get(commandId) ?? session.find((item) => item.commandId === commandId);
  if (record && record !== "done" && (!owner || !samePointer(record.pointer, owner))) return false;
  if (expected && (expected.commandId !== commandId || !isPointer(expected))) return false;
  if (record && record !== "done" && !removeShared(commandId, record.legacy)) return false;
  if (!record && shared && session.some((item) => item.commandId === commandId && !item._sharedV2) && !removeShared(commandId, true)) return false;
  if (!saveSession(session.filter((item) => item.commandId !== commandId || (owner && !samePointer(item, owner))))) return false;
  announce();
  return true;
}
export function clearOperatorReceipts(): void {
  // Logout must not erase another tab's (or another organization's) unknown
  // result. The next authenticated account sees only its own scoped items.
  active.clear();
  activePointers.clear();
  managed.clear();
  announce();
}
