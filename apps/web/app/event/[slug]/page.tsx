import Link from "next/link";
import type { CSSProperties } from "react";
import { notFound } from "next/navigation";
import { eventStageClassName, eventStageLabel } from "../../event-stage";
import { publicEventDate } from "../../../lib/public-event-date";
import { contrastRatio } from "../../console/event-card-theme";
import { loadVerificationMode } from "../../../lib/verification-mode";
import { publicRecoveryContact } from "../../../lib/public-recovery-contact";
import RichText from "../../ui/RichText";
import PublicProgramSchedule, { type PublicProgramScheduleItem } from "./PublicProgramSchedule";
import AddressCopyButton from "./AddressCopyButton";
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
type PublicWorkspace = {
  notices?: unknown;
  program?: unknown;
  venue?: { name?: unknown; address?: unknown; directions?: unknown; contact?: unknown; description?: unknown; map?: unknown } | null;
  registrationOpen?: unknown;
  pageExperience?: { published?: {
    intro?: unknown;
    accent?: unknown;
    showAnnouncements?: unknown;
    showSchedule?: unknown;
    showVenue?: unknown;
    showPrograms?: unknown;
    keyvisual?: { fileId?: unknown; data?: unknown } | null;
  } } | null;
  boothMap?: { published?: unknown } | null;
  booths?: unknown;
};

