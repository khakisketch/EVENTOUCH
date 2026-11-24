"use client";

// 자동 안내 (2026-11-24 결정): 참가 확정 안내와 행사 전 리마인드를 규칙으로 켜 둔다.
// 기본은 꺼짐이다. 이 화면은 규칙만 저장한다. 실제 발송은 서버의 예약 자동 실행(배포 옵트인)이
// 같은 가드로 맡고, 켜기 전에 이미 확정된 사람에게는 보내지 않는다.
import { useState, type ReactNode } from "react";
import ProductButton from "../../../../ui/ProductButton";
import ConsoleSection from "../../../console-ui/ConsoleSection";
import ConsoleConfirm from "../../../console-ui/ConsoleConfirm";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import StatusPill from "../../../console-ui/StatusPill";
import { consoleFetch } from "../../../../../lib/console-api";
import styles from "./AutoNotifyPanel.module.css";

export type AutoNotifyRule = { enabled: boolean; body: string; days: number; time: string; issue: string };
export type AutoNotifyRules = { confirmed: AutoNotifyRule | null; reminder: AutoNotifyRule | null };
type Kind = "confirmed" | "reminder";

const DEFAULTS: Record<Kind, { title: string; summary: string; body: string }> = {
  confirmed: {
    title: "참가 확정 안내",
    summary: "참가가 확정된 사람에게 한 번 보냅니다. 켠 뒤에 확정된 사람부터 보내고, 이미 확정된 사람에게는 보내지 않습니다.",
    body: "[{{행사명}}] {{이름}}님, 참가가 확정되었습니다.\n행사일: {{행사일}}",
  },
  reminder: {
    title: "행사 리마인드",
    summary: "정한 날과 시각에 참가 확정자 전원에게 한 번 보냅니다. 행사 날짜가 바뀌면 바뀐 날짜에 맞춰 보냅니다.",
    body: "[{{행사명}}] 곧 행사가 열립니다.\n{{이름}}님, 행사일: {{행사일}}\n입장할 때 티켓을 보여 주세요.",
  },
};
const DAY_CHOICES = [
  { days: 7, label: "행사 7일 전" }, { days: 3, label: "행사 3일 전" }, { days: 2, label: "행사 2일 전" },
  { days: 1, label: "행사 1일 전" }, { days: 0, label: "행사 당일" },
];
const ISSUE_LABELS: Record<string, string> = {
  TICKET_LINK_UNAVAILABLE: "티켓 링크를 만들 수 없어 자동으로 꺼졌습니다.",
  SMS_CHARSET_UNSUPPORTED: "문자로 보낼 수 없는 글자가 있어 자동으로 꺼졌습니다.",
};

// 을/를 by the last syllable's final consonant (batchim); non-Hangul endings read as open syllables.
function objectParticle(word: string): string {
  const code = word.trim().charCodeAt(word.trim().length - 1);
  return code >= 0xac00 && code <= 0xd7a3 && (code - 0xac00) % 28 !== 0 ? "을" : "를";
}

function commandId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

