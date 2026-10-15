import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadFont, textPath } from "../src/font.mjs";
import { pathToPolygons, coverage } from "../src/vector.mjs";
import { rasterGlyph } from "../src/bmfont.mjs";

/**
 * CFF fonts built byte by byte, so the tests ship no font file. The charstrings use every
 * drawing operator, both kinds of subroutine, hint masks, widths in each position they can
 * take, a seac accent, and the arithmetic operators; a CID-keyed variant routes glyphs to
 * their own font dicts; a CFF2 variant blends at the default instance.
 */

// Type 2 charstring number and operator encoding.
const num = (v) => {
  if (Number.isInteger(v)) {
    if (v >= -107 && v <= 107) return [v + 139];
    if (v >= 108 && v <= 1131) return [((v - 108) >> 8) + 247, (v - 108) & 255];
    if (v >= -1131 && v <= -108) return [((-v - 108) >> 8) + 251, (-v - 108) & 255];
    return [28, (v >> 8) & 255, v & 255];
  }
  const f = Math.round(v * 65536);
  return [255, (f >>> 24) & 255, (f >>> 16) & 255, (f >>> 8) & 255, f & 255];
};
const OP = { hstem: 1, vstem: 3, vmoveto: 4, rlineto: 5, hlineto: 6, vlineto: 7, rrcurveto: 8, callsubr: 10, return: 11, endchar: 14, vsindex: 15, blend: 16, hstemhm: 18, hintmask: 19, cntrmask: 20, rmoveto: 21, hmoveto: 22, vstemhm: 23, rcurveline: 24, rlinecurve: 25, vvcurveto: 26, hhcurveto: 27, callgsubr: 29, vhcurveto: 30, hvcurveto: 31 };
const ESC = { and: 3, or: 4, not: 5, abs: 9, add: 10, sub: 11, div: 12, neg: 14, eq: 15, drop: 18, put: 20, get: 21, ifelse: 22, random: 23, mul: 24, sqrt: 26, dup: 27, exch: 28, index: 29, roll: 30, hflex: 34, flex: 35, hflex1: 36, flex1: 37 };
/** A charstring from numbers, operator names and raw bytes (`{ raw: [...] }` for mask bytes). */
const cs = (...items) => Buffer.from(items.flatMap((it) => (typeof it === "number" ? num(it) : typeof it === "string" ? (it in OP ? [OP[it]] : [12, ESC[it]]) : it.raw)));

// DICT operands as five-byte integers, so every layout has a fixed size; reals as packed nibbles.
const dnum = (v) => [29, (v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
const dreal = (v) => {
  const s = String(v);
  const nib = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === ".") nib.push(10);
    else if (ch === "e" || ch === "E") {
      if (s[i + 1] === "-") {
        nib.push(12);
        i++;
      } else nib.push(11);
    } else if (ch === "-") nib.push(14);
    else nib.push(Number(ch));
  }
  nib.push(15);
  if (nib.length % 2) nib.push(15);
  const out = [30];
  for (let i = 0; i < nib.length; i += 2) out.push((nib[i] << 4) | nib[i + 1]);
  return out;
};
const dict = (entries) => Buffer.from(entries.flatMap(([op, ...vals]) => [...vals.flatMap((v) => (Number.isInteger(v) ? dnum(v) : dreal(v))), ...(op >= 1200 ? [12, op - 1200] : [op])]));

function index(items, cff2 = false) {
  const count = cff2 ? [(items.length >>> 24) & 255, (items.length >>> 16) & 255, (items.length >>> 8) & 255, items.length & 255] : [(items.length >> 8) & 255, items.length & 255];
  if (!items.length) return Buffer.from(count);
  const total = items.reduce((n, b) => n + b.length, 0);
  const offSize = total + 1 < 256 ? 1 : total + 1 < 65536 ? 2 : 4;
  const offs = [];
  let at = 1;
  const push = (v) => {
    for (let k = offSize - 1; k >= 0; k--) offs.push((v >>> (8 * k)) & 255);
  };
  push(at);
  for (const b of items) push((at += b.length));
  return Buffer.concat([Buffer.from(count), Buffer.from([offSize]), Buffer.from(offs), ...items]);
}

