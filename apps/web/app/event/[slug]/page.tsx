import Link from "next/link";
import { notFound } from "next/navigation";
import { eventStageClassName, eventStageLabel } from "../../event-stage";
import styles from "./public-event.module.css";

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

type Notice = { id: string; title: string; body: string; pinned?: boolean };
type ProgramItem = {
  id: string;
  title: string;
  date: string;
  start: string;
  end: string;
  place: string;
  speaker?: string;
  speakers?: string[];
  description: string;
};
type PublicWorkspace = {
  notices?: unknown;
  program?: unknown;
  venue?: { name?: unknown; address?: unknown; directions?: unknown; contact?: unknown } | null;
  registrationOpen?: unknown;
  pageExperience?: { published?: { intro?: unknown } } | null;
};

function apiBase(): string {
  return process.env.EVENTOUCH_API_URL ?? "http://127.0.0.1:8776";
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function loadEvent(slug: string): Promise<{
  event: PublicEvent;
  workspace: PublicWorkspace;
} | null> {
  const res = await fetch(
    `${apiBase()}/api/public/events/${encodeURIComponent(slug)}`,
    { cache: "no-store" }
  );
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`행사 정보를 불러오지 못했습니다 (${res.status})`);
  const data = (await res.json()) as {
    event?: PublicEvent | null;
    workspace?: PublicWorkspace | null;
  };
  if (!data.event) return null;
  return { event: data.event, workspace: data.workspace ?? {} };
}

export default async function EventPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const loaded = await loadEvent(slug);
  if (!loaded) notFound();
  const { event, workspace } = loaded;

  const intro =
    text(workspace.pageExperience?.published?.intro) || "참가에 필요한 안내를 확인하세요.";
  const registrationOpen = workspace.registrationOpen === true;
  const notices: Notice[] = Array.isArray(workspace.notices)
    ? workspace.notices.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const notice = item as Record<string, unknown>;
        if (typeof notice.title !== "string") return [];
        return [{
          id: text(notice.id),
          title: notice.title,
          body: text(notice.body),
          pinned: notice.pinned === true,
        }];
      })
    : [];
  const program: ProgramItem[] = Array.isArray(workspace.program)
    ? workspace.program.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const session = item as Record<string, unknown>;
        if (typeof session.title !== "string") return [];
        return [{
          id: text(session.id),
          title: session.title,
          date: text(session.date),
          start: text(session.start),
          end: text(session.end),
          place: text(session.place),
          speaker: text(session.speaker),
          speakers: Array.isArray(session.speakers)
            ? session.speakers.filter((name): name is string => typeof name === "string")
            : [],
          description: text(session.description),
        }];
      })
    : [];
  const venue = workspace.venue ?? {};
  const venueName = text(venue.name);
  const venueAddress = text(venue.address);
  const venueDirections = text(venue.directions);
  const venueContact = text(venue.contact);
  const hasVenue = Boolean(venueName || venueAddress || venueDirections || venueContact);

  return (
    <main id="main-content" className="site-page public-event-page">
      <header className="public-page-header">
        <span className="compact-wordmark">EVENTOUCH</span>
        <span className="eyebrow">행사 안내</span>
      </header>
      <section className="event-intro">
        <h1>{event.name}</h1>
        <p className={styles.introLine}>{intro}</p>
        <dl className="event-facts">
          <div className="event-fact">
            <dt>일정</dt>
            <dd>
              {event.date}
              {event.start ? ` ${event.start}` : ""}
              {event.end ? ` ~ ${event.end}` : ""}
            </dd>
          </div>
          {venueName ? (
            <div className="event-fact">
              <dt>장소</dt>
              <dd>{venueName}</dd>
            </div>
          ) : null}
          <div className="event-fact">
            <dt>진행 상태</dt>
            <dd><span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span></dd>
          </div>
        </dl>
        {registrationOpen ? (
          <p className={styles.cta}>
            <Link
              className="button button-primary"
              href={`/event/${encodeURIComponent(slug)}/register`}
            >
              참가 신청하기
            </Link>
          </p>
        ) : (
          <p className="notice" role="status">현재 신청을 받지 않습니다.</p>
        )}
      </section>

      {notices.length ? (
        <section className={styles.section} aria-labelledby="public-notices">
          <h2 id="public-notices">공지</h2>
          <ul className={styles.noticeList}>
            {notices.map((notice) => (
              <li key={notice.id}>
                <h3>
                  {notice.pinned ? <span className={styles.pin} aria-label="고정 공지">📌</span> : null}
                  {notice.title}
                </h3>
                {notice.body ? <p className="preserve-lines">{notice.body}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {program.length ? (
        <section className={styles.section} aria-labelledby="public-program">
          <h2 id="public-program">프로그램</h2>
          <ul className={styles.programList}>
            {program.map((session) => (
              <li key={session.id}>
                <h3>{session.title}</h3>
                <p className={styles.programMeta}>
                  {[
                    session.date,
                    session.start && session.end
                      ? `${session.start} ~ ${session.end}`
                      : session.start,
                    session.place,
                  ].filter(Boolean).join(" · ")}
                </p>
                {session.speaker || (session.speakers && session.speakers.length) ? (
                  <p className={styles.programSpeaker}>
                    {[session.speaker, ...(session.speakers ?? [])].filter(Boolean).join(" · ")}
                  </p>
                ) : null}
                {session.description ? <p>{session.description}</p> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {hasVenue ? (
        <section className={styles.section} aria-labelledby="public-venue">
          <h2 id="public-venue">오시는 길</h2>
          <dl className="event-facts">
            {venueName ? (
              <div className="event-fact">
                <dt>장소</dt>
                <dd>{venueName}</dd>
              </div>
            ) : null}
            {venueAddress ? (
              <div className="event-fact">
                <dt>주소</dt>
                <dd>{venueAddress}</dd>
              </div>
            ) : null}
            {venueDirections ? (
              <div className="event-fact">
                <dt>안내</dt>
                <dd className="preserve-lines">{venueDirections}</dd>
              </div>
            ) : null}
            {venueContact ? (
              <div className="event-fact">
                <dt>문의</dt>
                <dd>{venueContact}</dd>
              </div>
            ) : null}
          </dl>
        </section>
      ) : null}

      <footer className="public-page-footer">EVENTOUCH <span>행사 안내</span></footer>
    </main>
  );
}
