import { test } from "node:test";
import assert from "node:assert/strict";
import { inkProfile, inkRuns, sliceStrip, sharedScale, placeFrames, mirror } from "../src/strip.mjs";
import { silhouette, iou, normalisePair, dominantPalette, paletteDelta, frameDelta, compareFrame, sequenceSmoothness } from "../src/measure.mjs";
import { packActions, atlasJSON, atlasCSS, atlasHeader } from "../src/atlas.mjs";
import { encodeAPNG, encodeGIF, gifPalette, apngInfo } from "../src/anim.mjs";
import { decodePNG, isPNG } from "../src/png.mjs";

/** A transparent canvas with opaque rectangles painted on it: [x, y, w, h, [r, g, b]]. */
function canvas(width, height, rects) {
  const data = new Uint8Array(width * height * 4);
  for (const [x, y, w, h, c] of rects) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) data.set([c[0], c[1], c[2], 255], (yy * width + xx) * 4);
  return { width, height, data };
}
const alphaAt = (img, x, y) => img.data[(y * img.width + x) * 4 + 3];
const RED = [220, 40, 40];
const BLUE = [40, 60, 220];

test("a strip is sliced where the poses actually are, merged when there are too many pieces, divided when there are too few", () => {
  // Three poses of different heights with gaps of 4, 6 columns between them.
  const strip = canvas(60, 20, [[2, 8, 10, 12, RED], [16, 4, 12, 16, RED], [34, 10, 8, 10, RED]]);
  assert.deepEqual(Array.from(inkProfile(strip).subarray(0, 14)), [0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0]);
  assert.deepEqual(inkRuns(inkProfile(strip)), [[2, 12], [16, 28], [34, 42]]);
  const three = sliceStrip(strip, 3);
  assert.equal(three.method, "gaps");
  assert.equal(three.found, 3);
  assert.deepEqual(three.cells.map((c) => [c.image.width, c.image.height]), [[10, 12], [12, 16], [8, 10]], "each cell is trimmed to its pose");

  const two = sliceStrip(strip, 2);
  assert.equal(two.method, "merged");
  assert.equal(two.cells.length, 2);
  assert.equal(two.cells[0].image.width, 26, "the narrowest gap (4) was closed, joining the first two poses");

  const five = sliceStrip(strip, 5);
  assert.equal(five.method, "equal", "fewer poses than asked: equal division, and the method says so");
  assert.equal(five.cells.length, 5);

  assert.deepEqual(inkRuns(new Uint8Array([1, 1, 0, 1, 1, 0, 0, 0, 1]), { minGap: 2 }), [[0, 5], [8, 9]], "a one-column gap inside a pose is bridged");
});

test("every frame of an action shares one scale and one baseline", () => {
  const short = canvas(10, 10, [[0, 0, 10, 10, RED]]);
  const tall = canvas(10, 20, [[0, 0, 10, 20, RED]]);
  const s = sharedScale([short, tall], { width: 32, height: 32, fill: 0.9 });
  assert.ok(Math.abs(s - 28.8 / 20) < 1e-9, "the scale is set by the tallest frame");
  const [a, b] = placeFrames([short, tall], { width: 32, height: 32, fill: 0.9, anchor: "bottom", filter: "nearest" });
  const bottom = (img) => {
    for (let y = img.height - 1; y >= 0; y--) for (let x = 0; x < img.width; x++) if (alphaAt(img, x, y)) return y;
    return -1;
  };
  const top = (img) => {
    for (let y = 0; y < img.height; y++) for (let x = 0; x < img.width; x++) if (alphaAt(img, x, y)) return y;
    return -1;
  };
  assert.equal(bottom(a), bottom(b), "feet on the same line");
  assert.ok(top(a) > top(b), "the short frame is still short");
  assert.equal(bottom(b) - top(b) + 1, 29, "the tall frame fills 90% of the cell");
  assert.equal(bottom(a) - top(a) + 1, 14, "the short frame is half that, not stretched to fit");
  const [c] = placeFrames([short], { width: 32, height: 32, anchor: "center", filter: "nearest" });
  assert.ok(top(c) > 0 && bottom(c) < 31);
});

