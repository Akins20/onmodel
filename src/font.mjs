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
import { readFvar, readAvar, normalise, readHVAR, readMVAR, readGdefStore, readGvar, storeScalars, storeDelta } from "./variation.mjs";

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
 * What a value record holds for the pen: its x placement and x advance, each with the delta
 * its device table adds in a variable font (`dev` reads one at an absolute offset, or is null).
 * Device offsets are relative to the record's parent table, `base`.
 */
function valueParts(buf, at, format, base, dev) {
  let p = at;
  let xPla = 0;
  let xAdv = 0;
  if (format & 0x0001) {
    xPla = buf.readInt16BE(p);
    p += 2;
  }
  if (format & 0x0002) p += 2;
  if (format & 0x0004) {
    xAdv = buf.readInt16BE(p);
    p += 2;
  }
  if (format & 0x0008) p += 2;
  if (format & 0x0010) {
    const off = buf.readUInt16BE(p);
    if (off && dev) xPla += dev(base + off);
    p += 2;
  }
  if (format & 0x0020) p += 2;
  if (format & 0x0040) {
    const off = buf.readUInt16BE(p);
    if (off && dev) xAdv += dev(base + off);
  }
  return { xPla, xAdv };
}

/** The first glyph's advance plus the second's placement: for a pair set left to right, the kerning. */
const pairKern = (buf, rec1, vf1, rec2, vf2, base, dev) => valueParts(buf, rec1, vf1, base, dev).xAdv + valueParts(buf, rec2, vf2, base, dev).xPla;

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
function readGposKern(buf, gpos, dev = null) {
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
        if (g === second) return pairKern(buf, rec + 2, vf1, rec + 2 + s1, vf2, set, dev);
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
      return pairKern(buf, rec, vf1, rec + s1, vf2, at, dev);
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

/** The name table's strings by id, US English Windows names first so a localised one does not win. */
function readNames(buf, name) {
  const best = new Map();
  if (!name || name.offset + 6 > buf.length) return (id) => best.get(id)?.text ?? null;
  const count = buf.readUInt16BE(name.offset + 2);
  const strings = name.offset + buf.readUInt16BE(name.offset + 4);
  for (let i = 0; i < count; i++) {
    const r = name.offset + 6 + i * 12;
    if (r + 12 > buf.length) break;
    const platform = buf.readUInt16BE(r);
    const language = buf.readUInt16BE(r + 4);
    const id = buf.readUInt16BE(r + 6);
    const len = buf.readUInt16BE(r + 8);
    const at = strings + buf.readUInt16BE(r + 10);
    if (at + len > buf.length) continue;
    let text;
    if (platform === 3 || platform === 0) {
      text = "";
      for (let k = 0; k + 1 < len; k += 2) text += String.fromCharCode(buf.readUInt16BE(at + k));
    } else if (platform === 1) text = buf.toString("latin1", at, at + len);
    else continue;
    const score = platform === 3 && language === 0x409 ? 2 : platform === 3 ? 1 : 0;
    if (!best.has(id) || best.get(id).score < score) best.set(id, { text, score });
  }
  return (id) => best.get(id)?.text ?? null;
}

/** The family name: the typographic family if there is one, else the family. */
const readFamily = (nameOf) => nameOf(16) ?? nameOf(1);

const ON_CURVE = 1;
const X_SHORT = 2;
const Y_SHORT = 4;
const REPEAT = 8;
const X_SAME = 16;
const Y_SAME = 32;

// The most points one glyph may place, its composites' copies included. A real glyph needs a
// few thousand; nested composites a few hundred bytes long could otherwise ask for billions.
const GLYPH_POINTS = 1 << 21;

const spend = (budget, n) => {
  budget.left -= n;
  if (budget.left < 0) throw new Error(`this font's glyph ${budget.gid} places more than ${GLYPH_POINTS.toLocaleString("en")} points through its composites, so the font is malformed`);
};

/**
 * One glyph's contours, as points with a flag for whether each sits on the curve.
 *
 * A composite glyph is other glyphs placed by an offset, which is how an accented letter
 * is usually stored; those are read through to their parts, to a bounded depth, because
 * nothing stops a broken font pointing a glyph at itself.
 *
 * In a variable font set away from its default, `vary(gid, pointCount, ends, xs, ys)` gives
 * the deltas of the glyph's points (its components' offsets, for a composite) with the four
 * phantom points last; `met`, when given, receives the advance change the phantoms carry.
 */
function readGlyph(buf, glyf, loca, long, index, numGlyphs, depth = 0, vary = null, met = null, budget = { left: GLYPH_POINTS, gid: index }) {
  if (index < 0 || index >= numGlyphs || depth > 5) return [];
  const start = long ? buf.readUInt32BE(loca.offset + index * 4) : buf.readUInt16BE(loca.offset + index * 2) * 2;
  const end = long ? buf.readUInt32BE(loca.offset + index * 4 + 4) : buf.readUInt16BE(loca.offset + index * 2 + 2) * 2;
  const at = glyf.offset + start;
  if (end <= start || at + 10 > buf.length) {
    // An empty glyph (a space) still has its four phantom points in gvar, and without HVAR they
    // carry its advance.
    if (vary && met) {
      const moved = vary(index, 4, [], [], []);
      if (moved) met.advance = moved.dx[1] - moved.dx[0];
    }
    return [];
  }
  const contourCount = buf.readInt16BE(at);

  if (contourCount < 0) {
    const parts = [];
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
      parts.push({ glyphIndex, dx, dy, a, b, c, d, place: Boolean(flags & 2), metrics: Boolean(flags & 0x200) });
      if (!(flags & 0x20)) break;
    }
    spend(budget, parts.length);
    // Each component is one point to gvar: its offset moves.
    if (vary) {
      const n = parts.length;
      const moved = vary(index, n + 4, [], parts.map((q) => q.dx), parts.map((q) => q.dy));
      if (moved) {
        parts.forEach((q, i) => {
          q.dx += moved.dx[i];
          q.dy += moved.dy[i];
        });
        if (met) met.advance = moved.dx[n + 1] - moved.dx[n];
      }
    }
    const out = [];
    for (const q of parts) {
      if (!q.place) continue;
      // A component marked USE_MY_METRICS lends the composite its metrics, varied ones included,
      // as FreeType and HarfBuzz both read it.
      const own = q.metrics && met ? { advance: 0, from: null } : null;
      for (const contour of readGlyph(buf, glyf, loca, long, q.glyphIndex, numGlyphs, depth + 1, vary, own, budget)) {
        out.push(contour.map((pt) => ({ x: q.a * pt.x + q.c * pt.y + q.dx, y: q.b * pt.x + q.d * pt.y + q.dy, on: pt.on })));
      }
      if (own) {
        met.advance = own.advance;
        met.from = own.from ?? q.glyphIndex;
      }
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
  spend(budget, points);
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
  let fx = xs;
  let fy = ys;
  if (vary) {
    const moved = vary(index, points + 4, ends, xs, ys);
    if (moved) {
      fx = Float64Array.from(xs, (v, i) => v + moved.dx[i]);
      fy = Float64Array.from(ys, (v, i) => v + moved.dy[i]);
      if (met) met.advance = moved.dx[points + 1] - moved.dx[points];
    }
  }
  const out = [];
  let from = 0;
  for (const endAt of ends) {
    const contour = [];
    for (let i = from; i <= endAt && i < points; i++) contour.push({ x: fx[i], y: fy[i], on: Boolean(flags[i] & ON_CURVE) });
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

const trimTags = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.trim(), v]));

/**
 * A font, opened once and asked for glyphs by character. A variable font is set by `variation`
 * (axis coordinates, such as { wght: 700 }) or `instance` (a named instance), the coordinates
 * winning where both name an axis; without either it reads at its default.
 */
export function loadFont(buffer, { variation = null, instance = null } = {}) {
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
  const names = readNames(buf, tables.get("name"));

  // Where on its axes a variable font is set. Nothing below engages unless some coordinate is
  // away from its default, so a static font, and a variable one left alone, read as before.
  const fvar = readFvar(buf, tables.get("fvar"), names);
  const asked = Boolean(variation || instance != null);
  if (asked && !fvar) {
    throw new Error(tables.has("fvar") ? "this font's fvar table is malformed, so its axes cannot be read and --variation and --instance cannot apply" : "this font does not vary: it has no axes, so --variation and --instance cannot apply");
  }
  let coords = {};
  let chosen = null;
  if (fvar && instance != null) {
    const key = (s) => String(s ?? "").toLowerCase().replace(/[\s_-]+/g, "");
    const found = fvar.instances.find((inst) => key(inst.name) === key(instance));
    if (!found) throw new Error(`this font has no instance named "${instance}"; it has ${fvar.instances.map((inst) => inst.name).filter(Boolean).join(", ") || "none that is named"}`);
    coords = { ...found.coords };
    chosen = found;
  }
  if (fvar && variation) {
    for (const [given, value] of Object.entries(variation)) {
      const axis = fvar.axes.find((a) => a.tag.trim() === String(given).trim());
      if (!axis) throw new Error(`this font has no "${String(given).trim()}" axis; it has ${fvar.axes.map((a) => `${a.tag.trim()} (${a.min} to ${a.max}, ${a.def} by default)`).join(", ")}`);
      if (!Number.isFinite(value)) throw new Error(`the ${axis.tag.trim()} coordinate must be a number`);
      coords[axis.tag] = value;
    }
  }
  // avar is read only when a setting was asked for: left alone, a variable font sits at its default.
  const atDefault = () => ({ norm: new Float64Array(fvar.axes.length), applied: Object.fromEntries(fvar.axes.map((a) => [a.tag, a.def])) });
  const setting = fvar ? (asked ? normalise(fvar.axes, readAvar(buf, tables.get("avar"), fvar.axes.length), coords) : atDefault()) : null;
  const norm = setting?.norm ?? null;
  const varies = Boolean(norm && norm.some((v) => v !== 0));
  const applied = setting?.applied ?? null;
  // Named by the coordinates as applied, not as asked: an instance asked for keeps its own name
  // while it is still in force (two instances may share coordinates), and one moved away from by
  // coordinates given beside it is no longer that instance.
  const sameCoords = (a, b) => fvar.axes.every((axis) => Math.abs((a[axis.tag] ?? axis.def) - (b[axis.tag] ?? axis.def)) < 1e-6);
  const instanceName = fvar ? (chosen && sameCoords(chosen.coords, applied) ? chosen.name : (fvar.instances.find((inst) => sameCoords(inst.coords, applied))?.name ?? null)) : null;

  // The stores each kind of delta lives in, each weighted once for these coordinates.
  const scaled = (store) => (store && varies ? { store, scalars: storeScalars(store, norm) } : null);
  const hvar = varies ? readHVAR(buf, tables.get("HVAR"), fvar.axes.length) : null;
  const hvarScaled = hvar ? scaled(hvar.store) : null;
  const mvar = varies ? readMVAR(buf, tables.get("MVAR"), fvar.axes.length) : null;
  const mvarScaled = mvar ? scaled(mvar.store) : null;
  const gdef = varies ? scaled(readGdefStore(buf, tables.get("GDEF"), fvar.axes.length)) : null;
  // A GPOS value's device table, when it is a variation index into GDEF's store.
  const dev = gdef ? (at) => (at + 6 <= buf.length && buf.readUInt16BE(at + 4) === 0x8000 ? Math.round(storeDelta(gdef.store, gdef.scalars, buf.readUInt16BE(at), buf.readUInt16BE(at + 2))) : 0) : null;
  const metric = (tagName, value) => {
    const rec = mvarScaled ? mvar.records.get(tagName) : null;
    return rec ? value + Math.round(storeDelta(mvarScaled.store, mvarScaled.scalars, rec[0], rec[1])) : value;
  };

  const kern = readKern(buf, tables.get("kern"));
  // GPOS when the font kerns there, as any shaping engine would, else the old kern table.
  let gpos = null;
  try {
    gpos = readGposKern(buf, tables.get("GPOS"), dev);
  } catch {
    gpos = null;
  }
  const kernCache = new Map();
  const kernBetween = (a, b) => {
    const k = `${a},${b}`;
    if (!kernCache.has(k)) kernCache.set(k, gpos ? gpos(a, b) : (kern.get(k) ?? 0));
    return kernCache.get(k);
  };
  const ascender = metric("hasc", buf.readInt16BE(tables.get("hhea").offset + 4));
  const descender = metric("hdsc", buf.readInt16BE(tables.get("hhea").offset + 6));
  const lineGap = metric("hlgp", buf.readInt16BE(tables.get("hhea").offset + 8));
  // TrueType outlines move by gvar; each glyph is then read once at these coordinates and kept,
  // with the advance change its phantom points carry, for a font without HVAR.
  const gvar = varies && flavour === "TrueType" ? readGvar(buf, tables.get("gvar"), fvar.axes.length) : null;
  // A glyph's deltas depend only on the glyph, so each is worked out once however many composites
  // place it.
  const varyCache = new Map();
  const vary = gvar
    ? (gid, pointCount, ends, xs, ys) => {
        if (!varyCache.has(gid)) varyCache.set(gid, gvar.deltas(gid, pointCount, norm, ends, xs, ys));
        return varyCache.get(gid);
      }
    : null;
  const glyphCache = new Map();
  const readVaried = (gid) => {
    if (!glyphCache.has(gid)) {
      const met = { advance: 0, from: null };
      glyphCache.set(gid, { contours: readGlyph(buf, tables.get("glyf"), tables.get("loca"), long, gid, numGlyphs, 0, vary, met), advance: met.advance, from: met.from });
    }
    return glyphCache.get(gid);
  };
  const outlines = flavour !== "TrueType" ? null : vary ? (gid) => readVaried(gid).contours : (gid) => readGlyph(buf, tables.get("glyf"), tables.get("loca"), long, gid, numGlyphs);
  const cff = flavour === "TrueType" ? null : readCFF(buf, tables.get(flavour === "CFF" ? "CFF " : "CFF2"), { cff2: flavour === "CFF2", numGlyphs, norm: varies ? norm : null });
  const advanceOf = (gid) => {
    const base = advances[gid] ?? 0;
    if (!varies) return base;
    if (hvarScaled) return base + Math.round(storeDelta(hvarScaled.store, hvarScaled.scalars, ...hvar.map(gid)));
    if (!vary) return base;
    // From the phantom points: the glyph's own, or a USE_MY_METRICS component's.
    const v = readVaried(gid);
    return (v.from != null ? (advances[v.from] ?? base) : base) + Math.round(v.advance);
  };
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
    family: readFamily(names),
    kerning: gpos ? "GPOS" : kern.size ? "kern" : null,
    // The axes a variable font has and its named instances; where it is set (the coordinates as
    // applied, clamped to the axes), the instance those match if any, and whether anything is
    // away from its default.
    axes: fvar ? fvar.axes.map((a) => ({ tag: a.tag.trim(), name: a.name, min: a.min, default: a.def, max: a.max, hidden: a.hidden })) : [],
    instances: fvar ? fvar.instances.map((inst) => ({ name: inst.name, coords: trimTags(inst.coords) })) : [],
    variation: applied ? trimTags(applied) : null,
    instance: instanceName,
    varies,
    // A symbol font maps its characters at U+F020 to U+F0FF; the byte code a user types reaches them.
    glyphFor: (codepoint) => cmap.get(codepoint) ?? (cmap.symbol && codepoint < 0x100 ? cmap.get(codepoint + 0xf000) : undefined) ?? 0,
    advanceOf,
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

/** How a variable font is set, for a report: "Bold (wght 700, wdth 100)", or null when it is at its default. */
export function describeVariation(font) {
  if (!font.varies || !font.variation) return null;
  const coords = font.axes.map((a) => `${a.tag} ${font.variation[a.tag]}`).join(", ");
  return font.instance ? `${font.instance} (${coords})` : coords;
}

/** The same, fit for a file name: "bold" or "wght650-wdth90". */
export function variationSlug(font) {
  if (!font.varies || !font.variation) return null;
  const named = font.instance ? font.instance.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") : "";
  if (named) return named;
  return font.axes
    .filter((a) => font.variation[a.tag] !== a.default)
    .map((a) => `${a.tag}${String(font.variation[a.tag]).replace(/[^0-9a-z.-]/gi, "")}`)
    .join("-");
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
