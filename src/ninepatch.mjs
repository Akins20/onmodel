/**
 * Nine-patch UI art: the insets that let a panel, button or frame stretch to any size
 * without its corners or border distorting, found from the art itself.
 *
 * A nine-patch stretches the middle band of columns across and the middle band of rows
 * down, and leaves the corners alone. That is only invisible when every column in the
 * band is the same column, so stretching repeats nothing a person could see. Finding the
 * band is therefore a question about the art, not a number to guess: which columns are
 * all the same as the middle one.
 *
 * "The same" is the hard part, because real art is not clean. An anti-aliased edge
 * wobbles by a fraction of a pixel along its length, a generated image carries JPEG
 * noise, and demanding exact equality (or a tolerance taken from how much a row varies)
 * finds bands a few pixels wide in a panel that plainly stretches. Two things make the
 * test fair. The difference from the middle column is averaged over a pixel either way
 * first, which cancels noise and keeps anything two or three pixels across. And a row's
 * tolerance grows with how sharp an edge runs through it, because a sub-pixel shift of an
 * edge is the wobble of an outline, not detail; a flat row keeps a tight tolerance, so a
 * dot painted on a plain fill is still caught. Outside the image counts as clear, so the
 * art's own outer edge is an edge like any other.
 *
 * And the band has to hold the middle. A centred emblem splits the plain fill into a run
 * on either side of it; taking one run would leave the emblem in a fixed corner and push
 * it off centre as the panel grows, so that axis is reported as not stretchable instead.
 */

const premul = (data, p) => {
  const a = data[p + 3];
  return [(data[p] * a) / 255, (data[p + 1] * a) / 255, (data[p + 2] * a) / 255, a];
};

const median = (list) => {
  if (!list.length) return 0;
  const s = Float64Array.from(list).sort();
  return s[s.length >> 1];
};

/**
 * Art drawn with hard edges and no noise: every pixel clear or solid, and neighbouring pixels
 * either equal or plainly different, either way. Pixel art and flat vector-style UI are like this,
 * and for them "alike" can simply mean "the same", which is exact at any size, down to a 3x3 frame.
 * A gentle gradient steps by a level or two at a time; on a big panel those steps are rare, so the
 * bar for them is a thousandth of all neighbour pairs, not a hundredth.
 */
export function isCrisp(image) {
  const { width: W, height: H, data } = image;
  let soft = 0;
  let near = 0;
  let pairs = 0;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 4;
      const a = data[p + 3];
      if (a !== 0 && a !== 255) soft++;
      for (const q of [x + 1 < W ? p + 4 : -1, y + 1 < H ? p + W * 4 : -1]) {
        if (q < 0 || a !== 255 || data[q + 3] !== 255) continue;
        const d = Math.max(Math.abs(data[p] - data[q]), Math.abs(data[p + 1] - data[q + 1]), Math.abs(data[p + 2] - data[q + 2]));
        pairs++;
        if (d > 0 && d <= 6) near++;
      }
    }
  }
  return soft <= W * H * 0.005 && near <= pairs * 0.001;
}

const runLength = (r) => (r ? r[1] - r[0] : 0);

/**
 * Which run of alike lines is the band. `runs` are [start, end, class]: lines of one class are
 * alike. `beyond(run, side)` counts the layers of art between a run and the edge on that side.
 *
 * The run holding the middle is the band, unless the middle is part of a feature:
 * - the band's own line carries on past a short interruption (a dot or a word inside one plain
 *   fill), or past something on both sides (the gap between two words of a label holding the
 *   middle): stretching would pull the feature apart or off centre;
 * - in crisp art, the band sits inside a run of one other line on both sides that itself has more
 *   frame beyond it: a shape inside a plain fill, such as an emblem whose middle rows match. A
 *   thick frame round a small fill has the same shape, so the difference is whether anything but
 *   an outline lies beyond the surrounding run;
 * - no run holds the middle, and the plain line lies on both sides of it.
 * Runs of one or two lines are blips (a JPEG ringing column, a stray matching line by a corner)
 * and decide nothing.
 */
