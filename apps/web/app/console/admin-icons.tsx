// 준비·관리 콘솔(행사 목록, 메시지, 공지·안내, 참여 콘텐츠, 설정, 고객사, 팀)이 함께 쓰는
// 보조 아이콘. 공용 ConsoleIcons와 같은 24칸 선 아이콘이며 장식용이라 보조기기에서는 숨긴다.
// 공용 파일을 건드리지 않으려고 이 폴더에 둔다.

type IconProps = { className?: string };

function cls(className?: string): string {
  return ["action-icon", className].filter(Boolean).join(" ");
}

export function FilterIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M4 7h10m4 0h2M4 17h2m4 0h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </svg>
  );
}

export function CalendarIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <rect x="4" y="5.5" width="16" height="14.5" rx="2" />
      <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
    </svg>
  );
}

export function RowsIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M9 7h11M9 12h11M9 17h11" />
      <circle cx="5" cy="7" r="1" />
      <circle cx="5" cy="12" r="1" />
      <circle cx="5" cy="17" r="1" />
    </svg>
  );
}

export function UsersIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <circle cx="9" cy="8.5" r="3.2" />
      <path d="M3.5 19c.5-3.3 2.8-5 5.5-5s5 1.7 5.5 5" />
      <path d="M15.5 5.6a3 3 0 0 1 0 5.8M17.5 14.3c1.7.6 2.8 2.2 3 4.7" />
    </svg>
  );
}

export function MessageIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M5 5h14a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 17h-8l-4.5 3.5V17H5a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 5 5z" />
    </svg>
  );
}

export function BuildingIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M5 20V5.5A1.5 1.5 0 0 1 6.5 4h7A1.5 1.5 0 0 1 15 5.5V20M15 10h3.5A1.5 1.5 0 0 1 20 11.5V20M3.5 20h17" />
      <path d="M8.5 8h3M8.5 12h3M8.5 16h3" />
    </svg>
  );
}

export function ShieldIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 3.5 19 6v5.5c0 4.2-2.8 7.4-7 9-4.2-1.600-7-4.800-7-9V6z" />
      <path d="m9 12 2.200 2.200L15.200 10" />
    </svg>
  );
}

export function MapPinIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 21s6.500-5.700 6.500-11a6.500 6.500 0 0 0-13 0c0 5.300 6.500 11 6.500 11z" />
      <circle cx="12" cy="10" r="2.300" />
    </svg>
  );
}

export function MegaphoneIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M4 10v4a1 1 0 0 0 1 1h2.500l7 4V5l-7 4H5a1 1 0 0 0-1 1z" />
      <path d="M18 9.500a3.500 3.500 0 0 1 0 5" />
    </svg>
  );
}

export function SparkIcon({ className }: IconProps) {
  return (
    <svg className={cls(className)} aria-hidden="true" focusable="false" viewBox="0 0 24 24">
      <path d="M12 3.500 13.800 9l5.700 1.800-5.700 1.800L12 18.500l-1.800-5.900-5.700-1.800L10.200 9z" />
    </svg>
  );
}
