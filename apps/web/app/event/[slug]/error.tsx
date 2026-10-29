"use client";

import { useParams } from "next/navigation";
import RuntimeRecovery from "../../RuntimeRecovery";

// Route boundary for /event/[slug]/*: a failed public fetch otherwise drops
// the attendee on the framework default with no recovery path.
export default function EventError({
  error,
  retry,
}: {
  error: unknown;
  retry: () => void;
}) {
  const params = useParams();
  const slug = typeof params?.slug === "string" ? params.slug : "";
  return <RuntimeRecovery error={error} retry={retry} title="행사 정보를 불러오지 못했습니다"
    message="연결 상태를 확인한 뒤 다시 시도하세요. 계속되면 행사 운영자에게 문의해주세요."
    back={slug ? { href: `/event/${encodeURIComponent(slug)}`, label: "행사 안내로" } : undefined} />;
}
