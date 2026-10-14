/**
 * CFF outlines: the other flavour of OpenType, where each glyph is a Type 2 charstring, a small
 * stack program that draws cubic curves, rather than TrueType's quadratic points.
 *
 * Read here: the CFF table (version 1) for name-keyed fonts and for CID-keyed ones, whose glyphs
 * each belong to one of several font dicts with subroutines of their own; and CFF2, the table of
 * variable OpenType fonts, at its default instance, since onmodel sets a font, it does not explore
 * its design space. The charstring interpreter runs every drawing operator, both kinds of
 * subroutine, hint and counter masks (skipped, they only steer rasterisers at small sizes), the old
 * `seac` way of building an accented letter from two others, and the arithmetic operators.
 *
 * Widths in a charstring are skipped: hmtx is what every engine uses for advances, and it is
 * already read. Outlines come back in font units as move, line, cubic and close commands.
 */

/** A CFF INDEX: count, offset size, offsets, data. Returns the items and where the index ends. */
function readIndex(buf, at, cff2 = false) {
  const head = cff2 ? 4 : 2;
  if (at + head > buf.length) throw new Error("this font's CFF table ends where an index should begin, so the font is malformed");
  const count = cff2 ? buf.readUInt32BE(at) : buf.readUInt16BE(at);
  if (count === 0) return { items: [], end: at + head };
  if (at + head + 1 > buf.length) throw new Error("this font's CFF table ends inside an index, so the font is malformed");
  const offSize = buf[at + head];
  const offAt = at + head + 1;
  if (offSize < 1 || offSize > 4 || offAt + (count + 1) * offSize > buf.length) throw new Error("this font's CFF table has an index that runs past the end of the font, so the font is malformed");
  const readOff = (i) => {
    let v = 0;
    for (let k = 0; k < offSize; k++) v = v * 256 + buf[offAt + i * offSize + k];
    return v;
  };
  const dataStart = offAt + (count + 1) * offSize - 1;
  const items = [];
  for (let i = 0; i < count; i++) items.push(buf.subarray(dataStart + readOff(i), dataStart + readOff(i + 1)));
  return { items, end: dataStart + readOff(count) };
}

/**
 * A DICT: operator to operands. Two-byte operators are keyed 1200 + the second byte. Bytes 0
 * to 27 are operators (22 to 27 are CFF2's vsindex, blend, vstore and maxstack), 28 to 30
 * begin numbers.
 */
function readDict(data) {
  const dict = new Map();
  let ops = [];
  let i = 0;
  while (i < data.length) {
    const b = data[i];
    if (b <= 27) {
      let op = b;
      i++;
      if (b === 12) op = 1200 + data[i++];
      dict.set(op, ops);
      ops = [];
    } else if (b === 28) {
      ops.push(((data[i + 1] << 8) | data[i + 2]) << 16 >> 16);
      i += 3;
    } else if (b === 29) {
      ops.push((data[i + 1] << 24) | (data[i + 2] << 16) | (data[i + 3] << 8) | data[i + 4]);
      i += 5;
    } else if (b === 30) {
      // A real number, packed as nibbles.
      let s = "";
      i++;
      for (;;) {
        const byte = data[i++];
        const done = [byte >> 4, byte & 15].some((n) => {
          if (n === 15) return true;
          s += n <= 9 ? String(n) : n === 10 ? "." : n === 11 ? "E" : n === 12 ? "E-" : n === 14 ? "-" : "";
          return false;
        });
        if (done || i >= data.length) break;
      }
      ops.push(Number(s));
    } else if (b >= 32 && b <= 246) {
      ops.push(b - 139);
      i++;
    } else if (b >= 247 && b <= 250) {
      ops.push((b - 247) * 256 + data[i + 1] + 108);
      i += 2;
    } else if (b >= 251 && b <= 254) {
      ops.push(-(b - 251) * 256 - data[i + 1] - 108);
      i += 2;
    } else i++;
  }
  return dict;
}

const subrBias = (n) => (n < 1240 ? 107 : n < 33900 ? 1131 : 32768);

