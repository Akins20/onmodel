/**
 * Terrain sets: the 16 or 47 cells a Godot TileMapLayer needs in order to paint a
 * material rather than place tiles.
 *
 * A painter paints one material. Which 47 shapes that material has to take, and which
 * neighbours each of them declares, is arithmetic, and arithmetic is onmodel's half of the
 * deal. The cells are composited from one seamless fill, the peering bits are derived from
 * the shape rather than typed in, and then the thing that matters is measured: the set is
 * laid into a patch of terrain and every edge in it is checked to line up exactly. A terrain
 * set that is one bit wrong looks fine in the editor and tears a hole in the map later.
 *
 * The fill must tile, because two cells sitting side by side hold it at the same phase and
 * show it continuing across the join. `onmodel tile` is how you get one.
 */

import { resize } from "./key.mjs";
import { tiled } from "./tile.mjs";

/** Godot's own order for the eight neighbours of a square cell. */
export const NEIGHBOURS = ["right_side", "bottom_right_corner", "bottom_side", "bottom_left_corner", "left_side", "top_left_corner", "top_side", "top_right_corner"];

export const MODES = { sides: 2, both: 0 };

const SIDE_KEYS = ["t", "r", "b", "l"];
/** Each corner and the two sides that have to be present for it to mean anything. */
const CORNERS = [
  { key: "tl", sides: ["t", "l"] },
  { key: "tr", sides: ["t", "r"] },
  { key: "br", sides: ["b", "r"] },
  { key: "bl", sides: ["b", "l"] },
];

/**
 * Every distinct cell the mode needs.
 *
 * Sides alone gives 16, one per combination of four neighbours. Corners AND sides gives
 * 47, not 256: a corner only means anything when both of the sides beside it are already
 * present, since there is no way to reach diagonally past a gap. That reduction is what
 * makes the blob set 47, and the count is worth asserting because getting it wrong is how
 * a set ends up with holes the editor will not warn about.
 */
export function variants(mode = "both") {
  if (!Object.hasOwn(MODES, String(mode))) throw new Error(`terrain mode must be ${Object.keys(MODES).join(" or ")}`);
  const out = [];
  for (let s = 0; s < 16; s++) {
    const sides = { t: Boolean(s & 1), r: Boolean(s & 2), b: Boolean(s & 4), l: Boolean(s & 8) };
    const free = mode === "both" ? CORNERS.filter((c) => c.sides.every((k) => sides[k])) : [];
    for (let c = 0; c < 1 << free.length; c++) {
      const corners = { tl: false, tr: false, br: false, bl: false };
      free.forEach((corner, i) => {
        corners[corner.key] = Boolean(c & (1 << i));
      });
      out.push({ ...sides, ...corners });
    }
  }
  return out;
}

/** The peering bits a cell declares, in the order Godot writes them. */
export function peeringBits(cell, mode = "both") {
  const map = {
    right_side: cell.r,
    bottom_right_corner: mode === "both" && cell.br,
    bottom_side: cell.b,
    bottom_left_corner: mode === "both" && cell.bl,
    left_side: cell.l,
    top_left_corner: mode === "both" && cell.tl,
    top_side: cell.t,
    top_right_corner: mode === "both" && cell.tr,
  };
  return NEIGHBOURS.filter((n) => map[n]);
}

/**
 * The shape the material takes in one cell, as coverage from 0 to 1.
 *
 * The cell is read as nine regions: a centre that is always material, four sides that are
 * material when that neighbour matches, and four corners that are material only when the
 * corner and both of its sides do. Softening it rounds the corners into something that
 * looks drawn rather than cut from graph paper.
 *
 * The softening has to stay inside the margin on purpose. Blur that reaches an edge would
 * change the pixels along it, and two cells that are supposed to butt together would stop
 * matching: the rounding has to happen strictly inside. The blur runs twice, so it reaches
 * twice its radius, and the radius is held to under half the margin; holding it to the
 * margin itself let a requested --round 8 on a 32 px cell break 36 of the 47 cells.
 */
