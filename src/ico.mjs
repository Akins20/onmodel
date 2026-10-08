import { encodePNG } from "./png.mjs";

/**
 * Windows icon files, written in plain JavaScript. Small sizes are stored as
 * 32-bit bitmaps with an AND mask, which every reader understands, back to the
 * oldest Windows; 256 px and larger are stored as PNG inside the icon, which
 * readers since Windows Vista accept and which is far smaller. Images are
 * { width, height, data } with RGBA samples.
 */

/** One size as an ICO bitmap: a BITMAPINFOHEADER, BGRA rows bottom up, then a 1-bit mask. */
function bitmapEntry({ width, height, data }) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(width, 4);
  header.writeInt32LE(height * 2, 8); // colour rows plus mask rows
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);
  const pixels = Buffer.alloc(width * height * 4);
  const maskStride = Math.ceil(width / 32) * 4;
  const mask = Buffer.alloc(maskStride * height);
  for (let y = 0; y < height; y++) {
    const row = height - 1 - y;
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (row * width + x) * 4;
      pixels[d] = data[s + 2];
      pixels[d + 1] = data[s + 1];
      pixels[d + 2] = data[s];
      pixels[d + 3] = data[s + 3];
      if (data[s + 3] === 0) mask[row * maskStride + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  header.writeUInt32LE(pixels.length + mask.length, 20);
  return Buffer.concat([header, pixels, mask]);
}

/** An .ico holding every image given, largest last; sizes above 255 px are stored as PNG. */
export function encodeICO(images) {
  if (!images.length) throw new Error("an icon file needs at least one image");
  for (const im of images) if (im.width !== im.height || im.width < 1 || im.width > 256) throw new Error(`icon images must be square, 1 to 256 px; got ${im.width}x${im.height}`);
  const sorted = [...images].sort((a, b) => a.width - b.width);
  const payloads = sorted.map((im) => (im.width >= 256 ? encodePNG(im) : bitmapEntry(im)));
  const head = Buffer.alloc(6);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(sorted.length, 4);
  const dir = Buffer.alloc(16 * sorted.length);
  let offset = 6 + dir.length;
  sorted.forEach((im, i) => {
    const e = i * 16;
    dir[e] = im.width >= 256 ? 0 : im.width;
    dir[e + 1] = im.height >= 256 ? 0 : im.height;
    dir[e + 2] = 0;
    dir[e + 3] = 0;
    dir.writeUInt16LE(1, e + 4);
    dir.writeUInt16LE(32, e + 6);
    dir.writeUInt32LE(payloads[i].length, e + 8);
    dir.writeUInt32LE(offset, e + 12);
    offset += payloads[i].length;
  });
  return Buffer.concat([head, dir, ...payloads]);
}

/** The sizes and formats an .ico holds, for checks and reports. */
export function icoInfo(buffer) {
  if (buffer.readUInt16LE(0) !== 0 || buffer.readUInt16LE(2) !== 1) throw new Error("not an icon file");
  const count = buffer.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const e = 6 + i * 16;
    const width = buffer[e] || 256;
    const size = buffer.readUInt32LE(e + 8);
    const offset = buffer.readUInt32LE(e + 12);
    const png = buffer[offset] === 0x89 && buffer[offset + 1] === 0x50;
    entries.push({ width, height: buffer[e + 1] || 256, bytes: size, format: png ? "png" : "bmp" });
  }
  return entries;
}
