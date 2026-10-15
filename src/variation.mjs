/**
 * Variable fonts: one file holding a whole family, with axes (weight, width, optical size)
 * along which every outline, advance and kerning value moves.
 *
 * What is read: `fvar` for the axes and the named instances; `avar` for how the designer bent
 * each axis; the item variation store that `HVAR` (advances), `MVAR` (line metrics), `GDEF`
 * (the kerning values in GPOS) and CFF2 all share; and `gvar`, where a TrueType font keeps the
 * point deltas of each glyph. A coordinate the user gives is clamped to its axis, normalised to
 * -1..1 round the default, bent through avar, and every delta is then weighted by how far inside
 * its region the coordinates fall. Points a gvar tuple leaves out are inferred from their
 * neighbours the way the spec and FreeType do, which is what keeps a curve smooth when only its
 * ends were moved.
 */

const f2 = (v) => v / 16384;
const fixed = (v) => v / 65536;

/** Where a table ends: its stated length, or the file's end if that comes first. */
const tableEnd = (buf, table) => Math.min(buf.length, table.offset + (table.length || buf.length - table.offset));

/**
 * The axes and named instances. `nameOf` resolves a name table id. Null when the font has no
 * fvar or one whose records do not fit it: axis records shorter than 20 bytes, instance records
 * too short for their coordinates, or records running past the table, all of which a hostile
 * font can use to make a few bytes read as billions.
 */
export function readFvar(buf, fvar, nameOf) {
  if (!fvar) return null;
  const at = fvar.offset;
  const end = tableEnd(buf, fvar);
  if (at + 16 > end) return null;
  const axesAt = at + buf.readUInt16BE(at + 4);
  const axisCount = buf.readUInt16BE(at + 8);
  const axisSize = buf.readUInt16BE(at + 10);
  const instanceCount = buf.readUInt16BE(at + 12);
  const instanceSize = buf.readUInt16BE(at + 14);
  if (!axisCount || axisSize < 20 || instanceSize < 4 + 4 * axisCount || axesAt + axisCount * axisSize + instanceCount * instanceSize > end) return null;
  const axes = [];
  for (let a = 0; a < axisCount; a++) {
    const p = axesAt + a * axisSize;
    axes.push({
      tag: buf.toString("latin1", p, p + 4),
      min: fixed(buf.readInt32BE(p + 4)),
      def: fixed(buf.readInt32BE(p + 8)),
      max: fixed(buf.readInt32BE(p + 12)),
      hidden: Boolean(buf.readUInt16BE(p + 16) & 1),
      name: nameOf(buf.readUInt16BE(p + 18)),
    });
  }
  const instances = [];
  const instancesAt = axesAt + axisCount * axisSize;
  for (let i = 0; i < instanceCount; i++) {
    const p = instancesAt + i * instanceSize;
    const coords = {};
    axes.forEach((axis, k) => {
      coords[axis.tag] = fixed(buf.readInt32BE(p + 4 + k * 4));
    });
    instances.push({ name: nameOf(buf.readUInt16BE(p)), coords });
  }
  return { axes, instances };
}

/**
 * avar's piecewise-linear bend of each normalised axis, as F2DOT14 integers, or null when the
 * font has none or one that runs past its table. A record whose from-coordinate does not rise
 * above the one before is dropped, as the spec allows; a map left without its -1, 0 and 1 points
 * leaves that axis unbent, as the spec says.
 */
export function readAvar(buf, avar, axisCount) {
  if (!avar) return null;
  const at = avar.offset;
  const end = tableEnd(buf, avar);
  if (at + 8 > end || buf.readUInt16BE(at + 6) !== axisCount) return null;
  const maps = [];
  let p = at + 8;
  for (let a = 0; a < axisCount; a++) {
    if (p + 2 > end) return null;
    const n = buf.readUInt16BE(p);
    p += 2;
    if (p + 4 * n > end) return null;
    const map = [];
    for (let k = 0; k < n; k++, p += 4) {
      const from = buf.readInt16BE(p);
      if (!map.length || from > map[map.length - 1][0]) map.push([from, buf.readInt16BE(p + 2)]);
    }
    const has = (f, t) => map.some(([x, y]) => x === f && y === t);
    maps.push(map.length && has(-16384, -16384) && has(0, 0) && has(16384, 16384) ? map : []);
  }
  return maps;
}

