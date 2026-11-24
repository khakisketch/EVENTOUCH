import ProductLink from "../../../ui/ProductLink";
import TicketView from "./TicketView";
import styles from "./ticket.module.css";
import { attendeeGroundStyle, loadAttendeeTheme } from "../event-theme";
import AttendeeSurface from "../ui/AttendeeSurface";
import { attendeeLook } from "../../../../lib/attendee-look";

// Slice 3 of the frontend migration: the issued ticket. The bearer arrives
// in the address once (from registration) and the client component consumes
// it immediately, keeps it in memory, and cleans the address. Ticket state
// always comes from the server; this page never trusts the link alone.
// The pass sits on the event's own published ground and banner.
export default async function TicketPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const theme = await loadAttendeeTheme(slug);
  const look = attendeeLook(theme.homeStyle, theme.accent);
  return (
      <AttendeeSurface as="main" id="main-content" tabIndex={-1} color={look.color} mode={look.mode} ground={look.ground} className={`site-page ticket-page ${styles.ticketPage}`} style={attendeeGroundStyle(theme)}>
        <header className="public-page-header">
          <span className="compact-wordmark">EVENTOUCH</span>
          <ProductLink href={`/event/${encodeURIComponent(slug)}/home`} className={`public-return-link ${styles.returnLink}`}>← 참가자 홈으로</ProductLink>
        </header>
        <TicketView key={slug} slug={slug} theme={theme} />
      </AttendeeSurface>
  );
}
