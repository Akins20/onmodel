import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeBitmapFont } from "../src/bitmapfontset.mjs";
import { loadFont, textPath, describeVariation, variationSlug } from "../src/font.mjs";
import { parseVariation, normalise, regionScalar, readStore, storeScalars, storeDelta } from "../src/variation.mjs";

/**
 * A variable TrueType font built byte by byte: one weight axis from 100 to 900 round 400, two
 * named instances, gvar deltas that name every point of one glyph and only two points of
 * another (so the rest are inferred), a composite whose offset and advance move, avar bending
 * the axis, and HVAR carrying advances. Every expected number below is worked by hand from the
 * spec, not read back from the code.
 */

const u16 = (v) => [(v >> 8) & 255, v & 255];
const i16 = (v) => u16(v < 0 ? v + 65536 : v);
const u32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const fx = (v) => u32(Math.round(v * 65536) >>> 0);
const f2 = (v) => i16(Math.round(v * 16384));

function simpleGlyph(points) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const b = [...i16(1), ...[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].flatMap(i16), ...u16(points.length - 1), ...u16(0), ...points.map(() => 1)];
  let px = 0;
  let py = 0;
  const xd = [];
  const yd = [];
  for (const [x, y] of points) {
    xd.push(...i16(x - px));
    yd.push(...i16(y - py));
    px = x;
    py = y;
  }
  const g = [...b, ...xd, ...yd];
  if (g.length % 2) g.push(0);
  return Buffer.from(g);
}

/** A glyph of several contours, every point on the curve. */
function multiGlyph(contours) {
  const all = contours.flat();
  const xs = all.map((p) => p[0]);
  const ys = all.map((p) => p[1]);
  let end = -1;
  const ends = contours.map((c) => (end += c.length));
  const b = [...i16(contours.length), ...[Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)].flatMap(i16), ...ends.flatMap(u16), ...u16(0), ...all.map(() => 1)];
  let px = 0;
  let py = 0;
  const xd = [];
  const yd = [];
  for (const [x, y] of all) {
    xd.push(...i16(x - px));
    yd.push(...i16(y - py));
    px = x;
    py = y;
  }
  const g = [...b, ...xd, ...yd];
  if (g.length % 2) g.push(0);
  return Buffer.from(g);
}

function compositeGlyph(parts) {
  const b = [...i16(-1), ...[0, 0, 0, 0].flatMap(i16)];
  parts.forEach((p, i) => b.push(...u16(0x1 | 0x2 | (p.flags ?? 0) | (i < parts.length - 1 ? 0x20 : 0)), ...u16(p.gid), ...i16(p.dx), ...i16(p.dy)));
  if (b.length % 2) b.push(0);
  return Buffer.from(b);
}

/** Point numbers as gvar packs them: a count, then runs of differences; null means every point. */
function packPoints(points) {
  if (!points) return [0];
  let prev = 0;
  const deltas = points.map((p) => {
    const d = p - prev;
    prev = p;
    return d;
  });
  const words = deltas.some((d) => d > 255);
  return [points.length, (deltas.length - 1) | (words ? 0x80 : 0), ...deltas.flatMap((d) => (words ? u16(d) : [d]))];
}

/** Deltas as gvar packs them: runs of zeros, of bytes, of words. */
function packDeltas(values) {
  const out = [];
  const cls = (v) => (v === 0 ? 0 : Math.abs(v) <= 127 ? 1 : 2);
  let i = 0;
  while (i < values.length) {
    const c = cls(values[i]);
    let j = i;
    while (j < values.length && j - i < 64 && cls(values[j]) === c) j++;
    const n = j - i;
    if (c === 0) out.push(0x80 | (n - 1));
    else if (c === 1) out.push(n - 1, ...values.slice(i, j).map((v) => v & 255));
    else out.push(0x40 | (n - 1), ...values.slice(i, j).flatMap(i16));
    i = j;
  }
  return out;
}

/**
 * gvar: shared tuples, then per glyph its tuples. A tuple names its peak (an array, embedded) or a
 * shared index, optional start/end, and `points` (an array, or null for all) when private; a
 * glyph may name `sharedPoints` for all its tuples.
 */
function gvarTable({ axisCount, shared, glyphs }) {
  const datas = glyphs.map((g) => {
    if (!g || !g.tuples.length) return Buffer.alloc(0);
    const headers = [];
    const serial = [];
    let count = g.tuples.length;
    if (g.sharedPoints !== undefined) {
      count |= 0x8000;
      serial.push(...packPoints(g.sharedPoints));
    }
    for (const t of g.tuples) {
      const body = [];
      if (t.points !== undefined) body.push(...packPoints(t.points));
      body.push(...packDeltas(t.dx), ...packDeltas(t.dy));
      let index = 0;
      const h = [];
      if (Array.isArray(t.peak)) {
        index |= 0x8000;
        h.push(...t.peak.flatMap(f2));
      } else index |= t.peak;
      if (t.start) {
        index |= 0x4000;
        h.push(...t.start.flatMap(f2), ...t.end.flatMap(f2));
      }
      if (t.points !== undefined) index |= 0x2000;
      headers.push(...u16(body.length), ...u16(index), ...h);
      serial.push(...body);
    }
    const bytes = [...u16(count), ...u16(4 + headers.length), ...headers, ...serial];
    if (bytes.length % 2) bytes.push(0);
    return Buffer.from(bytes);
  });
  const offsets = [0];
  for (const d of datas) offsets.push(offsets[offsets.length - 1] + d.length);
  const sharedBytes = shared.flatMap((t) => t.flatMap(f2));
  const headerSize = 20 + (glyphs.length + 1) * 2;
  const head = [...u16(1), ...u16(0), ...u16(axisCount), ...u16(shared.length), ...u32(headerSize), ...u16(glyphs.length), ...u16(0), ...u32(headerSize + sharedBytes.length), ...offsets.flatMap((o) => u16(o / 2))];
  return Buffer.concat([Buffer.from(head), Buffer.from(sharedBytes), ...datas]);
}

