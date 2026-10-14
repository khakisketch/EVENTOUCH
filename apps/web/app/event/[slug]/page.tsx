import { notFound } from "next/navigation";
import { eventStageClassName, eventStageLabel } from "../../event-stage";

type PublicEvent = {
  id: string;
  slug: string;
  name: string;
  date: string;
  start: string;
  end: string;
  capacity: number;
  stage: string;
  features: string[];
};

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

async function loadEvent(slug: string): Promise<PublicEvent | null> {
  const res = await fetch(
    `${apiBase()}/api/public/events/${encodeURIComponent(slug)}`,
    { cache: "no-store" }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`행사 정보를 불러오지 못했습니다 (${res.status})`);
  const data = (await res.json()) as { event?: PublicEvent | null };
  return data.event ?? null;
}

export default async function EventPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const event = await loadEvent(slug);
  if (!event) notFound();
  return (
    <main id="main-content" className="site-page public-event-page">
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <span className="eyebrow">행사 안내</span>
      </header>
      <section className="event-intro">
        <h1>{event.name}</h1>
        <dl className="event-facts">
        <div className="event-fact">
          <dt>일정</dt>
          <dd>
            {event.date}
            {event.start ? ` ${event.start}` : ""}
            {event.end ? ` ~ ${event.end}` : ""}
          </dd>
        </div>
        <div className="event-fact">
          <dt>진행 상태</dt>
          <dd><span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span></dd>
        </div>
        </dl>
      </section>
      <footer className="public-page-footer">EVENTOUCH <span>행사 안내</span></footer>
    </main>
  );
}
