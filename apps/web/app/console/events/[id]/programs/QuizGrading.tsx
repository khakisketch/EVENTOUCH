"use client";

import { useRef, useState } from "react";
import ConsoleFeedback from "../../../console-ui/ConsoleFeedback";
import ConsoleFormActions from "../../../console-ui/ConsoleFormActions";
import styles from "./programs.module.css";

export type GradePayload = { moduleId: string; responseId: string; grade: "CORRECT" | "INCORRECT" | "AUTO"; expectedGradeVersion: number };
export type GradeResult = { ok: boolean; uncertain?: boolean; message?: string };
export type GradedResponse = { id: string; answer: string; manualGrade?: "CORRECT" | "INCORRECT" | null; gradeVersion?: number };
export default function QuizGrading({ moduleId, responses, locked, pending, submit }: {
  moduleId: string; responses: GradedResponse[]; locked: boolean; pending: boolean;
  submit: (payload: GradePayload, unconfirmed: boolean) => Promise<GradeResult>;
}) {
  const [limit, setLimit] = useState(10);
  const [working, setWorking] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const gate = useRef(false);
  async function save(payload: GradePayload, unconfirmed = false) {
    if (gate.current || locked) return;
    gate.current = true; setWorking(true); setFailure(null); setNotice("");
    try {
      const result = await submit(payload, unconfirmed);
      if (result.ok) { setNotice("채점을 저장했습니다."); }
      else { setFailure(result.message || "채점을 저장하지 못했습니다."); }
    } catch { setFailure("채점 결과를 확인하지 못했습니다. 같은 요청으로 다시 확인하세요."); }
    finally { gate.current = false; setWorking(false); }
  }
  return (
    <details className={styles.resultDisclosure} data-quiz-grading>
      <summary data-disclosure-indicator="">응답별 수동 채점 · {responses.length}건</summary>
      <p className={styles.detail}>표기가 달라도 정답으로 인정할 수 있습니다. 수동 채점이 자동 비교보다 우선하며, 자동 비교로 되돌릴 수 있습니다.</p>
      <div role="status" aria-live="polite">{notice}</div>
      {failure ? <ConsoleFeedback kind="error">{failure}</ConsoleFeedback> : null}
      <ol className={styles.resultList}>
        {responses.slice(0, limit).map((response, index) => <li key={response.id}>
          <p>응답 {index + 1} · {response.answer || "무응답"}</p>
          <p>{response.manualGrade === "CORRECT" ? "수동 채점: 정답" : response.manualGrade === "INCORRECT" ? "수동 채점: 오답" : "자동 비교 사용 중"}</p>
          <ConsoleFormActions>
            {([ ["CORRECT", "정답 처리"], ["INCORRECT", "오답 처리"], ["AUTO", "자동 비교로 복원"] ] as const).map(([grade, label]) => <button
              key={grade} type="button" className="button button-secondary"
              aria-label={`응답 ${index + 1} ${label}`}
              disabled={locked || working || pending || (grade === "AUTO" ? !response.manualGrade : response.manualGrade === grade)}
              onClick={() => void save({ moduleId, responseId: response.id, grade, expectedGradeVersion: response.gradeVersion || 0 })}
            >{label}</button>)}
          </ConsoleFormActions>
        </li>)}
      </ol>
      {responses.length > limit ? <button type="button" className="button button-secondary" onClick={() => setLimit(value => value + 10)}>응답 더 보기</button> : null}
      {!responses.length ? <p>채점할 응답이 없습니다.</p> : null}
    </details>
  );
}
