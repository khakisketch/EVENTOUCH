"use client";

import { Fragment, useEffect, useState } from "react";
import type { CSSProperties } from "react";
import ProductLink from "../../../ui/ProductLink";
import ProductButton from "../../../ui/ProductButton";
import { HOME_FEED_LIMIT, bannerFillCss, bannerFillTone, normalizeHomeStyle, readableInk, type HomePhoto, type HomeStyle } from "../../../../lib/attendee-home";
import { normalizeHomeMenus, type HomeMenus, type HomeProgram } from "../../../../lib/attendee-home-menus";
import styles from "./home.module.css";
import L from "./home-layouts.module.css";

export type HomeMenuKey = "qr" | "application" | "notice" | "lucky" | "roulette" | "vote" | "stamp";
type Menu = {
  key: HomeMenuKey;
  label: string;
  category: "Utility" | "info" | "Engagement";
};

export const HOME_MENUS: Menu[] = [
  { key: "qr", label: "모바일 티켓", category: "Utility" },
  { key: "notice", label: "공지사항", category: "info" },
  { key: "lucky", label: "럭키드로우 번호", category: "info" },
  { key: "roulette", label: "룰렛 이벤트", category: "Engagement" },
  { key: "vote", label: "순위 투표", category: "Engagement" },
  { key: "stamp", label: "부스 인증", category: "Engagement" },
];

/** Tiles that need a ticket before they do anything useful. */
const NEEDS_TICKET: ReadonlySet<HomeMenuKey> = new Set(["lucky", "roulette", "vote", "stamp"]);

type AttendeeHomeLandingProps = {
  eventName: string;
  // Whether this browser actually holds a ticket. Tiles that need one say
  // so on the tile instead of failing one tap later.
  hasTicket: boolean;
  // The landing stays the simple entry list. A QR is not handed to every
  // participant, so the home never assumes one; the ticket opens from the
  // first entry when the attendee has it.
  keyvisual: string | null;
  defaultHomeBanner?: "legacy" | "neutral";
  homeStyle: HomeStyle;
  onOpen?: (key: HomeMenuKey) => void;
  menuButtonRef?: (key: HomeMenuKey, node: HTMLButtonElement | null) => void;
  preview?: boolean;
  shortViewport?: boolean;
  slug?: string;
  hasPrograms?: boolean;
  unavailable?: HomeMenuKey[];
  homeMenus?: HomeMenus;
  programs?: HomeProgram[];
  // Approved participant photos, newest first, for the photo-first layout.
  // Other layouts ignore them.
  photos?: HomePhoto[];
};

