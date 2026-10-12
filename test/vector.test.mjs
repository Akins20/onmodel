import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { paletteNames, contours, polygonArea, fitLoop, vectorize, pathToPolygons, coverage, svgText, androidText, androidColoursText, otsuThreshold } from "../src/vector.mjs";
import { makeVector } from "../src/vectorize.mjs";
import { encodePNG, pngSize } from "../src/png.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";

/**
 * Vector output on synthetic marks with known answers, each case standing for a
 * lesson from the live runs: flat art traces close to its source, gradients and
 * texture are refused with a reason, pixel art converts exactly, key residue at the
 * rim never becomes an outline, colours that meet the silhouette never bleed into each
 * other, and a small accent is not outvoted by a large background.
 */

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "onmodel.mjs");

/** Paints with 4x4 supersampling: shade(x, y) returns [r, g, b] or null for clear. */
function paint(w, h, shade) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const c = shade(x + (sx + 0.5) / 4, y + (sy + 0.5) / 4);
          if (!c) continue;
          r += c[0];
          g += c[1];
          b += c[2];
          a += 1;
        }
      }
      if (a) data.set([Math.round(r / a), Math.round(g / a), Math.round(b / a), Math.round((a / 16) * 255)], (y * w + x) * 4);
    }
  }
  return { width: w, height: h, data };
}

const PLUM = [106, 27, 90];
const BLUSH = [244, 233, 241];
const INK = [29, 26, 30];
const at = (im, x, y) => Array.from(im.data.subarray((y * im.width + x) * 4, (y * im.width + x) * 4 + 4));
const PIS = "## Palette\nPlum #6A1B5A for the main form, magenta #A73669 for one small accent, blush #F4E9F1 for highlights and the inside of shapes, ink #1D1A1E only where a dark detail is needed, white #FFFFFF for the smallest highlight.\n";

test("palette names come from the words before each colour in the brief", () => {
  assert.deepEqual([...paletteNames(PIS).values()], ["plum", "magenta", "blush", "ink", "white"]);
  const chomp = paletteNames("## Palette\nBody cream #FFE6A5 with yellow #FFDC28 for the brighter side, mouth and tongue pink #EB96A0 with plum-brown #8C3C48 inside, outline and pupil deep teal-black #04201A, eye white #FFFFFF, mint #60EECC only for a tiny glint.\n");
  assert.deepEqual([...chomp.values()], ["body-cream", "yellow", "tongue-pink", "plum-brown", "deep-teal-black", "eye-white", "mint"]);
  assert.deepEqual([...paletteNames("## Palette\n#112233, #445566\n").values()], ["colour-1", "colour-2"], "unnamed colours are numbered");
});

test("contours close round a shape and its hole, with sub-pixel edges", () => {
  const w = 40;
  const field = new Float32Array(w * w);
  for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) field[y * w + x] = x >= 5 && x < 35 && y >= 5 && y < 35 && !(x >= 15 && x < 25 && y >= 15 && y < 25) ? 1 : 0;
  const loops = contours(field, w, w, 0.5);
  assert.equal(loops.length, 2, "the outline and the hole");
  const areas = loops.map((l) => Math.abs(polygonArea(l))).sort((a, b) => b - a);
  assert.ok(Math.abs(areas[0] - 30 * 30) < 30 * 4, `outer area ${areas[0]}`);
  assert.ok(Math.abs(areas[1] - 10 * 10) < 10 * 4, `hole area ${areas[1]}`);
});

