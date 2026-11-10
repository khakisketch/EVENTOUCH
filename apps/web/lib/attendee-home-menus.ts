export const HOME_CONFIGURABLE_KEYS = ["notice", "lucky", "roulette", "vote", "stamp"] as const;
export type ConfigurableHomeMenu = typeof HOME_CONFIGURABLE_KEYS[number];
export type HomeMenus = { order: ConfigurableHomeMenu[]; hidden: ConfigurableHomeMenu[]; programs: string[] };
export type HomeProgram = { id: string; title: string };
const keys = new Set<string>(HOME_CONFIGURABLE_KEYS);
const idPattern = /^[A-Za-z0-9_-]{1,120}$/;

export function normalizeHomeMenus(value: unknown): HomeMenus {
  const item = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const selectKeys = (candidate: unknown): ConfigurableHomeMenu[] =>
    [...new Set((Array.isArray(candidate) ? candidate : []).filter((key): key is ConfigurableHomeMenu => typeof key === "string" && keys.has(key)))];
  const order = selectKeys(item.order);
  for (const key of HOME_CONFIGURABLE_KEYS) if (!order.includes(key)) order.push(key);
  const hidden = selectKeys(item.hidden);
  const programs = [...new Set((Array.isArray(item.programs) ? item.programs : []).filter((id): id is string => typeof id === "string" && idPattern.test(id)))].slice(0, 100);
  return { order, hidden, programs };
}
