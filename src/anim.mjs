import { deflateSync } from "node:zlib";
import { pngChunk, filterRows, ihdrFor, PNG_SIGNATURE } from "./png.mjs";
import { medianCut, labOf, deltaE76 } from "./key.mjs";

/**
 * Animated previews a person can open: APNG (full colour with real alpha, what a
 * browser or a chat shows) and GIF (what everything else shows, 256 colours and
 * hard transparency, which suits pixel art exactly). Both are written here on top
 * of the PNG codec and plain arithmetic, so no image library is needed.
 *
 * Frames are { image, delayMs }, every image the same size.
 */

const sameSize = (frames) => {
  if (!frames.length) throw new Error("an animation needs at least one frame");
  const { width, height } = frames[0].image;
  for (const f of frames) if (f.image.width !== width || f.image.height !== height) throw new Error("every frame of an animation must be the same size");
  return { width, height };
};

/**
 * APNG: an acTL after the header, then for each frame an fcTL and the frame's data,
 * the first as IDAT and the rest as fdAT. Each frame is full size, drawn over a
 * cleared canvas, so transparency is honest frame to frame. `loops` 0 is forever.
 */
export function encodeAPNG(frames, { loops = 0 } = {}) {
  const { width, height } = sameSize(frames);
  const parts = [PNG_SIGNATURE, pngChunk("IHDR", ihdrFor(width, height))];
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(frames.length, 0);
  actl.writeUInt32BE(loops, 4);
  parts.push(pngChunk("acTL", actl));
  let seq = 0;
  frames.forEach((f, i) => {
    const delay = Math.max(1, Math.round(f.delayMs ?? 100));
    const fctl = Buffer.alloc(26);
    fctl.writeUInt32BE(seq++, 0);
    fctl.writeUInt32BE(width, 4);
    fctl.writeUInt32BE(height, 8);
    fctl.writeUInt32BE(0, 12);
    fctl.writeUInt32BE(0, 16);
    fctl.writeUInt16BE(delay, 20);
    fctl.writeUInt16BE(1000, 22);
    fctl[24] = 1; // dispose to transparent before the next frame
    fctl[25] = 0; // draw over, no blending
    parts.push(pngChunk("fcTL", fctl));
    const data = deflateSync(filterRows(f.image), { level: 6 });
    if (i === 0) parts.push(pngChunk("IDAT", data));
    else {
      const fdat = Buffer.alloc(4 + data.length);
      fdat.writeUInt32BE(seq++, 0);
      data.copy(fdat, 4);
      parts.push(pngChunk("fdAT", fdat));
    }
  });
  parts.push(pngChunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(parts);
}

/** A palette of up to 255 colours for a set of frames, leaving one index for transparency. */
export function gifPalette(frames, { alphaMin = 128, max = 255 } = {}) {
  const seen = new Map();
  const samples = [];
  for (const f of frames) {
    const { width, height, data } = f.image;
    const step = Math.max(1, Math.floor((width * height * frames.length) / 120_000));
    for (let i = 0; i < width * height; i += step) {
      const p = i * 4;
      if (data[p + 3] < alphaMin) continue;
      const key = (data[p] << 16) | (data[p + 1] << 8) | data[p + 2];
      if (!seen.has(key)) {
        seen.set(key, true);
        samples.push([data[p], data[p + 1], data[p + 2]]);
      }
    }
  }
  if (samples.length <= max) return samples;
  return medianCut(samples, max);
}

/** GIF LZW: codes packed least-significant bit first into sub-blocks of at most 255 bytes. */
function lzwEncode(indices, minCodeSize) {
  const out = [];
  let block = [];
  let acc = 0;
  let accBits = 0;
  const emit = (code, size) => {
    acc |= code << accBits;
    accBits += size;
    while (accBits >= 8) {
      block.push(acc & 0xff);
      acc >>>= 8;
      accBits -= 8;
      if (block.length === 255) {
        out.push(255, ...block);
        block = [];
      }
    }
  };
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  let dict = new Map();
  let next = eoi + 1;
  let codeSize = minCodeSize + 1;
  const reset = () => {
    dict = new Map();
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };
  emit(clear, codeSize);
  let prefix = -1;
  for (const k of indices) {
    if (prefix < 0) {
      prefix = k;
      continue;
    }
    const key = (prefix << 8) | k;
    const hit = dict.get(key);
    if (hit !== undefined) {
      prefix = hit;
      continue;
    }
    emit(prefix, codeSize);
    if (next < 4096) {
      dict.set(key, next++);
      if (next - 1 === 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clear, codeSize);
      reset();
    }
    prefix = k;
  }
  if (prefix >= 0) emit(prefix, codeSize);
  emit(eoi, codeSize);
  if (accBits > 0) block.push(acc & 0xff);
  if (block.length) out.push(block.length, ...block);
  out.push(0);
  return Buffer.from(out);
}

/**
 * GIF89a with a global palette, one image per frame over the whole canvas, each
 * disposed to the background so transparency holds, and a loop extension.
 */
export function encodeGIF(frames, { loops = 0, palette = null, alphaMin = 128 } = {}) {
  const { width, height } = sameSize(frames);
  const colours = (palette ?? gifPalette(frames, { alphaMin })).slice(0, 255);
  if (!colours.length) colours.push([0, 0, 0]);
  const transparent = colours.length;
  let size = 2;
  let bits = 1;
  while (size < colours.length + 1) {
    size <<= 1;
    bits++;
  }
  const table = Buffer.alloc(size * 3);
  colours.forEach((c, i) => table.set(c, i * 3));
  const labs = colours.map((c) => labOf(...c));
  const memo = new Map();
  const nearest = (r, g, b) => {
    const key = (r << 16) | (g << 8) | b;
    let hit = memo.get(key);
    if (hit !== undefined) return hit;
    const lab = labOf(r, g, b);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < labs.length; i++) {
      const d = deltaE76(lab, labs[i]);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    memo.set(key, best);
    return best;
  };
  const parts = [Buffer.from("GIF89a", "ascii")];
  const screen = Buffer.alloc(7);
  screen.writeUInt16LE(width, 0);
  screen.writeUInt16LE(height, 2);
  screen[4] = 0x80 | ((bits - 1) << 4) | (bits - 1);
  screen[5] = 0;
  screen[6] = 0;
  parts.push(screen, table);
  const netscape = Buffer.from([0x21, 0xff, 0x0b, ...Buffer.from("NETSCAPE2.0", "ascii"), 0x03, 0x01, loops & 0xff, (loops >> 8) & 0xff, 0x00]);
  parts.push(netscape);
  const minCodeSize = Math.max(2, bits);
  for (const f of frames) {
    const delay = Math.max(2, Math.round((f.delayMs ?? 100) / 10));
    const gce = Buffer.from([0x21, 0xf9, 0x04, (2 << 2) | 1, delay & 0xff, (delay >> 8) & 0xff, transparent, 0x00]);
    const descriptor = Buffer.alloc(10);
    descriptor[0] = 0x2c;
    descriptor.writeUInt16LE(0, 1);
    descriptor.writeUInt16LE(0, 3);
    descriptor.writeUInt16LE(width, 5);
    descriptor.writeUInt16LE(height, 7);
    descriptor[9] = 0;
    const indices = new Uint8Array(width * height);
    const { data } = f.image;
    for (let i = 0; i < width * height; i++) {
      const p = i * 4;
      indices[i] = data[p + 3] < alphaMin ? transparent : nearest(data[p], data[p + 1], data[p + 2]);
    }
    parts.push(gce, descriptor, Buffer.from([minCodeSize]), lzwEncode(indices, minCodeSize));
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

/** Reads the frame count and the first frame's delay out of an APNG, for tests and reports. */
export function apngInfo(buffer) {
  let pos = 8;
  let frames = 0;
  let delays = [];
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString("ascii", pos + 4, pos + 8);
    if (type === "acTL") frames = buffer.readUInt32BE(pos + 8);
    if (type === "fcTL") delays.push((buffer.readUInt16BE(pos + 8 + 20) * 1000) / buffer.readUInt16BE(pos + 8 + 22));
    if (type === "IEND") break;
    pos += 12 + len;
  }
  return { frames, delaysMs: delays };
}