function chooseRun(runs, N, { crisp = false, beyond = () => 0 } = {}) {
  const centre = Math.floor(N / 2);
  const holding = runs.find(([s, e]) => s <= centre && centre < e) ?? null;
  const big = runs.filter((r) => runLength(r) >= 3 || r === holding);
  const interrupted = (a, b) => b[0] - a[1] > 0 && b[0] - a[1] <= 1.5 * Math.min(runLength(a), runLength(b));
  const split = (gap) => ({ run: null, split: true, gap });
  // In soft art every alike run is alike to the one plain line, so three or more of them apart are
  // a repeating pattern (bands, a grain at one phase), not one feature: no band, and nothing for the
  // other axis to avoid.
  if (!crisp && big.filter((r) => runLength(r) >= 3).length >= 3) return { run: null, split: false };
  if (holding) {
    // A middle whose own line comes back close by is a pattern (a dither, fine stripes or bands),
    // which would have to tile: no band, and not a feature either.
    // Only crisp art has lines to compare like this; soft runs are all one class by construction.
    if (crisp) {
      const repeats = runs.filter((r) => r !== holding && r[2] === holding[2] && Math.min(Math.abs(r[0] - holding[1]), Math.abs(holding[0] - r[1])) <= Math.max(3, 2 * runLength(holding)));
      if (runLength(holding) <= 2 && repeats.length) return { run: null, split: false };
      if (repeats.some((r) => r[1] <= holding[0]) && repeats.some((r) => r[0] >= holding[1])) return { run: null, split: false };
    }
    const same = big.filter((r) => r !== holding && r[2] === holding[2]);
    const before = same.filter((r) => r[1] <= holding[0]).pop();
    const after = same.find((r) => r[0] >= holding[1]);
    if (before && interrupted(before, holding)) return split([before[1], holding[0]]);
    if (after && interrupted(holding, after)) return split([holding[1], after[0]]);
    if (before && after) return split([before[1], after[0]]);
    if (crisp) {
      const wide = runs.filter((r) => runLength(r) >= 3 && r !== holding);
      const left = wide.filter((r) => r[1] <= holding[0]).pop();
      const right = wide.find((r) => r[0] >= holding[1]);
      // Inside one other line on both sides: a shape in a plain fill (a dot, a tail, an emblem
      // whose middle rows match) when that fill dwarfs it or has more frame beyond it; a thick
      // frame round a small fill has the same shape, but its border is no more than a few times
      // the fill and only an outline lies beyond it.
      const dwarfs = left && right && Math.min(runLength(left), runLength(right)) >= 3 * runLength(holding);
      const framed = left && right && beyond(left, -1) >= 2 && beyond(right, 1) >= 2;
      if (left && right && left[2] === right[2] && left[2] !== holding[2] && (dwarfs || framed)) return split([holding[0], holding[1]]);
    }
    return { run: holding, split: false };
  }
  const left = big.filter((r) => r[1] <= centre).pop();
  const right = big.find((r) => r[0] > centre);
  if (left && right && left[2] === right[2] && (!crisp || interrupted(left, right) || (beyond(left, -1) >= 2 && beyond(right, 1) >= 2))) return split([left[1], right[0]]);
  return { run: null, split: false };
}

/**
 * The stretchable band along one axis: "x" finds columns (stretching across), "y" rows.
 * `window` measures given lines against their own band rather than the plain line of the art.
 * Returns the band, whether a feature splits the middle (and where it lies), which lines are
 * alike, and whether the art was taken as crisp.
 */
