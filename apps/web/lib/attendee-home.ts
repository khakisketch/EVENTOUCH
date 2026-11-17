export type HeroLayout = "centered" | "bottom-overlay" | "image-only";
export type TitleScale = "standard" | "large";
export type ImageFocus = "center" | "top" | "bottom";
export type TextAlign = "left" | "center" | "right";
export type TextTone = "light" | "dark";
export type HeroOverlay = "none" | "soft" | "strong";
// "instagram" is the photo-first home: a feed of approved participant photos
// under a slim banner (owner decision 2026-11-18). It needs approved photos to
// say anything, so a public page with none reads as the tile home.
export type HomeLayout = "tile" | "poster" | "typography" | "instagram";
export type MenuShape = "circle" | "list";
export type BannerKind = "image" | "gradient" | "solid";
export type BannerAngle = "diagonal" | "vertical" | "horizontal";

export type HomeStyle = {
  backgroundColor: string;
  heroTitle: string | null;
  heroSubtitle: string;
  heroLayout: HeroLayout;
  titleScale: TitleScale;
  imageFocus: ImageFocus;
  textAlign: TextAlign;
  textTone: TextTone;
  overlay: HeroOverlay;
  layout: HomeLayout;
  menuShape: MenuShape;
  bannerKind: BannerKind;
  bannerColor: string;
  bannerColor2: string;
  bannerAngle: BannerAngle;
};

export type HomeImage = {
  fileId?: string;
  name?: string;
  type?: string;
  size?: number;
  width?: number;
  height?: number;
  data?: string;
};

export const DEFAULT_HOME_STYLE: HomeStyle = {
  backgroundColor: "#B9DEF0",
  heroTitle: null,
  heroSubtitle: "",
  heroLayout: "centered",
  titleScale: "standard",
  imageFocus: "center",
  textAlign: "center",
  textTone: "light",
  overlay: "none",
  layout: "tile",
  menuShape: "circle",
  bannerKind: "image",
  bannerColor: "#1E2026",
  bannerColor2: "#C8441F",
  bannerAngle: "diagonal",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizeHomeStyle(value: unknown): HomeStyle {
  if (!isRecord(value)) return { ...DEFAULT_HOME_STYLE };
  const color = typeof value.backgroundColor === "string" && /^#[0-9a-f]{6}$/i.test(value.backgroundColor)
    ? value.backgroundColor.toUpperCase()
    : DEFAULT_HOME_STYLE.backgroundColor;
  return {
    backgroundColor: color,
    heroTitle: value.heroTitle === null
      ? null
      : typeof value.heroTitle === "string" && [...value.heroTitle].length <= 80
        ? value.heroTitle
        : null,
    heroSubtitle: typeof value.heroSubtitle === "string" && [...value.heroSubtitle].length <= 100
      ? value.heroSubtitle
      : "",
    heroLayout: value.heroLayout === "bottom-overlay" || value.heroLayout === "image-only"
      ? value.heroLayout
      : "centered",
    titleScale: value.titleScale === "large" ? "large" : "standard",
    imageFocus: value.imageFocus === "top" || value.imageFocus === "bottom" ? value.imageFocus : "center",
    textAlign: value.textAlign === "left" || value.textAlign === "right" ? value.textAlign : "center",
    textTone: value.textTone === "dark" ? "dark" : "light",
    overlay: value.overlay === "soft" || value.overlay === "strong" ? value.overlay : "none",
    layout: value.layout === "poster" || value.layout === "typography" || value.layout === "instagram" ? value.layout : "tile",
    menuShape: value.menuShape === "list" ? "list" : "circle",
    bannerKind: value.bannerKind === "gradient" || value.bannerKind === "solid" ? value.bannerKind : "image",
    bannerColor: hexOr(value.bannerColor, DEFAULT_HOME_STYLE.bannerColor),
    bannerColor2: hexOr(value.bannerColor2, DEFAULT_HOME_STYLE.bannerColor2),
    bannerAngle: value.bannerAngle === "vertical" || value.bannerAngle === "horizontal" ? value.bannerAngle : "diagonal",
  };
}

function hexOr(value: unknown, fallback: string): string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : fallback;
}

