import { useEffect, useRef, useState } from "react";
import ProductButton from "../../../../../ui/ProductButton";
import ProductInput from "../../../../../ui/ProductInput";
import ProductSelect from "../../../../../ui/ProductSelect";
import DeviceFrame from "../../../../console-ui/DeviceFrame";
import AttendeeIcon from "../../../../../event/[slug]/AttendeeIcons";
import EventBanner from "../../../../../event/[slug]/EventBanner";
import EventFacts from "../../../../../event/[slug]/EventFacts";
import AttendeeSurface from "../../../../../event/[slug]/ui/AttendeeSurface";
import { attendeeGroundStyle, DEFAULT_ATTENDEE_THEME, type AttendeeTheme } from "../../../../../event/[slug]/event-theme";
import registerStyles from "../../../../../event/[slug]/register/register.module.css";
import { attendeeLook } from "../../../../../../lib/attendee-look";
import type { PublicEventContext } from "../../../../../../lib/public-event-context";
import styles from "./fields.module.css";

export type PreviewField = { id: string; label: string; type: string; required: boolean; options: string[] };
// What the application sheet carries besides the fields: the published banner,
// when and where, whether a phone check and a consent notice are asked.
export type PreviewSheet = {
  theme: AttendeeTheme;
  context: PublicEventContext;
  verificationRequired: boolean;
  approvalRequired: boolean;
  consentText: string;
  consentVersion: number;
};
type PreviewMode = "published" | "draft";

const EMPTY_SHEET: PreviewSheet = {
  theme: DEFAULT_ATTENDEE_THEME,
  context: { date: "", dateTime: "", time: "", place: "", hasVenueGuide: false },
  verificationRequired: false,
  approvalRequired: false,
  consentText: "",
  consentVersion: 1,
};

