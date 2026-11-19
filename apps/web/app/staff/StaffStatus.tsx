// Staff field screen status vocabulary (design-system application 2026-11-20).
// One rule for every state shown on the dark field column and in its sheets:
// an icon, words, and a tone (ok = done, warn = needs a look, danger = failed,
// info = for your information). Colour is never the only signal.
//
// Why local: console-ui's ConsoleFeedback/ConsoleStatePanel are drawn for the
// white console and need a surface prop to sit on ink; StatusPill already
// works on any surface (its fills are opaque tint pairs) so it is reused as-is.
import type { ReactNode } from "react";
import StatusPill, { type StatusPillTone } from "../console/console-ui/StatusPill";
import { BangIcon, CheckIcon, InfoIcon, MinusIcon, XIcon } from "../console/console-ui/ConsoleIcons";
import styles from "./staff-status.module.css";

export type StaffTone = "ok" | "warn" | "danger" | "info";

const NOTE_ICON: Record<StaffTone, () => ReactNode> = {
  ok: () => <CheckIcon />,
  warn: () => <BangIcon />,
  danger: () => <XIcon />,
  info: () => <InfoIcon />,
};

type StaffNoteProps = {
  tone?: StaffTone;
  role?: "status" | "alert";
  id?: string;
  className?: string;
  children: ReactNode;
};

/** A message line: tinted face, tone icon, words. Replaces the global `.notice` paragraphs on the field screen. */
export function StaffNote({ tone = "info", role, id, className, children }: StaffNoteProps) {
  return (
    <div id={id} className={[styles.note, className].filter(Boolean).join(" ")} data-tone={tone} data-staff-note={tone} role={role}>
      <span className={styles.noteIcon} aria-hidden="true">{NOTE_ICON[tone]()}</span>
      <div className={styles.noteBody}>{children}</div>
    </div>
  );
}

export type StaffPillTone = Extract<StatusPillTone, "ok" | "wait" | "info" | "danger" | "neutral">;

const PILL_ICON: Record<StaffPillTone, () => ReactNode> = {
  ok: () => <CheckIcon />,
  wait: () => <BangIcon />,
  info: () => <InfoIcon />,
  danger: () => <XIcon />,
  neutral: () => <MinusIcon />,
};

/** A status pill with its icon. Wraps the shared StatusPill so row states read the same everywhere on this screen. */
export function StaffPill({ tone = "neutral", children, className }: { tone?: StaffPillTone; children: ReactNode; className?: string }) {
  return (
    <StatusPill tone={tone} size="sm" className={[styles.pill, className].filter(Boolean).join(" ")}>
      <span className={styles.pillIcon} aria-hidden="true">{PILL_ICON[tone]()}</span>
      {children}
    </StatusPill>
  );
}
