// 현장 모드의 어두운 무대용 상태 알약. 공용 StatusPill은 밝은 작업면 색(--success-soft 등)이라
// 어두운 바탕에서는 대비가 맞지 않아 이 화면 안에서만 따로 둔다. 모양·글자 크기·굵기·모서리는
// StatusPill과 같은 토큰을 쓰고, 색만 무대용(밝은 선 색)이다. 글자는 항상 보이고 색만으로 구분하지 않는다.
// 공용 부품에 필요한 기능: StatusPill의 tone="on-dark"(어두운 바탕용) 변형.
import type { ReactNode } from "react";
import styles from "./live.module.css";

export type LivePillTone = "live" | "wait" | "neutral";

export default function LivePill({ tone = "neutral", dot = false, children }: { tone?: LivePillTone; dot?: boolean; children: ReactNode }) {
  return (
    <span className={styles.pill} data-tone={tone}>
      {dot ? <i className={styles.pillDot} aria-hidden="true" /> : null}
      {children}
    </span>
  );
}
