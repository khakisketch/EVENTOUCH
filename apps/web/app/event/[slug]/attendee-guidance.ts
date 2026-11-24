// Words the attendee screens share about keeping and finding a ticket.
//
// What is true (server/attendees.js, server/api.js): signing up sets an
// HttpOnly session cookie that lasts until about 30 days after the event ends
// (90 days when no end is known, never more than 180). The ticket, home and
// engage screens send that cookie when the browser lets them keep a ticket in
// storage, so the same browser reopens the ticket in a new tab or a later
// visit. Another device or a private window has no cookie: it can only get the
// ticket back through phone verification, which some events cannot send.
// Say that once, on the ticket itself; everywhere else stay short and point to
// it. (attendee screens review, 2026-11-24)

/** The one full explanation. Shown on the ticket. */
export const TICKET_BROWSER_NOTE = "이 브라우저에서는 티켓을 다시 열 수 있습니다. 다른 기기나 시크릿 창에서는 열리지 않으니 입장 QR 화면을 캡처해 두세요.";

/** The organizer's contact when the event publishes one, otherwise the plain ask. */
export function organizerContactLine(contact: string | null | undefined, fallback = "행사 주최 측에 문의하세요."): string {
  const value = (contact ?? "").trim();
  return value ? `문의: ${value}` : fallback;
}

/** Short body for "no ticket found here" when text messages cannot reconnect it. */
export function noTicketHereNote(contact?: string | null): string {
  return `신청을 완료한 기기의 같은 브라우저에서 열어 주세요. 이 행사는 문자로 티켓을 다시 연결할 수 없습니다. ${organizerContactLine(contact)}`;
}
