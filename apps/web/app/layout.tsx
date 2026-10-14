import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "EVENTOUCH",
  description: "행사 운영 워크스페이스",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko">
      <body className="app-body">
        <a className="skip-link" href="#main-content">본문으로 건너뛰기</a>
        {children}
      </body>
    </html>
  );
}
