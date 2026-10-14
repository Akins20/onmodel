/**
 * Glyph outlines, read straight out of the font.
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
 * `hmtx` for how far to step after each one, and GPOS (or the old `kern` table) for the
 * pairs that need closing up. Outlines are quadratic, as TrueType stores them, and come out as the cubics the
 * rest of onmodel already writes.
 *
 * OpenType's other flavour (.otf) keeps its outlines in a CFF or CFF2 table as Type 2
 * charstrings, which are cubic already; cff.mjs reads those, and everything else about the
 * font (character map, advances, kerning) is the same tables either way.
 */

import { readCFF } from "./cff.mjs";

const tag = (buf, at) => buf.toString("latin1", at, at + 4);

/** Where each table is, by its four-letter tag. */
function tableDirectory(buf) {
  if (buf.length < 12) throw new Error("this file is too short to be a font");
  const kind = tag(buf, 0);
  if (kind === "ttcf") throw new Error("this is a font collection (.ttc); pass one font, not a collection");
  if (kind !== "\u0000\u0001\u0000\u0000" && kind !== "true" && kind !== "typ1" && kind !== "OTTO") throw new Error("this file is not a TrueType or OpenType font");
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
  let symbol = false;
  for (let i = 0; i < count; i++) {
    const rec = at + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const offset = buf.readUInt32BE(rec + 4);
    // Windows full Unicode first, then Windows BMP, then anything Unicode, then a Windows symbol
    // map (dingbat and icon fonts keep their only real map there), then anything else.
    const score = platform === 3 && encoding === 10 ? 5 : platform === 3 && encoding === 1 ? 4 : platform === 0 ? 3 : platform === 3 && encoding === 0 ? 2 : 0;
    if (score > bestScore) {
      bestScore = score;
      best = at + offset;
      symbol = platform === 3 && encoding === 0;
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
  map.symbol = symbol;
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

/** Where a glyph sits in a coverage table, or -1 when it is not covered. */
function coverageIndex(buf, at, gid) {
  const format = buf.readUInt16BE(at);
  const count = buf.readUInt16BE(at + 2);
  if (format === 1) {
    let lo = 0;
    let hi = count - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const g = buf.readUInt16BE(at + 4 + mid * 2);
      if (g === gid) return mid;
      if (g < gid) lo = mid + 1;
      else hi = mid - 1;
    }
    return -1;
  }
  if (format === 2) {
    for (let i = 0; i < count; i++) {
      const r = at + 4 + i * 6;
      const start = buf.readUInt16BE(r);
      const end = buf.readUInt16BE(r + 2);
      if (gid >= start && gid <= end) return buf.readUInt16BE(r + 4) + gid - start;
    }
  }
  return -1;
}

/** A glyph's class in a class definition table; a glyph it does not name is class 0. */
function glyphClass(buf, at, gid) {
  const format = buf.readUInt16BE(at);
  if (format === 1) {
    const start = buf.readUInt16BE(at + 2);
    const count = buf.readUInt16BE(at + 4);
    return gid >= start && gid < start + count ? buf.readUInt16BE(at + 6 + (gid - start) * 2) : 0;
  }
  if (format === 2) {
    const count = buf.readUInt16BE(at + 2);
    for (let i = 0; i < count; i++) {
      const r = at + 4 + i * 6;
      if (gid >= buf.readUInt16BE(r) && gid <= buf.readUInt16BE(r + 2)) return buf.readUInt16BE(r + 4);
    }
  }
  return 0;
}

const valueSize = (format) => {
  let n = 0;
  for (let bit = format; bit; bit >>= 1) n += bit & 1;
  return n * 2;
};

/**
 * What a value record does to the pen: the first glyph's x advance plus the second
 * glyph's x placement, which for a pair of letters set left to right is the kerning.
 */
function valueKern(buf, at, format) {
  let k = 0;
  let p = at;
  if (format & 0x0001) {
    p += 2; // x placement of the first glyph moves it, not the pen
  }
  if (format & 0x0002) p += 2;
  if (format & 0x0004) k += buf.readInt16BE(p);
  return k;
}

/**
 * Pair kerning from GPOS, which is where nearly every font made this century keeps it.
 *
 * Followed the way HarfBuzz follows it, because that is what every engine that shapes text
 * does. The script is Latin, else the default, and its default language's `kern` feature
 * names the lookups, which apply in order and add up. Within one lookup the first subtable
 * that applies wins, and "applies" differs by format: a class-based subtable (format 2)
 * applies whenever it covers the first glyph, but a glyph-pair subtable (format 1) only
 * when it has a record for this exact second glyph; otherwise the next subtable is tried.
 * Fonts put a format 1 subtable of exceptions before a format 2 one of classes on purpose,
 * and treating format 1 as final dropped most of Calibri's kerning (A with T among them).
 */
function readGposKern(buf, gpos) {
  if (!gpos) return null;
  const base = gpos.offset;
  if (base + 10 > buf.length) return null;
  const scriptList = base + buf.readUInt16BE(base + 4);
  const featureList = base + buf.readUInt16BE(base + 6);
  const lookupList = base + buf.readUInt16BE(base + 8);
  const scripts = new Map();
  const nScripts = buf.readUInt16BE(scriptList);
  for (let i = 0; i < nScripts; i++) scripts.set(tag(buf, scriptList + 2 + i * 6), scriptList + buf.readUInt16BE(scriptList + 6 + i * 6));
  const script = ["latn", "DFLT", "dflt"].map((t) => scripts.get(t)).find((s) => s != null);
  if (script == null) return null;
  const langOffset = buf.readUInt16BE(script);
  if (!langOffset) return null;
  const lang = script + langOffset;
  const featureCount = buf.readUInt16BE(lang + 4);
  const lookups = new Set();
  for (let i = 0; i < featureCount; i++) {
    const fi = buf.readUInt16BE(lang + 6 + i * 2);
    const rec = featureList + 2 + fi * 6;
    if (tag(buf, rec) !== "kern") continue;
    const feature = featureList + buf.readUInt16BE(rec + 4);
    const n = buf.readUInt16BE(feature + 2);
    for (let k = 0; k < n; k++) lookups.add(buf.readUInt16BE(feature + 4 + k * 2));
  }
  if (!lookups.size) return null;
  const subtables = [...lookups]
    .sort((a, b) => a - b)
    .map((index) => {
      const lookup = lookupList + buf.readUInt16BE(lookupList + 2 + index * 2);
      const type = buf.readUInt16BE(lookup);
      const count = buf.readUInt16BE(lookup + 4);
      const list = [];
      for (let s = 0; s < count; s++) {
        let at = lookup + buf.readUInt16BE(lookup + 6 + s * 2);
        let kind = type;
        if (kind === 9) {
          kind = buf.readUInt16BE(at + 2);
          at += buf.readUInt32BE(at + 4);
        }
        if (kind === 2) list.push(at);
      }
      return list;
    })
    .filter((list) => list.length);
  if (!subtables.length) return null;
  const pairIn = (at, first, second) => {
    const format = buf.readUInt16BE(at);
    const cov = coverageIndex(buf, at + buf.readUInt16BE(at + 2), first);
    if (cov < 0) return null;
    const vf1 = buf.readUInt16BE(at + 4);
    const vf2 = buf.readUInt16BE(at + 6);
    const s1 = valueSize(vf1);
    const s2 = valueSize(vf2);
    if (format === 1) {
      const set = at + buf.readUInt16BE(at + 10 + cov * 2);
      const n = buf.readUInt16BE(set);
      const size = 2 + s1 + s2;
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const rec = set + 2 + mid * size;
        const g = buf.readUInt16BE(rec);
        if (g === second) return valueKern(buf, rec + 2, vf1) + (vf2 & 0x0001 ? buf.readInt16BE(rec + 2 + s1) : 0);
        if (g < second) lo = mid + 1;
        else hi = mid - 1;
      }
      return null;
    }
    if (format === 2) {
      const c1 = glyphClass(buf, at + buf.readUInt16BE(at + 8), first);
      const c2 = glyphClass(buf, at + buf.readUInt16BE(at + 10), second);
      const class2Count = buf.readUInt16BE(at + 14);
      const rec = at + 16 + (c1 * class2Count + c2) * (s1 + s2);
      return valueKern(buf, rec, vf1) + (vf2 & 0x0001 ? buf.readInt16BE(rec + s1) : 0);
    }
    return null;
  };
  return (first, second) => {
    let total = 0;
    for (const list of subtables) {
      for (const at of list) {
        const got = pairIn(at, first, second);
        if (got != null) {
          total += got;
          break;
        }
      }
    }
    return total;
  };
}

/** The family name, from the name table: the typographic family if there is one, else the family. */
function readFamily(buf, name) {
  if (!name) return null;
  const count = buf.readUInt16BE(name.offset + 2);
  const strings = name.offset + buf.readUInt16BE(name.offset + 4);
  const found = [];
  for (let i = 0; i < count; i++) {
    const r = name.offset + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platform = buf.readUInt16BE(r);
    const language = buf.readUInt16BE(r + 4);
    const id = buf.readUInt16BE(r + 6);
    if (id !== 1 && id !== 16) continue;
    const len = buf.readUInt16BE(r + 8);
    const at = strings + buf.readUInt16BE(r + 10);
    if (at + len > buf.length) continue;
    let text;
    if (platform === 3 || platform === 0) {
      text = "";
      for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(buf.readUInt16BE(at + k));
    } else if (platform === 1) text = buf.toString("latin1", at, at + len);
    else continue;
    // US English Windows names first, so a localised family name does not become the face.
    found.push({ text, score: (id === 16 ? 4 : 0) + (platform === 3 && language === 0x409 ? 2 : platform === 3 ? 1 : 0) });
  }
  found.sort((a, b) => b.score - a.score);
  return found[0]?.text ?? null;
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
  for (const need of ["head", "maxp", "cmap", "hhea", "hmtx"]) {
    if (!tables.has(need)) throw new Error(`this font has no ${need} table, so it cannot be set`);
  }
  // TrueType outlines when the font has them, else CFF, else the CFF2 of a variable .otf.
  const flavour = tables.has("glyf") && tables.has("loca") ? "TrueType" : tables.has("CFF ") ? "CFF" : tables.has("CFF2") ? "CFF2" : null;
  if (!flavour) throw new Error(tables.has("glyf") ? "this font has a glyf table but no loca table, so its outlines cannot be read" : "this font has neither glyf nor CFF outlines, so its letters cannot be read");
  const head = tables.get("head");
  const unitsPerEm = buf.readUInt16BE(head.offset + 18) || 1000;
  const long = buf.readInt16BE(head.offset + 50) === 1;
  const numGlyphs = buf.readUInt16BE(tables.get("maxp").offset + 4);
  const cmap = readCmap(buf, tables.get("cmap").offset);
  const advances = readMetrics(buf, tables.get("hhea"), tables.get("hmtx"), numGlyphs);
  const kern = readKern(buf, tables.get("kern"));
  // GPOS when the font kerns there, as any shaping engine would, else the old kern table.
  let gpos = null;
  try {
    gpos = readGposKern(buf, tables.get("GPOS"));
  } catch {
    gpos = null;
  }
  const kernCache = new Map();
  const kernBetween = (a, b) => {
    const k = `${a},${b}`;
    if (!kernCache.has(k)) kernCache.set(k, gpos ? gpos(a, b) : (kern.get(k) ?? 0));
    return kernCache.get(k);
  };
  const ascender = buf.readInt16BE(tables.get("hhea").offset + 4);
  const descender = buf.readInt16BE(tables.get("hhea").offset + 6);
  const lineGap = buf.readInt16BE(tables.get("hhea").offset + 8);
  const outlines = flavour === "TrueType" ? (gid) => readGlyph(buf, tables.get("glyf"), tables.get("loca"), long, gid, numGlyphs) : null;
  const cff = flavour === "TrueType" ? null : readCFF(buf, tables.get(flavour === "CFF" ? "CFF " : "CFF2"), { cff2: flavour === "CFF2", numGlyphs });
  const commandCache = new Map();
  const commandsOf = (gid) => {
    if (!commandCache.has(gid)) commandCache.set(gid, gid >= 0 && gid < numGlyphs ? cff.commands(gid, unitsPerEm) : []);
    return commandCache.get(gid);
  };
  // A glyph as path text, every point placed by `at`, whichever flavour of outline it came from.
  const glyphPath = (gid, at = (p) => [p.x, p.y]) => {
    if (outlines) return outlines(gid).map((c) => contourToPath(c, at)).join("");
    // A contour that only moves draws nothing and is left out, as a one-point TrueType contour is.
    let d = "";
    let sub = "";
    let drawn = false;
    for (const c of commandsOf(gid)) {
      if (c[0] === "Z") {
        if (drawn) d += `${sub}Z`;
        sub = "";
        drawn = false;
        continue;
      }
      let s = c[0];
      for (let k = 1; k < c.length; k += 2) {
        const [px, py] = at({ x: c[k], y: c[k + 1] });
        s += `${k > 1 ? " " : ""}${r3(px)} ${r3(py)}`;
      }
      sub += s;
      if (c[0] !== "M") drawn = true;
    }
    return d;
  };
  // The box round every point of the outline, control points included, in font units; null
  // for a glyph that draws nothing.
  const glyphBounds = (gid) => {
    let xMin = Infinity;
    let yMin = Infinity;
    let xMax = -Infinity;
    let yMax = -Infinity;
    const take = (x, y) => {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    };
    if (outlines) {
      for (const c of outlines(gid)) if (c.length >= 2) for (const p of c) take(p.x, p.y);
    } else {
      let moved = null;
      for (const c of commandsOf(gid)) {
        if (c[0] === "M") moved = c;
        else if (c[0] !== "Z") {
          if (moved) take(moved[1], moved[2]);
          moved = null;
          for (let k = 1; k < c.length; k += 2) take(c[k], c[k + 1]);
        }
      }
    }
    return Number.isFinite(xMin) ? { xMin, yMin, xMax, yMax } : null;
  };
  // How tall a capital stands. It is what the eye lines a symbol up with, not the
  // ascender, which includes the room left above for accents. Measured off the H rather
  // than taken from OS/2, which plenty of fonts leave at zero or simply get wrong.
  let capHeight = 0;
  const h = cmap.get(0x48);
  if (h) capHeight = Math.max(0, glyphBounds(h)?.yMax ?? 0);
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
    lineGap,
    capHeight,
    family: readFamily(buf, tables.get("name")),
    kerning: gpos ? "GPOS" : kern.size ? "kern" : null,
    // A symbol font maps its characters at U+F020 to U+F0FF; the byte code a user types reaches them.
    glyphFor: (codepoint) => cmap.get(codepoint) ?? (cmap.symbol && codepoint < 0x100 ? cmap.get(codepoint + 0xf000) : undefined) ?? 0,
    advanceOf: (gid) => advances[gid] ?? 0,
    kernBetween,
    outlines: flavour,
    glyphPath,
    glyphBounds,
    // TrueType's own contours, points and on-curve flags, for what needs them; a CFF font has none.
    contoursOf: outlines ?? (() => []),
    has: (codepoint) => cmap.has(codepoint) || (cmap.symbol && codepoint < 0x100 && cmap.has(codepoint + 0xf000)),
    symbol: Boolean(cmap.symbol),
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
    const d = font.glyphPath(gid, (p) => [r3(x + (pen + p.x) * scale), r3(baseline - p.y * scale)]);
    const drew = d ? 1 : 0;
    if (d) parts.push(d);
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
