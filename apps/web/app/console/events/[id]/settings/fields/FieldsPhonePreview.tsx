import { useEffect, useState } from "react";
import ProductButton from "../../../../../ui/ProductButton";
import ProductInput from "../../../../../ui/ProductInput";
import ProductSelect from "../../../../../ui/ProductSelect";
import styles from "./fields.module.css";

export type PreviewField = { id: string; label: string; type: string; required: boolean; options: string[] };
type PreviewMode = "published" | "draft";

// A static rendering of the actual field definitions. Inputs and the CTA use
// the same wrappers and browser semantics as attendee registration, while the
// whole fieldset stays disabled, inert, and outside any form submission.
export default function FieldsPhonePreview({ eventName, publishedFields, draftFields, activeId,
  publishedVersion, draftVersion }: {
  eventName: string;
  publishedFields: PreviewField[] | null;
  draftFields: PreviewField[];
  activeId: string | null;
  publishedVersion: number;
  draftVersion: number;
}) {
  const [mode, setMode] = useState<PreviewMode>(publishedVersion > 0 && publishedVersion === draftVersion ? "published" : "draft");
  const isPublished = mode === "published";
  const fields = isPublished ? publishedFields ?? [] : draftFields;
  useEffect(() => {
    if (activeId || draftVersion > publishedVersion) setMode("draft");
    else if (publishedVersion > 0 && draftVersion === publishedVersion) setMode("published");
  }, [activeId, draftVersion, publishedVersion]);

  return (
    <figure className={styles.previewRail}>
      <figcaption className={styles.previewCaption}>참가자 신청 화면 미리보기</figcaption>
      <nav className={styles.previewModes} aria-label="신청서 미리보기 선택">
        <ProductButton type="button" variant="ghost" aria-pressed={isPublished} onClick={() => setMode("published")}>현재 게시본</ProductButton>
        <ProductButton type="button" variant="ghost" aria-pressed={!isPublished} onClick={() => setMode("draft")}>게시할 초안</ProductButton>
      </nav>
      <fieldset className={styles.phone} aria-hidden="true" inert disabled>
        <legend className="sr-only">참가 신청 양식 미리보기</legend>
        <header className={styles.phoneBar}>
          <strong>참가 신청</strong>
          <small className={styles.phoneStatus}>{isPublished ? `게시 ${publishedVersion}차` : "게시 전 초안"}</small>
        </header>
        <section className={styles.phoneBody}>
          <p className={styles.phoneTitle}>{eventName}</p>
          {isPublished && publishedVersion === 0 ? (
            <p className={styles.phoneEmpty}>아직 게시된 신청서가 없습니다.</p>
          ) : isPublished && !publishedFields ? (
            <p className={styles.phoneEmpty}>게시된 항목을 확인하지 못했습니다.</p>
          ) : fields.map((field) => {
            const id = `preview-field-${field.id}`;
            const active = !isPublished && field.id === activeId;
            const className = `${styles.phoneField} ${active ? styles.phoneFieldActive : ""}`;
            const marker = <small className={styles.phoneRequirement}>{field.required ? "(필수)" : "(선택)"}</small>;

            if (field.type === "checkbox") {
              return (
                <section key={field.id} className={className}>
                  <label className={styles.phoneCheck} htmlFor={id}>
                    <ProductInput id={id} type="checkbox" disabled required={field.required} />
                    {field.label || "이름 없는 항목"}{marker}
                  </label>
                </section>
              );
            }

            return (
              <section key={field.id} className={className}>
                <label className={styles.phoneLabel} htmlFor={id}>
                  {field.label || "이름 없는 항목"}{marker}
                </label>
                {field.type === "select" ? (
                  <ProductSelect id={id} className={styles.phoneInput} value="" disabled required={field.required}>
                    <option value="">선택하세요</option>
                    {field.options.map((option) => <option key={option} value={option}>{option}</option>)}
                  </ProductSelect>
                ) : (
                  <ProductInput id={id} className={styles.phoneInput}
                    type={field.type === "email" ? "email" : "text"}
                    placeholder={field.id === "phone" ? "01012345678" : undefined}
                    autoComplete={field.id === "phone" ? "tel" : field.id === "name" ? "name" : field.id === "company" ? "organization" : field.type === "email" ? "email" : undefined}
                    disabled required={field.required} value="" />
                )}
              </section>
            );
          })}
        </section>
        <footer className={styles.phoneFooter}>
          <ProductButton type="button" variant="primary" className={styles.phoneCta} disabled>신청하기</ProductButton>
        </footer>
      </fieldset>
      <p className={styles.previewNote}>
        {isPublished
          ? publishedFields && publishedVersion > 0 ? "참가자에게 현재 공개된 항목과 순서입니다." : "현재 게시본을 사용할 수 없습니다."
          : `초안 버전 ${draftVersion} · 저장 전 입력도 표시합니다.`}
      </p>
    </figure>
  );
}
