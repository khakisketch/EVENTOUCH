"use client";

// Always-on attendee phone for the 공지·안내 workspace. The 홈 screen is the
// real AttendeeHomeLanding rendered with the published page design, so the
// background, banner and menu order follow 참가자 페이지 with no copy of
// their rules. 공지·일정·장소 reuse the public event page's own list classes.
// The phone shows what attendees see (published items) plus the one item
// being edited, drawn from the live draft and outlined. The phone is the shared
// DeviceFrame simulator (real 390px layout, scaled to its host); a real phone
// shows the bare screen edge to edge instead.

import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import AttendeeHomeLanding from "../../../../event/[slug]/home/AttendeeHomeLanding";
import attendeeHomeStyles from "../../../../event/[slug]/home/home.module.css";
import publicStyles from "../../../../event/[slug]/public-event.module.css";
import HomeHero from "../../../../event/[slug]/home/HomeHero";
import L from "../../../../event/[slug]/home/home-layouts.module.css";
import GuideIcon from "../../../../event/[slug]/GuideIcon";
import PublicProgramSchedule, { type PublicProgramScheduleItem } from "../../../../event/[slug]/PublicProgramSchedule";
import type { HomeStyle } from "../../../../../lib/attendee-home";
import type { HomeMenus } from "../../../../../lib/attendee-home-menus";
import DeviceFrame, { deviceSize } from "../../../console-ui/DeviceFrame";
import ProductLink from "../../../../ui/ProductLink";
import RichText from "../../../../ui/RichText";
import styles from "./content-preview.module.css";

export type PreviewScreen = "home" | "notice" | "program" | "venue";

export type PreviewDesign = {
  homeStyle: HomeStyle;
  homeMenus: HomeMenus;
  accent: string;
  keyvisualUrl: string | null;
  defaultHomeBanner: "legacy" | "neutral";
  intro: string;
  showSchedule: boolean;
  showAnnouncements: boolean;
  showPrograms: boolean;
  showVenue: boolean;
};

export type PreviewNotice = { id: string; title: string; body: string; pinned: boolean; editing: boolean; unpublished: boolean };
export type PreviewProgram = PublicProgramScheduleItem & { editing: boolean; unpublished: boolean };
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

// Height of the scrolling screen inside the phone; the status and home rows come on top.
const PHONE_VIEWPORT = 700;
const RAIL_WIDTH = 300;