test("a circle is fitted with a few curves that stay on it", () => {
  const pts = Array.from({ length: 400 }, (_, i) => [100 + 80 * Math.cos((i / 400) * 2 * Math.PI), 100 + 80 * Math.sin((i / 400) * 2 * Math.PI)]);
  const curves = fitLoop(pts, 0.5);
  assert.ok(curves.length >= 2 && curves.length <= 12, `${curves.length} curves`);
  let worst = 0;
  for (const c of curves) {
    for (let t = 0; t <= 1; t += 0.05) {
      const mt = 1 - t;
      const x = mt ** 3 * c[0][0] + 3 * mt * mt * t * c[1][0] + 3 * mt * t * t * c[2][0] + t ** 3 * c[3][0];
      const y = mt ** 3 * c[0][1] + 3 * mt * mt * t * c[1][1] + 3 * mt * t * t * c[2][1] + t ** 3 * c[3][1];
      worst = Math.max(worst, Math.abs(Math.hypot(x - 100, y - 100) - 80));
    }
  }
  assert.ok(worst < 1, `the curves stay within a pixel of the circle (worst ${worst.toFixed(2)})`);
});

test("flat art traces into brand-named layers that match the source, hole and corners kept", () => {
  const img = paint(200, 200, (x, y) => {
    const d = Math.hypot(x - 100, y - 100);
    if (d > 90 || d < 25) return null;
    if (Math.abs(x - 140) < 18 && Math.abs(y - 70) < 14) return BLUSH;
    return PLUM;
  });
  const v = vectorize(img, { palette: ["#6a1b5a", "#f4e9f1"], names: paletteNames(PIS) });
  assert.ok(!v.refused, v.refused);
  assert.equal(v.facts.mode, "flat");
  assert.equal(v.facts.verdict, "good");
  assert.ok(v.facts.silhouette >= 0.97 && v.facts.colourKept >= 0.97, JSON.stringify(v.facts));
  assert.deepEqual(v.tokens.map((t) => t.name).sort(), ["brand-blush", "brand-plum"]);
  const c = v.crop;
  assert.equal(at(v.render, 100 - c.x, 100 - c.y)[3], 0, "the hole stays clear");
  assert.match(v.svg, /style="fill:var\(--brand-plum,#6a1b5a\)"/);
  assert.match(v.svg, /fill-rule="evenodd"/);
});

test("gradients and texture are refused with the measurement that says why", () => {
  const gradient = paint(160, 160, (x, y) => (Math.hypot(x - 80, y - 80) > 70 ? null : [Math.round(x * 1.5), 80, Math.round(255 - y * 1.5)]));
  const g = vectorize(gradient);
  assert.match(g.refused, /gradients or shading/);
  assert.ok(g.facts.meanError > 4);
  let seed = 3;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const texture = paint(120, 120, (x, y) => (Math.hypot(x - 60, y - 60) > 50 ? null : [100 + rnd() * 80, 40 + rnd() * 60, 90 + rnd() * 50]));
  assert.match(vectorize(texture).refused, /textured or painted/);
});

function sprite(softEdge) {
  const w = 16;
  const data = new Uint8Array(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - 7.5, y - 7.5);
      data.set(d < 3 ? [255, 255, 255, 255] : d < 6 ? [255, 230, 165, 255] : d < 7 ? [4, 32, 26, 255] : softEdge && d < 7.6 ? [4, 32, 26, 90] : [0, 0, 0, 0], (y * w + x) * 4);
    }
  }
  return { width: w, height: w, data };
}
const SPRITE_NAMES = { palette: ["#ffe6a5", "#04201a", "#ffffff"], names: new Map([["#ffe6a5", "body-cream"], ["#04201a", "outline"], ["#ffffff", "eye-white"]]) };

test("hard-edged pixel art is recognised and converts exactly", () => {
  const v = vectorize(sprite(false), SPRITE_NAMES);
  assert.equal(v.facts.mode, "pixel");
  assert.equal(v.facts.verdict, "exact");
  assert.equal(v.facts.hardened, 0);
});

