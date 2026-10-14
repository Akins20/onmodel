import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { trimBounds, trimFrames, packRects, trimAtlas, restoreFrame, verifyTrim, pivotOf } from "../src/trim.mjs";
import { packActions, atlasJSON, atlasGodot, atlasHeader } from "../src/atlas.mjs";
import { makeAtlas } from "../src/repack.mjs";
import { checkRun, failuresOf } from "../src/check.mjs";
import { encodePNG } from "../src/png.mjs";
import { decodeImage } from "../src/image.mjs";

const S = 64;

/** A character-ish frame: a block standing on the ground line, shifted and sized per pose. */
function pose(dx, h, { faint = false, edge = 255 } = {}) {
  const d = new Uint8Array(S * S * 4);
  for (let y = S - 4 - h; y < S - 4; y++) for (let x = 24 + dx; x < 40 + dx; x++) d.set([200, 80 + y, 60 + x, 255], (y * S + x) * 4);
  // A soft edge column, the way painted art has one.
  for (let y = S - 4 - h; y < S - 4; y++) d.set([200, 80, 60, edge === 255 ? 90 : edge], (y * S + 23 + dx) * 4);
  if (faint) d.set([255, 255, 255, 40], ((S - 5) * S + 18 + dx) * 4);
  return { width: S, height: S, data: d };
}
const empty = () => ({ width: S, height: S, data: new Uint8Array(S * S * 4) });

function grid() {
  return packActions([
    { name: "walk", frames: [pose(0, 40), pose(3, 42, { faint: true }), pose(-2, 38)], fps: 8 },
    { name: "idle", frames: [pose(0, 40), empty()], fps: 4, loop: false },
  ]);
}

test("bounds hold every pixel at the threshold, and an empty frame has none", () => {
  assert.deepEqual(trimBounds(pose(0, 40)), { x: 23, y: 20, w: 17, h: 40 });
  assert.equal(trimBounds(empty()), null);
  const cut = trimFrames([pose(0, 40), empty()], { margin: 1 });
  assert.deepEqual(cut[0], { x: 22, y: 19, w: 19, h: 42, sourceW: S, sourceH: S, empty: false });
  assert.equal(cut[1].empty, true, "an empty frame keeps one transparent texel, since no engine takes a region of nothing");
  // A margin never reaches outside the cell.
  const full = { width: 8, height: 8, data: new Uint8Array(8 * 8 * 4).fill(255) };
  assert.deepEqual(trimFrames([full], { margin: 3 })[0], { x: 0, y: 0, w: 8, h: 8, sourceW: 8, sourceH: 8, empty: false });
});

test("packed rectangles never overlap, keep their padding and stay inside the atlas", () => {
  let seed = 7;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
  const sizes = Array.from({ length: 40 }, () => ({ w: 3 + Math.floor(rnd() * 40), h: 3 + Math.floor(rnd() * 50) }));
  const pad = 2;
  const got = packRects(sizes, { padding: pad });
  sizes.forEach((s, i) => {
    const a = got.at[i];
    assert.ok(a.x >= pad && a.y >= pad && a.x + s.w + pad <= got.width && a.y + s.h + pad <= got.height, `rect ${i} inside with its padding`);
    for (let j = i + 1; j < sizes.length; j++) {
      const b = got.at[j];
      const t = sizes[j];
      const apart = a.x + s.w + pad <= b.x || b.x + t.w + pad <= a.x || a.y + s.h + pad <= b.y || b.y + t.h + pad <= a.y;
      assert.ok(apart, `rects ${i} and ${j} keep ${pad}px apart`);
    }
  });
  assert.throws(() => packRects([{ w: 100, h: 100 }], { maxSide: 50 }), /do not fit/);
});

test("a trimmed atlas puts every frame back exactly where it was, painted or pixel art", () => {
  const g = grid();
  for (const margin of [1, 0]) {
    const t = trimAtlas(g, { margin, padding: 2 });
    const v = verifyTrim(t.image, t.placements, t.cells);
    assert.equal(v.verdict, "exact", JSON.stringify(v));
    assert.ok(t.image.width * t.image.height < 0.3 * g.image.width * g.image.height, "and it is a fraction of the grid");
    // Restoring is the inverse of trimming, checked here directly as well.
    const p = t.placements[1];
    const back = restoreFrame(t.image, p);
    const cell = { width: S, height: S, data: new Uint8Array(S * S * 4) };
    for (let y = 0; y < S; y++) cell.data.set(g.image.data.subarray(((p.cellY + y) * g.image.width + p.cellX) * 4, ((p.cellY + y) * g.image.width + p.cellX + S) * 4), y * S * 4);
    assert.deepEqual([...back.data], [...cell.data]);
  }
});

