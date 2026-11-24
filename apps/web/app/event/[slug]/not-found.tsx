// An attendee who lands here followed a link from a text message or a printed
// invitation, not from the product's own site: the product landing page is
// not a way forward for them. They need the address checked or the organizer
// asked (attendee screens review, 2026-11-24).
export default function EventNotFound() {
  return (
    <main id="main-content" tabIndex={-1} className="site-page registration-state">
      <h1>행사를 찾을 수 없습니다</h1>
      <p>문자나 안내문에 적힌 주소를 다시 확인하거나, 행사 주최 측에 문의해 주세요.</p>
    </main>
  );
}