function keyvisualSource(slug: string, value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const image = value as Record<string, unknown>;
  const data = typeof image.data === "string" ? image.data : "";
  if (/^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return data;
  const fileId = typeof image.fileId === "string" ? image.fileId : "";
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(fileId)) return null;
  return `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`;
}

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
  const [loaded, verificationMode] = await Promise.all([
    loadEvent(slug),
    loadVerificationMode(),
  ]);
  if (!loaded) notFound();
  const { event, workspace } = loaded;
  // The recover screen itself refuses mock/none transports, so this page
  // must not advertise a recovery that ends there: device + operator
  // guidance replaces the link instead.
  const recoveryBlocked = verificationMode === "mock" || verificationMode === "none";

  const published = workspace.pageExperience?.published ?? {};
  const intro =
    text(published.intro) || "참가에 필요한 안내를 확인하세요.";
  // The page builder's visibility toggles are a promise to attendees: a
  // hidden section never renders here, it only stays editable in console.
  const showAnnouncements = published.showAnnouncements !== false;
  const showSchedule = published.showSchedule !== false;
  const showVenue = published.showVenue !== false && Array.isArray(event.features) && event.features.includes("venue");
  const showPrograms = published.showPrograms !== false;
  const accent = /^#[0-9a-f]{6}$/i.test(text(published.accent)) ? text(published.accent).toUpperCase() : "#E76D26";
  const accentStyle = {
    "--event-accent": accent,
    "--event-accent-ink": contrastRatio("#FFFFFF", accent) >= 4.5 ? "#FFFFFF" : "#000000",
  } as CSSProperties;
  const keyvisual = keyvisualSource(slug, published.keyvisual);
  const registrationOpen = workspace.registrationOpen === true;
  // The public signup writer only runs on READY/LIVE (participants writer
  // rule publicSignupEvent): an ENDED event with the intake flag still on
  // must not offer a form that can only fail. No API change: the stage
  // already ships in this payload.
  const acceptingSignup =
    registrationOpen && (event.stage === "READY" || event.stage === "LIVE");
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
  const program: PublicProgramScheduleItem[] = Array.isArray(workspace.program)
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
  const recoveryContact = publicRecoveryContact(workspace, event.features);
  const venueDescription = text(venue.description);
  const venueMap = (() => {
    const map = venue.map && typeof venue.map === "object" ? venue.map as Record<string, unknown> : null;
    const image = map?.image && typeof map.image === "object" ? map.image as Record<string, unknown> : null;
    const fileId = text(image?.fileId);
    const alt = text(map?.alt).trim();
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(fileId) || !alt) return null;
    return { alt, src: `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}` };
  })();
  const hasVenue = Boolean(venueName || venueAddress || venueDirections || venueContact || venueDescription || venueMap);
  const date = publicEventDate(event.date);
  // Published booth map only: draft placements never surface here.
  const boothMap = (() => {
    const source = workspace.boothMap as { published?: unknown } | undefined;
    const published = source && typeof source === "object" ? source.published : null;
    if (!published || typeof published !== "object") return null;
    const map = published as Record<string, unknown>;
    const image = map.image && typeof map.image === "object" ? (map.image as Record<string, unknown>) : null;
    if (!image || typeof image.fileId !== "string") return null;
    const width = Number(image.width);
    const height = Number(image.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) return null;
    const points = Array.isArray(map.points)
      ? map.points.flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const point = item as Record<string, unknown>;
          const x = Number(point.x);
          const y = Number(point.y);
          if (typeof point.boothId !== "string" || !Number.isFinite(x) || !Number.isFinite(y)) return [];
          return [{ boothId: point.boothId, x, y }];
        })
      : [];
    const booths = Array.isArray(workspace.booths)
      ? workspace.booths.flatMap((item) => {
          if (typeof item !== "object" || item === null) return [];
          const booth = item as Record<string, unknown>;
          if (typeof booth.id !== "string") return [];
          return [{ id: booth.id, name: text(booth.name) }];
        })
      : [];
    return { fileId: image.fileId, points, booths };
  })();
  const publicSections = [
    showAnnouncements && notices.length ? { id: "public-notices", label: "공지" } : null,
    showPrograms && program.length ? { id: "public-program", label: "프로그램" } : null,
    boothMap ? { id: "public-booth-map", label: "부스 지도" } : null,
    showVenue && hasVenue ? { id: "public-venue", label: "오시는 길" } : null,
  ].filter((section): section is { id: string; label: string } => Boolean(section));

  return (
    <main id="main-content" tabIndex={-1} className={`site-page public-event-page ${styles.page}`} style={accentStyle}>
      <header className={`public-page-header ${styles.masthead}`}>
        <span className="compact-wordmark">EVENTOUCH</span>
        <span className="eyebrow">행사 안내</span>
      </header>
      <section className={`event-intro ${styles.hero} ${keyvisual ? styles.heroWithImage : styles.heroNoImage}`} aria-labelledby="public-event-title">
        {keyvisual ? (
          <div className={styles.artwork}>
            {/* The published event image is kept intact without cropping. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className={styles.keyvisual} src={keyvisual} alt="" fetchPriority="high" />
          </div>
        ) : null}
        <div className={styles.heroCopy}>
          <h1 className={styles.eventTitle} id="public-event-title">{event.name}</h1>
          <p className={styles.introLine}>{intro}</p>
        </div>
        <div className={styles.heroInfo}>
          <dl className={`event-facts ${styles.facts}`}>
            {showSchedule ? (
              <div className={`event-fact ${styles.fact}`}>
                <dt>일시</dt>
                <dd>
                  <time dateTime={date?.dateTime}>{date?.label ?? event.date}</time>
                  {event.start ? <span className={styles.clock}>{event.start}{event.end ? `–${event.end}` : ""}</span> : null}
                </dd>
              </div>
            ) : null}
            {showVenue && (venueName || venueAddress) ? (
              <div className={`event-fact ${styles.fact}`}><dt>장소</dt><dd>{venueName || venueAddress}</dd></div>
            ) : null}
            <div className={`event-fact ${styles.fact}`}>
              <dt>진행 상태</dt>
              <dd><span className={eventStageClassName(event.stage)}>{eventStageLabel(event.stage)}</span></dd>
            </div>
          </dl>
          <div className={styles.cta}>
            <div className={styles.actionGroup}>
              {acceptingSignup ? (
                <Link className={`button button-primary ${styles.primaryAction}`} href={`/event/${encodeURIComponent(slug)}/register`}>참가 신청하기</Link>
              ) : (
                <p className={styles.registrationClosed} role="status">현재 신청을 받지 않습니다.</p>
              )}
              {!recoveryBlocked ? (
                <Link className={`button ${acceptingSignup ? "button-secondary" : "button-primary"} ${!acceptingSignup ? styles.primaryAction : ""} ${styles.recoveryLink}`} href={`/event/${encodeURIComponent(slug)}/ticket/recover`}>이미 신청했다면 내 티켓 찾기</Link>
              ) : null}
              <Link className={`button button-secondary ${styles.homeLink}`} href={`/event/${encodeURIComponent(slug)}/home`}>참가자 홈</Link>
            </div>
            {recoveryBlocked ? (
              <details className={styles.recoveryDetails}>
                <summary data-disclosure-indicator>이미 신청하셨나요?</summary>
                <p className={styles.recoveryNote} role="note">이미 신청했다면 신청을 완료한 브라우저 탭에서 티켓을 여세요. 이 행사는 문자로 다시 연결할 수 없습니다. {recoveryContact ? `문의: ${recoveryContact}` : "탭을 찾을 수 없다면 행사 초대 안내를 확인하거나 행사 주최 측에 문의하세요."}</p>
              </details>
            ) : null}
          </div>
        </div>
        {publicSections.length ? (
          <nav className={styles.sectionNav} aria-label="행사 안내 바로가기">
            {publicSections.map((section) => <Link key={section.id} href={`#${section.id}`}>{section.label}</Link>)}
          </nav>
        ) : null}
      </section>

      {showAnnouncements && notices.length ? (
        <section className={styles.section} aria-labelledby="public-notices">
          <h2 id="public-notices">공지</h2>
          <ul className={styles.noticeList}>
            {notices.map((notice) => (
              <li key={notice.id}>
                <h3>
                  {notice.pinned ? <span className={styles.pin}>고정</span> : null}
                  {notice.title}
                </h3>
                {notice.body ? <RichText source={notice.body} imageSrc={(fileId) => `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {showPrograms && program.length ? (
        <section className={styles.section} aria-labelledby="public-program">
          <h2 id="public-program">프로그램</h2>
          <PublicProgramSchedule program={program} eventDate={showSchedule ? event.date : ""} />
        </section>
      ) : null}

      {boothMap ? (
        <section className={styles.section} aria-labelledby="public-booth-map">
          <h2 id="public-booth-map">부스 지도</h2>
          <div className={styles.mapWrap}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className={styles.mapImage}
              src={`/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(boothMap.fileId)}`}
              alt="행사장 부스 배치도"
              loading="lazy"
            />
            {boothMap.points.map((point) => {
              const booth = boothMap.booths.find((item) => item.id === point.boothId);
              if (!booth) return null;
              return (
                <span
                  key={point.boothId}
                  className={styles.mapPoint}
                  style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}
                >
                  {booth.name}
                </span>
              );
            })}
          </div>
        </section>
      ) : null}

      {showVenue && hasVenue ? (
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
                <dd className={styles.addressRow}>
                  <AddressCopyButton address={venueAddress} />
                </dd>
              </div>
            ) : null}
            {venueDirections ? (
              <div className="event-fact">
                <dt>오시는 길</dt>
                <dd className={styles.venueText}>{venueDirections}</dd>
              </div>
            ) : null}
            {venueDescription ? (
              <div className="event-fact">
                <dt>행사장 안내</dt>
                <dd className={styles.venueText}>{venueDescription}</dd>
              </div>
            ) : null}
            {venueContact ? (
              <div className="event-fact">
                <dt>문의</dt>
                <dd>{venueContact}</dd>
              </div>
            ) : null}
          </dl>
          {venueMap ? <figure className={styles.venueMap}>
            {/* A normal image/link preserves zoom and the browser's download controls. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={venueMap.src} alt={venueMap.alt} />
            <figcaption><Link className="button button-secondary" href={venueMap.src} target="_blank" rel="noopener noreferrer">안내도 크게 보기 (새 탭)</Link></figcaption>
          </figure> : null}
        </section>
      ) : null}

    </main>
  );
}
