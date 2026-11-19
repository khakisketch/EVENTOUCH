import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";
import { notFound } from "next/navigation";
import { eventStageLabel } from "../../event-stage";
import { normalizeHomeStyle, parseHomePhotos, readableInk } from "../../../lib/attendee-home";
import { homeSurfaceStyle } from "../../../lib/home-surface";
import { publicEventDate } from "../../../lib/public-event-date";
import { loadVerificationMode } from "../../../lib/verification-mode";
import { publicRecoveryContact } from "../../../lib/public-recovery-contact";
import ProductLink from "../../ui/ProductLink";
import RichText from "../../ui/RichText";
import HomeHero from "./home/HomeHero";
import homeStyles from "./home/home.module.css";
import L from "./home/home-layouts.module.css";
import GuideIcon, { type GuideIconType } from "./GuideIcon";
import PublicProgramSchedule, { type PublicProgramScheduleItem } from "./PublicProgramSchedule";
import AddressCopyButton from "./AddressCopyButton";
import TabTicketChoice from "./TabTicketChoice";
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
    defaultHomeBanner?: unknown;
    homeStyle?: unknown;
  } } | null;
  photos?: unknown;
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

// "D-58" / "오늘" for an upcoming event day, in Korea Standard Time. Past events
// say nothing: their stage chip already does.
function ddayLabel(date: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "";
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000);
  if (!Number.isFinite(days)) return "";
  return days === 0 ? "오늘" : days > 0 ? `D-${days}` : "";
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
  // The guide wears the design the agency chose for the attendee home: the same
  // banner, ground color, tone and composition. A photo-first home with no
  // approved photos reads as the tile home, so the guide does too.
  const homeStyle = normalizeHomeStyle(published.homeStyle);
  const defaultHomeBanner = published.defaultHomeBanner === "neutral" ? "neutral" : "legacy";
  const photos = Array.isArray(event.features) && event.features.includes("photo")
    ? parseHomePhotos(workspace.photos, (fileId) => `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`)
    : [];
  const layout = homeStyle.layout === "instagram" && !photos.length ? "tile" : homeStyle.layout;
  const rootStyle = { "--lay-ink": readableInk(homeStyle.backgroundColor) } as CSSProperties;
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
    showAnnouncements && notices.length ? { id: "public-notices", label: "공지", icon: "notice" as GuideIconType } : null,
    showPrograms && program.length ? { id: "public-program", label: "프로그램", icon: "program" as GuideIconType } : null,
    boothMap ? { id: "public-booth-map", label: "부스 지도", icon: "map" as GuideIconType } : null,
    showVenue && hasVenue ? { id: "public-venue", label: "오시는 길", icon: "venue" as GuideIconType } : null,
  ].filter((section): section is { id: string; label: string; icon: GuideIconType } => Boolean(section));
  // The hero's second line, in the home's own subtitle slot: when and where.
  const clock = event.start ? `${event.start}${event.end ? `–${event.end}` : ""}` : "";
  const whenText = showSchedule ? date?.shortLabel ?? date?.label ?? event.date : "";
  const dday = showSchedule ? ddayLabel(event.date) : "";
  const whereText = showVenue ? venueName || venueAddress : "";
  const whereSub = showVenue && venueName && venueAddress ? venueAddress : "";
  const stageLabel = eventStageLabel(event.stage);
  const guideHref = `/event/${encodeURIComponent(slug)}`;


  // Poster keeps the home's own composition (ticket-card slot, icon tiles); tile and
  // photo layouts read as one plain summary card, then plain cards (owner decision 2026-11-19).
  const simple = layout !== "poster";
  const registration = (
    <TabTicketChoice slug={slug} whenPresent={
      <GuideCard
        slot={!simple}
        href={`${guideHref}/ticket`}
        prefetch={false}
        icon="ticket"
        label="내 티켓 열기"
        sub={acceptingSignup ? stageLabel : "현재 신청을 받지 않습니다"}
        go="열기"
      />
    }>
      {acceptingSignup ? (
        <GuideCard slot={!simple} href={`${guideHref}/register`} icon="register" label="참가 신청하기" sub={`${stageLabel} · 접수 중`} go="신청" />
      ) : !recoveryBlocked ? (
        <GuideCard slot={!simple} href={`${guideHref}/ticket/recover`} icon="ticket" label="이미 신청했다면 내 티켓 찾기" sub="현재 신청을 받지 않습니다" go="찾기" />
      ) : (
        <div className={styles.closedCard}>
          <GuideIcon type="register" />
          <p className={styles.registrationClosed} role="status">현재 신청을 받지 않습니다.</p>
        </div>
      )}
    </TabTicketChoice>
  );
  // A long venue name or address would squeeze two side-by-side tiles; stack them instead.
  const longFacts = whereText.length > 14 || whereSub.length > 20;
  const facts = whenText || whereText ? (
    <div className={simple ? styles.factRows : `${styles.facts}${longFacts ? ` ${styles.factsStack}` : ""}`}>
      {whenText ? (
        <div className={simple ? styles.factRow : styles.fact} data-guide-when>
          <span className={styles.factIcon} aria-hidden="true"><GuideIcon type="calendar" /></span>
          <span className={styles.factText}>
            <span className={styles.factMain}>{date ? <time dateTime={date.dateTime}>{whenText}</time> : whenText}</span>
            <span className={styles.factSub}>{clock || "시간 미정"}</span>
          </span>
          {dday ? <span className={styles.dday}>{dday}</span> : null}
        </div>
      ) : null}
      {whereText ? (
        <div className={simple ? styles.factRow : styles.fact} data-guide-where>
          <span className={styles.factIcon} aria-hidden="true"><GuideIcon type="venue" /></span>
          <span className={styles.factText}>
            <span className={styles.factMain}>{whereText}</span>
            {whereSub ? <span className={styles.factSub}>{whereSub}</span> : null}
          </span>
        </div>
      ) : null}
    </div>
  ) : null;

  const photoUrl = (fileId: string) => `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`;
  const sectionLabel = `${L.groupLabel} ${styles.sectionLabel}`;

  return (
    <main id="main-content" tabIndex={-1} className={`${homeStyles.homePage} public-event-page`} style={homeSurfaceStyle(homeStyle)}>
      <div className={`${L.root} ${L[layout]}`} style={rootStyle} data-layout={layout} data-menu-shape={layout === "poster" ? "circle" : layout === "tile" ? "tile" : "row"}>
        <HomeHero
          eventName={event.name}
          homeStyle={homeStyle}
          layout={layout}
          keyvisual={keyvisual}
          defaultHomeBanner={defaultHomeBanner}
          label={`${event.name} 행사 안내`}
        />

        {simple ? (
          // Tile and photo layouts: one plain summary card (when, where and the one action),
          // then plain cards. Not the home's floating ticket card and tiles.
          <section className={styles.summary} aria-label="행사 요약">
            {facts}
            <div className={styles.summaryAction}>{registration}</div>
            <p className={styles.summaryIntro}>{intro}</p>
          </section>
        ) : (
          <>
            <div className={L.ticketWrap}>{registration}</div>
            {facts}
            <p className={styles.intro}>{intro}</p>
          </>
        )}

        {layout === "poster" && publicSections.length ? (
          <nav className={L.menus} aria-label="행사 안내 바로가기">
            <h2 className={L.groupLabel}>바로가기</h2>
            <div className={`${L.group} ${L.group_circle}`}>
              {publicSections.map((section) => (
                <a key={section.id} className={L.circle} href={`#${section.id}`}>
                  <Anatomy icon={<GuideIcon type={section.icon} />}><span className={L.entryLabel}>{section.label}</span></Anatomy>
                </a>
              ))}
            </div>
          </nav>
        ) : null}

        <div className={styles.sections}>
          {showAnnouncements && notices.length ? (
            <section className={styles.section} aria-labelledby="public-notices">
              <h2 id="public-notices" className={sectionLabel}>공지</h2>
              <div className={styles.card}>
                <ul className={styles.noticeList}>
                  {/* Pinned notices lead; the sort is stable, so each group keeps its own order. */}
                  {[...notices].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map((notice) => (
                    <li key={notice.id} data-pinned={notice.pinned || undefined}>
                      <span className={styles.noticeIcon} aria-hidden="true"><GuideIcon type="notice" /></span>
                      <div className={styles.noticeBody}>
                        <h3>
                          {notice.pinned ? <span className={styles.pin}>고정</span> : null}
                          {notice.title}
                        </h3>
                        {notice.body ? <RichText source={notice.body} imageSrc={(fileId) => `/api/public/events/${encodeURIComponent(slug)}/files/${encodeURIComponent(fileId)}`} /> : null}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </section>
          ) : null}

          {showPrograms && program.length ? (
            <section className={styles.section} aria-labelledby="public-program">
              <h2 id="public-program" className={sectionLabel}>프로그램</h2>
              <div className={styles.card}>
                <PublicProgramSchedule program={program} eventDate={showSchedule ? event.date : ""} />
              </div>
            </section>
          ) : null}

          {boothMap ? (
            <section className={styles.section} aria-labelledby="public-booth-map">
              <h2 id="public-booth-map" className={sectionLabel}>부스 지도</h2>
              <div className={styles.card}>
                <div className={styles.mapWrap}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img className={styles.mapImage} src={photoUrl(boothMap.fileId)} alt="행사장 부스 배치도" loading="lazy" />
                  {boothMap.points.map((point) => {
                    const booth = boothMap.booths.find((item) => item.id === point.boothId);
                    if (!booth) return null;
                    return (
                      <span key={point.boothId} className={styles.mapPoint} style={{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }}>
                        {booth.name}
                      </span>
                    );
                  })}
                </div>
              </div>
            </section>
          ) : null}

          {showVenue && hasVenue ? (
            <section className={styles.section} aria-labelledby="public-venue">
              <h2 id="public-venue" className={sectionLabel}>오시는 길</h2>
              <div className={styles.card}>
                {venueName || venueAddress ? (
                  <div className={styles.venueHead}>
                    <span className={styles.venueBubble} aria-hidden="true"><GuideIcon type="venue" /></span>
                    <div className={styles.venueBody}>
                      {venueName ? <p className={styles.venueName}>{venueName}</p> : null}
                      {venueAddress ? <div className={styles.addressRow}><AddressCopyButton address={venueAddress} /></div> : null}
                      {venueAddress ? (
                        <a className={styles.mapLink} href={`https://map.naver.com/p/search/${encodeURIComponent(venueAddress)}`} target="_blank" rel="noopener noreferrer">
                          지도에서 보기 <span aria-hidden="true">↗</span><span className="sr-only"> (새 탭)</span>
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {venueDirections || venueDescription || venueContact ? (
                  <dl className="event-facts">
                    {venueDirections ? (
                      <div className="event-fact"><dt>오시는 길</dt><dd className={styles.venueText}>{venueDirections}</dd></div>
                    ) : null}
                    {venueDescription ? (
                      <div className="event-fact"><dt>행사장 안내</dt><dd className={styles.venueText}>{venueDescription}</dd></div>
                    ) : null}
                    {venueContact ? (
                      <div className="event-fact"><dt>문의</dt><dd>{venueContact}</dd></div>
                    ) : null}
                  </dl>
                ) : null}
                {venueMap ? <figure className={styles.venueMap}>
                  {/* A normal image/link preserves zoom and the browser's download controls. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={venueMap.src} alt={venueMap.alt} />
                  <figcaption><Link className="button button-secondary" href={venueMap.src} target="_blank" rel="noopener noreferrer">안내도 크게 보기 (새 탭)</Link></figcaption>
                </figure> : null}
              </div>
            </section>
          ) : null}
        </div>

        <TabTicketChoice slug={slug} whenPresent={
          <nav className={L.links} aria-label="행사 안내와 참여">
            <ProductLink className="button button-secondary" href={`${guideHref}/home`}>참가자 홈 <span aria-hidden="true">→</span></ProductLink>
            {acceptingSignup ? (
              <a className="button button-secondary" href={`${guideHref}/register`} target="_blank" rel="noopener noreferrer">
                다른 참가자 신청 (새 탭) <span aria-hidden="true">→</span>
              </a>
            ) : null}
            {/* A tab may hold someone else's ticket: recovery stays reachable here, as it was before. */}
            {!recoveryBlocked ? (
              <ProductLink className="button button-secondary" href={`${guideHref}/ticket/recover`}>이미 신청했다면 내 티켓 찾기 <span aria-hidden="true">→</span></ProductLink>
            ) : null}
          </nav>
        }>
          <nav className={L.links} aria-label="행사 안내와 참여">
            {acceptingSignup && !recoveryBlocked ? (
              <ProductLink className="button button-secondary" href={`${guideHref}/ticket/recover`}>이미 신청했다면 내 티켓 찾기 <span aria-hidden="true">→</span></ProductLink>
            ) : null}
            <ProductLink className="button button-secondary" href={`${guideHref}/home`}>참가자 홈 <span aria-hidden="true">→</span></ProductLink>
          </nav>
          {recoveryBlocked ? (
            <details className={styles.recoveryDetails}>
              <summary data-disclosure-indicator>이미 신청하셨나요?</summary>
              <p className={styles.recoveryNote} role="note">이미 신청했다면 신청을 완료한 브라우저 탭에서 티켓을 여세요. 이 행사는 문자로 다시 연결할 수 없습니다. {recoveryContact ? `문의: ${recoveryContact}` : "탭을 찾을 수 없다면 행사 초대 안내를 확인하거나 행사 주최 측에 문의하세요."}</p>
            </details>
          ) : null}
        </TabTicketChoice>
      </div>
    </main>
  );
}

// The home's button anatomy (content span > icon span + label span) on a link,
// so the home's own rules lay out the guide's ticket card and shortcuts.
function Anatomy({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <span>
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
    </span>
  );
}

// The registration action. In the poster composition it is the home's ticket-card slot,
// as a link; in the plain composition it is one full-width primary button with its status.
function GuideCard({ slot, href, prefetch, icon, label, sub, go }: { slot: boolean; href: string; prefetch?: boolean; icon: GuideIconType; label: string; sub: string; go: string }) {
  if (!slot) {
    return (
      <div className={styles.primaryBlock}>
        <Link className={`button button-primary ${styles.primaryAction}`} href={href} prefetch={prefetch}>{label}</Link>
        <p className={styles.primarySub}>{sub}</p>
      </div>
    );
  }
  return (
    <Link className={`${L.ticket} ${styles.cardLink}`} href={href} prefetch={prefetch}>
      <Anatomy icon={<GuideIcon type={icon} />}>
        <span className={L.ticketText}>
          <span className={L.ticketLabel}>{label}</span>
          <span className={styles.ticketSub}>{sub}</span>
        </span>
        <span className={L.ticketGo} aria-hidden="true">{go}</span>
      </Anatomy>
    </Link>
  );
}
