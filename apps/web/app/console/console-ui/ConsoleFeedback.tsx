import type { ReactNode } from "react";
import styles from "./console-ui.module.css";

type ConsoleFeedbackKind = "success" | "error" | "warning" | "info";

type ConsoleFeedbackProps = {
  kind: ConsoleFeedbackKind;
  children: ReactNode;
  id?: string;
};

const KIND_CLASS: Record<ConsoleFeedbackKind, string> = {
  success: styles.feedbackSuccess,
  error: styles.feedbackError,
  warning: styles.feedbackWarning,
  info: styles.feedbackInfo,
};

/**
 * Page-level feedback strip reusing the product feedback tokens. Errors
 * assert with `alert`; success, warning and info persist politely with
 * `status`. Field errors and quiet helper notes stay inline plain text,
 * not alerts. Hook-free.
 */
export default function ConsoleFeedback({ kind, children, id }: ConsoleFeedbackProps) {
  return (
    <div
      className={[styles.feedback, KIND_CLASS[kind]].filter(Boolean).join(" ")}
      role={kind === "error" ? "alert" : "status"}
      id={id}
    >
      {children}
    </div>
  );
}