/** An sfnt round the CFF table, with a cmap mapping codes to glyph ids, 1000 units to the em. */
function sfnt(cffTable, { tag = "CFF ", codes, numGlyphs, advance = 600, kind = "OTTO", unitsPerEm = 1000, extra = [] }) {
  const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(unitsPerEm, 18);
  const maxp = Buffer.alloc(6);
  maxp.writeUInt32BE(0x00005000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);
  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4);
  hhea.writeInt16BE(-200, 6);
  hhea.writeUInt16BE(numGlyphs, 34);
  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g++) hmtx.writeUInt16BE(advance, g * 4);
  // cmap format 4: one segment from the lowest code to the highest, through a glyph id array.
  const sorted = [...codes].sort((a, b) => a[0] - b[0]);
  const lo = sorted[0][0];
  const hi = sorted[sorted.length - 1][0];
  const ids = new Array(hi - lo + 1).fill(0);
  for (const [c, g] of sorted) ids[c - lo] = g;
  const sub = Buffer.alloc(32 + ids.length * 2);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(sub.length, 2);
  sub.writeUInt16BE(4, 6);
  sub.writeUInt16BE(hi, 14);
  sub.writeUInt16BE(0xffff, 16);
  sub.writeUInt16BE(lo, 20);
  sub.writeUInt16BE(0xffff, 22);
  sub.writeInt16BE(0, 24);
  sub.writeInt16BE(1, 26);
  sub.writeUInt16BE(4, 28);
  sub.writeUInt16BE(0, 30);
  ids.forEach((g, i) => sub.writeUInt16BE(g, 32 + i * 2));
  const cmapHead = Buffer.alloc(12);
  cmapHead.writeUInt16BE(1, 2);
  cmapHead.writeUInt16BE(3, 4);
  cmapHead.writeUInt16BE(1, 6);
  cmapHead.writeUInt32BE(12, 8);
  const parts = [[tag, cffTable], ["cmap", Buffer.concat([cmapHead, sub])], ["head", head], ["hhea", hhea], ["hmtx", hmtx], ["maxp", maxp], ...extra];
  const dir = Buffer.alloc(12 + parts.length * 16);
  if (kind === "OTTO") dir.write("OTTO", 0, 4, "latin1");
  else dir.writeUInt32BE(0x00010000, 0);
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

/** A name-keyed CFF table: header, name, top dict, strings, global subrs, charset, charstrings, private, local subrs. */
function cffTable({ charStrings, charsetSids, gsubrs = [], subrs = [], strings = [], nominalWidthX = 0, fontMatrix = null }) {
  const header = Buffer.from([1, 0, 4, 1]);
  const nameIndex = index([Buffer.from("Test")]);
  const stringIndex = index(strings.map((s) => Buffer.from(s)));
  const gsubrIndex = index(gsubrs);
  const charset = Buffer.from([0, ...charsetSids.flatMap((sid) => [(sid >> 8) & 255, sid & 255])]);
  const charStringsIndex = index(charStrings);
  const privateSize = dict([[20, 0], [21, nominalWidthX], [19, 0]]).length;
  const priv = dict([[20, 0], [21, nominalWidthX], [19, privateSize]]); // Subrs right after the private dict
  const subrIndex = index(subrs);
  const topFor = (o) => dict([...(fontMatrix ? [[1207, ...fontMatrix]] : []), [15, o.charset], [17, o.charStrings], [18, priv.length, o.priv]]);
  // Offsets are absolute from the start of the table; the dict's size does not depend on them.
  const topSize = index([topFor({ charset: 0, charStrings: 0, priv: 0 })]).length;
  let at = header.length + nameIndex.length + topSize + stringIndex.length + gsubrIndex.length;
  const o = { charset: at };
  at += charset.length;
  o.charStrings = at;
  at += charStringsIndex.length;
  o.priv = at;
  const top = index([topFor(o)]);
  assert.equal(top.length, topSize);
  return Buffer.concat([header, nameIndex, top, stringIndex, gsubrIndex, charset, charStringsIndex, priv, subrIndex]);
}

// Standard string ids: A is 34, acute is 125 (Standard Encoding code 194), and 391 is the first custom string.
const SQUARE = [100, 0, "rmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"];