// Rounds half away from zero, as FreeType's fixed-point arithmetic does.
const rnd = (x) => Math.sign(x) * Math.round(Math.abs(x));

/**
 * User coordinates to the -1..1 every delta is weighted by: clamped to the axis, normalised round
 * its default, bent through avar. Done in 16.16 fixed point and rounded once to F2DOT14 at the
 * end, which is what the OpenType spec requires of an implementation (and what FreeType does).
 * Returns the normalised vector and the coordinates as applied.
 */
export function normalise(axes, avarMaps, coords = {}) {
  const norm = new Float64Array(axes.length);
  const applied = {};
  axes.forEach((axis, i) => {
    const given = coords[axis.tag];
    const v = Math.min(axis.max, Math.max(axis.min, given == null ? axis.def : given));
    applied[axis.tag] = v;
    const u = rnd(v * 65536);
    const lo = rnd(axis.min * 65536);
    const d = rnd(axis.def * 65536);
    const hi = rnd(axis.max * 65536);
    let n = 0;
    if (u < d && d > lo) n = -rnd(((d - u) * 65536) / (d - lo));
    else if (u > d && hi > d) n = rnd(((u - d) * 65536) / (hi - d));
    n = Math.max(-65536, Math.min(65536, n));
    const map = avarMaps?.[i];
    if (map && map.length) {
      // The map's F2DOT14 points become 16.16 by a shift of two.
      const pts = map.map(([f, t]) => [f * 4, t * 4]);
      const exact = pts.find(([f]) => f === n);
      if (exact) n = exact[1];
      else {
        for (let k = 1; k < pts.length; k++) {
          if (n < pts[k][0]) {
            const [f0, t0] = pts[k - 1];
            const [f1, t1] = pts[k];
            n = t0 + rnd(((t1 - t0) * (n - f0)) / (f1 - f0));
            break;
          }
        }
      }
    }
    n = Math.max(-65536, Math.min(65536, n));
    // 16.16 to F2DOT14: add 2, then an arithmetic shift right by 2.
    norm[i] = ((n + 2) >> 2) / 16384;
  });
  return { norm, applied };
}

/**
 * An item variation store, read lazily: a region only when a scalar first needs it, an item
 * variation data only when an outer index first asks for it and then kept by its offset, so data
 * that many outer indexes alias is parsed once. Every record is held to the end of the table, the
 * region count to the spec's limit and, when `axes` is given, the region list to the font's axis
 * count; data that does not fit, names a region the list lacks, or sits at a NULL offset reads as
 * no data.
 */
export function readStore(buf, at, end = buf.length, axes = null) {
  if (!Number.isInteger(at) || at < 0 || at + 8 > end || buf.readUInt16BE(at) !== 1) return null;
  const regionsAt = at + buf.readUInt32BE(at + 2);
  const count = buf.readUInt16BE(at + 6);
  if (at + 8 + 4 * count > end || regionsAt + 4 > end) return null;
  const axisCount = buf.readUInt16BE(regionsAt);
  const regionCount = buf.readUInt16BE(regionsAt + 2);
  if (regionCount >= 32768 || (axes != null && axisCount !== axes) || regionsAt + 4 + regionCount * axisCount * 6 > end) return null;
  const region = (r) => {
    const out = [];
    for (let a = 0, p = regionsAt + 4 + r * axisCount * 6; a < axisCount; a++, p += 6) out.push([f2(buf.readInt16BE(p)), f2(buf.readInt16BE(p + 2)), f2(buf.readInt16BE(p + 4))]);
    return out;
  };
  const parsed = new Map();
  const parse = (d) => {
    if (d + 6 > end) return null;
    const itemCount = buf.readUInt16BE(d);
    const wordInfo = buf.readUInt16BE(d + 2);
    const longWords = Boolean(wordInfo & 0x8000);
    const wordCount = wordInfo & 0x7fff;
    const regionIndexCount = buf.readUInt16BE(d + 4);
    if (wordCount > regionIndexCount || d + 6 + 2 * regionIndexCount > end) return null;
    const regionIndexes = [];
    for (let r = 0; r < regionIndexCount; r++) {
      const index = buf.readUInt16BE(d + 6 + 2 * r);
      if (index >= regionCount) return null;
      regionIndexes.push(index);
    }
    const setsAt = d + 6 + 2 * regionIndexCount;
    const wordSize = longWords ? 4 : 2;
    const byteSize = longWords ? 2 : 1;
    const rowSize = wordCount * wordSize + (regionIndexCount - wordCount) * byteSize;
    if (setsAt + itemCount * rowSize > end) return null;
    const deltaSet = (item) => {
      if (!(item >= 0 && item < itemCount)) return null;
      const out = new Float64Array(regionIndexCount);
      let q = setsAt + item * rowSize;
      for (let r = 0; r < regionIndexCount; r++) {
        if (r < wordCount) {
          out[r] = longWords ? buf.readInt32BE(q) : buf.readInt16BE(q);
          q += wordSize;
        } else {
          out[r] = longWords ? buf.readInt16BE(q) : buf.readInt8(q);
          q += byteSize;
        }
      }
      return out;
    };
    return { itemCount, regionIndexes, deltaSet };
  };
  const data = (outer) => {
    if (!Number.isInteger(outer) || outer < 0 || outer >= count) return null;
    const offset = buf.readUInt32BE(at + 8 + 4 * outer);
    if (!offset) return null;
    const d = at + offset;
    if (!parsed.has(d)) parsed.set(d, parse(d));
    return parsed.get(d);
  };
  return { regionCount, count, region, data };
}