function fvarTable(axes, instances) {
  const b = [...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(axes.length), ...u16(20), ...u16(instances.length), ...u16(axes.length * 4 + 4)];
  for (const a of axes) b.push(...Buffer.from(a.tag, "latin1"), ...fx(a.min), ...fx(a.def), ...fx(a.max), ...u16(0), ...u16(a.nameID));
  for (const inst of instances) b.push(...u16(inst.nameID), ...u16(0), ...inst.coords.flatMap(fx));
  return Buffer.from(b);
}

const avarTable = (maps) => Buffer.from([...u16(1), ...u16(0), ...u16(0), ...u16(maps.length), ...maps.flatMap((m) => [...u16(m.length), ...m.flatMap(([a, b]) => [...f2(a), ...f2(b)])])]);

function nameTable(entries) {
  const recs = [];
  const strings = [];
  let off = 0;
  for (const e of entries) {
    const bytes = Buffer.from(e.text, "utf16le").swap16();
    recs.push(...u16(3), ...u16(1), ...u16(0x409), ...u16(e.id), ...u16(bytes.length), ...u16(off));
    strings.push(bytes);
    off += bytes.length;
  }
  return Buffer.concat([Buffer.from([...u16(0), ...u16(entries.length), ...u16(6 + entries.length * 12)]), Buffer.from(recs), ...strings]);
}

/** An item variation store: regions as [start, peak, end] per axis; data as region indexes and delta sets. */
export function ivsTable({ axisCount, regions, data }) {
  const regionList = [...u16(axisCount), ...u16(regions.length), ...regions.flatMap((r) => r.flatMap((a) => a.flatMap(f2)))];
  const ivds = data.map((d) => {
    const words = d.deltaSets.some((set) => set.some((v) => Math.abs(v) > 127)) ? d.regionIndexes.length : 0;
    const b = [...u16(d.deltaSets.length), ...u16(words), ...u16(d.regionIndexes.length), ...d.regionIndexes.flatMap(u16)];
    for (const set of d.deltaSets) for (let r = 0; r < d.regionIndexes.length; r++) b.push(...(r < words ? i16(set[r]) : [set[r] & 255]));
    return Buffer.from(b);
  });
  const headSize = 8 + 4 * data.length;
  const offsets = [];
  let at = headSize + regionList.length;
  for (const d of ivds) {
    offsets.push(at);
    at += d.length;
  }
  return Buffer.concat([Buffer.from([...u16(1), ...u32(headSize), ...u16(data.length), ...offsets.flatMap(u32)]), Buffer.from(regionList), ...ivds]);
}

const hvarTable = (ivs) => Buffer.concat([Buffer.from([...u32(0x00010000), ...u32(20), ...u32(0), ...u32(0), ...u32(0)]), ivs]);

/** MVAR: one value record per tag, each naming an item in the store that follows the records. */
const mvarTable = (records, ivs) => Buffer.concat([Buffer.from([...u16(1), ...u16(0), ...u16(0), ...u16(8), ...u16(records.length), ...u16(12 + records.length * 8), ...records.flatMap(([t, o, i]) => [...Buffer.from(t, "latin1"), ...u16(o), ...u16(i)])]), ivs]);

/**
 * GDEF 1.3: the 1.2 header's 16-bit mark glyph sets offset at +12, then the variation store's
 * 32-bit offset at +14, the store itself right after the 18-byte header.
 */
const gdefTable = (ivs) => Buffer.concat([Buffer.from([...u16(1), ...u16(3), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u16(0), ...u32(18)]), ivs]);

/**
 * GPOS with one latn script whose kern feature runs one PairPos format 1 lookup: glyph 1 then
 * glyph 2 closes up by -50 on the first glyph's advance and moves the second by +10, each with a
 * variation-index device table (items 0 and 1 of GDEF's store). Device offsets in a format 1
 * subtable are from the PairSet.
 */
function gposTable() {
  const scriptList = [...u16(1), ...Buffer.from("latn", "latin1"), ...u16(8), ...u16(4), ...u16(0), ...u16(0), ...u16(0xffff), ...u16(1), ...u16(0)];
  const featureList = [...u16(1), ...Buffer.from("kern", "latin1"), ...u16(8), ...u16(0), ...u16(1), ...u16(0)];
  const pairSet = [...u16(1), ...u16(2), ...i16(-50), ...u16(12), ...i16(10), ...u16(18), ...u16(0), ...u16(0), ...u16(0x8000), ...u16(0), ...u16(1), ...u16(0x8000)];
  const coverage = [...u16(1), ...u16(1), ...u16(1)];
  const pairPos = [...u16(1), ...u16(12), ...u16(0x0044), ...u16(0x0011), ...u16(1), ...u16(18), ...coverage, ...pairSet];
  const lookupList = [...u16(1), ...u16(4), ...u16(2), ...u16(0), ...u16(1), ...u16(8), ...pairPos];
  const head = 10;
  return Buffer.from([...u16(1), ...u16(0), ...u16(head), ...u16(head + scriptList.length), ...u16(head + scriptList.length + featureList.length), ...scriptList, ...featureList, ...lookupList]);
}

