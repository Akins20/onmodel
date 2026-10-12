import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { loadFont, textPath, contourToPath } from "../src/font.mjs";
import { pathToPolygons, coverage } from "../src/vector.mjs";

/**
 * A TrueType font built byte by byte, so the tests need no font file of their own and no
 * licence to ship one. Three glyphs: an empty .notdef, a square for A and a triangle for
 * B, at 1000 units to the em with an advance of 600.
 */
function tinyFont({ unitsPerEm = 1000, advance = 600 } = {}) {
  const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

  const simpleGlyph = (points, box) => {
    const head = Buffer.alloc(10);
    head.writeInt16BE(1, 0);
    for (let i = 0; i < 4; i++) head.writeInt16BE(box[i], 2 + i * 2);
    const ends = Buffer.alloc(2);
    ends.writeUInt16BE(points.length - 1, 0);
    const instr = Buffer.alloc(2);
    // every point sits on the curve, and every coordinate is a signed 16-bit step
    const flags = Buffer.alloc(points.length, 1);
    const xs = Buffer.alloc(points.length * 2);
    const ys = Buffer.alloc(points.length * 2);
    let px = 0;
    let py = 0;
    points.forEach(([x, y], i) => {
      xs.writeInt16BE(x - px, i * 2);
      ys.writeInt16BE(y - py, i * 2);
      px = x;
      py = y;
    });
    const g = Buffer.concat([head, ends, instr, flags, xs, ys]);
    return g.length % 2 ? Buffer.concat([g, Buffer.alloc(1)]) : g;
  };

  const square = simpleGlyph(
    [
      [100, 0],
      [500, 0],
      [500, 400],
      [100, 400],
    ],
    [100, 0, 500, 400],
  );
  const triangle = simpleGlyph(
    [
      [100, 0],
      [500, 0],
      [300, 500],
    ],
    [100, 0, 500, 500],
  );
  const glyf = Buffer.concat([square, triangle]);
  const numGlyphs = 3;

  const loca = Buffer.alloc((numGlyphs + 1) * 2);
  loca.writeUInt16BE(0, 0);
  loca.writeUInt16BE(0, 2);
  loca.writeUInt16BE(square.length / 2, 4);
  loca.writeUInt16BE((square.length + triangle.length) / 2, 6);

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(unitsPerEm, 18);
  head.writeInt16BE(0, 50); // short loca

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeUInt16BE(numGlyphs, 34); // one metric per glyph

  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g++) hmtx.writeUInt16BE(advance, g * 4);

  // cmap: one Windows BMP table, format 4, covering A to H through a glyph id array,
  // which is the form real fonts use and the one worth exercising. A and H are the
  // square, B is the triangle, and the letters between them are absent.
  const sub = Buffer.alloc(48);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(48, 2);
  sub.writeUInt16BE(4, 6); // segCountX2
  sub.writeUInt16BE(72, 14); // endCode[0] = H
  sub.writeUInt16BE(0xffff, 16); // endCode[1]
  sub.writeUInt16BE(0, 18); // reservedPad
  sub.writeUInt16BE(65, 20); // startCode[0] = A
  sub.writeUInt16BE(0xffff, 22);
  sub.writeInt16BE(0, 24); // idDelta[0]: none, the array decides
  sub.writeInt16BE(1, 26);
  sub.writeUInt16BE(4, 28); // idRangeOffset[0]: the array starts four bytes on
  sub.writeUInt16BE(0, 30);
  [1, 2, 0, 0, 0, 0, 0, 1].forEach((g, i) => sub.writeUInt16BE(g, 32 + i * 2));
  const cmapHead = Buffer.alloc(12);
  cmapHead.writeUInt16BE(0, 0);
  cmapHead.writeUInt16BE(1, 2);
  cmapHead.writeUInt16BE(3, 4);
  cmapHead.writeUInt16BE(1, 6);
  cmapHead.writeUInt32BE(12, 8);
  const cmap = Buffer.concat([cmapHead, sub]);

  const parts = [
    ["cmap", cmap],
    ["glyf", glyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
  ];
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

test("a font's tables, glyphs and metrics are read from its bytes", () => {
  const font = loadFont(tinyFont());
  assert.equal(font.unitsPerEm, 1000);
  assert.equal(font.numGlyphs, 3);
  assert.equal(font.ascender, 800);
  assert.equal(font.descender, -200);
  assert.equal(font.glyphFor(65), 1, "A is the first glyph");
  assert.equal(font.glyphFor(66), 2, "B is the second");
  assert.equal(font.glyphFor(67), 0, "C is not in the font");
  assert.ok(font.has(65) && !font.has(67));
  assert.equal(font.advanceOf(1), 600);
  assert.equal(font.contoursOf(1).length, 1, "the square is one contour");
  assert.equal(font.contoursOf(1)[0].length, 4, "of four points");
  assert.deepEqual(font.contoursOf(1)[0][1], { x: 500, y: 0, on: true });
  assert.equal(font.contoursOf(0).length, 0, "notdef is empty");
});

test("a letter comes out as a path, the right way up and the right size", () => {
  const font = loadFont(tinyFont());
  const got = textPath(font, "A", { size: 100 });
  assert.ok(got.d.startsWith("M"), got.d);
  assert.equal(got.missing.length, 0);
  assert.equal(got.width, 60, "one advance of 600 units at a tenth scale");

  // A font measures up from the baseline and an SVG measures down from the top, so the
  // square's top edge must come out above its bottom edge in the path.
  const ys = [...got.d.matchAll(/[ML]([-\d.]+) ([-\d.]+)/g)].map((m) => Number(m[2]));
  assert.ok(Math.min(...ys) < Math.max(...ys));
  assert.ok(Math.max(...ys) <= got.baseline + 0.01, "nothing sits below the baseline");
});

test("the path drawn back is the shape the glyph describes", () => {
  const font = loadFont(tinyFont());
  const got = textPath(font, "A", { size: 100 });
  const cov = coverage(pathToPolygons(got.d), 120, 120);
  let on = 0;
  for (const v of cov) if (v > 0.5) on++;
  // The square is 400 x 400 units at a tenth scale, so 40 x 40 pixels.
  assert.ok(Math.abs(on - 1600) < 120, `covered ${on} pixels, expected about 1600`);
});

test("letters step along by their advance, and spacing and kerning move them", () => {
  const font = loadFont(tinyFont());
  assert.equal(textPath(font, "AA", { size: 100 }).width, 120);
  assert.equal(textPath(font, "AAA", { size: 100 }).width, 180);
  // Tracking is in thousandths of the size, as it is given everywhere else.
  assert.equal(textPath(font, "AA", { size: 100, letterSpacing: 100 }).width, 140);
  assert.equal(textPath(font, "", { size: 100 }).width, 0);
});

test("a character the font does not have is named, not silently dropped", () => {
  const font = loadFont(tinyFont());
  const got = textPath(font, "AZB", { size: 100 });
  assert.deepEqual(got.missing, ["Z"]);
  // It still takes its place, as the missing-glyph box does when the text is set.
  assert.equal(got.width, 180);
});

test("a contour that starts off the curve still closes", () => {
  // TrueType leaves out the on-curve point between two curves and may begin a contour on
  // an off-curve point; both have to be put back before anything can be drawn.
  const d = contourToPath([
    { x: 0, y: 0, on: false },
    { x: 100, y: 0, on: false },
    { x: 100, y: 100, on: false },
    { x: 0, y: 100, on: false },
  ]);
  assert.ok(d.startsWith("M"), d);
  assert.ok(d.endsWith("Z"), d);
  assert.equal((d.match(/C/g) ?? []).length, 4, "four curves for four off-curve points");
  assert.equal(contourToPath([{ x: 0, y: 0, on: true }]), "", "a single point is not a contour");
});

test("a font whose outlines onmodel cannot read says so plainly", () => {
  const otto = Buffer.alloc(32);
  otto.write("OTTO", 0, 4, "latin1");
  assert.throws(() => loadFont(otto), /CFF/);
  const ttc = Buffer.alloc(32);
  ttc.write("ttcf", 0, 4, "latin1");
  assert.throws(() => loadFont(ttc), /collection/);
  assert.throws(() => loadFont(Buffer.from("not a font at all")), /not a TrueType font/);
});

test("a real font from this machine reads the same way", async (t) => {
  // Real fonts bring composite glyphs, repeated flags and kerning, which a hand-built
  // one does not. Skipped where there is no such font to read.
  const candidates = ["C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/tahoma.ttf", "/System/Library/Fonts/Supplemental/Arial.ttf", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"];
  let file = null;
  for (const c of candidates) {
    try {
      await access(c);
      file = c;
      break;
    } catch {}
  }
  if (!file) return t.skip("no TrueType font on this machine");
  const font = loadFont(await readFile(file));
  assert.ok(font.unitsPerEm >= 16 && font.unitsPerEm <= 16384);
  assert.ok(font.numGlyphs > 50);
  for (const ch of "ONMODEL") assert.ok(font.has(ch.codePointAt(0)), `${ch} is in the font`);
  const got = textPath(font, "ONMODEL", { size: 120 });
  assert.equal(got.missing.length, 0);
  assert.ok(got.width > 120, `width ${got.width}`);
  assert.ok(got.d.length > 500, "the letters have real outlines");
  // Drawn back, the word covers a sensible share of its own box: not blank, not solid.
  const w = Math.ceil(got.width) + 4;
  const h = Math.ceil(got.height) + 4;
  const cov = coverage(pathToPolygons(got.d), w, h);
  let on = 0;
  for (const v of cov) if (v > 0.5) on++;
  assert.ok(on > w * h * 0.05 && on < w * h * 0.6, `covered ${on} of ${w * h}`);
});

test("the text command writes a wordmark set from the font, with a brand fill", async (t) => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { DEFAULTS, merge, validate } = await import("../src/config.mjs");
  const { makeText } = await import("../src/text.mjs");

  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-text-"));
  const fontFile = path.join(dir, "tiny.ttf");
  await writeFile(fontFile, tinyFont());
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, "# Brief\n\n## Product\nA shop.\n\n## Art direction\nFlat.\n\n## Palette\n- Charcoal ink #20262e\n- Ember orange #c64a34\n");
  const config = validate(merge(DEFAULTS, { brief, out: path.join(dir, "out") }));
  config.briefText = "## Palette\n- Charcoal ink #20262e\n- Ember orange #c64a34\n";
  config.palette = ["#20262e", "#c64a34"];

  const got = await makeText({ config, text: "AB", fontPath: fontFile, name: "mark", size: 100, log: () => {} });
  assert.equal(got.facts.verdict, "exact", "nothing is drawn, so nothing can be malformed");
  assert.equal(got.facts.glyphs, 2);
  assert.deepEqual(got.facts.missing, []);
  assert.deepEqual(got.facts.blank, []);
  assert.ok(got.facts.inkShare > 0.05, `inkShare ${got.facts.inkShare}`);

  // The darkest brand colour, named from the brief, with no colour asked for.
  assert.equal(got.tokens[0].hex, "#20262e");
  assert.equal(got.tokens[0].name, "brand-charcoal-ink");
  assert.equal(got.tokens[0].brand, true);

  for (const f of Object.values(got.files)) await access(f);
  const svg = await readFile(got.files.svg, "utf8");
  assert.match(svg, /var\(--brand-charcoal-ink,#20262e\)/);
  const xml = await readFile(got.files.drawable, "utf8");
  assert.match(xml, /@color\/brand_charcoal_ink/);

  // A colour that is asked for and is in the brief snaps to it; one that is nowhere near
  // keeps its own value rather than being quietly moved.
  const ember = await makeText({ config, text: "A", fontPath: fontFile, name: "e", colour: "#c64a34", log: () => {} });
  assert.equal(ember.tokens[0].name, "brand-ember-orange");
  const odd = await makeText({ config, text: "A", fontPath: fontFile, name: "o", colour: "#00ff00", log: () => {} });
  assert.equal(odd.tokens[0].hex, "#00ff00");
  assert.equal(odd.tokens[0].brand, false);
});

test("a letter the font has not got is reported, not quietly dropped", async () => {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { DEFAULTS, merge, validate } = await import("../src/config.mjs");
  const { makeText } = await import("../src/text.mjs");

  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-text2-"));
  const fontFile = path.join(dir, "tiny.ttf");
  await writeFile(fontFile, tinyFont());
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, "# Brief\n\n## Product\nA shop.\n\n## Art direction\nFlat.\n");
  const config = validate(merge(DEFAULTS, { brief, out: path.join(dir, "out") }));
  config.briefText = "";
  config.palette = [];

  // The tiny font has only A and B, so Z cannot be set and the verdict must say so.
  const got = await makeText({ config, text: "AZB", fontPath: fontFile, name: "gap", log: () => {} });
  assert.deepEqual(got.facts.missing, ["Z"]);
  assert.equal(got.facts.verdict, "incomplete");

  await assert.rejects(() => makeText({ config, text: "", fontPath: fontFile, log: () => {} }), /--string/);
  await assert.rejects(() => makeText({ config, text: "A", fontPath: null, log: () => {} }), /--font/);
});

/** A flat two-colour mark to lock up beside the words. */
async function markFile(dir) {
  const { writeFile } = await import("node:fs/promises");
  const path = (await import("node:path")).default;
  const { encodePNG } = await import("../src/png.mjs");
  const S = 64;
  const data = new Uint8Array(S * S * 4);
  for (let y = 8; y < 56; y++) {
    for (let x = 8; x < 56; x++) {
      const i = (y * S + x) * 4;
      const inner = x > 20 && x < 44 && y > 20 && y < 44;
      data.set(inner ? [198, 74, 52, 255] : [32, 38, 46, 255], i);
    }
  }
  const file = path.join(dir, "mark.png");
  await writeFile(file, encodePNG({ width: S, height: S, data }));
  return file;
}

async function lockupSetup(tag) {
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { DEFAULTS, merge, validate } = await import("../src/config.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), `onmodel-${tag}-`));
  const fontFile = path.join(dir, "tiny.ttf");
  await writeFile(fontFile, tinyFont());
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, "# Brief\n\n## Product\nA shop.\n\n## Art direction\nFlat.\n");
  const config = validate(merge(DEFAULTS, { brief, out: path.join(dir, "out") }));
  config.briefText = "## Palette\n- Charcoal ink #20262e\n- Ember orange #c64a34\n";
  config.palette = ["#20262e", "#c64a34"];
  return { dir, fontFile, config, markPath: await markFile(dir) };
}

/** The `d` of every path the SVG draws, in the order it draws them. */
const pathsOf = (svg) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]);