export function cellMask(cell, size, { margin = null, round: rounding = null, mode = "both" } = {}) {
  const { m, r } = cellGeometry(size, { margin, round: rounding });
  return drawMask(cell, size, m, r, mode);
}

const NONE = { t: false, r: false, b: false, l: false, tl: false, tr: false, br: false, bl: false };

/**
 * The margin and the rounding a cell size really gets, once both are made safe.
 *
 * Two limits, both measured rather than assumed. The rounding stays under half the margin
 * so it never reaches an edge. And it must not eat the shape: a wide --margin leaves the
 * centre a small square and each side a thin neck, and rounding that is harmless at the
 * default (a side's middle stays 0.89 covered at 32 px) erased the island's centre and
 * cut 31 cells' sides at a margin of 13. So the rounding steps down until the island keeps
 * its centre and a lone side keeps its middle, which every other cell has more material
 * around than.
 */
export function cellGeometry(size, { margin = null, round: rounding = null } = {}) {
  if (!Number.isInteger(size) || size < 4) throw new Error(`a terrain cell must be a whole number of pixels, 4 or more (got ${size})`);
  for (const [what, v] of [["margin", margin], ["round", rounding]]) if (v != null && (!Number.isInteger(v) || v < 0)) throw new Error(`terrain ${what} must be a whole number of pixels (got ${v})`);
  const m = Math.max(1, Math.min(Math.floor(size / 2) - 1, margin ?? Math.round(size * 0.3)));
  let r = Math.max(0, Math.min(Math.floor((m - 1) / 2), rounding ?? Math.floor(m / 2)));
  const mid = size >> 1;
  const keeps = (rr) => drawMask(NONE, size, m, rr, "both")[mid * size + mid] === 1 && drawMask({ ...NONE, t: true }, size, m, rr, "both")[mid] === 1;
  while (r > 0 && !keeps(r)) r--;
  return { m, r };
}

/** The nine regions for a margin m, softened at radius r and cut at half. */
function drawMask(cell, size, m, r, mode) {
  const zone = (v) => (v < m ? 0 : v < size - m ? 1 : 2);
  const filled = (zx, zy) => {
    if (zx === 1 && zy === 1) return true;
    if (zx === 1) return zy === 0 ? cell.t : cell.b;
    if (zy === 1) return zx === 0 ? cell.l : cell.r;
    const corner = zy === 0 ? (zx === 0 ? "tl" : "tr") : zx === 0 ? "bl" : "br";
    const sides = CORNERS.find((c) => c.key === corner).sides;
    if (!sides.every((k) => cell[k])) return false;
    return mode === "both" ? cell[corner] : true;
  };
  const raw = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) raw[y * size + x] = filled(zone(x), zone(y)) ? 1 : 0;
  if (r < 1) return raw;

  // A box blur run twice, then a half threshold: enough to round a corner without
  // touching the first or last column, which is what keeps the joins exact.
  const pass = (src) => {
    const mid = new Float32Array(size * size);
    const out = new Float32Array(size * size);
    const clamp = (v) => (v < 0 ? 0 : v >= size ? size - 1 : v);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        let t = 0;
        for (let k = -r; k <= r; k++) t += src[y * size + clamp(x + k)];
        mid[y * size + x] = t / (2 * r + 1);
      }
    }
    for (let x = 0; x < size; x++) {
      for (let y = 0; y < size; y++) {
        let t = 0;
        for (let k = -r; k <= r; k++) t += mid[clamp(y + k) * size + x];
        out[y * size + x] = t / (2 * r + 1);
      }
    }
    return out;
  };
  const soft = pass(pass(raw));
  const mask = new Float32Array(size * size);
  for (let i = 0; i < mask.length; i++) mask[i] = soft[i] >= 0.5 ? 1 : 0;
  return mask;
}