function sfnt(parts) {
  const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const dir = Buffer.alloc(12 + parts.length * 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(parts.length, 4);
  let at = dir.length;
  const bodies = [];
  parts.forEach(([name, body], i) => {
    const padded = pad4(body);
    dir.write(name, 12 + i * 16, 4, "latin1");
    dir.writeUInt32BE(at, 12 + i * 16 + 8);
    dir.writeUInt32BE(body.length, 12 + i * 16 + 12);
    bodies.push(padded);
    at += padded.length;
  });
  return Buffer.concat([dir, ...bodies]);
}

/**
 * Glyph 1: a square 100..500 x 0..400 whose right side moves 200 at full weight (every point named).
 * Glyph 2: a 6-point box 0..200 x 0..100 where only points 0 and 2 are named (0 and +100), so the
 * rest are inferred. Glyph 3: glyph 1 placed at (0, 500), its offset rising 100 and its advance
 * growing 100 through the phantom points. A is glyph 1, B glyph 2, C glyph 3. Glyph 4, reached by
 * no character, is a 100-unit square moved +40 by an intermediate tuple that peaks at 0.5 and ends
 * there too.
 */
function varFont({ variable = true, avar = false, hvar = false, gpos = false, mvar = false } = {}) {
  const SQ = [[0, 0], [100, 0], [100, 100], [0, 100]];
  const glyphs = [Buffer.alloc(0), simpleGlyph([[100, 0], [500, 0], [500, 400], [100, 400]]), simpleGlyph([[0, 0], [100, 0], [200, 0], [200, 100], [100, 100], [0, 100]]), compositeGlyph([{ gid: 1, dx: 0, dy: 500 }]), simpleGlyph([[0, 0], [100, 0], [100, 100], [0, 100]]), Buffer.alloc(0), compositeGlyph([{ gid: 7, dx: 0, dy: 0, flags: 0x200 }]), simpleGlyph(SQ), simpleGlyph(SQ), simpleGlyph(SQ), multiGlyph([[[0, 0], [100, 0], [300, 0], [300, 100], [0, 100]], [[0, 200], [0, 300], [50, 300], [50, 200]]])];
  const numGlyphs = glyphs.length;
  const loca = Buffer.alloc((numGlyphs + 1) * 2);
  let off = 0;
  glyphs.forEach((g, i) => {
    loca.writeUInt16BE(off / 2, i * 2);
    off += g.length;
  });
  loca.writeUInt16BE(off / 2, numGlyphs * 2);
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18);
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4);
  hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(numGlyphs, 34);
  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g++) hmtx.writeUInt16BE(g === 7 ? 700 : 600, g * 4);
  const sub = Buffer.alloc(32 + 3 * 2);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(4, 6);
  sub.writeUInt16BE(0x43, 14);
  sub.writeUInt16BE(0xffff, 16);
  sub.writeUInt16BE(0x41, 20);
  sub.writeUInt16BE(0xffff, 22);
  sub.writeInt16BE(0, 24);
  sub.writeInt16BE(1, 26);
  sub.writeUInt16BE(4, 28);
  sub.writeUInt16BE(0, 30);
  [1, 2, 3].forEach((g, i) => sub.writeUInt16BE(g, 32 + i * 2));
  const cmapHead = Buffer.alloc(12);
  cmapHead.writeUInt16BE(1, 2);
  cmapHead.writeUInt16BE(3, 4);
  cmapHead.writeUInt16BE(1, 6);
  cmapHead.writeUInt32BE(12, 8);
  const parts = [
    ["cmap", Buffer.concat([cmapHead, sub])],
    ["glyf", Buffer.concat(glyphs)],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["name", nameTable([{ id: 1, text: "Var Test" }, { id: 256, text: "Weight" }, { id: 257, text: "Light" }, { id: 258, text: "Bold" }])],
  ];
  if (variable) {
    parts.push(["fvar", fvarTable([{ tag: "wght", min: 100, def: 400, max: 900, nameID: 256 }], [{ nameID: 257, coords: [100] }, { nameID: 258, coords: [900] }])]);
    parts.push([
      "gvar",
      gvarTable({
        axisCount: 1,
        shared: [[1]],
        glyphs: [
          null,
          { sharedPoints: null, tuples: [{ peak: [1], dx: [0, 200, 200, 0, 0, 0, 0, 0], dy: [0, 0, 0, 0, 0, 0, 0, 0] }] },
          { tuples: [{ peak: 0, points: [0, 2], dx: [0, 100], dy: [0, 0] }] },
          { sharedPoints: null, tuples: [{ peak: 0, dx: [0, 0, 100, 0, 0], dy: [100, 0, 0, 0, 0] }] },
          { sharedPoints: null, tuples: [{ peak: [0.5], start: [0], end: [0.5], dx: [40, 40, 40, 40, 0, 0, 0, 0], dy: [0, 0, 0, 0, 0, 0, 0, 0] }] },
          { sharedPoints: null, tuples: [{ peak: 0, dx: [0, 30, 0, 0], dy: [0, 0, 0, 0] }] },
          { sharedPoints: null, tuples: [{ peak: 0, dx: [0, 0, 10, 0, 0], dy: [0, 0, 0, 0, 0] }] },
          { sharedPoints: null, tuples: [{ peak: 0, dx: [0, 0, 0, 0, 0, 50, 0, 0], dy: [0, 0, 0, 0, 0, 0, 0, 0] }] },
          { tuples: [{ peak: 0, points: [1, 1], dx: [30, 20], dy: [0, 0] }, { peak: 5, points: null, dx: [500, 500, 500, 500, 0, 0, 0, 0], dy: [0, 0, 0, 0, 0, 0, 0, 0] }] },
          { sharedPoints: null, tuples: [{ peak: [0.5], start: [-0.5], end: [1], dx: [40, 40, 40, 40, 0, 0, 0, 0], dy: [0, 0, 0, 0, 0, 0, 0, 0] }] },
          { tuples: [{ peak: 0, points: [0, 1, 5, 6], dx: [0, 100, 10, 30], dy: [0, 0, 0, 0] }] },
        ],
      }),
    ]);
    if (avar) parts.push(["avar", avarTable(Array.isArray(avar) ? avar : [[[-1, -1], [0, 0], [0.5, 0.25], [1, 1]]])]);
    if (hvar) parts.push(["HVAR", hvarTable(ivsTable({ axisCount: 1, regions: [[[0, 1, 1]]], data: [{ regionIndexes: [0], deltaSets: [[0], [50], [0], [80]] }] }))]);
    if (mvar) parts.push(["MVAR", mvarTable([["hasc", 0, 0]], ivsTable({ axisCount: 1, regions: [[[0, 1, 1]]], data: [{ regionIndexes: [0], deltaSets: [[100]] }] }))]);
  }
  if (gpos) {
    parts.push(["GPOS", gposTable()]);
    if (variable) parts.push(["GDEF", gdefTable(ivsTable({ axisCount: 1, regions: [[[0, 1, 1]]], data: [{ regionIndexes: [0], deltaSets: [[-40], [20]] }] }))]);
  }
  return sfnt(parts);
}