function nameKeyedFont() {
  const charStrings = [
    cs("endchar"), // 0 .notdef
    cs(50, ...SQUARE), // 1 A: a width (nominal + 50) before rmoveto
    cs(200, 500, "rmoveto", 100, 0, "rlineto", -50, 100, "rlineto", "endchar"), // 2 acute: a triangle
    cs(50, 0, 100, 65, 194, "endchar"), // 3 Aacute: width, then seac of A and acute raised 100
    // 4 hints: eight hstems and a vstem implied by the hintmask's arguments make nine stems, so each
    // mask is two bytes; a mask skipped one byte short would read 0x80 as a number and bend the square
    cs(0, 10, 20, 10, 20, 10, 20, 10, 20, 10, 20, 10, 20, 10, 20, 10, "hstemhm", 0, 100, "hintmask", { raw: [0xff, 0x80] }, 100, 100, "rmoveto", "hintmask", { raw: [0xff, 0x80] }, 50, "hlineto", 50, "vlineto", -50, "hlineto", "endchar"),
    cs(100, 0, "rmoveto", -107, "callsubr", "endchar"), // 5 the square's sides from local subr 0
    cs(300, 0, "rmoveto", -107, "callgsubr", "endchar"), // 6 a 100-unit square from global subr 0, at 300
    cs(0, 0, "rmoveto", 50, 50, 30, 50, 50, 50, 50, "hflex", "endchar"), // 7 hflex
    cs(0, 0, "rmoveto", 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 50, "flex", "endchar"), // 8 flex
    cs(0, 0, "rmoveto", 10, 5, 20, 10, 30, 30, 20, -10, 10, "hflex1", "endchar"), // 9 hflex1
    cs(0, 0, "rmoveto", 10, 2, 20, 3, 30, 1, 30, -1, 20, -3, 10, "flex1", "endchar"), // 10 flex1, ending on the start y
    // 11 every curve operator once, chained
    cs(0, 0, "rmoveto", 10, 20, 30, 40, 50, 60, "rrcurveto", 1, 2, 3, 4, 5, 6, 7, 8, "rcurveline", 1, 1, 2, 2, 3, 3, 4, 4, "rlinecurve", 5, 10, 20, 30, 40, "vvcurveto", 6, 10, 20, 30, 40, "hhcurveto", 10, 20, 30, 40, 5, "hvcurveto", 10, 20, 30, 40, "vhcurveto", "endchar"),
    // 12 arithmetic: (40 + 60) 0 rmoveto; then 2*25 hlineto; 50 put/get vlineto; 50 neg (-50), dup/drop, hlineto
    cs(40, 60, "add", 0, "rmoveto", 2, 25, "mul", "hlineto", 50, 0, "put", 0, "get", "vlineto", 50, "neg", "dup", "drop", "hlineto", "endchar"),
    cs(120, "hmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"), // 13 hmoveto with no width
    cs(50, 120, "hmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"), // 14 width then hmoveto
    cs(50, "endchar"), // 15 a width and nothing drawn
    cs(50, 0, 100, "hstem", 0, 100, "vstem", 100, 0, "rmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"), // 16 width before hstem
    cs(0, 0, "rmoveto", 100, 0, "rlineto", 0, 100, "rlineto", 300, 300, "rmoveto", 100, 0, "rlineto", 0, 100, "rlineto", "endchar"), // 17 two contours, each closed
    cs(100, "vmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"), // 18 vmoveto
    cs(0, 0, "rmoveto", 1.5, 0, "rlineto", 0, 2.25, "rlineto", "endchar"), // 19 fixed-point numbers
    cs(100, 100, "rmoveto", 200, 200, "rmoveto", 10, "hlineto", 10, "vlineto", "endchar"), // 20 a move that draws nothing is dropped
    cs(100, 1, 0, "and", "add", 0, "rmoveto", 10, "hlineto", 10, "vlineto", "endchar"), // 21 and with a zero on top must still take both operands
    // 22 the rest of the arithmetic, each result spent on a line
    cs(300, 200, "exch", "rmoveto", 1, 2, 3, 2, "index", "hlineto", 1, 2, 3, 3, 1, "roll", "vlineto", -6, "abs", 2, "div", "hlineto", 10, 20, 1, 2, "ifelse", "vlineto", 0, "not", "hlineto", 0, 1, "or", "vlineto", 8, 2, "sub", 1, 0, "and", "add", "hlineto", 9, "sqrt", "vlineto", "endchar"),
    cs(50, 100, "vmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"), // 23 width then vmoveto
    cs(50, 0, 100, "hintmask", { raw: [0x80] }, 100, 0, "rmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"), // 24 width before a hintmask that comes first
    cs(50, 0, 100, "vstemhm", 0, 100, "cntrmask", { raw: [0xc0] }, 100, 0, "rmoveto", 400, "hlineto", 400, "vlineto", -400, "hlineto", "endchar"), // 25 width before vstemhm, then cntrmask with an implied stem
  ];
  const charsetSids = [34, 125, 391, ...Array.from({ length: charStrings.length - 4 }, (_, k) => 392 + k)];
  const subrs = [cs(400, "hlineto", 400, "vlineto", -400, "hlineto", "return")];
  const gsubrs = [cs(100, "hlineto", 100, "vlineto", -100, "hlineto", "return")];
  const strings = ["Aacute", ...Array.from({ length: charStrings.length - 4 }, (_, k) => `g${k}`)];
  const table = cffTable({ charStrings, charsetSids, subrs, gsubrs, strings, nominalWidthX: 500 });
  const codes = charStrings.map((_, g) => [0x41 + g, g]).slice(1);
  return sfnt(table, { codes, numGlyphs: charStrings.length });
}

test("a CFF OpenType font loads, with its character map, advances and cubic outlines", () => {
  const font = loadFont(nameKeyedFont());
  assert.equal(font.outlines, "CFF");
  assert.equal(font.unitsPerEm, 1000);
  assert.equal(font.numGlyphs, 26);
  assert.equal(font.glyphFor(0x42), 1, "B is glyph 1");
  assert.equal(font.advanceOf(1), 600, "advances come from hmtx, not the charstring width");
  assert.equal(font.glyphPath(1), "M100 0L500 0L500 400L100 400Z", "a width before rmoveto is dropped");
  assert.deepEqual(font.glyphBounds(1), { xMin: 100, yMin: 0, xMax: 500, yMax: 400 });
  assert.equal(font.glyphPath(0), "", ".notdef draws nothing");
  assert.equal(font.glyphBounds(0), null);
  assert.deepEqual(font.contoursOf(1), [], "a CFF font has no TrueType contours");
  assert.equal(font.capHeight, 30, "the cap height is measured off whatever H draws (here the hflex glyph), as for TrueType");
});