export function findBand(image, axis = "x", { window = null, crisp = null } = {}) {
  const { width: W, height: H, data } = image;
  const N = axis === "x" ? W : H;
  const A = axis === "x" ? H : W;
  const at = (i, j) => (axis === "x" ? (j * W + i) * 4 : (i * W + j) * 4);
  const exact = crisp ?? isCrisp(image);
  if (N < 3 && !window) return { start: 0, end: 0, length: 0, split: false, ok: new Array(N).fill(false), crisp: exact };
  const clearLine = (i) => {
    for (let j = 0; j < A; j++) if (data[at(i, j) + 3]) return false;
    return true;
  };

  if (exact) {
    // Crisp art: a line is alike when it is the same line, pixel for pixel (clear is clear,
    // whatever colour a clear pixel happens to carry).
    const same = (i, k) => {
      for (let j = 0; j < A; j++) {
        const p = at(i, j);
        const q = at(k, j);
        if (data[p + 3] === 0 && data[q + 3] === 0) continue;
        if (data[p] !== data[q] || data[p + 1] !== data[q + 1] || data[p + 2] !== data[q + 2] || data[p + 3] !== data[q + 3]) return false;
      }
      return true;
    };
    if (window) {
      const [s, e] = window;
      const ref = Math.floor((s + e - 1) / 2);
      const ok = Array.from({ length: N }, (_, i) => i >= s && i < e && same(i, ref));
      return { start: s, end: e, length: e - s, split: false, ok, crisp: true };
    }
    // Runs of identical neighbouring lines, each its own run (merging two runs of different lines
    // would chain a pixel circle's columns into a band), classed by line so a plain fill broken
    // by a feature is seen as one fill.
    const raw = [];
    for (let i = 0; i < N; ) {
      let k = i + 1;
      while (k < N && same(k, i)) k++;
      raw.push([i, k]);
      i = k;
    }
    const classes = [];
    const runs = raw.map(([s, e]) => {
      let c = classes.findIndex((rep) => same(rep, s));
      if (c < 0) c = classes.push(s) - 1;
      return [s, e, c];
    });
    // Layers of art between a run and the edge: runs of lines that are not wholly clear, so a
    // transparent gutter round the art is not mistaken for frame.
    const beyond = (r, side) => runs.filter((q) => (side < 0 ? q[1] <= r[0] : q[0] >= r[1]) && !clearLine(q[0])).length;
    const ok = new Array(N).fill(false);
    const centre = Math.floor(N / 2);
    for (const [s, e] of raw) if (e - s >= 2 || (s <= centre && centre < e)) for (let i = s; i < e; i++) ok[i] = true;
    const { run, split, gap } = chooseRun(runs, N, { crisp: true, beyond });
    if (!run) return { start: 0, end: 0, length: 0, split, ok, crisp: true, gap: gap ?? null };
    return { start: run[0], end: run[1], length: run[1] - run[0], split: false, ok, crisp: true };
  }

  // Soft art. Every pixel averaged with its 3x3 neighbours once: that cancels noise and keeps
  // anything two or three pixels across, and every comparison below is made on these averages.
  const P = new Float32Array(N * A * 4);
  for (let i = 0; i < N; i++) for (let j = 0; j < A; j++) P.set(premul(data, at(i, j)), (i * A + j) * 4);
  const B = new Float32Array(N * A * 4);
  for (let i = 0; i < N; i++) {
    for (let j = 0; j < A; j++) {
      for (let c = 0; c < 4; c++) {
        let t = 0;
        let n = 0;
        for (let di = -1; di <= 1; di++) {
          const ii = i + di;
          if (ii < 0 || ii >= N) continue;
          for (let dj = -1; dj <= 1; dj++) {
            const jj = j + dj;
            if (jj < 0 || jj >= A) continue;
            t += P[(ii * A + jj) * 4 + c];
            n++;
          }
        }
        B[(i * A + j) * 4 + c] = t / n;
      }
    }
  }
  const from = window ? window[0] : Math.floor(N * 0.2);
  const to = window ? Math.max(window[0] + 1, window[1]) : Math.max(from + 1, Math.ceil(N * 0.8));
  const mid = (from + to - 1) / 2;

  // Noise at the scale of the averages, from averages three lines apart and three pixels apart
  // in the window, the quieter direction kept: that sees JPEG's blotchy noise, which a neighbour
  // difference reads as nothing, while a stripe or grain that runs one way cannot loosen the test.
  const alongD = [];
  const acrossD = [];
  for (let i = from; i < to; i++) {
    for (let j = 0; j < A; j++) {
      for (let c = 0; c < 4; c++) {
        if (i + 3 < to) alongD.push(Math.abs(B[((i + 3) * A + j) * 4 + c] - B[(i * A + j) * 4 + c]));
        if (j + 3 < A) acrossD.push(Math.abs(B[(i * A + j + 3) * 4 + c] - B[(i * A + j) * 4 + c]));
      }
    }
  }
  // The larger of a median and a 90th-percentile reading, each scaled to a normal spread: JPEG
  // quantises averages until most differences are exactly nothing, so its median reads no noise
  // at all while lines in a plain fill still sit three to five levels apart.
  const spreadOf = (list) => {
    if (!list.length) return Infinity;
    const q = Float64Array.from(list).sort();
    return Math.max(1.4826 * q[q.length >> 1], q[Math.floor(q.length * 0.9)] / 1.6449);
  };
  const lowFreq = Math.min(spreadOf(alongD), spreadOf(acrossD)) / Math.SQRT2;
  const sigma = Number.isFinite(lowFreq) ? lowFreq : 0;

  // A reference line is a level and a slope per row and channel; a line is alike when every
  // average along it is within tolerance of the reference: five times the noise, plus four tenths
  // of the edge the reference crosses at that row, which covers an outline wobbling by up to about
  // two thirds of a pixel while a tab, notch or tail two pixels deep moves more.
  const fits = (level, slope) => {
    const refAt = (j, c, i) => (j < 0 || j >= A ? 0 : level[j * 4 + c] + slope[j * 4 + c] * (i - mid));
    const edge = new Float32Array(A);
    for (let j = 0; j < A; j++) {
      let g = 0;
      for (let c = 0; c < 4; c++) g = Math.max(g, Math.abs(refAt(j + 1, c, mid) - refAt(j, c, mid)), Math.abs(refAt(j, c, mid) - refAt(j - 1, c, mid)));
      edge[j] = g;
    }
    const tol = new Float32Array(A);
    for (let j = 0; j < A; j++) tol[j] = 5 * sigma + 3 + 0.4 * Math.max(edge[j], j > 0 ? edge[j - 1] : 0, j + 1 < A ? edge[j + 1] : 0);
    // How far a line strays, as its worst average over its row's tolerance: alike at 1 or under.
    return (i) => {
      let worst = 0;
      for (let j = 0; j < A; j++) {
        for (let c = 0; c < 4; c++) {
          const r = Math.abs(B[(i * A + j) * 4 + c] - refAt(j, c, i)) / tol[j];
          if (r > worst) worst = r;
        }
      }
      return worst;
    };
  };
  // Alike lines, with blips forgiven: one or two lines that stray by under twice the tolerance with
  // alike lines on both sides are noise (JPEG's block edges land on lines like that), while a band's
  // edge or a feature strays by many times and is never forgiven.
  const alike = (stray) => {
    const ok = Array.from({ length: N }, (_, i) => stray(i) <= 1);
    for (let i = 1; i < N - 1; i++) {
      if (ok[i] || !ok[i - 1]) continue;
      let k = i;
      while (k < N && !ok[k]) k++;
      if (k < N && k - i <= 2) {
        let soft = true;
        for (let q = i; q < k; q++) if (stray(q) > 2) soft = false;
        if (soft) for (let q = i; q < k; q++) ok[q] = true;
      }
      i = k;
    }
    return ok;
  };
  const flatRef = (i) => {
    const level = new Float32Array(A * 4);
    for (let q = 0; q < A * 4; q++) level[q] = B[i * A * 4 + q];
    return { level, slope: new Float32Array(A * 4) };
  };
  // A line through the medians of two sets of lines, per row and channel.
  const throughMedians = (left, right) => {
    const level = new Float32Array(A * 4);
    const slope = new Float32Array(A * 4);
    const pL = median(left);
    const pR = median(right);
    for (let q = 0; q < A * 4; q++) {
      const mL = median(left.map((i) => B[i * A * 4 + q]));
      const mR = median(right.map((i) => B[i * A * 4 + q]));
      const b = pR > pL ? (mR - mL) / (pR - pL) : 0;
      slope[q] = b;
      level[q] = mL + b * (mid - pL);
    }
    return { level, slope };
  };

  const third = Math.max(1, Math.floor((to - from) / 3));
  const outerLo = [];
  const outerHi = [];
  for (let i = from; i < from + third; i++) outerLo.push(i);
  for (let i = to - third; i < to; i++) outerHi.push(i);
  // The ramp through the window's outer thirds: right for a gradient, which no single line
  // matches everywhere, and the fallback when the vote below finds no plain line.
  let ref = throughMedians(outerLo, outerHi);
  if (!window) {
    // The plain line, put to a vote: each of sixteen lines across the middle is a candidate, and
    // the one most lines pass the full per-pixel test against wins. A label wide enough to fill the
    // middle cannot become the reference this way, and a corner row of a pill cannot either, since
    // it fails against the straight rows rather than following them.
    const span = to - from;
    // A candidate is tried flat and as a ramp fitted on its own neighbours, and keeps whichever more
    // lines pass: a gradient button's straight rows all follow a ramp, but no flat line beyond a few.
    const localRamp = (c) => {
      const lo = [Math.max(0, c - 3), Math.max(0, c - 2), Math.max(0, c - 1)];
      const hi = [Math.min(N - 1, c + 1), Math.min(N - 1, c + 2), Math.min(N - 1, c + 3)];
      const level = new Float32Array(A * 4);
      const slope = new Float32Array(A * 4);
      const run = median(hi) - median(lo);
      for (let q = 0; q < A * 4; q++) {
        const b0 = run > 0 ? (median(hi.map((i) => B[i * A * 4 + q])) - median(lo.map((i) => B[i * A * 4 + q]))) / run : 0;
        slope[q] = b0;
        level[q] = B[c * A * 4 + q] + b0 * (mid - c);
      }
      return { level, slope };
    };
    let best = null;
    for (let n = 0; n < 16; n++) {
      const cand = from + Math.floor(((n + 0.5) * span) / 16);
      for (const r of [flatRef(cand), localRamp(cand)]) {
        const stray = fits(r.level, r.slope);
        const followers = [];
        for (let i = 0; i < N; i++) if (stray(i) <= 1) followers.push(i);
        if (!best || followers.length > best.followers.length) best = { cand, followers, stray };
      }
    }
    const f = best?.followers ?? [];
    const left = f.filter((i) => i < mid);
    const right = f.filter((i) => i >= mid);
    if (left.length && right.length) ref = throughMedians(left, right);
  }
  const ok = alike(fits(ref.level, ref.slope));
  if (window) return { start: window[0], end: window[1], length: window[1] - window[0], split: false, ok, crisp: false, noise: Math.round(sigma * 10) / 10 };
  const runs = [];
  for (let i = 0; i < N; ) {
    if (!ok[i]) {
      i++;
      continue;
    }
    let k = i;
    while (k < N && ok[k]) k++;
    // Every alike run here is alike to the one plain line, so they are one class.
    runs.push([i, k, 0]);
    i = k;
  }
  const { run, split, gap } = chooseRun(runs, N);
  if (!run) return { start: 0, end: 0, length: 0, split, ok, crisp: false, noise: Math.round(sigma * 10) / 10, gap: gap ?? null };
  let [start, end] = run;
  // The first stretched pixel is blended with the frame texel beside the band when an engine
  // filters linearly, so a band wide enough to spare it keeps one alike texel on each side.
  if (end - start >= 6) {
    start++;
    end--;
  }
  return { start, end, length: end - start, split: false, ok, crisp: false, noise: Math.round(sigma * 10) / 10 };
}

