import DeviceFrame from "../../../console-ui/DeviceFrame";
import styles from "./draws.module.css";

// A small, faithful redraw of what the audience actually sees, so the operator
// reads the stage before acting and in the same place afterwards: draws show the
// venue-screen scene (/screen), roulette, vote and lucky numbers show the
// attendee phone card. It loads nothing and runs no commands; the real screens
// stay the source of truth, and the whole preview is decorative for assistive
// technology (the card beside it states the same facts in text). Each scene is
// drawn at the real device size inside a device simulator (a 1280x720 venue
// screen, a 390px phone) and scaled down as a whole.

export type StageScene =
  | { kind: "board"; event: string; program: string; winner: { name: string; sub: string; tier: string } | null; more: number }
  | { kind: "vote"; teams: string[]; pickCount: number }
  | { kind: "roulette"; prizes: Array<{ label: string; left: string }> }
  | { kind: "lucky"; digits: number };

function Phone({ title, event, action, children }: { title: string; event: string; action: string; children: React.ReactNode }) {
  return (
    <DeviceFrame variant="phone" fixed maxDisplayWidth={300} className={styles.device}>
      <div className={styles.phoneScreen}>
        <div className={styles.phoneHead}>{title}<small>{event}</small></div>
        <div className={styles.phoneBody}>{children}</div>
        <div className={styles.phoneFoot}><span>{action}</span></div>
      </div>
    </DeviceFrame>
  );
}

export default function StagePreview({ scene, label, event }: { scene: StageScene; label: string; event: string }) {
  return (
    <div className={styles.stageBox} role="img" aria-label={label} data-scene={scene.kind}>
      {scene.kind === "board" ? (
        <DeviceFrame variant="screen" fixed maxDisplayWidth={640} className={styles.device}>
        <div className={styles.board} aria-hidden="true">
          <div>
            <div className={styles.boardHead}><span>{scene.event}</span></div>
            <div className={styles.boardTitle}>{scene.program}</div>
          </div>
          <div className={styles.boardWinner}>
            {scene.winner ? (
              <>
                <small>{scene.winner.sub}</small>
                <b>{scene.winner.name}</b>
                <span>{[scene.winner.tier, scene.more > 0 ? `외 ${scene.more}명` : ""].filter(Boolean).join(" · ")}</span>
              </>
            ) : <small>아직 추첨 결과가 없습니다</small>}
          </div>
          <div className={styles.boardFoot} />
        </div>
        </DeviceFrame>
      ) : scene.kind === "vote" ? (
        <Phone title="순위 투표" event={event} action="투표하기">
          <p>좋아하는 팀 {scene.pickCount}개를 순서대로</p>
          {scene.teams.slice(0, 5).map((team, index) => (
            <div className={styles.phonePick} key={`${team}-${index}`}><i>{index + 1}</i>{team}</div>
          ))}
        </Phone>
      ) : scene.kind === "roulette" ? (
        <Phone title="모바일 룰렛" event={event} action="돌리기">
          <div className={styles.wheel} />
          {scene.prizes.slice(0, 3).map((prize) => (
            <div className={styles.phonePrize} key={prize.label}><b>{prize.label}</b><span>{prize.left}</span></div>
          ))}
        </Phone>
      ) : (
        <Phone title="내 럭키번호" event={event} action="내 QR 보기">
          <p>추첨에 쓰이는 내 번호</p>
          <div className={styles.phoneDigits}>{Array.from({ length: scene.digits }, (_, index) => <i key={index}>—</i>)}</div>
          <p>입장하면 발급됩니다</p>
        </Phone>
      )}
    </div>
  );
}
