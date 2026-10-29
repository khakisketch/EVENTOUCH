"use client";
import "./tokens.css";
import RuntimeRecovery from "./RuntimeRecovery";

// Last-resort boundary for failures in the root layout itself. It renders
// its own document (no app styles or layout), offers one explicit retry, and
// never reloads by itself: an automatic reload could loop on a poisoned chunk
// and would silently drop whatever the user had typed.
export default function GlobalError({
  error,
}: {
  error: unknown;
  retry: () => void;
}) {
  return (
    <html lang="ko">
      <head><title>화면 복구 · EVENTOUCH</title></head>
      <body style={{ margin: 0, fontFamily: "var(--body-font)", background: "var(--ground)", color: "var(--ink)" }}>
        <RuntimeRecovery error={error} standalone />
      </body>
    </html>
  );
}