/** Which font dict each glyph uses, in a CID-keyed or CFF2 font. */
function readFDSelect(buf, at, numGlyphs) {
  const format = buf[at];
  if (format === 0) return (gid) => buf[at + 1 + gid] ?? 0;
  if (format === 3 || format === 4) {
    const wide = format === 4;
    const n = wide ? buf.readUInt32BE(at + 1) : buf.readUInt16BE(at + 1);
    const ranges = [];
    let p = at + (wide ? 5 : 3);
    for (let k = 0; k < n; k++) {
      ranges.push([wide ? buf.readUInt32BE(p) : buf.readUInt16BE(p), wide ? buf.readUInt16BE(p + 4) : buf[p + 2]]);
      p += wide ? 6 : 3;
    }
    const sentinel = wide ? buf.readUInt32BE(p) : buf.readUInt16BE(p);
    return (gid) => {
      if (gid >= sentinel) return 0;
      let lo = 0;
      let hi = ranges.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (ranges[mid][0] <= gid) lo = mid;
        else hi = mid - 1;
      }
      return ranges[lo]?.[1] ?? 0;
    };
  }
  throw new Error(`this font picks its font dicts with FDSelect format ${format}, which onmodel does not read`);
}

/** Glyph id to string id, from a charset (formats 0, 1 and 2); id 0 is .notdef. */
function readCharset(buf, base, offset, numGlyphs) {
  const sids = new Uint16Array(numGlyphs);
  // The predefined ISOAdobe set is glyph id for string id; the two Expert sets hold no letter a
  // seac could name.
  if (offset === 0) for (let g = 0; g < numGlyphs && g <= 228; g++) sids[g] = g;
  if (offset <= 2) return sids;
  const at = base + offset;
  const format = buf[at];
  let p = at + 1;
  let gid = 1;
  if (format === 0) {
    for (; gid < numGlyphs; gid++, p += 2) sids[gid] = buf.readUInt16BE(p);
  } else {
    while (gid < numGlyphs && p < buf.length) {
      const first = buf.readUInt16BE(p);
      const left = format === 1 ? buf[p + 2] : buf.readUInt16BE(p + 2);
      p += format === 1 ? 3 : 4;
      for (let k = 0; k <= left && gid < numGlyphs; k++) sids[gid++] = first + k;
    }
  }
  return sids;
}

/**
 * Standard Encoding, as the string ids of its glyph names: what a `seac` names its base and accent
 * by. Codes 32 to 126 are ASCII order (string ids 1 to 95), the rest are the accented and symbol
 * slots of Adobe's table.
 */
const STANDARD = (() => {
  const t = new Uint16Array(256);
  for (let c = 32; c <= 126; c++) t[c] = c - 31;
  const high = [
    [161, 96], [162, 97], [163, 98], [164, 99], [165, 100], [166, 101], [167, 102], [168, 103], [169, 104], [170, 105],
    [171, 106], [172, 107], [173, 108], [174, 109], [175, 110], [177, 111], [178, 112], [179, 113], [180, 114], [182, 115],
    [183, 116], [184, 117], [185, 118], [186, 119], [187, 120], [188, 121], [189, 122], [191, 123], [193, 124], [194, 125],
    [195, 126], [196, 127], [197, 128], [198, 129], [199, 130], [200, 131], [202, 132], [203, 133], [205, 134], [206, 135],
    [207, 136], [208, 137], [225, 138], [227, 139], [232, 140], [233, 141], [234, 142], [235, 143], [241, 144], [245, 145],
    [248, 146], [249, 147], [250, 148], [251, 149],
  ];
  for (const [c, sid] of high) t[c] = sid;
  return t;
})();

/**
 * Opens a CFF or CFF2 table. Returns how many glyphs it has and a function that draws one glyph
 * as commands in font units: ["M", x, y], ["L", x, y], ["C", x1, y1, x2, y2, x, y], ["Z"].
 */
