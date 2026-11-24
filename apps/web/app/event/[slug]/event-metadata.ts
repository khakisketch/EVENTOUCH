import type { Metadata } from "next";
import { configuredPublicBase } from "../../../lib/public-origin";
import { readPublicEventContext } from "../../../lib/public-event-context";
import { asRecord } from "../../../lib/json-guards";
import { readAttendeeTheme } from "./event-theme";

// Link-preview tags for an event's attendee pages (카카오톡·문자·메신저). Until
// 2026-11-24 every attendee page said "EVENTOUCH"; a shared signup link now
// carries the event's own name, when and where, and its banner picture.
//
// Public projection only: the same fields the page itself renders, honoring the
// page's own show/hide switches (a hidden date or venue never reaches a tag).

const SITE_NAME = "EVENTOUCH";

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

/** "2026-11-24" -> "11월 24일"; anything else -> "". */
export function eventMonthDay(date: string): string {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return "";
  return `${Number(match[1])}월 ${Number(match[2])}일`;
}

/**
 * The banner as a share image: only a file of this event (an inline data picture
 * is not a URL a crawler can load) and only while the banner is a picture. The
 * result is relative; metadataBase (EVENTOUCH_PUBLIC_URL) makes it absolute.
 */
export function shareImagePath(slug: string, workspace: unknown, base: string | null): string | null {
  if (!base) return null;
  const theme = readAttendeeTheme(slug, workspace);
  if (theme.homeStyle.bannerKind !== "image" || !theme.keyvisual) return null;
  const prefix = `/api/public/events/${encodeURIComponent(slug)}/files/`;
  return theme.keyvisual.startsWith(prefix) ? theme.keyvisual : null;
}

export function buildEventMetadata(slug: string, payload: unknown, base: string | null = configuredPublicBase()): Metadata {
  const source = asRecord(payload);
  const event = asRecord(source?.event);
  const name = typeof event?.name === "string" ? event.name.trim() : "";
  if (!event || !name) return {};
  const workspace = source?.workspace;
  const context = readPublicEventContext(event, workspace);
  const monthDay = context.date ? eventMonthDay(typeof event.date === "string" ? event.date : "") : "";
  const title = `${name} · ${monthDay ? `${monthDay} ` : ""}참가 신청`;
  const when = [context.date, context.time].filter(Boolean).join(" ");
  const description = [when, context.place].filter(Boolean).join(" · ") || `${name} 참가 신청과 행사 안내`;
  const image = shareImagePath(slug, workspace, base);
  return {
    title,
    description,
    openGraph: {
      title: name,
      description,
      siteName: SITE_NAME,
      locale: "ko_KR",
      type: "website",
      // No picture: leave images unset so the segment's own default card (opengraph-image) is used.
      ...(image ? { images: [{ url: image, alt: name }] } : {}),
    },
    twitter: { card: "summary_large_image", title: name, description },
  };
}

/** A failed or missing event keeps the product's general title. */
export async function loadEventMetadata(slug: string): Promise<Metadata> {
  try {
    const response = await fetch(`${apiBase()}/api/public/events/${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (!response.ok) return {};
    return buildEventMetadata(slug, await response.json());
  } catch {
    return {};
  }
}
