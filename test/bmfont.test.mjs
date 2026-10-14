import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadFont } from "../src/font.mjs";
import { buildBitmapFont, writeFnt, parseFnt, setText, fntFromBuild, fontMetrics, rasterGlyph, monoDamage } from "../src/bmfont.mjs";
import { makeBitmapFont } from "../src/bitmapfontset.mjs";
import { checkRun, failuresOf } from "../src/check.mjs";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "onmodel.mjs");

/** Big-endian bytes from a list of [kind, value] pairs. */
function be(items) {
  const size = items.reduce((t, [k]) => t + (k === "u32" || k === "tag" ? 4 : 2), 0);
  const b = Buffer.alloc(size);
  let at = 0;
  for (const [k, v] of items) {
    if (k === "u16") b.writeUInt16BE(v, at);
    else if (k === "i16") b.writeInt16BE(v, at);
    else if (k === "u32") b.writeUInt32BE(v, at);
    else if (k === "tag") b.write(v, at, 4, "latin1");
    at += k === "u32" || k === "tag" ? 4 : 2;
  }
  return b;
}

/**
 * A TrueType font built byte by byte, carrying what a bitmap font needs: a line gap, a
 * family name, and GPOS pair kerning laid out the way real fonts lay it out. Its one kern
 * lookup is wrapped in extension subtables and holds a glyph-pair subtable (A then B) before
 * a class subtable (A then C). A then C is covered by the first and kerned only by the second,
 * which is the case that a rule treating the first subtable as final gets wrong.
 *
 * Glyphs: A a square, B a triangle, C a tall bar, i a stem with a separate dot, and _ a bar
 * 40 units thick, under half a pixel at 10px. The font has no space.
 */