/**
 * How much of a region's delta applies at these coordinates: 1 at its peak, 0 outside it. An
 * axis whose range is not a proper tent (start past the peak, the peak past the end, or a range
 * that crosses zero) is ignored, as the spec says.
 */
export function regionScalar(region, norm) {
  let s = 1;
  for (let a = 0; a < region.length; a++) {
    const [start, peak, end] = region[a];
    if (start > peak || peak > end || (start < 0 && end > 0 && peak !== 0)) continue;
    const v = norm[a] ?? 0;
    if (peak === 0 || v === peak) continue;
    if (v <= start || v >= end) return 0;
    s *= v < peak ? (v - start) / (peak - start) : (end - v) / (end - peak);
  }
  return s;
}

/** Each variation data's region scalars at these coordinates, worked out once per data asked for. */
export function storeScalars(store, norm) {
  const perRegion = new Map();
  const scalarOf = (r) => {
    if (!perRegion.has(r)) perRegion.set(r, regionScalar(store.region(r), norm));
    return perRegion.get(r);
  };
  const memo = new Map();
  return (outer) => {
    if (!memo.has(outer)) memo.set(outer, store.data(outer)?.regionIndexes.map(scalarOf) ?? []);
    return memo.get(outer);
  };
}

/** One item's delta: its delta set weighted by the scalars. */
export function storeDelta(store, scalars, outer, inner) {
  const d = store?.data(outer);
  if (!d) return 0;
  const set = d.deltaSet(inner);
  if (!set) return 0;
  const s = scalars(outer);
  let sum = 0;
  for (let r = 0; r < set.length; r++) if (s[r]) sum += set[r] * s[r];
  return sum;
}

/**
 * A delta-set index map: a glyph id (or other index) to an outer and inner index into the store.
 * Null when its entries do not fit the table.
 */
export function readDeltaSetIndexMap(buf, at, end = buf.length) {
  if (at + 4 > end) return null;
  const format = buf[at];
  const entryFormat = buf[at + 1];
  if (format === 1 && at + 6 > end) return null;
  const mapCount = format === 1 ? buf.readUInt32BE(at + 2) : buf.readUInt16BE(at + 2);
  const dataAt = at + (format === 1 ? 6 : 4);
  const innerBits = (entryFormat & 0x0f) + 1;
  const entrySize = ((entryFormat & 0x30) >> 4) + 1;
  const innerSpan = 2 ** innerBits;
  if (dataAt + mapCount * entrySize > end) return null;
  return (index) => {
    if (mapCount === 0) return [0, index];
    const i = Math.min(index, mapCount - 1);
    let v = 0;
    for (let k = 0; k < entrySize; k++) v = v * 256 + buf[dataAt + i * entrySize + k];
    return [Math.floor(v / innerSpan), v % innerSpan];
  };
}

