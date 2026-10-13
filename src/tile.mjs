/**
 * Tiles that actually tile.
 *
 * A texture laid out across a floor repeats, and the join is where it gives itself away:
 * the right edge runs into the left, the bottom into the top, and if they do not meet the
 * player sees a grid of seams across the ground. A painter has no way to know that, since
 * it paints one square and never sees it repeated.
 *
 * So the join is measured rather than hoped for. How different the two edges are is
 * compared against how different neighbouring columns are anywhere else in the tile: a
 * texture that already tiles has a join no sharper than its own grain, and one that does
 * not has a join several times sharper. That ratio is the measure, and it does not care
 * how busy or how smooth the texture is.
 *
 * Where the join is too sharp it is closed, by moving both edges to meet in the middle
 * and fading that correction inward over a band. The fix is honest about what it is: it
 * removes the LINE, it cannot make a feature carry on across the join. A brick cut in
 * half is still a brick cut in half, and the report says so rather than calling it fixed.
 */

const at = (image, x, y) => ((y * image.width + x) * 4);

/** Mean absolute difference per channel between two columns, or two rows. */
function edgeDiff(image, aIndex, bIndex, vertical) {
  const n = vertical ? image.height : image.width;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const p = vertical ? at(image, aIndex, i) : at(image, i, aIndex);
    const q = vertical ? at(image, bIndex, i) : at(image, i, bIndex);
    total += Math.abs(image.data[p] - image.data[q]) + Math.abs(image.data[p + 1] - image.data[q + 1]) + Math.abs(image.data[p + 2] - image.data[q + 2]);
  }
  return total / (n * 3);
}

/**
 * How badly the tile shows its join, in both directions.
 *
 * `ratio` is the join against the tile's own grain. At 1 the join is no sharper than any
 * other step across the texture, which is what seamless means; a hard join runs well
 * above that. The grain is taken as the median of the interior steps, not the mean, so
 * one strong edge inside the tile does not excuse a bad join.
 */
export function seam(image) {
  const { width: w, height: h } = image;
  if (w < 4 || h < 4) return { x: 0, y: 0, grainX: 0, grainY: 0, ratioX: 1, ratioY: 1, ratio: 1 };
  const median = (list) => {
    const s = list.slice().sort((a, b) => a - b);
    return s.length ? s[s.length >> 1] : 0;
  };
  const insideX = [];
  for (let x = 0; x < w - 1; x++) insideX.push(edgeDiff(image, x, x + 1, true));
  const insideY = [];
  for (let y = 0; y < h - 1; y++) insideY.push(edgeDiff(image, y, y + 1, false));
  const joinX = edgeDiff(image, w - 1, 0, true);
  const joinY = edgeDiff(image, h - 1, 0, false);
  const grainX = median(insideX);
  const grainY = median(insideY);
  // A flat colour has no grain at all, so any join at all is a seam; the floor keeps the
  // ratio finite without calling a perfect tile broken.
  const r2 = (v) => Math.round(v * 100) / 100;
  const ratioX = joinX <= 0.5 ? 1 : joinX / Math.max(grainX, 0.5);
  const ratioY = joinY <= 0.5 ? 1 : joinY / Math.max(grainY, 0.5);
  return { x: r2(joinX), y: r2(joinY), grainX: r2(grainX), grainY: r2(grainY), ratioX: r2(ratioX), ratioY: r2(ratioY), ratio: r2(Math.max(ratioX, ratioY)) };
}

/**
 * Closes the join. Both edges move to meet halfway and the correction fades to nothing
 * `band` pixels in, so the two sides end up identical where they meet and the middle of
 * the tile is left exactly as it was painted.
 */
export function makeSeamless(image, { band = null } = {}) {
  const { width: w, height: h } = image;
  const out = { width: w, height: h, data: Uint8Array.from(image.data) };
  const bx = Math.max(1, Math.min(Math.floor(w / 2) - 1, band ?? Math.round(w * 0.12)));
  const by = Math.max(1, Math.min(Math.floor(h / 2) - 1, band ?? Math.round(h * 0.12)));
  if (w < 4 || h < 4) return { image: out, band: { x: bx, y: by }, moved: 0, mean: 0 };

  const before = Uint8Array.from(out.data);
  for (let y = 0; y < h; y++) {
    for (let c = 0; c < 3; c++) {
      const delta = out.data[at(out, 0, y) + c] - out.data[at(out, w - 1, y) + c];
      for (let i = 0; i < bx; i++) {
        const weight = 0.5 * (1 - i / bx);
        const left = at(out, i, y) + c;
        const right = at(out, w - 1 - i, y) + c;
        out.data[left] = clamp(out.data[left] - delta * weight);
        out.data[right] = clamp(out.data[right] + delta * weight);
      }
    }
  }
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      const delta = out.data[at(out, x, 0) + c] - out.data[at(out, x, h - 1) + c];
      for (let i = 0; i < by; i++) {
        const weight = 0.5 * (1 - i / by);
        const top = at(out, x, i) + c;
        const bottom = at(out, x, h - 1 - i) + c;
        out.data[top] = clamp(out.data[top] - delta * weight);
        out.data[bottom] = clamp(out.data[bottom] + delta * weight);
      }
    }
  }

  let moved = 0;
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(out.data[i * 4] - before[i * 4]) + Math.abs(out.data[i * 4 + 1] - before[i * 4 + 1]) + Math.abs(out.data[i * 4 + 2] - before[i * 4 + 2]);
    if (d > 2) moved++;
    total += d / 3;
  }
  return { image: out, band: { x: bx, y: by }, moved: Math.round((moved / (w * h)) * 1000) / 1000, mean: Math.round((total / (w * h)) * 100) / 100 };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));

/** The tile laid out `n` by `n`, which is the only way to really see whether it tiles. */
export function tiled(image, n = 3) {
  const { width: w, height: h } = image;
  const out = { width: w * n, height: h * n, data: new Uint8Array(w * n * h * n * 4) };
  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      for (let y = 0; y < h; y++) {
        const from = (y * w) * 4;
        const to = ((ty * h + y) * out.width + tx * w) * 4;
        out.data.set(image.data.subarray(from, from + w * 4), to);
      }
    }
  }
  return out;
}
