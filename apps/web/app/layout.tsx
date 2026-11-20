import type { Metadata } from "next";
import { headers } from "next/headers";
import SkipLink from "./SkipLink";
import "./layers.css";
import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import { Theme } from "@astryxdesign/core/theme";
import { themes, defaultThemeSlug } from "../astryx-themes";
import "pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css";
import "./globals.css";
import "./product-ui.css";
import { configuredPublicBase } from "../lib/public-origin";

const TITLE = "EVENTOUCH";
const DESCRIPTION = "행사 운영 워크스페이스";

// Read at request time (not module load) so the container's EVENTOUCH_PUBLIC_URL
// decides absolute og:image URLs. Unset: no metadataBase and no absolute share URL.
export async function generateMetadata(): Promise<Metadata> {
  const base = configuredPublicBase();
  return {
    metadataBase: base ? new URL(base) : undefined,
    title: TITLE,
    description: DESCRIPTION,
    openGraph: { title: TITLE, description: DESCRIPTION, siteName: TITLE, locale: "ko_KR", type: "website" },
    twitter: { card: "summary_large_image", title: TITLE, description: DESCRIPTION },
  };
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Per-request CSP nonce (proxy.ts sets x-nonce). Reading request headers
  // opts this layout — and every page under it — into dynamic rendering,
  // which nonces require: Next.js stamps the request's nonce on each script
  // it emits during SSR. No UI change; the value itself is consumed by the
  // framework, not by markup here.
  await headers();
  return (
    <html lang="ko">
      <body className="app-body">
        <Theme theme={themes[defaultThemeSlug]} mode="light">
          <SkipLink />
          {children}
        </Theme>
      </body>
    </html>
  );
}