test("widths are dropped wherever a charstring may carry one", () => {
  const font = loadFont(nameKeyedFont());
  const square = "M100 0L500 0L500 400L100 400Z";
  const squareAt120 = "M120 0L520 0L520 400L120 400Z";
  assert.equal(font.glyphPath(13), squareAt120, "hmoveto with one argument");
  assert.equal(font.glyphPath(14), squareAt120, "a width then hmoveto");
  assert.equal(font.glyphPath(15), "", "a width then endchar");
  assert.equal(font.glyphPath(16), square, "a width before hstem, then vstem");
  assert.equal(font.glyphPath(18), "M0 100L400 100L400 500L0 500Z", "vmoveto");
  assert.equal(font.glyphPath(23), "M0 100L400 100L400 500L0 500Z", "a width then vmoveto");
  assert.equal(font.glyphPath(24), square, "a width before a hintmask that comes first");
  assert.equal(font.glyphPath(25), square, "a width before vstemhm, then cntrmask with an implied stem");
});

test("hint masks are skipped by the stem count, implied vstems included", () => {
  const font = loadFont(nameKeyedFont());
  assert.equal(font.glyphPath(4), "M100 100L150 100L150 150L100 150Z");
});

test("local and global subroutines run with their bias, and return", () => {
  const font = loadFont(nameKeyedFont());
  assert.equal(font.glyphPath(5), "M100 0L500 0L500 400L100 400Z");
  assert.equal(font.glyphPath(6), "M300 0L400 0L400 100L300 100Z");
});

test("seac draws the base and the accent moved into place", () => {
  const font = loadFont(nameKeyedFont());
  assert.equal(font.glyphPath(3), "M100 0L500 0L500 400L100 400ZM200 600L300 600L250 700Z");
  assert.deepEqual(font.glyphBounds(3), { xMin: 100, yMin: 0, xMax: 500, yMax: 700 });
});

test("the flex operators each draw two curves that end where the spec says", () => {
  const font = loadFont(nameKeyedFont());
  assert.equal(font.glyphPath(7), "M0 0C50 0 100 30 150 30C200 30 250 0 300 0Z", "hflex returns to the start y");
  // flex: 12 deltas, each pair relative to the point before.
  assert.equal(font.glyphPath(8), "M0 0C10 20 40 60 90 120C160 200 250 300 360 420Z");
  // hflex1: dx1 dy1 dx2 dy2 dx3 dx4 dx5 dy5 dx6; the last point is back on the start y.
  assert.equal(font.glyphPath(9), "M0 0C10 5 30 15 60 15C90 15 110 5 120 0Z");
  // flex1: the last point's other coordinate is the start's, chosen by which delta is larger.
  assert.equal(font.glyphPath(10), "M0 0C10 2 30 5 60 6C90 5 110 2 120 0Z");
});

test("every curve operator advances the pen as the spec describes", () => {
  const font = loadFont(nameKeyedFont());
  const d = font.glyphPath(11);
  const ends = [...d.matchAll(/[LC]([^LCZ]+)/g)].map((m) => m[1].trim().split(" ").slice(-2).map(Number));
  // rrcurveto 10 20 30 40 50 60 -> (90,120); rcurveline curve (1,2,3,4,5,6) -> (99,132), line (7,8) -> (106,140);
  // rlinecurve 1 1 2 2 3 3 4 4: one line (1,1) -> (107,141), then the last six (2 2 3 3 4 4) are the curve -> (116,150).
  assert.deepEqual(ends[0], [90, 120], "rrcurveto");
  assert.deepEqual(ends[1], [99, 132], "rcurveline's curve");
  assert.deepEqual(ends[2], [106, 140], "rcurveline's line");
  assert.deepEqual(ends[3], [107, 141], "rlinecurve's line");
  assert.deepEqual(ends[4], [116, 150], "rlinecurve's curve: 2 2 3 3 4 4");
  // vvcurveto 5 10 20 30 40: dx1 5, then dya 10 dxb 20 dyb 30 dyc 40 -> x 116+5+20 = 141, y 150+10+30+40 = 230
  assert.deepEqual(ends[5], [141, 230], "vvcurveto with a leading dx1");
  // hhcurveto 6 10 20 30 40: dy1 6, dxa 10 dxb 20 dyb 30 dxc 40 -> x 141+10+20+40 = 211, y 230+6+30 = 266
  assert.deepEqual(ends[6], [211, 266], "hhcurveto with a leading dy1");
  // hvcurveto 10 20 30 40 5: dx1 10 dx2 20 dy2 30 dy3 40 dxf 5 -> x 211+10+20+5 = 246, y 266+30+40 = 336
  assert.deepEqual(ends[7], [246, 336], "hvcurveto with the fifth argument");
  // vhcurveto 10 20 30 40: dy1 10 dx2 20 dy2 30 dx3 40 -> x 246+20+40 = 306, y 336+10+30 = 376
  assert.deepEqual(ends[8], [306, 376], "vhcurveto");
  assert.equal(ends.length, 9);
});

