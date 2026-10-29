// Error values can be arbitrary client throws, not just sanitized server
// Errors. Inspect only for a recovery choice; never return a raw message.
function errorString(error: unknown, key: "name" | "message"): string {
  try {
    if (!error || (typeof error !== "object" && typeof error !== "function")) return "";
    const value = (error as Record<string, unknown>)[key];
    return typeof value === "string" ? value : "";
  } catch {
    // A thrown Proxy/getter must not break the last-resort boundary too.
    return "";
  }
}

export function isChunkLoadingError(error: unknown): boolean {
  const name = errorString(error, "name");
  const message = typeof error === "string" ? error : errorString(error, "message");
  return name === "ChunkLoadError" ||
    /(?:failed to load chunk|loading chunk .+ failed|failed to fetch dynamically imported module|importing a module script failed)/i.test(message);
}
