import { test } from "node:test";
import assert from "node:assert/strict";
import { variants, peeringBits, cellMask, cellGeometry, terrainAtlas, adjacencyReport, coverage, fitFill, renderMap, NEIGHBOURS, MODES } from "../src/terrain.mjs";
import { atlasTileSet } from "../src/atlas.mjs";
import { seam } from "../src/tile.mjs";
import { resize } from "../src/key.mjs";

/** A fill that really tiles, which a terrain set depends on. */
function fill(S = 32) {
  const data = new Uint8Array(S * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = 120 + 40 * Math.sin((2 * Math.PI * x * 2) / S) * Math.cos((2 * Math.PI * y * 2) / S);
      const i = (y * S + x) * 4;
      data[i] = v * 0.5;
      data[i + 1] = v;
      data[i + 2] = v * 0.45;
      data[i + 3] = 255;
    }
  }
  return { width: S, height: S, data };
}

test("the set is 16 cells on sides and 47 on corners and sides", () => {
  // 47 and not 256: a corner only means anything when both sides beside it are present,
  // since nothing reaches diagonally past a gap. Getting this wrong is how a set ends up
  // with holes the editor never warns about, so the counts are worth asserting outright.
  assert.equal(variants("sides").length, 16);
  assert.equal(variants("both").length, 47);

  // And every cell is distinct.
  const keys = variants("both").map((c) => Object.values(c).map(Number).join(""));
  assert.equal(new Set(keys).size, 47);

  // No cell claims a corner whose two sides are not both there.
  for (const c of variants("both")) {
    if (c.tl) assert.ok(c.t && c.l, "a top-left corner needs a top and a left");
    if (c.br) assert.ok(c.b && c.r, "a bottom-right corner needs a bottom and a right");
  }
  assert.throws(() => variants("diagonal"), /mode must be/);
  // Names every object inherits are not modes; toString once wrote a function into the .tres.
  assert.throws(() => variants("toString"), /mode must be/);
  assert.throws(() => variants("constructor"), /mode must be/);
});

test("peering bits are named and ordered the way Godot writes them", () => {
  assert.deepEqual(NEIGHBOURS, ["right_side", "bottom_right_corner", "bottom_side", "bottom_left_corner", "left_side", "top_left_corner", "top_side", "top_right_corner"]);
  const all = { t: true, r: true, b: true, l: true, tl: true, tr: true, br: true, bl: true };
  assert.deepEqual(peeringBits(all, "both"), NEIGHBOURS, "every neighbour, in Godot's order");
  // Sides mode has no corner bits to declare at all.
  assert.deepEqual(peeringBits(all, "sides"), ["right_side", "bottom_side", "left_side", "top_side"]);
  assert.deepEqual(peeringBits({ t: false, r: true, b: false, l: false }, "sides"), ["right_side"]);
  assert.deepEqual(peeringBits({ t: false, r: false, b: false, l: false }, "both"), [], "an island declares nothing");
  assert.equal(MODES.both, 0, "Godot's MATCH_CORNERS_AND_SIDES");
  assert.equal(MODES.sides, 2, "and MATCH_SIDES");
});

test("a cell with every neighbour is solid, and an island touches no edge", () => {
  const S = 32;
  const solid = cellMask({ t: true, r: true, b: true, l: true, tl: true, tr: true, br: true, bl: true }, S);
  assert.ok(solid.every((v) => v === 1), "every neighbour means every pixel");

  const island = cellMask({ t: false, r: false, b: false, l: false, tl: false, tr: false, br: false, bl: false }, S);
  for (let i = 0; i < S; i++) {
    assert.equal(island[i], 0, "nothing along the top");
    assert.equal(island[(S - 1) * S + i], 0, "nor the bottom");
    assert.equal(island[i * S], 0, "nor the left");
    assert.equal(island[i * S + S - 1], 0, "nor the right");
  }
  assert.equal(island[(S / 2) * S + S / 2], 1, "but something in the middle");
});