test("mirroring flips left to right exactly", () => {
  const img = canvas(4, 1, [[0, 0, 1, 1, RED], [3, 0, 1, 1, BLUE]]);
  const m = mirror(img);
  assert.deepEqual(Array.from(m.data.subarray(0, 3)), BLUE);
  assert.deepEqual(Array.from(m.data.subarray(12, 15)), RED);
});

test("the same shape at any size overlaps completely, a different shape or size or colour is flagged", () => {
  const square = canvas(40, 40, [[10, 10, 20, 20, RED]]);
  const bigSquare = canvas(80, 80, [[10, 10, 60, 60, RED]]);
  const bar = canvas(40, 40, [[10, 10, 20, 8, RED]]);
  const blueSquare = canvas(40, 40, [[10, 10, 20, 20, BLUE]]);

  assert.equal(silhouette(square).area, 400);
  assert.equal(iou(silhouette(square), silhouette(square)), 1);
  const [n1, n2] = normalisePair(square, bigSquare);
  assert.equal(n1.height, n2.height);
  assert.ok(iou(silhouette(n1), silhouette(n2)) > 0.97, "the same shape drawn larger still overlaps once normalised");

  const same = compareFrame(square, { reference: square });
  assert.equal(same.iou, 1);
  assert.equal(same.heightRatio, 1);
  assert.ok(same.paletteDelta < 1);
  assert.deepEqual(same.flags, []);

  const grown = compareFrame(bigSquare, { reference: square });
  assert.ok(grown.flags.includes("size"), `a frame three times as tall is a size drift, got ${grown.flags}`);
  assert.ok(!grown.flags.includes("shape"));

  const reshaped = compareFrame(bar, { reference: square });
  assert.ok(reshaped.iou < 0.5 && reshaped.flags.includes("shape"), `a bar is not a square, iou ${reshaped.iou}`);

  const recoloured = compareFrame(blueSquare, { reference: square });
  assert.ok(recoloured.paletteDelta > 15 && recoloured.flags.includes("colour"), `blue is not red, delta ${recoloured.paletteDelta}`);

  const jumped = compareFrame(square, { previous: bar });
  assert.ok(jumped.flags.includes("jump"));
  assert.equal(frameDelta(square, square), 0);
  assert.ok(frameDelta(square, blueSquare) > 0);
});

test("a sequence reports where it breaks", () => {
  const a = canvas(20, 20, [[5, 5, 10, 10, RED]]);
  const b = canvas(20, 20, [[5, 4, 10, 11, RED]]);
  const c = canvas(20, 20, [[2, 2, 3, 16, RED]]);
  const smooth = sequenceSmoothness([a, b, a]);
  assert.deepEqual(smooth.breaks, []);
  assert.ok(smooth.min > 0.8);
  const broken = sequenceSmoothness([a, b, c, a]);
  assert.deepEqual(broken.breaks, [2, 3], "the odd frame breaks the step into it and the step out of it");
});

test("dominant colours come out most used first and merged", () => {
  const img = canvas(10, 10, [[0, 0, 10, 7, RED], [0, 7, 10, 3, BLUE]]);
  const pal = dominantPalette(img);
  assert.deepEqual(pal[0].color, RED);
  assert.deepEqual(pal[1].color, BLUE);
  assert.ok(pal[0].share > pal[1].share);
  assert.ok(paletteDelta(img, img) < 0.5);
});