// One landing, four compositions (homeStyle.layout): tile (compact banner,
// square tiles), poster (tall banner, circle or list menus), typography (no
// banner, large type) and instagram (slim banner, a feed of approved
// participant photos, list menus). Entries, ticket gating, group labels, links
// and the preview/disabled behavior are the same in every composition; only the
// arrangement changes. The photo-first layout needs approved photos to say
// anything: a public page with none reads as the tile home, while the
// console preview keeps the layout and shows where the photos will go.
export default function AttendeeHomeLanding({
  eventName,
  hasTicket,
  keyvisual,
  defaultHomeBanner = "legacy",
  homeStyle: homeStyleInput,
  onOpen,
  menuButtonRef,
  preview = false,
  slug,
  hasPrograms = false,
  unavailable = [],
  homeMenus,
  programs = [],
  photos = [],
}: AttendeeHomeLandingProps) {
  const [imageFailed, setImageFailed] = useState(false);
  // Stored or partial styles always read through the same defaults.
  const homeStyle = normalizeHomeStyle(homeStyleInput);
  const layout = homeStyle.layout === "instagram" && !photos.length && !preview ? "tile" : homeStyle.layout;
  const fill = bannerFillCss(homeStyle);
  const imageMode = fill === null;
  const neutralBanner = imageMode && (imageFailed || (!keyvisual && defaultHomeBanner === "neutral"));
  const imageSource = imageMode && !imageFailed ? keyvisual || (defaultHomeBanner === "neutral" ? null : "/attendee-home-banner.png") : null;
  const title = homeStyle.heroTitle?.trim() || eventName;
  const textHidden = imageMode && homeStyle.heroLayout === "image-only" && !neutralBanner;
  // A color banner reads its own tone; a picture follows the chosen tone.
  const tone = fill ? bannerFillTone(homeStyle) : neutralBanner ? "light" : homeStyle.textTone;
  const heroClass = [
    L.hero,
    tone === "dark" ? L.toneDark : L.toneLight,
    L[`align${capitalize(homeStyle.textAlign)}`],
    homeStyle.titleScale === "large" ? L.titleLarge : "",
    layout === "tile" && homeStyle.heroLayout === "bottom-overlay" ? L.textBottom : "",
    imageMode && homeStyle.overlay !== "none" ? L[`overlay${capitalize(homeStyle.overlay)}${capitalize(tone)}`] : "",
    homeStyle.imageFocus === "top" ? L.focusTop : homeStyle.imageFocus === "bottom" ? L.focusBottom : "",
  ].filter(Boolean).join(" ");

  useEffect(() => setImageFailed(false), [keyvisual]);

  // The console builder embeds this landing inside its own preview section
  // (under the preview h2): there it renders an h3 with identical styling so
  // the builder page keeps a single h1. The public page keeps the h1.
  const Title = preview ? "h3" : "h1";
  const menuSettings = normalizeHomeMenus(homeMenus);
  const ordered = ["qr", ...menuSettings.order].flatMap((key) => HOME_MENUS.filter((menu) => menu.key === key));
  // Preserve the two existing groups while allowing order changes inside each.
  const visibleMenus = [
    ...ordered.filter((menu) => menu.category === "Utility"),
    ...ordered.filter((menu) => menu.category === "info"),
    ...ordered.filter((menu) => menu.category === "Engagement"),
  ].filter((menu) => !unavailable.includes(menu.key) && (menu.key === "qr" || !menuSettings.hidden.includes(menu.key as typeof menuSettings.hidden[number])));
  const ticket = visibleMenus.find((menu) => menu.key === "qr");
  const entries = visibleMenus.filter((menu) => menu.key !== "qr");
  const programById = new Map(programs.map((program) => [program.id, program]));
  const selectedPrograms = menuSettings.programs.flatMap((id) => programById.has(id) ? [programById.get(id)!] : []);
  const showLinks = Boolean(slug || preview);
  const shape = layout === "tile" ? "tile" : layout === "poster" && homeStyle.menuShape === "circle" ? "circle" : "row";
  const feedPhotos = photos.slice(0, HOME_FEED_LIMIT);
  const rootStyle = { "--lay-ink": readableInk(homeStyle.backgroundColor) } as CSSProperties;

  const heroText = (
    <div className={`${L.heroText}${textHidden ? ` ${styles.visuallyHidden}` : ""}`}>
      <Title className={L.title}>{title}</Title>
      {homeStyle.heroLayout !== "image-only" && homeStyle.heroSubtitle.trim() ? <p className={L.subtitle}>{homeStyle.heroSubtitle}</p> : null}
    </div>
  );

  const hero = layout === "typography" ? (
    <header className={`${L.typoHead} ${homeStyle.titleScale === "large" ? L.titleLarge : ""} ${L[`align${capitalize(homeStyle.textAlign)}`]}`} aria-label={`${eventName} 참가자 홈`}>
      {heroText}
    </header>
  ) : (
    <section className={heroClass} style={fill ? { background: fill } : undefined} aria-label={`${eventName} 참가자 홈`} data-neutral={neutralBanner || undefined}>
      {imageSource ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={L.artwork} src={imageSource} alt="" onError={() => setImageFailed(true)} />
      ) : imageMode && imageFailed ? (
        <div className={styles.bannerImageFailure} role="status">배너 이미지를 불러오지 못했습니다.</div>
      ) : null}
      {heroText}
    </section>
  );

  const ticketEntry = ticket ? (
    <ProductButton
      ref={menuButtonRef ? (node) => menuButtonRef("qr", node) : undefined}
      type="button"
      className={L.ticket}
      icon={<MenuIcon type="qr" />}
      onClick={() => onOpen?.("qr")}
      disabled={preview || !onOpen}
      aria-disabled={preview || undefined}
    >
      <span className={L.ticketText}>
        <span className={L.ticketLabel}>{ticket.label}</span>
      </span>
      <span className={L.ticketGo}>열기</span>
    </ProductButton>
  ) : null;

  const renderEntry = (menu: Menu) => (
    <MenuEntry
      key={menu.key}
      menu={menu}
      shape={shape}
      needsTicket={!hasTicket && NEEDS_TICKET.has(menu.key)}
      onOpen={onOpen ? () => onOpen(menu.key) : undefined}
      buttonRef={menuButtonRef ? (node) => menuButtonRef(menu.key, node) : undefined}
      preview={preview}
    />
  );
  const feed = layout === "instagram" ? (
    <section className={L.feed} aria-label="현장 사진">
      <h2 className={L.groupLabel}>현장 사진{photos.length ? ` ${photos.length}` : ""}</h2>
      {photos.length ? (
        <ul className={L.feedList}>
          {feedPhotos.map((photo) => <FeedCard key={photo.id} photo={photo} />)}
        </ul>
      ) : (
        // Console preview only (a public page with no photos reads as the tile home).
        <ul className={L.feedList}>
          <li className={`${L.feedCard} ${L.feedEmpty}`}>
            <span className={L.feedEmptyArt} aria-hidden="true" />
            <p className={L.feedCaption}>승인된 참가자 사진이 여기에 표시됩니다<small>사진을 승인하면 최근 사진부터 보여요</small></p>
          </li>
        </ul>
      )}
      {photos.length > feedPhotos.length ? <p className={L.feedMore}>최근 {feedPhotos.length}장을 보여 드려요. 전체 사진은 참여 콘텐츠에서 볼 수 있어요.</p> : null}
    </section>
  ) : null;
  const groups = (["info", "Engagement"] as const).map((category) => ({
    category,
    items: entries.filter((menu) => menu.category === category),
  })).filter((group) => group.items.length);

  return (
    <div className={`${L.root} ${L[layout]}`} style={rootStyle} data-layout={layout} data-menu-shape={shape}>
      {hero}
      {ticketEntry ? <div className={L.ticketWrap}>{ticketEntry}</div> : null}
      {feed}
      <nav className={L.menus} aria-label="참가 메뉴">
        {groups.map((group, index) => (
          <Fragment key={group.category}>
            <h2 className={L.groupLabel}>{group.category === "info" ? "행사 안내" : "행사 참여"}</h2>
            <div className={`${L.group} ${L[`group_${shape}`]}`}>
              {group.items.map(renderEntry)}
              {shape === "tile" && showLinks && index === groups.length - 1 ? (
                <ApplicationEntry shape="tile" menuButtonRef={menuButtonRef} onOpen={onOpen} preview={preview} />
              ) : null}
            </div>
          </Fragment>
        ))}
      </nav>
      {showLinks ? (
        <nav className={L.links} aria-label="행사 안내와 참여">
          {shape !== "tile" ? <ApplicationEntry shape="link" menuButtonRef={menuButtonRef} onOpen={onOpen} preview={preview} /> : null}
          {preview ? <ProductButton type="button" disabled>행사 안내 보기 <span aria-hidden="true">→</span></ProductButton>
            : <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug!)}`}>행사 안내 보기 <span aria-hidden="true">→</span></ProductLink>}
          {hasPrograms ? preview ? <ProductButton type="button" disabled>참여 콘텐츠 보기 <span aria-hidden="true">→</span></ProductButton>
            : <ProductLink className="button button-secondary" href={`/event/${encodeURIComponent(slug!)}/engage`}>참여 콘텐츠 보기 <span aria-hidden="true">→</span></ProductLink> : null}
          {selectedPrograms.map((program) => preview
            ? <ProductButton type="button" disabled key={program.id}>{program.title} <span aria-hidden="true">→</span></ProductButton>
            : <ProductLink key={program.id} className="button button-secondary" href={`/event/${encodeURIComponent(slug!)}/engage?program=${encodeURIComponent(program.id)}`}>{program.title} <span aria-hidden="true">→</span></ProductLink>)}
        </nav>
      ) : null}
    </div>
  );
}

function formatFeedTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { hour: "numeric", minute: "2-digit" }).format(date);
}

// One photo of the feed. An unreadable file shows a quiet note in its place
// instead of a broken image.
function FeedCard({ photo }: { photo: HomePhoto }) {
  const [failed, setFailed] = useState(false);
  const meta = [photo.name, formatFeedTime(photo.at)].filter(Boolean).join(" · ");
  return (
    <li className={L.feedCard} data-feed-photo={photo.id}>
      {failed ? (
        <span className={L.feedBroken} role="status">사진을 불러오지 못했습니다.</span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={L.feedImage} src={photo.src} alt={photo.caption || `${photo.name || "참가자"}님이 공유한 사진`} loading="lazy" onError={() => setFailed(true)} />
      )}
      {photo.caption || meta ? (
        <p className={L.feedCaption}>{photo.caption}{meta ? <small>{meta}</small> : null}</p>
      ) : null}
    </li>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function ApplicationEntry({ shape, menuButtonRef, onOpen, preview }: {
  shape: "tile" | "link";
  menuButtonRef?: (key: HomeMenuKey, node: HTMLButtonElement | null) => void;
  onOpen?: (key: HomeMenuKey) => void;
  preview: boolean;
}) {
  if (shape === "tile") {
    return (
      <ProductButton
        ref={menuButtonRef ? (node) => menuButtonRef("application", node) : undefined}
        type="button"
        className={L.tile}
        icon={<MenuIcon type="application" />}
        disabled={preview}
        onClick={() => onOpen?.("application")}
      >
        <span className={L.tileLabel}>내 신청 정보</span>
      </ProductButton>
    );
  }
  return (
    <ProductButton ref={menuButtonRef ? (node) => menuButtonRef("application", node) : undefined} type="button" disabled={preview} onClick={() => onOpen?.("application")}>
      내 신청 정보 <span aria-hidden="true">→</span>
    </ProductButton>
  );
}

function MenuEntry({
  menu,
  shape,
  needsTicket,
  onOpen,
  buttonRef,
  preview,
}: {
  menu: Menu;
  shape: "tile" | "circle" | "row";
  needsTicket: boolean;
  onOpen?: () => void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  preview: boolean;
}) {
  const className = shape === "tile" ? L.tile : shape === "circle" ? L.circle : L.row;
  return (
    <ProductButton
      ref={buttonRef}
      type="button"
      className={className}
      icon={<MenuIcon type={menu.key} />}
      onClick={onOpen}
      disabled={preview || !onOpen}
      aria-disabled={preview || undefined}
    >
      {shape === "tile" ? (
        // The hint sits under the label so a narrow tile wraps it instead of clipping it.
        <span className={L.tileCopy}>
          <span className={L.tileLabel}>{menu.label}</span>
          {needsTicket ? <span className={L.needTicket}>티켓 필요</span> : null}
        </span>
      ) : (
        <>
          <span className={L.entryLabel}>{menu.label}</span>
          {needsTicket ? " " : null}
          {needsTicket ? <span className={L.needTicket}>티켓 필요</span> : null}
        </>
      )}
    </ProductButton>
  );
}

function MenuIcon({ type }: { type: HomeMenuKey }) {
  const common = {
    className: styles.menuIcon,
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2.8,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true as const,
  };

  switch (type) {
    case "stamp":
      return <svg {...common}><circle cx="24" cy="24" r="13" /><path d="m17.5 24.5 4.5 4.5 8.5-9.5" /><path d="M24 5v3M24 40v3M5 24h3M40 24h3" /></svg>;
    case "qr":
      return <svg {...common}><path d="M9 13h3l2.3-3.5h19.4L36 13h3a3 3 0 0 1 3 3v15a3 3 0 0 1-3 3h-3l-2.3 3.5H14.3L12 34h-3a3 3 0 0 1-3-3V16a3 3 0 0 1 3-3Z" /><path d="m22 17 5 .2-2.2 4 4.4 2.5-2.2 3.9-4.2-2.5-3.3 2.6v-5l3.2-1.5Z" /></svg>;
    case "notice":
      return <svg {...common}><path d="M10 6h28v27H10zM15 12h18M15 18h18M15 24h12M17 33v6m14-6v6" /><path d="M7 10v22" /></svg>;
    case "lucky":
      return <svg {...common}><path d="M9 12h30v21H9zM14 33l-3 6m22-6 3 6" /><path d="m24 17 1.7 3.4 3.8.6-2.8 2.7.7 3.8-3.4-1.8-3.4 1.8.7-3.8-2.8-2.7 3.8-.6L24 17Z" /></svg>;
    case "roulette":
      return <svg {...common}><circle cx="24" cy="23" r="16" /><circle cx="24" cy="23" r="4" /><path d="m24 7 2.8 8.1M38 15l-8.2 3.4M37 32l-8-4M11 31l8-4M10 14l8.2 4.2M18 39h12m-6-5v5" /></svg>;
    case "vote":
      return <svg {...common}><path d="M10 9h28v30H10zM16 15h3m5 0h10M16 23l2.5 2.5L22 21m3 2h9M16 32h18" /></svg>;
    case "application":
      return <svg {...common}><path d="M12 7h24v34H12zM17 16h14M17 23h14M17 30h10" /></svg>;
  }
}
