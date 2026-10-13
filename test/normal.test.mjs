import { test } from "node:test";
import assert from "node:assert/strict";
import { normalMap, relight, lightingStrip, heightField, smooth } from "../src/normal.mjs";
import { seam } from "../src/tile.mjs";
import { atlasCanvasTexture } from "../src/atlas.mjs";

function paint(w, h, f) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = f(x, y);
      const i = (y * w + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round(r)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[i + 3] = a === undefined ? 255 : a;
    }
  }
  return { width: w, height: h, data };
}

const W = 64;
const at = (img, x, y) => [img.data[(y * img.width + x) * 4], img.data[(y * img.width + x) * 4 + 1], img.data[(y * img.width + x) * 4 + 2]];

/** A dome: luminance really is the height, so the lighting has no excuse to be wrong. */
function dome(size = 96) {
  const c = size / 2;
  const R = size * 0.38;
  return paint(size, size, (x, y) => {
    const r = Math.hypot(x + 0.5 - c, y + 0.5 - c);
    const v = 60 + 180 * (r >= R ? 0 : Math.sqrt(1 - (r / R) ** 2));
    return [v, v * 0.9, v * 0.8];
  });
}

test("flat art gives flat normals, exactly", () => {
  const got = normalMap(paint(W, W, () => [120, 90, 60]));
  assert.deepEqual(at(got.image, W / 2, W / 2), [128, 128, 255]);
  assert.equal(got.facts.flatShare, 1);
  assert.equal(got.facts.unitError, 0);
});

test("the normal leans away from the rise, and green points up the image", () => {
  // Brighter to the right means the surface climbs rightward, so the face tilts left.
  const rising = normalMap(paint(W, W, (x) => { const v = 40 + (170 * x) / (W - 1); return [v, v, v]; }));
  assert.ok(at(rising.image, W / 2, W / 2)[0] < 128, `red ${at(rising.image, W / 2, W / 2)[0]}`);

  // Brighter downward climbs down the image, so the face tilts UP the image. Green holds
  // Y measured up, so it goes above 128. Flip that and every bump lights as a dent.
  const falling = normalMap(paint(W, W, (x, y) => { const v = 40 + (170 * y) / (W - 1); return [v, v, v]; }));
  assert.ok(at(falling.image, W / 2, W / 2)[1] > 128, `green ${at(falling.image, W / 2, W / 2)[1]}`);
  assert.equal(falling.facts.green, "up (OpenGL)");

  // Godot wants X+ Y+ Z+, which is this one; the other convention is there for tools
  // that want it and must be the mirror image.
  const dx = normalMap(paint(W, W, (x, y) => { const v = 40 + (170 * y) / (W - 1); return [v, v, v]; }), { invertY: true });
  assert.ok(at(dx.image, W / 2, W / 2)[1] < 128, `green ${at(dx.image, W / 2, W / 2)[1]}`);
  assert.equal(at(dx.image, W / 2, W / 2)[1] + at(falling.image, W / 2, W / 2)[1], 255, "the two conventions mirror about 127.5");
  assert.deepEqual([at(dx.image, W / 2, W / 2)[0], at(dx.image, W / 2, W / 2)[2]], [at(falling.image, W / 2, W / 2)[0], at(falling.image, W / 2, W / 2)[2]], "and only green differs");
});

test("a dome lit from a corner is brightest at that corner", () => {
  // The decisive test. A number can say the encoding is faithful; only this says the
  // bumps read as bumps. With the green channel flipped, top and bottom swap.
  const art = dome();
  const n = normalMap(art, { strength: 1.2, blur: 1 });
  const grey = paint(art.width, art.height, () => [190, 190, 190]);
  const c = art.width / 2;
  const R = art.width * 0.38;
  const quadrant = (lit, x0, y0) => {
    let sum = 0;
    let n2 = 0;
    for (let y = y0; y < y0 + art.width / 2; y++) {
      for (let x = x0; x < x0 + art.width / 2; x++) {
        if (Math.hypot(x - c, y - c) > R * 0.9) continue;
        sum += lit.data[(y * art.width + x) * 4];
        n2++;
      }
    }
    return sum / Math.max(1, n2);
  };
  const half = art.width / 2;
  for (const [lx, ly, bright, dark] of [
    [-0.6, -0.6, [0, 0], [half, half]],
    [0.6, -0.6, [half, 0], [0, half]],
    [-0.6, 0.6, [0, half], [half, 0]],
    [0.6, 0.6, [half, half], [0, 0]],
  ]) {
    const lit = relight(grey, n.image, { light: [lx, ly, 0.5], ambient: 0.25 });
    const b = quadrant(lit, bright[0], bright[1]);
    const d = quadrant(lit, dark[0], dark[1]);
    assert.ok(b > d + 15, `light (${lx},${ly}): lit side ${b.toFixed(0)} vs shaded ${d.toFixed(0)}`);
  }
});

test("the gradient read back out of the pixels is the gradient it was made from", () => {
  // This is what can actually be proven. It says the encoding is faithful; it says
  // nothing about whether luminance was ever a sensible stand-in for height.
  for (const strength of [0.5, 1, 2]) {
    const got = normalMap(dome(), { strength, blur: 1 });
    assert.ok(got.facts.gradientError < 0.02, `strength ${strength}: mean ${got.facts.gradientError}`);
    assert.ok(got.facts.gradientWorst < 0.08, `strength ${strength}: worst ${got.facts.gradientWorst}`);
    assert.ok(got.facts.unitError < 0.02, `strength ${strength}: unit ${got.facts.unitError}`);
  }
});

