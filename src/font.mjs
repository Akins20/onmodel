/**
 * TrueType outlines, read straight out of the font.
 *
 * The image models cannot be trusted with letters, and no measurement onmodel takes could
 * catch it if they got one wrong: silhouette, colour and drift have no notion of whether
 * that shape is an R. So letters are not painted here and not measured afterwards, they
 * are read from the font the type designer drew, which makes them right by construction
 * rather than right on inspection.
 *
 * What is parsed: the sfnt table directory, `head` for the units the outlines are drawn
 * in, `maxp` for how many glyphs there are, `cmap` for which glyph a character is,
 * `loca` for where each glyph sits in `glyf`, `glyf` for the outline itself, `hhea` and
 * `hmtx` for how far to step after each one, and `kern` for the pairs that need closing
 * up. Outlines are quadratic, as TrueType stores them, and come out as the cubics the
 * rest of onmodel already writes.
 *
 * OpenType's other flavour keeps its outlines in a CFF table as Type 2 charstrings, which
 * is a different parser entirely; such a font is named and turned down rather than read
 * wrongly.
 */

const tag = (buf, at) => buf.toString("latin1", at, at + 4);

/** Where each table is, by its four-letter tag. */
function tableDirectory(buf) {
  if (buf.length < 12) throw new Error("this file is too short to be a font");
  const kind = tag(buf, 0);
  if (kind === "ttcf") throw new Error("this is a font collection (.ttc); pass one font, not a collection");
  if (kind === "OTTO") throw new Error("this is an OpenType font with CFF outlines; onmodel reads TrueType outlines (.ttf), so use the TrueType build of this family");
  if (kind !== "\u0000\u0001\u0000\u0000" && kind !== "true" && kind !== "typ1") throw new Error("this file is not a TrueType font");
  const count = buf.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < count; i++) {
    const at = 12 + i * 16;
    if (at + 16 > buf.length) break;
    tables.set(tag(buf, at), { offset: buf.readUInt32BE(at + 8), length: buf.readUInt32BE(at + 12) });
  }
  return tables;
}

/** Character code to glyph id, from the best cmap subtable the font offers. */
function readCmap(buf, at) {
  const count = buf.readUInt16BE(at + 2);
  let best = null;
  let bestScore = -1;
  for (let i = 0; i < count; i++) {
    const rec = at + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = buf.readUInt32BE(rec + 4);
    // Windows full Unicode first, then Windows BMP, then anything Unicode.
    const score = platform === 3 && encoding === 10 ? 4 : platform === 3 && encoding === 1 ? 3 : platform === 0 ? 2 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = at + offset;
    }
  }
  if (best == null) throw new Error("this font has no character map");
  const map = new Map();
  const format = buf.readUInt16BE(best);
  if (format === 4) {
    const segX2 = buf.readUInt16BE(best + 6);
    const segs = segX2 / 2;
    const ends = best + 14;
    const starts = ends + segX2 + 2;
    const deltas = starts + segX2;
    const ranges = deltas + segX2;
    for (let s = 0; s < segs; s++) {
      const end = buf.readUInt16BE(ends + s * 2);
      const start = buf.readUInt16BE(starts + s * 2);
      const delta = buf.readInt16BE(deltas + s * 2);
      const rangeAt = ranges + s * 2;
      const range = buf.readUInt16BE(rangeAt);
      if (start === 0xffff) continue;
      for (let c = start; c <= end && c !== 0x10000; c++) {
        let g;
        if (range === 0) g = (c + delta) & 0xffff;
        else {
          const p = rangeAt + range + (c - start) * 2;
          if (p + 2 > buf.length) continue;
          g = buf.readUInt16BE(p);
          if (g) g = (g + delta) & 0xffff;
        }
        if (g) map.set(c, g);
      }
    }
  } else if (format === 12) {
    const groups = buf.readUInt32BE(best + 12);
    for (let i = 0; i < groups; i++) {
      const g = best + 16 + i * 12;
      const start = buf.readUInt32BE(g);
      const end = buf.readUInt32BE(g + 4);
      const gid = buf.readUInt32BE(g + 8);
      for (let c = start; c <= end && c - start < 0x10000; c++) map.set(c, gid + (c - start));
    }
  } else throw new Error(`this font's character map is in format ${format}, which onmodel does not read`);
  return map;
}