/** HVAR: how each glyph's advance moves. */
export function readHVAR(buf, hvar, axes = null) {
  if (!hvar) return null;
  const at = hvar.offset;
  const end = tableEnd(buf, hvar);
  if (at + 20 > end) return null;
  const storeAt = buf.readUInt32BE(at + 4);
  const mapAt = buf.readUInt32BE(at + 8);
  const store = storeAt ? readStore(buf, at + storeAt, end, axes) : null;
  if (!store) return null;
  const map = mapAt ? readDeltaSetIndexMap(buf, at + mapAt, end) : (gid) => [0, gid];
  return map ? { store, map } : null;
}

/** MVAR: which line metrics move, by their tag. */
export function readMVAR(buf, mvar, axes = null) {
  if (!mvar) return null;
  const at = mvar.offset;
  const end = tableEnd(buf, mvar);
  if (at + 12 > end) return null;
  const recordSize = buf.readUInt16BE(at + 6);
  const count = buf.readUInt16BE(at + 8);
  const storeAt = buf.readUInt16BE(at + 10);
  if (recordSize < 8 || at + 12 + count * recordSize > end) return null;
  const store = storeAt ? readStore(buf, at + storeAt, end, axes) : null;
  if (!store) return null;
  const records = new Map();
  for (let i = 0; i < count; i++) {
    const p = at + 12 + i * recordSize;
    records.set(buf.toString("latin1", p, p + 4), [buf.readUInt16BE(p + 4), buf.readUInt16BE(p + 6)]);
  }
  return { store, records };
}

/**
 * The item variation store GPOS value records point into, from GDEF 1.3: after the 1.2 header's
 * 16-bit mark glyph sets offset at +12 comes the store's 32-bit offset at +14.
 */
export function readGdefStore(buf, gdef, axes = null) {
  if (!gdef) return null;
  const at = gdef.offset;
  const end = tableEnd(buf, gdef);
  if (at + 18 > end || buf.readUInt16BE(at) !== 1 || buf.readUInt16BE(at + 2) < 3) return null;
  const storeAt = buf.readUInt32BE(at + 14);
  return storeAt ? readStore(buf, at + storeAt, end, axes) : null;
}

/** The points a tuple names, as a list, or null for every point; nothing is read past `limit`. */
function readPackedPoints(buf, at, limit) {
  let p = at;
  if (p >= limit) return { points: [], end: p };
  let count = buf[p++];
  if (count & 0x80) {
    if (p >= limit) return { points: [], end: p };
    count = ((count & 0x7f) << 8) | buf[p++];
  }
  if (count === 0) return { points: null, end: p };
  const points = [];
  let v = 0;
  while (points.length < count && p < limit) {
    const control = buf[p++];
    const run = (control & 0x7f) + 1;
    const words = control & 0x80;
    for (let k = 0; k < run && points.length < count && p + (words ? 2 : 1) <= limit; k++) {
      v += words ? buf.readUInt16BE(p) : buf[p];
      p += words ? 2 : 1;
      points.push(v);
    }
  }
  return { points, end: p };
}

/** n packed deltas: runs of zeros, bytes or words; nothing is read past `limit`. */
function readPackedDeltas(buf, at, n, limit) {
  const values = new Float64Array(n);
  let i = 0;
  let p = at;
  while (i < n && p < limit) {
    const control = buf[p++];
    const run = (control & 0x3f) + 1;
    if (control & 0x80) i = Math.min(n, i + run);
    else if (control & 0x40) {
      for (let k = 0; k < run && i < n && p + 2 <= limit; k++, p += 2) values[i++] = buf.readInt16BE(p);
    } else for (let k = 0; k < run && i < n && p < limit; k++) values[i++] = buf.readInt8(p++);
  }
  return { values, end: p };
}

/**
 * How much of a gvar tuple applies: the tent round its peak, with explicit ends when it has them.
 * At the peak itself an axis applies in full before any range is looked at (an intermediate tuple
 * may end exactly at its peak), and an intermediate axis whose range is not a proper tent is
 * ignored, as the spec says.
 */