export function readCFF(buf, table, { cff2 = false, numGlyphs = null } = {}) {
  const base = table.offset;
  let topDict;
  let globalSubrs;
  if (cff2) {
    const hdrSize = buf[base + 2];
    const topSize = buf.readUInt16BE(base + 3);
    topDict = readDict(buf.subarray(base + hdrSize, base + hdrSize + topSize));
    globalSubrs = readIndex(buf, base + hdrSize + topSize, true).items;
  } else {
    const hdrSize = buf[base + 2];
    const names = readIndex(buf, base + hdrSize);
    const tops = readIndex(buf, names.end);
    if (tops.items.length !== 1) throw new Error(`this CFF table holds ${tops.items.length} fonts; onmodel reads one`);
    topDict = readDict(tops.items[0]);
    const strings = readIndex(buf, tops.end);
    globalSubrs = readIndex(buf, strings.end).items;
  }
  const charStringsAt = topDict.get(17)?.[0];
  if (charStringsAt == null) throw new Error("this CFF table has no charstrings");
  const charStrings = readIndex(buf, base + charStringsAt, cff2).items;
  const glyphCount = numGlyphs ?? charStrings.length;

  // Private dicts and their local subroutines: one for a name-keyed font, one per font dict for a
  // CID-keyed font or a CFF2 font. A CID font dict may carry a font matrix of its own.
  const privateOf = (dict, own) => {
    const p = dict.get(18);
    const matrix = own && !cff2 ? (dict.get(1207) ?? null) : null;
    if (!p) return { subrs: [], vsindex: 0, matrix };
    const [size, offset] = p;
    const pd = readDict(buf.subarray(base + offset, base + offset + size));
    const subrsAt = pd.get(19)?.[0];
    return { subrs: subrsAt != null ? readIndex(buf, base + offset + subrsAt, cff2).items : [], vsindex: pd.get(22)?.[0] ?? 0, matrix };
  };
  // Type 2 allows 48 arguments on the stack; CFF2 says how many it needs, up to 513.
  const stackLimit = cff2 ? Math.min(topDict.get(25)?.[0] ?? 513, 513) : 48;
  // A CFF2 blend carries one delta per region, and how many regions depends on which item
  // variation data the glyph uses, so the counts are read from the variation store.
  const regionCounts = [];
  const vstoreAt = cff2 ? topDict.get(24)?.[0] : null;
  if (vstoreAt != null) {
    const ivs = base + vstoreAt + 2;
    const count = buf.readUInt16BE(ivs + 6);
    for (let k = 0; k < count; k++) regionCounts.push(buf.readUInt16BE(ivs + buf.readUInt32BE(ivs + 8 + 4 * k) + 4));
  }
  let fdOf = () => 0;
  let privates;
  const fdArrayAt = topDict.get(1236)?.[0];
  if (fdArrayAt != null) {
    privates = readIndex(buf, base + fdArrayAt, cff2).items.map((d) => privateOf(readDict(d), true));
    if (!privates.length) throw new Error("this font's FDArray holds no font dicts, so the font is malformed");
    const fdSelectAt = topDict.get(1237)?.[0];
    if (fdSelectAt != null) fdOf = readFDSelect(buf, base + fdSelectAt, glyphCount);
  } else privates = [privateOf(topDict, false)];

  // Charstring units are the head table's units, as FreeType reads them. A font matrix is honoured
  // for the shape it adds (an oblique, an aspect) and not for its scale, which is normalised away;
  // a CID font dict's matrix is combined with the top dict's. CFF2 allows only the plain matrix.
  const topMatrix = cff2 ? null : (topDict.get(1207) ?? null);
  const compose = (top, sub) => [
    top[0] * sub[0] + top[2] * sub[1],
    top[1] * sub[0] + top[3] * sub[1],
    top[0] * sub[2] + top[2] * sub[3],
    top[1] * sub[2] + top[3] * sub[3],
    top[0] * sub[4] + top[2] * sub[5] + top[4],
    top[1] * sub[4] + top[3] * sub[5] + top[5],
  ];
  const transformOf = (fd) => {
    const full = (m) => m && m.length >= 6 && m.every(Number.isFinite);
    const m = full(topMatrix) && full(fd) ? compose(topMatrix, fd) : full(fd) ? fd : full(topMatrix) ? topMatrix : null;
    if (!m) return null;
    const t = Math.abs(m[3]) || Math.abs(m[0]);
    if (!(t > 0)) return null;
    const n = m.map((v) => v / t);
    const near = (v, w) => Math.abs(v - w) < 1e-6;
    if (near(n[0], 1) && near(n[1], 0) && near(n[2], 0) && near(n[3], 1) && near(n[4], 0) && near(n[5], 0)) return null;
    return n;
  };
  const transforms = privates.map((p) => transformOf(p.matrix));
  const charset = cff2 ? null : readCharset(buf, base, topDict.get(15)?.[0] ?? 0, charStrings.length);

  const drawGlyph = (gid, out, depth = 0, dx = 0, dy = 0, budget = { left: 200000 }) => {
    const code = charStrings[gid];
    if (!code) return;
    const priv = privates[fdOf(gid)] ?? privates[0];
    const local = priv.subrs;
    const localBias = subrBias(local.length);
    const globalBias = subrBias(globalSubrs.length);
    let stack = [];
    let x = dx;
    let y = dy;
    let stems = 0;
    let open = false;
    let widthDone = cff2;
    let vsindex = priv.vsindex;
    const transient = [];
    // An operator short of arguments reads past the stack and makes NaN of every point after it.
    const point = (nx, ny) => {
      if (!(Number.isFinite(nx) && Number.isFinite(ny))) throw new Error(`this font's glyph ${gid} has a charstring that runs short of arguments, so the font is malformed`);
    };
    const moveTo = (nx, ny) => {
      point(nx, ny);
      if (open) out.push(["Z"]);
      x = nx;
      y = ny;
      out.push(["M", x, y]);
      open = true;
    };
    // A line or curve before any move starts the contour at the current point, as FreeType does.
    const lineTo = (nx, ny) => {
      point(nx, ny);
      if (!open) moveTo(x, y);
      x = nx;
      y = ny;
      out.push(["L", x, y]);
    };
    const curveTo = (x1, y1, x2, y2, nx, ny) => {
      point(x1, y1);
      point(x2, y2);
      point(nx, ny);
      if (!open) moveTo(x, y);
      x = nx;
      y = ny;
      out.push(["C", x1, y1, x2, y2, x, y]);
    };
    // The first stack-clearing operator may carry a width before its arguments; it is dropped.
    const takeWidth = (expectEven) => {
      if (widthDone) return;
      widthDone = true;
      if ((stack.length % 2 === 1) === expectEven) stack.shift();
    };
    const stemHints = () => {
      takeWidth(true);
      stems += stack.length >> 1;
      stack = [];
    };
    let ended = false;
    const run = (cs, level) => {
      if (level > 10) throw new Error("this font's charstrings nest subroutines more than ten deep");
      let i = 0;
      while (i < cs.length && !ended) {
        // Depth alone does not bound the work: subroutines that call each other many times over
        // grow it exponentially, so one budget covers the glyph, its subroutines and its seac parts.
        if (--budget.left < 0) throw new Error(`this font's glyph ${gid} runs its charstring through more than 200,000 steps, so the font is malformed`);
        if (stack.length > stackLimit) throw new Error(`this font's glyph ${gid} overflows the charstring argument stack, so the font is malformed`);
        const b = cs[i];
        if (b >= 32 || b === 28) {
          if (b === 28) {
            stack.push(((cs[i + 1] << 8) | cs[i + 2]) << 16 >> 16);
            i += 3;
          } else if (b <= 246) {
            stack.push(b - 139);
            i++;
          } else if (b <= 250) {
            stack.push((b - 247) * 256 + cs[i + 1] + 108);
            i += 2;
          } else if (b <= 254) {
            stack.push(-(b - 251) * 256 - cs[i + 1] - 108);
            i += 2;
          } else {
            stack.push(((cs[i + 1] << 24) | (cs[i + 2] << 16) | (cs[i + 3] << 8) | cs[i + 4]) / 65536);
            i += 5;
          }
          continue;
        }
        i++;
        switch (b) {
          case 1: // hstem
          case 3: // vstem
          case 18: // hstemhm
          case 23: // vstemhm
            stemHints();
            break;
          case 19: // hintmask
          case 20: // cntrmask
            // Arguments left on the stack are an implied vstemhm.
            stemHints();
            i += (stems + 7) >> 3;
            break;
          case 21: // rmoveto
            takeWidth(true);
            moveTo(x + stack[stack.length - 2], y + stack[stack.length - 1]);
            stack = [];
            break;
          case 22: // hmoveto
            takeWidth(false);
            moveTo(x + stack[stack.length - 1], y);
            stack = [];
            break;
          case 4: // vmoveto
            takeWidth(false);
            moveTo(x, y + stack[stack.length - 1]);
            stack = [];
            break;
          case 5: // rlineto
            for (let k = 0; k + 1 < stack.length; k += 2) lineTo(x + stack[k], y + stack[k + 1]);
            stack = [];
            break;
          case 6: // hlineto
          case 7: {
            // vlineto
            let horizontal = b === 6;
            for (const d of stack) {
              if (horizontal) lineTo(x + d, y);
              else lineTo(x, y + d);
              horizontal = !horizontal;
            }
            stack = [];
            break;
          }
          case 8: // rrcurveto
            for (let k = 0; k + 5 < stack.length; k += 6) {
              const x1 = x + stack[k];
              const y1 = y + stack[k + 1];
              const x2 = x1 + stack[k + 2];
              const y2 = y1 + stack[k + 3];
              curveTo(x1, y1, x2, y2, x2 + stack[k + 4], y2 + stack[k + 5]);
            }
            stack = [];
            break;
          case 24: {
            // rcurveline
            let k = 0;
            for (; k + 7 < stack.length; k += 6) {
              const x1 = x + stack[k];
              const y1 = y + stack[k + 1];
              const x2 = x1 + stack[k + 2];
              const y2 = y1 + stack[k + 3];
              curveTo(x1, y1, x2, y2, x2 + stack[k + 4], y2 + stack[k + 5]);
            }
            lineTo(x + stack[k], y + stack[k + 1]);
            stack = [];
            break;
          }
          case 25: {
            // rlinecurve
            let k = 0;
            for (; k + 7 < stack.length; k += 2) lineTo(x + stack[k], y + stack[k + 1]);
            const x1 = x + stack[k];
            const y1 = y + stack[k + 1];
            const x2 = x1 + stack[k + 2];
            const y2 = y1 + stack[k + 3];
            curveTo(x1, y1, x2, y2, x2 + stack[k + 4], y2 + stack[k + 5]);
            stack = [];
            break;
          }
          case 26: {
            // vvcurveto
            let k = 0;
            let dx1 = 0;
            if (stack.length % 4 === 1) dx1 = stack[k++];
            for (; k + 3 < stack.length; k += 4) {
              const x1 = x + dx1;
              const y1 = y + stack[k];
              const x2 = x1 + stack[k + 1];
              const y2 = y1 + stack[k + 2];
              curveTo(x1, y1, x2, y2, x2, y2 + stack[k + 3]);
              dx1 = 0;
            }
            stack = [];
            break;
          }
          case 27: {
            // hhcurveto
            let k = 0;
            let dy1 = 0;
            if (stack.length % 4 === 1) dy1 = stack[k++];
            for (; k + 3 < stack.length; k += 4) {
              const x1 = x + stack[k];
              const y1 = y + dy1;
              const x2 = x1 + stack[k + 1];
              const y2 = y1 + stack[k + 2];
              curveTo(x1, y1, x2, y2, x2 + stack[k + 3], y2);
              dy1 = 0;
            }
            stack = [];
            break;
          }
          case 30: // vhcurveto
          case 31: {
            // hvcurveto
            let horizontal = b === 31;
            let k = 0;
            while (k + 3 < stack.length) {
              const last = stack.length - k === 5;
              if (horizontal) {
                const x1 = x + stack[k];
                const y1 = y;
                const x2 = x1 + stack[k + 1];
                const y2 = y1 + stack[k + 2];
                const ny = y2 + stack[k + 3];
                curveTo(x1, y1, x2, y2, x2 + (last ? stack[k + 4] : 0), ny);
              } else {
                const x1 = x;
                const y1 = y + stack[k];
                const x2 = x1 + stack[k + 1];
                const y2 = y1 + stack[k + 2];
                const nx = x2 + stack[k + 3];
                curveTo(x1, y1, x2, y2, nx, y2 + (last ? stack[k + 4] : 0));
              }
              k += last ? 5 : 4;
              horizontal = !horizontal;
            }
            stack = [];
            break;
          }
          case 10: {
            // callsubr
            const n = stack.pop() + localBias;
            if (local[n]) run(local[n], level + 1);
            break;
          }
          case 29: {
            // callgsubr
            const n = stack.pop() + globalBias;
            if (globalSubrs[n]) run(globalSubrs[n], level + 1);
            break;
          }
          case 11: // return
            return;
          case 14: // endchar
            if (!cff2) {
              // No arguments or the four of a seac, either one after a width.
              takeWidth(true);
              const accent = stack.length >= 4 ? stack.slice(-4) : null;
              if (accent && charset && depth === 0) {
                // seac: an accented letter drawn as a base glyph plus an accent moved into place.
                const [adx, ady, bchar, achar] = accent;
                const find = (c) => charset.findIndex((sid, g) => g > 0 && sid === STANDARD[c]);
                const bg = find(bchar);
                const ag = find(achar);
                if (open) out.push(["Z"]);
                open = false;
                if (bg > 0) drawGlyph(bg, out, depth + 1, 0, 0, budget);
                if (ag > 0) drawGlyph(ag, out, depth + 1, adx, ady, budget);
                ended = true;
                return;
              }
            }
            if (open) out.push(["Z"]);
            open = false;
            ended = true;
            return;
          case 15: // vsindex (CFF2): which set of regions the blends that follow use
            vsindex = stack.pop() ?? 0;
            stack = [];
            break;
          case 16: {
            // blend (CFF2): n default values, then a delta per value per region. The default
            // instance keeps the values and drops the deltas.
            const n = stack.pop() ?? 0;
            const regions = regionCounts[vsindex] ?? 0;
            const start = stack.length - n * (regions + 1);
            if (start < 0) throw new Error("a CFF2 blend asks for more values than the stack holds");
            stack = stack.slice(0, start + n);
            break;
          }
          case 12: {
            const op = cs[i++];
            const s = stack;
            switch (op) {
              case 34: {
                // hflex
                const [d1, d2, d3, d4, d5, d6, d7] = s;
                const x1 = x + d1;
                const y1 = y;
                const x2 = x1 + d2;
                const y2 = y1 + d3;
                const x3 = x2 + d4;
                curveTo(x1, y1, x2, y2, x3, y2);
                const x4 = x3 + d5;
                const x5 = x4 + d6;
                curveTo(x4, y2, x5, y1, x5 + d7, y1);
                break;
              }
              case 35: {
                // flex
                for (let k = 0; k < 12; k += 6) {
                  const x1 = x + s[k];
                  const y1 = y + s[k + 1];
                  const x2 = x1 + s[k + 2];
                  const y2 = y1 + s[k + 3];
                  curveTo(x1, y1, x2, y2, x2 + s[k + 4], y2 + s[k + 5]);
                }
                break;
              }
              case 36: {
                // hflex1
                const [d1, d2, d3, d4, d5, d6, d7, d8, d9] = s;
                const y0 = y;
                const x1 = x + d1;
                const y1 = y + d2;
                const x2 = x1 + d3;
                const y2 = y1 + d4;
                const x3 = x2 + d5;
                curveTo(x1, y1, x2, y2, x3, y2);
                const x4 = x3 + d6;
                const x5 = x4 + d7;
                const y5 = y2 + d8;
                curveTo(x4, y2, x5, y5, x5 + d9, y0);
                break;
              }
              case 37: {
                // flex1
                const [d1, d2, d3, d4, d5, d6, d7, d8, d9, d10, d11] = s;
                const sx = x;
                const sy = y;
                const x1 = x + d1;
                const y1 = y + d2;
                const x2 = x1 + d3;
                const y2 = y1 + d4;
                const x3 = x2 + d5;
                const y3 = y2 + d6;
                curveTo(x1, y1, x2, y2, x3, y3);
                const x4 = x3 + d7;
                const y4 = y3 + d8;
                const x5 = x4 + d9;
                const y5 = y4 + d10;
                const ddx = x5 - sx;
                const ddy = y5 - sy;
                if (Math.abs(ddx) > Math.abs(ddy)) curveTo(x4, y4, x5, y5, x5 + d11, sy);
                else curveTo(x4, y4, x5, y5, sx, y5 + d11);
                break;
              }
              // The arithmetic operators, rare in fonts but part of the language.
              case 3: { const b2 = s.pop(); const a = s.pop(); s.push(a && b2 ? 1 : 0); break; } // and
              case 4: { const a = s.pop(); const c = s.pop(); s.push(a || c ? 1 : 0); break; } // or
              case 5: s.push(s.pop() ? 0 : 1); break; // not
              case 9: s.push(Math.abs(s.pop())); break; // abs
              case 10: s.push(s.pop() + s.pop()); break; // add
              case 11: { const b2 = s.pop(); s.push(s.pop() - b2); break; } // sub
              case 12: { const b2 = s.pop(); s.push(s.pop() / b2); break; } // div
              case 14: s.push(-s.pop()); break; // neg
              case 15: s.push(s.pop() === s.pop() ? 1 : 0); break; // eq
              case 18: s.pop(); break; // drop
              case 20: { const k = s.pop(); transient[k] = s.pop(); break; } // put
              case 21: s.push(transient[s.pop()] ?? 0); break; // get
              case 22: { const v2 = s.pop(); const v1 = s.pop(); const s2 = s.pop(); const s1 = s.pop(); s.push(v1 <= v2 ? s1 : s2); break; } // ifelse
              case 23: s.push(0.5); break; // random: any value in (0, 1]; outlines that depend on it are not reproducible anyway
              case 24: s.push(s.pop() * s.pop()); break; // mul
              case 26: s.push(Math.sqrt(s.pop())); break; // sqrt
              case 27: s.push(s[s.length - 1]); break; // dup
              case 28: { const b2 = s.pop(); const a = s.pop(); s.push(b2, a); break; } // exch
              case 29: { const k = s.pop(); s.push(k < 0 ? s[s.length - 1] : s[s.length - 1 - k]); break; } // index
              case 30: {
                // roll
                const j = s.pop();
                const n = s.pop();
                if (n > 0) {
                  const part = s.splice(s.length - n, n);
                  const r = ((j % n) + n) % n;
                  s.push(...part.slice(n - r), ...part.slice(0, n - r));
                }
                break;
              }
              default:
                break;
            }
            if (op >= 34 && op <= 37) stack = [];
            break;
          }
          default:
            stack = [];
        }
      }
    };
    run(code, 0);
    if (open) out.push(["Z"]);
  };

  return {
    glyphs: charStrings.length,
    commands(gid, unitsPerEm) {
      const out = [];
      drawGlyph(gid, out);
      const m = transforms[fdOf(gid)] ?? transforms[0];
      // A point far outside the em is no glyph: the rasteriser would split a cubic that long into
      // more pieces than memory holds. TrueType cannot get here (its coordinates are 16-bit).
      const limit = 64 * unitsPerEm;
      for (const c of out) {
        for (let k = 1; k < c.length; k += 2) {
          let px = c[k];
          let py = c[k + 1];
          if (m) {
            const tx = m[0] * px + m[2] * py + m[4];
            py = m[1] * px + m[3] * py + m[5];
            px = tx;
          }
          if (!(Math.abs(px) <= limit && Math.abs(py) <= limit)) throw new Error(`this font's glyph ${gid} draws far outside its em, so the font is malformed`);
          c[k] = px;
          c[k + 1] = py;
        }
      }
      return out;
    },
  };
}