/**
 * The fill brought to exactly one cell, wrapping at its edges.
 *
 * Every cell has to hold the WHOLE fill, once. Two cells side by side join the last column
 * of one to the first column of the next, and that is the fill's own wrap join only when a
 * cell holds the fill exactly. Sampling a 64 px fill into 32 px cells took its top-left
 * quarter, so every join in the map joined column 31 to column 0: a seam at every cell,
 * while the fill measured as seamless. Shrinking averages areas, which partitions the fill
 * and so keeps its wrap; enlarging blends neighbours, and at the border the neighbour is
 * the far side of the fill, so it is resized three by three and the middle kept.
 */
export function fitFill(fill, size, { pixel = false } = {}) {
  if (fill.width === size && fill.height === size) return { image: fill, filter: "none" };
  if (pixel) return { image: resize(fill, size, size, { filter: "nearest" }), filter: "nearest" };
  if (size <= fill.width && size <= fill.height) return { image: resize(fill, size, size, { filter: "box" }), filter: "box" };
  const big = resize(tiled(fill, 3), size * 3, size * 3, { filter: "auto" });
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    const from = ((size + y) * big.width + size) * 4;
    data.set(big.data.subarray(from, from + size * 4), y * size * 4);
  }
  return { image: { width: size, height: size, data }, filter: "linear" };
}

/** Where each cell of the mode sits in the atlas, which is all the TileSet and the gate need. */
export function layout(mode = "both", columns = 8) {
  const cells = variants(mode);
  const cols = Math.max(1, Math.min(columns, cells.length));
  return {
    cols,
    rows: Math.ceil(cells.length / cols),
    cells: cells.map((cell, i) => ({ col: i % cols, row: Math.floor(i / cols), cell, bits: peeringBits(cell, mode) })),
  };
}

/**
 * The whole set as one atlas: every cell the mode needs, cut from one seamless fill.
 *
 * Each cell holds the fill at the SAME phase, so two cells laid side by side show the
 * material carrying on across the join rather than restarting. That is also why the fill
 * has to tile: the join between two cells is a join in the fill.
 */
export function terrainAtlas(fill, { mode = "both", size = null, columns = 8, margin = null, round: rounding = null, pixel = false } = {}) {
  const cellSize = size ?? 32;
  if (!Number.isInteger(cellSize) || cellSize < 4) throw new Error(`a terrain cell must be a whole number of pixels, 4 or more (got ${cellSize})`);
  if (!Number.isInteger(columns) || columns < 1) throw new Error(`terrain columns must be a whole number, 1 or more (got ${columns})`);
  const { m, r } = cellGeometry(cellSize, { margin, round: rounding });
  const fitted = fitFill(fill, cellSize, { pixel });
  const tex = fitted.image;
  const { cols, rows, cells: placed } = layout(mode, columns);
  const width = cols * cellSize;
  const height = rows * cellSize;
  const data = new Uint8Array(width * height * 4);
  for (const { col, row, cell } of placed) {
    const mask = drawMask(cell, cellSize, m, r, mode);
    for (let y = 0; y < cellSize; y++) {
      for (let x = 0; x < cellSize; x++) {
        const a = mask[y * cellSize + x];
        if (a <= 0) continue;
        const from = (y * cellSize + x) * 4;
        const to = ((row * cellSize + y) * width + col * cellSize + x) * 4;
        data[to] = tex.data[from];
        data[to + 1] = tex.data[from + 1];
        data[to + 2] = tex.data[from + 2];
        data[to + 3] = Math.round(a * tex.data[from + 3]);
      }
    }
  }
  return { image: { width, height, data }, cells: placed, cellSize, columns: cols, rows, mode, margin: m, round: r, fill: tex, fillFilter: fitted.filter };
}

/**
 * Whether each cell draws the shape its bits declare. The map check cannot see this on its
 * own: every edge of a set of EMPTY cells agrees with every other, and so does every edge
 * of a set flattened to solid squares, so either would pass as perfect.
 *
 * Every cell must have material at its centre, the cell with every neighbour must be
 * material all over, and at the middle of each side and at each corner the material must
 * be there exactly when the bits say a neighbour is. A corner pixel only ever blurs with
 * its own region, so it is exact. A side's middle stays well over half covered at the
 * default margin (0.89 at 32 px); a --margin wide enough to leave the side a thin neck
 * lets the rounding eat through it, and that cell is then reported here as drawn wrong
 * rather than shipped with a side that claims to connect and does not.
 */