/** How far the pen moves after each glyph. */
function readMetrics(buf, hhea, hmtx, numGlyphs) {
  const pairs = buf.readUInt16BE(hhea.offset + 34);
  const advances = new Int32Array(numGlyphs);
  let last = 0;
  for (let g = 0; g < numGlyphs; g++) {
    if (g < pairs) {
      const at = hmtx.offset + g * 4;
      last = at + 2 <= buf.length ? buf.readUInt16BE(at) : last;
    }
    advances[g] = last;
  }
  return advances;
}

/** Pairs the designer wants closed up or opened out, from the old kern table. */
function readKern(buf, kern) {
  const pairs = new Map();
  if (!kern) return pairs;
  const tables = buf.readUInt16BE(kern.offset + 2);
  let at = kern.offset + 4;
  for (let t = 0; t < tables && at + 14 <= buf.length; t++) {
    const length = buf.readUInt16BE(at + 2);
    const coverage = buf.readUInt16BE(at + 4);
    if ((coverage & 0xff00) === 0) {
      const n = buf.readUInt16BE(at + 6);
      for (let i = 0; i < n; i++) {
        const p = at + 14 + i * 6;
        if (p + 6 > buf.length) break;
        pairs.set(`${buf.readUInt16BE(p)},${buf.readUInt16BE(p + 2)}`, buf.readInt16BE(p + 4));
      }
    }
    at += length || 14;
  }
  return pairs;
}

const ON_CURVE = 1;
const X_SHORT = 2;
const Y_SHORT = 4;
const REPEAT = 8;
const X_SAME = 16;
const Y_SAME = 32;

/**
 * One glyph's contours, as points with a flag for whether each sits on the curve.
 *
 * A composite glyph is other glyphs placed by an offset, which is how an accented letter
 * is usually stored; those are read through to their parts, to a bounded depth, because
 * nothing stops a broken font pointing a glyph at itself.
 */
function readGlyph(buf, glyf, loca, long, index, numGlyphs, depth = 0) {
  if (index < 0 || index >= numGlyphs || depth > 5) return [];
  const start = long ? buf.readUInt32BE(loca.offset + index * 4) : buf.readUInt16BE(loca.offset + index * 2) * 2;
  const end = long ? buf.readUInt32BE(loca.offset + index * 4 + 4) : buf.readUInt16BE(loca.offset + index * 2 + 2) * 2;
  if (end <= start) return [];
  const at = glyf.offset + start;
  if (at + 10 > buf.length) return [];
  const contourCount = buf.readInt16BE(at);

  if (contourCount < 0) {
    const out = [];
    let p = at + 10;
    for (;;) {
      if (p + 4 > buf.length) break;
      const flags = buf.readUInt16BE(p);
      const glyphIndex = buf.readUInt16BE(p + 2);
      p += 4;
      let dx = 0;
      let dy = 0;
      if (flags & 1) {
        dx = buf.readInt16BE(p);
        dy = buf.readInt16BE(p + 2);
        p += 4;
      } else {
        dx = buf.readInt8(p);
        dy = buf.readInt8(p + 1);
        p += 2;
      }
      let a = 1;
      let b = 0;
      let c = 0;
      let d = 1;
      const f2 = (v) => v / 16384;
      if (flags & 8) {
        a = d = f2(buf.readInt16BE(p));
        p += 2;
      } else if (flags & 0x40) {
        a = f2(buf.readInt16BE(p));
        d = f2(buf.readInt16BE(p + 2));
        p += 4;
      } else if (flags & 0x80) {
        a = f2(buf.readInt16BE(p));
        b = f2(buf.readInt16BE(p + 2));
        c = f2(buf.readInt16BE(p + 4));
        d = f2(buf.readInt16BE(p + 6));
        p += 8;
      }
      // ARGS_ARE_XY_VALUES is the common case; point matching is not supported.
      if (flags & 2) {
        for (const contour of readGlyph(buf, glyf, loca, long, glyphIndex, numGlyphs, depth + 1)) {
          out.push(contour.map((pt) => ({ x: a * pt.x + c * pt.y + dx, y: b * pt.x + d * pt.y + dy, on: pt.on })));
        }
      }
      if (!(flags & 0x20)) break;
    }
    return out;
  }

  let p = at + 10;
  const ends = [];
  for (let i = 0; i < contourCount; i++) {
    ends.push(buf.readUInt16BE(p));
    p += 2;
  }
  const points = ends.length ? ends[ends.length - 1] + 1 : 0;
  p += 2 + buf.readUInt16BE(p); // the hinting instructions, which outlines do not need
  const flags = new Uint8Array(points);
  for (let i = 0; i < points; ) {
    if (p >= buf.length) return [];
    const f = buf[p++];
    flags[i++] = f;
    if (f & REPEAT) {
      let n = buf[p++];
      while (n-- > 0 && i < points) flags[i++] = f;
    }
  }
  const xs = new Int32Array(points);
  let x = 0;
  for (let i = 0; i < points; i++) {
    const f = flags[i];
    if (f & X_SHORT) x += (f & X_SAME ? 1 : -1) * buf[p++];
    else if (!(f & X_SAME)) {
      x += buf.readInt16BE(p);
      p += 2;
    }
    xs[i] = x;
  }
  const ys = new Int32Array(points);
  let y = 0;
  for (let i = 0; i < points; i++) {
    const f = flags[i];
    if (f & Y_SHORT) y += (f & Y_SAME ? 1 : -1) * buf[p++];
    else if (!(f & Y_SAME)) {
      y += buf.readInt16BE(p);
      p += 2;
    }
    ys[i] = y;
  }
  const out = [];
  let from = 0;
  for (const endAt of ends) {
    const contour = [];
    for (let i = from; i <= endAt && i < points; i++) contour.push({ x: xs[i], y: ys[i], on: Boolean(flags[i] & ON_CURVE) });
    if (contour.length) out.push(contour);
    from = endAt + 1;
  }
  return out;
}