function bitmapTestFont() {
  const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);
  const glyph = (contours) => {
    const all = contours.flat();
    const box = [Math.min(...all.map((p) => p[0])), Math.min(...all.map((p) => p[1])), Math.max(...all.map((p) => p[0])), Math.max(...all.map((p) => p[1]))];
    const head = Buffer.alloc(10);
    head.writeInt16BE(contours.length, 0);
    box.forEach((v, i) => head.writeInt16BE(v, 2 + i * 2));
    const ends = Buffer.alloc(contours.length * 2);
    let n = 0;
    contours.forEach((c, i) => {
      n += c.length;
      ends.writeUInt16BE(n - 1, i * 2);
    });
    const flags = Buffer.alloc(all.length, 1);
    const xs = Buffer.alloc(all.length * 2);
    const ys = Buffer.alloc(all.length * 2);
    let px = 0;
    let py = 0;
    all.forEach(([x, y], i) => {
      xs.writeInt16BE(x - px, i * 2);
      ys.writeInt16BE(y - py, i * 2);
      px = x;
      py = y;
    });
    const g = Buffer.concat([head, ends, Buffer.alloc(2), flags, xs, ys]);
    return g.length % 2 ? Buffer.concat([g, Buffer.alloc(1)]) : g;
  };
  const rect = (x0, y0, x1, y1) => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
  const glyphs = [
    Buffer.alloc(0),
    glyph([rect(100, 0, 500, 400)]),
    glyph([
      [
        [100, 0],
        [500, 0],
        [300, 500],
      ],
    ]),
    glyph([rect(200, 0, 400, 700)]),
    glyph([rect(250, 0, 350, 400), rect(250, 500, 350, 600)]),
    glyph([rect(50, -100, 550, -60)]),
  ];
  const numGlyphs = glyphs.length;
  const glyf = Buffer.concat(glyphs);
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
  hhea.writeInt16BE(100, 8); // line gap
  hhea.writeUInt16BE(numGlyphs, 34);
  const hmtx = Buffer.alloc(numGlyphs * 4);
  [600, 600, 600, 600, 600, 600].forEach((a, g) => hmtx.writeUInt16BE(a, g * 4));

  // cmap format 4: one segment per character, each with its own delta, then the end.
  const codes = [
    [65, 1],
    [66, 2],
    [67, 3],
    [95, 5],
    [105, 4],
  ];
  const segs = [...codes.map(([c, g]) => ({ start: c, end: c, delta: g - c })), { start: 0xffff, end: 0xffff, delta: 1 }];
  const sc = segs.length;
  const sub = be([
    ["u16", 4],
    ["u16", 16 + sc * 8],
    ["u16", 0],
    ["u16", sc * 2],
    ["u16", 0],
    ["u16", 0],
    ["u16", 0],
    ...segs.map((s) => ["u16", s.end]),
    ["u16", 0],
    ...segs.map((s) => ["u16", s.start]),
    ...segs.map((s) => ["i16", s.delta]),
    ...segs.map(() => ["u16", 0]),
  ]);
  const cmap = Buffer.concat([be([["u16", 0], ["u16", 1], ["u16", 3], ["u16", 1], ["u32", 12]]), sub]);

  const family = Buffer.from("Tiny Test", "utf16le").swap16();
  const name = Buffer.concat([be([["u16", 0], ["u16", 1], ["u16", 18], ["u16", 3], ["u16", 1], ["u16", 0x409], ["u16", 1], ["u16", family.length], ["u16", 0]]), family]);

  // GPOS: latn, its default language's kern feature, one lookup of two extension subtables.
  const pair1 = Buffer.concat([
    be([["u16", 1], ["u16", 12], ["u16", 4], ["u16", 0], ["u16", 1], ["u16", 18]]),
    be([["u16", 1], ["u16", 1], ["u16", 1]]), // coverage: A
    be([["u16", 1], ["u16", 2], ["i16", -100]]), // A then B
  ]);
  const pair2 = Buffer.concat([
    be([["u16", 2], ["u16", 24], ["u16", 4], ["u16", 0], ["u16", 30], ["u16", 38], ["u16", 2], ["u16", 2]]),
    be([["i16", 0], ["i16", 0], ["i16", 0], ["i16", -160]]), // class 1 (A) then class 1 (C)
    be([["u16", 1], ["u16", 1], ["u16", 1]]), // coverage: A
    be([["u16", 1], ["u16", 1], ["u16", 1], ["u16", 1]]), // first classes: A is 1
    be([["u16", 2], ["u16", 1], ["u16", 3], ["u16", 3], ["u16", 1]]), // second classes: C is 1
  ]);
  const lookup = Buffer.concat([
    be([["u16", 9], ["u16", 0], ["u16", 2], ["u16", 10], ["u16", 18]]),
    be([["u16", 1], ["u16", 2], ["u32", 16]]),
    be([["u16", 1], ["u16", 2], ["u32", 8 + pair1.length]]),
    pair1,
    pair2,
  ]);
  const scriptList = Buffer.concat([be([["u16", 1], ["tag", "latn"], ["u16", 8]]), be([["u16", 4], ["u16", 0]]), be([["u16", 0], ["u16", 0xffff], ["u16", 1], ["u16", 0]])]);
  const featureList = Buffer.concat([be([["u16", 1], ["tag", "kern"], ["u16", 8]]), be([["u16", 0], ["u16", 1], ["u16", 0]])]);
  const lookupList = Buffer.concat([be([["u16", 1], ["u16", 4]]), lookup]);
  const gpos = Buffer.concat([be([["u32", 0x00010000], ["u16", 10], ["u16", 10 + scriptList.length], ["u16", 10 + scriptList.length + featureList.length]]), scriptList, featureList, lookupList]);

  const parts = [
    ["GPOS", gpos],
    ["cmap", cmap],
    ["glyf", glyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
    ["name", name],
  ];
  const dir = Buffer.alloc(12 + parts.length * 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(parts.length, 4);
  let at = dir.length;
  const bodies = [];
  parts.forEach(([n, body], i) => {
    dir.write(n, 12 + i * 16, 4, "latin1");
    dir.writeUInt32BE(at, 12 + i * 16 + 8);
    dir.writeUInt32BE(body.length, 12 + i * 16 + 12);
    bodies.push(pad4(body));
    at += pad4(body).length;
  });
  return Buffer.concat([dir, ...bodies]);
}

test("GPOS kerning follows HarfBuzz: a pair subtable only applies with a record for the second glyph", () => {
  const font = loadFont(bitmapTestFont());
  assert.equal(font.family, "Tiny Test");
  assert.equal(font.lineGap, 100);
  assert.equal(font.kerning, "GPOS");
  const A = font.glyphFor(65);
  const B = font.glyphFor(66);
  const C = font.glyphFor(67);
  assert.equal(font.kernBetween(A, B), -100, "the pair subtable has A then B");
  assert.equal(font.kernBetween(A, C), -160, "it covers A but has no C, so the class subtable after it decides");
  assert.equal(font.kernBetween(B, A), 0);
});

test("a real font's GPOS kerning is read, where it was missed before", { skip: !existsSync("C:/Windows/Fonts/calibri.ttf") && "Calibri is not installed" }, async () => {
  // Calibri puts glyph-pair exceptions before class kerning in the same lookup; treating the
  // first subtable as final kept 175 of its 611 kerned ASCII pairs and lost A then T.
  const font = loadFont(await readFile("C:/Windows/Fonts/calibri.ttf"));
  const k = (a, b) => font.kernBetween(font.glyphFor(a.codePointAt(0)), font.glyphFor(b.codePointAt(0)));
  assert.equal(k("A", "T"), -160);
  assert.equal(k("A", "V"), -89);
  let kerned = 0;
  for (let a = 32; a < 127; a++) for (let b = 32; b < 127; b++) if (font.kernBetween(font.glyphFor(a), font.glyphFor(b))) kerned++;
  assert.equal(kerned, 611);
});

test("metrics are rounded once, and every glyph sits on the baseline they give", () => {
  const font = loadFont(bitmapTestFont());
  assert.deepEqual(fontMetrics(font, 10), { s: 0.01, base: 8, lineHeight: 11 });
  const bm = buildBitmapFont(font, { px: 10, chars: "ABCi_ " });
  const A = bm.glyphs.find((g) => g.ch === "A");
  assert.equal(A.top + A.height, 0, "A stands on the baseline");
  assert.equal(A.x, 1);
  assert.equal(A.advance, 6);
  const under = bm.glyphs.find((g) => g.ch === "_");
  assert.ok(under.top >= 0, "the underscore hangs below the baseline: row 0 is the first row under it");
  assert.deepEqual(bm.kernings, [
    { first: 65, second: 66, amount: -1 },
    { first: 65, second: 67, amount: -2 },
  ]);
  assert.equal(bm.syntheticSpace, true, "the font has no space, so one is made a quarter em wide");
  assert.equal(bm.glyphs.find((g) => g.ch === " ").advance, 3);
});

test("the .fnt reads back to the font that was built, whatever its line endings", () => {
  const font = loadFont(bitmapTestFont());
  const bm = buildBitmapFont(font, { px: 10, chars: "ABCi_ " });
  const text = writeFnt(bm, { face: "Tiny Test", pageFile: "tiny_0.png" });
  assert.match(text, /^info face="Tiny Test" size=10 bold=0 italic=0 charset="" unicode=1 /);
  assert.match(text, /\ncommon lineHeight=11 base=8 scaleW=\d+ scaleH=\d+ pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4\n/);
  for (const t of [text, text.replace(/\n/g, "\r\n")]) {
    const back = parseFnt(t);
    assert.equal(back.chars.length, 6);
    assert.equal(back.pages[0].file, "tiny_0.png");
    assert.equal(back.common.lineHeight, 11);
    assert.deepEqual(back.kernings.map((k) => [k.first, k.second, k.amount]), [
      [65, 66, -1],
      [65, 67, -2],
    ]);
    // Text set from what was read back is the text set from what was built.
    const a = setText(["ABC iA_"], { chars: back.chars, kernings: back.kernings, lineHeight: back.common.lineHeight, page: bm.page });
    const b = setText(["ABC iA_"], fntFromBuild(bm));
    assert.deepEqual([...a.data], [...b.data]);
  }
});

test("crisp pixels lose the thin bar and keep the dotted i whole", () => {
  const font = loadFont(bitmapTestFont());
  const crisp = buildBitmapFont(font, { px: 10, chars: "ABi_", mono: true });
  assert.deepEqual(crisp.lost, ["_"], "a bar under half a pixel thick leaves nothing at 50% cover");
  assert.ok(crisp.blank.includes("_"));
  assert.ok(!crisp.broken.includes("i"), "the dot and the stem are two pieces of the outline, not one broken one");
  const i = rasterGlyph(font, font.glyphFor(105), 10, { mono: true });
  assert.deepEqual(monoDamage(i), { lost: 0, broken: 0 });
  // Smooth, the bar is faint but there.
  const smooth = buildBitmapFont(font, { px: 10, chars: "_" });
  assert.equal(smooth.blank.length, 0);
  // A lower cover keeps it.
  assert.deepEqual(buildBitmapFont(font, { px: 10, chars: "_", mono: true, cover: 30 }).lost, []);
});

test("onmodel bitmapfont proves its files, and the gate holds them", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-bmf-"));
  const fontFile = path.join(dir, "tiny.ttf");
  await writeFile(fontFile, bitmapTestFont());
  const made = await makeBitmapFont({ config: { out: dir }, fontPath: fontFile, px: 10, chars: "ABCi_ Z", log: () => {} });
  assert.equal(made.facts.face, "Tiny Test");
  assert.equal(made.facts.previewDiffers, 0);
  assert.deepEqual(made.facts.missing, ["Z"]);
  assert.equal(made.facts.verdict, "incomplete", "a character the font lacks is named, not drawn with something else");

  const clean = await makeBitmapFont({ config: { out: dir }, fontPath: fontFile, px: 10, chars: "ABCi_ ", name: "tiny", log: () => {} });
  assert.equal(clean.facts.verdict, "complete");
  const run = path.join(dir, "tiny");
  const before = await checkRun({ dir: run });
  assert.equal(failuresOf(before).length, 0, JSON.stringify(failuresOf(before)));
  const fail = async () => failuresOf(await checkRun({ dir: run })).map((f) => `${f.file}:${f.check}`);

  const fnt = await readFile(clean.files.fnt, "utf8");
  // A checkout that turned every line ending into CRLF changes nothing.
  await writeFile(clean.files.fnt, fnt.replace(/\n/g, "\r\n"));
  assert.deepEqual(await fail(), []);
  // A kerning pair dropped by hand.
  await writeFile(clean.files.fnt, fnt.replace(/kerning first=65 second=67 amount=-2\n/, ""));
  assert.deepEqual(await fail(), ["tiny.fnt:unchanged", "tiny.fnt:kerning"]);
  // A glyph's rectangle moved off the page.
  await writeFile(clean.files.fnt, fnt.replace(/char id=65 x=\d+/, "char id=65 x=900"));
  assert.deepEqual(await fail(), ["tiny.fnt:unchanged", "tiny_0.png:glyphs"]);
  // The line height changed.
  await writeFile(clean.files.fnt, fnt.replace(/lineHeight=11/, "lineHeight=12"));
  assert.deepEqual(await fail(), ["tiny.fnt:unchanged", "tiny.fnt:metrics"]);
  await writeFile(clean.files.fnt, fnt);
  assert.deepEqual(await fail(), []);
});