test("a normal map for a tile has to tile too", () => {
  // A seamless tile lit by a seamed normal map still shows a grid, so the map is held to
  // the same join measurement as the colour it accompanies.
  const tile = paint(W, W, (x, y) => { const v = 128 + 60 * Math.sin((2 * Math.PI * x * 3) / W) * Math.cos((2 * Math.PI * y * 2) / W); return [v, v * 0.8, v * 0.6]; });
  const wrapped = normalMap(tile, { wrap: true, blur: 1 });
  const clamped = normalMap(tile, { wrap: false, blur: 1 });
  assert.ok(seam(wrapped.image).ratio < 1.5, `wrapped ${seam(wrapped.image).ratio}`);
  assert.ok(seam(clamped.image).ratio > seam(wrapped.image).ratio, `clamped ${seam(clamped.image).ratio} should be worse than wrapped ${seam(wrapped.image).ratio}`);
});

test("what is not visible does not become a cliff round the edge", () => {
  // Transparent pixels take the average of what is visible. Left at zero, a sprite would
  // have a wall all the way round it and light up like it had been stamped out of metal.
  const sprite = paint(W, W, (x, y) => (Math.hypot(x - W / 2, y - W / 2) < 20 ? [180, 180, 180, 255] : [0, 0, 0, 0]));
  const { field, mean, visible } = heightField(sprite);
  assert.ok(visible > 1000 && visible < W * W);
  assert.ok(Math.abs(field[0] - mean) < 1e-6, "outside takes the average, not zero");
  // And the statistics count only where the art is. A sprite is mostly padding, which
  // encodes perfectly flat, so averaging it in made every figure look excellent in
  // proportion to how much empty space the frame happened to have.
  const got = normalMap(sprite);
  assert.ok(got.facts.visible < W * W * 0.6, "most of the frame is empty");
  assert.ok(got.facts.flatShare > 0.9, "and the disc itself is one flat colour, so its normals are flat");

  const shaded = normalMap(paint(W, W, (x, y) => {
    const r = Math.hypot(x - W / 2, y - W / 2);
    if (r >= 20) return [0, 0, 0, 0];
    const v = 60 + 180 * Math.sqrt(1 - (r / 20) ** 2);
    return [v, v, v, 255];
  }));
  assert.ok(shaded.facts.flatShare < 0.1, `a shaded sprite is not flat: ${shaded.facts.flatShare}`);
  // The steepest face as an angle, which is the form anyone can picture.
  assert.ok(shaded.facts.steepest > 5 && shaded.facts.steepest < 80, `steepest ${shaded.facts.steepest} degrees`);
});

test("blurring more leaves less for the map to catch", () => {
  const grainy = (() => { let s = 7; const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; return paint(W, W, () => { const v = 110 + 70 * r(); return [v, v, v]; }); })();
  const sharp = normalMap(grainy, { blur: 0 });
  const soft = normalMap(grainy, { blur: 4 });
  assert.ok(soft.facts.maxSlope < sharp.facts.maxSlope, `${soft.facts.maxSlope} should be under ${sharp.facts.maxSlope}`);
  // And it says how much it threw away, which is the cost of the luminance guess.
  assert.ok(soft.facts.grainShare > sharp.facts.grainShare, `${soft.facts.grainShare} vs ${sharp.facts.grainShare}`);
  assert.equal(smooth(new Float32Array([1, 2, 3, 4]), 4, 1, 0).length, 4, "no radius is a copy, not a crash");
});

test("the four-corner strip is four copies side by side", () => {
  const art = dome(32);
  const n = normalMap(art);
  const strip = lightingStrip(art, n.image, { gap: 4 });
  assert.equal(strip.width, 32 * 4 + 4 * 3);
  assert.equal(strip.height, 32);
});

test("the Godot CanvasTexture binds colour to normal, with the enum values Godot uses", () => {
  // Checked against Godot 4.7.2, which loaded this back with both textures bound.
  // texture_filter 1 is nearest and texture_repeat 2 is enabled, not 1.
  const tres = atlasCanvasTexture({ diffuse: "res://a.png", normal: "res://a.normal.png", filter: 1, repeat: 2 });
  assert.match(tres, /^\[gd_resource type="CanvasTexture" format=3\]/);
  assert.match(tres, /diffuse_texture = ExtResource\("1_diffuse"\)/);
  assert.match(tres, /normal_texture = ExtResource\("2_normal"\)/);
  assert.match(tres, /texture_filter = 1/);
  assert.match(tres, /texture_repeat = 2/);

  const bare = atlasCanvasTexture({ diffuse: "res://a.png" });
  assert.ok(!/normal_texture/.test(bare), "no normal map, no line for one");
  assert.ok(!/texture_filter/.test(bare), "and no flags that were not asked for");
  const spec = atlasCanvasTexture({ diffuse: "res://a.png", normal: "res://n.png", specular: "res://s.png", shininess: 0.5 });
  assert.match(spec, /specular_texture = ExtResource\("3_specular"\)/);
  assert.match(spec, /specular_shininess = 0\.5/);
});
