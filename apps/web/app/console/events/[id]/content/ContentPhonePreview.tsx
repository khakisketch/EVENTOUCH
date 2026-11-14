"use client";

// Always-on attendee phone for the 공지·안내 workspace. The 홈 screen is the
// real AttendeeHomeLanding rendered with the published page design, so the
// background, banner and menu order follow 참가자 페이지 with no copy of
// their rules. 공지·일정·장소 reuse the public event page's own list classes.
// The phone shows what attendees see (published items) plus the one item
// being edited, drawn from the live draft and outlined.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import AttendeeHomeLanding from "../../../../event/[slug]/home/AttendeeHomeLanding";
import attendeeHomeStyles from "../../../../event/[slug]/home/home.module.css";
import publicStyles from "../../../../event/[slug]/public-event.module.css";
import type { HomeStyle } from "../../../../../lib/attendee-home";
import type { HomeMenus } from "../../../../../lib/attendee-home-menus";
import ProductLink from "../../../../ui/ProductLink";
import RichText from "../../../../ui/RichText";
import styles from "./content-preview.module.css";

export type PreviewScreen = "home" | "notice" | "program" | "venue";

export type PreviewDesign = {
  homeStyle: HomeStyle;
  homeMenus: HomeMenus;
  keyvisualUrl: string | null;
  defaultHomeBanner: "legacy" | "neutral";
  intro: string;
  showAnnouncements: boolean;
  showPrograms: boolean;
  showVenue: boolean;
};

export type PreviewNotice = { id: string; title: string; body: string; pinned: boolean; editing: boolean; unpublished: boolean };
export type PreviewProgram = { id: string; title: string; meta: string; description: string; editing: boolean; unpublished: boolean };
export type PreviewVenue = { name: string; address: string; directions: string; contact: string; description: string; mapUrl: string | null; mapAlt: string; editing: boolean };

const SCREENS: Array<{ id: PreviewScreen; label: string }> = [
  { id: "home", label: "홈" },
  { id: "notice", label: "공지" },
  { id: "program", label: "일정" },
  { id: "venue", label: "장소" },
];

