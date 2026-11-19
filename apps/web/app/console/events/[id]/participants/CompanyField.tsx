"use client";

import ProductButton from "../../../../ui/ProductButton";
import { suggestCompany } from "../../../../../lib/contact-normalize.cjs";
import styles from "./participants.module.css";

// 로/으로: a final consonant other than ㄹ takes 으로 (삼성전자로, 한울물산으로).
export function withRo(word: string): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0) - 0xac00;
  if (code < 0 || code > 11171) return `${word}(으)로`;
  const final = code % 28;
  return `${word}${final === 0 || final === 8 ? "로" : "으로"}`;
}

// 소속 is free text, but the people already in this event suggest the spelling:
// the browser lists existing names while typing, and a new name that looks like
// a well-used one (삼상전자 vs 삼성전자) gets a one-tap fix. Nothing is changed on its own.
export default function CompanyField({ id, value, onChange, counts, disabled = false }: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  counts: Map<string, number>;
  disabled?: boolean;
}) {
  const listId = `${id}-options`;
  const options = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ko")).slice(0, 200);
  const typed = value.trim();
  const hit = typed && !counts.has(typed) ? suggestCompany(typed, counts) : null;
  return (
    <>
      <input id={id} type="text" maxLength={200} value={value} disabled={disabled} list={listId} autoComplete="off"
        aria-describedby={`${id}-hint`} onChange={(event) => onChange(event.target.value)} />
      <datalist id={listId}>
        {options.map(([name, count]) => <option key={name} value={name} label={`${count}명`} />)}
      </datalist>
      <div id={`${id}-hint`} className={styles.companyHint} aria-live="polite">
        {hit ? (
          <>
            <span>이미 등록된 <b>{hit.company}</b>({hit.count}명)와 비슷합니다.</span>
            <ProductButton type="button" variant="ghost" disabled={disabled} onClick={() => onChange(hit.company)}>{withRo(hit.company)} 바꾸기</ProductButton>
          </>
        ) : null}
      </div>
    </>
  );
}
