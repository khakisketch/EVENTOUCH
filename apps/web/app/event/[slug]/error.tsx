"use client";

import Link from "next/link";
import { useParams } from "next/navigation";

// Route boundary for /event/[slug]/*: a failed public fetch otherwise drops
// the attendee on the framework default with no recovery path.
export default function EventError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const params = useParams();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  return (
    <section className="ticket-card ticket-message" role="alert">
      <h1>행사 정보를 불러오지 못했습니다</h1>
      <p>
        {error?.message || "연결하지 못했습니다. 다시 시도하세요."}
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
    </section>
  );
}
