// Local icons for the staff field screen (the shared console icon file is off
// limits for this screen's redesign). Same 24-grid round-cap stroke family.

type IconProps = { className?: string };

function svgProps(className?: string) {
  return { className: ["action-icon", className].filter(Boolean).join(" "), "aria-hidden": true as const, focusable: "false" as const, viewBox: "0 0 24 24" };
}

export function CameraIcon({ className }: IconProps) {
  return (
    <svg {...svgProps(className)}>
      <path d="M4 8.5A2.5 2.5 0 0 1 6.5 6h1.2l1.3-2h6l1.3 2h1.2A2.5 2.5 0 0 1 20 8.5v8a2.5 2.5 0 0 1-2.5 2.5h-11A2.5 2.5 0 0 1 4 16.5z" />
      <circle cx="12" cy="12.5" r="3.4" />
    </svg>
  );
}
