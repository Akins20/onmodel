import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chooseKey, keyOut, alphaBounds, trim, crop, resize, fitInto, fillBackground, colorCount, quantize, medianCut, gridAdherence, labOf, deltaE76 } from "../src/key.mjs";
import { decodeJPEG } from "../src/jpeg.mjs";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** A solid image, with optional rectangles painted over it: [x, y, w, h, [r, g, b, a]]. */
function paint(width, height, base, rects = []) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(base, i * 4);
  for (const [x, y, w, h, c] of rects) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set(c, (yy * width + xx) * 4);
  return { width, height, data };
}
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

const MAGENTA = [255, 0, 255, 255];
const BLUE = [20, 60, 220, 255];
// Far from magenta in Lab, the way a subject is when the key was chosen against the palette.
const GREEN = [20, 200, 60, 255];

test("the key is the candidate furthest from the palette, so a magenta brand is never keyed on magenta", () => {
  assert.equal(chooseKey([]), "#ff00ff");
  const forPlum = chooseKey(["#6a1b5a", "#e63946", "#f4e9f1"]);
  assert.notEqual(forPlum, "#ff00ff");
  assert.ok(["#00ff00", "#00ffff", "#0000ff", "#ffff00"].includes(forPlum));
  const forGreen = chooseKey(["#2a7d4f", "#34c759"]);
  assert.notEqual(forGreen, "#00ff00");
});

test("keying removes the flat background exactly and measures what it found", () => {
  const img = paint(20, 20, MAGENTA, [[5, 5, 10, 10, GREEN]]);
  const { image, facts } = keyOut(img, "#ff00ff", { tolerance: 30 });
  assert.equal(facts.background, 0.75);
  assert.equal(facts.fringe, 0);
  assert.equal(facts.residue, 0);
  assert.deepEqual(facts.bounds, { x: 5, y: 5, width: 10, height: 10 });
  assert.deepEqual(facts.touchesEdge, { top: false, left: false, bottom: false, right: false });
  assert.equal(px(image, 0, 0)[3], 0, "background is transparent");
  assert.deepEqual(px(image, 10, 10), GREEN, "the subject is untouched");
  assert.ok(facts.rimDelta > 60 && facts.interiorDelta > 60, "green is far from magenta on the rim and inside");
  // A subject of the key's own hue is reported as residue, not silently kept.
  const pinkish = keyOut(paint(10, 10, MAGENTA, [[2, 2, 6, 6, [230, 80, 220, 255]]]), "#ff00ff", { tolerance: 10 });
  assert.ok(pinkish.facts.residue > 0.9, `a magenta-hued subject is residue, got ${pinkish.facts.residue}`);
});

test("a blended edge becomes a soft alpha and its colour is un-mixed from the key", () => {
  // A one-pixel border that is three parts magenta to one part green, the way an
  // anti-aliased pixel next to the background arrives.
  const mix = [Math.round(0.75 * 255 + 0.25 * 20), Math.round(0.25 * 200), Math.round(0.75 * 255 + 0.25 * 60), 255];
  const img = paint(12, 12, MAGENTA, [[3, 3, 6, 6, mix], [4, 4, 4, 4, GREEN]]);
  const keyed = keyOut(img, "#ff00ff", { tolerance: 20, despill: true });
  const edge = px(keyed.image, 3, 5);
  assert.ok(edge[3] > 20 && edge[3] < 235, `a blended pixel is semi-transparent, got alpha ${edge[3]}`);
  const unmixedDistance = deltaE76(labOf(edge[0], edge[1], edge[2]), labOf(255, 0, 255));
  const rawDistance = deltaE76(labOf(mix[0], mix[1], mix[2]), labOf(255, 0, 255));
  assert.ok(unmixedDistance > rawDistance, "un-mixing moves the edge colour away from the key");
  assert.ok(keyed.facts.fringe > 0);
  const kept = keyOut(img, "#ff00ff", { tolerance: 20, despill: false });
  assert.deepEqual(px(kept.image, 3, 5).slice(0, 3), mix.slice(0, 3), "without despill the blend is kept as it was");
});