test("an atlas lays one action per row and exports what engines read", () => {
  const f = (c) => canvas(8, 8, [[0, 0, 8, 8, c]]);
  const atlas = packActions([
    { name: "idle", frames: [f(RED), f(RED), f(RED)], fps: 4 },
    { name: "walk right", frames: [f(BLUE), f(BLUE)], fps: 8 },
  ]);
  assert.equal(atlas.image.width, 24);
  assert.equal(atlas.image.height, 16);
  assert.deepEqual(atlas.placements.map((p) => [p.name, p.x, p.y]), [["idle_0", 0, 0], ["idle_1", 8, 0], ["idle_2", 16, 0], ["walk right_0", 0, 8], ["walk right_1", 8, 8]]);
  assert.deepEqual(atlas.ranges.map((r) => [r.name, r.from, r.to]), [["idle", 0, 2], ["walk right", 3, 4]]);
  assert.deepEqual(Array.from(atlas.image.data.subarray((8 * 24 + 0) * 4, (8 * 24 + 0) * 4 + 3)), BLUE, "the second row holds the second action");

  const json = atlasJSON(atlas, { file: "player.png" });
  assert.deepEqual(json.frames["idle_1"].frame, { x: 8, y: 0, w: 8, h: 8 });
  assert.equal(json.frames["idle_1"].duration, 250);
  assert.equal(json.meta.image, "player.png");
  assert.deepEqual(json.meta.size, { w: 24, h: 16 });
  assert.deepEqual(json.meta.frameTags[1], { name: "walk right", from: 3, to: 4, direction: "forward", fps: 8 });

  const css = atlasCSS(atlas, { file: "player.png" });
  assert.match(css, /\.om-sprite \{ width: 8px; height: 8px; background: url\("player\.png"\)/);
  assert.match(css, /\.om-idle \{ background-position: 0px 0px; animation: om-idle 0\.75s steps\(3\) infinite; \}/);
  assert.match(css, /@keyframes om-walk-right \{ from \{ background-position: 0px -8px; \} to \{ background-position: -16px -8px; \} \}/);

  const h = atlasHeader(atlas, { file: "player.png" });
  assert.match(h, /static const OmFrame OM_FRAMES\[5\]/);
  assert.match(h, /\{ 8, 8, 8, 8 \}/);
  assert.match(h, /\{ "walk right", 3, 4, 8\.0f \}/);
  assert.match(h, /OM_WALK_RIGHT = 1/);
  assert.match(h, /static inline int om_frame_at/);

  assert.throws(() => packActions([{ name: "x", frames: [f(RED), canvas(4, 4, [])] }]), /every frame must be 8x8/);
});

test("APNG carries every frame with its delay and still opens as a plain PNG", () => {
  const frames = [RED, BLUE, RED].map((c, i) => ({ image: canvas(6, 6, [[i, i, 3, 3, c]]), delayMs: 120 }));
  const apng = encodeAPNG(frames);
  assert.ok(isPNG(apng));
  const first = decodePNG(apng);
  assert.equal(first.width, 6);
  assert.deepEqual(Array.from(first.data.subarray(0, 3)), RED, "a plain decoder sees the first frame");
  assert.deepEqual(apngInfo(apng), { frames: 3, delaysMs: [120, 120, 120] });
});

test("GIF has a palette, one image per frame, transparency and a loop", () => {
  const frames = [RED, BLUE, RED].map((c, i) => ({ image: canvas(6, 6, [[i, i, 3, 3, c]]), delayMs: 100 }));
  const gif = encodeGIF(frames);
  assert.equal(gif.toString("ascii", 0, 6), "GIF89a");
  assert.equal(gif.readUInt16LE(6), 6);
  assert.equal(gif.readUInt16LE(8), 6);
  assert.ok(gif.includes(Buffer.from("NETSCAPE2.0", "ascii")), "it loops");
  let images = 0;
  for (let i = 0; i + 1 < gif.length; i++) if (gif[i] === 0x21 && gif[i + 1] === 0xf9) images++;
  assert.equal(images, 3, "one graphic control block per frame");
  assert.equal(gif[gif.length - 1], 0x3b, "the trailer closes the file");
  const palette = gifPalette(frames);
  assert.deepEqual(palette.sort((a, b) => a[0] - b[0]), [BLUE, RED].sort((a, b) => a[0] - b[0]));

  // More colours than a GIF can hold are reduced to a palette of 255.
  const noisy = { width: 32, height: 32, data: new Uint8Array(32 * 32 * 4) };
  for (let i = 0; i < 32 * 32; i++) noisy.data.set([(i * 7) & 255, (i * 13) & 255, (i * 29) & 255, 255], i * 4);
  assert.ok(gifPalette([{ image: noisy }]).length <= 255);
  assert.doesNotThrow(() => encodeGIF([{ image: noisy, delayMs: 50 }]));
});