/**
 * How far given insets' band is from alike, each line measured against the band's own line
 * (a single line repeats only itself and cannot smear). An axis with no band has none.
 */
export function bandSmear(image, axis, start, end) {
  if (end - start <= 0) return { failing: 0, lines: 0 };
  const got = findBand(image, axis, { window: [start, end] });
  let failing = 0;
  for (let i = start; i < end; i++) if (!got.ok[i]) failing++;
  return { failing, lines: end - start };
}

/** Insets for the art: found from it, or given (left, top, right, bottom), and what each axis can do. */
export function ninePatchInsets(image, given = null) {
  if (given) {
    const [l, t, r, b] = given;
    if (l + r >= image.width || t + b >= image.height) throw new Error(`insets ${given.join(",")} leave nothing to stretch in a ${image.width}x${image.height} image`);
    // Insets of nothing on an axis mean that axis has no frame and scales as a whole, just as
    // when none is found; there is no band to smear.
    const axis = (a, b2, n, which) => (a === 0 && b2 === 0 ? { stretches: false, split: false, failing: 0, lines: 0 } : { stretches: true, split: false, ...bandSmear(image, which, a, n - b2) });
    return { left: l, top: t, right: r, bottom: b, given: true, across: axis(l, r, image.width, "x"), down: axis(t, b, image.height, "y") };
  }
  const across = findBand(image, "x");
  const down = findBand(image, "y", { crisp: across.crisp });
  // A feature found on one axis must not lie in the other axis's band: a pixel emblem's middle rows
  // can be identical, so the rows through it look stretchable, yet stretching them makes it taller.
  const crosses = (band, other, axis) => {
    if (!band.length || !other.split || !other.gap) return false;
    const [gs, ge] = other.gap;
    const W = image.width;
    for (let i = band.start; i < band.end; i++) {
      const px = (k) => (axis === "y" ? (i * W + k) * 4 : (k * W + i) * 4);
      const edge = px(Math.max(0, gs - 1));
      for (let k = gs; k < ge; k++) {
        const q = px(k);
        let d = 0;
        for (let c = 0; c < 4; c++) d = Math.max(d, Math.abs(image.data[q + c] - image.data[edge + c]));
        if (d > (across.crisp ? 0 : 24)) return true;
      }
    }
    return false;
  };
  if (crosses(down, across, "y")) Object.assign(down, { start: 0, end: 0, length: 0, split: true });
  if (crosses(across, down, "x")) Object.assign(across, { start: 0, end: 0, length: 0, split: true });
  const axis = (band) => (band.length ? { stretches: true, split: false, failing: 0, lines: band.length } : { stretches: false, split: band.split, failing: 0, lines: 0 });
  // An axis with no band of alike lines gets no insets at all: drawn at its own size it is
  // exactly as painted, and resized along that axis it scales as a whole rather than
  // pretending a frame exists. The output says to keep that side's size fixed.
  return {
    left: across.length ? across.start : 0,
    right: across.length ? image.width - across.end : 0,
    top: down.length ? down.start : 0,
    bottom: down.length ? image.height - down.end : 0,
    given: false,
    crisp: across.crisp,
    across: axis(across),
    down: axis(down),
  };
}