const SQUARE = "M100 0L500 0L500 400L100 400L100 0Z";

test("a variable font left alone reads at its default, and says what it has", () => {
  const font = loadFont(varFont());
  assert.equal(font.glyphPath(1), SQUARE);
  assert.deepEqual(font.axes, [{ tag: "wght", name: "Weight", min: 100, default: 400, max: 900, hidden: false }]);
  assert.deepEqual(font.instances, [{ name: "Light", coords: { wght: 100 } }, { name: "Bold", coords: { wght: 900 } }]);
  assert.deepEqual(font.variation, { wght: 400 });
  assert.equal(font.instance, null, "no instance sits at the default");
  assert.equal(font.varies, false);
  assert.equal(describeVariation(font), null);
  assert.equal(font.family, "Var Test");
  const still = loadFont(varFont({ variable: false }));
  assert.deepEqual(still.axes, []);
  assert.equal(still.variation, null);
});

test("coordinates move the points gvar names, and the points it leaves out are inferred from their neighbours", () => {
  const bold = loadFont(varFont(), { variation: { wght: 900 } });
  assert.equal(bold.varies, true);
  assert.equal(bold.glyphPath(1), "M100 0L700 0L700 400L100 400L100 0Z", "every point named: the right side moves 200");
  // Points 0 and 2 named (0 and +100): point 1 at x 100 between them gets half, point 3 at x 200 (on
  // the far reference) gets the full delta, point 4 at x 100 half, point 5 at x 0 none; y never moves.
  assert.equal(bold.glyphPath(2), "M0 0L150 0L300 0L300 100L150 100L0 100L0 0Z");
  const half = loadFont(varFont(), { variation: { wght: 650 } });
  assert.equal(half.glyphPath(1), "M100 0L600 0L600 400L100 400L100 0Z", "halfway to the maximum, half the delta");
  const light = loadFont(varFont(), { variation: { wght: 100 } });
  assert.equal(light.glyphPath(1), SQUARE, "the tuple peaks on the heavy side, so the light side is untouched");
  assert.equal(light.varies, true, "set away from the default all the same");
});

test("avar bends the axis before the deltas are weighted", () => {
  const font = loadFont(varFont({ avar: true }), { variation: { wght: 650 } });
  // 650 normalises to 0.5, which the map sends to 0.25.
  assert.equal(font.glyphPath(1), "M100 0L550 0L550 400L100 400L100 0Z");
  assert.equal(loadFont(varFont({ avar: true }), { variation: { wght: 900 } }).glyphPath(1), "M100 0L700 0L700 400L100 400L100 0Z");
});

test("a composite moves with its parts and its own offset; advances come from HVAR, else from the phantom points", () => {
  const phantom = loadFont(varFont(), { variation: { wght: 900 } });
  assert.equal(phantom.glyphPath(3), "M100 600L700 600L700 1000L100 1000L100 600Z", "the part's own deltas and the offset's 100");
  assert.equal(phantom.advanceOf(3), 700, "the right phantom point moved 100");
  assert.equal(phantom.advanceOf(1), 600, "glyph 1's phantoms did not move");
  const hvar = loadFont(varFont({ hvar: true }), { variation: { wght: 900 } });
  assert.equal(hvar.advanceOf(1), 650);
  assert.equal(hvar.advanceOf(3), 680, "HVAR wins over the phantom points");
  assert.equal(loadFont(varFont({ hvar: true }), { variation: { wght: 650 } }).advanceOf(1), 625);
  assert.equal(loadFont(varFont({ hvar: true })).advanceOf(1), 600, "nothing moves at the default");
  const set = textPath(hvar, "AA", { size: 100 });
  assert.equal(set.width, 130, "the set width carries the moved advances");
});

test("an intermediate tuple applies in full at its own peak, even where its range ends there", () => {
  const at = (wght) => loadFont(varFont(), { variation: { wght } }).glyphPath(4);
  assert.equal(at(650), "M40 0L140 0L140 100L40 100L40 0Z", "0.5 is the peak and the end: all of the +40");
  assert.equal(at(525), "M20 0L120 0L120 100L20 100L20 0Z", "0.25 is halfway up from the start");
  assert.equal(at(900), "M0 0L100 0L100 100L0 100L0 0Z", "past the end: none");
  assert.equal(at(100), "M0 0L100 0L100 100L0 100L0 0Z", "on the other side of the default: none");
});

