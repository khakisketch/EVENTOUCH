export type HeroLayout = "centered" | "bottom-overlay" | "image-only";
export type TitleScale = "standard" | "large";
export type ImageFocus = "center" | "top" | "bottom";
export type TextAlign = "left" | "center" | "right";
export type TextTone = "light" | "dark";
export type HeroOverlay = "none" | "soft" | "strong";

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
  };
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
