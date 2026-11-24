// The contact an attendee is told to use when a ticket or a code does not
// arrive. The organizer's own "참가자 문의처" (workspace.participantContact) wins:
// it is sent with every public read, whether or not the venue guide is on.
// Without it (an older server, or a field left empty) the published venue
// contact is the fallback. A saved but hidden venue contact is not permission
// to show it in recovery UI, so that fallback still follows the same
// visibility rules as the public event page.
const PARTICIPANT_CONTACT_MAX = 200;

export function participantContactOf(workspace: unknown): string {
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return "";
  const value = (workspace as Record<string, unknown>).participantContact;
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, PARTICIPANT_CONTACT_MAX) : "";
}

export function publicRecoveryContact(workspace: unknown, features: unknown): string {
  const own = participantContactOf(workspace);
  if (own) return own;
  // Older servers may still return a stored contact when the feature is off.
  // A missing or malformed feature list cannot prove that it is public.
  if (!Array.isArray(features) || !features.includes("venue")) return "";
  if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) return "";
  const source = workspace as Record<string, unknown>;
  const experience = source.pageExperience && typeof source.pageExperience === "object" && !Array.isArray(source.pageExperience)
    ? source.pageExperience as Record<string, unknown> : {};
  const published = experience.published && typeof experience.published === "object" && !Array.isArray(experience.published)
    ? experience.published as Record<string, unknown> : {};
  if (published.showVenue === false) return "";
  const venue = source.venue && typeof source.venue === "object" && !Array.isArray(source.venue)
    ? source.venue as Record<string, unknown> : {};
  return typeof venue.contact === "string" ? venue.contact.trim() : "";
}

// Recovery may be opened directly, so it cannot assume the visitor came
// through the event page. A failed read does not invent a contact.
export async function loadPublicRecoveryContact(slug: string): Promise<string> {
  try {
    const base = process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
    const response = await fetch(`${base}/api/public/events/${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (!response.ok) return "";
    const data = await response.json() as { event?: { features?: unknown }; workspace?: unknown };
    return publicRecoveryContact(data.workspace, data.event?.features);
  } catch {
    return "";
  }
}
