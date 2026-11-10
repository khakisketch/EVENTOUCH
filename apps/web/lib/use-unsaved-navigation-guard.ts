"use client";
import { useEffect } from "react";

// Browser refresh/close uses the browser's own prompt. App links use a
// cancellable confirmation. Back/forward cannot be portably cancelled in the
// App Router, so this hook never invents history entries or promises recovery.
export function useUnsavedNavigationGuard(dirty: boolean, message: string): void {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    const onLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      let url: URL;
      try { url = new URL(link.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol) ||
          url.pathname === window.location.pathname || url.pathname.startsWith("/api/")) return;
      if (!window.confirm(`${message}\n\n이동할까요?`)) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", onLink, true);
    return () => { window.removeEventListener("beforeunload", beforeUnload); document.removeEventListener("click", onLink, true); };
  }, [dirty, message]);
}