test("kerning moves with the axes: GPOS device tables point into GDEF's variation store", () => {
  // The first glyph's advance -50 moves by -40 at full weight, the second glyph's placement +10
  // by +20; the kerning is their sum.
  const kern = (variation) => loadFont(varFont({ gpos: true }), variation ? { variation } : {}).kernBetween(1, 2);
  assert.equal(kern(null), -40);
  assert.equal(kern({ wght: 900 }), -60);
  assert.equal(kern({ wght: 650 }), -50);
  assert.equal(kern({ wght: 100 }), -40, "the region lies on the heavy side");
  assert.equal(loadFont(varFont({ gpos: true }), { variation: { wght: 900 } }).kernBetween(2, 1), 0, "only the pair in that order");
  assert.equal(loadFont(varFont({ variable: false, gpos: true })).kernBetween(1, 2), -40, "a static font reads the same values without devices");
  const set = textPath(loadFont(varFont({ gpos: true }), { variation: { wght: 900 } }), "AB", { size: 100 });
  assert.equal(set.width, 114, "600 - 60 + 600 at a tenth");
});

test("MVAR moves the line metrics", () => {
  const at = (variation) => loadFont(varFont({ mvar: true }), variation ? { variation } : {});
  assert.equal(at(null).ascender, 800);
  assert.equal(at({ wght: 900 }).ascender, 900);
  assert.equal(at({ wght: 650 }).ascender, 850);
  assert.equal(at({ wght: 900 }).descender, -200, "a metric MVAR does not name stays put");
});

test("a named instance sets its coordinates, and coordinates that match one are named by it", () => {
  const bold = loadFont(varFont(), { instance: "bold" });
  assert.deepEqual(bold.variation, { wght: 900 });
  assert.equal(bold.instance, "Bold");
  assert.equal(bold.glyphPath(1), "M100 0L700 0L700 400L100 400L100 0Z");
  assert.equal(describeVariation(bold), "Bold (wght 900)");
  assert.equal(variationSlug(bold), "bold");
  const byCoords = loadFont(varFont(), { variation: { wght: 900 } });
  assert.equal(byCoords.instance, "Bold");
  const light = loadFont(varFont(), { instance: "LIGHT" });
  assert.deepEqual(light.variation, { wght: 100 });
  const mixed = loadFont(varFont(), { instance: "Light", variation: { wght: 650 } });
  assert.deepEqual(mixed.variation, { wght: 650 }, "coordinates given beside an instance win");
  assert.equal(mixed.instance, null);
  assert.equal(describeVariation(mixed), "wght 650");
  assert.equal(variationSlug(mixed), "wght650");
});

test("a font that does not vary, an unknown axis, an unknown instance and a coordinate past the axis", () => {
  assert.throws(() => loadFont(varFont({ variable: false }), { variation: { wght: 700 } }), /does not vary/);
  assert.throws(() => loadFont(varFont({ variable: false }), { instance: "Bold" }), /does not vary/);
  assert.throws(() => loadFont(varFont(), { variation: { wdth: 75 } }), /no "wdth" axis; it has wght \(100 to 900, 400 by default\)/);
  assert.throws(() => loadFont(varFont(), { instance: "Black" }), /no instance named "Black"; it has Light, Bold/);
  const clamped = loadFont(varFont(), { variation: { wght: 5000 } });
  assert.deepEqual(clamped.variation, { wght: 900 }, "clamped to the axis");
  assert.equal(clamped.instance, "Bold");
});

test("--variation text parses tags and numbers in the forms people type", () => {
  assert.deepEqual(parseVariation("wght=700,wdth=90"), { wght: 700, wdth: 90 });
  assert.deepEqual(parseVariation("wght:700 opsz=14.5; wdth=87.5"), { wght: 700, opsz: 14.5, wdth: 87.5 });
  assert.deepEqual(parseVariation("GRAD=-50"), { GRAD: -50 });
  assert.throws(() => parseVariation("bold"), /tag=value/);
  assert.throws(() => parseVariation(""), /axis coordinates/);
});

test("a variable font from this machine sets heavier, narrower and in between", async (t) => {
  // Windows ships Bahnschrift (weight and width, with avar and HVAR); skipped where it is absent.
  let bytes;
  try {
    bytes = await readFile("C:/Windows/Fonts/bahnschrift.ttf");
  } catch {
    return t.skip("no Bahnschrift on this machine");
  }
  const regular = loadFont(bytes);
  assert.ok(regular.axes.some((a) => a.tag === "wght") && regular.axes.some((a) => a.tag === "wdth"));
  assert.ok(regular.instances.some((i) => i.name === "Bold Condensed"));
  const bold = loadFont(bytes, { instance: "Bold" });
  const condensed = loadFont(bytes, { variation: { wdth: 75 } });
  const between = loadFont(bytes, { variation: { wght: 512, wdth: 87.5 } });
  const H = regular.glyphFor(0x48);
  const width = (f) => f.glyphBounds(H).xMax - f.glyphBounds(H).xMin;
  assert.ok(width(bold) > width(regular) + 20, `a bold H is wider: ${width(bold)} vs ${width(regular)}`);
  assert.ok(width(condensed) < width(regular) - 100, `a condensed H is narrower: ${width(condensed)} vs ${width(regular)}`);
  assert.ok(condensed.advanceOf(H) < regular.advanceOf(H) - 100, "and its advance moved with it, through HVAR");
  assert.ok(width(between) > width(condensed) && width(between) < width(regular), "a coordinate between instances lands between them");
  assert.equal(bold.capHeight, regular.capHeight, "Bahnschrift keeps its cap height across weights");
  assert.equal(describeVariation(bold), "Bold (wght 700, wdth 100)");
  const set = textPath(bold, "Hamburgefonstiv", { size: 64 });
  assert.equal(set.missing.length + set.blank.length, 0);
});

