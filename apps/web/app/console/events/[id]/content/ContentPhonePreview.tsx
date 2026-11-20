"use client";

// Always-on attendee phone for the 공지·안내 workspace. The 홈 screen is the
// real AttendeeHomeLanding rendered with the published page design, so the
// background, banner and menu order follow 참가자 페이지 with no copy of
// their rules. 공지·일정·장소 are the event guide's own sections (GuideSection,
// GuideNoticeList, GuideVenueCard) inside the same AttendeeSurface and look
// (a1 white / a2 event ground) an attendee gets, so the phone shows what they see.
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
import GuideSection from "../../../../event/[slug]/GuideSection";
import GuideNoticeList from "../../../../event/[slug]/GuideNoticeList";
import GuideVenueCard from "../../../../event/[slug]/GuideVenueCard";
import PublicProgramSchedule, { type PublicProgramScheduleItem } from "../../../../event/[slug]/PublicProgramSchedule";
import AttendeeSurface from "../../../../event/[slug]/ui/AttendeeSurface";
import AttendeeStateMessage from "../../../../event/[slug]/ui/AttendeeStateMessage";
import { readableInk, type HomeStyle } from "../../../../../lib/attendee-home";
import type { HomeMenus } from "../../../../../lib/attendee-home-menus";
import { attendeeLook } from "../../../../../lib/attendee-look";
import { homeSurfaceStyle } from "../../../../../lib/home-surface";
import DeviceFrame, { deviceSize } from "../../../console-ui/DeviceFrame";
import ProductLink from "../../../../ui/ProductLink";
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
  // The same ground variables the attendee screens set (lib/home-surface), at the phone's viewport height.
  const frameStyle = { ...homeSurfaceStyle(design.homeStyle), "--home-viewport-height": "700px" } as CSSProperties;
  // a1 (white ground, the 강조색 as the accent) unless the agency picked a ground color: what an attendee gets.
  const look = attendeeLook(design.homeStyle, design.accent);
  const layout = design.homeStyle.layout === "instagram" ? "tile" : design.homeStyle.layout;
  const hidden = (flag: boolean) => (flag ? null : <AttendeeStateMessage kind="info" title="이 구역은 참가자 페이지에서 숨겨져 있어요." className={styles.stateNote}>참가자에게는 보이지 않습니다.</AttendeeStateMessage>);
  const empty = (title: string) => <AttendeeStateMessage kind="empty" title={title} className={styles.stateNote} />;

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
              accent={design.accent}
              homeMenus={design.homeMenus}
              unavailable={design.showAnnouncements ? [] : ["notice"]}
              preview
              shortViewport
            />
          </div>
        ) : (
          <AttendeeSurface color={look.color} mode={look.mode} ground={look.ground} className={`${styles.page} ${attendeeHomeStyles.homePage}`} style={homeSurfaceStyle(design.homeStyle)}>
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
                  <GuideSection title="공지">
                    {hidden(design.showAnnouncements)}
                    {notices.length ? (
                      <GuideNoticeList
                        notices={notices.map((item) => ({
                          id: item.id,
                          title: item.title || "제목 없음",
                          body: item.body,
                          pinned: item.pinned,
                          editing: item.editing,
                          footer: item.editing && item.unpublished ? <p className={styles.draftTag}>게시 전 · 초안 미리보기</p> : null,
                        }))}
                        imageSrc={imageSrc}
                        editingClassName={styles.editing}
                      />
                    ) : empty("게시된 공지가 없습니다.")}
                  </GuideSection>
                ) : null}
                {screen === "program" ? (
                  <GuideSection title="프로그램">
                    {hidden(design.showPrograms)}
                    {programs.length ? (
                      <div className={publicStyles.card}>
                        <PublicProgramSchedule key={editingKey} program={programs} eventDate={design.showSchedule ? eventDate : ""} preview />
                      </div>
                    ) : empty("게시된 일정이 없습니다.")}
                  </GuideSection>
                ) : null}
                {screen === "venue" ? (
                  <GuideSection title="오시는 길">
                    {hidden(design.showVenue)}
                    {venue && (venue.name || venue.address || venue.directions || venue.contact || venue.description || venue.mapUrl) ? (
                      <GuideVenueCard
                        name={venue.name}
                        address={venue.address ? <p className={styles.venueAddress}>{venue.address}</p> : null}
                        directions={venue.directions}
                        description={venue.description}
                        contact={venue.contact}
                        map={venue.mapUrl ? { src: venue.mapUrl, alt: venue.mapAlt } : null}
                        editing={venue.editing}
                        editingClassName={styles.editing}
                      />
                    ) : empty("게시된 장소 안내가 없습니다.")}
                  </GuideSection>
                ) : null}
              </div>
            </div>
          </AttendeeSurface>
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
