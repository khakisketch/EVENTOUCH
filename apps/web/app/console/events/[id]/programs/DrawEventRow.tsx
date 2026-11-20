// A stage draw, rank vote, roulette or lucky-number item as a row of the
// 참여 이벤트 list. It reads the same operator bootstrap as every other row;
// running it (draw run, 무대 터치, 결과 공개, settings) stays on the draws
// stage, reachable from the opened row with its existing #hash selection.

import ProductLink from "../../../../ui/ProductLink";
import { eventPill, lifecycleSegments, lifecycleSteps, type DrawEvent, type EventFacts } from "../../../../../lib/participation-events";
import ProgramTypeIcon from "./ProgramIcons";
import StatusPill from "../../../console-ui/StatusPill";
import { EventStepper, LifecycleMeter, eventPillTone } from "./EventLifecycle";
import styles from "./programs.module.css";

const STATE_LABEL: Record<string, string> = { DRAFT: "준비 중", OPEN: "진행 중", CLOSED: "종료" };

export default function DrawEventRow({ event, eventId, featureOn, closeHref }: {
  event: DrawEvent;
  eventId: string;
  featureOn: boolean;
  closeHref: (target: string) => string;
}) {
  const facts: EventFacts = { status: event.status, configured: event.configured, hasResult: event.hasResult, rewardCount: event.rewardCount };
  let pill = eventPill(facts);
  // Lucky numbers have no open/close of their own: say what is true.
  if (event.kind === "lucky" && event.status === "DRAFT") pill = event.configured ? { tone: "ready", label: "번호 배정됨" } : { tone: "prep", label: "번호 미배정" };
  const state = event.status === "OPEN" ? "live" : event.status === "CLOSED" ? "done" : "prep";
  const base = `/console/events/${encodeURIComponent(eventId)}`;
  const stageHref = closeHref(`${base}/draws${event.hash}`);
  // 경품 지급 is not an event-close destination, so the link is plain (closeHref would throw while a close handoff is active).
  const rewardsHref = `${base}/rewards`;
  const id = `event-row-${event.key.replace(/[^A-Za-z0-9_-]/gu, "-")}`;
  return (
    <li className={styles.moduleCard} data-status={event.status} data-kind={event.kind} data-feature-off={featureOn ? undefined : "true"}>
      <details className={styles.moduleDetails}>
        <summary className={styles.moduleSummary}>
          <ProgramTypeIcon type={event.icon} state={state} />
          <span className={styles.moduleName}>
            <h3 className={styles.moduleTitle} id={id} tabIndex={-1}>{event.title}</h3>
            <span className={styles.moduleLine}>
              <span>{event.line}</span>
              {event.schedule ? <span>{event.schedule}</span> : null}
              {event.rewardCount !== null && event.rewardCount > 0 ? <span>경품 {event.rewardCount}</span> : null}
              {!featureOn ? <b className={styles.moduleWarn}>이 유형이 꺼져 있습니다</b> : null}
              <span className="sr-only"> · {STATE_LABEL[event.status] ?? "상태 확인 필요"}</span>
            </span>
          </span>
          <LifecycleMeter segments={lifecycleSegments(facts)} />
          <span className={styles.moduleCount}>{event.status !== "DRAFT" || event.count > 0 ? <><b>{event.count}</b>{event.unit}</> : null}</span>
          <StatusPill tone={eventPillTone(pill.tone)} dot={pill.tone === "live"} align="end">{pill.label}</StatusPill>
        </summary>
        <div className={styles.moduleBody}>
          <EventStepper steps={lifecycleSteps(facts)} rewardsHref={rewardsHref} rewardCount={event.rewardCount} />
          {!featureOn ? (
            <p className={styles.featureOff} role="note">
              이 유형이 꺼져 있습니다.{" "}
              <ProductLink href={closeHref(`${base}/settings#settings-features`)}>행사 설정</ProductLink>에서 기능을 먼저 켜세요.
            </p>
          ) : null}
          <ul className={styles.factList} aria-label={`${event.title} 현황`}>
            {event.facts.map((fact) => <li key={fact}>{fact}</li>)}
          </ul>
          <div className={styles.moduleFoot}>
            <ProductLink variant="secondary" href={stageHref}>무대에서 진행·당첨 보기</ProductLink>
          </div>
        </div>
      </details>
    </li>
  );
}