// Same contrast rule the page builder uses for text on the home background.
function luminance(color: string): number {
  const channels = color.slice(1).match(/.{2}/g)?.map((value) => parseInt(value, 16) / 255) ?? [0, 0, 0];
  const [r, g, b] = channels.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function readableInk(color: string): string {
  const dark = "#17252B";
  const background = luminance(color);
  return (background + 0.05) / (luminance(dark) + 0.05) >= 1.05 / (background + 0.05) ? dark : "#FFFFFF";
}

type Props = {
  eventName: string;
  screen: PreviewScreen;
  onScreen: (screen: PreviewScreen) => void;
  design: PreviewDesign;
  notices: PreviewNotice[];
  programs: PreviewProgram[];
  venue: PreviewVenue | null;
  designHref: string;
  imageSrc: (fileId: string) => string;
  // "rail" sits beside the work; "stage" is the full view (the whole screen
  // on a phone) and fits the phone to the space it is given.
  mode?: "rail" | "stage";
  onExpand?: () => void;
  onClose?: () => void;
};

export default function ContentPhonePreview({ eventName, screen, onScreen, design, notices, programs, venue, designHref, imageSrc, mode = "rail", onExpand, onClose }: Props) {
  const stage = mode === "stage";
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Stage fit: on a real phone the screen fills the viewport edge to edge
  // (no frame); on larger screens the framed phone is scaled to the height
  // and width left over.
  const [fit, setFit] = useState<{ scale: number; height: number; bare: boolean } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!stage || !host) return;
    const measure = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      const bare = window.innerWidth <= 768;
      if (bare) setFit({ scale: width / 390, height: height / (width / 390), bare });
      else setFit({ scale: Math.max(0.5, Math.min(1.15, (height - 32) / 780, (width - 32) / 390)), height: 780, bare });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [stage]);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const editingKey = [...notices, ...programs].find((item) => item.editing)?.id ?? (venue?.editing ? "venue" : "");
  useEffect(() => {
    const node = screenRef.current?.querySelector<HTMLElement>("[data-editing='true']");
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [screen, editingKey]);

  const background = design.homeStyle.backgroundColor;
  const frameStyle = {
    "--home-background-color": background,
    "--home-background-ink": readableInk(background),
    "--home-background-copy": readableInk(background),
    "--home-viewport-height": "700px",
  } as CSSProperties;
  const hidden = (flag: boolean) => (flag ? null : <p className={styles.hiddenNote}>이 구역은 참가자 페이지에서 숨겨져 있어 참가자에게 보이지 않습니다.</p>);

  const scaled = stage && fit ? ({ "--phone-scale": fit.scale, "--phone-height": `${fit.height}px` } as CSSProperties) : undefined;
  const phoneEl = (
  <div className={styles.phone}>
    <div className={styles.viewport}>
      <div className={styles.screen} ref={screenRef} style={frameStyle} tabIndex={0} role="region" aria-label={`참가자 ${SCREENS.find((item) => item.id === screen)?.label} 화면 미리보기`}>
        {screen === "home" ? (
          <div className={`${styles.home} ${attendeeHomeStyles.homePage}`}>
            <AttendeeHomeLanding
              eventName={eventName}
              hasTicket
              keyvisual={design.keyvisualUrl}
              defaultHomeBanner={design.defaultHomeBanner}
              homeStyle={design.homeStyle}
              homeMenus={design.homeMenus}
              unavailable={design.showAnnouncements ? [] : ["notice"]}
              preview
              shortViewport
            />
          </div>
        ) : (
          <div className={styles.page}>
            <header className={styles.hero} style={{ background }}>
              {design.keyvisualUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={design.keyvisualUrl} alt="" />
              ) : null}
              <h3 style={{ color: readableInk(background) }}>{eventName}</h3>
            </header>
            <p className={styles.intro}>{design.intro}</p>
            {screen === "notice" ? (
              <section className={publicStyles.section} aria-label="공지">
                <h2>공지</h2>
                {hidden(design.showAnnouncements)}
                {notices.length ? (
                  <ul className={publicStyles.noticeList}>
                    {notices.map((item) => (
                      <li key={item.id || "new"} data-editing={item.editing || undefined} className={item.editing ? styles.editing : undefined}>
                        <h3>
                          {item.pinned ? <span className={publicStyles.pin}>고정</span> : null}
                          {item.title || "제목 없음"}
                        </h3>
                        {item.body ? <RichText source={item.body} imageSrc={imageSrc} /> : null}
                        {item.editing && item.unpublished ? <p className={styles.draftTag}>게시 전 · 초안 미리보기</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.emptyNote}>게시된 공지가 없습니다.</p>}
              </section>
            ) : null}
            {screen === "program" ? (
              <section className={publicStyles.section} aria-label="프로그램">
                <h2>프로그램</h2>
                {hidden(design.showPrograms)}
                {programs.length ? (
                  <ul className={publicStyles.programList}>
                    {programs.map((item) => (
                      <li key={item.id || "new"} data-editing={item.editing || undefined} className={item.editing ? styles.editing : undefined}>
                        <h3>{item.title || "제목 없음"}</h3>
                        {item.meta ? <p className={publicStyles.programMeta}>{item.meta}</p> : null}
                        {item.description ? <p>{item.description}</p> : null}
                        {item.editing && item.unpublished ? <p className={styles.draftTag}>게시 전 · 초안 미리보기</p> : null}
                      </li>
                    ))}
                  </ul>
                ) : <p className={styles.emptyNote}>게시된 일정이 없습니다.</p>}
              </section>
            ) : null}
            {screen === "venue" ? (
              <section className={publicStyles.section} aria-label="오시는 길">
                <h2>오시는 길</h2>
                {hidden(design.showVenue)}
                {venue && (venue.name || venue.address || venue.directions || venue.contact || venue.description || venue.mapUrl) ? (
                  <dl className={`${styles.venue} ${venue.editing ? styles.editing : ""}`} data-editing={venue.editing || undefined}>
                    {venue.name ? <div><dt>장소</dt><dd>{venue.name}</dd></div> : null}
                    {venue.address ? <div><dt>주소</dt><dd>{venue.address}</dd></div> : null}
                    {venue.directions ? <div><dt>길찾기</dt><dd className={publicStyles.venueText}>{venue.directions}</dd></div> : null}
                    {venue.description ? <div><dt>안내</dt><dd className={publicStyles.venueText}>{venue.description}</dd></div> : null}
                    {venue.contact ? <div><dt>문의</dt><dd>{venue.contact}</dd></div> : null}
                    {venue.mapUrl ? (
                      <figure className={publicStyles.venueMap}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={venue.mapUrl} alt={venue.mapAlt} />
                      </figure>
                    ) : null}
                  </dl>
                ) : <p className={styles.emptyNote}>게시된 장소 안내가 없습니다.</p>}
              </section>
            ) : null}
          </div>
        )}
      </div>
    </div>
  </div>
  );

  if (stage) {
    return (
      <div className={`${styles.stage} ${fit?.bare ? styles.stageBare : ""}`}>
        <div className={styles.stageBar}>
          <div className={styles.screenTabs} role="group" aria-label="미리볼 화면">
            {SCREENS.map((item) => (
              <button key={item.id} type="button" className={styles.screenTab} aria-pressed={screen === item.id} onClick={() => onScreen(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
          <button type="button" className={styles.stageClose} onClick={onClose}>닫기</button>
        </div>
        <div className={styles.stageHost} ref={hostRef} style={scaled}>
          {fit ? phoneEl : null}
        </div>
      </div>
    );
  }

  return (
    <aside className={styles.rail} aria-label="참가자 폰 미리보기">
      <div className={styles.captionRow}>
        <p className={styles.caption}>참가자 폰 · 실시간 미리보기</p>
        {onExpand ? <button type="button" className={styles.expand} onClick={onExpand}>크게 보기</button> : null}
      </div>
      <div className={styles.screenTabs} role="group" aria-label="미리볼 화면">
        {SCREENS.map((item) => (
          <button key={item.id} type="button" className={styles.screenTab} aria-pressed={screen === item.id} onClick={() => onScreen(item.id)}>
            {item.label}
          </button>
        ))}
      </div>
      {phoneEl}
      <p className={styles.themeLine}>
        <span className={styles.swatch} style={{ background }} aria-hidden="true" />
        <span>참가자 페이지 디자인을 그대로 반영합니다</span>
        <ProductLink className={styles.themeLink} href={designHref}>바꾸기</ProductLink>
      </p>
    </aside>
  );
}
