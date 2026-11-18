// Shared console action icons: one authored stroke family for the recurring
// operator actions (menu, copy, jump, edit, add/remove/clear). 24-grid,
// currentColor stroke, round caps — the same voice as the rail nav icons.
// Decorative SVGs are hidden from assistive technology. Actions either pair
// an icon with visible Korean text or provide a specific accessible name
// when surrounding context makes an icon-only control appropriate.

type IconProps = {
  className?: string;
};

function baseClass(className?: string): string {
  return ["action-icon", className].filter(Boolean).join(" ");
}

export function SearchIcon() {
  return (
    <svg className={baseClass()} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.4 15.4 4.6 4.6" />
    </svg>
  );
}

export function BarsIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path className="bar-top" d="M4 7.5h16" />
      <path className="bar-mid" d="M4 12h16" />
      <path className="bar-bot" d="M4 16.5h16" />
    </svg>
  );
}

export function CopyIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V6a2 2 0 0 1 2-2h9" />
    </svg>
  );
}

export function ExternalLinkIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M14 4h6v6" />
      <path d="M20 4l-9 9" />
      <path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" />
    </svg>
  );
}

export function CheckIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

export function ArrowDownIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 4.5v15m0 0l-5.5-5.5M12 19.5l5.5-5.5" />
    </svg>
  );
}

export function ArrowUpIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 19.5v-15m0 0L6.5 10M12 4.5l5.5 5.5" />
    </svg>
  );
}

export function PencilIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M14.5 5.5l4 4L8 20H4v-4L14.5 5.5z" />
      <path d="M12.5 7.5l4 4" />
    </svg>
  );
}

export function PlusIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

export function MinusIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M5 12h14" />
    </svg>
  );
}

export function XIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

export function ListIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M4 6.5h2M4 12h2M4 17.5h2M9 6.5h11M9 12h11M9 17.5h11" />
    </svg>
  );
}

export function RefreshIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M20 5v5h-5M20 10a8 8 0 1 0 .2 4" />
    </svg>
  );
}

export function ArrowRightIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M5 12h14m-6-6 6 6-6 6" />
    </svg>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

export function MoreIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <circle cx="5" cy="12" r="1.4" />
      <circle cx="12" cy="12" r="1.4" />
      <circle cx="19" cy="12" r="1.4" />
    </svg>
  );
}

export function BackIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M14.5 5.5L8 12l6.5 6.5" />
    </svg>
  );
}

export function DownloadIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 4v11m0 0l-4-4m4 4l4-4" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function UploadIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 20V9m0 0l-4 4m4-4l4 4" />
      <path d="M5 20h14" />
    </svg>
  );
}

export function DocumentIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </svg>
  );
}

export function PrinterIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M6 9V3h12v6" />
      <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
      <rect x="6" y="14" width="12" height="7" />
    </svg>
  );
}

export function BangIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 6v8" />
      <path d="M12 18v.5" />
    </svg>
  );
}

export function InfoIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 11v6" />
      <path d="M12 7v.5" />
    </svg>
  );
}

export function KeyIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
    </svg>
  );
}

export function GiftIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <rect x="4" y="9" width="16" height="11" rx="1" />
      <path d="M12 9v11M3 9h18M12 9c-2-4-6-3-5 0M12 9c2-4 6-3 5 0" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg className={baseClass(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </svg>
  );
}