/** A copy of a font with one table's bytes changed by \`edit(buf, offset)\`. */
function patched(font, tag, edit) {
  const buf = Buffer.from(font);
  const count = buf.readUInt16BE(4);
  for (let i = 0; i < count; i++) {
    if (buf.toString("latin1", 12 + i * 16, 16 + i * 16) === tag) {
      edit(buf, buf.readUInt32BE(12 + i * 16 + 8));
      return buf;
    }
  }
  throw new Error(`no ${tag} table`);
}

test("a space's advance moves through its phantom points when the font has no HVAR", () => {
  // Glyph 5 has no outline; its gvar moves phantom point 1 (the advance) by 30 at full weight.
  const at = (variation, opts = {}) => loadFont(varFont(opts), variation ? { variation } : {}).advanceOf(5);
  assert.equal(at(null), 600);
  assert.equal(at({ wght: 900 }), 630);
  assert.equal(at({ wght: 650 }), 615);
  assert.equal(at({ wght: 900 }, { hvar: true }), 600, "with HVAR the advance comes from HVAR, which names no item for it");
});

test("a USE_MY_METRICS component lends the composite its advance, varied", () => {
  // Glyph 6 places glyph 7 with USE_MY_METRICS; glyph 7 is 700 wide and its phantom moves 50, the
  // composite's own phantom 10. FreeType and HarfBuzz both take the component's: 750, not 610.
  const bold = loadFont(varFont(), { variation: { wght: 900 } });
  assert.equal(bold.advanceOf(7), 750);
  assert.equal(bold.advanceOf(6), 750);
});

test("a point named twice takes both deltas, and a shared tuple the table lacks is dropped", () => {
  // Glyph 8 names point 1 twice (+30 and +20) and nothing else, so the one named point carries
  // the whole contour +50. Its second tuple names shared tuple 5 of 1 and would move it +500.
  assert.equal(loadFont(varFont(), { variation: { wght: 900 } }).glyphPath(8), "M50 0L150 0L150 100L50 100L50 0Z");
});

test("inferred points outside their references take the nearer one's delta; references sharing a coordinate pass on nothing unless they agree", () => {
  // Contour one: points 0 (x 0, +0) and 1 (x 100, +100) named; 2 and 3 at x 300 lie past the
  // references and take +100 (extrapolating would give +300), 4 at x 0 takes 0. Contour two:
  // points 5 and 6 named (+10, +30) share x 0, so 7 and 8 between them get nothing.
  assert.equal(loadFont(varFont(), { variation: { wght: 900 } }).glyphPath(10), "M0 0L200 0L400 0L400 100L0 100L0 0ZM10 200L30 300L50 300L50 200L10 200Z");
});

test("an axis whose range is not a proper tent is ignored, in gvar tuples and in the stores", () => {
  // Glyph 9's intermediate tuple runs from -0.5 through 0.5 to 1: it crosses zero, so the spec
  // ignores the axis and the tuple applies in full wherever the font is set.
  const at = (wght) => loadFont(varFont(), { variation: { wght } }).glyphPath(9);
  assert.equal(at(100), "M40 0L140 0L140 100L40 100L40 0Z");
  assert.equal(at(650), "M40 0L140 0L140 100L40 100L40 0Z");
  assert.equal(regionScalar([[-0.5, 0.5, 1]], [0.25]), 1, "crossing zero");
  assert.equal(regionScalar([[0.6, 0.5, 1]], [0.55]), 1, "start past the peak");
  assert.equal(regionScalar([[0, 0.5, 0.4]], [0.45]), 1, "peak past the end");
  assert.equal(regionScalar([[0, 0.5, 1]], [0.25]), 0.5, "a proper tent halfway up");
  assert.equal(regionScalar([[0, 0.5, 1]], [-0.25]), 0, "and outside it");
});

test("an avar map without its -1, 0 and 1 points, or out of order, leaves the axis unbent", () => {
  const half = "M100 0L600 0L600 400L100 400L100 0Z";
  assert.equal(loadFont(varFont({ avar: [[[-1, -1], [0.5, 0.25], [1, 1]]] }), { variation: { wght: 650 } }).glyphPath(1), half, "no 0 to 0 point");
  assert.equal(loadFont(varFont({ avar: [[[-1, -1], [0, 0], [1, 1], [0.5, 0.25]]] }), { variation: { wght: 650 } }).glyphPath(1), half, "points out of order");
  assert.equal(loadFont(varFont({ avar: true }), { variation: { wght: 650 } }).glyphPath(1), "M100 0L550 0L550 400L100 400L100 0Z", "a proper map still bends");
});

