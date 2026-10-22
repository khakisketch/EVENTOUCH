"use client";

import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, type ReactNode } from "react";

type DraftGuard = {
  register: (id: string, reason: string) => () => void;
  confirmLeave: () => boolean;
};

const GuardContext = createContext<DraftGuard | null>(null);
const DEFAULT_REASON = "저장하지 않은 변경이 있습니다. 이 페이지를 떠나면 입력한 내용이 사라질 수 있습니다.";
const allowLeave = () => true;
export const UNCONFIRMED_WRITE_CLOSE_MESSAGE = "요청 결과를 아직 확인하지 못했습니다. 이미 저장되었을 수 있으며, 닫아도 서버의 처리는 취소되지 않습니다. 결과를 확인하지 않고 닫을까요?";

/**
 * A warning, not an autosave or offline session. The workspace owns dirty and
 * pending intent; this provider owns one exit check across the console.
 *
 * Only normal same-tab route links are intercepted. Downloads, new tabs,
 * filters and section anchors never discard this workspace and stay native.
 * Browser Back/Forward is deliberately not trapped or rewritten: the platform
 * does not offer a portable cancellable App Router traversal. Do not claim
 * draft restoration across those traversals or after a tab has closed.
 */
export function ConsoleDraftGuardProvider({ children }: { children: ReactNode }) {
  const drafts = useRef(new Map<string, string>());

  const beforeUnload = useCallback((event: BeforeUnloadEvent) => {
    if (!drafts.current.size) return;
    event.preventDefault();
    event.returnValue = "";
  }, []);

  const register = useCallback((id: string, reason: string) => {
    const wasEmpty = drafts.current.size === 0;
    drafts.current.set(id, reason.trim() || DEFAULT_REASON);
    // Install only while dirty so clean console pages retain native bfcache.
    if (wasEmpty) window.addEventListener("beforeunload", beforeUnload);
    return () => {
      drafts.current.delete(id);
      if (!drafts.current.size) window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [beforeUnload]);

  const confirmLeave = useCallback(() => {
    if (!drafts.current.size) return true;
    const reasons = [...new Set(drafts.current.values())];
    return window.confirm(`${reasons.join("\n\n")}\n\n이동할까요?`);
  }, []);

  useEffect(() => {
    const onLink = (event: MouseEvent) => {
      if (!drafts.current.size || event.defaultPrevented || event.button !== 0 ||
        event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target instanceof Element ? event.target : null;
      const link = target?.closest<HTMLAnchorElement>("a[href]");
      if (!link || link.hasAttribute("download") || (link.target && link.target !== "_self")) return;
      let url: URL;
      try { url = new URL(link.href, window.location.href); } catch { return; }
      if (url.origin !== window.location.origin || !["http:", "https:"].includes(url.protocol) ||
        url.pathname === window.location.pathname || url.pathname.startsWith("/api/")) return;
      if (!confirmLeave()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    document.addEventListener("click", onLink, true);
    return () => {
      document.removeEventListener("click", onLink, true);
      window.removeEventListener("beforeunload", beforeUnload);
      drafts.current.clear();
    };
  }, [beforeUnload, confirmLeave]);

  const value = useMemo(() => ({ register, confirmLeave }), [register, confirmLeave]);
  return <GuardContext.Provider value={value}>{children}</GuardContext.Provider>;
}

export function useConsoleDraftGuard(dirty: boolean, reason = DEFAULT_REASON): void {
  const guard = useContext(GuardContext);
  const id = useId();
  useEffect(() => {
    if (!dirty || !guard) return;
    return guard.register(id, reason);
  }, [dirty, guard, id, reason]);
}

/** For explicit exits such as logout; successful save navigation stays owned by its workspace. */
export function useConsoleLeaveConfirmation(): () => boolean {
  return useContext(GuardContext)?.confirmLeave ?? allowLeave;
}