/**
 * A glyph's contours as path commands.
 *
 * TrueType draws with quadratic curves and leaves out the points between two curves:
 * where two off-curve points sit next to each other, the on-curve point halfway between
 * them is implied and has to be put back. A contour may even begin on an off-curve point,
 * in which case the start has to be found before anything can be drawn. Each quadratic
 * becomes the cubic the rest of onmodel writes.
 */
export function contourToPath(contour, at = (p) => [p.x, p.y]) {
  if (contour.length < 2) return "";
  const pts = contour.slice();
  let startIndex = pts.findIndex((p) => p.on);
  if (startIndex < 0) {
    // Every point is off the curve, so the start is halfway between the last and first.
    const a = pts[pts.length - 1];
    const b = pts[0];
    pts.unshift({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, on: true });
    startIndex = 0;
  }
  const order = pts.slice(startIndex).concat(pts.slice(0, startIndex));
  const start = at(order[0]);
  let d = `M${start[0]} ${start[1]}`;
  let cur = start;
  let pending = null;
  // The control points are worked out here rather than coming through `at`, so they are
  // rounded here too; left at full precision they tripled the size of the path text.
  const quad = (control, to) => {
    const c1 = [r3(cur[0] + (2 / 3) * (control[0] - cur[0])), r3(cur[1] + (2 / 3) * (control[1] - cur[1]))];
    const c2 = [r3(to[0] + (2 / 3) * (control[0] - to[0])), r3(to[1] + (2 / 3) * (control[1] - to[1]))];
    d += `C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${to[0]} ${to[1]}`;
    cur = to;
  };
  for (let i = 1; i <= order.length; i++) {
    const p = order[i % order.length];
    const xy = at(p);
    if (p.on) {
      if (pending) {
        quad(pending, xy);
        pending = null;
      } else {
        d += `L${xy[0]} ${xy[1]}`;
        cur = xy;
      }
    } else if (pending) {
      // Two curves in a row: the point between them was left out, so put it back.
      quad(pending, [(pending[0] + xy[0]) / 2, (pending[1] + xy[1]) / 2]);
      pending = xy;
    } else pending = xy;
  }
  if (pending) quad(pending, start);
  return `${d}Z`;
}