export function coverage(atlas) {
  const { image, cells, cellSize, mode } = atlas;
  const solid = (c, x, y) => image.data[((c.row * cellSize + y) * image.width + c.col * cellSize + x) * 4 + 3] >= 128;
  const mid = cellSize >> 1;
  const end = cellSize - 1;
  const hollow = cells.filter((c) => !solid(c, mid, mid)).length;
  const full = cells.find((c) => SIDE_KEYS.every((k) => c.cell[k]) && (mode !== "both" || CORNERS.every((k) => c.cell[k.key])));
  let gaps = full ? 0 : cellSize * cellSize;
  if (full) for (let y = 0; y < cellSize; y++) for (let x = 0; x < cellSize; x++) if (!solid(full, x, y)) gaps++;
  const points = [
    ["t", mid, 0],
    ["r", end, mid],
    ["b", mid, end],
    ["l", 0, mid],
    ["tl", 0, 0],
    ["tr", end, 0],
    ["br", end, end],
    ["bl", 0, end],
  ];
  const wants = (cell, k) => {
    if (k.length === 1) return cell[k];
    const sides = CORNERS.find((c) => c.key === k).sides;
    return sides.every((s) => cell[s]) && (mode === "both" ? cell[k] : true);
  };
  // A side with no neighbour is empty all the way along, corners included, since a corner
  // needs both of its sides; the pair check never sees that edge, because nothing sits there.
  const bare = (c) =>
    SIDE_KEYS.some((k) => {
      if (c.cell[k]) return false;
      for (let i = 0; i < cellSize; i++) {
        const [x, y] = k === "t" ? [i, 0] : k === "b" ? [i, end] : k === "l" ? [0, i] : [end, i];
        if (solid(c, x, y)) return true;
      }
      return false;
    });
  const misdrawn = cells.filter((c) => bare(c) || points.some(([k, x, y]) => solid(c, x, y) !== Boolean(wants(c.cell, k)))).length;
  return { hollow, gaps, misdrawn };
}

/** A seeded patch of terrain, and each square's bits read off it. */
export function sampleMap(mode, { width = 24, height = 24, seed = 12345, density = 0.55 } = {}) {
  let s = seed >>> 0;
  const rnd = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const isT = [];
  for (let y = 0; y < height; y++) {
    isT.push([]);
    for (let x = 0; x < width; x++) isT[y].push(rnd() < density);
  }
  const on = (x, y) => x >= 0 && y >= 0 && x < width && y < height && isT[y][x];
  return { width, height, on, bitsAt: (x, y) => bitsFrom(on, x, y, mode) };
}

/** The bits a square takes from the squares around it: a corner only with both its sides. */
function bitsFrom(on, x, y, mode) {
  const c = { t: on(x, y - 1), r: on(x + 1, y), b: on(x, y + 1), l: on(x - 1, y), tl: false, tr: false, br: false, bl: false };
  if (mode === "both") {
    c.tl = c.t && c.l && on(x - 1, y - 1);
    c.tr = c.t && c.r && on(x + 1, y - 1);
    c.br = c.b && c.r && on(x + 1, y + 1);
    c.bl = c.b && c.l && on(x - 1, y + 1);
  }
  return c;
}

/** The set laid into that patch, which is the only way to see whether it holds together. */
export function renderMap(atlas, options = {}) {
  const { image, cells, cellSize, mode } = atlas;
  const map = sampleMap(mode, options);
  const lookup = new Map(cells.map((c) => [key(c.cell, mode), c]));
  const out = { width: map.width * cellSize, height: map.height * cellSize, data: new Uint8Array(map.width * cellSize * map.height * cellSize * 4) };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (!map.on(x, y)) continue;
      const cell = lookup.get(key(map.bitsAt(x, y), mode));
      if (!cell) continue;
      for (let py = 0; py < cellSize; py++) {
        const from = ((cell.row * cellSize + py) * image.width + cell.col * cellSize) * 4;
        out.data.set(image.data.subarray(from, from + cellSize * 4), ((y * cellSize + py) * out.width + x * cellSize) * 4);
      }
    }
  }
  return out;
}