test("rounding never reaches an edge, which is what keeps the joins exact", () => {
  // Softening the mask is what makes a corner look drawn rather than cut from graph
  // paper, and it has to happen strictly inside: blur that touched an edge would change
  // the pixels along it and two cells meant to butt together would stop matching.
  const S = 32;
  const right = cellMask({ t: false, r: true, b: false, l: false, tl: false, tr: false, br: false, bl: false }, S, { round: 6 });
  const left = cellMask({ t: false, r: false, b: false, l: true, tl: false, tr: false, br: false, bl: false }, S, { round: 6 });
  for (let y = 0; y < S; y++) {
    // Where one says "material to my right" and the other "material to my left", the two
    // touching columns must say the same thing all the way down.
    assert.equal(right[y * S + S - 1], left[y * S], `row ${y}`);
  }
});

test("every pair of cells that can ever touch joins exactly, and only those pairs are judged", () => {
  // All pairs is the wrong test: most cannot occur together, so what their shared edge does
  // is nobody's business. One random map is not enough either: a 24 by 24 one placed 38 of
  // the 47 cells and never the solid one. Every way to fill the window around two cells
  // finds every pair that can occur: 169 side by side and 169 one above the other.
  const atlas = terrainAtlas(fill(), { mode: "both" });
  assert.equal(atlas.cells.length, 47);
  const got = adjacencyReport(atlas);
  assert.equal(got.missing, 0, "every shape a map can ask for has a cell");
  assert.equal(got.edges, 338);
  assert.equal(got.joins, 1, `${got.matched} of ${got.edges} agree: ${got.broken.slice(0, 3).join("; ")}`);
});

test("a notch painted on a cell the old test map never placed is caught", () => {
  // The reviewer's case: alpha cleared on the right edge of the cell with every side and
  // the two right-hand corners, which the 24 by 24 map never put down. Five real pairs
  // then show a gap.
  const atlas = terrainAtlas(fill());
  const c = atlas.cells.find((x) => x.col === 5 && x.row === 4);
  assert.deepEqual(c.bits, ["right_side", "bottom_right_corner", "bottom_side", "left_side", "top_side", "top_right_corner"]);
  for (let y = 3; y <= 8; y++) for (let x = 30; x <= 31; x++) atlas.image.data[((4 * 32 + y) * atlas.image.width + 5 * 32 + x) * 4 + 3] = 0;
  const got = adjacencyReport(atlas);
  assert.equal(got.matched, 333);
  assert.equal(got.broken.length, 5);

  // And material painted onto a side with nothing beside it, which no pair ever looks at.
  const other = terrainAtlas(fill());
  const island = other.cells.find((x) => x.bits.length === 0);
  for (let y = 3; y <= 8; y++) for (let x = 29; x <= 31; x++) other.image.data[((island.row * 32 + y) * other.image.width + island.col * 32 + x) * 4 + 3] = 255;
  assert.equal(adjacencyReport(other).joins, 1, "no pair sees it");
  assert.equal(coverage(other).misdrawn, 1, "the shape check does");
});

test("sides-only cannot close a diagonal, and says so rather than pretending", () => {
  // Not a fault to fix: MATCH_SIDES has no bit for a corner, so where two cells disagree
  // about what is above them the edge steps. The number is the reason to pick the other
  // mode for anything meant to look seamless.
  const got = adjacencyReport(terrainAtlas(fill(), { mode: "sides" }));
  assert.equal(got.missing, 0, "it can still supply every square");
  assert.equal(got.edges, 128);
  assert.equal(got.matched, 32, "and a quarter of the pairs that can touch join");
});

test("the map is drawn from the set, and only where there is terrain", () => {
  const atlas = terrainAtlas(fill(), { mode: "both" });
  const map = renderMap(atlas, { width: 8, height: 6 });
  assert.equal(map.width, 8 * atlas.cellSize);
  assert.equal(map.height, 6 * atlas.cellSize);
  let solid = 0;
  for (let i = 0; i < map.width * map.height; i++) if (map.data[i * 4 + 3] >= 128) solid++;
  assert.ok(solid > 0 && solid < map.width * map.height, "some terrain, and some not");
});