test("only pixels the threshold lets go may go, and a visible one is a loss", () => {
  const g = grid();
  const faint = trimAtlas(g, { alpha: 100, margin: 0 });
  const v = verifyTrim(faint.image, faint.placements, faint.cells, { alpha: 100 });
  assert.equal(v.verdict, "exact");
  assert.ok(v.faint > 0, "the alpha-40 speck and the alpha-90 edge were cut on purpose and counted");

  const harsh = trimAtlas(g, { alpha: 255, margin: 0 });
  const edge = packActions([{ name: "soft", frames: [pose(0, 40, { edge: 200 })], fps: 8 }]);
  const cut = trimAtlas(edge, { alpha: 255, margin: 0 });
  assert.equal(verifyTrim(cut.image, cut.placements, cut.cells, { alpha: 255 }).verdict, "lossy", "an alpha-200 edge is visible art");
  assert.equal(verifyTrim(harsh.image, harsh.placements, harsh.cells, { alpha: 255 }).lost, 0, "an alpha-90 edge is under half opaque, so it is only faint");
});

test("a record that does not put a frame back is caught", () => {
  const t = trimAtlas(grid(), { margin: 1 });
  const moved = t.placements.map((p, i) => (i === 2 ? { ...p, trim: { ...p.trim, x: p.trim.x + 1 } } : p));
  const v = verifyTrim(t.image, moved, t.cells);
  assert.equal(v.verdict, "moved");
  assert.equal(v.moved, 1);
});

test("frames that fill their cells get no smaller, and the number says so", () => {
  const full = () => ({ width: 32, height: 32, data: new Uint8Array(32 * 32 * 4).fill(200) });
  const g = packActions([{ name: "block", frames: Array.from({ length: 8 }, full), fps: 8 }]);
  const t = trimAtlas(g, { padding: 2 });
  assert.ok(t.image.width * t.image.height > g.image.width * g.image.height, "padding costs more than trimming saves");
  assert.equal(verifyTrim(t.image, t.placements, t.cells).verdict, "exact");
});

test("the pivot is the point every frame stands on", () => {
  assert.deepEqual(pivotOf({ width: 64, height: 64 }, { fill: 0.9, anchor: "bottom" }), { x: 32, y: 61 });
  assert.deepEqual(pivotOf({ width: 64, height: 48 }, { fill: 1, anchor: "bottom" }), { x: 32, y: 48 });
  assert.deepEqual(pivotOf({ width: 64, height: 64 }, { anchor: "center" }), { x: 32, y: 32 });
  assert.deepEqual(pivotOf({ width: 64, height: 64 }, { fill: 0.9, anchor: "top" }), { x: 32, y: 3 });
});

test("the exports carry the trim, and a grid atlas is written exactly as before", () => {
  const g = grid();
  const t = trimAtlas(g, { margin: 1 });
  const json = atlasJSON(t, { version: "x", pivot: { x: 32, y: 61 } }).frames.walk_1;
  assert.equal(json.trimmed, true);
  assert.deepEqual(json.sourceSize, { w: S, h: S });
  const p = t.placements[1];
  assert.deepEqual(json.spriteSourceSize, { x: p.trim.x, y: p.trim.y, w: p.width, h: p.height });
  assert.deepEqual(json.pivot, { x: 0.5, y: 0.9531 });
  assert.deepEqual(json.anchor, json.pivot, "PixiJS reads anchor, Phaser pivot");

  // Untrimmed and without a pivot: the same JSON, .tres and header as before trimming existed.
  const plain = atlasJSON(g, { version: "x" }).frames.walk_1;
  assert.equal(plain.trimmed, false);
  assert.ok(!("pivot" in plain) && !("anchor" in plain), "a pivot changes how Phaser places a sprite, so it is never written unasked");
  assert.ok(!/margin/.test(atlasGodot(g)));
  assert.ok(!/ox, oy/.test(atlasHeader(g)) && !/PIVOT/.test(atlasHeader(g)));

  const tres = atlasGodot(t);
  assert.match(tres, new RegExp(`region = Rect2\\(${p.x}, ${p.y}, ${p.width}, ${p.height}\\)\\nmargin = Rect2\\(${p.trim.x}, ${p.trim.y}, ${S - p.width}, ${S - p.height}\\)`));
});

