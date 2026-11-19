import Link from "next/link";
import styles from "./BottomAction.module.css";

// The one strong action of a screen, fixed to the bottom of the 520px phone
// column with the home-indicator safe area under it. It renders its own
// spacer so the last content is never covered; BottomActionSpacer is exported
// for layouts that place the bar themselves.
export type BottomActionButton = {
  label: string;
  href?: string;
  onClick?: () => void;
  type?: "button" | "submit";
  /** Associates a submit button with a form elsewhere in the page. */
  form?: string;
  disabled?: boolean;
};

function ActionButton({ action, variant }: { action: BottomActionButton; variant: "primary" | "secondary" }) {
  const className = `${styles.button} ${variant === "primary" ? styles.primary : styles.secondary}`;
  if (action.href && !action.disabled) {
    return <Link className={className} href={action.href}>{action.label}</Link>;
  }
  return (
    <button
      type={action.type ?? "button"}
      form={action.form}
      className={className}
      onClick={action.onClick}
      disabled={action.disabled || (!action.onClick && action.type !== "submit")}
    >
      {action.label}
    </button>
  );
}

export function BottomActionSpacer({ withSecondary = false }: { withSecondary?: boolean }) {
  return <div className={`${styles.spacer} ${withSecondary ? styles.spacerDouble : ""}`} aria-hidden="true" data-bottom-action-spacer />;
}

export default function BottomAction({
  primary,
  secondary,
  spacer = true,
  label,
}: {
  primary: BottomActionButton;
  secondary?: BottomActionButton;
  /** Render the spacer after the bar (default). Pass false to place BottomActionSpacer yourself. */
  spacer?: boolean;
  /** Names the group for assistive technology, e.g. "신청 진행". */
  label?: string;
}) {
  return (
    <>
      {spacer ? <BottomActionSpacer withSecondary={Boolean(secondary)} /> : null}
      <div className={styles.bar} role="group" aria-label={label} data-bottom-action>
        <div className={styles.inner}>
          <ActionButton action={primary} variant="primary" />
          {secondary ? <ActionButton action={secondary} variant="secondary" /> : null}
        </div>
      </div>
    </>
  );
}