/** Whether the centre patch draws anything; Godot can skip drawing it when it does not. */
export function centreIsEmpty(image, { left, top, right, bottom }) {
  for (let y = top; y < image.height - bottom; y++) for (let x = left; x < image.width - right; x++) if (image.data[(y * image.width + x) * 4 + 3] > 0) return false;
  return true;
}

/**
 * The art drawn at another size the way an engine draws a nine-patch: corners as they are,
 * the bands stretched. Godot's own mapping (canvas.glsl, map_ninepatch_axis), sampled at
 * pixel centres with nearest filtering, which is enough to show what stretching does.
 */
export function renderNinePatch(image, insets, width, height) {
  const out = { width, height, data: new Uint8Array(width * height * 4) };
  const map = (p, draw, tex, m0, m1) => {
    if (p < m0) return p;
    if (p >= draw - m1) return tex - (draw - p);
    const span = Math.max(1, draw - m0 - m1);
    return m0 + ((p - m0) / span) * (tex - m0 - m1);
  };
  for (let y = 0; y < height; y++) {
    const sy = Math.min(image.height - 1, Math.max(0, Math.floor(map(y + 0.5, height, image.height, insets.top, insets.bottom))));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(image.width - 1, Math.max(0, Math.floor(map(x + 0.5, width, image.width, insets.left, insets.right))));
      out.data.set(image.data.subarray((sy * image.width + sx) * 4, (sy * image.width + sx) * 4 + 4), (y * width + x) * 4);
    }
  }
  return out;
}

