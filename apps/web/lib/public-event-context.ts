import { publicEventDate } from "./public-event-date";

export type PublicEventContext = {
  date: string;
  dateTime: string;
  time: string;
  place: string;
  hasVenueGuide: boolean;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function validTime(value: string): string {
  return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : "";
}

export function readPublicEventContext(
  rawEvent: unknown,
  rawWorkspace: unknown,
): PublicEventContext {
  const event = record(rawEvent);
  const workspace = record(rawWorkspace);
  const published = record(record(workspace.pageExperience).published);
  const venue = record(workspace.venue);
  const features = Array.isArray(event.features) ? event.features : [];
  const scheduleVisible = published.showSchedule !== false;
  const venueVisible = features.includes("venue") && published.showVenue !== false;
  const date = scheduleVisible ? publicEventDate(text(event.date)) : null;
  const start = scheduleVisible ? validTime(text(event.start)) : "";
  const end = scheduleVisible ? validTime(text(event.end)) : "";
  const map = record(venue.map);
  const mapImage = record(map.image);
  const hasPublishedMap =
    typeof mapImage.fileId === "string" &&
    /^[A-Za-z0-9_-]{1,160}$/.test(mapImage.fileId) &&
    Boolean(text(map.alt));
  const hasVenueGuide = venueVisible && Boolean(
    text(venue.name) ||
    text(venue.address) ||
    text(venue.directions) ||
    text(venue.contact) ||
    text(venue.description) ||
    hasPublishedMap
  );

  return {
    date: date?.label ?? "",
    dateTime: date?.dateTime ?? "",
    time: start ? `${start}${end ? `–${end}` : ""}` : "",
    place: venueVisible ? text(venue.name) || text(venue.address) : "",
    hasVenueGuide,
  };
}
