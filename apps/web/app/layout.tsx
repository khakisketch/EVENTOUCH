import type { Metadata } from "next";

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
      <body>{children}</body>
    </html>
  );
}