function RuleCard({ eventId, kind, rule, canWrite, active, serverNote, onSaved, preview, scheduledReminders }: {
  eventId: string; kind: Kind; rule: AutoNotifyRule | null; canWrite: boolean; active: boolean; serverNote: string; onSaved: () => void;
  preview?: (body: string) => ReactNode; scheduledReminders: number;
}) {
  const info = DEFAULTS[kind];
  const [enabled, setEnabled] = useState(rule?.enabled === true);
  const [body, setBody] = useState(rule?.body || info.body);
  const [days, setDays] = useState(rule?.days ?? 1);
  const [time, setTime] = useState(rule?.time || "18:00");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saved = rule?.enabled === true;
  const dirty = enabled !== saved || body !== (rule?.body || info.body) || (kind === "reminder" && (days !== (rule?.days ?? 1) || time !== (rule?.time || "18:00")));
  const turningOn = enabled && !saved;
  const id = `auto-notify-${kind}`;

  async function save() {
    if (busy) return;
    setBusy(true); setError(""); setNotice(""); setConfirming(false);
    try {
      const payload: Record<string, unknown> = { rule: kind, enabled, body };
      if (kind === "reminder") { payload.days = days; payload.time = time; }
      const response = await consoleFetch(`/api/events/${encodeURIComponent(eventId)}/commands`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ commandId: commandId(), command: "autoNotify.save", payload }),
      });
      const data = await response.json().catch(() => null) as { error?: unknown } | null;
      if (!response.ok) {
        setError(typeof data?.error === "string" && data.error ? data.error : "저장하지 못했습니다. 다시 시도하세요.");
        return;
      }
      setNotice(enabled ? "저장했습니다. 이제부터 조건에 맞으면 자동으로 보냅니다." : "저장했습니다. 자동 안내가 꺼져 있습니다.");
      onSaved();
    } catch {
      setError("저장 결과를 확인하지 못했습니다. 새로고침해서 현재 설정을 확인하세요.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className={styles.rule} aria-labelledby={`${id}-title`}>
      <header className={styles.ruleHead}>
        <h3 id={`${id}-title`}>{info.title}</h3>
        <span className={styles.headStatus}>
          {dirty ? <StatusPill tone="wait">저장하지 않은 변경</StatusPill> : null}
          <StatusPill tone={saved ? (active ? "ok" : "wait") : "neutral"} dot>{saved ? (active ? "켜짐" : "켜짐 · 지금은 보내지 않음") : "꺼짐"}</StatusPill>
        </span>
      </header>
      <p className={styles.help}>{info.summary}</p>
      {rule?.issue ? <ConsoleFeedback kind="warning">{ISSUE_LABELS[rule.issue] || "확인이 필요해 자동으로 꺼졌습니다."} 문구를 확인한 뒤 다시 켜세요.</ConsoleFeedback> : null}
      <label className={styles.toggle}>
        <input id={`${id}-enabled`} type="checkbox" checked={enabled} disabled={!canWrite || busy} onChange={(event) => { setEnabled(event.target.checked); setConfirming(false); setNotice(""); }} />
        <span>자동으로 보내기</span>
      </label>
      {kind === "reminder" ? (
        <div className={styles.when}>
          <label htmlFor={`${id}-days`}>언제
            <select id={`${id}-days`} value={days} disabled={!canWrite || busy} onChange={(event) => setDays(Number(event.target.value))}>
              {DAY_CHOICES.map((choice) => <option key={choice.days} value={choice.days}>{choice.label}</option>)}
            </select>
          </label>
          <label htmlFor={`${id}-time`}>시각 (한국 시간)
            <input id={`${id}-time`} type="time" step={60} value={time} disabled={!canWrite || busy}
              onChange={(event) => { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(event.target.value)) setTime(event.target.value); }} />
          </label>
        </div>
      ) : null}
      <label className={styles.bodyField} htmlFor={`${id}-body`}>보낼 내용
        <textarea id={`${id}-body`} value={body} maxLength={2000} rows={5} disabled={!canWrite || busy} onChange={(event) => setBody(event.target.value)} />
      </label>
      <p className={styles.help}>쓸 수 있는 변수: {"{{이름}}"}, {"{{행사명}}"}, {"{{행사일}}"}. 문자(SMS)로 보냅니다.</p>
      <p className={styles.help}>{"{{티켓링크}}"}도 넣을 수 있지만, 티켓을 만들 수 없는 참가자가 한 명이라도 있으면 이 안내가 자동으로 꺼집니다. 그래서 기본 문구에는 넣지 않았습니다.</p>
      {preview && body.trim() ? <div className={styles.preview}><span>받는 사람 화면 예시</span><p>{preview(body)}</p></div> : null}
      {kind === "reminder" && scheduledReminders > 0 ? <ConsoleFeedback kind="warning">이 행사에는 직접 예약한 리마인드가 {scheduledReminders}건 있습니다. 자동 리마인드를 켜면 같은 문자가 두 번 갈 수 있어요.</ConsoleFeedback> : null}
      {dirty ? <p className={styles.help} role="status">저장하지 않은 변경이 있습니다. 저장해야 적용됩니다.</p> : null}
      {enabled ? <p className={styles.help} role="note">{serverNote}</p> : null}
      {error ? <ConsoleFeedback kind="error">{error}</ConsoleFeedback> : null}
      {notice ? <ConsoleFeedback kind="success">{notice}</ConsoleFeedback> : null}
      {confirming ? (
        <ConsoleConfirm
          summary={<>
            <strong>‘{info.title}’{objectParticle(info.title)} 켭니다.</strong>
            <span> {kind === "confirmed" ? "켠 뒤에 확정되는 사람에게 자동으로 문자를 보냅니다. 이미 확정된 사람에게는 보내지 않습니다." : `${DAY_CHOICES.find((choice) => choice.days === days)?.label || ""} ${time}에 참가 확정자 전원에게 자동으로 문자를 보냅니다.`} 보낸 문자는 되돌릴 수 없습니다.</span>
          </>}
          confirmLabel="켜기"
          busy={busy}
          onConfirm={() => void save()}
          onCancel={() => setConfirming(false)}
        />
      ) : (
        <div className={styles.actions}>
          <ProductButton id={`${id}-save`} type="button" variant="primary" disabled={!canWrite || busy || !dirty || (enabled && !body.trim())}
            onClick={() => (turningOn ? setConfirming(true) : void save())}>
            {busy ? "저장 중" : "저장"}
          </ProductButton>
        </div>
      )}
    </section>
  );
}

export default function AutoNotifyPanel({ eventId, rules, canWrite, active, serverNote, onSaved, preview, scheduledReminders = 0 }: {
  eventId: string; rules: AutoNotifyRules; canWrite: boolean;
  // 작성 화면의 받는 화면 예시를 그대로 쓴다. 없으면 예시를 보이지 않는다.
  preview?: (body: string) => ReactNode; scheduledReminders?: number;
  // 서버가 자동 실행으로 설정돼 있고 발송이 연결된 경우에만 true. 아니면 규칙이 켜져 있어도 보내지 않는다.
  active: boolean; serverNote: string; onSaved: () => void;
}) {
  return (
    <ConsoleSection
      headingId="auto-notify-heading"
      title="자동 안내"
      description="조건이 맞으면 문자를 자동으로 보냅니다. 기본은 꺼져 있고, 안내마다 따로 켭니다."
      divider
    >
      {!canWrite ? <ConsoleFeedback kind="info">자동 안내를 바꿀 권한이 없거나 읽기 전용 상태입니다.</ConsoleFeedback> : null}
      <div className={styles.rules}>
        <RuleCard key={`confirmed:${JSON.stringify(rules.confirmed)}`} eventId={eventId} kind="confirmed" rule={rules.confirmed} canWrite={canWrite} active={active} serverNote={serverNote} onSaved={onSaved} preview={preview} scheduledReminders={scheduledReminders} />
        <RuleCard key={`reminder:${JSON.stringify(rules.reminder)}`} eventId={eventId} kind="reminder" rule={rules.reminder} canWrite={canWrite} active={active} serverNote={serverNote} onSaved={onSaved} preview={preview} scheduledReminders={scheduledReminders} />
      </div>
    </ConsoleSection>
  );
}
