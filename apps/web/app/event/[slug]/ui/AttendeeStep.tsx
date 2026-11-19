import styles from "./AttendeeStep.module.css";

// Progress of the registration flow: 1/3 as bars (default) or dots. Read as a
// progressbar by assistive technology with a spoken "3단계 중 1단계".
export default function AttendeeStep({
  current,
  total,
  variant = "bars",
  showCount = true,
  label = "진행 단계",
  className,
}: {
  /** 1-based step the attendee is on. */
  current: number;
  total: number;
  variant?: "bars" | "dots";
  showCount?: boolean;
  label?: string;
  className?: string;
}) {
  const count = Math.max(1, Math.floor(total));
  const step = Math.min(count, Math.max(1, Math.floor(current)));
  const classes = [styles.step, variant === "dots" ? styles.dots : styles.bars, className].filter(Boolean).join(" ");
  return (
    <div
      className={classes}
      role="progressbar"
      aria-label={label}
      aria-valuemin={1}
      aria-valuemax={count}
      aria-valuenow={step}
      aria-valuetext={`${count}단계 중 ${step}단계`}
    >
      <span className={styles.track} aria-hidden="true">
        {Array.from({ length: count }, (_, index) => (
          <i key={index} className={`${styles.unit} ${index < step ? styles.on : ""} ${index === step - 1 ? styles.current : ""}`} />
        ))}
      </span>
      {showCount ? <span className={styles.count} aria-hidden="true">{step}/{count}</span> : null}
    </div>
  );
}
