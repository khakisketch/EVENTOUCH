import { Avatar } from "@astryxdesign/core/Avatar";
import { Switch } from "@astryxdesign/core/Switch";
import type { ReactNode } from "react";
import styles from "./operations.module.css";

export type Staffer = { assignmentId: string; accountId: string; name: string };

/** Who is on duty as initials; an empty slot is a dashed plus that names the gap. */
export function StaffFaces({ staff }: { staff: Staffer[] }) {
  if (!staff.length) {
    return <span className={styles.faceEmpty} aria-hidden="true">+</span>;
  }
  return (
    <span className={styles.faces} aria-hidden="true">
      {staff.slice(0, 3).map((person) => (
        <Avatar key={person.assignmentId} name={person.name} size="sm" />
      ))}
      {staff.length > 3 ? <span className={styles.facesMore}>+{staff.length - 3}</span> : null}
    </span>
  );
}

type LocationRowProps = {
  name: string;
  sub: string;
  staff: Staffer[];
  /** Spoken description of the whole row; the visible faces are decorative. */
  staffSummary: string;
  dim?: boolean;
  warning?: string | null;
  onOpen: () => void;
  openLabel: string;
  /** Desks carry a switch; booths follow their schedule and show a status instead. */
  control: ReactNode;
};

/** One location (desk or booth): the row opens its detail, the control stays outside the button. */
export function LocationRow({ name, sub, staff, staffSummary, dim, warning, onOpen, openLabel, control }: LocationRowProps) {
  return (
    <li className={`${styles.location} ${dim ? styles.locationDim : ""}`}>
      <button type="button" className={styles.locationOpen} onClick={onOpen} aria-label={`${openLabel} ${name}`}>
        <span className={styles.locationText}>
          <strong>{name}</strong>
          <span className={styles.locationSub}>{sub}</span>
          {warning ? <span className={styles.locationWarn}>{warning}</span> : null}
          <span className="sr-only">{staffSummary}</span>
        </span>
        <StaffFaces staff={staff} />
        <span className={styles.locationChevron} aria-hidden="true">›</span>
      </button>
      <span className={styles.locationControl}>{control}</span>
    </li>
  );
}

type DeskSwitchProps = {
  name: string;
  on: boolean;
  disabled: boolean;
  reason?: string;
  onToggle: () => void;
};

export function RunSwitch({ name, on, disabled, reason, onToggle }: DeskSwitchProps) {
  return (
    <Switch
      label={`${name} 가동`}
      isLabelHidden
      value={on}
      isDisabled={disabled}
      disabledMessage={disabled ? reason : undefined}
      onChange={() => onToggle()}
    />
  );
}

export function StatusDot({ tone, children }: { tone: "good" | "wait" | "muted"; children: ReactNode }) {
  return <span className={styles.statusDot} data-tone={tone}>{children}</span>;
}
