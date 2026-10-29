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
      <path d="M20 7v5h-5" />
      <path d="M19.1 12a7.1 7.1 0 1 1-2.08-5.02L20 9" />
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