test("a lockup puts the symbol beside the word, centred on the cap height", async () => {
  const { readFile } = await import("node:fs/promises");
  const { makeLockup, pathBounds } = await import("../src/lockup.mjs");
  const { fontFile, config, markPath } = await lockupSetup("lock1");

  const got = await makeLockup({ config, text: "AB", fontPath: fontFile, markPath, name: "beside", px: 100, gap: 0.5, symbol: 1.2, log: () => {} });
  assert.equal(got.facts.layout, "beside");
  assert.equal(got.facts.word.capHeight, 40, "measured off the H, which is 400 units of 1000");

  const svg = await readFile(got.files.svg, "utf8");
  const paths = pathsOf(svg);
  assert.ok(paths.length >= 2, "the symbol and the word are both drawn");
  const word = pathBounds(paths[paths.length - 1]);
  const sym = pathBounds(paths.slice(0, -1).join(""));

  // Side by side, with a gap between them and no overlap.
  assert.ok(sym.x1 < word.x0, `symbol ends at ${sym.x1}, word starts at ${word.x0}`);
  assert.ok(Math.abs(word.x0 - sym.x1 - got.facts.gap) < 2, `gap ${word.x0 - sym.x1}, meant to be ${got.facts.gap}`);

  // The symbol is centred on the band between the baseline and the cap line, NOT on the
  // word's ink. Neither glyph here descends, so the bottom of the ink is the baseline;
  // the triangle rises past the cap line, which is exactly the case that would drag the
  // symbol off centre if the ink were used instead.
  const baseline = word.y1;
  const capMiddle = baseline - got.facts.word.capHeight / 2;
  const symMiddle = (sym.y0 + sym.y1) / 2;
  assert.ok(Math.abs(symMiddle - capMiddle) < 2, `symbol centre ${symMiddle}, cap band centre ${capMiddle}`);
  assert.ok(word.y0 < baseline - got.facts.word.capHeight, "and one glyph does rise past the cap line");

  // Sized against the cap height, not the em: 1.2 of a 40px cap height.
  assert.ok(Math.abs(sym.y1 - sym.y0 - 48) < 2, `symbol is ${sym.y1 - sym.y0} tall, meant to be 48`);
});

