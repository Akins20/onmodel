import { inflateSync, deflateSync } from "node:zlib";

/**
 * A small PNG codec on Node's own zlib, so the tool can read pixels (text contrast
 * on a native screen, where the view hierarchy carries no colours) and write the
 * raw framebuffer a device hands back, without an image library.
 *
 * Images are { width, height, data } with data an RGBA Uint8Array, row by row.
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** Whether a buffer starts with the PNG signature. */
export function isPNG(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length > 8 && buffer.subarray(0, 8).equals(SIGNATURE);
}

/**
 * Decodes a PNG into RGBA. Handles every colour type at bit depths 1 to 16, with
 * palette transparency. Interlaced files are refused with a clear error; screenshots
 * from browsers, devices and design tools are never interlaced.
 */
export function decodePNG(buffer) {
  if (!isPNG(buffer)) throw new Error("not a PNG file");
  let offset = 8;
  let header = null;
  let palette = null;
  let paletteAlpha = null;
  const idat = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length;
    if (type === "IHDR") {
      header = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        depth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") paletteAlpha = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
  }
  if (!header) throw new Error("PNG has no IHDR chunk");
  const { width, height, depth, colorType, interlace } = header;
  if (interlace) throw new Error("interlaced PNGs are not supported");
  const channels = CHANNELS[colorType];
  if (!channels) throw new Error(`unsupported PNG colour type ${colorType}`);
  if (colorType === 3 && !palette) throw new Error("palette PNG without a PLTE chunk");

  const raw = inflateSync(Buffer.concat(idat));
  const bitsPerPixel = channels * depth;
  const stride = Math.ceil((width * bitsPerPixel) / 8);
  const bpp = Math.max(1, bitsPerPixel >> 3);
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is truncated");

  // Undo the per-row filters in place, row by row.
  const rows = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    const prev = dst - stride;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= bpp ? rows[dst + x - bpp] : 0;
      const up = y > 0 ? rows[prev + x] : 0;
      const upLeft = y > 0 && x >= bpp ? rows[prev + x - bpp] : 0;
      let v = raw[src + x];
      if (filter === 1) v += left;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (left + up) >> 1;
      else if (filter === 4) v += paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unknown PNG filter ${filter}`);
      rows[dst + x] = v & 0xff;
    }
  }

  const out = new Uint8Array(width * height * 4);
  const maxValue = (1 << depth) - 1;
  const sample = (row, index) => {
    // The index-th sample of a row, scaled to 0..255.
    if (depth === 8) return rows[row + index];
    if (depth === 16) return rows[row + index * 2];
    const bitOffset = index * depth;
    const byte = rows[row + (bitOffset >> 3)];
    const shift = 8 - depth - (bitOffset & 7);
    const value = (byte >> shift) & maxValue;
    return colorType === 3 ? value : Math.round((value * 255) / maxValue);
  };
  for (let y = 0; y < height; y += 1) {
    const row = y * stride;
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = sample(row, x * 4);
        out[o + 1] = sample(row, x * 4 + 1);
        out[o + 2] = sample(row, x * 4 + 2);
        out[o + 3] = sample(row, x * 4 + 3);
      } else if (colorType === 2) {
        out[o] = sample(row, x * 3);
        out[o + 1] = sample(row, x * 3 + 1);
        out[o + 2] = sample(row, x * 3 + 2);
        out[o + 3] = 255;
      } else if (colorType === 0) {
        const g = sample(row, x);
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = 255;
      } else if (colorType === 4) {
        const g = sample(row, x * 2);
        out[o] = g;
        out[o + 1] = g;
        out[o + 2] = g;
        out[o + 3] = sample(row, x * 2 + 1);
      } else {
        const index = sample(row, x);
        out[o] = palette[index * 3] ?? 0;
        out[o + 1] = palette[index * 3 + 1] ?? 0;
        out[o + 2] = palette[index * 3 + 2] ?? 0;
        out[o + 3] = paletteAlpha && index < paletteAlpha.length ? paletteAlpha[index] : 255;
      }
    }
  }
  return { width, height, data: out };
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "latin1");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/**
 * Encodes an RGBA image as a PNG. Screens are mostly flat colour, so the first row
 * uses the Sub filter and the rest Up, which compresses them well at little cost.
 */
/** RGBA rows with PNG filter bytes (Sub on the first row, Up after), ready to deflate. Shared with the APNG writer. */
export function filterRows({ width, height, data }) {
  const stride = width * 4;
  const filtered = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const dst = y * (stride + 1);
    const row = y * stride;
    if (y === 0) {
      filtered[dst] = 1;
      for (let x = 0; x < stride; x += 1) filtered[dst + 1 + x] = (data[row + x] - (x >= 4 ? data[row + x - 4] : 0)) & 0xff;
    } else {
      filtered[dst] = 2;
      for (let x = 0; x < stride; x += 1) filtered[dst + 1 + x] = (data[row + x] - data[row + x - stride]) & 0xff;
    }
  }
  return filtered;
}

/** The IHDR payload for an 8-bit RGBA image. */
export function ihdrFor(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return ihdr;
}

export { chunk as pngChunk, SIGNATURE as PNG_SIGNATURE };

export function encodePNG(image) {
  return Buffer.concat([SIGNATURE, chunk("IHDR", ihdrFor(image.width, image.height)), chunk("IDAT", deflateSync(filterRows(image), { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

/** Reads the width and height of a PNG or JPEG from its header without decoding it. */
export function imageSize(buffer) {
  if (isPNG(buffer)) return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  if (buffer.length > 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
      const length = buffer.readUInt16BE(offset + 2);
      // Start-of-frame markers carry the dimensions; C4, C8 and CC are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
      }
      offset += 2 + length;
    }
  }
  return null;
}
