// Phone photos are routinely larger than the 600KB the notice picture limit
// allows. This shrinks a picture in the browser (longest side, then JPEG
// quality) until it fits, and leaves a file that already fits untouched. The
// original is never uploaded in that case, and a picture that cannot be
// shrunk enough is refused so the operator sees why instead of a server 413.

export const NOTICE_IMAGE_MAX_BYTES = 600000;
const TYPES = ["image/png", "image/jpeg", "image/webp"];

export type FitResult = { file: File } | { error: string };

function blobOf(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
}

export async function fitImage(file: File, maxBytes = NOTICE_IMAGE_MAX_BYTES): Promise<FitResult> {
  if (!TYPES.includes(file.type)) return { error: "PNG, JPG, WEBP 이미지만 넣을 수 있습니다." };
  if (file.size > 0 && file.size <= maxBytes) return { file };
  if (typeof createImageBitmap !== "function") return { error: "이미지가 너무 큽니다. 600KB 이하로 줄여서 올려주세요." };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return { error: "이미지를 읽지 못했습니다. 다른 파일을 선택하세요." };
  }
  try {
    for (const longest of [1600, 1280, 1024, 800]) {
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
      for (const quality of [0.86, 0.74, 0.62]) {
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
  return { error: "이미지를 600KB 이하로 줄이지 못했습니다. 더 작은 이미지를 선택하세요." };
}