function tupleScalar(peak, start, end, norm) {
  let s = 1;
  for (let a = 0; a < peak.length; a++) {
    const pk = peak[a];
    if (pk === 0) continue;
    const v = norm[a] ?? 0;
    if (v === pk) continue;
    if (start && (start[a] > pk || pk > end[a] || (start[a] < 0 && end[a] > 0))) continue;
    if (v === 0) return 0;
    if (!start) {
      if (v < Math.min(0, pk) || v > Math.max(0, pk)) return 0;
      s *= v / pk;
    } else {
      if (v <= start[a] || v >= end[a]) return 0;
      s *= v < pk ? (v - start[a]) / (pk - start[a]) : (end[a] - v) / (end[a] - pk);
    }
  }
  return s;
}

/** The delta of an untouched point between two touched ones, along one axis. */
function interpolate(i, a, b, c, d) {
  let r1 = a;
  let r2 = b;
  if (c[r1] > c[r2]) {
    r1 = b;
    r2 = a;
  }
  const in1 = c[r1];
  const in2 = c[r2];
  const d1 = d[r1];
  const d2 = d[r2];
  if (in1 === in2) {
    d[i] = d1 === d2 ? d1 : 0;
    return;
  }
  const v = c[i];
  d[i] = v <= in1 ? d1 : v >= in2 ? d2 : d1 + ((v - in1) * (d2 - d1)) / (in2 - in1);
}

/**
 * Inferred deltas for the points a tuple did not name: between two named points of the same
 * contour a point moves by the interpolation of their deltas along its own coordinate, outside
 * them by the nearer one's; a contour with one named point moves whole, with none stays. Contours
 * are held to the glyph's real points, so ends out of order never reach the phantom points.
 */
function inferUntouched(dx, dy, touched, ends, xs, ys) {
  let from = 0;
  for (const end of ends) {
    const last = Math.min(end, xs.length - 1);
    if (last < from) {
      from = Math.max(from, end + 1);
      continue;
    }
    const named = [];
    for (let i = from; i <= last; i++) if (touched[i]) named.push(i);
    if (named.length === 1) {
      for (let i = from; i <= last; i++) {
        if (!touched[i]) {
          dx[i] = dx[named[0]];
          dy[i] = dy[named[0]];
        }
      }
    } else if (named.length > 1) {
      for (let k = 0; k < named.length; k++) {
        const a = named[k];
        const b = named[(k + 1) % named.length];
        let i = a + 1;
        if (i > last) i = from;
        while (i !== b) {
          interpolate(i, a, b, xs, dx);
          interpolate(i, a, b, ys, dy);
          i++;
          if (i > last) i = from;
        }
      }
    }
    from = end + 1;
  }
}

// The most point-by-tuple work one glyph's variation may cost. A real glyph needs a small
// fraction of it; a few kilobytes of hostile tuples could otherwise ask for billions.
const GVAR_WORK = 1 << 22;

/**
 * gvar: where every point of a TrueType glyph moves. Null when its axis count is not the font's or
 * its offsets and shared tuples do not fit the table; a glyph's tuples are read only from its own
 * bytes.
 */