test("a key-tinted rim beside transparency is softened and un-mixed, while the same colour inside the subject is left alone", () => {
  // A blend of subject and key that sits past the soft band (opaque) but short of
  // three times the tolerance, the way a JPEG's anti-aliased edge arrives. Lab is
  // not linear in RGB, so the blend is found by measuring rather than guessed.
  const keyLab = labOf(255, 0, 255);
  let tinted = null;
  for (let w = 0.1; w <= 0.9 && !tinted; w += 0.02) {
    const mix = [Math.round(w * 20 + (1 - w) * 255), Math.round(w * 200), Math.round(w * 60 + (1 - w) * 255)];
    const d = deltaE76(labOf(...mix), keyLab);
    if (d > 43 && d < 57) tinted = [...mix, 255];
  }
  assert.ok(tinted, "a blend inside the rim band exists");
  const img = paint(14, 14, MAGENTA, [[3, 3, 8, 8, tinted], [4, 4, 6, 6, GREEN], [6, 6, 2, 2, tinted]]);
  const { image, facts } = keyOut(img, "#ff00ff", { tolerance: 20 });
  const rim = px(image, 3, 7);
  const inside = px(image, 6, 7);
  assert.ok(rim[3] > 0 && rim[3] < 255, `the rim pixel is softened, got alpha ${rim[3]}`);
  assert.equal(inside[3], 255, "the same colour inside the subject stays opaque");
  assert.deepEqual(inside.slice(0, 3), tinted.slice(0, 3), "and its colour is not touched");
  assert.ok(facts.rimSoftened >= 28, `the ring around the subject was softened, got ${facts.rimSoftened}`);
  assert.ok(facts.rimDelta > facts.interiorDelta * 0.5, `after the pass the rim is no longer far closer to the key than the inside (rim ${facts.rimDelta}, inside ${facts.interiorDelta})`);
});

test("the real model output keys cleanly: the cat stays, the magenta goes, and nothing touches the edge", async () => {
  const cat = decodeJPEG(await readFile(path.join(fixtures, "cat-256.jpg")));
  const { image, facts } = keyOut(cat, "#ff00ff", { tolerance: 30 });
  assert.ok(facts.background > 0.3 && facts.background < 0.95, `background share ${facts.background}`);
  assert.ok(facts.fringe < 0.03, `fringe ${facts.fringe} should be a thin edge, not a halo`);
  assert.ok(facts.residue < 0.05, `key residue inside the subject ${facts.residue}`);
  assert.deepEqual(facts.touchesEdge, { top: false, left: false, bottom: false, right: false });
  assert.equal(px(image, 2, 2)[3], 0, "a corner is transparent");
  assert.equal(px(image, 128, 128)[3], 255, "the centre is the cat");
  assert.ok(facts.bounds.width > 100 && facts.bounds.height > 100);
});

test("trim crops to the subject with transparent padding, and bounds know an empty image", () => {
  const img = keyOut(paint(20, 20, MAGENTA, [[5, 5, 10, 10, GREEN]]), "#ff00ff").image;
  const t = trim(img, { padding: 2 });
  assert.equal(t.width, 14);
  assert.equal(t.height, 14);
  assert.equal(px(t, 0, 0)[3], 0);
  assert.deepEqual(px(t, 2, 2), GREEN);
  assert.equal(alphaBounds(paint(4, 4, [0, 0, 0, 0])), null);
  assert.equal(trim(paint(4, 4, [0, 0, 0, 0])).width, 4, "an empty image is left alone");
  assert.deepEqual(px(crop(img, -1, -1, 3, 3), 0, 0), [0, 0, 0, 0], "cropping past the edge reads transparent");
});

test("resizing: nearest keeps pixels crisp, box averages, and transparent neighbours never darken an edge", () => {
  const checker = paint(2, 2, [255, 255, 255, 255], [[0, 0, 1, 1, [0, 0, 0, 255]], [1, 1, 1, 1, [0, 0, 0, 255]]]);
  const big = resize(checker, 8, 8, { filter: "nearest" });
  assert.deepEqual(px(big, 1, 1), [0, 0, 0, 255]);
  assert.deepEqual(px(big, 5, 1), [255, 255, 255, 255]);
  assert.equal(colorCount(big), 2, "nearest invents no colours");

  const halves = paint(4, 4, [255, 255, 255, 255], [[0, 0, 2, 4, [0, 0, 0, 255]]]);
  const two = resize(halves, 2, 1, { filter: "box" });
  assert.deepEqual(px(two, 0, 0).slice(0, 3), [0, 0, 0]);
  assert.deepEqual(px(two, 1, 0).slice(0, 3), [255, 255, 255]);
  const one = resize(halves, 1, 1, { filter: "box" });
  assert.ok(Math.abs(px(one, 0, 0)[0] - 128) <= 1, `a half black, half white image averages to mid grey, got ${px(one, 0, 0)[0]}`);

  const redAndClear = paint(2, 1, [0, 0, 0, 0], [[0, 0, 1, 1, [220, 30, 30, 255]]]);
  const merged = resize(redAndClear, 1, 1, { filter: "box" });
  assert.deepEqual(px(merged, 0, 0).slice(0, 3), [220, 30, 30], "the transparent pixel's black does not bleed into the red");
  assert.ok(Math.abs(px(merged, 0, 0)[3] - 128) <= 1);

  const up = resize(halves, 8, 8, { filter: "auto" });
  assert.equal(up.width, 8);
  assert.ok(px(up, 3, 0)[0] > 0 && px(up, 3, 0)[0] < 255, "enlarging blends across the boundary");
  assert.equal(resize(halves, 4, 4), halves, "the same size is the same image");
});