test("a pixel-mode sprite with a soft edge is hardened at half, counted, and still exact", () => {
  const v = vectorize(sprite(true), { ...SPRITE_NAMES, pixel: true });
  assert.equal(v.facts.mode, "pixel");
  assert.equal(v.facts.verdict, "exact");
  assert.equal(v.facts.silhouette, 1);
  assert.equal(v.facts.colourKept, 1);
  assert.ok(v.facts.hardened > 0, "the soft edge pixels were hardened and counted");
  assert.match(v.svg, /shape-rendering="crispEdges"/);
  assert.deepEqual(v.tokens.map((t) => t.name).sort(), ["brand-body-cream", "brand-eye-white", "brand-outline"]);
  assert.doesNotMatch(v.svg, / C/, "straight pixel edges only");
});

test("key residue at the rim never becomes an outline colour", () => {
  // a plum disc whose outer two pixels are a dark green fringe, as keying can leave
  const img = paint(160, 160, (x, y) => {
    const d = Math.hypot(x - 80, y - 80);
    if (d > 70) return null;
    return d > 68 ? [30, 70, 35] : PLUM;
  });
  const v = vectorize(img, { palette: ["#6a1b5a"], names: new Map([["#6a1b5a", "plum"]]) });
  assert.ok(!v.refused, v.refused);
  assert.deepEqual(v.tokens.map((t) => t.name), ["brand-plum"], "only plum: the fringe took the colour inside it");
  const c = v.crop;
  const edge = at(v.render, 80 - c.x, 80 - 68 - c.y + 1);
  assert.ok(Math.abs(edge[0] - PLUM[0]) < 30 && Math.abs(edge[1] - PLUM[1]) < 30, `the rim renders plum, got ${edge}`);
});

test("two colours meeting the silhouette do not bleed into each other at the edge", () => {
  // left half ink, right half blush: ink is traced first, so it must not show at blush's rim
  const img = paint(160, 160, (x, y) => (Math.hypot(x - 80, y - 80) > 70 ? null : x < 80 ? INK : BLUSH));
  const v = vectorize(img, { palette: ["#1d1a1e", "#f4e9f1"] });
  assert.ok(!v.refused, v.refused);
  const c = v.crop;
  // walk the right half's edge: every half-covered pixel must be blush with partial alpha, not darkened
  let worst = 0;
  for (let deg = -60; deg <= 60; deg += 5) {
    const t = (deg * Math.PI) / 180;
    const x = Math.round(80 + 70 * Math.cos(t)) - c.x;
    const y = Math.round(80 + 70 * Math.sin(t)) - c.y;
    const p = at(v.render, x, y);
    if (p[3] < 40) continue;
    worst = Math.max(worst, BLUSH[0] - p[0], BLUSH[1] - p[1], BLUSH[2] - p[2]);
  }
  assert.ok(worst < 40, `blush's anti-aliased rim stays blush (darkest shift ${worst})`);
});

test("a small accent gets its own colour even beside a large background", () => {
  // a large plum field with a small ink dot: area alone would outvote the dot
  const img = paint(300, 300, (x, y) => {
    if (x < 4 || y < 4 || x > 296 || y > 296) return null;
    return Math.hypot(x - 220, y - 80) < 9 ? INK : PLUM;
  });
  const v = vectorize(img, { palette: ["#6a1b5a", "#1d1a1e"], names: new Map([["#6a1b5a", "plum"], ["#1d1a1e", "ink"]]) });
  assert.ok(!v.refused, v.refused);
  assert.ok(v.tokens.some((t) => t.name === "brand-ink"), `the dot is its own colour: ${JSON.stringify(v.tokens)}`);
  const dot = at(v.render, 220 - v.crop.x, 80 - v.crop.y);
  assert.ok(dot[0] < 60, `the dot renders dark, got ${dot}`);
});

test("path text parses back and fills by even-odd", () => {
  const polys = pathToPolygons("M0 0H10V10H0ZM3 3V7H7V3Z");
  assert.equal(polys.length, 2);
  const cov = coverage(polys, 10, 10);
  assert.ok(cov[0] > 0.99 && cov[5 * 10 + 5] < 0.01, "the inner square is a hole");
  const curve = pathToPolygons("M0 0C10 0 10 10 0 10Z", { step: 1 });
  assert.ok(curve[0].length > 4, "a curve is flattened into many points");
});

