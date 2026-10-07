import { decodePNG, isPNG, encodePNG, imageSize } from "./png.mjs";
import { decodeJPEG, isJPEG } from "./jpeg.mjs";

/**
 * One door for image bytes: what format they are, and the same RGBA shape back
 * whether the model answered in JPEG or a reference came in as PNG. WebP and GIF
 * are recognised so a reference in those formats can still be sent to the model,
 * but they are not decoded here; measuring them needs the browser.
 */

export function mimeOf(buffer) {
  if (!buffer || buffer.length < 12) return null;
  if (isPNG(buffer)) return "image/png";
  if (isJPEG(buffer)) return "image/jpeg";
  if (buffer[0] === 0x52 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x46 && buffer[8] === 0x57 && buffer[9] === 0x45 && buffer[10] === 0x42 && buffer[11] === 0x50) return "image/webp";
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return "image/gif";
  return null;
}

/** Decodes PNG or JPEG bytes to { width, height, data } with RGBA samples. */
export function decodeImage(buffer) {
  const mime = mimeOf(buffer);
  if (mime === "image/png") return decodePNG(buffer);
  if (mime === "image/jpeg") return decodeJPEG(buffer);
  if (mime) throw new Error(`${mime} cannot be decoded without a browser; convert it to PNG or JPEG first`);
  throw new Error("not an image the tool recognises (PNG, JPEG, WebP or GIF)");
}

export { encodePNG, imageSize };