type Props = {
  eventName: string;
  eventDate: string;
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

export default function ContentPhonePreview({ eventName, eventDate, screen, onScreen, design, notices, programs, venue, designHref, imageSrc, mode = "rail", onExpand, onClose }: Props) {
  const stage = mode === "stage";
  const hostRef = useRef<HTMLDivElement | null>(null);
  // Stage fit: on a real phone the screen fills the viewport edge to edge
  // (no frame); on larger screens the device simulator is drawn as large as
  // the width and height left over allow.
  const [fit, setFit] = useState<{ scale: number; height: number; bare: boolean; maxWidth: number } | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!stage || !host) return;
    const measure = () => {
      const width = host.clientWidth;
      const height = host.clientHeight;
      if (!width || !height) return;
      const bare = window.innerWidth <= 768;
      const size = deviceSize("phone", undefined, PHONE_VIEWPORT);
      if (bare) setFit({ scale: width / 390, height: height / (width / 390), bare, maxWidth: width });
      else setFit({ scale: 1, height: size.height, bare, maxWidth: Math.max(220, Math.min(size.width * 1.1, width - 32, (height - 24) * (size.width / size.height))) });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [stage]);
  const screenRef = useRef<HTMLDivElement | null>(null);
  const editingNotice = notices.find((item) => item.editing);
  const editingProgram = programs.find((item) => item.editing);
  const editingKey = editingNotice
    ? `notice:${editingNotice.id || "new"}`
    : editingProgram
      ? `program:${editingProgram.id || "new"}:${editingProgram.date}`
      : venue?.editing ? "venue" : "";
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
  const layout = design.homeStyle.layout === "instagram" ? "tile" : design.homeStyle.layout;
  const hidden = (flag: boolean) => (flag ? null : <p className={styles.hiddenNote}>이 구역은 참가자 페이지에서 숨겨져 있어 참가자에게 보이지 않습니다.</p>);

  const scaled = stage && fit?.bare ? ({ "--phone-scale": fit.scale, "--phone-height": `${fit.height}px` } as CSSProperties) : undefined;
  const screenLabel = `참가자 ${SCREENS.find((item) => item.id === screen)?.label} 화면 미리보기`;
  const screenBody = (
    <>
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
          <div className={`${styles.page} ${attendeeHomeStyles.homePage}`}>
            <div className={`${L.root} ${L[layout]}`} style={{ "--lay-ink": readableInk(background) } as CSSProperties} data-layout={layout}>
              <HomeHero
                eventName={eventName}
                homeStyle={design.homeStyle}
                layout={layout}
                keyvisual={design.keyvisualUrl}
                defaultHomeBanner={design.defaultHomeBanner}
                label={`${eventName} 행사 안내`}
                preview
              />
              <p className={publicStyles.intro}>{design.intro}</p>
              <div className={publicStyles.sections}>
            {screen === "notice" ? (
              <section className={publicStyles.section} aria-label="공지">
                <h2 className={`${L.groupLabel} ${publicStyles.sectionLabel}`}>공지</h2>
                {hidden(design.showAnnouncements)}
                {notices.length ? (
                  <div className={publicStyles.card}>
                  <ul className={publicStyles.noticeList}>
                    {[...notices].sort((a, b) => Number(b.pinned) - Number(a.pinned)).map((item) => (
                      <li key={item.id || "new"} data-pinned={item.pinned || undefined} data-editing={item.editing || undefined} className={item.editing ? styles.editing : undefined}>
                        <span className={publicStyles.noticeIcon} aria-hidden="true"><GuideIcon type="notice" /></span>
                        <div className={publicStyles.noticeBody}>
                          <h3>
                            {item.pinned ? <span className={publicStyles.pin}>고정</span> : null}
                            {item.title || "제목 없음"}
                          </h3>
                          {item.body ? <RichText source={item.body} imageSrc={imageSrc} /> : null}
                          {item.editing && item.unpublished ? <p className={styles.draftTag}>게시 전 · 초안 미리보기</p> : null}
                        </div>
                      </li>
                    ))}
                  </ul>
                  </div>
                ) : <p className={styles.emptyNote}>게시된 공지가 없습니다.</p>}
              </section>
            ) : null}
            {screen === "program" ? (
              <section className={publicStyles.section} aria-label="프로그램">
                <h2 className={`${L.groupLabel} ${publicStyles.sectionLabel}`}>프로그램</h2>
                {hidden(design.showPrograms)}
                {programs.length ? (
                  <div className={publicStyles.card} style={{ "--event-accent": design.accent } as CSSProperties}>
                    <PublicProgramSchedule key={editingKey} program={programs} eventDate={design.showSchedule ? eventDate : ""} preview />
                  </div>
                ) : <p className={styles.emptyNote}>게시된 일정이 없습니다.</p>}
              </section>
            ) : null}
            {screen === "venue" ? (
              <section className={publicStyles.section} aria-label="오시는 길">
                <h2 className={`${L.groupLabel} ${publicStyles.sectionLabel}`}>오시는 길</h2>
                {hidden(design.showVenue)}
                {venue && (venue.name || venue.address || venue.directions || venue.contact || venue.description || venue.mapUrl) ? (
                  <div className={`${publicStyles.card} ${venue.editing ? styles.editing : ""}`} data-editing={venue.editing || undefined}>
                    {venue.name || venue.address ? (
                      <div className={publicStyles.venueHead}>
                        <span className={publicStyles.venueBubble} aria-hidden="true"><GuideIcon type="venue" /></span>
                        <div className={publicStyles.venueBody}>
                          {venue.name ? <p className={publicStyles.venueName}>{venue.name}</p> : null}
                          {venue.address ? <p className={styles.venueAddress}>{venue.address}</p> : null}
                        </div>
                      </div>
                    ) : null}
                    <dl className={`${styles.venue} event-facts`}>
                      {venue.directions ? <div className="event-fact"><dt>오시는 길</dt><dd className={publicStyles.venueText}>{venue.directions}</dd></div> : null}
                      {venue.description ? <div className="event-fact"><dt>행사장 안내</dt><dd className={publicStyles.venueText}>{venue.description}</dd></div> : null}
                      {venue.contact ? <div className="event-fact"><dt>문의</dt><dd>{venue.contact}</dd></div> : null}
                    </dl>
                    {venue.mapUrl ? (
                      <figure className={publicStyles.venueMap}>
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={venue.mapUrl} alt={venue.mapAlt} />
                      </figure>
                    ) : null}
                  </div>
                ) : <p className={styles.emptyNote}>게시된 장소 안내가 없습니다.</p>}
              </section>
            ) : null}
              </div>
            </div>
          </div>
        )}
    </>
  );
  const bareEl = (
    <div className={styles.phone}>
      <div className={styles.viewport}>
        <div className={styles.screen} ref={screenRef} style={frameStyle} tabIndex={0} role="region" aria-label={screenLabel}>
          {screenBody}
        </div>
      </div>
    </div>
  );
  const phoneEl = (
    <DeviceFrame
      variant="phone"
      viewportHeight={PHONE_VIEWPORT}
      maxDisplayWidth={stage ? fit?.maxWidth : RAIL_WIDTH}
      chromeColor={background}
      scrollLabel={screenLabel}
      contentRef={screenRef}
      contentStyle={frameStyle}
    >
      {screenBody}
    </DeviceFrame>
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
          {fit ? (fit.bare ? bareEl : phoneEl) : null}
        </div>
      </div>
    );
  }

  return (
    <aside className={styles.rail} aria-label="참가자 폰 미리보기">
      <h2 className="sr-only">참가자 폰 미리보기</h2>
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
