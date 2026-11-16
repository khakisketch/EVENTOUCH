import ProductLink from "./ui/ProductLink";

// Any address the product does not serve: say so in the product's language and
// offer the one way back that always exists.
export default function NotFound() {
  return (
    <main id="main-content" tabIndex={-1} className="site-page registration-state">
      <h1>페이지를 찾을 수 없습니다</h1>
      <p>주소를 확인하거나 처음 화면으로 돌아가세요.</p>
      <p>
        <ProductLink href="/">처음으로</ProductLink>
      </p>
    </main>
  );
}
