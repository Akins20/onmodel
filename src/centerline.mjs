/**
 * Centre lines: the parts of a colour layer that are no wider than a stroke, traced as
 * stroked lines down their middle instead of as a filled outline.
 *
 * A filled outline is the wrong shape for line art. A 2 px pen stroke traced as a filled
 * region becomes a long thin loop: twice the points, and it stops being a line you can
 * restyle, rescale or give a different weight. Traced down the middle it is one open path
 * with a stroke width, which is what the drawing actually was.
 *
 * The steps, each a published algorithm:
 *   1. Distance. A chamfer 3-4 distance transform (Borgefors) gives every pixel of the
 *      layer its distance to the nearest pixel outside it, in thirds of a pixel.
 *   2. Width. An 8-connected piece whose widest point is within the stroke width is a
 *      line; anything wider stays a filled area.
 *   3. Skeleton. The piece is thinned to one pixel wide (Zhang-Suen).
 *   4. Graph. Runs of skeleton pixels between ends and junctions become polylines through
 *      the pixel centres, with touching junction pixels merged into one node, short spurs
 *      left by thinning pruned, and a node left with two runs joined back together.
 *   5. Width again. The stroke width is the piece's pixel count over the polyline length.
 *
 * Everything here works on typed arrays and plain `[x, y]` points, so the fitting stays
 * in vector.mjs where the curve helpers live.
 */

const AROUND = [
  [-1, -1],
  [0, -1],
  [1, -1],
  [-1, 0],
  [1, 0],
  [-1, 1],
  [0, 1],
  [1, 1],
];

/** Zhang-Suen's P2..P9: the 8 neighbours clockwise from north. */
const RING = [
  [0, -1],
  [1, -1],
  [1, 0],
  [1, 1],
  [0, 1],
  [-1, 1],
  [-1, 0],
  [-1, -1],
];

const BIG = 1 << 28;

/**
 * Distance from each set pixel to the nearest clear one, in thirds of a pixel: an
 * orthogonal step costs 3 and a diagonal 4, which approximates the true distance to
 * within about 2 percent. Outside the image counts as clear, so a line along the edge
 * is still measured as a line. Two passes, forward then backward.
 */
export function chamfer34(mask, width, height) {
  const d = new Int32Array(width * height);
  for (let i = 0; i < d.length; i++) d[i] = mask[i] ? BIG : 0;
  const edge = (x, y) => x < 0 || y < 0 || x >= width || y >= height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!d[i]) continue;
      let best = d[i];
      for (const [dx, dy, cost] of [
        [-1, -1, 4],
        [0, -1, 3],
        [1, -1, 4],
        [-1, 0, 3],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        const v = edge(nx, ny) ? 0 : d[ny * width + nx];
        if (v + cost < best) best = v + cost;
      }
      d[i] = best;
    }
  }
  for (let y = height - 1; y >= 0; y--) {
    for (let x = width - 1; x >= 0; x--) {
      const i = y * width + x;
      if (!d[i]) continue;
      let best = d[i];
      for (const [dx, dy, cost] of [
        [1, 1, 4],
        [0, 1, 3],
        [-1, 1, 4],
        [1, 0, 3],
      ]) {
        const nx = x + dx;
        const ny = y + dy;
        const v = edge(nx, ny) ? 0 : d[ny * width + nx];
        if (v + cost < best) best = v + cost;
      }
      d[i] = best;
    }
  }
  return d;
}

/** The 8-connected pieces of a mask, each as a list of pixel indices. */
export function components8(mask, width, height) {
  const seen = new Uint8Array(width * height);
  const out = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || seen[start]) continue;
    const comp = [];
    seen[start] = 1;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop();
      comp.push(i);
      const x = i % width;
      const y = (i - x) / width;
      for (const [dx, dy] of AROUND) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const j = ny * width + nx;
        if (mask[j] && !seen[j]) {
          seen[j] = 1;
          stack.push(j);
        }
      }
    }
    out.push(comp);
  }
  return out;
}

