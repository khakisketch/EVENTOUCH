// Small stroke glyphs for the reward oversight screen (24 grid, currentColor,
// round caps — the voice of ConsoleIcons). Decorative: text always names the
// state next to them.

const PATHS: Record<string, React.ReactNode> = {
  alert: (<><path d="M12 8v5M12 16.5v.1" /><path d="M10.3 4.6L3.4 17a2 2 0 0 0 1.7 3h13.8a2 2 0 0 0 1.7-3L13.7 4.6a2 2 0 0 0-3.4 0z" /></>),
  clock: (<><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  x: <path d="M6 6l12 12M18 6L6 18" />,
  userx: (<><circle cx="9.5" cy="8" r="3.5" /><path d="M3 19c.6-3.2 3.2-5 6.5-5 1.6 0 3 .4 4.1 1.2M16 14l5 5M21 14l-5 5" /></>),
  userplus: (<><circle cx="9.5" cy="8" r="3.5" /><path d="M3 19c.6-3.2 3.2-5 6.5-5M18 12v6M15 15h6" /></>),
  plug: <path d="M9 3v4M15 3v4M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />,
  hand: <path d="M8 12V6.5a1.5 1.5 0 0 1 3 0V11M11 10V5a1.5 1.5 0 0 1 3 0v6M14 10.5V7a1.5 1.5 0 0 1 3 0v8c0 3-2 5-5 5s-4-1.5-5-3.5L4.5 13a1.4 1.4 0 0 1 2.3-1.5L8 13" />,
  ticket: <path d="M4 8.5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1.5a2 2 0 0 0 0 4V15.5a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V14a2 2 0 0 0 0-4z" />,
};

export default function RewardGlyph({ name, small = false }: { name: string; small?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false" data-small={small || undefined}>
      {PATHS[name] ?? PATHS.alert}
    </svg>
  );
}
