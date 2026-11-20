import type { ReactNode } from "react";
import styles from "./AttendeeFieldError.module.css";

// The one line under a field (or under a form's submit) that says what was not
// accepted: small, danger-colored, announced at once. It is not a state message:
// AttendeeStateMessage is the card for what a whole screen cannot show. Pass `id`
// when an input points to it with aria-describedby.
export default function AttendeeFieldError({ id, children, className }: { id?: string; children: ReactNode; className?: string }) {
  return (
    <p id={id} className={className ? `${styles.error} ${className}` : styles.error} role="alert">
      {children}
    </p>
  );
}