test("the SVG and Android files carry the brand names, fallbacks and even-odd fills", () => {
  const layers = [{ name: "plum", hex: "#6a1b5a", d: "M0 0H4V4H0Z" }];
  const token = (n) => `brand-${n}`;
  assert.match(svgText(layers, 4, 4, { token }), /fill:var\(--brand-plum,#6a1b5a\)/);
  const xml = androidText(layers, 4, 4, { token });
  assert.match(xml, /android:fillColor="@color\/brand_plum"/);
  assert.match(xml, /android:fillType="evenOdd"/);
  assert.match(xml, /android:viewportWidth="4"/);
  assert.match(androidColoursText([{ name: "plum", hex: "#6a1b5a" }], { token }), /<color name="brand_plum">#6A1B5A<\/color>/);
});

test("the vector command writes every file for a flat mark, and refuses painted art with exit 2", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-vec-"));
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, `# Brief\n\n## Product\nA shop.\n\n## Art direction\nFlat.\n\n${PIS}`);
  const config = validate(merge(DEFAULTS, { brief, out: path.join(dir, "out") }));
  config.briefText = await readFile(brief, "utf8");
  config.palette = ["#6a1b5a", "#a73669", "#f4e9f1", "#1d1a1e", "#ffffff"];
  const mark = path.join(dir, "mark.png");
  await writeFile(mark, encodePNG(paint(140, 140, (x, y) => (Math.hypot(x - 70, y - 70) > 60 ? null : Math.abs(x - 70) < 15 && Math.abs(y - 70) < 15 ? BLUSH : PLUM))));
  const r = await makeVector({ config, markPath: mark, log: () => {} });
  assert.equal(r.facts.verdict, "good");
  for (const f of Object.values(r.files)) await access(f);
  assert.match(await readFile(r.files.css, "utf8"), /--brand-plum: #6a1b5a;/);
  assert.match(await readFile(r.files.drawable, "utf8"), /@color\/brand_plum/);
  assert.match(await readFile(r.htmlPath, "utf8"), /A good match/);

  const painted = path.join(dir, "painted.png");
  await writeFile(painted, encodePNG(paint(120, 120, (x, y) => (Math.hypot(x - 60, y - 60) > 50 ? null : [Math.round(x * 2), 90, Math.round(240 - y * 2)]))));
  const run = spawnSync(process.execPath, [bin, "vector", "--mark", painted, "--brief", brief, "--out", path.join(dir, "out")], { encoding: "utf8" });
  assert.equal(run.status, 2, run.stdout + run.stderr);
  assert.match(run.stdout, /not traced/);
});

/**
 * Anti-aliased line art: a ring and a bar of one colour, drawn by how far each pixel is
 * from the line, which is what a real drawing tool produces and what keeps it out of the
 * pixel-art path.
 */
function lineArt(size, halfWidth, colour) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  const radius = size * 0.32;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const ring = Math.abs(Math.hypot(px - c, py - c) - radius);
      const bar = px > c - radius && px < c + radius ? Math.abs(py - c) : Infinity;
      const edge = halfWidth + 0.5 - Math.min(ring, bar);
      const a = edge <= 0 ? 0 : edge >= 1 ? 1 : edge;
      if (a <= 0) continue;
      const i = (y * size + x) * 4;
      data[i] = colour[0];
      data[i + 1] = colour[1];
      data[i + 2] = colour[2];
      data[i + 3] = Math.round(a * 255);
    }
  }
  return { width: size, height: size, data };
}