// A static rendering of the actual registration sheet inside a phone: the
// event banner, when and where, then the numbered sections (참가자 정보,
// 연락처 인증, 정보 수집 동의) with the field definitions in the organizer's
// order. Inputs and the CTA use the same wrappers and browser semantics as
// attendee registration, while the whole fieldset stays disabled, inert, and
// outside any form submission.
export default function FieldsPhonePreview({ eventName, publishedFields, draftFields, activeId,
  publishedVersion, draftVersion, sheet = EMPTY_SHEET }: {
  eventName: string;
  publishedFields: PreviewField[] | null;
  draftFields: PreviewField[];
  activeId: string | null;
  publishedVersion: number;
  draftVersion: number;
  sheet?: PreviewSheet;
}) {
  const [mode, setMode] = useState<PreviewMode>(publishedVersion > 0 && publishedVersion === draftVersion ? "published" : "draft");
  const isPublished = mode === "published";
  const fields = isPublished ? publishedFields ?? [] : draftFields;
  const screenRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (activeId || draftVersion > publishedVersion) setMode("draft");
    else if (publishedVersion > 0 && draftVersion === publishedVersion) setMode("published");
  }, [activeId, draftVersion, publishedVersion]);
  // The field being edited scrolls into view inside the phone.
  useEffect(() => {
    if (!activeId || isPublished) return;
    const node = screenRef.current?.querySelector<HTMLElement>("[data-active='true']");
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: "nearest" });
  }, [activeId, isPublished, draftFields]);

  const { theme, context, verificationRequired, approvalRequired, consentText, consentVersion } = sheet;
  const ground = attendeeGroundStyle(theme);
  // The look the real application page wears: a1 white, or a2 the event ground, with the 강조색 as the accent.
  const look = attendeeLook(theme.homeStyle, theme.accent);
  const chrome = theme.homeStyle.backgroundColor;
  const showFields = !(isPublished && (publishedVersion === 0 || !publishedFields));

  return (
    <div className={styles.previewRail}>
      <div className={styles.previewHead}>
        <p className={styles.previewCaption}>참가자 신청 화면 미리보기</p>
        <small className={styles.phoneStatus}>{isPublished ? `게시됨 ${publishedVersion}회` : "아직 게시 전"}</small>
      </div>
      <nav className={styles.previewModes} aria-label="신청서 미리보기 선택">
        <ProductButton type="button" variant="ghost" aria-pressed={isPublished} onClick={() => setMode("published")}>현재 게시본</ProductButton>
        <ProductButton type="button" variant="ghost" aria-pressed={!isPublished} onClick={() => setMode("draft")}>게시할 초안</ProductButton>
      </nav>
      <DeviceFrame variant="phone" viewportHeight={700} maxDisplayWidth={340} chromeColor={chrome} contentRef={screenRef} scrollLabel="참가 신청 화면 미리보기 (스크롤)">
      <AttendeeSurface color={look.color} mode={look.mode} ground={look.ground} className={styles.phoneSurface} style={ground}>
      <fieldset className={styles.phone} aria-hidden="true" inert disabled>
        <legend className="sr-only">참가 신청 양식 미리보기</legend>
        <header className={styles.phoneBar}>
          <span className={styles.phoneWordmark}>EVENTOUCH</span>
          <span className={styles.phoneContext}>참가 신청</span>
        </header>
        <div className={`${registerStyles.sheet} ${styles.phoneSheet}`}>
          <EventBanner theme={theme} title={eventName} kicker={<span>참가 신청</span>} className={registerStyles.sheetBanner} />
          <div className={registerStyles.sheetBody}>
            <EventFacts slug="preview" context={context} />
            <div className={`registration-form ${registerStyles.form}`}>
              {!showFields ? (
                <p className={styles.phoneEmpty}>
                  {isPublished && publishedVersion === 0 ? "아직 게시된 신청서가 없습니다." : "게시된 항목을 확인하지 못했습니다."}
                </p>
              ) : (
                <>
                  <section className={registerStyles.stepSection}>
                    <p className={registerStyles.outcomeNote}>
                      <span className={registerStyles.outcomeIcon}><AttendeeIcon name="ticket" size={18} /></span>
                      <span>
                        {approvalRequired ? "신청 접수 후 운영자가 승인하면 입장 QR이 표시됩니다." : "신청하면 입장 티켓이 바로 발급됩니다."}
                        {verificationRequired ? " 신청 전 연락처 인증이 필요합니다." : null}
                      </span>
                    </p>
                  </section>
                  <section className={registerStyles.stepSection}>
                    <h2 className={registerStyles.stepTitle}>참가자 정보</h2>
                    {fields.map((field) => {
                      const id = `preview-field-${field.id}`;
                      const active = !isPublished && field.id === activeId;
                      const className = `form-field ${field.type === "checkbox" ? "checkbox-field " : ""}${active ? styles.phoneFieldActive : ""}`;
                      const marker = <span className={registerStyles.req}>{field.required ? " (필수)" : " (선택)"}</span>;

                      if (field.type === "checkbox") {
                        return (
                          <div key={field.id} className={className} data-active={active || undefined}>
                            <label htmlFor={id}>
                              <ProductInput id={id} type="checkbox" disabled required={field.required} />
                              {field.label || "이름 없는 항목"}{marker}
                            </label>
                          </div>
                        );
                      }

                      return (
                        <div key={field.id} className={className} data-active={active || undefined}>
                          <label htmlFor={id}>
                            {field.label || "이름 없는 항목"}{marker}
                          </label>
                          {field.type === "select" ? (
                            <ProductSelect id={id} value="" disabled required={field.required}>
                              <option value="">선택하세요</option>
                              {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                            </ProductSelect>
                          ) : (
                            <ProductInput id={id}
                              type={field.type === "email" ? "email" : "text"}
                              placeholder={field.id === "phone" ? "01012345678" : undefined}
                              autoComplete={field.id === "phone" ? "tel" : field.id === "name" ? "name" : field.id === "company" ? "organization" : field.type === "email" ? "email" : undefined}
                              disabled required={field.required} value="" />
                          )}
                        </div>
                      );
                    })}
                  </section>
                  {verificationRequired ? (
                    <section className={registerStyles.stepSection}>
                      <div className="verification-panel">
                        <h2>연락처 인증</h2>
                        <p>신청 연락처가 본인 것인지 문자 인증번호로 확인합니다. 인증을 마쳐야 신청할 수 있습니다.</p>
                        <ProductButton type="button" variant="ghost" disabled>인증번호 받기</ProductButton>
                      </div>
                    </section>
                  ) : null}
                  {consentText ? (
                    <section className={registerStyles.stepSection}>
                      <h2 className={registerStyles.stepTitle}>정보 수집 동의</h2>
                      <div className={`consent-field ${registerStyles.consentPanel}`}>
                        <label htmlFor="preview-consent">
                          <ProductInput id="preview-consent" type="checkbox" disabled required />
                          정보 수집 안내에 동의합니다 (필수)
                        </label>
                        <p className="preserve-lines">{consentText}</p>
                        <p className="consent-meta">동의 버전 {consentVersion} · 동의 시각과 함께 기록되며, 행사 종료 후 파기 기준은 행사 주최 측에 확인하세요.</p>
                      </div>
                    </section>
                  ) : null}
                </>
              )}
              <div className={styles.phoneFooter}>
                <ProductButton type="button" variant="primary" className={styles.phoneCta} disabled>신청하기</ProductButton>
              </div>
            </div>
          </div>
        </div>
      </fieldset>
      </AttendeeSurface>
      </DeviceFrame>
      <p className={styles.previewNote}>
        {isPublished
          ? publishedFields && publishedVersion > 0 ? "참가자에게 현재 공개된 항목과 순서입니다." : "현재 게시본을 사용할 수 없습니다."
          : `저장된 수정 ${draftVersion}건 · 저장 전 입력도 표시합니다.`}
      </p>
    </div>
  );
}