test("the trimmed C header compiles and holds the offsets", { skip: spawnSync("gcc", ["--version"]).status !== 0 && "no gcc" }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-hdr-"));
  const t = trimAtlas(grid(), { margin: 1 });
  await writeFile(path.join(dir, "hero.h"), atlasHeader(t, { prefix: "HERO", guard: "HERO_ATLAS_H", pivot: { x: 32, y: 61 } }));
  await writeFile(
    path.join(dir, "main.c"),
    `#include <stdio.h>\n#include "hero.h"\nint main(void) { const HeroFrame *f = &HERO_FRAMES[1]; printf("%d %d %d %d %d %d %d %d %.1f %d\\n", f->x, f->y, f->w, f->h, f->ox, f->oy, f->sw, f->sh, HERO_PIVOT_Y, HERO_TRIMMED); return 0; }\n`,
  );
  const exe = path.join(dir, "main.exe");
  const built = spawnSync("gcc", ["-std=c99", "-Wall", "-Werror", "-o", exe, path.join(dir, "main.c")], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const p = t.placements[1];
  const ran = spawnSync(exe, { encoding: "utf8" });
  assert.equal(ran.stdout.trim(), `${p.x} ${p.y} ${p.width} ${p.height} ${p.trim.x} ${p.trim.y} ${S} ${S} 61.0 1`);
});

