"use client";

import { useRef } from "react";
import ProductButton from "../../ui/ProductButton";
import { SearchIcon, XIcon } from "./ConsoleIcons";
import styles from "./event-menu-search.module.css";

export default function EventMenuSearch({ query, onChange, resultCount, resultsId }: {
  query: string;
  onChange: (query: string) => void;
  resultCount: number;
  resultsId: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const searching = Boolean(query.trim());
  const resultMessage = resultCount ? `찾은 메뉴 ${resultCount}개` : "일치하는 메뉴가 없습니다.";

  return (
    <search aria-label="행사 메뉴" className={styles.search}>
      <label className={styles.field}>
        <SearchIcon />
        <input ref={input} type="search" aria-label="행사 메뉴 찾기" placeholder="메뉴 찾기"
          autoComplete="off" spellCheck={false} maxLength={80} aria-controls={resultsId} value={query}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
            if (event.key === "Escape" && query) {
              event.preventDefault();
              event.stopPropagation();
              onChange("");
              return;
            }
            const firstResult = document.getElementById(resultsId)?.querySelector<HTMLAnchorElement>("a[href]");
            if (event.key === "ArrowDown" && firstResult) {
              event.preventDefault();
              event.stopPropagation();
              firstResult.focus();
            } else if (event.key === "Enter" && searching && resultCount === 1 && firstResult) {
              event.preventDefault();
              firstResult.click();
            }
          }} />
      </label>
      {query ? <ProductButton type="button" variant="ghost" className={styles.clear} label="메뉴 검색어 지우기"
        icon={<XIcon />} onClick={() => { onChange(""); input.current?.focus(); }} /> : null}
      <p role="status" className={searching ? styles.status : "sr-only"}>{searching ? resultMessage : ""}</p>
    </search>
  );
}