test("the CLI refuses a cover without --mono and sizes it cannot set", () => {
  const run = (...args) => spawnSync(process.execPath, [bin, "bitmapfont", "--font", "x.ttf", ...args], { encoding: "utf8" });
  assert.match(run("--cover", "40").stderr, /needs --mono/);
  assert.match(run("--px", "3").stderr, /4 to 256/);
  assert.match(run("--px", "12.5").stderr, /whole number/);
});

test("every kerning pair and the baseline are set from the files, so a wrong one cannot hide", () => {
  const font = loadFont(bitmapTestFont());
  const bm = buildBitmapFont(font, { px: 10, chars: "ABCi_ " });
  const back = parseFnt(writeFnt(bm, { pageFile: "p.png" }));
  const line = ["AB AC"];
  const good = setText(line, { chars: back.chars, kernings: back.kernings, lineHeight: back.common.lineHeight, page: bm.page, base: back.common.base, refBase: bm.base });
  // A base written one pixel out moves every glyph, as it would in Godot.
  const offBase = setText(line, { chars: back.chars, kernings: back.kernings, lineHeight: back.common.lineHeight, page: bm.page, base: back.common.base + 1, refBase: bm.base });
  assert.notDeepEqual([...offBase.data], [...good.data]);
  // A kerning pair reversed in the file changes the line the pairs are set in.
  const flipped = back.kernings.map((k) => ({ ...k, amount: -k.amount }));
  const wrong = setText(line, { chars: back.chars, kernings: flipped, lineHeight: back.common.lineHeight, page: bm.page });
  assert.notDeepEqual([...wrong.data], [...good.data]);
});