/**
 * Zhang-Suen thinning: a mask reduced to a one-pixel-wide skeleton that keeps the
 * shape's connectivity. Each pass marks every pixel it may delete and deletes them
 * together, which is the published algorithm; the two sub-passes alternate which side
 * they erode so the result stays centred. It runs until a pass changes nothing.
 */
export function thin(mask, width, height) {
  const skel = new Uint8Array(width * height);
  for (let i = 0; i < skel.length; i++) skel[i] = mask[i] ? 1 : 0;
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : skel[y * width + x]);
  const doomed = [];
  for (let guard = 0; guard < width * height; guard++) {
    let changed = false;
    for (let step = 0; step < 2; step++) {
      doomed.length = 0;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const i = y * width + x;
          if (!skel[i]) continue;
          const p = RING.map(([dx, dy]) => at(x + dx, y + dy));
          let b = 0;
          for (const v of p) b += v;
          if (b < 2 || b > 6) continue;
          let a = 0;
          for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++;
          if (a !== 1) continue;
          // p[0] north, p[2] east, p[4] south, p[6] west
          const ok =
            step === 0
              ? p[0] * p[2] * p[4] === 0 && p[2] * p[4] * p[6] === 0
              : p[0] * p[2] * p[6] === 0 && p[0] * p[4] * p[6] === 0;
          if (ok) doomed.push(i);
        }
      }
      if (doomed.length) {
        for (const i of doomed) skel[i] = 0;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return skel;
}

/**
 * How many separate lines leave a pixel: the number of 8-connected groups among its set
 * neighbours, not how many neighbours it has.
 *
 * Counting neighbours makes every staircase corner look like a junction. On a one-pixel
 * rectangle outline the pixel just right of a corner has three neighbours, because it
 * touches the one below the corner diagonally, so a plain square outline came apart into
 * eight runs instead of one ring. Those two neighbours touch each other, so they are one
 * line continuing through, which is what grouping them counts.
 */
function branchMap(skel, width, height) {
  const branch = new Uint8Array(width * height);
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : skel[y * width + x]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (!skel[i]) continue;
      // The crossing number: how many times the ring of neighbours turns on as it is
      // walked once round. Grouping the neighbours by whether they touch each other does
      // not work, because north and east touch, so a plus would count as one line.
      const p = RING.map(([dx, dy]) => at(x + dx, y + dy));
      let a = 0;
      for (let k = 0; k < 8; k++) if (!p[k] && p[(k + 1) % 8]) a++;
      branch[i] = a;
    }
  }
  return branch;
}

/**
 * The skeleton as polylines through pixel centres.
 *
 * A pixel with two neighbours is in the middle of a run; anything else is a node, either
 * an end (one neighbour, or none at all) or a junction (three or more). Junction pixels
 * that touch each other are one node, because thinning leaves a little clump where lines
 * meet rather than a single pixel. Runs are walked from node to node. A piece that is all
 * middle, with no node anywhere, is a closed ring.
 *
 * Thinning also leaves short spurs sticking out of junctions, which would be drawn as
 * real whiskers; a run that dead-ends at an end and is shorter than `minSpur` is dropped,
 * and when that leaves a junction with exactly two runs they are joined into one, since it
 * is no longer a junction.
 */
