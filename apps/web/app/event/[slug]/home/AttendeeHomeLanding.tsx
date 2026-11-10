"use client";

import { Fragment, useEffect, useState } from "react";
import Link from "next/link";
import type { HomeStyle } from "../../../../lib/attendee-home";
import { normalizeHomeMenus, type HomeMenus, type HomeProgram } from "../../../../lib/attendee-home-menus";
import styles from "./home.module.css";

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
};

export default function AttendeeHomeLanding({
  eventName,
  hasTicket,
  keyvisual,
  defaultHomeBanner = "legacy",
  homeStyle,
  onOpen,
  menuButtonRef,
  preview = false,
  shortViewport = false,
  slug,
  hasPrograms = false,
  unavailable = [],
  homeMenus,
  programs = [],
}: AttendeeHomeLandingProps) {
  const [imageFailed, setImageFailed] = useState(false);
  const neutralBanner = imageFailed || (!keyvisual && defaultHomeBanner === "neutral");
  const title = homeStyle.heroTitle?.trim() || eventName;
  const extended = homeStyle.heroLayout !== "image-only" && (
    homeStyle.titleScale === "large" || Boolean(homeStyle.heroSubtitle.trim()) || [...title].length > 30
  );
  const bannerClasses = [
    styles.eventBanner,
    neutralBanner ? styles.bannerNeutral : "",
    homeStyle.heroLayout === "bottom-overlay" ? styles.bannerBottomOverlay : "",
    homeStyle.heroLayout === "image-only" ? styles.bannerImageOnly : "",
    homeStyle.titleScale === "large" ? styles.bannerTitleLarge : "",
    preview && shortViewport ? styles.previewShortBanner : "",
    homeStyle.imageFocus === "top" ? styles.bannerFocusTop : "",
    homeStyle.imageFocus === "bottom" ? styles.bannerFocusBottom : "",
    styles[`bannerAlign${capitalize(homeStyle.textAlign)}`],
    homeStyle.textTone === "dark" ? styles.bannerToneDark : "",
    homeStyle.overlay !== "none" ? styles[`bannerOverlay${capitalize(homeStyle.overlay)}${capitalize(homeStyle.textTone)}`] : "",
    extended ? styles.bannerExtended : "",
  ].filter(Boolean).join(" ");
  const imageSource = imageFailed ? null : keyvisual || (defaultHomeBanner === "neutral" ? null : "/attendee-home-banner.png");

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
  const programById = new Map(programs.map((program) => [program.id, program]));
  const selectedPrograms = menuSettings.programs.flatMap((id) => programById.has(id) ? [programById.get(id)!] : []);

  return (
    <>
      <section className={bannerClasses} aria-label={`${eventName} 참가자 홈`}>
        {imageSource ? (
          <img
            className={styles.bannerArtwork}
            src={imageSource}
            alt=""
            onError={() => setImageFailed(true)}
          />
        ) : imageFailed ? (
          <div className={styles.bannerImageFailure} role="status">
            배너 이미지를 불러오지 못했습니다.
          </div>
        ) : null}
        <div className={`${styles.bannerText}${homeStyle.heroLayout === "image-only" && !neutralBanner ? ` ${styles.visuallyHidden}` : ""}`}>
          <Title className={styles.eventTitle}>{title}</Title>
          {homeStyle.heroLayout !== "image-only" && homeStyle.heroSubtitle.trim() ? (
            <p className={styles.heroSubtitle}>{homeStyle.heroSubtitle}</p>
          ) : null}
        </div>
      </section>
      <nav className={`${styles.menuBoard}${preview && shortViewport ? ` ${styles.previewShortMenu}` : ""}`} aria-label="참가 메뉴">
        {visibleMenus.map((menu, index) => (
          <Fragment key={menu.key}>
          {menu.category !== "Utility" && visibleMenus[index - 1]?.category !== menu.category ? <p className={styles.menuGroupLabel}>{menu.category === "info" ? "행사 안내" : "행사 참여"}</p> : null}
          <MenuButton
            key={menu.key}
            menu={menu}
            needsTicket={!hasTicket && NEEDS_TICKET.has(menu.key)}
            onOpen={onOpen ? () => onOpen(menu.key) : undefined}
            buttonRef={menuButtonRef ? (node) => menuButtonRef(menu.key, node) : undefined}
            preview={preview}
          />
          </Fragment>
        ))}
      </nav>
      {slug || preview ? (
        <nav className={styles.moreLinks} aria-label="행사 안내와 참여">
          <button type="button" disabled={preview} ref={menuButtonRef ? (node) => menuButtonRef("application", node) : undefined} onClick={() => onOpen?.("application")}>내 신청 정보 <span aria-hidden="true">→</span></button>
          {preview ? <button type="button" disabled>행사 안내 보기 <span aria-hidden="true">→</span></button>
            : <Link href={`/event/${encodeURIComponent(slug!)}`}>행사 안내 보기 <span aria-hidden="true">→</span></Link>}
          {hasPrograms ? preview ? <button type="button" disabled>참여 콘텐츠 보기 <span aria-hidden="true">→</span></button>
            : <Link href={`/event/${encodeURIComponent(slug!)}/engage`}>참여 콘텐츠 보기 <span aria-hidden="true">→</span></Link> : null}
          {selectedPrograms.map((program) => preview
            ? <button type="button" disabled key={program.id}>{program.title} <span aria-hidden="true">→</span></button>
            : <Link key={program.id} href={`/event/${encodeURIComponent(slug!)}/engage?program=${encodeURIComponent(program.id)}`}>{program.title} <span aria-hidden="true">→</span></Link>)}
        </nav>
      ) : null}
    </>
  );
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function MenuButton({
  menu,
  needsTicket,
  onOpen,
  buttonRef,
  preview,
}: {
  menu: Menu;
  needsTicket: boolean;
  onOpen?: () => void;
  buttonRef?: (node: HTMLButtonElement | null) => void;
  preview: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={styles.menuButton}
      onClick={onOpen}
      disabled={preview || !onOpen}
      aria-disabled={preview || undefined}
    >
      <MenuIcon type={menu.key} />
      <span className={styles.menuLabel}>{menu.label}</span>
      {/* Visual cue only: the detail screen announces the ticket need in
          full sentences, so the badge stays out of the accessible name and
          exact-name activation keeps working. */}
      {needsTicket ? <span className={styles.menuNeedTicket} aria-hidden="true">티켓 필요</span> : null}
    </button>
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
