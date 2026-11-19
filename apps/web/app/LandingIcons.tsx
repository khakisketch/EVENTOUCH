const PATHS = {
  notice: "M5 4h14v13H9l-4 3V4Zm4 4h6M9 11.5h4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13.5V12l3 2",
  pin: "M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21Zm0-8.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z",
  spark: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3Zm7 12l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z",
  vote: "M5 20V10m7 10V4m7 16v-7",
  gift: "M4 10h16v10H4V10Zm-1-4h18v4H3V6Zm9 0v14M12 6c-1.5-3-5-3-5-1s3.5 2 5 1Zm0 0c1.5-3 5-3 5-1s-3.5 2-5 1Z",
  users: "M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm-6 9c0-3.3 2.7-6 6-6s6 2.7 6 6m1-9.2a3 3 0 1 0 0-5.6M17 14.2c2.3.5 4 2.5 4 5.8",
  qr: "M4 4h6v6H4V4Zm10 0h6v6h-6V4ZM4 14h6v6H4v-6Zm10 0h2v2h-2v-2Zm4 0h2v2h-2v-2Zm-4 4h2v2h-2v-2Zm4 0h2v2h-2v-2Z",
  chart: "M4 20h16M7 16V11m5 5V6m5 10v-7",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12M18 6L6 18",
  seminar: "M3 5h18v11H3V5Zm6 15h6m-3-4v4M8 9h8M8 12h5",
  door: "M6 21V4h9l3 2v15M6 21H4m14 0h2M12 12.5v.01",
  repeat: "M17 4l3 3-3 3M4 11V9a2 2 0 0 1 2-2h14M7 20l-3-3 3-3m13-1v2a2 2 0 0 1-2 2H4",
  mail: "M3 6h18v12H3V6Zm0 1 9 7 9-7",
  setup: "M12 3v3m0 12v3M3 12h3m12 0h3M5.6 5.6l2.1 2.1m8.6 8.6 2.1 2.1m0-12.8-2.1 2.1M7.7 16.3l-2.1 2.1M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
  play: "M8 5l11 7-11 7V5Z",
} as const;

export type LandingIconName = keyof typeof PATHS;

export function LandingIcon({ name, size = 20 }: { name: LandingIconName; size?: number }) {
  return (
    <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d={PATHS[name]} />
    </svg>
  );
}
