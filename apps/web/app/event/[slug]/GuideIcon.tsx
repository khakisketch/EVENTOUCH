import homeStyles from "./home/home.module.css";

// Icons of the event guide, drawn like the attendee home's menu icons (same
// 48px grid, stroke and size class) so a guide entry and a home entry read as
// one family.
export type GuideIconType = "register" | "ticket" | "notice" | "program" | "map" | "venue";

export default function GuideIcon({ type }: { type: GuideIconType }) {
  const common = {
    className: homeStyles.menuIcon,
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };
  switch (type) {
    case "ticket":
      return <svg {...common}><path d="M9 13h3l2.3-3.5h19.4L36 13h3a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3h-3l-2.3 3.5H14.3L12 34h-3a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3Z" /><circle cx="24" cy="23.5" r="6" /></svg>;
    case "register":
      return <svg {...common}><path d="M12 7h24v34H12zM17 16h14M17 23h14M17 30h10" /></svg>;
    case "notice":
      return <svg {...common}><path d="M10 6h28v27H10zM15 12h18M15 18h18M15 24h12M17 33v6m14-6v6" /><path d="M7 10v22" /></svg>;
    case "program":
      return <svg {...common}><circle cx="24" cy="24" r="16" /><path d="M24 14v10l7 4" /></svg>;
    case "map":
      return <svg {...common}><path d="M6 12l12-4 12 4 12-4v28l-12 4-12-4-12 4zM18 8v28M30 12v28" /></svg>;
    case "venue":
      return <svg {...common}><path d="M24 42s12-10.4 12-20a12 12 0 0 0-24 0c0 9.6 12 20 12 20z" /><circle cx="24" cy="22" r="4.5" /></svg>;
  }
}
