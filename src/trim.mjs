/**
 * Trimmed atlases: each frame cut to its own pixels and packed tight, with what every
 * engine needs to put it back exactly where it was in its cell.
 *
 * A sprite cell is mostly air. The character fills a share of it and every frame keeps
 * the same cell so it stands on the same ground line, which is right for drawing and
 * wasteful for a GPU: on a typical set more than two thirds of the atlas is transparent
 * texels that still have to be uploaded and sampled. Cutting each frame to its pixels and
 * recording where they sat keeps the drawing exactly the same and the atlas much smaller.
 *
 * The record is the whole point. A trimmed frame that is put back one pixel off makes the
 * character jitter, and nobody looks at a JSON file to find out why, so the trimmed atlas
 * is restored frame by frame from what was written and compared with the untrimmed cells,
 * pixel for pixel.
 *
 * Two things a naive trim gets wrong. Cut flush to the art, a frame loses the half texel of
 * soft edge that linear filtering used to blend into the empty cell around it, because an
 * engine only draws the trimmed region: the ring of screen pixels just outside it gets
 * nothing. So painted art keeps one transparent texel inside its region; pixel art, drawn
 * with nearest filtering, is cut flush. And frames packed edge to edge bleed into each other
 * under filtering, so they are kept apart by padding.
 */

const blank = (width, height) => ({ width, height, data: new Uint8Array(width * height * 4) });

/** The smallest box holding every pixel at least `alpha` opaque, or null when there is none. */
export function trimBounds(image, alpha = 1) {
  const { width: w, height: h, data } = image;
  let x0 = w;
  let y0 = h;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < alpha) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * Where each frame's pixels are cut from its cell. `margin` keeps that many transparent
 * texels around the art (inside the cell) so filtering still has something to blend into.
 * An empty frame keeps a single transparent texel, since no engine takes a region of
 * nothing, and is marked so a consumer can tell.
 */
export function trimFrames(frames, { alpha = 1, margin = 0 } = {}) {
  return frames.map((f) => {
    const b = trimBounds(f, alpha);
    if (!b) return { x: 0, y: 0, w: 1, h: 1, sourceW: f.width, sourceH: f.height, empty: true };
    const x = Math.max(0, b.x - margin);
    const y = Math.max(0, b.y - margin);
    const x1 = Math.min(f.width, b.x + b.w + margin);
    const y1 = Math.min(f.height, b.y + b.h + margin);
    return { x, y, w: x1 - x, h: y1 - y, sourceW: f.width, sourceH: f.height, empty: false };
  });
}

/**
 * Shelf packing, tallest first, trying atlas widths from the widest frame up and keeping
 * whichever gives the smallest area (the squarer one on a tie). Shelves are simple and on
 * frames of one character, which are all much the same height, they pack within a few
 * percent of anything cleverer. `padding` separates frames from each other and from the
 * atlas edge.
 */
export function packRects(sizes, { padding = 2, maxSide = 8192 } = {}) {
  if (!sizes.length) throw new Error("nothing to pack");
  const order = sizes.map((s, i) => i).sort((a, b) => sizes[b].h - sizes[a].h || sizes[b].w - sizes[a].w || a - b);
  const widest = Math.max(...sizes.map((s) => s.w)) + 2 * padding;
  const area = sizes.reduce((t, s) => t + (s.w + padding) * (s.h + padding), 0);
  const tryWidth = (W) => {
    const at = new Array(sizes.length);
    let x = padding;
    let y = padding;
    let shelf = 0;
    for (const i of order) {
      const s = sizes[i];
      if (x + s.w + padding > W && x > padding) {
        y += shelf + padding;
        x = padding;
        shelf = 0;
      }
      at[i] = { x, y };
      x += s.w + padding;
      if (s.h > shelf) shelf = s.h;
    }
    return { at, width: W, height: y + shelf + padding };
  };
  let best = null;
  const top = Math.min(maxSide, Math.max(widest, Math.ceil(Math.sqrt(area) * 3)));
  const step = Math.max(1, Math.floor((top - widest) / 256));
  for (let W = widest; W <= top; W += step) {
    const got = tryWidth(W);
    // Trim the width to what the shelves actually use.
    let used = 0;
    got.at.forEach((p, i) => {
      if (p.x + sizes[i].w + padding > used) used = p.x + sizes[i].w + padding;
    });
    got.width = used;
    if (got.height > maxSide || got.width > maxSide) continue;
    const a = got.width * got.height;
    const b = best ? best.width * best.height : Infinity;
    if (a < b || (a === b && Math.abs(got.width - got.height) < Math.abs(best.width - best.height))) best = got;
  }
  if (!best) throw new Error(`the trimmed frames do not fit in ${maxSide}x${maxSide}`);
  return best;
}

