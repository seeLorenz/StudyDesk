// iPhone photos (HEIC/HEIF) into JPEG (design/guidelines.md, "Every chat box
// takes files").
//
// iPhones save photos as HEIC. Claude only takes PNG, JPEG, WebP and GIF, and
// only Safari can draw HEIC, so every HEIC that comes in (dropped, pasted,
// picked, or inside a course zip) is turned into a JPEG in the page first.
// Safari does it with its own decoder; every other browser uses a bundled
// libheif build (heic-to, LGPL-3.0), loaded only when a HEIC actually arrives.

const HEIC_EXT = /\.(heic|heif|hif)$/i;
const HEIC_TYPE = /^image\/(heic|heif)(-sequence)?$/i;

/** True for an iPhone photo (HEIC/HEIF), from its name or type. Pure. */
export function isHeic(name: string, type = ""): boolean {
  return HEIC_EXT.test(name) || HEIC_TYPE.test(type);
}

/** "IMG_5334.HEIC" -> "IMG_5334.jpg". Pure. */
export function jpegName(name: string): string {
  return HEIC_EXT.test(name) ? name.replace(HEIC_EXT, ".jpg") : `${name || "photo"}.jpg`;
}

export const HEIC_FAILED = "This iPhone photo (HEIC) couldn't be opened. Send it as a JPEG instead: on the iPhone, share it with Options > Most Compatible, or set Settings > Camera > Formats > Most Compatible.";

const QUALITY = 0.9;

/** Safari draws HEIC itself; other browsers throw here. */
async function viaBrowser(blob: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0);
  bmp.close?.();
  const out = await new Promise<Blob | null>((r) => canvas.toBlob(r, "image/jpeg", QUALITY));
  if (!out) throw new Error("no jpeg");
  return out;
}

async function viaLibheif(blob: Blob): Promise<Blob> {
  // The "csp" build needs no eval, which the artifact page doesn't allow.
  const { heicTo } = await import("heic-to/csp");
  return heicTo({ blob, type: "image/jpeg", quality: QUALITY });
}

/** Turns HEIC bytes into a JPEG. Throws HEIC_FAILED when neither decoder can read it. */
export async function heicToJpeg(blob: Blob): Promise<Blob> {
  try {
    return await viaBrowser(blob);
  } catch {
    /* not Safari: use libheif */
  }
  try {
    const out = await viaLibheif(blob);
    if (!out.size) throw new Error("empty");
    return out;
  } catch {
    throw new Error(HEIC_FAILED);
  }
}

/** The same file as a JPEG when it's an iPhone photo; any other file unchanged. */
export async function asJpegIfHeic(file: File): Promise<File> {
  if (!isHeic(file.name, file.type)) return file;
  const jpeg = await heicToJpeg(file);
  return new File([jpeg], jpegName(file.name), { type: "image/jpeg", lastModified: file.lastModified });
}