test("normalisation runs in 16.16 and rounds once to F2DOT14, as the spec requires", () => {
  // wght 413 on a 100..400..900 axis bent 0.6667 to 0.5 (10923 to 8192 in F2DOT14):
  // 16.16: 13 * 65536 / 500 = 1703.936, rounds to 1704.
  // avar in 16.16: points 43692 -> 32768, so 32768 * 1704 / 43692 = 1277.96, rounds to 1278.
  // To F2DOT14: (1278 + 2) >> 2 = 320. Bending the unrounded double and rounding at the end
  // gives 319 (0.026 * 0.5 / 0.666687 * 16384 = 319.47).
  const axis = { tag: "wght", min: 100, def: 400, max: 900 };
  const map = [[-16384, -16384], [0, 0], [10923, 8192], [16384, 16384]];
  assert.equal(normalise([axis], [map], { wght: 413 }).norm[0], 320 / 16384);
  assert.equal(normalise([axis], [map], { wght: 900 }).norm[0], 1);
  assert.equal(normalise([axis], [map], { wght: 100 }).norm[0], -1);
  assert.equal(normalise([axis], [[]], { wght: 650 }).norm[0], 0.5, "an empty map leaves the axis alone");
});

test("a malformed fvar or avar never stops a font left alone from opening", () => {
  // fvar's axis records claim to be 8 bytes, short of the 20 the spec fixes.
  const badFvar = patched(varFont(), "fvar", (b, at) => b.writeUInt16BE(8, at + 10));
  const alone = loadFont(badFvar);
  assert.deepEqual(alone.axes, []);
  assert.equal(alone.glyphPath(1), SQUARE);
  assert.throws(() => loadFont(badFvar, { variation: { wght: 700 } }), /fvar table is malformed/);
  // avar's map for the one axis claims 500 points it does not have: avar is not read when the
  // font is left alone, and is ignored when a setting is asked for.
  const badAvar = patched(varFont({ avar: true }), "avar", (b, at) => b.writeUInt16BE(500, at + 8));
  assert.equal(loadFont(badAvar).glyphPath(1), SQUARE);
  assert.equal(loadFont(badAvar, { variation: { wght: 650 } }).glyphPath(1), "M100 0L600 0L600 400L100 400L100 0Z");
});

test("a bitmap font's folder keeps its setting even when the font file's name is long", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-var-"));
  const file = path.join(dir, "AVeryLongVariableFontFamilyName-Variable[wght,wdth,opsz,GRAD].ttf");
  await writeFile(file, varFont());
  const light = await makeBitmapFont({ config: { out: dir }, fontPath: file, px: 12, chars: "ABC", instance: "Light", log: () => {} });
  const bold = await makeBitmapFont({ config: { out: dir }, fontPath: file, px: 12, chars: "ABC", variation: { wght: 900 }, log: () => {} });
  assert.notEqual(light.name, bold.name, "two settings, two folders");
  assert.ok(light.name.endsWith("-light-12"), light.name);
  assert.ok(bold.name.endsWith("-bold-12"), bold.name);
  assert.ok(light.name.length <= 60 && bold.name.length <= 60);
  assert.equal(bold.facts.setting, "Bold (wght 900)");
});

/**
 * A TrueType font holding the given glyphs at 1000 units, 600 wide each, with only U+0041 mapped
 * (to glyph 1) so that opening it reads no glyph; with \`gvar\`, a one-axis weight font.
 */
function bareFont(glyphs, gvar = null) {
  const numGlyphs = glyphs.length;
  const loca = Buffer.alloc((numGlyphs + 1) * 4);
  let off = 0;
  glyphs.forEach((g, i) => {
    loca.writeUInt32BE(off, i * 4);
    off += g.length;
  });
  loca.writeUInt32BE(off, numGlyphs * 4);
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(1000, 18);
  head.writeInt16BE(1, 50);
  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4);
  hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(numGlyphs, 34);
  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g++) hmtx.writeUInt16BE(600, g * 4);
  const sub = Buffer.alloc(34);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(34, 2);
  sub.writeUInt16BE(4, 6);
  sub.writeUInt16BE(0x41, 14);
  sub.writeUInt16BE(0xffff, 16);
  sub.writeUInt16BE(0x41, 20);
  sub.writeUInt16BE(0xffff, 22);
  sub.writeInt16BE(1 - 0x41, 24);
  sub.writeInt16BE(1, 26);
  const cmapHead = Buffer.alloc(12);
  cmapHead.writeUInt16BE(1, 2);
  cmapHead.writeUInt16BE(3, 4);
  cmapHead.writeUInt16BE(1, 6);
  cmapHead.writeUInt32BE(12, 8);
  const parts = [["cmap", Buffer.concat([cmapHead, sub])], ["glyf", Buffer.concat(glyphs)], ["head", head], ["hhea", hhea], ["hmtx", hmtx], ["loca", loca], ["maxp", maxp], ["name", nameTable([{ id: 1, text: "Bare" }, { id: 256, text: "Weight" }])]];
  if (gvar) parts.push(["fvar", fvarTable([{ tag: "wght", min: 100, def: 400, max: 900, nameID: 256 }], [])], ["gvar", gvar]);
  return sfnt(parts);
}

/** A one-contour glyph of n points all at the origin, its flags run-length coded: a few hundred bytes. */
function flatGlyph(n) {
  const flags = [];
  for (let left = n; left > 0; left -= 256) flags.push(0x39, Math.min(256, left) - 1);
  const g = [...i16(1), 0, 0, 0, 0, 0, 0, 0, 0, ...u16(n - 1), ...u16(0), ...flags];
  if (g.length % 2) g.push(0);
  return Buffer.from(g);
}

test("the avar-bent value is clamped back to the axis, as the spec's step 4 requires", () => {
  // A map whose 0.5 goes to 1.5 would hand regions a coordinate past the end of the axis.
  const axis = { tag: "wght", min: 100, def: 400, max: 900 };
  assert.equal(normalise([axis], [[[-16384, -16384], [0, 0], [8192, 24576], [16384, 16384]]], { wght: 650 }).norm[0], 1);
  assert.equal(normalise([axis], [[[-16384, -16384], [-8192, -24576], [0, 0], [16384, 16384]]], { wght: 250 }).norm[0], -1);
});