test("stacked, the symbol is centred over the word", async () => {
  const { readFile } = await import("node:fs/promises");
  const { makeLockup, pathBounds } = await import("../src/lockup.mjs");
  const { fontFile, config, markPath } = await lockupSetup("lock2");

  const got = await makeLockup({ config, text: "AB", fontPath: fontFile, markPath, name: "above", layout: "above", px: 100, symbol: 2, log: () => {} });
  const svg = await readFile(got.files.svg, "utf8");
  const paths = pathsOf(svg);
  const word = pathBounds(paths[paths.length - 1]);
  const sym = pathBounds(paths.slice(0, -1).join(""));

  assert.ok(sym.y1 < word.y0, "the symbol sits above the word");
  const symMid = (sym.x0 + sym.x1) / 2;
  const wordMid = (word.x0 + word.x1) / 2;
  assert.ok(Math.abs(symMid - wordMid) < 2, `symbol centre ${symMid}, word centre ${wordMid}`);
});

test("both halves' colours come through, and the words take the brief's darkest", async () => {
  const { readFile } = await import("node:fs/promises");
  const { makeLockup } = await import("../src/lockup.mjs");
  const { fontFile, config, markPath } = await lockupSetup("lock3");
  const got = await makeLockup({ config, text: "AB", fontPath: fontFile, markPath, name: "colours", px: 80, log: () => {} });

  const names = got.tokens.map((t) => t.name);
  assert.ok(names.includes("brand-charcoal-ink"), names.join(", "));
  assert.ok(names.includes("brand-ember-orange"), "the symbol's second colour survives");
  assert.equal(new Set(names).size, names.length, "and no colour is listed twice");

  const css = await readFile(got.files.css, "utf8");
  assert.match(css, /--brand-charcoal-ink: #20262e;/);
  const xml = await readFile(got.files.drawable, "utf8");
  assert.match(xml, /@color\/brand_charcoal_ink/);
});

test("a lockup that cannot be made says which half failed", async () => {
  const { makeLockup } = await import("../src/lockup.mjs");
  const { fontFile, config, markPath } = await lockupSetup("lock4");
  await assert.rejects(() => makeLockup({ config, text: "AB", fontPath: fontFile, markPath, layout: "diagonal", log: () => {} }), /--layout/);
  await assert.rejects(() => makeLockup({ config, text: "", fontPath: fontFile, markPath, log: () => {} }), /--string/);
  await assert.rejects(() => makeLockup({ config, text: "AB", fontPath: null, markPath, log: () => {} }), /--font/);
});