test("the arithmetic operators, fixed-point numbers and empty moves", () => {
  const font = loadFont(nameKeyedFont());
  assert.equal(font.glyphPath(12), "M100 0L150 0L150 50L100 50Z");
  assert.equal(font.glyphPath(21), "M100 0L110 0L110 10Z", "1 0 and takes both operands and leaves 0");
  // exch; index 2 of 1 2 3 -> 1 2 3 1; 1 2 3 roll 3 1 -> 3 1 2; |-6| / 2; ifelse picks 10 since 1 <= 2;
  // not 0; 0 or 1; (8 - 2) + (1 and 0); sqrt 9
  assert.equal(font.glyphPath(22), "M200 300L201 300L201 302L204 302L204 303L204 306L205 306L205 308L208 308L208 318L209 318L209 319L215 319L215 322Z");
  assert.equal(font.glyphPath(19), "M0 0L1.5 0L1.5 2.25Z");
  assert.equal(font.glyphPath(17), "M0 0L100 0L100 100ZM400 400L500 400L500 500Z", "each contour is closed");
  assert.equal(font.glyphPath(20), "M300 300L310 300L310 310Z", "a move that draws nothing is dropped");
  assert.deepEqual(font.glyphBounds(20), { xMin: 300, yMin: 300, xMax: 310, yMax: 310 }, "and does not widen the bounds");
});

test("text is set from a CFF font and rasterised the same way as from TrueType", () => {
  const font = loadFont(nameKeyedFont());
  const got = textPath(font, "BBC", { size: 100 });
  assert.equal(got.missing.length, 0);
  assert.equal(got.blank.length, 0);
  assert.equal(got.width, 180);
  assert.equal((got.d.match(/M/g) ?? []).length, 3, "three glyphs drawn");
  const w = Math.ceil(got.width) + 2;
  const h = Math.ceil(got.height) + 2;
  const cov = coverage(pathToPolygons(got.d), w, h);
  const ink = cov.reduce((a, b) => a + b, 0);
  // Two 40x40 squares and a 10x10 triangle at 100 units: 3200 + 50.
  assert.ok(Math.abs(ink - 3250) < 60, `ink ${ink}`);
  const g = rasterGlyph(font, 1, 20);
  assert.equal(g.width, 8);
  assert.equal(g.height, 8);
  assert.equal(g.x, 2);
  assert.equal(g.advance, 12);
  assert.ok(g.alpha.every((v) => v === 255), "a square at whole pixels is solid");
});

test("a CFF table in a TrueType-tagged sfnt reads, and a font matrix keeps its shape but not its scale", () => {
  const charStrings = [cs("endchar"), cs(...SQUARE)];
  const square = "M100 0L500 0L500 400L100 400Z";
  // Charstring units are the head table's whatever scale the matrix states, as FreeType reads them.
  const scaled = cffTable({ charStrings, charsetSids: [34], fontMatrix: [1 / 2000, 0, 0, 1 / 2000, 0, 0] });
  const font = loadFont(sfnt(scaled, { codes: [[0x41, 1]], numGlyphs: 2, kind: "true", unitsPerEm: 2000 }));
  assert.equal(font.outlines, "CFF");
  assert.equal(font.unitsPerEm, 2000);
  assert.equal(font.glyphPath(1), square);
  // An oblique matrix slants the glyph, normalised to the em.
  const oblique = cffTable({ charStrings, charsetSids: [34], fontMatrix: [0.001, 0, 0.0002, 0.001, 0, 0] });
  assert.equal(loadFont(sfnt(oblique, { codes: [[0x41, 1]], numGlyphs: 2 })).glyphPath(1), "M100 0L500 0L580 400L180 400Z");
});