/**
 * The Android .9.png: the art inside a one-pixel border, opaque black marking what stretches
 * (top and left) and where content goes (bottom and right), every other border pixel clear.
 * aapt2 checks exactly this and refuses anything grey, so it must never be resized.
 */
export function androidNinePatch(image, insets, content = insets) {
  const W = image.width + 2;
  const H = image.height + 2;
  const out = { width: W, height: H, data: new Uint8Array(W * H * 4) };
  for (let y = 0; y < image.height; y++) out.data.set(image.data.subarray(y * image.width * 4, (y + 1) * image.width * 4), ((y + 1) * W + 1) * 4);
  const mark = (x, y) => out.data.set([0, 0, 0, 255], (y * W + x) * 4);
  for (let x = 1 + insets.left; x < 1 + image.width - insets.right; x++) mark(x, 0);
  for (let y = 1 + insets.top; y < 1 + image.height - insets.bottom; y++) mark(0, y);
  for (let x = 1 + content.left; x < 1 + image.width - content.right; x++) mark(x, H - 1);
  for (let y = 1 + content.top; y < 1 + image.height - content.bottom; y++) mark(W - 1, y);
  return out;
}

/**
 * Reads a .9.png back: the art inside the border, the insets its top and left marks give,
 * and the content box its bottom and right marks give, with anything aapt2 would refuse
 * named. The border's neutral colour is whatever its corner is, clear or (in old files) opaque
 * white; opaque black marks; red ticks on the bottom and right are layout bounds, which do not
 * change stretching and are passed over.
 */
