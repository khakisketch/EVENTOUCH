// Local icons for the field-operations screen: the same 24-grid, round-cap
// stroke family as the shared console icons (which this screen may not edit).
// Decorative only; every use sits beside visible text or a spoken summary.

type IconProps = { className?: string };

function svgProps(className?: string) {
  return { className: ["action-icon", className].filter(Boolean).join(" "), "aria-hidden": true as const, focusable: "false" as const, viewBox: "0 0 24 24" };
}

/** Entry desk: a monitor on a stand. */
export function DeskIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <rect x="3.5" y="4.5" width="17" height="11" rx="2" />
      <path d="M9 20h6M12 15.5V20" />
    </svg>
  );
}

/** Self-service tablet. */
export function TabletIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <rect x="5.5" y="3.5" width="13" height="17" rx="2.5" />
      <path d="M10.5 17.5h3" />
    </svg>
  );
}

/** Booth: a flag on a pole. */
export function BoothIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M6 20.5V4M6 5h11.5l-2.2 3.8 2.2 3.7H6" />
    </svg>
  );
}

/** Venue display: a wide screen with a stand. */
export function ScreenIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <rect x="2.5" y="4" width="19" height="12.5" rx="2" />
      <path d="M8 20.5h8M12 16.5v4" />
    </svg>
  );
}

/** Two people: staff coverage. */
export function CrewIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.5-3.3 2.8-5 5.5-5s5 1.7 5.5 5" />
      <path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.4c1.8.6 3 2.2 3.3 4.6" />
    </svg>
  );
}

/** Map pin for the booth map. */
export function MapPinIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z" />
      <circle cx="12" cy="10" r="2.3" />
    </svg>
  );
}

/** Scan frame for the stamp method. */
export function ScanIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M4 8.5V6a2 2 0 0 1 2-2h2.5M15.5 4H18a2 2 0 0 1 2 2v2.5M20 15.5V18a2 2 0 0 1-2 2h-2.5M8.5 20H6a2 2 0 0 1-2-2v-2.5M4 12h16" />
    </svg>
  );
}