test("the TileSet declares the terrain set and every cell's peering bits", () => {
  // Checked against Godot 4.7.2, which loaded this back and reported one terrain set in
  // mode 0, one terrain by name, 47 tiles and 46 of them carrying bits; the forty-seventh
  // is the island, which correctly declares none.
  const atlas = terrainAtlas(fill(), { mode: "both" });
  const tres = atlasTileSet(atlas.image, { file: "grass.png", tileWidth: atlas.cellSize, terrain: { mode: MODES.both, name: "grass", cells: atlas.cells } });
  assert.match(tres, /terrain_set_0\/mode = 0/);
  assert.match(tres, /terrain_set_0\/terrain_0\/name = "grass"/);
  assert.match(tres, /terrain_set_0\/terrain_0\/color = Color\(/);
  assert.equal((tres.match(/\/0\/terrain_set = 0/g) ?? []).length, 47, "every cell belongs to the set");
  assert.match(tres, /terrains_peering_bit\/right_side = 0/);

  // The total number of bits is a property of the set, not of the writing.
  const expected = atlas.cells.reduce((t, c) => t + c.bits.length, 0);
  assert.equal((tres.match(/terrains_peering_bit\//g) ?? []).length, expected);
  assert.equal(atlas.cells.filter((c) => c.bits.length === 0).length, 1, "exactly one island");

  // Without a terrain set, nothing about terrain is written.
  const plain = atlasTileSet(atlas.image, { file: "grass.png", tileWidth: atlas.cellSize });
  assert.ok(!/terrain/.test(plain));
});

/** A fill that tiles at its own size with a chosen number of waves across it. */
function wave(W, H, px, py) {
  const data = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = 120 + 50 * Math.sin((2 * Math.PI * x * px) / W) * Math.cos((2 * Math.PI * y * py) / H);
      const i = (y * W + x) * 4;
      data[i] = v * 0.5;
      data[i + 1] = v;
      data[i + 2] = v * 0.45;
      data[i + 3] = 255;
    }
  }
  return { width: W, height: H, data };
}

const quarter = (img, w, h) => {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) data.set(img.data.subarray(y * img.width * 4, (y * img.width + w) * 4), y * w * 4);
  return { width: w, height: h, data };
};

test("a fill bigger than the cell is scaled into it, so the material carries across every join", () => {
  // Three waves across 64 px: its top-left 32 px holds a wave and a half, which is what
  // every cell used to show, so every join in the map joined two different phases.
  const big = wave(64, 64, 3, 3);
  assert.ok(seam(big).ratio <= 1.5, "the fill itself tiles");
  assert.ok(seam(quarter(big, 32, 32)).ratio > 3, "and its corner does not, which is the bug");

  const atlas = terrainAtlas(big, { size: 32 });
  assert.equal(atlas.fill.width, 32);
  assert.equal(atlas.fillFilter, "box");
  assert.ok(seam(atlas.fill).ratio <= 1.5, `the cell holds the whole fill, joined at its own wrap: ${seam(atlas.fill).ratio}`);
});

test("a fill smaller than the cell is enlarged across its wrap, not its edges", () => {
  // Blending at the border has to reach the far side of the fill, which is its true
  // neighbour; clamping to the edge pixel puts the seam straight back.
  const small = wave(16, 16, 1, 1);
  assert.ok(seam(resize(small, 32, 32, { filter: "linear" })).ratio > 2, "clamped enlarging seams");
  const fitted = fitFill(small, 32);
  assert.equal(fitted.filter, "linear");
  assert.ok(seam(fitted.image).ratio <= 1.5, `wrapped enlarging does not: ${seam(fitted.image).ratio}`);

  // Pixel art is enlarged without blending at all, so it keeps its hard pixels.
  const crisp = fitFill(small, 32, { pixel: true });
  assert.equal(crisp.filter, "nearest");
  assert.deepEqual([...crisp.image.data.subarray(0, 4)], [...crisp.image.data.subarray(4, 8)], "each pixel is doubled, not blended");
});

test("no rounding the command accepts can reach an edge or eat a shape", () => {
  // The blur runs twice and so reaches twice its radius; holding the radius to the margin
  // let --round 8 on a 32 px cell break 36 of the 47 cells. And a wide margin leaves the
  // sides as thin necks the rounding cut through. Both are clamped now, and measured.
  const f = fill();
  for (const [size, opts] of [[32, { round: 8 }], [32, { round: 64 }], [16, { round: 4 }], [24, { round: 6 }], [12, { round: 3 }], [32, { margin: 12 }], [32, { margin: 13 }], [32, { margin: 15 }], [7, {}], [13, {}], [64, {}]]) {
    const atlas = terrainAtlas(f, { size, ...opts });
    const map = adjacencyReport(atlas);
    const drawn = coverage(atlas);
    const label = `${size}px ${JSON.stringify(opts)}`;
    assert.equal(map.joins, 1, `${label}: ${map.matched} of ${map.edges}`);
    assert.deepEqual(drawn, { hollow: 0, gaps: 0, misdrawn: 0 }, label);
  }
  // The default at 32 px is the round of 4 the help promises.
  assert.deepEqual(cellGeometry(32), { m: 10, r: 4 });
});

test("pixels come whole, and anything else is refused rather than drawn empty", () => {
  // A --round of 2.5 indexed half a pixel, read nothing, and left every cell empty, which
  // the edge check then called perfect.
  const f = fill();
  assert.throws(() => terrainAtlas(f, { round: 2.5 }), /whole number/);
  assert.throws(() => terrainAtlas(f, { margin: 1.5 }), /whole number/);
  assert.throws(() => terrainAtlas(f, { size: 32.5 }), /whole number/);
  assert.throws(() => terrainAtlas(f, { columns: 2.5 }), /whole number/);
  assert.throws(() => terrainAtlas(f, { size: 3 }), /4 or more/);
});

test("an empty or flattened atlas is caught, though every edge in the map agrees", () => {
  // The map check compares shapes along edges, and empty meets empty as exactly as solid
  // meets solid. Whether each cell draws the shape its bits declare is a separate check.
  const atlas = terrainAtlas(fill());
  assert.deepEqual(coverage(atlas), { hollow: 0, gaps: 0, misdrawn: 0 });

  const flat = { ...atlas, image: { ...atlas.image, data: Uint8Array.from(atlas.image.data) } };
  for (let i = 3; i < flat.image.data.length; i += 4) flat.image.data[i] = 255;
  assert.equal(adjacencyReport(flat).joins, 1, "solid squares agree everywhere");
  assert.equal(coverage(flat).misdrawn, 46, "and all but the full cell draw the wrong shape");

  const blank = { ...atlas, image: { ...atlas.image, data: new Uint8Array(atlas.image.data.length) } };
  assert.equal(adjacencyReport(blank).joins, 1, "empty squares agree everywhere");
  assert.equal(coverage(blank).hollow, 47);
});

test("the command refuses a fractional pixel value before drawing anything", async () => {
  const { spawnSync } = await import("node:child_process");
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const path = (await import("node:path")).default;
  const { fileURLToPath } = await import("node:url");
  const { encodePNG } = await import("../src/png.mjs");
  const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "onmodel.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-terraincli-"));
  const file = path.join(dir, "grass.png");
  await writeFile(file, encodePNG(fill()));
  for (const flag of ["--round", "--cell", "--margin", "--columns"]) {
    const run = spawnSync(process.execPath, [bin, "terrain", "--mark", file, "--out", dir, flag, "2.5"], { encoding: "utf8" });
    assert.notEqual(run.status, 0, `${flag} 2.5 is refused`);
    assert.match(run.stderr, /whole number/, `${flag}: ${run.stderr}`);
  }
  const bad = spawnSync(process.execPath, [bin, "terrain", "--mark", file, "--out", dir, "--mode", "toString"], { encoding: "utf8" });
  assert.notEqual(bad.status, 0, "--mode toString is refused");
  assert.match(bad.stderr, /--mode must be/);
});
