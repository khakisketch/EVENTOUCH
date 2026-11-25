import { Switch } from "@astryxdesign/core/Switch";
import type { ReactNode } from "react";
import ConsoleAvatar from "../../../console-ui/ConsoleAvatar";
import { ChevronRightIcon } from "../../../console-ui/ConsoleIcons";
import ProductLink from "../../../../ui/ProductLink";
import StatusPill from "../../../console-ui/StatusPill";
import { BoothIcon, DeskIcon, TabletIcon } from "./OpsIcons";
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
        <ConsoleAvatar key={person.assignmentId} name={person.name} tone="ok" size="sm" className={styles.face} />
      ))}
      {staff.length > 3 ? <span className={styles.facesMore}>+{staff.length - 3}</span> : null}
    </span>
  );
}

/** The duty line beside the faces: the first name, or a quiet "스태프 없음" for an empty place. Decorative; the row's spoken summary carries the same facts. */
function DutyCaption({ staff }: { staff: Staffer[] }) {
  if (!staff.length) return <span className={styles.dutyCaption} data-empty="true" aria-hidden="true">스태프 없음</span>;
  return (
    <span className={styles.dutyCaption} aria-hidden="true">
      {staff[0].name}{staff.length > 1 ? ` 외 ${staff.length - 1}명` : ""}
    </span>
  );
}

export type LocationKind = "desk" | "tablet" | "booth";
export type LocationTone = "on" | "off" | "wait" | "warn";

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
  /** Decorative tile: what kind of place this is and whether it is running. */
  kind: LocationKind;
  tone: LocationTone;
  /** Desks carry a switch; booths follow their schedule and show a status instead. */
  control: ReactNode;
};

function KindIcon({ kind }: { kind: LocationKind }) {
  if (kind === "tablet") return <TabletIcon />;
  if (kind === "booth") return <BoothIcon />;
  return <DeskIcon />;
}

/** One location (desk or booth): the row opens its detail, the control stays outside the button. */
export function LocationRow({ name, sub, staff, staffSummary, dim, warning, onOpen, openLabel, kind, tone, control }: LocationRowProps) {
  return (
    <li className={`${styles.location} ${dim ? styles.locationDim : ""}`}>
      <button type="button" className={styles.locationOpen} onClick={onOpen}>
        <span className={styles.locationTile} data-tone={tone} aria-hidden="true"><KindIcon kind={kind} /></span>
        <span className={styles.locationText}>
          <strong>{name}</strong>
          <span className="sr-only">{openLabel}</span>
          <span className={styles.locationSub}>{sub}</span>
          {warning ? <span className={styles.locationWarn}>{warning}</span> : null}
          <span className="sr-only">{staffSummary}</span>
        </span>
        <span className={styles.locationDuty}>
          <StaffFaces staff={staff} />
          <DutyCaption staff={staff} />
        </span>
        <span className={styles.locationChevron} aria-hidden="true"><ChevronRightIcon /></span>
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
  // The visible track is 40x24; the wrapper grows the operable area to the 44px touch floor.
  return (
    <span className={styles.runSwitch}>
      <Switch
        label={`${name} 가동`}
        isLabelHidden
        value={on}
        isDisabled={disabled}
        disabledMessage={disabled ? reason : undefined}
        onChange={() => onToggle()}
      />
    </span>
  );
}

/** Booth schedule state: the shared pill (dot plus word), never colour alone. */
export function StatusDot({ tone, children }: { tone: "good" | "wait" | "muted"; children: ReactNode }) {
  return <StatusPill tone={tone === "good" ? "ok" : tone === "wait" ? "info" : "neutral"} size="sm" dot>{children}</StatusPill>;
}

type DeskCardProps = {
  name: string;
  /** Quiet word after the name: the exit direction, or a desk whose setup needs a look. */
  note: string | null;
  tone: "on" | "off" | "warn";
  dim: boolean;
  /** People processed at this desk, or null while the entry records cannot be read. */
  count: number | null;
  /** "방금" / "N분 전" / a clock time; null when nothing was processed yet. */
  last: string | null;
  staff: Staffer[];
  onOpen: () => void;
  /** The field screen for this desk on this device, or null when it cannot take scans. */
  enterHref: string | null;
  /** Orange only when there is a single running desk to open. */
  enterPrimary: boolean;
  /** The desk's arrival sign, for entry desks. */
  poster?: ReactNode;
  /** The run switch; it sits outside the opening button. */
  control: ReactNode;
};

/**
 * 진행 중 데스크 보드의 카드 하나(2026-11-24, 다시 엶 2026-11-25). 카드 전체가 데스크 상세를 열고,
 * 가동 스위치와 "이 기기에서 열기"는 열기 버튼 밖에 둔다. 스태프 배정은 선택이라 경고색을 쓰지 않는다.
 */
export function DeskCard({ name, note, tone, dim, count, last, staff, onOpen, enterHref, enterPrimary, poster, control }: DeskCardProps) {
  const lastLine = count === null ? null : last ? `마지막 처리 ${last}` : "아직 처리 기록이 없습니다";
  return (
    <li className={styles.deskCard} data-dim={dim ? "true" : undefined}>
      <button type="button" className={styles.cardOpen} onClick={onOpen}>
        <span className={styles.cardHead}>
          <span className={styles.cardDot} data-tone={tone} aria-hidden="true" />
          <strong className={styles.cardName}>{name}</strong>
          {note ? <span className={styles.cardNote}>{note}</span> : null}
        </span>
        <span className={styles.cardStat}>
          {count === null ? (
            <span className={styles.cardUnknown}>확인 불가</span>
          ) : (
            <>
              <b className={styles.cardNum}>{count}</b>
              <span className={styles.cardUnit}>명 처리</span>
            </>
          )}
          <span className={styles.cardMore} aria-hidden="true">상세<ChevronRightIcon /></span>
        </span>
        {lastLine ? <span className={styles.cardMeta}>{lastLine}</span> : null}
        <span className={styles.cardFoot}>
          {staff.length ? (
            <>
              <ConsoleAvatar name={staff[0].name} tone="ok" size="sm" />
              <span className={styles.cardStaff}>{staff[0].name}{staff.length > 1 ? ` 외 ${staff.length - 1}명` : ""}</span>
            </>
          ) : (
            <span className={styles.cardNone}>휴대폰 스태프 없음</span>
          )}
        </span>
        <span className="sr-only">상세 보기</span>
      </button>
      <span className={styles.cardControl}>{control}</span>
      {enterHref || poster ? (
        <div className={styles.cardEnter}>
          {enterHref ? (
            <ProductLink variant={enterPrimary ? "primary" : "secondary"} className={styles.cardEnterLink} href={enterHref} target="_blank" rel="noreferrer" aria-label={`${name} 이 기기에서 열기 (새 탭)`}>
              이 기기에서 열기
            </ProductLink>
          ) : null}
          {poster}
        </div>
      ) : null}
    </li>
  );
}