/** A sprites run on disk, as `sprites` leaves it, with no call to anything. */
async function spritesRun(out, label) {
  const g = grid();
  const dir = path.join(out, label, "sprites");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${label}.png`), encodePNG(g.image));
  const actions = [];
  for (const r of g.ranges) {
    const adir = path.join(dir, r.name);
    await mkdir(adir, { recursive: true });
    const frames = [];
    for (let i = r.from; i <= r.to; i++) {
      const p = g.placements[i];
      const cell = { width: S, height: S, data: new Uint8Array(S * S * 4) };
      for (let y = 0; y < S; y++) cell.data.set(g.image.data.subarray(((p.y + y) * g.image.width + p.x) * 4, ((p.y + y) * g.image.width + p.x + S) * 4), y * S * 4);
      const f = path.join(adir, `frame_${String(i - r.from).padStart(2, "0")}.png`);
      await writeFile(f, encodePNG(cell));
      frames.push(f);
    }
    actions.push({ name: r.name, files: { frames } });
  }
  const summary = {
    tool: "onmodel",
    kind: "sprites",
    name: label,
    dir,
    placement: { fill: 0.9, anchor: "bottom" },
    actions,
    atlas: { image: path.join(dir, `${label}.png`), width: g.image.width, height: g.image.height, frame: g.frame, actions: g.ranges.map((x) => ({ name: x.name, from: x.from, to: x.to, fps: x.fps, loop: x.loop !== false })) },
  };
  await writeFile(path.join(dir, "sprites.json"), JSON.stringify(summary));
  return dir;
}

test("onmodel atlas packs an existing run trimmed, and the gate puts every frame back from disk", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  await spritesRun(out, "hero");
  const config = { out, pixel: null, sprite: { trim: true, trimAlpha: 1, padding: 2, pivot: true, fill: 0.9, anchor: "bottom" } };
  const made = await makeAtlas({ config, name: "hero", log: () => {} });
  assert.equal(made.atlas.layout, "trimmed");
  assert.equal(made.atlas.trim.verdict, "exact");
  assert.ok(made.atlas.trim.fewerTexels > 0.7, `${made.atlas.trim.fewerTexels}`);
  assert.deepEqual(made.atlas.trim.empty, ["idle_1"]);
  assert.deepEqual(made.atlas.pivot, { x: 32, y: 61, godotOffset: { x: 0, y: -29 } });
  assert.equal(made.framesEdited, 0);
  assert.equal(made.framesCompared, 5);

  const run = path.join(out, "hero");
  const before = await checkRun({ dir: run });
  assert.equal(failuresOf(before).length, 0, JSON.stringify(failuresOf(before)));
  const checks = before.find((r) => r.kind === "atlas").files.flatMap((f) => f.checks.map((c) => c.check));
  for (const c of ["size", "frames", "restores", "margins", "offsets"]) assert.ok(checks.includes(c), `checks ${c}`);

  const dir = made.dir;
  const fail = async () => failuresOf(await checkRun({ dir: run })).map((f) => `${f.file}:${f.check}`);

  // One frame nudged in the JSON: it no longer comes back where it was.
  const jsonFile = path.join(dir, "hero.json");
  const json = await readFile(jsonFile, "utf8");
  const edited = JSON.parse(json);
  edited.frames.walk_1.spriteSourceSize.x += 1;
  await writeFile(jsonFile, JSON.stringify(edited));
  assert.deepEqual(await fail(), ["hero.json:restores", "hero.tres:margins", "hero.h:offsets"]);
  await writeFile(jsonFile, json);

  // A margin changed by hand in the .tres fails only the .tres.
  const tresFile = path.join(dir, "hero.tres");
  const tres = await readFile(tresFile, "utf8");
  await writeFile(tresFile, tres.replace(/margin = Rect2\((\d+)/, (m, n) => `margin = Rect2(${Number(n) + 2}`));
  assert.deepEqual(await fail(), ["hero.tres:margins"]);
  await writeFile(tresFile, tres);

  // A row of the header changed by hand fails only the header.
  const hFile = path.join(dir, "hero.h");
  const h = await readFile(hFile, "utf8");
  await writeFile(hFile, h.replace(/(_FRAMES\[\d+\] = \{\s*\{ )(\d+)/, (m, a, n) => `${a}${Number(n) + 1}`));
  assert.deepEqual(await fail(), ["hero.h:offsets"]);
  await writeFile(hFile, h);

  assert.equal(failuresOf(await checkRun({ dir: run })).length, 0);
});

test("onmodel atlas says when the atlas was edited after the run, and packs the atlas", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  const dir = await spritesRun(out, "hero");
  await writeFile(path.join(dir, "walk", "frame_00.png"), encodePNG(pose(5, 30)));
  const made = await makeAtlas({ config: { out, pixel: null, sprite: { trim: true } }, name: "hero", log: () => {} });
  assert.equal(made.framesEdited, 1);
  assert.equal(made.atlas.trim.verdict, "exact");
});

test("onmodel atlas refuses what it cannot pack honestly", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  await assert.rejects(makeAtlas({ config: { out, sprite: {} }, name: "atlas", log: () => {} }), /summary atlas.json/);
  await assert.rejects(makeAtlas({ config: { out, sprite: {} }, name: "nobody", log: () => {} }), /no sprites run/);
  const dir = await spritesRun(out, "hero");
  await writeFile(path.join(dir, "hero.png"), encodePNG({ width: 10, height: 10, data: new Uint8Array(400) }));
  await assert.rejects(makeAtlas({ config: { out, sprite: {} }, name: "hero", log: () => {} }), /not the 192x128 grid/);
});

test("onmodel atlas keeps the run's pixel mode and normal map, and a trimmed run's touch-ups", async () => {
  // Packed with today's config, a pixel-art run came out as painted art: blurred in Godot, cut
  // with a margin, its CSS no longer pixelated. The run's own settings are used now.
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  const dir = await spritesRun(out, "hero");
  const sj = JSON.parse(await readFile(path.join(dir, "sprites.json"), "utf8"));
  sj.pixel = { grid: 64 };
  await writeFile(path.join(dir, "sprites.json"), JSON.stringify(sj));
  const crisp = await makeAtlas({ config: { out, pixel: null, sprite: { trim: true } }, name: "hero", log: () => {} });
  assert.deepEqual(crisp.pixel, { grid: 64 });
  assert.equal(crisp.atlas.trim.margin, 0, "pixel art is cut flush");
  assert.match(await readFile(crisp.atlas.godot, "utf8"), /texture_filter = 1/);
  assert.match(await readFile(crisp.atlas.css, "utf8"), /image-rendering: pixelated/);

  // A run that was itself trimmed is packed again from the atlas that ships, so a pixel touched
  // up in it since is kept.
  const out2 = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  await spritesRun(out2, "hero");
  const first = await makeAtlas({ config: { out: out2, pixel: null, sprite: { trim: true } }, name: "hero", log: () => {} });
  const runDir = path.join(out2, "hero", "sprites");
  // Make the trimmed atlas the run's own, as `sprites --trim` leaves it.
  for (const f of ["hero.png", "hero.json", "hero.cells.png"]) await writeFile(path.join(runDir, f), await readFile(path.join(first.dir, f)));
  const run = JSON.parse(await readFile(path.join(runDir, "sprites.json"), "utf8"));
  run.atlas = { ...run.atlas, layout: "trimmed", image: path.join(runDir, "hero.png"), json: path.join(runDir, "hero.json"), cells: path.join(runDir, "hero.cells.png") };
  await writeFile(path.join(runDir, "sprites.json"), JSON.stringify(run));
  const shipped = decodeImage(await readFile(path.join(runDir, "hero.png")));
  const rec = JSON.parse(await readFile(path.join(runDir, "hero.json"), "utf8")).frames.walk_0;
  const at = ((rec.frame.y + 5) * shipped.width + rec.frame.x + 5) * 4;
  shipped.data.set([255, 0, 255, 255], at);
  await writeFile(path.join(runDir, "hero.png"), encodePNG(shipped));
  const again = await makeAtlas({ config: { out: out2, pixel: null, sprite: { trim: true } }, name: "hero", log: () => {} });
  const cells = decodeImage(await readFile(again.atlas.cells));
  const cx = rec.spriteSourceSize.x + 5;
  const cy = rec.spriteSourceSize.y + 5;
  assert.deepEqual([...cells.data.subarray((cy * cells.width + cx) * 4, (cy * cells.width + cx) * 4 + 4)], [255, 0, 255, 255], "the touch-up is in the new atlas");
});

test("a trimmed normal map is the grid's, cut, so no frame is lit by its neighbour", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  await spritesRun(out, "hero");
  const lit = await makeAtlas({ config: { out, pixel: null, sprite: { trim: true, normal: true } }, name: "hero", log: () => {} });
  const { normalMap } = await import("../src/normal.mjs");
  const grid = decodeImage(await readFile(lit.atlas.cells));
  const full = normalMap(grid, { strength: 1, blur: 1 }).image;
  const cut = decodeImage(await readFile(lit.atlas.normal));
  const frames = JSON.parse(await readFile(lit.atlas.json, "utf8")).frames;
  const order = ["walk_0", "walk_1", "walk_2", "idle_0", "idle_1"];
  order.forEach((name, n) => {
    const f = frames[name];
    const cellX = (n < 3 ? n : n - 3) * S;
    const cellY = (n < 3 ? 0 : 1) * S;
    for (let y = 0; y < f.frame.h; y++) {
      for (let x = 0; x < f.frame.w; x++) {
        const a = ((f.frame.y + y) * cut.width + f.frame.x + x) * 4;
        const b = ((cellY + f.spriteSourceSize.y + y) * full.width + cellX + f.spriteSourceSize.x + x) * 4;
        assert.deepEqual([...cut.data.subarray(a, a + 4)], [...full.data.subarray(b, b + 4)], `${name} ${x},${y}`);
      }
    }
  });
});

test("the gate catches frames marked untrimmed and a pivot moved by hand", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  await spritesRun(out, "hero");
  const made = await makeAtlas({ config: { out, pixel: null, sprite: { trim: true, pivot: true, fill: 0.9, anchor: "bottom" } }, name: "hero", log: () => {} });
  const run = path.join(out, "hero");
  const fail = async () => failuresOf(await checkRun({ dir: run })).map((f) => `${f.file}:${f.check}`);
  assert.deepEqual(await fail(), []);
  const jsonFile = made.atlas.json;
  const json = await readFile(jsonFile, "utf8");
  const untrimmed = JSON.parse(json);
  untrimmed.frames.walk_0.trimmed = false;
  await writeFile(jsonFile, JSON.stringify(untrimmed));
  assert.deepEqual(await fail(), ["hero.json:trimmed"]);
  const moved = JSON.parse(json);
  moved.frames.walk_0.pivot = { x: 0.5, y: 0.5 };
  await writeFile(jsonFile, JSON.stringify(moved));
  assert.deepEqual(await fail(), ["hero.json (pivot):pivot"]);
  await writeFile(jsonFile, json);
  const h = await readFile(made.atlas.header, "utf8");
  await writeFile(made.atlas.header, h.replace(/_PIVOT_Y = [\d.]+f;/, "_PIVOT_Y = 10.0f;"));
  assert.deepEqual(await fail(), ["hero.h (pivot):pivot"]);
});

test("the gate catches a misstated cell, a rotated frame, a moved texture, a reordered animation and a wrong cell size", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  await spritesRun(out, "hero");
  const made = await makeAtlas({ config: { out, pixel: null, sprite: { trim: true } }, name: "hero", log: () => {} });
  const run = path.join(out, "hero");
  const fail = async () => failuresOf(await checkRun({ dir: run })).map((f) => `${f.file}:${f.check}`);
  const json = await readFile(made.atlas.json, "utf8");
  const big = JSON.parse(json);
  big.frames.walk_0.sourceSize = { w: 80, h: 70 };
  await writeFile(made.atlas.json, JSON.stringify(big));
  assert.deepEqual(await fail(), ["hero.json:cells"], "the JSON is blamed, not the correct .tres and .h");
  const turned = JSON.parse(json);
  turned.frames.walk_1.rotated = true;
  await writeFile(made.atlas.json, JSON.stringify(turned));
  assert.deepEqual(await fail(), ["hero.json:cells"]);
  await writeFile(made.atlas.json, json);
  const tres = await readFile(made.atlas.godot, "utf8");
  await writeFile(made.atlas.godot, tres.replace('res://hero.png', 'res://hero.cells.png'));
  assert.deepEqual(await fail(), ["hero.tres:texture"]);
  await writeFile(made.atlas.godot, tres.replace('SubResource("AtlasTexture_0")\n}, {\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_1")', 'SubResource("AtlasTexture_1")\n}, {\n"duration": 1.0,\n"texture": SubResource("AtlasTexture_0")'));
  assert.deepEqual(await fail(), ["hero.tres:order"]);
  await writeFile(made.atlas.godot, tres);
  const h = await readFile(made.atlas.header, "utf8");
  await writeFile(made.atlas.header, h.replace(/_FRAME_W = \d+;/, "_FRAME_W = 10;"));
  assert.deepEqual(await fail(), ["hero.h:cell"]);
  await writeFile(made.atlas.header, h);
  assert.deepEqual(await fail(), []);
});

test("packing again keeps the run's normal strength and Godot path, and an alpha trim is not an edit", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-atlas-"));
  await spritesRun(out, "hero");
  const first = await makeAtlas({ config: { out, pixel: null, sprite: { trim: true, trimAlpha: 100, normal: true, normalStrength: 3, resPath: "res://art/hero" } }, name: "hero", log: () => {} });
  assert.equal(first.atlas.normalStrength, 3);
  assert.equal(first.atlas.resPath, "res://art/hero");
  // Make that trimmed atlas the run's own, as sprites --trim --alpha 100 leaves it.
  const runDir = path.join(out, "hero", "sprites");
  for (const f of ["hero.png", "hero.json", "hero.cells.png", "hero.normal.png"]) await writeFile(path.join(runDir, f), await readFile(path.join(first.dir, f)));
  const run = JSON.parse(await readFile(path.join(runDir, "sprites.json"), "utf8"));
  run.atlas = { ...first.atlas, image: path.join(runDir, "hero.png"), json: path.join(runDir, "hero.json"), cells: path.join(runDir, "hero.cells.png"), normal: path.join(runDir, "hero.normal.png") };
  await writeFile(path.join(runDir, "sprites.json"), JSON.stringify(run));
  const again = await makeAtlas({ config: { out, pixel: null, sprite: { trim: true } }, name: "hero", log: () => {} });
  assert.equal(again.framesEdited, 0, "pixels the run's own alpha let go are not an edit");
  assert.equal(again.atlas.normalStrength, 3);
  assert.match(await readFile(again.atlas.godot, "utf8"), /path="res:\/\/art\/hero\/hero\.png"/);
});