export function readAndroidNinePatch(image) {
  const { width: W, height: H, data } = image;
  const problems = [];
  const notes = [];
  if (W < 3 || H < 3) return { problems: ["smaller than 3x3, so it has no border and no art"], notes };
  const px = (x, y) => data.subarray((y * W + x) * 4, (y * W + x) * 4 + 4);
  const [r0, g0, b0, a0] = px(0, 0);
  const whiteNeutral = a0 === 255 && r0 === 255 && g0 === 255 && b0 === 255;
  if (a0 !== 0 && !whiteNeutral) problems.push("the border's corner must be clear or opaque white");
  const neutral = (r, g, b, a) => (whiteNeutral ? a === 255 && r === 255 && g === 255 && b === 255 : a === 0);
  const runsOn = (cells, side, boundsAllowed) => {
    const runs = [];
    let open = -1;
    cells.forEach(([x, y], k) => {
      const [r, g, b, a] = px(x, y);
      const black = a === 255 && r === 0 && g === 0 && b === 0;
      const red = a === 255 && r === 255 && g === 0 && b === 0;
      if (!black && !neutral(r, g, b, a)) {
        if (red && boundsAllowed) notes.push(`${side} border carries layout bounds, which do not change stretching`);
        else problems.push(`${side} border pixel ${k} is neither the border's clear colour nor opaque black (${r},${g},${b},${a})`);
      }
      if (black && open < 0) open = k;
      if (!black && open >= 0) {
        runs.push([open, k]);
        open = -1;
      }
    });
    if (open >= 0) runs.push([open, cells.length]);
    return runs;
  };
  const inner = (n) => Array.from({ length: n }, (_, k) => k + 1);
  const top = runsOn(inner(W - 2).map((x) => [x, 0]), "top", false);
  const left = runsOn(inner(H - 2).map((y) => [0, y]), "left", false);
  const bottom = runsOn(inner(W - 2).map((x) => [x, H - 1]), "bottom", true);
  const right = runsOn(inner(H - 2).map((y) => [W - 1, y]), "right", true);
  const w = W - 2;
  const h = H - 2;
  const art = { width: w, height: h, data: new Uint8Array(w * h * 4) };
  for (let y = 0; y < h; y++) art.data.set(data.subarray(((y + 1) * W + 1) * 4, ((y + 1) * W + 1 + w) * 4), y * w * 4);
  // Several stretch regions on a side keep something between them at its size (an icon held in
  // the middle); a StyleBoxTexture, a NinePatchRect and CSS border-image all stretch one region.
  const regions = { across: top.length, down: left.length };
  if (bottom.length > 1 || right.length > 1) problems.push("the content padding is marked in more than one piece, which aapt2 refuses");
  const one = (runs) => (runs.length === 1 ? runs[0] : null);
  const t = one(top);
  const l = one(left);
  const bt = one(bottom);
  const rt = one(right);
  return {
    problems,
    notes: [...new Set(notes)],
    regions,
    art,
    insets: t && l ? { left: t[0], right: w - t[1], top: l[0], bottom: h - l[1] } : null,
    content: bt && rt ? { left: bt[0], right: w - bt[1], top: rt[0], bottom: h - rt[1] } : null,
  };
}

