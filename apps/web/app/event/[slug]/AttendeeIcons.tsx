// Small line icons of the attendee phone screens (ticket, application,
// engagement). They are decoration: every one is hidden from assistive
// technology, the words beside it carry the meaning.
export type AttendeeIconName =
  | "calendar" | "pin" | "ticket" | "check" | "clock" | "sun" | "arrow" | "info"
  | "poll" | "quiz" | "survey" | "qa" | "photo" | "board" | "draw" | "user" | "refresh" | "shield" | "qr"
  // Added with the attendee design-system foundation (2026-11-20).
  | "gift" | "chat" | "vote" | "chevron" | "alert";

export default function AttendeeIcon({ name, size = 20 }: { name: AttendeeIconName; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
    focusable: false as const,
  };
  switch (name) {
    case "calendar":
      return <svg {...common}><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M8 3v4M16 3v4M3.5 10h17" /></svg>;
    case "pin":
      return <svg {...common}><path d="M12 21s7-6.2 7-11.5a7 7 0 0 0-14 0C5 14.8 12 21 12 21Z" /><circle cx="12" cy="9.5" r="2.5" /></svg>;
    case "ticket":
      return <svg {...common}><path d="M4 8a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v2a2 2 0 0 0 0 4v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-2a2 2 0 0 0 0-4V8Z" /><path d="M14 6v12" strokeDasharray="2 3" /></svg>;
    case "check":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></svg>;
    case "clock":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></svg>;
    case "sun":
      return <svg {...common}><circle cx="12" cy="12" r="4" /><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" /></svg>;
    case "arrow":
      return <svg {...common}><path d="M5 12h14M13 6l6 6-6 6" /></svg>;
    case "info":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></svg>;
    case "poll":
      return <svg {...common}><path d="M5 20V10M12 20V4M19 20v-7" /></svg>;
    case "quiz":
      return <svg {...common}><circle cx="12" cy="12" r="9" /><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.7.4-1 .9-1 1.7M12 17h.01" /></svg>;
    case "survey":
      return <svg {...common}><rect x="5" y="3.5" width="14" height="17" rx="2.5" /><path d="M9 9h6M9 13h6M9 17h3" /></svg>;
    case "qa":
      return <svg {...common}><path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-6l-4 4v-4H6a2 2 0 0 1-2-2V6Z" /></svg>;
    case "photo":
      return <svg {...common}><rect x="3" y="6" width="18" height="14" rx="3" /><circle cx="12" cy="13" r="3.5" /><path d="M8.5 6 10 3.5h4L15.5 6" /></svg>;
    case "board":
      return <svg {...common}><path d="M5 4h14v12H9l-4 4V4Z" /><path d="M9 8.5h6M9 12h4" /></svg>;
    case "draw":
      return <svg {...common}><path d="M12 3l2.5 5.5L20 9l-4 4 1 6-5-3-5 3 1-6-4-4 5.5-.5L12 3Z" /></svg>;
    case "user":
      return <svg {...common}><circle cx="12" cy="8" r="4" /><path d="M4.5 20a7.5 7.5 0 0 1 15 0" /></svg>;
    case "refresh":
      return <svg {...common}><path d="M20 12a8 8 0 0 1-14 5.3M4 12a8 8 0 0 1 14-5.3" /><path d="M18.5 3v4h-4M5.5 21v-4h4" /></svg>;
    case "shield":
      return <svg {...common}><path d="M12 3 5 6v5.5c0 4.2 2.8 7.5 7 9.5 4.2-2 7-5.3 7-9.5V6l-7-3Z" /><path d="m9 12 2.2 2.2L15.5 10" /></svg>;
    case "qr":
      return <svg {...common}><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><path d="M14 14h2.5v2.5M20 14v.01M14 20h.01M17 20h3v-3.5" /></svg>;
    case "gift":
      return <svg {...common}><rect x="4" y="11" width="16" height="9" rx="2" /><rect x="3" y="7.5" width="18" height="3.5" rx="1.5" /><path d="M12 7.5V20M12 7.5C10 3.5 6.5 4.5 7.5 6.5c.6 1.1 2.7 1 4.5 1Zm0 0c2-4 5.5-3 4.5-1-.6 1.1-2.7 1-4.5 1Z" /></svg>;
    case "chat":
      return <svg {...common}><path d="M20 12a8 8 0 0 1-11.7 7.1L4 20l1-3.9A8 8 0 1 1 20 12Z" /><path d="M9 11h6M9 14h3.5" /></svg>;
    case "vote":
      return <svg {...common}><path d="M4 14h16v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-5Z" /><path d="M8 14V5.5A1.5 1.5 0 0 1 9.5 4h5A1.5 1.5 0 0 1 16 5.5V14" /><path d="m10 9 1.5 1.5L14 7.5" /></svg>;
    case "chevron":
      return <svg {...common}><path d="m9 6 6 6-6 6" /></svg>;
    case "alert":
      return <svg {...common}><path d="M12 3.5 21.5 20h-19L12 3.5Z" /><path d="M12 10v4.5M12 17.5h.01" /></svg>;
  }
}