test("the command checks every pair, refuses an empty set, and fails a page it cannot fill", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-bmf-"));
  const fontFile = path.join(dir, "tiny.ttf");
  await writeFile(fontFile, bitmapTestFont());
  const made = await makeBitmapFont({ config: { out: dir }, fontPath: fontFile, px: 10, chars: "ABCi_ ", name: "pairs", log: () => {} });
  assert.equal(made.facts.pairsChecked, 2);
  // The XML form Phaser loads says the same as the .fnt.
  const xml = await readFile(made.files.xml, "utf8");
  assert.equal((xml.match(/<char /g) ?? []).length, 6);
  assert.match(xml, /<kerning first="65" second="67" amount="-2"\/>/);
  await assert.rejects(makeBitmapFont({ config: { out: dir }, fontPath: fontFile, chars: "", log: () => {} }), /--chars is empty/);
  // At 256px the tall C alone is about 180px, so a 150px page cannot hold the set; it says so.
  const { buildBitmapFont: build } = await import("../src/bmfont.mjs");
  assert.throws(() => build(loadFont(bitmapTestFont()), { px: 256, chars: "ABCi", maxPage: 150 }), /do not fit on one 150x150 page/);
});

test("the gate fails a font its own run failed, and a glyph emptied by hand", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-bmf-"));
  const fontFile = path.join(dir, "tiny.ttf");
  await writeFile(fontFile, bitmapTestFont());
  await makeBitmapFont({ config: { out: dir }, fontPath: fontFile, px: 10, chars: "ABZ", name: "short", log: () => {} });
  const short = failuresOf(await checkRun({ dir: path.join(dir, "short") })).map((f) => `${f.file}:${f.check}`);
  assert.deepEqual(short, ["short.fnt:made"], "the font lacks Z, as the run said");

  const ok = await makeBitmapFont({ config: { out: dir }, fontPath: fontFile, px: 10, chars: "AB", name: "ab", log: () => {} });
  const fnt = await readFile(ok.files.fnt, "utf8");
  await writeFile(ok.files.fnt, fnt.replace(/char id=66 x=\d+ y=\d+ width=\d+ height=\d+/, "char id=66 x=0 y=0 width=0 height=0"));
  const emptied = failuresOf(await checkRun({ dir: path.join(dir, "ab") })).map((f) => `${f.file}:${f.check}`);
  assert.deepEqual(emptied, ["ab.fnt:unchanged", "ab.fnt:blank"]);
});

