import type { Metadata } from "next";
import ArriveView from "./ArriveView";
import styles from "./arrive.module.css";
import { attendeeGroundStyle, loadAttendeeTheme } from "../event-theme";
import AttendeeSurface from "../ui/AttendeeSurface";
import { attendeeLook } from "../../../../lib/attendee-look";

// The page a desk poster's QR opens (owner decision 2026-11-25): one button for the browser
// that signed up, name and phone otherwise, or on to the application. Everything about the
// person comes from the server; this page never decides who has arrived.
export const metadata: Metadata = { robots: { index: false } };

export default async function ArrivePage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ desk?: string | string[] }>;
}) {
  const { slug } = await params;
  const desk = (await searchParams).desk;
  const deskId = typeof desk === "string" && /^[A-Za-z0-9_-]{1,120}$/.test(desk) ? desk : "";
  const theme = await loadAttendeeTheme(slug);
  const look = attendeeLook(theme.homeStyle, theme.accent);
  return (
    <AttendeeSurface as="main" id="main-content" tabIndex={-1} color={look.color} mode={look.mode} ground={look.ground} className={`site-page ${styles.page}`} style={attendeeGroundStyle(theme)}>
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <p className={styles.pageContext}>입장 접수</p>
      </header>
      <ArriveView key={`${slug}:${deskId}`} slug={slug} deskId={deskId} />
    </AttendeeSurface>
  );
}