test("line art is flat, not painted: it just has little interior to measure", () => {
  const art = lineArt(96, 1.2, [27, 77, 62]);
  const got = vectorize(art, { pixel: false });
  assert.ok(!got.refused, `refused: ${got.refused}`);
  // The two measures pull apart here, which is the whole point. Only a fifth of the ink
  // has four opaque neighbours, so the old share of all of it read as painted; of the
  // part that can be judged, every pixel is flat.
  assert.ok(got.facts.interiorShare < 0.3, `interiorShare ${got.facts.interiorShare}`);
  assert.ok(got.facts.flatShare > 0.9, `flatShare ${got.facts.flatShare}`);
  assert.ok(got.facts.meanError < 2, `meanError ${got.facts.meanError}`);
});

test("centre lines trace a ring and its bar as three strokes of the right weight", () => {
  const art = lineArt(96, 1.2, [27, 77, 62]);
  const filled = vectorize(art, { pixel: false });
  const stroked = vectorize(art, { pixel: false, stroke: 4 });
  assert.ok(!stroked.refused, `refused: ${stroked.refused}`);

  // The drawing is a ring cut in two by a bar, so three lines and no more. Every
  // skeleton pixel has to land in one of them: an earlier walk left a whole arc in no
  // run at all and quietly traced five sixths of the picture.
  assert.equal(stroked.facts.lines, 3, "two arcs and the bar");
  assert.equal(stroked.facts.strokeMax, 4);
  assert.match(stroked.svg, /stroke-width="[\d.]+"/);
  assert.match(stroked.svg, /stroke-linecap="round"/);
  assert.match(stroked.android, /android:strokeWidth="[\d.]+"/);

  // The line is 2.4 px wide and must be measured as such, to a fraction of a pixel. A
  // distance transform alone cannot tell 2 px from 1, so this is read off the soft edge.
  assert.ok(Math.abs(stroked.facts.hairline - 2.4) < 0.15, `hairline ${stroked.facts.hairline}`);

  // Strokes beat outlines on the thing that matters: how much of the source comes back.
  assert.ok(stroked.facts.silhouette > filled.facts.silhouette, `${stroked.facts.silhouette} vs ${filled.facts.silhouette}`);
  assert.ok(stroked.facts.colourKept >= 0.9, `colourKept ${stroked.facts.colourKept}`);

  // A hairline can never score like a blob, so the bar it is held to says what its own
  // width allows, and the raw figure stays on the record beside it.
  assert.ok(stroked.facts.silhouetteCeiling < 0.85, `ceiling ${stroked.facts.silhouetteCeiling}`);
  assert.equal(stroked.facts.verdict, "good");
});

test("a solid mark is left as fills even when centre lines are asked for", () => {
  const size = 64;
  const data = new Uint8Array(size * size * 4);
  for (let y = 12; y < 52; y++) {
    for (let x = 12; x < 52; x++) {
      const i = (y * size + x) * 4;
      data.set([200, 40, 60, 255], i);
    }
  }
  const got = vectorize({ width: size, height: size, data }, { pixel: false, stroke: 4 });
  assert.ok(!got.refused, `refused: ${got.refused}`);
  assert.equal(got.facts.lines, 0, "a block is nothing like a stroke");
  assert.ok(!/stroke-width/.test(got.svg));
});

/** A lit sphere: smooth shading, which a flat trace refuses and full tone is for. */
function shadedSphere(size = 160, bands = 0) {
  const data = new Uint8Array(size * size * 4);
  const c = size / 2;
  const R = size * 0.4;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = x + 0.5 - c;
      const py = y + 0.5 - c;
      const r = Math.hypot(px, py);
      const cover = R + 0.5 - r;
      const a = cover <= 0 ? 0 : cover >= 1 ? 1 : cover;
      if (a <= 0) continue;
      const z = Math.sqrt(Math.max(0, 1 - (r / R) ** 2));
      const lit = Math.max(0, (-px / R) * 0.5 + (-py / R) * 0.5 + z * 0.7);
      const k = 0.25 + 0.75 * Math.min(1, lit);
      const i = (y * size + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        const v = Math.round([52, 108, 196][ch] * k + 255 * Math.max(0, lit - 0.85) * 2);
        data[i + ch] = bands ? Math.round(v / bands) * bands : v;
      }
      data[i + 3] = Math.round(a * 255);
    }
  }
  return { width: size, height: size, data };
}

