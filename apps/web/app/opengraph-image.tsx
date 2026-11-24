import { ImageResponse } from "next/og";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// Default share card for link previews (카카오톡·문자·메신저 썸네일). Every route
// inherits it. The event pages (app/event/[slug]) define their own title and
// description and use their banner picture when there is one; without a picture
// they re-export this same card (event/[slug]/opengraph-image.tsx). Colors follow the brand tokens
// (--brand #EA552E, --brand-text #8E351F). Pretendard is set explicitly because
// the default Satori font cannot draw Hangul.
export const alt = "EVENTOUCH · 행사 운영 워크스페이스";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

const FONT_DIR = join(process.cwd(), "node_modules/pretendard/dist/public/static");

export default async function OpengraphImage() {
  const [bold, extraBold] = await Promise.all([
    readFile(join(FONT_DIR, "Pretendard-Bold.otf")),
    readFile(join(FONT_DIR, "Pretendard-ExtraBold.otf")),
  ]);

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          width: "100%",
          height: "100%",
          padding: "72px 96px",
          color: "#FFFFFF",
          fontFamily: "Pretendard",
          background: "linear-gradient(135deg, #EA552E 0%, #C8441F 55%, #8E351F 100%)",
        }}
      >
        <div style={{ display: "flex", fontSize: 176, fontWeight: 800, letterSpacing: -6, lineHeight: 1 }}>
          EVENTOUCH
        </div>
        <div style={{ display: "flex", marginTop: 36, fontSize: 50, fontWeight: 700, lineHeight: 1.3 }}>
          행사 운영 워크스페이스
        </div>
      </div>
    ),
    {
      ...size,
      fonts: [
        { name: "Pretendard", data: extraBold, weight: 800, style: "normal" },
        { name: "Pretendard", data: bold, weight: 700, style: "normal" },
      ],
    },
  );
}