test("a malformed font is refused with a message, not a hang or a crash", () => {
  const one = (glyph, extra = {}) => loadFont(sfnt(cffTable({ charStrings: [cs("endchar"), glyph], charsetSids: [34], ...extra }), { codes: [[0x41, 1]], numGlyphs: 2 }));
  // Nine levels of subroutines, each calling the next twenty times over, would run 20^9 steps
  // while staying inside the nesting limit.
  const fanOut = Array.from({ length: 9 }, (_, k) => (k < 8 ? cs(...Array.from({ length: 20 }, () => [-107 + k + 1, "callsubr"]).flat(), "return") : cs(10, "hlineto", "return")));
  assert.throws(() => one(cs(0, 0, "rmoveto", -107, "callsubr", "endchar"), { subrs: fanOut }).glyphPath(1), /200,000 steps/);
  assert.throws(() => one(cs(...Array.from({ length: 60 }, (_, k) => k), "endchar")).glyphPath(1), /overflows the charstring argument stack/);
  assert.throws(() => one(cs(0, 0, "rmoveto", 1000, 1000, "mul", 0, "rlineto", "endchar")).glyphPath(1), /far outside its em/);
  assert.throws(() => one(cs("rmoveto", 10, "hlineto", "endchar")).glyphPath(1), /runs short of arguments/);
  assert.equal(one(cs(100, 0, "rlineto", 0, 100, "rlineto", "endchar")).glyphPath(1), "M0 0L100 0L100 100Z", "a line before any move starts at the current point, as FreeType draws it");
  assert.throws(() => loadFont(sfnt(cidKeyedTable({ emptyFdArray: true }), { codes: [[0x41, 1]], numGlyphs: 4 })), /holds no font dicts/);
  assert.throws(() => loadFont(sfnt(Buffer.alloc(16), { tag: "glyf", codes: [[0x41, 1]], numGlyphs: 2 })), /glyf table but no loca/);
  const cut = sfnt(cffTable({ charStrings: [cs("endchar"), cs(...SQUARE)], charsetSids: [34] }), { codes: [[0x41, 1]], numGlyphs: 2 });
  assert.throws(() => loadFont(cut.subarray(0, cut.length - 40)), /malformed|RangeError|out of range/i, "a truncated table throws rather than looping");
});

/** A CID-keyed CFF: two font dicts with their own subroutines, glyphs routed to them by FDSelect. */
function cidKeyedTable({ selectFormat = 3, matrices = false, emptyFdArray = false } = {}) {
  const header = Buffer.from([1, 0, 4, 1]);
  const nameIndex = index([Buffer.from("TestCID")]);
  const stringIndex = index([Buffer.from("Adobe"), Buffer.from("Identity")]);
  const gsubrIndex = index([]);
  const charStrings = [
    cs("endchar"),
    cs(0, 0, "rmoveto", -107, "callsubr", "endchar"), // fd 0's subr: a 100 square
    cs(0, 0, "rmoveto", -107, "callsubr", "endchar"), // fd 1's subr: a 300 square
    cs(0, 0, "rmoveto", -107, "callsubr", "endchar"), // fd 1 again
  ];
  const charset = Buffer.from([0, 0, 1, 0, 2, 0, 3]);
  const charStringsIndex = index(charStrings);
  const subrsA = index([cs(100, "hlineto", 100, "vlineto", -100, "hlineto", "return")]);
  const subrsB = index([cs(300, "hlineto", 300, "vlineto", -300, "hlineto", "return")]);
  const privSize = dict([[19, 0]]).length;
  const privA = dict([[19, privSize]]);
  const privB = dict([[19, privSize]]);
  const fdSelect = selectFormat === 3 ? Buffer.from([3, 0, 2, 0, 0, 0, 0, 2, 1, 0, 4]) : Buffer.from([0, 0, 0, 1, 1]);
  // The PostScript CIDFont convention: an identity matrix on top, 1/1000 in each font dict.
  const fdMatrix = matrices ? [[1207, 0.001, 0, 0, 0.001, 0, 0]] : [];
  const topMatrix = matrices ? [[1207, 1, 0, 0, 1, 0, 0]] : [];
  const fdArrayFor = (o) => (emptyFdArray ? index([]) : index([dict([...fdMatrix, [18, privA.length, o.privA]]), dict([...fdMatrix, [18, privB.length, o.privB]])]));
  const topFor = (o) => dict([[1230, 391, 392, 0], ...topMatrix, [15, o.charset], [17, o.charStrings], [1236, o.fdArray], [1237, o.fdSelect]]);
  const topSize = index([topFor({ charset: 0, charStrings: 0, fdArray: 0, fdSelect: 0 })]).length;
  const fdArraySize = fdArrayFor({ privA: 0, privB: 0 }).length;
  let at = header.length + nameIndex.length + topSize + stringIndex.length + gsubrIndex.length;
  const o = { charset: at };
  at += charset.length;
  o.charStrings = at;
  at += charStringsIndex.length;
  o.fdSelect = at;
  at += fdSelect.length;
  o.privA = at;
  at += privA.length + subrsA.length;
  o.privB = at;
  at += privB.length + subrsB.length;
  o.fdArray = at;
  const top = index([topFor(o)]);
  const fdArray = fdArrayFor(o);
  assert.equal(fdArray.length, fdArraySize);
  return Buffer.concat([header, nameIndex, top, stringIndex, gsubrIndex, charset, charStringsIndex, fdSelect, privA, subrsA, privB, subrsB, fdArray]);
}