test("a symbol font is read, and its byte codes reach its glyphs", { skip: !existsSync("C:/Windows/Fonts/wingding.ttf") && "Wingdings is not installed" }, async () => {
  const font = loadFont(await readFile("C:/Windows/Fonts/wingding.ttf"));
  assert.equal(font.symbol, true);
  assert.ok(font.has(65) && font.glyphFor(65) === font.glyphFor(0xf041));
});

test("a glyph moved or an advance changed by hand is caught, and every advance and space is set", async () => {
  // Counts alone passed a .fnt whose glyphs had all moved; what the run wrote is held exactly now.
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-bmf-"));
  const fontFile = path.join(dir, "tiny.ttf");
  await writeFile(fontFile, bitmapTestFont());
  const made = await makeBitmapFont({ config: { out: dir }, fontPath: fontFile, px: 10, chars: "ABCi_ ", name: "moved", log: () => {} });
  const fnt = await readFile(made.files.fnt, "utf8");
  await writeFile(made.files.fnt, fnt.replace(/(char id=66 [^\n]*yoffset=)(-?\d+)/, (m, a, n) => `${a}${Number(n) + 2}`));
  const moved = failuresOf(await checkRun({ dir: path.join(dir, "moved") })).map((f) => `${f.file}:${f.check}`);
  assert.deepEqual(moved, ["moved.fnt:unchanged"]);
  // Every character is followed by one with ink in the lines that are checked, so the advance of
  // the last glyph and of a space places something too.
  const { buildBitmapFont: build, fntFromBuild: from, setText: set } = await import("../src/bmfont.mjs");
  const bm = build(loadFont(bitmapTestFont()), { px: 10, chars: "AB C" });
  const good = from(bm);
  const wide = { ...good, chars: good.chars.map((c) => (c.id === 32 ? { ...c, xadvance: c.xadvance + 5 } : c)) };
  assert.notDeepEqual([...set([" A"], wide).data], [...set([" A"], good).data], "a space's advance shows once something follows it");
});