/** A font, opened once and asked for glyphs by character. */
export function loadFont(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const tables = tableDirectory(buf);
  for (const need of ["head", "maxp", "cmap", "loca", "glyf", "hhea", "hmtx"]) {
    if (!tables.has(need)) {
      if (need === "glyf" && tables.has("CFF ")) throw new Error("this font keeps its outlines in a CFF table; onmodel reads TrueType outlines, so use the TrueType build of this family");
      throw new Error(`this font has no ${need.trim()} table, so its outlines cannot be read`);
    }
  }
  const head = tables.get("head");
  const unitsPerEm = buf.readUInt16BE(head.offset + 18) || 1000;
  const long = buf.readInt16BE(head.offset + 50) === 1;
  const numGlyphs = buf.readUInt16BE(tables.get("maxp").offset + 4);
  const cmap = readCmap(buf, tables.get("cmap").offset);
  const advances = readMetrics(buf, tables.get("hhea"), tables.get("hmtx"), numGlyphs);
  const kern = readKern(buf, tables.get("kern"));
  const ascender = buf.readInt16BE(tables.get("hhea").offset + 4);
  const descender = buf.readInt16BE(tables.get("hhea").offset + 6);
  const outlines = (gid) => readGlyph(buf, tables.get("glyf"), tables.get("loca"), long, gid, numGlyphs);
  // How tall a capital stands. It is what the eye lines a symbol up with, not the
  // ascender, which includes the room left above for accents. Measured off the H rather
  // than taken from OS/2, which plenty of fonts leave at zero or simply get wrong.
  let capHeight = 0;
  const h = cmap.get(0x48);
  if (h) for (const contour of outlines(h)) for (const pt of contour) if (pt.y > capHeight) capHeight = pt.y;
  if (!capHeight) {
    const os2 = tables.get("OS/2");
    if (os2 && buf.readUInt16BE(os2.offset) >= 2 && os2.offset + 90 <= buf.length) capHeight = buf.readInt16BE(os2.offset + 88);
  }
  if (capHeight <= 0) capHeight = Math.round(ascender * 0.7);
  return {
    unitsPerEm,
    numGlyphs,
    ascender,
    descender,
    capHeight,
    glyphFor: (codepoint) => cmap.get(codepoint) ?? 0,
    advanceOf: (gid) => advances[gid] ?? 0,
    kernBetween: (a, b) => kern.get(`${a},${b}`) ?? 0,
    contoursOf: outlines,
    has: (codepoint) => cmap.has(codepoint),
  };
}

/**
 * A line of text as one path, laid out left to right at the given size.
 *
 * The y axis is flipped on the way out, because a font measures up from the baseline and
 * an SVG measures down from the top. Letter spacing is in thousandths of the size, which
 * is how tracking is given everywhere else.
 */
export function textPath(font, text, { size = 100, letterSpacing = 0, kerning = true, x = 0, y = null } = {}) {
  const scale = size / font.unitsPerEm;
  const baseline = y ?? font.ascender * scale;
  const chars = Array.from(String(text));
  const missing = [];
  const blank = [];
  let pen = 0;
  const parts = [];
  let prev = null;
  for (const ch of chars) {
    const code = ch.codePointAt(0);
    const space = /^\s$/.test(ch);
    if (!font.has(code) && !space) missing.push(ch);
    const gid = font.glyphFor(code);
    if (kerning && prev != null) pen += font.kernBetween(prev, gid);
    let drew = 0;
    for (const contour of font.contoursOf(gid)) {
      const d = contourToPath(contour, (p) => [r3(x + (pen + p.x) * scale), r3(baseline - p.y * scale)]);
      if (d) {
        parts.push(d);
        drew++;
      }
    }
    // A letter that reads as present but draws nothing would leave a hole in the word
    // with nothing to say so, which is the one way setting type can still go wrong.
    if (!drew && !space && !missing.includes(ch)) blank.push(ch);
    pen += font.advanceOf(gid) + (letterSpacing * font.unitsPerEm) / 1000;
    prev = gid;
  }
  return {
    d: parts.join(""),
    width: r3(pen * scale),
    height: r3((font.ascender - font.descender) * scale),
    baseline: r3(baseline),
    glyphs: chars.length,
    missing,
    blank,
  };
}

const r3 = (v) => {
  const s = (Math.round(v * 1000) / 1000).toFixed(3).replace(/\.?0+$/, "");
  return s === "-0" ? 0 : Number(s);
};
