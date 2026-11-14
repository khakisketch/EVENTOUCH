// Content-type tiles for the programs screen: one authored stroke family
// (24 grid, currentColor, round caps — the voice of ConsoleIcons) on a soft
// tinted square. The small corner dot carries the run state: green running,
// amber preparing, hollow ended. Decorative; the row's text names both.

import styles from "./programs.module.css";

type Props = { type: string; state?: "live" | "prep" | "done"; small?: boolean };

const TYPES = ["poll", "quiz", "qa", "survey", "draw", "photo", "board"] as const;
type Known = (typeof TYPES)[number];

function known(type: string): Known | null {
  return (TYPES as readonly string[]).includes(type) ? (type as Known) : null;
}

function Glyph({ type }: { type: Known | null }) {
  switch (type) {
    case "poll":
      return <path d="M6 19v-7M12 19V6M18 19v-4M4 19.5h16" />;
    case "quiz":
      return (<><circle cx="12" cy="12" r="8.5" /><path d="M9.6 9.6a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .8-1 1.5v.4M12 16.6v.1" /></>);
    case "qa":
      return (<><path d="M4.5 5h9.5a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9.5L6 17v-3H4.5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z" /><path d="M18.5 9h1a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H19v2.5L16 18h-3.5" /></>);
    case "survey":
      return <path d="M12 4l2.4 4.9 5.4.8-3.9 3.8.9 5.4L12 16.4 7.2 18.9l.9-5.4-3.9-3.8 5.4-.8z" />;
    case "draw":
      return (<><path d="M4.5 10.5h15V20h-15zM3.5 7.5h17v3h-17zM12 7.5V20" /><path d="M12 7.5C10.5 4.5 7 4.3 7 6.2S10 7.5 12 7.5c2 0 5 .6 5-1.3s-3.5-1.7-5 1.3" /></>);
    case "photo":
      return (<><rect x="3.5" y="5" width="17" height="14" rx="2.5" /><circle cx="9" cy="10" r="1.6" /><path d="M20.5 16l-4.8-4.6-8.2 7.6" /></>);
    case "board":
      return (<><path d="M5 4.5h14v10l-5 5H5z" /><path d="M14 19.5v-5h5M8.5 9h7M8.5 12h4" /></>);
    default:
      return <circle cx="12" cy="12" r="7.5" />;
  }
}

export default function ProgramTypeIcon({ type, state, small = false }: Props) {
  const kind = known(type);
  return (
    <span className={small ? `${styles.typeTile} ${styles.typeTileSmall}` : styles.typeTile} data-type={kind ?? "other"} aria-hidden="true">
      <svg viewBox="0 0 24 24" focusable="false"><Glyph type={kind} /></svg>
      {state ? <i data-state={state} /> : null}
    </span>
  );
}
