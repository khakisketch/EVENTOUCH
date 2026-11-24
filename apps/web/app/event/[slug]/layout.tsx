import type { Metadata } from "next";
import type { ReactNode } from "react";
import { loadEventMetadata } from "./event-metadata";

// Every attendee page of an event (guide, application, ticket, home, engage)
// shares its name, date and banner as the link preview. The event's own data is
// the same public read the page makes, so a fetch is shared within the request.
export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  return loadEventMetadata(slug);
}

export default function EventLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