test("a CID-keyed CFF routes each glyph to its own font dict's subroutines", () => {
  for (const selectFormat of [3, 0]) {
    const font = loadFont(sfnt(cidKeyedTable({ selectFormat }), { codes: [[0x41, 1], [0x42, 2], [0x43, 3]], numGlyphs: 4 }));
    assert.equal(font.glyphPath(1), "M0 0L100 0L100 100L0 100Z", `format ${selectFormat}: glyph 1 is in font dict 0`);
    assert.equal(font.glyphPath(2), "M0 0L300 0L300 300L0 300Z", `format ${selectFormat}: glyph 2 is in font dict 1`);
    assert.equal(font.glyphPath(3), "M0 0L300 0L300 300L0 300Z", `format ${selectFormat}: glyph 3 is in font dict 1`);
  }
  // Font dict matrices combined with the top dict's: the usual CIDFont pair comes to the plain scale.
  const font = loadFont(sfnt(cidKeyedTable({ matrices: true }), { codes: [[0x41, 1], [0x42, 2]], numGlyphs: 4 }));
  assert.equal(font.glyphPath(1), "M0 0L100 0L100 100L0 100Z");
  assert.equal(font.glyphPath(2), "M0 0L300 0L300 300L0 300Z");
});

/** A CFF2 table: no widths, no endchar, a variation store with one region, and a glyph that blends. */
function cff2Table({ extra = [] } = {}) {
  const charStrings = [
    ...extra,
    cs(100, 10, 1, "blend", 0, "rmoveto", 200, "hlineto", 200, "vlineto", -200, "hlineto"), // blended x at the default: 100
    cs(1, "vsindex", 0, 0, "rmoveto", 50, 7, 8, 1, "blend", "hlineto", 60, 7, 8, 1, "blend", "vlineto"), // vsindex 1 selects two regions, so each value carries two deltas
    cs(0, 0, "rmoveto", -107, "callsubr"), // a local subr
  ];
  const charStringsIndex = index(charStrings, true);
  const gsubrIndex = index([], true);
  const subrs = index([cs(40, "hlineto", 40, "vlineto", -40, "hlineto")], true);
  const privSize = dict([[22, 0], [19, 0]]).length;
  const priv = dict([[22, 0], [19, privSize]]);
  // ItemVariationStore after a two-byte length: format 1, a region list of one axis and two
  // regions, then two item variation data, the first over one region and the second over both.
  const regionList = Buffer.from([0, 1, 0, 2, 0, 0, 0x40, 0, 0x40, 0, 0xc0, 0, 0xc0, 0, 0, 0]);
  const ivd0 = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0]);
  const ivd1 = Buffer.from([0, 0, 0, 0, 0, 2, 0, 0, 0, 1]);
  const ivsHead = Buffer.alloc(16);
  ivsHead.writeUInt16BE(1, 0);
  ivsHead.writeUInt32BE(16, 2);
  ivsHead.writeUInt16BE(2, 6);
  ivsHead.writeUInt32BE(16 + regionList.length, 8);
  ivsHead.writeUInt32BE(16 + regionList.length + ivd0.length, 12);
  const ivs = Buffer.concat([ivsHead, regionList, ivd0, ivd1]);
  const vstore = Buffer.concat([Buffer.from([(ivs.length >> 8) & 255, ivs.length & 255]), ivs]);
  const fdArrayFor = (o) => index([dict([[18, priv.length, o.priv]])], true);
  const topFor = (o) => dict([[17, o.charStrings], [1236, o.fdArray], [24, o.vstore]]);
  const topSize = topFor({ charStrings: 0, fdArray: 0, vstore: 0 }).length;
  const header = Buffer.from([2, 0, 5, (topSize >> 8) & 255, topSize & 255]);
  let at = header.length + topSize + gsubrIndex.length;
  const o = { charStrings: at };
  at += charStringsIndex.length;
  o.priv = at;
  at += priv.length + subrs.length;
  o.fdArray = at;
  at += fdArrayFor({ priv: 0 }).length;
  o.vstore = at;
  return Buffer.concat([header, topFor(o), gsubrIndex, charStringsIndex, priv, subrs, fdArrayFor(o), vstore]);
}

test("a CFF2 font reads at its default instance: blends keep the values and drop the deltas", () => {
  const font = loadFont(sfnt(cff2Table(), { tag: "CFF2", codes: [[0x41, 0], [0x42, 1], [0x43, 2]], numGlyphs: 3 }));
  assert.equal(font.outlines, "CFF2");
  assert.equal(font.glyphPath(0), "M100 0L300 0L300 200L100 200Z");
  assert.equal(font.glyphPath(1), "M0 0L50 0L50 60Z", "after vsindex 1 each blend drops two deltas, not one");
  assert.equal(font.glyphPath(2), "M0 0L40 0L40 40L0 40Z", "a CFF2 local subroutine, closed at the end of the charstring");
});

