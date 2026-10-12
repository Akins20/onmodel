import { test } from "node:test";
import assert from "node:assert/strict";
import { chamfer34, components8, thin, skeletonPolylines, polylineLength, strokeLines } from "../src/centerline.mjs";

/** A mask with the given rectangles set: [x, y, w, h]. */
function mask(width, height, rects) {
  const m = new Uint8Array(width * height);
  for (const [x, y, w, h] of rects) {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) m[yy * width + xx] = 1;
  }
  return m;
}

/** Labels where every set pixel of the mask is `label` and the rest is -1. */
function labelled(m, label = 0) {
  const l = new Int16Array(m.length).fill(-1);
  for (let i = 0; i < m.length; i++) if (m[i]) l[i] = label;
  return l;
}

const widestOf = (dt, m) => {
  let far = 0;
  for (let i = 0; i < m.length; i++) if (m[i] && dt[i] > far) far = dt[i];
  return (2 * far) / 3 - 1;
};

test("the distance transform measures how wide a shape is at its widest", () => {
  // A one-pixel line: every pixel has a clear one straight above it, so one step of 3.
  const line = mask(20, 12, [[2, 5, 10, 1]]);
  assert.equal(widestOf(chamfer34(line, 20, 12), line), 1);

  // A three-pixel bar: the middle row is two orthogonal steps from clear.
  const bar = mask(20, 12, [[2, 4, 10, 3]]);
  assert.equal(widestOf(chamfer34(bar, 20, 12), bar), 3);

  // A block is as wide as it is, so it is nothing like a stroke.
  const block = mask(20, 20, [[5, 5, 10, 10]]);
  assert.ok(widestOf(chamfer34(block, 20, 20), block) >= 8);

  // The image edge counts as outside, so a line along it is still a line.
  const edge = mask(20, 12, [[0, 0, 10, 1]]);
  assert.equal(widestOf(chamfer34(edge, 20, 12), edge), 1);
});

test("pieces are 8-connected, so a diagonal join is one piece", () => {
  const two = mask(12, 12, [[1, 1, 2, 2], [8, 8, 2, 2]]);
  assert.equal(components8(two, 12, 12).length, 2);

  // Touching only at a corner is still one piece.
  const diagonal = mask(12, 12, [[1, 1, 2, 2], [3, 3, 2, 2]]);
  assert.equal(components8(diagonal, 12, 12).length, 1);

  const sizes = components8(two, 12, 12).map((c) => c.length);
  assert.deepEqual(sizes, [4, 4]);
});

test("thinning reduces a bar to one pixel wide and keeps it in one piece", () => {
  const bar = mask(20, 12, [[2, 4, 12, 3]]);
  const skel = thin(bar, 20, 12);
  let before = 0;
  let after = 0;
  for (let i = 0; i < bar.length; i++) {
    if (bar[i]) before++;
    if (skel[i]) after++;
  }
  assert.ok(after < before, "thinning removed pixels");
  assert.equal(components8(skel, 20, 12).length, 1, "and left it connected");

  // One pixel wide means no column of the skeleton holds two set pixels.
  for (let x = 0; x < 20; x++) {
    let col = 0;
    for (let y = 0; y < 12; y++) if (skel[y * 20 + x]) col++;
    assert.ok(col <= 1, `column ${x} is one pixel wide`);
  }

  // A line that is already thin is left alone.
  const line = mask(20, 12, [[2, 5, 10, 1]]);
  assert.deepEqual(Array.from(thin(line, 20, 12)), Array.from(line));
});

test("a straight line is one open run from end to end", () => {
  const line = mask(20, 12, [[2, 5, 10, 1]]);
  const runs = skeletonPolylines(line, 20, 12);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].closed, false);
  assert.equal(runs[0].pixels.length, 10);
});

test("a cross is four arms meeting at one junction", () => {
  const cross = mask(21, 21, [[10, 4, 1, 13], [4, 10, 13, 1]]);
  const runs = skeletonPolylines(thin(cross, 21, 21), 21, 21, { minSpur: 2 });
  assert.equal(runs.length, 4);
  assert.deepEqual(runs.map((r) => r.pixels.length), [7, 7, 7, 7], "each arm runs centre to tip");
  // All four meet at the same node, rather than each arm inventing its own.
  const shared = runs.map((r) => r.a).filter((a) => runs.every((r) => r.a === a || r.b === a));
  assert.ok(shared.length > 0 || new Set(runs.flatMap((r) => [r.a, r.b])).size === 5);

  // Without preferring a straight step over a diagonal one, the walk hops around the
  // junction and reports one long line through a crossing that is really four.
  for (const r of runs) assert.ok(!r.closed);
});

test("a one-pixel rectangle outline is a single closed ring", () => {
  // The 8-connected corner trap: the pixel beside a corner touches the one below it
  // diagonally, which makes a neighbour count call it a junction and breaks the outline
  // into eight pieces. Counted by crossing number it stays one ring.
  const square = new Int16Array(16 * 16).fill(-1);
  for (let x = 3; x < 13; x++) {
    square[3 * 16 + x] = 0;
    square[12 * 16 + x] = 0;
  }
  for (let y = 3; y < 13; y++) {
    square[y * 16 + 3] = 0;
    square[y * 16 + 12] = 0;
  }
  const got = strokeLines(square, 16, 16, 0, { maxWidth: 3 });
  assert.equal(got.lines.length, 1);
  assert.equal(got.lines[0].closed, true);
  // 36 pixels of outline, plus the first point again to close it.
  assert.equal(got.lines[0].points.length, 37);
  assert.ok(Math.abs(got.lines[0].width - 1) < 0.2, `width ${got.lines[0].width}`);
});

test("polyline length is the distance walked, not the pixel count", () => {
  assert.equal(polylineLength([[0, 0], [3, 0], [3, 4]]), 7);
  assert.equal(polylineLength([[0, 0]]), 0);
});

test("a thin shape becomes stroked centre lines, a fat one stays filled", () => {
  const line = labelled(mask(20, 12, [[2, 5, 10, 1]]));
  const got = strokeLines(line, 20, 12, 0, { maxWidth: 3 });
  assert.equal(got.lines.length, 1);
  assert.ok(got.lines[0].width > 0.9 && got.lines[0].width < 1.6, `width ${got.lines[0].width}`);
  // Every pixel of the line is accounted for, so the filled layer leaves it out.
  let covered = 0;
  for (const v of got.covered) if (v) covered++;
  assert.equal(covered, 10);

  // A block is wider than any stroke, so nothing is traced and nothing is claimed.
  const block = labelled(mask(20, 20, [[5, 5, 10, 10]]));
  const fat = strokeLines(block, 20, 20, 0, { maxWidth: 3 });
  assert.equal(fat.lines.length, 0);
  assert.ok(!fat.covered.includes(1));
});

test("a three-pixel stroke reports about three pixels of width", () => {
  const bar = labelled(mask(24, 12, [[2, 4, 18, 3]]));
  const got = strokeLines(bar, 24, 12, 0, { maxWidth: 4 });
  assert.equal(got.lines.length, 1);
  assert.ok(got.lines[0].width > 2.4 && got.lines[0].width < 3.6, `width ${got.lines[0].width}`);
});

test("an empty or mismatched label yields nothing rather than throwing", () => {
  const empty = new Int16Array(100).fill(-1);
  assert.deepEqual(strokeLines(empty, 10, 10, 0, {}).lines, []);
  assert.deepEqual(strokeLines(new Int16Array(4), 10, 10, 0, {}).lines, []);
  assert.deepEqual(strokeLines(new Int16Array(0), 0, 0, 0, {}).lines, []);
});
