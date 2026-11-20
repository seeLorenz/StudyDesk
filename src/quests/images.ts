// Photos of answers are kept with the quest, so they can still be graded after
// a reload. Each one is shrunk to a JPEG that fits one database document
// (256 KiB), which is plenty for a page of handwriting.

const MAX_CHARS = 230_000;

export async function compressImage(blob: Blob): Promise<string | null> {
  try {
    const bmp = await createImageBitmap(blob);
    for (const [side, quality] of [
      [1800, 0.8],
      [1600, 0.7],
      [1400, 0.6],
      [1200, 0.55],
      [1000, 0.5],
      [800, 0.5],
    ] as const) {
      const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(bmp.width * scale);
      canvas.height = Math.round(bmp.height * scale);
      const ctx = canvas.getContext("2d")!;
      ctx.fillStyle = "#fff"; // transparent screenshots become white, not black
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= MAX_CHARS) return url;
    }
    return null;
  } catch {
    return null;
  }
}

export function dataUrlToBlob(url: string): Blob {
  const [head, body] = url.split(",");
  const type = /data:([^;]+)/.exec(head)?.[1] ?? "image/jpeg";
  const bin = atob(body);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}
