import styles from "./console-skeleton.module.css";

/**
 * Loading skeleton for console screens (2026-11-23).
 *
 * The console loads each screen's data on the client, so every screen used to
 * start with one line of text and then jump when the data arrived. A skeleton
 * is the same screen drawn as quiet blocks, so the page keeps its shape.
 *
 * Server-safe (no hooks), purely decorative: the group is aria-hidden and the
 * caller announces the loading state itself (ConsoleStatePanel does).
 */
export type ConsoleSkeletonShape = "overview" | "list" | "form" | "cards" | "split";

const block = (extra?: string) => (extra ? `${styles.block} ${extra}` : styles.block);

function Row({ index }: { index: number }) {
  return (
    <div className={styles.row}>
      <div className={block(styles.rowDot)} />
      <div className={styles.rowText}>
        <div className={block(`${styles.line} ${index % 2 ? styles.lineMid : styles.lineWide}`)} />
        <div className={block(`${styles.line} ${styles.lineShort}`)} />
      </div>
      <div className={block(styles.rowPill)} />
    </div>
  );
}

function Rows({ count }: { count: number }) {
  return (
    <div>
      {Array.from({ length: count }, (_, index) => (
        <Row key={index} index={index} />
      ))}
    </div>
  );
}

function Fields({ count }: { count: number }) {
  return (
    <>
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className={styles.field}>
          <div className={block(`${styles.line} ${styles.lineShort}`)} />
          <div className={block(styles.input)} />
        </div>
      ))}
    </>
  );
}

export function ConsoleSkeletonBody({ shape = "list" }: { shape?: ConsoleSkeletonShape }) {
  switch (shape) {
    case "overview":
      return (
        <>
          <div className={block(styles.hero)} />
          <div className={styles.stats}>
            {[0, 1, 2, 3].map((key) => (
              <div key={key} className={block(styles.stat)} />
            ))}
          </div>
          <Rows count={3} />
        </>
      );
    case "cards":
      return (
        <>
          <div className={styles.toolbar}>
            <div className={block(styles.search)} />
            <div className={block(styles.tabs)} />
          </div>
          <div className={styles.cards}>
            {[0, 1, 2, 3, 4, 5].map((key) => (
              <div key={key} className={block(styles.card)} />
            ))}
          </div>
        </>
      );
    case "form":
      return <Fields count={4} />;
    case "split":
      return (
        <div className={styles.split}>
          <div className={block(styles.phone)} />
          <div className={styles.page}>
            <Fields count={3} />
          </div>
        </div>
      );
    case "list":
    default:
      return (
        <>
          <div className={styles.toolbar}>
            <div className={block(styles.search)} />
            <div className={block(styles.tabs)} />
          </div>
          <Rows count={6} />
        </>
      );
  }
}

/** Body-only skeleton: the page header is already on screen. */
export default function ConsoleSkeleton({ shape = "list" }: { shape?: ConsoleSkeletonShape }) {
  return (
    <div className={styles.group} aria-hidden="true">
      <ConsoleSkeletonBody shape={shape} />
    </div>
  );
}

/** Whole-page skeleton for route-level loading.tsx: header placeholder + body. */
export function ConsolePageSkeleton({ shape = "list" }: { shape?: ConsoleSkeletonShape }) {
  return (
    <div className={`${styles.page} ${styles.group}`} aria-busy="true">
      <p className={styles.visuallyHidden} role="status">
        화면을 불러오고 있습니다.
      </p>
      <div className={styles.pageHeader} aria-hidden="true">
        <div className={block(`${styles.line} ${styles.lineShort}`)} />
        <div className={block(styles.title)} />
        <div className={block(`${styles.line} ${styles.lineMid}`)} />
      </div>
      <div className={styles.page} aria-hidden="true">
        <ConsoleSkeletonBody shape={shape} />
      </div>
    </div>
  );
}
