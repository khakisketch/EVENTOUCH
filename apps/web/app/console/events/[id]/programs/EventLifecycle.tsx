// 참여 이벤트 life cycle parts: the four-segment meter on every row, the
// five-step header inside an opened event, and the status pill. Everything
// is drawn from `lib/participation-events.ts`, which derives each segment
// only from data that exists. Decorative color is never the only signal:
// every segment and step also carries text.

import type { LifecycleSegment, LifecycleStep, PillTone } from "../../../../../lib/participation-events";
import ProductLink from "../../../../ui/ProductLink";
import styles from "./programs.module.css";

const SEGMENT_STATE_TEXT: Record<LifecycleSegment["state"], string> = {
  done: "완료", current: "지금 단계", todo: "대기", na: "해당 없음",
};

export function LifecycleMeter({ segments }: { segments: LifecycleSegment[] }) {
  return (
    <ol className={styles.lifeMeter} aria-label="이벤트 진행 단계">
      {segments.map((segment) => (
        <li key={segment.key} data-key={segment.key} data-state={segment.state}>
          <i aria-hidden="true" />
          <span>{segment.label}<span className="sr-only"> {SEGMENT_STATE_TEXT[segment.state]}</span></span>
        </li>
      ))}
    </ol>
  );
}

export function StatusPill({ tone, label }: { tone: PillTone; label: string }) {
  return <span className={styles.statusPill} data-tone={tone}>{label}</span>;
}

export function EventStepper({ steps, rewardsHref, rewardCount }: { steps: LifecycleStep[]; rewardsHref: string; rewardCount: number | null }) {
  const current = steps.find((step) => step.state === "current") ?? null;
  return (
    <section className={styles.stepper} aria-label="이벤트 5단계">
      <ol>
        {steps.map((step, index) => (
          <li key={step.key} data-state={step.state} aria-current={step.state === "current" ? "step" : undefined}>
            <span className={styles.stepDot} aria-hidden="true">{step.state === "done" ? "✓" : index + 1}</span>
            <span className={styles.stepText}>
              <b>{step.label}</b>
              <span>{step.hint}</span>
              {step.key === "reward" && rewardCount !== null ? (
                <ProductLink variant="ghost" className={styles.stepLink} href={rewardsHref}>{rewardCount > 0 ? `경품 지급 ${rewardCount}건 보기` : "경품 지급 열기"}</ProductLink>
              ) : null}
            </span>
          </li>
        ))}
      </ol>
      <p className={styles.stepNow}>
        {current ? <>지금 단계 · <b>{current.label}</b></> : <>모든 단계가 정리되었습니다.</>}
      </p>
    </section>
  );
}