export function readGvar(buf, gvar, axisCount) {
  if (!gvar) return null;
  const at = gvar.offset;
  const tableLimit = tableEnd(buf, gvar);
  if (at + 20 > tableLimit || buf.readUInt16BE(at + 4) !== axisCount) return null;
  const sharedCount = buf.readUInt16BE(at + 6);
  const sharedAt = at + buf.readUInt32BE(at + 8);
  const glyphCount = buf.readUInt16BE(at + 12);
  const longOffsets = buf.readUInt16BE(at + 14) & 1;
  const dataAt = at + buf.readUInt32BE(at + 16);
  const offsetsAt = at + 20;
  if (offsetsAt + (glyphCount + 1) * (longOffsets ? 4 : 2) > tableLimit || sharedAt + sharedCount * axisCount * 2 > tableLimit) return null;
  const shared = [];
  for (let t = 0; t < sharedCount; t++) {
    const tuple = [];
    for (let a = 0; a < axisCount; a++) tuple.push(f2(buf.readInt16BE(sharedAt + (t * axisCount + a) * 2)));
    shared.push(tuple);
  }
  const offsetOf = (g) => (longOffsets ? buf.readUInt32BE(offsetsAt + g * 4) : buf.readUInt16BE(offsetsAt + g * 2) * 2);
  const readTuple = (p) => {
    const t = [];
    for (let a = 0; a < axisCount; a++) t.push(f2(buf.readInt16BE(p + a * 2)));
    return t;
  };
  return {
    glyphCount,
    /**
     * The deltas of one glyph at these coordinates over its points, the four phantom points last,
     * or null when nothing moves. `ends` are the contour ends and `xs`/`ys` the original points,
     * which the inferred deltas need.
     */
    deltas(gid, pointCount, norm, ends, xs, ys) {
      if (gid < 0 || gid >= glyphCount) return null;
      const start = dataAt + offsetOf(gid);
      const end = dataAt + offsetOf(gid + 1);
      if (end <= start || start + 4 > end || end > tableLimit) return null;
      const raw = buf.readUInt16BE(start);
      const tupleCount = raw & 0x0fff;
      let ser = start + buf.readUInt16BE(start + 2);
      let header = start + 4;
      let sharedPoints = null;
      if (raw & 0x8000) {
        const r = readPackedPoints(buf, ser, end);
        sharedPoints = r.points;
        ser = r.end;
      }
      const dx = new Float64Array(pointCount);
      const dy = new Float64Array(pointCount);
      let any = false;
      let work = 0;
      for (let t = 0; t < tupleCount; t++) {
        if (header + 4 > end) break;
        const size = buf.readUInt16BE(header);
        const index = buf.readUInt16BE(header + 2);
        header += 4;
        const headerSize = (index & 0x8000 ? axisCount * 2 : 0) + (index & 0x4000 ? axisCount * 4 : 0);
        if (header + headerSize > end) break;
        let peak;
        if (index & 0x8000) {
          peak = readTuple(header);
          header += axisCount * 2;
        } else peak = shared[index & 0x0fff] ?? null;
        let tStart = null;
        let tEnd = null;
        if (index & 0x4000) {
          tStart = readTuple(header);
          tEnd = readTuple(header + axisCount * 2);
          header += axisCount * 4;
        }
        const data = ser;
        ser += size;
        // A shared tuple the table does not have names no region, so the tuple is dropped.
        if (!peak) continue;
        const scalar = tupleScalar(peak, tStart, tEnd, norm);
        if (!scalar) continue;
        const limit = Math.min(end, data + size);
        let points = sharedPoints;
        let q = data;
        if (index & 0x2000) {
          const r = readPackedPoints(buf, q, limit);
          points = r.points;
          q = r.end;
        }
        // No delta bytes: every delta is zero, so the tuple moves nothing.
        if (q >= limit) continue;
        work += pointCount + (points ? points.length : 0);
        if (work > GVAR_WORK) throw new Error(`this font's glyph ${gid} varies its points through more than ${GVAR_WORK.toLocaleString("en")} steps, so the font is malformed`);
        const n = points ? points.length : pointCount;
        const xd = readPackedDeltas(buf, q, n, limit);
        const yd = readPackedDeltas(buf, xd.end, n, limit);
        if (!points) {
          for (let i = 0; i < pointCount; i++) {
            dx[i] += xd.values[i] * scalar;
            dy[i] += yd.values[i] * scalar;
          }
        } else {
          const tx = new Float64Array(pointCount);
          const ty = new Float64Array(pointCount);
          const touched = new Uint8Array(pointCount);
          // A point named twice takes both deltas, as the spec says.
          points.forEach((p, k) => {
            if (p < pointCount) {
              tx[p] += xd.values[k];
              ty[p] += yd.values[k];
              touched[p] = 1;
            }
          });
          inferUntouched(tx, ty, touched, ends, xs, ys);
          for (let i = 0; i < pointCount; i++) {
            dx[i] += tx[i] * scalar;
            dy[i] += ty[i] * scalar;
          }
        }
        any = true;
      }
      return any ? { dx, dy } : null;
    },
  };
}

/** Parses "wght=700,wdth=90" (or with spaces, semicolons or colons) into axis coordinates. */
export function parseVariation(text) {
  const coords = {};
  const parts = String(text).trim().split(/[,;\s]+/).filter(Boolean);
  if (!parts.length) throw new Error('--variation needs axis coordinates such as "wght=700,wdth=90"');
  for (const part of parts) {
    const m = /^([A-Za-z0-9]{1,4})[=:](-?\d+(?:\.\d+)?)$/.exec(part);
    if (!m) throw new Error(`--variation could not read "${part}": give each axis as tag=value, such as wght=700`);
    coords[m[1].padEnd(4, " ")] = Number(m[2]);
  }
  return coords;
}
