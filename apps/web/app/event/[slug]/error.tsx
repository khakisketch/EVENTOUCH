"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

// Route boundary for /event/[slug]/*: a failed public fetch otherwise drops
// the attendee on the framework default with no recovery path.
export default function EventError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  return (
    <main id="main-content" tabIndex={-1} className="ticket-card ticket-message">
      <h1>행사 정보를 불러오지 못했습니다</h1>
      <p role="alert">
        연결 상태를 확인한 뒤 다시 시도하세요. 계속되면 행사 운영자에게 문의해주세요.
      </p>
      <p>
        <button type="button" className="button button-primary" onClick={() => reset()}>
          다시 시도
        </button>
      </p>
      {slug ? (
        <p>
          <Link href={`/event/${encodeURIComponent(slug)}`}>행사 안내로</Link>
        </p>
      ) : null}
    </main>
  );
}