test("full tone traces shaded art a flat trace refuses, and beats the PNG doing it", () => {
  const art = shadedSphere();
  const flat = vectorize(art, { pixel: false });
  assert.ok(flat.refused, "a flat trace will not have it");
  assert.match(flat.refused, /gradients or shading/);

  const toned = vectorize(art, { pixel: false, tone: 16 });
  assert.ok(!toned.refused, `refused: ${toned.refused}`);
  assert.ok(toned.facts.colours >= 8, `${toned.facts.colours} colours`);
  assert.equal(toned.facts.tone, 16);
  assert.ok(toned.facts.silhouette >= 0.97, `silhouette ${toned.facts.silhouette}`);
  assert.ok(toned.facts.colourKept >= 0.95, `colourKept ${toned.facts.colourKept}`);
  // Shading is the one case where a vector can honestly lose to its own PNG, so the
  // answer is a measured ratio rather than a promise. A sphere comfortably wins.
  assert.ok(toned.facts.vsPNG < 1, `vsPNG ${toned.facts.vsPNG}`);
});

test("full tone is never worse than a flat trace on art the flat trace handles", () => {
  // Banded art already traces well without it, and asking for tones used to make it
  // worse: the mean of what the colours missed landed between two bands, owned none of
  // either and was dropped, so the search gave up with the bands still missing.
  const art = shadedSphere(160, 64);
  const flat = vectorize(art, { pixel: false });
  const toned = vectorize(art, { pixel: false, tone: 16 });
  assert.ok(!flat.refused && !toned.refused);
  assert.ok(toned.facts.colourKept >= flat.facts.colourKept - 0.02, `${toned.facts.colourKept} vs ${flat.facts.colourKept}`);
  assert.ok(toned.facts.drift <= flat.facts.drift + 0.5, `drift ${toned.facts.drift} vs ${flat.facts.drift}`);
  assert.equal(toned.facts.verdict, "good");
});

test("a colour search that cannot converge still stops", () => {
  // Settling drops a colour that wins no pixels, so a push can leave the count where it
  // was. Against a smooth gradient, which no finite palette satisfies, the loop's own
  // condition never comes true: without a bound it ran for ever.
  const art = shadedSphere(96);
  const started = Date.now();
  const got = vectorize(art, { pixel: false, tone: 64 });
  assert.ok(Date.now() - started < 20000, "it finished");
  assert.ok(!got.refused);
  assert.ok(got.facts.colours <= 64);
});

test("banding is caught, which no per-pixel measure can see", () => {
  // A gradient cut into flat bands can hold every pixel to within a few of its old
  // colour while the eye sees rings: the error is small everywhere but it steps.
  const smooth = vectorize(shadedSphere(), { pixel: false, tone: 16 });
  assert.ok(smooth.facts.colourKept >= 0.95, "every pixel is close");
  assert.ok(smooth.facts.banding > 0.06, `banding ${smooth.facts.banding}`);
  assert.notEqual(smooth.facts.verdict, "good", "so it is not called good");

  // Art that was banded to begin with keeps its own edges, and those are not invented.
  const already = vectorize(shadedSphere(160, 64), { pixel: false, tone: 16 });
  assert.ok(already.facts.banding < 0.06, `banding ${already.facts.banding}`);
  assert.equal(already.facts.verdict, "good");
});

test("the luminance cut is chosen from the art, and lands in the gap", () => {
  // Two flat tones and nothing between them. Otsu names the top of the dark class, which
  // here is the ink's own luminance; cutting there puts the whole mark halfway up the
  // soft edge and it came out at half coverage, so the cut belongs in the gap.
  const size = 40;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const dark = i % 2 === 0;
    data.set(dark ? [20, 20, 20, 255] : [200, 200, 200, 255], i * 4);
  }
  const t = otsuThreshold({ width: size, height: size, data });
  assert.ok(t > 20 && t < 200, `threshold ${t}`);
  assert.ok(Math.abs(t - 110) < 6, `threshold ${t} should sit between the two tones`);
});