/**
 * Checks that the set actually fits together: every pair of cells that can EVER sit side
 * by side, and nothing else.
 *
 * Along each such shared edge the SHAPE must agree: where both cells declare that side the
 * material has to be present in both, and where neither does it has to be absent from
 * both. A disagreement is a notch or an overlap that appears wherever that pair comes up.
 *
 * Not every pair of cells: plenty cannot occur together. A cell whose only neighbour is to
 * its right never sits beside one with neighbours above and to its left, so what their
 * shared edge does is nobody's business, and checking it marks a correct set as broken.
 * Not one random map either, which was the second attempt: a 24 by 24 map placed 38 of the
 * 47 cells and never the solid one, so a notch in any of the other nine passed. Which pairs
 * can occur is decided by the squares around them, a window of four by three for two
 * cells side by side and three by four for one above the other, so trying every way to
 * fill those windows finds every pair there is, exactly, in a few thousand tries.
 *
 * The shape is what is checked, not the colour. Two neighbouring cells do not hold the
 * same pixels along their shared edge, they hold CONSECUTIVE ones, because both hold the
 * fill at the same phase and the material carries on across the join. Demanding identical
 * pixels marks every correct pair as broken. Whether the colour carries on is a property
 * of the fill, and `seam` is what measures it.
 */
export function adjacencyReport(atlas) {
  const { image, cells, cellSize, mode } = atlas;
  const lookup = new Map(cells.map((c) => [key(c.cell, mode), c]));
  const at = (c, x, y) => ((c.row * cellSize + y) * image.width + c.col * cellSize + x) * 4;
  const solid = (c, x, y) => image.data[at(c, x, y) + 3] >= 128;
  const seen = new Set();
  const missing = new Set();
  const broken = [];
  let edges = 0;
  let matched = 0;
  for (const across of [true, false]) {
    const W = across ? 4 : 3;
    const H = across ? 3 : 4;
    for (let fill = 0; fill < 1 << (W * H); fill++) {
      const on = (x, y) => x >= 0 && y >= 0 && x < W && y < H && ((fill >> (y * W + x)) & 1) === 1;
      const [bx, by] = across ? [2, 1] : [1, 2];
      if (!on(1, 1) || !on(bx, by)) continue;
      const ka = key(bitsFrom(on, 1, 1, mode), mode);
      const kb = key(bitsFrom(on, bx, by, mode), mode);
      const pair = `${across ? "|" : "/"}${ka}${kb}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const a = lookup.get(ka);
      const b = lookup.get(kb);
      if (!a) missing.add(ka);
      if (!b) missing.add(kb);
      if (!a || !b) continue;
      edges++;
      let ok = true;
      for (let i = 0; i < cellSize && ok; i++) ok = across ? solid(a, cellSize - 1, i) === solid(b, 0, i) : solid(a, i, cellSize - 1) === solid(b, i, 0);
      if (ok) matched++;
      else if (broken.length < 8) broken.push(`${describe(a.cell)} ${across ? "beside" : "over"} ${describe(b.cell)}`);
    }
  }
  return { edges, matched, missing: missing.size, broken, joins: edges ? Math.round((matched / edges) * 1000) / 1000 : 1 };
}

/** Every cell the set needs is one of these; two cells with the same key are the same cell. */
const key = (cell, mode) => (mode === "both" ? `${+cell.t}${+cell.r}${+cell.b}${+cell.l}${+cell.tl}${+cell.tr}${+cell.br}${+cell.bl}` : `${+cell.t}${+cell.r}${+cell.b}${+cell.l}`);

const describe = (cell) => [...SIDE_KEYS, ...CORNERS.map((c) => c.key)].filter((k) => cell[k]).join(" ") || "an island";