test("an avar record out of order is dropped on its own; the rest of the map still bends", () => {
  // 0.3 after 0.5 is out of order and goes; 0.5 to 0.25 stays, so 650 still lands at 0.25.
  const font = loadFont(varFont({ avar: [[[-1, -1], [0, 0], [0.5, 0.25], [0.3, 0.9], [1, 1]]] }), { variation: { wght: 650 } });
  assert.equal(font.glyphPath(1), "M100 0L550 0L550 400L100 400L100 0Z");
});

test("a NULL item variation data offset and a fractional outer index both mean no deltas", () => {
  // The region list sits at 65,539, so read as item data at offset 0 the store's own header would
  // give one word column and three region indexes (from its count and the NULL offset), and its
  // second data offset would read as a row of deltas: 0, 1 and 16 at full weight, 17 in all.
  const regionsAt = 65539;
  const store3 = Buffer.alloc(regionsAt + 4 + 3 * 6);
  store3.writeUInt16BE(1, 0);
  store3.writeUInt32BE(regionsAt, 2);
  store3.writeUInt16BE(2, 6);
  store3.writeUInt32BE(0, 8); // outer 0: NULL
  store3.writeUInt32BE(272, 12); // outer 1: one item, one region, a delta of 5
  store3.writeUInt16BE(1, 272);
  store3.writeUInt16BE(0, 274);
  store3.writeUInt16BE(1, 276);
  store3.writeUInt16BE(0, 278);
  store3.writeInt8(5, 280);
  store3.writeUInt16BE(1, regionsAt);
  store3.writeUInt16BE(3, regionsAt + 2);
  for (let r = 0; r < 3; r++) store3.writeInt16BE(16384, regionsAt + 4 + 6 * r + 2), store3.writeInt16BE(16384, regionsAt + 4 + 6 * r + 4);
  const store = readStore(store3, 0, store3.length, 1);
  const scalars = storeScalars(store, [1]);
  assert.equal(store.data(0), null);
  assert.equal(storeDelta(store, scalars, 0, 0), 0, "the store's own header is not read as data");
  assert.equal(storeDelta(store, scalars, 1, 0), 5);
  // 4 x 0.3 is no byte offset at all; reading at it would throw rather than find nothing.
  assert.equal(store.data(0.3), null);
  assert.equal(readStore(store3, 0.3, store3.length), null, "nor a store at a fractional offset");
});

test("a region list is read only as far as the deltas used ask, and must match the font's axes", () => {
  const ivs = ivsTable({ axisCount: 1, regions: [[[0, 1, 1]], [[-1, -1, 0]]], data: [{ regionIndexes: [1], deltaSets: [[-30]] }] });
  assert.equal(readStore(ivs, 0, ivs.length, 2), null, "a one-axis region list in a two-axis font");
  const store = readStore(ivs, 0, ivs.length, 1);
  assert.equal(storeDelta(store, storeScalars(store, [-1]), 0, 0), -30);
  // A table that really holds 40,000 regions, past the spec's limit of 32,767.
  const many = Buffer.concat([ivs, Buffer.alloc(40000 * 6)]);
  many.writeUInt16BE(40000, 8 + 4 + 2);
  assert.equal(readStore(many, 0, many.length), null);
  many.writeUInt16BE(32767, 8 + 4 + 2);
  assert.notEqual(readStore(many, 0, many.length), null, "32,767 is still allowed");
});

test("an instance whose name has no letters a folder can carry is named by its coordinates", () => {
  const font = { varies: true, instance: "\u2605", variation: { wght: 900 }, axes: [{ tag: "wght", default: 400 }] };
  assert.equal(variationSlug(font), "wght900");
  assert.equal(variationSlug({ ...font, instance: "Bold" }), "bold");
});

test("a glyph whose variation would cost millions of steps is refused, and reads at its default", () => {
  // 51,200 points in about 400 bytes, and 4,095 tuples each naming one point: every tuple would
  // otherwise infer deltas for all 51,200.
  const n = 51200;
  const tuple = { peak: 0, points: [0], dx: [5], dy: [0] };
  const font = bareFont([Buffer.alloc(0), flatGlyph(n)], gvarTable({ axisCount: 1, shared: [[1]], glyphs: [null, { tuples: Array.from({ length: 4095 }, () => tuple) }] }));
  assert.ok(loadFont(font).glyphPath(1).length > 0, "at the default gvar is never read");
  const t = performance.now();
  assert.throws(() => loadFont(font, { variation: { wght: 900 } }).glyphPath(1), /glyph 1 varies its points through more than 4,194,304 steps, so the font is malformed/);
  assert.ok(performance.now() - t < 5000, "and refused quickly");
});

test("composites nested to place millions of points are refused, even at the default", () => {
  // Each level places the one below 64 times: glyph 5 would draw 64^4 squares.
  const fan = (gid) => compositeGlyph(Array.from({ length: 64 }, () => ({ gid, dx: 0, dy: 0 })));
  const font = bareFont([Buffer.alloc(0), simpleGlyph([[0, 0], [10, 0], [10, 10], [0, 10]]), fan(1), fan(2), fan(3), fan(4)]);
  const loaded = loadFont(font);
  assert.equal(loaded.contoursOf(3).length, 64 * 64, "a big but real composite still reads");
  const t = performance.now();
  assert.throws(() => loaded.glyphPath(5), /glyph 5 places more than 2,097,152 points through its composites, so the font is malformed/);
  assert.ok(performance.now() - t < 5000, "and refused quickly");
});