test("fitInto keeps proportions on an exact canvas, centred or standing on the floor", () => {
  const wide = paint(100, 50, BLUE);
  const centred = fitInto(wide, 64, 64);
  assert.equal(centred.width, 64);
  assert.equal(centred.height, 64);
  assert.equal(px(centred, 32, 10)[3], 0, "above the content is transparent");
  assert.equal(px(centred, 32, 32)[3], 255);
  assert.equal(px(centred, 32, 54)[3], 0);
  const floored = fitInto(wide, 64, 64, { align: "bottom" });
  assert.equal(px(floored, 32, 63)[3], 255, "bottom-aligned content reaches the floor");
  assert.equal(px(floored, 32, 20)[3], 0);
});

test("flattening onto a colour blends by alpha", () => {
  const img = paint(2, 1, [0, 0, 0, 0], [[0, 0, 1, 1, [255, 255, 255, 128]]]);
  const flat = fillBackground(img, "#000000");
  assert.deepEqual(px(flat, 1, 0), [0, 0, 0, 255]);
  assert.ok(Math.abs(px(flat, 0, 0)[0] - 128) <= 1);
});

test("quantising maps to a given palette and reports how far the image had drifted from it", () => {
  const near = paint(4, 4, [252, 4, 4, 255], [[0, 0, 2, 4, [4, 6, 250, 255]]]);
  const { image, palette, drift } = quantize(near, { palette: ["#ff0000", "#0000ff", "#00ff00"] });
  assert.deepEqual(palette, ["#ff0000", "#0000ff", "#00ff00"]);
  assert.deepEqual(px(image, 3, 0).slice(0, 3), [255, 0, 0]);
  assert.deepEqual(px(image, 0, 0).slice(0, 3), [0, 0, 255]);
  assert.ok(drift.mean > 0 && drift.mean < 5, `a hair of drift, got ${drift.mean}`);
  assert.equal(colorCount(image), 2);

  const four = paint(8, 8, [0, 0, 0, 255], [[4, 0, 4, 4, [255, 0, 0, 255]], [0, 4, 4, 4, [0, 255, 0, 255]], [4, 4, 4, 4, [0, 0, 255, 255]]]);
  const found = quantize(four, { count: 4 });
  assert.equal(found.palette.length, 4);
  assert.equal(colorCount(found.image), 4, "median cut finds the four colours");
  assert.equal(found.drift.max, 0, "already on its own palette");
  assert.deepEqual(medianCut([], 4), []);
});

test("grid adherence tells real pixel art from art that only looks like it", () => {
  const onGrid = resize(paint(4, 4, [255, 255, 255, 255], [[0, 0, 2, 2, [0, 0, 0, 255]], [2, 2, 2, 2, [40, 90, 200, 255]]]), 32, 32, { filter: "nearest" });
  assert.equal(gridAdherence(onGrid, 8).share, 1);
  // Every seventh pixel pushed 90 levels the other way, so light and dark cells alike break.
  const noisy = { ...onGrid, data: new Uint8Array(onGrid.data) };
  for (let i = 0; i < noisy.data.length; i += 4) if (i % 28 === 0) noisy.data[i] = noisy.data[i] > 127 ? noisy.data[i] - 90 : noisy.data[i] + 90;
  assert.ok(gridAdherence(noisy, 8).share < 0.25, `noise within cells breaks the grid, got ${gridAdherence(noisy, 8).share}`);
});
