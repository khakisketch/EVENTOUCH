"use client";

import { useEffect, useRef, useState } from "react";
import ConsoleSection from "../console-ui/ConsoleSection";
import consoleUiStyles from "../console-ui/console-ui.module.css";
import teamStyles from "./team.module.css";
import { getActivityLabel, isKnownActivityType } from "./activity-labels";

// Operations visibility for the team screen: integration status, recent
// activity, and login protection. All three are read-only; the server owns
// every permission decision, so each panel degrades to what the caller may
// see instead of failing the screen.

type Health = {
  messaging: boolean;
  messagingProvider: string | null;
  verification: string;
  outboxPending: number | null;
};

type Attempt = {
  scope: string;
  key: string;
  failures: number;
  firstFailureAt: string;
  lastFailureAt: string;
};

type AuditEntry = {
  id: string;
  eventId: string;
  eventName: string;
  type: string;
  actor: string;
  detail: string;
  at: string;
};

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function formatTime(value: string): string {
  if (!value) return "시각 확인 중";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "시각 확인 중";
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function verificationLabel(mode: string): string {
  switch (mode) {
    case "solapi":
      return "실발송 (Solapi)";
    case "mock":
      return "모의 발송 (코드 실전송 없음)";
    default:
      return "미설정 (인증 요청 거부)";
  }
}

// Raw command keys are operator-hostile on their own: every known audit
// type resolves through the single shared activity-labels map (the full
// server command universe, read-only), so a new server command can only
// change one place. Unknown keys keep the raw key at the data level so no
// activity ever goes blank; rows render "기록된 작업" with the raw key
// inside an on-demand details block instead.
function activityActionLabel(type: string): string {
  const mapped = getActivityLabel(type);
  if (mapped !== null) return mapped;
  if (type.startsWith("participant.")) return "참가자 변경";
  return type;
}

const ACTIVITY_INITIAL_ROWS = 8;
const ACTIVITY_MORE_STEP = 8;
const ACTIVITY_MAX_ROWS = 20;

export default function OperationsPanels() {
  const [health, setHealth] = useState<Health | null>(null);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);
  const [visibleActivityCount, setVisibleActivityCount] = useState(ACTIVITY_INITIAL_ROWS);
  const activityListRef = useRef<HTMLUListElement | null>(null);
  // First newly revealed row to focus after 더 보기: rows render before the
  // button, so without this the focused button disappears (final page) or
  // focus stays behind the new rows.
  const pendingActivityFocusRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const healthRes = await fetch("/api/health", { cache: "no-store" });
        const healthData = (await healthRes.json().catch(() => null)) as {
          messaging?: unknown;
          messagingProvider?: unknown;
          verification?: unknown;
          outboxPending?: unknown;
        } | null;
        if (!cancelled && healthData) {
          setHealth({
            messaging: healthData.messaging === true,
            messagingProvider: typeof healthData.messagingProvider === "string" ? healthData.messagingProvider : null,
            verification: typeof healthData.verification === "string" ? healthData.verification : "off",
            outboxPending: typeof healthData.outboxPending === "number" ? healthData.outboxPending : null,
          });
        }
      } catch {
        // Health stays empty; the panel says so instead of breaking.
      }
      try {
        const securityRes = await fetch("/api/auth/security", { cache: "no-store" });
        // Denial (normal MANAGER) ends only this branch: the security panel
        // stays hidden while health/activity keep loading independently.
        if (securityRes.status === 403 || securityRes.status === 401) {
          if (!cancelled) setAttempts([]);
        } else {
          const securityData = (await securityRes.json().catch(() => null)) as {
            attempts?: unknown;
          } | null;
          if (!cancelled && securityData && Array.isArray(securityData.attempts)) {
            setAttempts(
              securityData.attempts.flatMap((item) => {
                if (typeof item !== "object" || item === null) return [];
                const attempt = item as Record<string, unknown>;
                return [{
                  scope: text(attempt.scope),
                  key: text(attempt.key),
                  failures: typeof attempt.failures === "number" ? attempt.failures : 0,
                  firstFailureAt: text(attempt.firstFailureAt),
                  lastFailureAt: text(attempt.lastFailureAt),
                }];
              }).slice(0, 10)
            );
          } else if (!cancelled) {
            setAttempts([]);
          }
        }
      } catch {
        if (!cancelled) setAttempts([]);
      }
      try {
        const bootRes = await fetch("/api/bootstrap", { cache: "no-store" });
        if (bootRes.status === 401) {
          if (!cancelled) setAudit([]);
          return;
        }
        const bootData = (await bootRes.json().catch(() => null)) as {
          state?: {
            events?: unknown;
            workspaces?: unknown;
            accounts?: unknown;
          } | null;
        } | null;
        const bootstrap = bootData?.state;
        if (!cancelled && bootstrap) {
          const names = new Map<string, string>();
          if (Array.isArray(bootstrap.accounts)) {
            for (const item of bootstrap.accounts) {
              if (typeof item === "object" && item !== null) {
                const account = item as Record<string, unknown>;
                if (typeof account.id === "string") names.set(account.id, text(account.name) || text(account.email));
              }
            }
          }
          const eventNames = new Map<string, string>();
          if (Array.isArray(bootstrap.events)) {
            for (const item of bootstrap.events) {
              if (typeof item === "object" && item !== null) {
                const event = item as Record<string, unknown>;
                if (typeof event.id === "string") eventNames.set(event.id, text(event.name) || event.id);
              }
            }
          }
          const entries: AuditEntry[] = [];
          const workspaces = (bootstrap.workspaces ?? {}) as Record<string, { audit?: unknown }>;
          for (const [eventId, workspace] of Object.entries(workspaces)) {
            if (!Array.isArray(workspace?.audit)) continue;
            for (const item of workspace.audit) {
              if (typeof item !== "object" || item === null) continue;
              const entry = item as Record<string, unknown>;
              entries.push({
                id: text(entry.id),
                eventId,
                eventName: eventNames.get(eventId) ?? eventId,
                type: text(entry.type),
                actor: names.get(text(entry.actor)) ?? "확인 필요",
                detail: text(entry.detail),
                at: text(entry.at),
              });
            }
          }
          entries.sort((a, b) => (a.at < b.at ? 1 : -1));
          if (!cancelled) setAudit(entries.slice(0, ACTIVITY_MAX_ROWS));
        } else if (!cancelled) {
          // Explicit empty, never perpetual loading: the panel renders its
          // unavailable/empty copy instead of waiting forever.
          setAudit([]);
        }
      } catch {
        if (!cancelled) setAudit([]);
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Keyboard reveal: rows insert before the focused 더 보기, so after each
  // reveal move focus to the first newly revealed row. Runs on the final
  // reveal too, where the button unmounts and focus would otherwise drop.
  useEffect(() => {
    const target = pendingActivityFocusRef.current;
    if (target === null) return;
    pendingActivityFocusRef.current = null;
    const row = activityListRef.current?.children[target] as HTMLElement | undefined;
    row?.focus?.();
  }, [visibleActivityCount]);

  return (
    <>
      <ConsoleSection headingId="operations-integrations" title="연동 상태" surface="plain" width="full">
        {!health ? (
          <p className="notice" role="status">연동 상태를 불러오고 있습니다.</p>
        ) : (
          <dl className="client-meta">
            <div>
              <dt>문자·알림톡</dt>
              <dd>{health.messaging ? `연결됨${health.messagingProvider ? ` (${health.messagingProvider})` : ""}` : "미연동 (연결 필요 상태로 기록됩니다)"}</dd>
            </div>
            <div>
              <dt>참가자 인증번호</dt>
              <dd>{verificationLabel(health.verification)}</dd>
            </div>
            {health.outboxPending !== null ? (
              <div>
                <dt>발송 대기</dt>
                <dd>{health.outboxPending}건</dd>
              </div>
            ) : null}
          </dl>
        )}
        <p className="landing-note">자격증명·발신번호·승인 템플릿은 서버 환경에서 관리하며 화면에 입력하지 않습니다.</p>
      </ConsoleSection>
      <ConsoleSection headingId="operations-activity" title="최근 활동" surface="plain" width="full">
        {!audit ? (
          <p className="notice" role="status">활동 기록을 불러오고 있습니다.</p>
        ) : !audit.length ? (
          <p className="notice" role="status">표시할 활동 기록이 없습니다.</p>
        ) : (
          <>
          <ul ref={activityListRef} className={consoleUiStyles.collection} aria-label="최근 활동 목록">
            {audit.slice(0, visibleActivityCount).map((entry, index) => {
              // Known audit types read as their Korean action; unmapped
              // participant.* keys keep the grouped fallback; anything else
              // reads as "기록된 작업". The raw technical key is one
              // disclosure away whenever the key is unmapped — including
              // unmapped participant.* keys — so evidence is never lost to
              // a grouped reading.
              const known = isKnownActivityType(entry.type);
              const unmapped = getActivityLabel(entry.type) === null;
              return (
              <li className={consoleUiStyles.recordRow} key={entry.id || `${entry.eventId}-${index}`} tabIndex={-1} data-activity-row={index}>
                <div className={consoleUiStyles.recordMain}>
                  {known ? (
                    <span>
                      {entry.eventName} · {activityActionLabel(entry.type)}
                      {entry.detail ? ` · ${entry.detail}` : ""}
                    </span>
                  ) : (
                    <span>
                      {entry.eventName} · 기록된 작업
                      {entry.detail ? ` · ${entry.detail}` : ""}
                    </span>
                  )}
                  <p className={consoleUiStyles.recordMeta}>{entry.actor} · {formatTime(entry.at)}</p>
                  {unmapped ? (
                    <details className={teamStyles.activityTech}>
                      <summary>기술 정보</summary>
                      <p className={consoleUiStyles.recordMeta}>내부 작업 키 <code>{entry.type}</code></p>
                    </details>
                  ) : null}
                </div>
              </li>
              );
            })}
          </ul>
          {audit.length > visibleActivityCount ? (
            <p>
              <button
                type="button"
                id="team-activity-more"
                className="button button-secondary"
                onClick={() => {
                  pendingActivityFocusRef.current = visibleActivityCount;
                  setVisibleActivityCount((count) => Math.min(count + ACTIVITY_MORE_STEP, ACTIVITY_MAX_ROWS, audit.length));
                }}
              >
                더 보기 ({audit.length - visibleActivityCount})
              </button>
            </p>
          ) : null}
          </>
        )}
      </ConsoleSection>
      {attempts && attempts.length ? (
        <ConsoleSection headingId="operations-security" title="로그인 보호 상태" surface="plain" width="full">
          <p className="landing-note">실패 횟수만 집계합니다. 성공한 로그인은 기록하지 않으므로 접속 로그로 오해하지 마세요.</p>
          <ul className={consoleUiStyles.collection} aria-label="로그인 실패 집계">
            {attempts.map((attempt) => (
              <li className={consoleUiStyles.recordRow} key={`${attempt.scope}:${attempt.key}`}>
                <div className={consoleUiStyles.recordMain}>
                  <span>{attempt.scope === "account" ? "계정" : "접속 주소"} · {attempt.key} · {attempt.failures}회 실패</span>
                  <p className={consoleUiStyles.recordMeta}>최근 {formatTime(attempt.lastFailureAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        </ConsoleSection>
      ) : null}
    </>
  );
}
