import Link from "next/link";

export default function EventNotFound() {
  return (
      <main id="main-content" className="site-page registration-state">
      <h1>행사를 찾을 수 없습니다</h1>
      <p>주소를 확인하세요.</p>
      <p>
        <Link href="/">처음으로</Link>
      </p>
    </main>
  );
}