test("a CFF2 font set away from its default weights each blend's deltas by its regions", () => {
  // One weight axis, 100 to 900 round 400. The store's region 0 peaks at +1 (the heavy end),
  // region 1 at -1 (the light end). Glyph 0 blends 100 with a delta of 10 over region 0; glyph 1
  // (vsindex 1, both regions) blends 50 with 7 and 8, and 60 with 7 and 8.
  const u16 = (v) => [(v >> 8) & 255, v & 255];
  const fx = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].map((b) => b);
  const fixed = (v) => fx(Math.round(v * 65536) >>> 0);
  const fvar = Buffer.from([...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(1), ...u16(20), ...u16(0), ...u16(8), ...Buffer.from("wght", "latin1"), ...fixed(100), ...fixed(400), ...fixed(900), ...u16(0), ...u16(256)]);
  const at = (variation) => loadFont(sfnt(cff2Table(), { tag: "CFF2", codes: [[0x41, 0], [0x42, 1], [0x43, 2]], numGlyphs: 3, extra: [["fvar", fvar]] }), { variation });
  assert.equal(at({ wght: 900 }).glyphPath(0), "M110 0L310 0L310 200L110 200Z", "at the heavy end region 0 applies in full");
  assert.equal(at({ wght: 650 }).glyphPath(0), "M105 0L305 0L305 200L105 200Z", "halfway there, half the delta");
  assert.equal(at({ wght: 100 }).glyphPath(0), "M100 0L300 0L300 200L100 200Z", "the light end is outside region 0");
  assert.equal(at({ wght: 900 }).glyphPath(1), "M0 0L57 0L57 67Z", "both values take region 0's delta");
  assert.equal(at({ wght: 100 }).glyphPath(1), "M0 0L58 0L58 68Z", "and region 1's at the light end");
  assert.equal(at({ wght: 400 }).glyphPath(1), "M0 0L50 0L50 60Z");
  assert.deepEqual(at({ wght: 900 }).variation, { wght: 900 });
});

test("a font with CFF outlines from this machine sets text and bitmap glyphs", async (t) => {
  // Adobe ships CFF fonts with Acrobat, macOS has the STIX fonts, Debian the URW base 35. A file
  // that turns out to be TrueType is passed over for the next; skipped where none is found.
  const candidates = [
    "C:/Program Files/Adobe/Acrobat DC/Resource/Font/MinionPro-Regular.otf",
    "C:/Program Files/Adobe/Acrobat DC/Resource/Font/MyriadPro-Regular.otf",
    "/System/Library/Fonts/Supplemental/STIXGeneral.otf",
    "/usr/share/fonts/opentype/urw-base35/NimbusSans-Regular.otf",
  ];
  let font = null;
  for (const c of candidates) {
    let bytes;
    try {
      bytes = await readFile(c);
    } catch {
      continue;
    }
    const f = loadFont(bytes);
    if (f.outlines === "TrueType") continue;
    font = f;
    break;
  }
  if (!font) return t.skip("no CFF font on this machine");
  assert.ok(font.numGlyphs > 100);
  assert.ok(font.capHeight > font.unitsPerEm * 0.5 && font.capHeight < font.unitsPerEm * 0.85, `cap height ${font.capHeight}`);
  const got = textPath(font, "ONMODEL", { size: 120 });
  assert.equal(got.missing.length, 0);
  assert.equal(got.blank.length, 0);
  assert.ok(got.width > 400, `width ${got.width}`);
  const w = Math.ceil(got.width) + 4;
  const h = Math.ceil(got.height) + 4;
  const cov = coverage(pathToPolygons(got.d), w, h, { rule: "nonzero" });
  const share = cov.reduce((a, b) => a + b, 0) / (w * h);
  assert.ok(share > 0.08 && share < 0.5, `ink share ${share.toFixed(3)}`);
  // Every glyph in the font interprets; the ones that draw nothing are the few blanks every font has.
  let empty = 0;
  for (let g = 0; g < font.numGlyphs; g++) if (!font.glyphPath(g)) empty++;
  assert.ok(empty < font.numGlyphs / 20, `${empty} of ${font.numGlyphs} glyphs draw nothing`);
  const o = rasterGlyph(font, font.glyphFor(0x4f), 32);
  assert.ok(o.width >= 18 && o.height >= 20, `O at 32px is ${o.width}x${o.height}`);
  assert.ok(o.alpha.some((v) => v === 255) && o.alpha.some((v) => v === 0), "the O has a solid ring and a hole");
});

test("a CFF2 vsindex that names no variation data is refused by name, at the default too", () => {
  // 0.5 arrives as a 16.16 operand; an outer index into the store must be a whole number.
  const table = cff2Table({ extra: [cs(0.5, "vsindex", 0, 0, "rmoveto", 50, 7, 8, 1, "blend", "hlineto", 60, "vlineto")] });
  const font = loadFont(sfnt(table, { tag: "CFF2", codes: [[0x41, 0]], numGlyphs: 4 }));
  assert.throws(() => font.glyphPath(0), /vsindex of 0\.5, which names no variation data/);
  assert.equal(font.glyphPath(1), "M100 0L300 0L300 200L100 200Z", "the other glyphs still read");
});