function channelLuminance(color: string): number {
  const rgb = color.slice(1).match(/.{2}/g)?.map((channel) => parseInt(channel, 16) / 255) ?? [0, 0, 0];
  const [r, g, b] = rgb.map((channel) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Ink that reads on a color: near-black or white, whichever contrasts more. */
export function readableInk(color: string): string {
  const background = channelLuminance(color);
  const dark = "#17252B";
  return (background + 0.05) / (channelLuminance(dark) + 0.05) >= 1.05 / (background + 0.05) ? dark : "#FFFFFF";
}

const ANGLES: Record<BannerAngle, string> = { diagonal: "135deg", vertical: "180deg", horizontal: "90deg" };

/** CSS background for a gradient or solid banner; null for the picture banner. */
export function bannerFillCss(style: HomeStyle): string | null {
  if (style.bannerKind === "solid") return style.bannerColor;
  if (style.bannerKind === "gradient") return `linear-gradient(${ANGLES[style.bannerAngle]}, ${style.bannerColor}, ${style.bannerColor2})`;
  return null;
}

/** Text tone for a fill banner: judged on the average of its colors. */
export function bannerFillTone(style: HomeStyle): "light" | "dark" {
  const colors = style.bannerKind === "gradient" ? [style.bannerColor, style.bannerColor2] : [style.bannerColor];
  const average = colors.reduce((sum, color) => sum + channelLuminance(color), 0) / colors.length;
  return average > 0.4 ? "dark" : "light";
}

// An approved participant photo as the photo-first home shows it.
export type HomePhoto = { id: string; src: string; caption: string; name: string; at: string };

// Most recent photos the feed lists; the rest live on the participation page.
export const HOME_FEED_LIMIT = 12;

/**
 * The approved participant photos of a workspace, newest first. Only APPROVED
 * photos with a usable file id count: a pending, hidden or unreadable photo
 * never reaches the feed, even when the response carries it (an attendee's own
 * pending photo rides along in the public projection). `srcFor` decides where
 * the bytes are read from, so the public page and the console preview each use
 * their own authorized route.
 */
export function parseHomePhotos(value: unknown, srcFor: (fileId: string) => string): HomePhoto[] {
  if (!Array.isArray(value)) return [];
  const photos: HomePhoto[] = [];
  for (const item of value) {
    if (!isRecord(item) || item.status !== "APPROVED") continue;
    const image = isRecord(item.image) ? item.image : null;
    const fileId = typeof image?.fileId === "string" ? image.fileId : "";
    if (!/^[A-Za-z0-9_-]{1,160}$/.test(fileId)) continue;
    const id = typeof item.id === "string" ? item.id : "";
    if (!id) continue;
    photos.push({
      id,
      src: srcFor(fileId),
      caption: typeof item.caption === "string" ? item.caption.trim() : "",
      name: typeof item.name === "string" ? item.name.trim() : "",
      at: typeof item.at === "string" ? item.at : "",
    });
  }
  // Newest first; an unreadable time sorts last and keeps its order.
  return photos
    .map((photo, index) => ({ photo, index, time: Date.parse(photo.at) }))
    .sort((a, b) => (Number.isFinite(b.time) ? b.time : -Infinity) - (Number.isFinite(a.time) ? a.time : -Infinity) || a.index - b.index)
    .map(({ photo }) => photo);
}

export function normalizeHomeImage(value: unknown): HomeImage | null {
  if (!isRecord(value)) return null;
  const fileId = typeof value.fileId === "string" && /^[A-Za-z0-9_-]{1,160}$/.test(value.fileId)
    ? value.fileId
    : undefined;
  const data = typeof value.data === "string" && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(value.data)
    ? value.data
    : undefined;
  if (!fileId && !data) return null;
  return {
    ...(fileId ? { fileId } : {}),
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.type === "string" ? { type: value.type } : {}),
    ...(typeof value.size === "number" && Number.isFinite(value.size) ? { size: value.size } : {}),
    ...(typeof value.width === "number" && Number.isFinite(value.width) ? { width: value.width } : {}),
    ...(typeof value.height === "number" && Number.isFinite(value.height) ? { height: value.height } : {}),
    ...(data ? { data } : {}),
  };
}

export function sameHomeImage(left: HomeImage | null, right: HomeImage | null): boolean {
  if (left === right) return true;
  if (!left || !right) return false;
  return (left.fileId || "") === (right.fileId || "") && (left.data || "") === (right.data || "");
}

export function homeImageLabel(image: HomeImage | null): string {
  if (!image) return "기본 배너 이미지";
  return image.name || (image.fileId ? "업로드한 배너 이미지" : "기존 배너 이미지");
}