export function skeletonPolylines(skel, width, height, { minSpur = 3 } = {}) {
  const deg = branchMap(skel, width, height);
  const isNode = new Uint8Array(width * height);
  for (let i = 0; i < skel.length; i++) if (skel[i] && deg[i] !== 2) isNode[i] = 1;

  // Touching junction pixels become one node, named by the lowest index in the clump.
  const clump = new Int32Array(width * height).fill(-1);
  const junction = new Uint8Array(width * height);
  for (let i = 0; i < skel.length; i++) if (skel[i] && deg[i] >= 3) junction[i] = 1;
  for (const comp of components8(junction, width, height)) {
    const id = Math.min(...comp);
    for (const i of comp) clump[i] = id;
  }
  const nodeId = (i) => (clump[i] >= 0 ? clump[i] : i);

  const neighbours = (i) => {
    const x = i % width;
    const y = (i - x) / width;
    const out = [];
    for (const [dx, dy] of AROUND) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const j = ny * width + nx;
      if (skel[j]) out.push(j);
    }
    return out;
  };

  /**
   * The next pixel along a run, leaving `cur` without going back to `prev`.
   *
   * A step straight up, down, left or right is taken before a diagonal one. Without that
   * rule the walk cuts the corner: next to the centre of a plus, the pixel below the top
   * arm touches both the centre and the left arm diagonally, so the walk would hop around
   * the junction into the left arm and report one long line through a crossing that is
   * really four. The same hop sends a walk back down a rectangle's top edge instead of
   * turning the corner.
   */
  const nextStep = (cur, prev) => {
    const cx = cur % width;
    const cy = (cur - cx) / width;
    let best;
    let bestScore = 9;
    for (const j of neighbours(cur)) {
      if (j === prev) continue;
      const jx = j % width;
      const jy = (j - jx) / width;
      const score = Math.abs(jx - cx) + Math.abs(jy - cy) === 1 ? 0 : 1;
      if (score < bestScore) {
        bestScore = score;
        best = j;
      }
    }
    return best;
  };

  const runs = [];
  const walked = new Set();
  for (let start = 0; start < skel.length; start++) {
    if (!skel[start] || !isNode[start]) continue;
    for (const first of neighbours(start)) {
      // Inside one junction clump there is nothing to walk.
      if (clump[start] >= 0 && clump[first] === clump[start]) continue;
      const key = `${start}>${first}`;
      if (walked.has(key)) continue;
      const path = [start];
      let prev = start;
      let cur = first;
      for (let guard = 0; guard <= skel.length; guard++) {
        path.push(cur);
        if (isNode[cur]) break;
        const next = nextStep(cur, prev);
        if (next === undefined) break;
        prev = cur;
        cur = next;
      }
      const end = path[path.length - 1];
      walked.add(key);
      walked.add(`${end}>${path[path.length - 2]}`);
      runs.push({ pixels: path, a: nodeId(start), b: nodeId(end), closed: false });
    }
  }

  // A piece with no node at all is a ring: walk it from any pixel back to itself.
  const inRun = new Uint8Array(width * height);
  for (const r of runs) for (const i of r.pixels) inRun[i] = 1;
  const ringSeed = new Uint8Array(width * height);
  // Only a run-of-the-middle pixel can be part of a ring. A node left over is already
  // accounted for by the runs that end on it: the centre of a junction clump belongs to
  // no run, and without this it would be walked again as a ring of its own.
  for (let i = 0; i < skel.length; i++) if (skel[i] && !inRun[i] && !isNode[i]) ringSeed[i] = 1;
  for (const comp of components8(ringSeed, width, height)) {
    const start = comp[0];
    const ns = neighbours(start);
    if (!ns.length) continue;
    const path = [start];
    let prev = start;
    let cur = ns[0];
    for (let guard = 0; guard <= comp.length + 1; guard++) {
      path.push(cur);
      if (cur === start) break;
      const next = nextStep(cur, prev);
      if (next === undefined) break;
      prev = cur;
      cur = next;
    }
    runs.push({ pixels: path, a: start, b: start, closed: path[path.length - 1] === start });
  }

  return prune(runs, deg, minSpur);
}