/**
 * The trimmed atlas for a grid atlas from `packActions`: the same actions, ranges and
 * frame names, each placement now the trimmed region with a `trim` record of where it sat
 * in its cell. The grid itself is kept as `cells`, since a CSS steps() animation needs
 * every frame the same size.
 */
export function trimAtlas(grid, { alpha = 1, margin = 0, padding = 2 } = {}) {
  const { width: fw, height: fh } = grid.frame;
  const cells = grid.placements.map((p) => {
    const cell = blank(fw, fh);
    for (let y = 0; y < fh; y++) cell.data.set(grid.image.data.subarray(((p.y + y) * grid.image.width + p.x) * 4, ((p.y + y) * grid.image.width + p.x + fw) * 4), y * fw * 4);
    return cell;
  });
  const cuts = trimFrames(cells, { alpha, margin });
  const packed = packRects(cuts.map((c) => ({ w: c.w, h: c.h })), { padding });
  const image = blank(packed.width, packed.height);
  const placements = grid.placements.map((p, i) => {
    const c = cuts[i];
    const { x, y } = packed.at[i];
    if (!c.empty) {
      for (let row = 0; row < c.h; row++) {
        const from = ((c.y + row) * fw + c.x) * 4;
        image.data.set(cells[i].data.subarray(from, from + c.w * 4), ((y + row) * image.width + x) * 4);
      }
    }
    return { ...p, x, y, width: c.w, height: c.h, cellX: p.x, cellY: p.y, trim: { x: c.x, y: c.y, sourceW: fw, sourceH: fh, empty: c.empty } };
  });
  return { image, placements, ranges: grid.ranges, frame: grid.frame, columns: grid.columns, rows: grid.rows, cells: grid.image, trimmed: true, padding };
}

/** One frame put back into a cell of its source size, from the atlas and its record. */
export function restoreFrame(image, p) {
  const t = p.trim ?? { x: 0, y: 0, sourceW: p.width, sourceH: p.height };
  const out = blank(t.sourceW, t.sourceH);
  if (t.empty) return out;
  for (let row = 0; row < p.height; row++) {
    const from = ((p.y + row) * image.width + p.x) * 4;
    out.data.set(image.data.subarray(from, from + p.width * 4), ((t.y + row) * t.sourceW + t.x) * 4);
  }
  return out;
}

/**
 * Restores every frame of a trimmed atlas and compares it with its cell in the grid.
 *
 * A pixel the trim was allowed to drop (fainter than `alpha`) is only counted; one at
 * least half opaque that went missing is a real loss, since it is visible art. Anything
 * else that differs means the record does not put the frame back where it was.
 */
export function verifyTrim(image, placements, cells, { alpha = 1 } = {}) {
  let moved = 0;
  let faint = 0;
  let lost = 0;
  const wrong = [];
  for (const p of placements) {
    const t = p.trim;
    if (!t) continue;
    if (p.x < 0 || p.y < 0 || p.x + p.width > image.width || p.y + p.height > image.height || t.x < 0 || t.y < 0 || t.x + p.width > t.sourceW || t.y + p.height > t.sourceH) {
      moved++;
      if (wrong.length < 8) wrong.push(`${p.name} lies outside its atlas or its cell`);
      continue;
    }
    const back = restoreFrame(image, p);
    let bad = 0;
    for (let y = 0; y < t.sourceH; y++) {
      for (let x = 0; x < t.sourceW; x++) {
        const a = ((y * t.sourceW + x) * 4);
        const b = (((p.cellY ?? 0) + y) * cells.width + (p.cellX ?? 0) + x) * 4;
        const want = cells.data[b + 3];
        const got = back.data[a + 3];
        if (got === want && (want === 0 || (back.data[a] === cells.data[b] && back.data[a + 1] === cells.data[b + 1] && back.data[a + 2] === cells.data[b + 2]))) continue;
        // Only a pixel the threshold let go may be missing; it is a loss if it was visible.
        if (got === 0 && want < alpha) {
          if (want >= 128) lost++;
          else faint++;
        } else bad++;
      }
    }
    if (bad) {
      moved++;
      if (wrong.length < 8) wrong.push(`${p.name}: ${bad} pixels come back different from its cell`);
    }
  }
  return { frames: placements.length, moved, faint, lost, wrong, verdict: moved ? "moved" : lost ? "lossy" : "exact" };
}

/**
 * Where a frame stands: the point that stays put from frame to frame, which an engine
 * should treat as the sprite's origin. Frames are placed with one scale and one anchor,
 * so it is the same point for every frame: the middle of the ground line for a bottom
 * anchor, the centre for a centre one, the middle of the top line for a top one.
 */
export function pivotOf(cell, { fill = 0.9, anchor = "bottom" } = {}) {
  const margin = Math.round((cell.height * (1 - fill)) / 2);
  const y = anchor === "bottom" ? cell.height - margin : anchor === "top" ? margin : cell.height / 2;
  return { x: cell.width / 2, y };
}
