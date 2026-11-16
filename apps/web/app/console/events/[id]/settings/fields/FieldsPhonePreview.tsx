import styles from "./fields.module.css";

export type PreviewField = { id: string; label: string; type: string; required: boolean; options: string[] };

// What the attendee's application form will show once this draft is
// published. It is a decorative redraw: it reads the draft list, runs nothing,
// and must be updated when the real form (event/[slug]/register) changes.
export default function FieldsPhonePreview({ eventName, fields, activeId }: { eventName: string; fields: PreviewField[]; activeId: string | null }) {
  return (
    <figure className={styles.previewRail}>
      <figcaption className={styles.previewCaption}>참가자에게 보이는 신청서 (초안)</figcaption>
      {/* The redraw repeats the list's own labels; it is not a second form. */}
      <div className={styles.phone} aria-hidden="true" inert>
        <div className={styles.phoneBar}><strong>참가 신청</strong><span>초안</span></div>
        <div className={styles.phoneBody}>
          <p className={styles.phoneTitle}>{eventName}</p>
          {fields.map((field) => (
            <div key={field.id} className={`${styles.phoneField} ${field.id === activeId ? styles.phoneFieldActive : ""}`}>
              {field.type === "checkbox" ? (
                <span className={styles.phoneCheck}><i />{field.label || "이름 없는 항목"}<em>{field.required ? " (필수)" : " (선택)"}</em></span>
              ) : (
                <>
                  <span className={styles.phoneLabel}>{field.label || "이름 없는 항목"}<em>{field.required ? " (필수)" : " (선택)"}</em></span>
                  <span className={styles.phoneInput}>{field.type === "select" ? "선택하세요" : field.id === "phone" ? "01012345678" : ""}</span>
                </>
              )}
            </div>
          ))}
        </div>
        <div className={styles.phoneCta}>신청하기</div>
      </div>
      <p className={styles.previewNote}>입력칸은 동작하지 않는 미리보기입니다.</p>
    </figure>
  );
}