/** Drops the short whiskers thinning leaves, then joins a node left with two runs. */
function prune(runs, deg, minSpur) {
  let live = runs.filter((r) => r.pixels.length > 1);
  for (let pass = 0; pass < 8; pass++) {
    const count = new Map();
    for (const r of live) {
      if (r.closed) continue;
      count.set(r.a, (count.get(r.a) ?? 0) + 1);
      count.set(r.b, (count.get(r.b) ?? 0) + 1);
    }
    const spur = live.findIndex((r) => {
      if (r.closed || r.pixels.length > minSpur) return false;
      const aEnd = (count.get(r.a) ?? 0) === 1;
      const bEnd = (count.get(r.b) ?? 0) === 1;
      // A whisker hangs off a junction at one end and stops dead at the other.
      return (aEnd && !bEnd) || (bEnd && !aEnd);
    });
    if (spur < 0) break;
    live.splice(spur, 1);
  }
  for (let pass = 0; pass < 64; pass++) {
    const byNode = new Map();
    for (const r of live) {
      if (r.closed) continue;
      for (const n of [r.a, r.b]) {
        if (!byNode.has(n)) byNode.set(n, []);
        byNode.get(n).push(r);
      }
    }
    let joined = false;
    for (const [node, rs] of byNode) {
      if (rs.length !== 2 || rs[0] === rs[1]) continue;
      if (deg[node] < 3) continue;
      const [p, q] = rs;
      const pp = p.b === node ? p.pixels : [...p.pixels].reverse();
      const qq = q.a === node ? q.pixels : [...q.pixels].reverse();
      const merged = {
        pixels: [...pp, ...qq.slice(1)],
        a: p.b === node ? p.a : p.b,
        b: q.a === node ? q.b : q.a,
        closed: false,
      };
      live = live.filter((r) => r !== p && r !== q);
      merged.closed = merged.a === merged.b;
      live.push(merged);
      joined = true;
      break;
    }
    if (!joined) break;
  }
  return live;
}

/** The arc length of a polyline of `[x, y]` points. */
export function polylineLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return total;
}

/**
 * The centre lines of one label: every 8-connected piece of it no wider than `maxWidth`
 * pixels, as polylines through pixel centres with the width to stroke them with, plus the
 * pixels those pieces cover so the filled layer can leave them out.
 *
 * A piece is measured by its widest point, so a label that is mostly a broad shape with a
 * thin tail stays filled: it is one piece, and the broad part rules. Pieces are judged
 * whole because a stroke has one width, and splitting a shape into stroked and filled
 * parts would show a seam where they meet.
 */
export function strokeLines(labels, width, height, label, { maxWidth = 3, minSpur = 3 } = {}) {
  const covered = new Uint8Array(width * height);
  const lines = [];
  if (width <= 0 || height <= 0 || labels.length !== width * height) return { covered, lines };
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i++) mask[i] = labels[i] === label ? 1 : 0;
  const dt = chamfer34(mask, width, height);

  for (const comp of components8(mask, width, height)) {
    let far = 0;
    for (const i of comp) if (dt[i] > far) far = dt[i];
    // dt is in thirds of a pixel and measures the middle of the piece, so twice it less
    // one is how wide the piece is at its widest.
    const widest = (2 * far) / 3 - 1;
    if (widest > maxWidth) continue;

    const piece = new Uint8Array(width * height);
    for (const i of comp) piece[i] = 1;
    const skel = thin(piece, width, height);
    const runs = skeletonPolylines(skel, width, height, { minSpur });
    if (!runs.length) continue;

    const polys = runs.map((r) => ({
      points: r.pixels.map((i) => [(i % width) + 0.5, Math.floor(i / width) + 0.5]),
      closed: r.closed,
    }));
    const total = polys.reduce((s, p) => s + polylineLength(p.points), 0);
    if (total < 1) continue;
    // One width for the whole piece, read off the distance transform along the skeleton:
    // twice the distance to the outside, less one, is how wide the shape is there, and the
    // mean of that is the stroke. Area over length would do instead, but thinning eats a
    // few pixels off each end of the skeleton, and a length short by that much reports a
    // 3 px bar as nearly 4. Per run would make a cross's arms disagree where they meet.
    let sum = 0;
    let n = 0;
    for (const i of comp) {
      if (!skel[i]) continue;
      sum += Math.max(0, (2 * dt[i]) / 3 - 1);
      n++;
    }
    const stroke = Math.max(0.5, n ? sum / n : comp.length / total);

    for (const i of comp) covered[i] = 1;
    for (const p of polys) {
      if (p.points.length < 2) continue;
      lines.push({ points: p.points, closed: p.closed, width: stroke, pixels: comp.length });
    }
  }
  return { covered, lines };
}