/**
 * A Godot 4 StyleBoxTexture, in the order Godot 4.7.2 itself wrote one: content margins,
 * texture, texture margins, then the axis modes and draw_center when they are not their
 * defaults. Any Control's theme can use it as a panel, a button state or a frame.
 */
export function styleBoxTexture({ texture, insets, content = insets, drawCenter = true }) {
  const f = (v) => Number(v).toFixed(1);
  const lines = [
    `[gd_resource type="StyleBoxTexture" format=3]`,
    "",
    `[ext_resource type="Texture2D" path="${texture}" id="1_texture"]`,
    "",
    "[resource]",
    `content_margin_left = ${f(content.left)}`,
    `content_margin_top = ${f(content.top)}`,
    `content_margin_right = ${f(content.right)}`,
    `content_margin_bottom = ${f(content.bottom)}`,
    `texture = ExtResource("1_texture")`,
    `texture_margin_left = ${f(insets.left)}`,
    `texture_margin_top = ${f(insets.top)}`,
    `texture_margin_right = ${f(insets.right)}`,
    `texture_margin_bottom = ${f(insets.bottom)}`,
  ];
  if (!drawCenter) lines.push("draw_center = false");
  lines.push("");
  return lines.join("\n");
}

/** CSS border-image for the same art: slices top right bottom left, with fill for the centre. */
export function ninePatchCSS({ file, className, insets, drawCenter = true }) {
  const { top: t, right: r, bottom: b, left: l } = insets;
  return [
    `/* Generated by onmodel. ${file} as a nine-patch: corners kept, edges and centre stretched. */`,
    `.${/^[A-Za-z_]/.test(className) ? className : `np-${className}`} {`,
    `  border-style: solid;`,
    `  border-width: ${t}px ${r}px ${b}px ${l}px;`,
    `  border-image: url("${file}") ${t} ${r} ${b} ${l}${drawCenter ? " fill" : ""} / ${t}px ${r}px ${b}px ${l}px stretch;`,
    `}`,
    "",
  ].join("\n");
}
