import { contours, polygonArea, coverage } from "./vector.mjs";

/**
 * Collision and occlusion shapes, traced from the art's own silhouette.
 *
 * A game needs to know where a thing is, not just what it looks like, and that shape is
 * already in the picture: it is the edge of what is opaque. onmodel traces contours at
 * sub-pixel precision for the vector work, so the shape comes almost free; what it needs
 * on top is to be made SIMPLE, because a collision polygon with two thousand points is a
 * performance bug wearing the shape of an answer.
 *
 * Simplifying loses area, so the area lost is measured and reported. That is the number
 * that matters: a shape 98% of the art is a good collision body, one at 70% will let
 * things walk through the sprite's feet.
 */

/**
 * Ramer-Douglas-Peucker: drop every point that sits within `tolerance` of the line
 * between the points that would remain. Keeps corners, throws away the stretches
 * between them.
 */
export function simplify(points, tolerance) {
  if (points.length < 3 || tolerance <= 0) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    if (to <= from + 1) continue;
    const [ax, ay] = points[from];
    const [bx, by] = points[to];
    const dx = bx - ax;
    const dy = by - ay;
    const span = Math.hypot(dx, dy);
    let worst = -1;
    let at = -1;
    for (let i = from + 1; i < to; i++) {
      const [px, py] = points[i];
      // Distance to the segment, or to the end point when the segment has no length.
      const d = span < 1e-9 ? Math.hypot(px - ax, py - ay) : Math.abs(dy * px - dx * py + bx * ay - by * ax) / span;
      if (d > worst) {
        worst = d;
        at = i;
      }
    }
    if (worst > tolerance && at > 0) {
      keep[at] = 1;
      stack.push([from, at], [at, to]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/**
 * The outlines of what is opaque, simplified to at most `maxPoints` each.
 *
 * The tolerance is raised until the shape fits the budget rather than the points being
 * truncated, because dropping the tail of a polygon does not simplify it, it tears it.
 * Holes and specks are dropped: a collision body is the thing itself, and a loop smaller
 * than `minArea` is noise in the alpha, not a part of the sprite.
 */
/**
 * What the art encloses, not just what it inks.
 *
 * A body is the region a thing occupies, and for outline art that is the space inside the
 * outline, not the strokes themselves. Without this a drawn mug reported a shape claiming
 * four times its own area as empty, when the shape was right and the measure was wrong.
 * Anything transparent that cannot be reached from outside the picture is inside it.
 */
export function filledMask(image, alphaMin = 128) {
  const { width: w, height: h } = image;
  const solid = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) solid[i] = image.data[i * 4 + 3] >= alphaMin ? 1 : 0;
  const outside = new Uint8Array(w * h);
  const stack = [];
  const push = (x, y) => {
    if (x < 0 || y < 0 || x >= w || y >= h) return;
    const i = y * w + x;
    if (outside[i] || solid[i]) return;
    outside[i] = 1;
    stack.push(i);
  };
  for (let x = 0; x < w; x++) {
    push(x, 0);
    push(x, h - 1);
  }
  for (let y = 0; y < h; y++) {
    push(0, y);
    push(w - 1, y);
  }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w;
    const y = (i - x) / w;
    push(x - 1, y);
    push(x + 1, y);
    push(x, y - 1);
    push(x, y + 1);
  }
  const filled = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) filled[i] = solid[i] || !outside[i] ? 1 : 0;
  return filled;
}

export function silhouettePolygons(image, { alphaMin = 128, maxPoints = 32, minArea = 16, tolerance = 0.75 } = {}) {
  const { width: w, height: h } = image;
  const mask = filledMask(image, alphaMin);
  const field = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) field[i] = mask[i];
  const loops = contours(field, w, h, 0.5).filter((l) => Math.abs(polygonArea(l)) >= minArea);
  // Only the outside of the shape: a hole is a loop wound the other way, and a collision
  // body with a hole in it is a different and much harder thing than a game usually wants.
  const outer = loops.filter((l) => polygonArea(l) > 0);
  const chosen = (outer.length ? outer : loops).sort((a, b) => Math.abs(polygonArea(b)) - Math.abs(polygonArea(a)));
  const out = [];
  for (const loop of chosen) {
    let t = tolerance;
    let simple = simplify(loop, t);
    for (let guard = 0; simple.length > maxPoints && guard < 24; guard++) {
      t *= 1.6;
      simple = simplify(loop, t);
    }
    if (simple.length >= 3) out.push({ points: simple, tolerance: Math.round(t * 100) / 100, from: loop.length });
  }
  return out;
}

/**
 * How well the shape matches the art, by drawing it back.
 *
 * Comparing areas is not enough and quietly flatters a bad shape: simplifying a lumpy
 * sprite cuts the corners off its dents and bridges them, which ADDS as much area as it
 * loses, and a polygon that bulged 16% outside the art reported as though it covered it.
 * So the polygon is rasterised and set against the art pixel by pixel, which separates
 * the two mistakes: `missed` is sprite the shape does not cover, `extra` is empty space
 * it claims. A body that claims empty space makes things collide with nothing.
 */
export function shapeFit(image, polygons, { alphaMin = 128 } = {}) {
  const { width: w, height: h } = image;
  const cov = coverage(polygons.map((p) => p.points), w, h);
  // Against what the art ENCLOSES, for the same reason the polygon is traced from it.
  const mask = filledMask(image, alphaMin);
  let art = 0;
  let both = 0;
  let missed = 0;
  let extra = 0;
  for (let i = 0; i < w * h; i++) {
    const inArt = mask[i] === 1;
    const inShape = cov[i] >= 0.5;
    if (inArt) art++;
    if (inArt && inShape) both++;
    else if (inArt) missed++;
    else if (inShape) extra++;
  }
  const union = both + missed + extra;
  return {
    artPixels: art,
    covers: art ? Math.round((both / art) * 1000) / 1000 : 0,
    missed: art ? Math.round((missed / art) * 1000) / 1000 : 0,
    extra: art ? Math.round((extra / art) * 1000) / 1000 : 0,
    fit: union ? Math.round((both / union) * 1000) / 1000 : 0,
  };
}

const n2 = (v) => {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

/** `PackedVector2Array(x, y, x, y, ...)`, optionally moved so the origin is the centre. */
export function packedVector2(points, { originX = 0, originY = 0 } = {}) {
  return `PackedVector2Array(${points.map(([x, y]) => `${n2(x - originX)}, ${n2(y - originY)}`).join(", ")})`;
}

/**
 * A Godot 4 OccluderPolygon2D, which is what a LightOccluder2D needs to cast a shadow.
 * Taken from what Godot 4.7.2 wrote; `closed` is its default and so is left out.
 */
export function occluderPolygon(points) {
  return [`[gd_resource type="OccluderPolygon2D" format=3]`, "", "[resource]", `polygon = ${packedVector2(points)}`, ""].join("\n");
}
