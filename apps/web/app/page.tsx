import Link from "next/link";

// Slice 1 of the frontend migration: public, read-only event pages.
// The legacy vanilla app at :8776 stays the product until each slice passes
// E2E/a11y/mobile and takes over deliberately. Nothing here writes.
export default function Home() {
  return (
    <main>
      <h1>EVENTOUCH</h1>
      <p>행사 공개 페이지를 새 앱에서 확인합니다.</p>
      <p>
        <Link href="/event/partner-demo">파트너 컨퍼런스 · 데모</Link>
      </p>
    </main>
  );
}
