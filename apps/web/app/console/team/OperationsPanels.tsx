"use client";

import { useEffect, useState } from "react";
import ConsoleSection from "../console-ui/ConsoleSection";
import styles from "./team.module.css";

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

export default function OperationsPanels() {
  const [health, setHealth] = useState<Health | null>(null);
  const [attempts, setAttempts] = useState<Attempt[] | null>(null);
  const [audit, setAudit] = useState<AuditEntry[] | null>(null);

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
        if (securityRes.status === 403 || securityRes.status === 401) {
          if (!cancelled) setAttempts([]);
          return;
        }
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
          setAudit(entries.slice(0, 20));
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

  return (
    <>
      <ConsoleSection headingId="operations-integrations" title="연동 상태" className={styles.teamSection}>
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
      <ConsoleSection headingId="operations-activity" title="최근 활동" className={styles.teamSection}>
        {!audit ? (
          <p className="notice" role="status">활동 기록을 불러오고 있습니다.</p>
        ) : !audit.length ? (
          <p className="notice" role="status">표시할 활동 기록이 없습니다.</p>
        ) : (
          <ul className="participant-list" aria-label="최근 활동 목록">
            {audit.map((entry, index) => (
              <li className="participant-row" key={entry.id || `${entry.eventId}-${index}`}>
                <span className="participant-summary">
                  {entry.eventName} · {entry.type}
                  {entry.detail ? ` · ${entry.detail}` : ""}
                  <br />
                  <small>{entry.actor} · {formatTime(entry.at)}</small>
                </span>
              </li>
            ))}
          </ul>
        )}
      </ConsoleSection>
      {attempts && attempts.length ? (
        <ConsoleSection headingId="operations-security" title="로그인 보호 상태" className={styles.teamSection}>
          <p className="landing-note">실패 횟수만 집계합니다. 성공한 로그인은 기록하지 않으므로 접속 로그로 오해하지 마세요.</p>
          <ul className="participant-list" aria-label="로그인 실패 집계">
            {attempts.map((attempt) => (
              <li className="participant-row" key={`${attempt.scope}:${attempt.key}`}>
                <span className="participant-summary">
                  {attempt.scope === "account" ? "계정" : "접속 주소"} · {attempt.key} · {attempt.failures}회 실패
                  <br />
                  <small>최근 {formatTime(attempt.lastFailureAt)}</small>
                </span>
              </li>
            ))}
          </ul>
        </ConsoleSection>
      ) : null}
    </>
  );
}
