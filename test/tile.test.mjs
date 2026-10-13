import { test } from "node:test";
import assert from "node:assert/strict";
import { seam, makeSeamless, tiled } from "../src/tile.mjs";
import { atlasTileSet } from "../src/atlas.mjs";

/** An image whose pixel at (x, y) is f(x, y). */
function paint(w, h, f) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * w + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round(r)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

const W = 64;
/** Whole periods across the tile, so the right edge really does run into the left. */
const periodic = () => paint(W, W, (x, y) => { const v = 128 + 60 * Math.sin((2 * Math.PI * x * 3) / W) * Math.cos((2 * Math.PI * y * 2) / W); return [v, v * 0.8, v * 0.6]; });
/** Dark on the left, light on the right: the join is a cliff. */
const gradient = () => paint(W, W, (x) => { const v = 20 + (215 * x) / (W - 1); return [v, v, v]; });
const noisy = () => { let s = 9; const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; return paint(W, W, () => { const v = 100 + 80 * r(); return [v, v, v]; }); };

const columnsEqual = (img, a, b) => {
  for (let y = 0; y < img.height; y++) {
    for (let c = 0; c < 3; c++) {
      if (img.data[(y * img.width + a) * 4 + c] !== img.data[(y * img.width + b) * 4 + c]) return false;
    }
  }
  return true;
};

test("the join is measured against the texture's own grain, not in the abstract", () => {
  // The whole point of the ratio: a busy texture and a smooth one are judged alike,
  // because each is compared with how much it changes from one column to the next
  // anywhere else in itself.
  assert.ok(seam(periodic()).ratio < 2, `periodic ${seam(periodic()).ratio}`);
  assert.ok(seam(gradient()).ratio > 20, `gradient ${seam(gradient()).ratio}`);

  // Noise has a huge join in absolute terms and still tiles fine, since every step
  // across it is just as large. An absolute threshold would have condemned it.
  const n = seam(noisy());
  assert.ok(n.x > 20, `the join is large in absolute terms: ${n.x}`);
  assert.ok(n.ratio < 2, `but no sharper than its own grain: ${n.ratio}`);
});

test("closing the join makes the edges meet exactly", () => {
  const before = gradient();
  assert.ok(!columnsEqual(before, 0, W - 1), "the edges start far apart");
  const got = makeSeamless(before);
  assert.ok(columnsEqual(got.image, 0, W - 1), "and end identical");
  assert.ok(seam(got.image).ratio <= 1.2, `ratio after ${seam(got.image).ratio}`);
  assert.equal(seam(got.image).x, 0, "there is no step across the join at all");
});

test("the middle of the tile is left exactly as it was painted", () => {
  const before = periodic();
  const got = makeSeamless(before, { band: 6 });
  let changed = 0;
  for (let y = 10; y < W - 10; y++) {
    for (let x = 10; x < W - 10; x++) {
      const i = (y * W + x) * 4;
      if (before.data[i] !== got.image.data[i]) changed++;
    }
  }
  assert.equal(changed, 0, "the correction fades out well before the centre");
  assert.equal(got.band.x, 6);
});

test("how much the fix had to move says whether to trust it", () => {
  // A texture that nearly tiles needs almost nothing; one that never could needs a lot,
  // and that number is the warning rather than a quiet success.
  const gentle = makeSeamless(periodic());
  const violent = makeSeamless(gradient());
  assert.ok(gentle.mean < 2, `gentle ${gentle.mean}`);
  assert.ok(violent.mean > 8, `violent ${violent.mean}`);
});

test("a tile too small to have a join is left alone rather than mangled", () => {
  const tiny = paint(2, 2, () => [10, 20, 30]);
  assert.equal(seam(tiny).ratio, 1);
  const got = makeSeamless(tiny);
  assert.deepEqual(Array.from(got.image.data), Array.from(tiny.data));
});

test("the tile laid out in a grid repeats it exactly", () => {
  const one = paint(4, 4, (x, y) => [x * 60, y * 60, 0]);
  const many = tiled(one, 3);
  assert.equal(many.width, 12);
  assert.equal(many.height, 12);
  for (const [x, y] of [[0, 0], [4, 0], [8, 8], [5, 9]]) {
    const a = (y * 12 + x) * 4;
    const b = ((y % 4) * 4 + (x % 4)) * 4;
    assert.equal(many.data[a], one.data[b], `at ${x},${y}`);
    assert.equal(many.data[a + 1], one.data[b + 1]);
  }
});

test("the Godot TileSet is the shape Godot itself writes", () => {
  // Checked against Godot 4.7.2, which loaded this back and reported four tiles at the
  // right coordinates. A cell left undeclared is empty in the editor however good the
  // pixels are, which is the part a guess would miss.
  const tres = atlasTileSet({ width: 64, height: 64 }, { file: "ground.png", tileWidth: 32 });
  assert.match(tres, /^\[gd_resource type="TileSet" format=3\]/);
  assert.match(tres, /\[ext_resource type="Texture2D" path="res:\/\/ground\.png" id="1_atlas"\]/);
  assert.match(tres, /texture_region_size = Vector2i\(32, 32\)/);
  for (const cell of ["0:0/0 = 0", "1:0/0 = 0", "0:1/0 = 0", "1:1/0 = 0"]) assert.ok(tres.includes(cell), `declares ${cell}`);
  assert.match(tres, /tile_size = Vector2i\(32, 32\)/);
  assert.match(tres, /sources\/0 = SubResource\("TileSetAtlasSource_0"\)/);

  // One tile filling the whole image is one cell, not none.
  const single = atlasTileSet({ width: 128, height: 128 }, { file: "t.png", tileWidth: 128 });
  assert.equal((single.match(/\/0 = 0/g) ?? []).length, 1);
  assert.match(atlasTileSet({ width: 32, height: 32 }, { file: "t.png", tileWidth: 32, resPath: "res://art/t.png" }), /path="res:\/\/art\/t\.png"/);
});