test("mono keeps the dark and drops the light, in one brand colour", () => {
  const art = lineArt(96, 1.5, [24, 28, 34]);
  // a pale wash over one half, which mono should not treat as ink
  for (let y = 0; y < 48; y++) {
    for (let x = 0; x < 96; x++) {
      const p = (y * 96 + x) * 4;
      if (art.data[p + 3]) continue;
      art.data.set([228, 228, 232, 255], p);
    }
  }
  const got = vectorize(art, { pixel: false, mono: true });
  assert.ok(!got.refused, `refused: ${got.refused}`);
  assert.equal(got.facts.colours, 1, "one colour");
  assert.equal(got.facts.mono, 1);
  assert.ok(got.facts.cuts[0] > 34 && got.facts.cuts[0] < 228, `cut ${got.facts.cuts[0]}`);

  // The wash is lighter than the cut, so none of it is ink: the one colour that comes
  // back is the dark line, not a blend of the two.
  const [r, g, b] = got.tokens[0].hex.match(/\w\w/g).map((v) => parseInt(v, 16));
  assert.ok(0.299 * r + 0.587 * g + 0.114 * b < 80, `the colour is ${got.tokens[0].hex}`);

  // It is a hairline, so it is judged against what a line that thin allows, not 0.97.
  assert.ok(got.facts.silhouetteCeiling < 0.9, `ceiling ${got.facts.silhouetteCeiling}`);
  assert.notEqual(got.facts.verdict, "poor");
});

test("mono with levels gives nested bands, as many as the art really has", () => {
  const one = vectorize(shadedSphere(), { pixel: false, mono: true });
  const many = vectorize(shadedSphere(), { pixel: false, mono: true, tone: 4 });
  assert.equal(one.facts.colours, 1);
  assert.equal(one.facts.cuts.length, 1);
  assert.ok(many.facts.cuts.length > 1, `cuts ${many.facts.cuts}`);
  assert.ok(many.facts.colours > one.facts.colours, `${many.facts.colours} vs ${one.facts.colours}`);
  // Cuts step downwards: each level sits inside the one before it.
  for (let i = 1; i < many.facts.cuts.length; i++) assert.ok(many.facts.cuts[i] < many.facts.cuts[i - 1]);
});

test("noise sets the smallest shape worth tracing", () => {
  const art = lineArt(96, 1.2, [27, 77, 62]);
  const fine = vectorize(art, { pixel: false, noise: 4 });
  const coarse = vectorize(art, { pixel: false, noise: 4000 });
  assert.ok(fine.facts.loops > coarse.facts.loops, `${fine.facts.loops} vs ${coarse.facts.loops}`);
});

test("an image too large to trace is turned down with its size, not left to hang", () => {
  const huge = { width: 5000, height: 5000, data: new Uint8Array(4) };
  const got = vectorize(huge, { pixel: false, maxPixels: 16e6 });
  assert.ok(got.refused);
  assert.match(got.refused, /5000x5000/);
  assert.match(got.refused, /megapixels/);
  assert.equal(got.facts.width, 5000);
});

test("a PNG's size is read from its header, without decoding it", () => {
  // The point is to turn down a file too large to hold before holding it, so this must
  // not go near the pixels.
  const img = { width: 300, height: 170, data: new Uint8Array(300 * 170 * 4) };
  const bytes = encodePNG(img);
  assert.deepEqual(pngSize(bytes), { width: 300, height: 170 });
  assert.equal(pngSize(Buffer.from("not a png at all")), null);
  assert.equal(pngSize(bytes.subarray(0, 20)), null);
});
