import { test } from "node:test";
import assert from "node:assert/strict";
import { simplify, silhouettePolygons, shapeFit, packedVector2, occluderPolygon, filledMask } from "../src/silhouette.mjs";
import { atlasTileSet } from "../src/atlas.mjs";

/** An image opaque wherever f(x, y) is true. */
function mask(w, h, f) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!f(x, y)) continue;
      const i = (y * w + x) * 4;
      data.set([200, 80, 60, 255], i);
    }
  }
  return { width: w, height: h, data };
}

const W = 64;
const c = W / 2;
const disc = (r = 24) => mask(W, W, (x, y) => Math.hypot(x - c, y - c) < r);
/** A ring: ink only on the rim, nothing in the middle, which is how outline art looks. */
const ring = () => mask(W, W, (x, y) => { const d = Math.hypot(x - c, y - c); return d < 24 && d > 19; });

test("simplifying keeps the corners and throws away the straights", () => {
  const line = [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]];
  assert.deepEqual(simplify(line, 0.5), [[0, 0], [4, 0]], "a straight run is two points");

  const corner = [[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]];
  const kept = simplify(corner, 0.5);
  assert.equal(kept.length, 3, "the bend survives");
  assert.deepEqual(kept[1], [10, 0]);

  assert.deepEqual(simplify([[0, 0], [1, 1]], 1), [[0, 0], [1, 1]], "too few points to simplify");
  assert.equal(simplify(corner, 0).length, corner.length, "no tolerance, no simplifying");
});

test("a body is what the art encloses, not only what it inks", () => {
  // Outline art is the case that catches this. A ring is ink on the rim and nothing in
  // the middle; its body is the disc. Measured against the ink alone, a correct shape
  // reported claiming four times its own area as empty space.
  const filled = filledMask(ring());
  let inside = 0;
  for (const v of filled) if (v) inside++;
  const solid = disc();
  let solidCount = 0;
  for (let i = 0; i < W * W; i++) if (solid.data[i * 4 + 3] >= 128) solidCount++;
  assert.ok(Math.abs(inside - solidCount) < solidCount * 0.1, `the ring fills to ${inside}, the disc is ${solidCount}`);

  const polys = silhouettePolygons(ring(), { maxPoints: 24 });
  const fit = shapeFit(ring(), polys);
  assert.equal(polys.length, 1, "one body, not an outer and an inner loop");
  assert.ok(fit.extra < 0.05, `claims ${fit.extra} empty`);
  assert.ok(fit.covers > 0.95, `covers ${fit.covers}`);
});

test("too few points and the shape goes wrong in a named direction", () => {
  // The two mistakes are not the same. Missing part of the sprite lets a sword through a
  // shoulder; claiming empty space makes the player collide with nothing.
  const tight = shapeFit(disc(), silhouettePolygons(disc(), { maxPoints: 7 }));
  assert.ok(tight.missed > 0.05, `an inscribed polygon misses ${tight.missed}`);
  assert.equal(tight.extra, 0, "and claims nothing that is not there");

  const enough = shapeFit(disc(), silhouettePolygons(disc(), { maxPoints: 20 }));
  assert.ok(enough.fit > 0.97, `fit ${enough.fit}`);
  assert.ok(enough.missed < 0.03);
});

test("the point budget is met by simplifying harder, not by cutting the tail off", () => {
  for (const budget of [6, 10, 20, 40]) {
    const polys = silhouettePolygons(disc(), { maxPoints: budget });
    assert.ok(polys[0].points.length <= budget, `${polys[0].points.length} points for a budget of ${budget}`);
    assert.ok(polys[0].points.length >= 3, "and still a polygon");
    // Tearing the tail off a loop would leave the first and last points far apart.
    const first = polys[0].points[0];
    const last = polys[0].points[polys[0].points.length - 1];
    assert.ok(Math.hypot(first[0] - last[0], first[1] - last[1]) < W * 0.6, "the loop still closes");
  }
});

test("separate pieces come back as separate shapes", () => {
  const two = mask(W, W, (x, y) => Math.hypot(x - 16, y - 16) < 9 || Math.hypot(x - 48, y - 48) < 9);
  assert.equal(silhouettePolygons(two, { maxPoints: 16 }).length, 2);
});

test("points are written in Godot's notation, and can be centred", () => {
  assert.equal(packedVector2([[0, 0], [2, 0], [2, 2]]), "PackedVector2Array(0, 0, 2, 0, 2, 2)");
  // A tile's collision is measured from the middle of the tile, not its corner.
  assert.equal(packedVector2([[0, 0], [32, 32]], { originX: 16, originY: 16 }), "PackedVector2Array(-16, -16, 16, 16)");
  assert.match(occluderPolygon([[0, 0], [8, 0], [8, 8]]), /^\[gd_resource type="OccluderPolygon2D" format=3\]/);
  assert.match(occluderPolygon([[0, 0], [8, 0], [8, 8]]), /polygon = PackedVector2Array\(0, 0, 8, 0, 8, 8\)/);
});

test("a TileSet can carry collision and occlusion, measured from the tile's centre", () => {
  // Checked against Godot 4.7.2, which wrote -16,-16 to 16,16 for a 32 px tile. Written
  // from the corner the body sits half a tile down and right of the art it belongs to.
  const square = [[0, 0], [32, 0], [32, 32], [0, 32]];
  const tres = atlasTileSet({ width: 32, height: 32 }, { file: "t.png", tileWidth: 32, collision: square, occluder: square });
  assert.match(tres, /0:0\/0\/physics_layer_0\/polygon_0\/points = PackedVector2Array\(-16, -16, 16, -16, 16, 16, -16, 16\)/);
  assert.match(tres, /\[sub_resource type="OccluderPolygon2D" id="OccluderPolygon2D_0"\]/);
  assert.match(tres, /0:0\/0\/occlusion_layer_0\/polygon_0\/polygon = SubResource\("OccluderPolygon2D_0"\)/);
  assert.match(tres, /physics_layer_0\/collision_layer = 1/);
  assert.match(tres, /occlusion_layer_0\/light_mask = 1/);

  // A layer that was not asked for is not declared, or Godot shows an empty one.
  const plain = atlasTileSet({ width: 32, height: 32 }, { file: "t.png", tileWidth: 32 });
  assert.ok(!/physics_layer_0/.test(plain));
  assert.ok(!/occlusion_layer_0/.test(plain));
});
