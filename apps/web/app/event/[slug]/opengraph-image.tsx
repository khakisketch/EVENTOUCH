import OpengraphImage from "../../opengraph-image";

// An event without a banner picture keeps the product's default share card:
// its layout's own openGraph tags would otherwise drop the card the root
// segment provides. Same image, same size; only the segment owns it now.
export const alt = "EVENTOUCH · 행사 참가 안내";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";
export const runtime = "nodejs";

export default OpengraphImage;
