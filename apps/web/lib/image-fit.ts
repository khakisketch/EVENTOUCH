// Phone photos are routinely larger than the 600KB the notice picture limit
// allows. This shrinks a picture in the browser (longest side, then JPEG
// quality) until it fits, and leaves a file that already fits untouched. The
// original is never uploaded in that case, and a picture that cannot be
// shrunk enough is refused so the operator sees why instead of a server 413.

export const NOTICE_IMAGE_MAX_BYTES = 600000;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

export type FitResult = { file: File } | { error: string };
export type FitOptions = {
  // MMS only accepts JPEG: a small PNG/WEBP is converted instead of passed through.
  requireJpeg?: boolean;
};

// "200KB" / "600KB" for a byte limit, "3.5MB" for a file size.
export function formatImageBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(Math.round(bytes / 100_000) / 10).toString()}MB`;
  return `${Math.max(1, Math.round(bytes / 1000))}KB`;
}

function blobOf(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export async function fitImage(file: File, maxBytes = NOTICE_IMAGE_MAX_BYTES, options: FitOptions = {}): Promise<FitResult> {
  const limit = formatImageBytes(maxBytes);
  if (!TYPES.includes(file.type)) return { error: "PNG, JPG, WEBP 이미지만 넣을 수 있습니다." };
  if (file.size > 0 && file.size <= maxBytes && (!options.requireJpeg || file.type === "image/jpeg")) return { file };
  if (typeof createImageBitmap !== "function") return { error: `이미지가 너무 큽니다. ${limit} 이하로 줄여서 올려주세요.` };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: "이미지를 읽지 못했습니다. 다른 파일을 선택하세요." };
  }
  try {
    // A tight limit (MMS 200KB) needs smaller steps than the notice picture does.
    const tight = maxBytes < NOTICE_IMAGE_MAX_BYTES;
    const sizes = tight ? [1280, 1024, 800, 640, 480] : [1600, 1280, 1024, 800];
    const qualities = tight ? [0.8, 0.7, 0.6, 0.5, 0.4] : [0.86, 0.74, 0.62];
    for (const longest of sizes) {
      const scale = Math.min(1, longest / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) break;
      // JPEG has no alpha: a transparent PNG would turn black without a base.
      context.fillStyle = "#fff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      for (const quality of qualities) {
        const blob = await blobOf(canvas, quality);
        if (blob && blob.size <= maxBytes) {
          const name = file.name.replace(/\.[^.]+$/, "") || "image";
          return { file: new File([blob], `${name}.jpg`, { type: "image/jpeg" }) };
        }
      }
    }
  } finally {
    bitmap.close();
  }
  return { error: `이미지를 ${limit} 이하로 줄이지 못했습니다. 더 작은 이미지를 선택하세요.` };
}
