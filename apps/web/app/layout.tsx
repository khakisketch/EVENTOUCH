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

export const metadata: Metadata = {
  title: "EVENTOUCH",
  description: "행사 운영 워크스페이스",
};

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
