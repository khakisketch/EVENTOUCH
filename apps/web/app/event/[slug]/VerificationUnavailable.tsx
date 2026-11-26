import ProductLink from "../../ui/ProductLink";
import { organizerContactLine } from "./attendee-guidance";

// Shown instead of the form when signup or ticket recovery needs a phone check
// that cannot be sent right now (a test transport or no text service). Said
// once, in the attendee's words: no provider or mode names, and the way to an
// existing ticket instead of a repeated explanation. The heading names what
// this screen cannot do: ticket recovery says nothing about signup.
export default function VerificationUnavailable({
  slug,
  contact = "",
  purpose = "signup",
}: {
  slug: string;
  /** Kept so callers can say which transport is behind it; the attendee is never told. */
  mode?: "mock" | "none";
  contact?: string;
  purpose?: "signup" | "recover";
}) {
  const base = `/event/${encodeURIComponent(slug)}`;
  return (
    <section className="verification-unavailable" role="status">
      <h2>{purpose === "recover" ? "지금은 문자로 티켓을 찾을 수 없습니다" : "지금은 신청을 받을 수 없습니다"}</h2>
      <p>인증 문자를 보낼 수 없어 연락처 확인을 마칠 수 없습니다. {organizerContactLine(contact)}</p>
      <p>이미 신청했다면 신청한 기기의 같은 브라우저에서 내 티켓을 열 수 있습니다.</p>
      <ProductLink className="button button-secondary" href={`${base}/ticket`} prefetch={false}>
        이 브라우저에서 내 티켓 열기
      </ProductLink>
      <ProductLink className="button button-secondary" href={base}>
        행사 안내 보기
      </ProductLink>
    </section>
  );
}
