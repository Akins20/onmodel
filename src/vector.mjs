import { labOf, deltaE76, medianCut } from "./key.mjs";
import { sectionOf } from "./brief.mjs";
import { toHex } from "./color.mjs";
import { strokeLines } from "./centerline.mjs";
import { encodePNG } from "./png.mjs";

/**
 * Vector output: a picture the image model painted, turned into shapes. The models
 * answer in pixels only, so this is a step after painting, and it is honest about
 * what it can do: flat-colour art traces into clean paths, pixel art converts
 * exactly, and painted, shaded or textured art is refused with the measurement that
 * says why, because tracing it would give thousands of blobs and a worse file than
 * the PNG.
 *
 * Flat art: the picture's own flat colours are found from its interior pixels (an
 * anti-aliased edge is a mix of two colours and is not counted), and each colour
 * close to a brand colour is snapped to it and named after it. Colours are stacked
 * bottom to top and layer i traces the union of its colour and every colour above
 * it, so shapes overlap underneath and never leave a hairline gap; the outermost
 * colour goes first, so the outline is traced as the smooth silhouette. Contours are
 * found at sub-pixel precision by marching squares over a lightly blurred field (the
 * soft alpha for the silhouette), and cubic Bezier curves are fitted between corners
 * (Schneider's algorithm, Graphics Gems I).
 *
 * Pixel art: every pixel edge between colours is traced, so the SVG is the sprite
 * exactly, drawn with crisp edges.
 *
 * Every fill is a CSS variable named after the brief's palette with the real colour
 * as its fallback, so the SVG renders anywhere and follows a theme when inlined; the
 * Android vector drawable refers to colour resources written beside it.
 *
 * Then the SVG text is parsed back, drawn into pixels by a small renderer here and
 * compared with the original: the silhouette, the share of pixels that kept their
 * colour, the colour drift and the file's size are facts, and a verdict follows.
 */

const r2 = (v) => {
  const s = (Math.round(v * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
};

// ---------------------------------------------------------------- palette names

const FILLER = new Set(["for", "the", "a", "an", "and", "with", "only", "is", "are", "of", "on", "in", "as", "to", "where", "when", "its", "it", "inside", "use", "used", "plus", "or", "both", "any", "all"]);

/**
 * Names for the brief's palette colours, read from the words before each hex in the
 * Palette section ("Plum #6A1B5A for the main form, magenta #A73669 ..." gives plum
 * and magenta). Returns a map from lower-case hex to a slug.
 */
export function paletteNames(briefText) {
  const sec = sectionOf(briefText ?? "", "Palette");
  const names = new Map();
  const used = new Set();
  let prevEnd = 0;
  let i = 0;
  for (const m of sec.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    i += 1;
    const hex = `#${m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]}`.toLowerCase();
    const chunk = sec.slice(prevEnd, m.index).split(/[,;.:\n()]/).pop() ?? "";
    prevEnd = m.index + m[0].length;
    const words = (chunk.toLowerCase().match(/[a-z][a-z-]*/g) ?? []).filter((w) => !FILLER.has(w));
    let name = words.slice(-2).join("-") || `colour-${i}`;
    if (used.has(name)) {
      let k = 2;
      while (used.has(`${name}-${k}`)) k += 1;
      name = `${name}-${k}`;
    }
    if (!names.has(hex)) {
      names.set(hex, name);
      used.add(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------- colours and labels

const rgbOfHex = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));

/**
 * The picture's flat colours, from its interior pixels: the fewest colours (up to
 * maxColours) whose mean distance to those pixels is at most `target`. Also how much
 * of the picture is interior at all; textured art has little.
 */
export function flatColours(image, { maxColours = 12, target = 4, alphaMin = 128, all = false, far = 12, merge = 6 } = {}) {
  const { width, height, data } = image;
  const n = width * height;
  const lab = new Float32Array(n * 3);
  let opaque = 0;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < alphaMin) continue;
    opaque++;
    const l = labOf(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    lab[i * 3] = l[0];
    lab[i * 3 + 1] = l[1];
    lab[i * 3 + 2] = l[2];
  }
  const near = (a, b) => Math.hypot(lab[a * 3] - lab[b * 3], lab[a * 3 + 1] - lab[b * 3 + 1], lab[a * 3 + 2] - lab[b * 3 + 2]) < 8;
  const interior = [];
  const solid = [];
  let measurable = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      if (data[i * 4 + 3] < alphaMin) continue;
      solid.push(i);
      const nb = [i - 1, i + 1, i - width, i + width];
      if (!nb.every((j) => data[j * 4 + 3] >= alphaMin)) continue;
      measurable++;
      if (nb.every((j) => near(i, j))) interior.push(i);
    }
  }
  const interiorShare = opaque ? interior.length / opaque : 0;
  // Two different questions, which the one share used to answer at once and get wrong for
  // line work. How flat the art is can only be asked of a pixel whose four neighbours are
  // all opaque, so `flatShare` is the share of those that are flat. How much of the art is
  // too thin to ask at all is `measurable` against `opaque`: a two-pixel stroke has almost
  // nothing with four opaque neighbours, and judging it by `interiorShare` called a pure
  // black line painted and textured.
  const flatShare = measurable ? interior.length / measurable : 0;
  const thin = measurable < Math.max(16, opaque * 0.05);
  // Thin art has no interior to sample, so its colours are read off every opaque pixel.
  // Full tone reads them off every pixel too: its whole point is the shading, which lives
  // in the very pixels the interior test throws away for not matching their neighbours.
  // Art can also have no interior because no pixel agrees with its neighbours in colour,
  // which is what a photograph or a noise field looks like from here. Sampling an empty
  // interior found no colours at all and wrote an empty SVG, a quiet nothing where a
  // refusal or an honest big file belonged, so the colours are read off every pixel
  // whenever there is too little interior to read them from.
  const pool = all || thin || interior.length < Math.max(16, solid.length * 0.02) ? solid : interior;
  const step = Math.max(1, Math.floor(pool.length / 30000));
  const samples = [];
  const sampleLab = [];
  for (let k = 0; k < pool.length; k += step) {
    const i = pool[k];
    samples.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    sampleLab.push([lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]]);
  }
  if (!samples.length) return { colours: [], meanError: null, interiorShare: Math.round(interiorShare * 1000) / 1000, flatShare: 0, thin, measurable, opaque, lab };
  // Area decides a median cut, so a thin outline or a small accent would be outvoted by
  // a large background. After the first split, every group of pixels the colours miss
  // by more than `far` seeds a colour of its own, and k-means settles them each time.
  const minShare = Math.max(8 / samples.length, 0.0005);
  let colours = medianCut(samples, 2);
  let errors = [];
  const settle = () => {
    for (let round = 0; round < 4; round++) {
      const labs = colours.map((c) => labOf(...c));
      const sums = colours.map(() => [0, 0, 0, 0]);
      errors = sampleLab.map((s, i) => {
        let best = 0;
        let bestD = Infinity;
        for (let c = 0; c < labs.length; c++) {
          const d = deltaE76(s, labs[c]);
          if (d < bestD) {
            bestD = d;
            best = c;
          }
        }
        const acc = sums[best];
        acc[0] += samples[i][0];
        acc[1] += samples[i][1];
        acc[2] += samples[i][2];
        acc[3] += 1;
        return bestD;
      });
      colours = sums.filter((a) => a[3] > 0).map((a) => [Math.round(a[0] / a[3]), Math.round(a[1] / a[3]), Math.round(a[2] / a[3])]);
    }
  };
  settle();
  // The guard is not decoration. Settling drops a colour that ends up with no pixels of
  // its own, so pushing one and settling can leave the count exactly where it was; with a
  // target the art cannot satisfy, which is any smooth gradient, the condition never
  // comes true and the loop runs for ever. Flat art never showed it because its misses
  // die away after a few colours and the other exit is taken first.
  for (let guard = 0; colours.length < maxColours && guard < maxColours * 3 + 8; guard++) {
    const missed = samples.filter((_, i) => errors[i] > far);
    if (missed.length / samples.length <= minShare) break;
    const before = colours.length;
    colours.push(medianCut(missed, 1)[0]);
    settle();
    if (colours.length <= before) {
      // The mean of everything missed can land between two tones, owning none of either,
      // and settling drops it again. On art banded into steps that happens from the first
      // try, and the search stopped five colours in with the bands themselves still
      // missing. Seed on the pixel furthest from every colour instead: it is a colour the
      // art really has, so it keeps at least itself and the search carries on.
      let worst = 0;
      for (let i = 1; i < errors.length; i++) if (errors[i] > errors[worst]) worst = i;
      colours.push(samples[worst]);
      settle();
      if (colours.length <= before) break;
    }
  }
  // two colours that ended up within a hair of each other are one colour
  const labs = colours.map((c) => labOf(...c));
  colours = colours.filter((c, i) => !labs.slice(0, i).some((l) => deltaE76(l, labs[i]) < merge));
  const meanError = errors.reduce((t, e) => t + e, 0) / errors.length;
  return {
    colours,
    meanError: Math.round(meanError * 100) / 100,
    interiorShare: Math.round(interiorShare * 1000) / 1000,
    flatShare: Math.round(flatShare * 1000) / 1000,
    thin,
    measurable,
    opaque,
    lab,
  };
}

/**
 * Snaps the found colours to the brand: a colour within `snap` of a palette colour
 * becomes that palette colour and takes its name; two found colours that snap to the
 * same palette colour are one colour. Returns the final colours and, for each found
 * colour, the index of the final colour it became.
 */
export function brandColours(found, palette = [], names = new Map(), { snap = 12 } = {}) {
  const finals = [];
  const map = [];
  const palLabs = palette.map((hex) => ({ hex, lab: labOf(...rgbOfHex(hex)) }));
  let extra = 0;
  for (const rgb of found) {
    const lab = labOf(...rgb);
    let hit = null;
    let bestD = Infinity;
    for (const p of palLabs) {
      const d = deltaE76(lab, p.lab);
      if (d < bestD) {
        bestD = d;
        hit = p;
      }
    }
    if (hit && bestD <= snap) {
      let idx = finals.findIndex((f) => f.hex === hit.hex);
      if (idx < 0) {
        idx = finals.length;
        finals.push({ hex: hit.hex, rgb: rgbOfHex(hit.hex), name: names.get(hit.hex) ?? `colour-${palette.indexOf(hit.hex) + 1}`, brand: true });
      }
      map.push(idx);
    } else {
      extra += 1;
      map.push(finals.length);
      finals.push({ hex: toHex(rgb), rgb, name: `extra-${extra}`, brand: false });
    }
  }
  return { finals, map };
}

/**
 * Each opaque pixel's colour, -1 for transparent. A pixel on the silhouette's rim
 * (partly transparent, or within two pixels of transparency) does not choose its own colour: its
 * colour is a mix with the key, and residue the keying left there would read as a
 * dark or tinted outline round the whole mark. Rim pixels take the colour of the
 * solid pixels next to them, spreading outward; only a feature that is all rim (a
 * hairline) falls back to its own nearest colour.
 */
function labelPixels(image, lab, colours, { alphaMin = 128, solid = 250 } = {}) {
  const { width, height, data } = image;
  const n = width * height;
  const labels = new Int16Array(n).fill(-1);
  const labs = colours.map((c) => labOf(...c.rgb));
  const nearest = (i) => {
    const p = [lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]];
    let best = 0;
    let bestD = Infinity;
    for (let c = 0; c < labs.length; c++) {
      const d = deltaE76(p, labs[c]);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  };
  const clear = (x, y) => x < 0 || y < 0 || x >= width || y >= height || data[(y * width + x) * 4 + 3] < alphaMin;
  const pending = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (data[i * 4 + 3] < alphaMin) continue;
      // the rim is two pixels deep: keying leaves its residue up to two pixels in
      let rim = data[i * 4 + 3] < solid;
      for (let dy = -2; dy <= 2 && !rim; dy++) for (let dx = -2; dx <= 2 && !rim; dx++) if ((dx || dy) && clear(x + dx, y + dy)) rim = true;
      if (rim) {
        labels[i] = -2;
        pending.push(i);
      } else labels[i] = nearest(i);
    }
  }
  for (let pass = 0; pass < 8 && pending.length; pass++) {
    const assign = [];
    for (const i of pending) {
      const x = i % width;
      const y = (i / width) | 0;
      const votes = new Map();
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if ((!dx && !dy) || xx < 0 || yy < 0 || xx >= width || yy >= height) continue;
          const l = labels[yy * width + xx];
          if (l >= 0) votes.set(l, (votes.get(l) ?? 0) + 1);
        }
      }
      let best = -1;
      for (const [l, v] of votes) if (best < 0 || v > votes.get(best)) best = l;
      if (best >= 0) assign.push([i, best]);
    }
    if (!assign.length) break;
    for (const [i, l] of assign) labels[i] = l;
    pending.splice(0, pending.length, ...pending.filter((i) => labels[i] === -2));
  }
  for (const i of pending) if (labels[i] === -2) labels[i] = nearest(i);
  return labels;
}

/**
 * Cleans the labels the way a person would before tracing: a majority filter takes
 * out the one-pixel slivers an anti-aliased edge leaves between two colours, then
 * specks smaller than `minArea` join the colour around them.
 */
function cleanLabels(labels, width, height, count, { passes = 2, minArea = 16 } = {}) {
  let cur = labels;
  for (let pass = 0; pass < passes; pass++) {
    const next = new Int16Array(cur);
    const votes = new Int32Array(count);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = y * width + x;
        if (cur[i] < 0) continue;
        votes.fill(0);
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= height) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= width) continue;
            const l = cur[yy * width + xx];
            if (l >= 0) votes[l]++;
          }
        }
        let best = cur[i];
        for (let c = 0; c < count; c++) if (votes[c] > votes[best]) best = c;
        next[i] = best;
      }
    }
    cur = next;
  }
  // specks: 4-connected components below minArea take their neighbours' colour
  const comp = new Int32Array(width * height).fill(-1);
  const stack = [];
  let id = 0;
  for (let s = 0; s < width * height; s++) {
    if (cur[s] < 0 || comp[s] >= 0) continue;
    const l = cur[s];
    const members = [];
    stack.push(s);
    comp[s] = id;
    while (stack.length) {
      const i = stack.pop();
      members.push(i);
      const x = i % width;
      const y = (i / width) | 0;
      for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) {
        if (j >= 0 && comp[j] < 0 && cur[j] === l) {
          comp[j] = id;
          stack.push(j);
        }
      }
    }
    if (members.length < minArea) {
      const votes = new Int32Array(count);
      for (const i of members) {
        const x = i % width;
        const y = (i / width) | 0;
        for (const j of [x > 0 ? i - 1 : -1, x < width - 1 ? i + 1 : -1, y > 0 ? i - width : -1, y < height - 1 ? i + width : -1]) if (j >= 0 && cur[j] >= 0 && cur[j] !== l) votes[cur[j]]++;
      }
      let best = -1;
      for (let c = 0; c < count; c++) if (votes[c] > 0 && (best < 0 || votes[c] > votes[best])) best = c;
      if (best >= 0) for (const i of members) cur[i] = best;
    }
    id++;
  }
  return cur;
}

/** Colours bottom to top: the ones on the silhouette's edge first, then by area. */
function layerOrder(labels, width, height, count) {
  const area = new Array(count).fill(0);
  const edge = new Array(count).fill(0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const l = labels[i];
      if (l < 0) continue;
      area[l]++;
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1 || labels[i - 1] < 0 || labels[i + 1] < 0 || labels[i - width] < 0 || labels[i + width] < 0) edge[l]++;
    }
  }
  return [...Array(count).keys()].filter((c) => area[c] > 0).sort((a, b) => edge[b] - edge[a] || area[b] - area[a]);
}

// ---------------------------------------------------------------- contours

function blur(field, width, height, sigma) {
  if (!sigma) return field;
  const radius = Math.max(1, Math.ceil(sigma * 2.5));
  const kernel = [];
  let sum = 0;
  for (let k = -radius; k <= radius; k++) {
    const w = Math.exp(-(k * k) / (2 * sigma * sigma));
    kernel.push(w);
    sum += w;
  }
  for (let k = 0; k < kernel.length; k++) kernel[k] /= sum;
  const tmp = new Float32Array(field.length);
  const out = new Float32Array(field.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = x + k;
        if (xx >= 0 && xx < width) v += field[y * width + xx] * kernel[k + radius];
      }
      tmp[y * width + x] = v;
    }
  }
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy >= 0 && yy < height) v += tmp[yy * width + x] * kernel[k + radius];
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

/**
 * The closed contours of a field at `iso`, as loops of points in pixel coordinates
 * (pixel centres at x + 0.5), by marching squares with a one-sample border of zero so
 * every loop closes. Segments run with the inside on their right, so each crossing is
 * entered once and left once and loops link without searching; the two saddle cases
 * are settled by the cell's centre.
 */
export function contours(field, width, height, iso = 0.5) {
  const PW = width + 2;
  const PH = height + 2;
  const f = (x, y) => (x <= 0 || y <= 0 || x >= PW - 1 || y >= PH - 1 ? 0 : field[(y - 1) * width + (x - 1)]);
  const key = (x, y, vertical) => ((y * PW + x) << 1) | (vertical ? 1 : 0);
  const next = new Map();
  const point = new Map();
  const cross = (k, x, y, vertical) => {
    if (point.has(k)) return;
    const a = f(x, y);
    const b = vertical ? f(x, y + 1) : f(x + 1, y);
    const t = b === a ? 0.5 : (iso - a) / (b - a);
    point.set(k, vertical ? [x - 0.5, y + t - 0.5] : [x + t - 0.5, y - 0.5]);
  };
  for (let y = 0; y < PH - 1; y++) {
    for (let x = 0; x < PW - 1; x++) {
      const tl = f(x, y) > iso;
      const tr = f(x + 1, y) > iso;
      const br = f(x + 1, y + 1) > iso;
      const bl = f(x, y + 1) > iso;
      const c = (tl ? 8 : 0) | (tr ? 4 : 0) | (br ? 2 : 0) | (bl ? 1 : 0);
      if (c === 0 || c === 15) continue;
      const T = key(x, y, false);
      const B = key(x, y + 1, false);
      const L = key(x, y, true);
      const R = key(x + 1, y, true);
      const link = (from, to) => next.set(from, to);
      if (c === 5 || c === 10) {
        const centre = (f(x, y) + f(x + 1, y) + f(x + 1, y + 1) + f(x, y + 1)) / 4 > iso;
        if (c === 10) {
          if (centre) {
            link(T, R);
            link(B, L);
          } else {
            link(T, L);
            link(B, R);
          }
        } else if (centre) {
          link(L, T);
          link(R, B);
        } else {
          link(R, T);
          link(L, B);
        }
      } else {
        // the edge entered has its inside corner on the boundary's right
        const enter = tl && !tr ? T : tr && !br ? R : br && !bl ? B : L;
        const exit = tr && !tl ? T : br && !tr ? R : bl && !br ? B : L;
        link(enter, exit);
      }
      if (tl !== tr) cross(T, x, y, false);
      if (bl !== br) cross(B, x, y + 1, false);
      if (tl !== bl) cross(L, x, y, true);
      if (tr !== br) cross(R, x + 1, y, true);
    }
  }
  const loops = [];
  const seen = new Set();
  for (const start of next.keys()) {
    if (seen.has(start)) continue;
    const loop = [];
    let k = start;
    while (!seen.has(k)) {
      seen.add(k);
      loop.push(point.get(k));
      k = next.get(k);
      if (k === undefined) break;
    }
    if (loop.length >= 3) loops.push(loop);
  }
  return loops;
}

export function polygonArea(points) {
  let a = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// ---------------------------------------------------------------- curve fitting

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, s) => [a[0] * s, a[1] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a, fallback = [1, 0]) => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l] : fallback;
};

function bezierAt(b, t) {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const c = 3 * mt * mt * t;
  const d = 3 * mt * t * t;
  const e = t * t * t;
  return [a * b[0][0] + c * b[1][0] + d * b[2][0] + e * b[3][0], a * b[0][1] + c * b[1][1] + d * b[2][1] + e * b[3][1]];
}

function chordLength(points) {
  const u = [0];
  for (let i = 1; i < points.length; i++) u.push(u[i - 1] + len(sub(points[i], points[i - 1])));
  const total = u[u.length - 1] || 1;
  return u.map((v) => v / total);
}

function generateBezier(points, u, tHat1, tHat2) {
  const p0 = points[0];
  const p3 = points[points.length - 1];
  let c00 = 0;
  let c01 = 0;
  let c11 = 0;
  let x0 = 0;
  let x1 = 0;
  for (let i = 0; i < points.length; i++) {
    const t = u[i];
    const mt = 1 - t;
    const b0 = mt * mt * mt;
    const b1 = 3 * t * mt * mt;
    const b2 = 3 * t * t * mt;
    const b3 = t * t * t;
    const a1 = mul(tHat1, b1);
    const a2 = mul(tHat2, b2);
    c00 += dot(a1, a1);
    c01 += dot(a1, a2);
    c11 += dot(a2, a2);
    const tmp = sub(points[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp);
    x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alphaR = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const segLength = len(sub(p3, p0));
  const eps = 1e-6 * segLength;
  if (alphaL < eps || alphaR < eps) {
    alphaL = segLength / 3;
    alphaR = segLength / 3;
  }
  return [p0, add(p0, mul(tHat1, alphaL)), add(p3, mul(tHat2, alphaR)), p3];
}

function maxError(points, bez, u) {
  let max = 0;
  let split = Math.floor(points.length / 2);
  for (let i = 1; i < points.length - 1; i++) {
    const d = sub(bezierAt(bez, u[i]), points[i]);
    const dd = dot(d, d);
    if (dd >= max) {
      max = dd;
      split = i;
    }
  }
  return [max, split];
}

function reparameterize(points, u, bez) {
  const q1 = [mul(sub(bez[1], bez[0]), 3), mul(sub(bez[2], bez[1]), 3), mul(sub(bez[3], bez[2]), 3)];
  const q2 = [mul(sub(q1[1], q1[0]), 2), mul(sub(q1[2], q1[1]), 2)];
  return u.map((t, i) => {
    const p = bezierAt(bez, t);
    const mt = 1 - t;
    const d1 = add(add(mul(q1[0], mt * mt), mul(q1[1], 2 * mt * t)), mul(q1[2], t * t));
    const d2 = add(mul(q2[0], mt), mul(q2[1], t));
    const diff = sub(p, points[i]);
    const den = dot(d1, d1) + dot(diff, d2);
    if (Math.abs(den) < 1e-12) return t;
    return Math.min(1, Math.max(0, t - dot(diff, d1) / den));
  });
}

/** Fits cubic Beziers through points within `error` (pixels), appending to `out`. */
export function fitCubic(points, tHat1, tHat2, error, out, depth = 0) {
  if (points.length === 2 || depth > 24) {
    const p0 = points[0];
    const p3 = points[points.length - 1];
    const dist = len(sub(p3, p0)) / 3;
    out.push([p0, add(p0, mul(tHat1, dist)), add(p3, mul(tHat2, dist)), p3]);
    return;
  }
  const err2 = error * error;
  let u = chordLength(points);
  let bez = generateBezier(points, u, tHat1, tHat2);
  let [maxErr, split] = maxError(points, bez, u);
  if (maxErr < err2) {
    out.push(bez);
    return;
  }
  if (maxErr < err2 * 16) {
    for (let i = 0; i < 4; i++) {
      u = reparameterize(points, u, bez);
      bez = generateBezier(points, u, tHat1, tHat2);
      [maxErr, split] = maxError(points, bez, u);
      if (maxErr < err2) {
        out.push(bez);
        return;
      }
    }
  }
  split = Math.min(points.length - 2, Math.max(1, split));
  // The join's tangent from points a few steps either side: neighbours one pixel apart
  // give a noisy direction, and a noisy direction shows as a kink where two curves meet.
  const k = Math.min(4, split, points.length - 1 - split);
  const centre = unit(sub(points[split - k], points[split + k]), unit(sub(points[0], points[points.length - 1])));
  fitCubic(points.slice(0, split + 1), tHat1, centre, error, out, depth + 1);
  fitCubic(points.slice(split), mul(centre, -1), tHat2, error, out, depth + 1);
}

/** Indices of the corners of a closed loop: sharp turns over a window of `k` points. */
function loopCorners(loop, { k = CORNER_WINDOW, angle = CORNER_ANGLE } = {}) {
  const n = loop.length;
  if (n < 2 * k + 2) return [];
  const turn = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = loop[(i - k + n) % n];
    const b = loop[i];
    const c = loop[(i + k) % n];
    const v1 = sub(b, a);
    const v2 = sub(c, b);
    const l = len(v1) * len(v2);
    turn[i] = l > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, dot(v1, v2) / l))) : 0;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (turn[i] < angle) continue;
    let peak = true;
    for (let d = -k; d <= k; d++) if (d && turn[(i + d + n) % n] > turn[i]) peak = false;
    if (peak && (!out.length || i - out[out.length - 1] > k)) out.push(i);
  }
  if (out.length > 1 && out[0] + n - out[out.length - 1] <= k) out.pop();
  return out;
}

/**
 * The tangent at one end of a run, pointing into the run (Schneider's convention):
 * from the first point towards a few points on, or from the last point back. The
 * chord is the fallback when those points coincide.
 */
const tangentAt = (pts, i, dir, k = 3) => {
  const j = Math.max(0, Math.min(pts.length - 1, i + dir * k));
  const chord = dir > 0 ? sub(pts[pts.length - 1], pts[0]) : sub(pts[0], pts[pts.length - 1]);
  return unit(sub(pts[j], pts[i]), unit(chord));
};

/** A closed loop as cubic Beziers: split at its corners, smooth elsewhere. */
export function fitLoop(loop, error, corner = CORNER) {
  const n = loop.length;
  const cs = loopCorners(loop, corner);
  const runs = [];
  if (!cs.length) {
    // no corner: split in two, joined with matching tangents so the curve stays smooth
    const half = Math.floor(n / 2);
    const k = Math.max(1, Math.min(4, Math.floor(n / 8)));
    const tA = unit(sub(loop[k], loop[n - k]));
    const tB = unit(sub(loop[(half + k) % n], loop[half - k]));
    const first = loop.slice(0, half + 1);
    const second = [...loop.slice(half), loop[0]];
    const out = [];
    fitCubic(first, tA, mul(tB, -1), error, out);
    fitCubic(second, tB, mul(tA, -1), error, out);
    return out;
  }
  for (let c = 0; c < cs.length; c++) {
    const a = cs[c];
    const b = cs[(c + 1) % cs.length];
    const run = [];
    for (let i = a; ; i = (i + 1) % n) {
      run.push(loop[i]);
      if (i === b && run.length > 1) break;
      if (run.length > n + 1) break;
    }
    runs.push(run);
  }
  const out = [];
  for (const run of runs) {
    if (run.length < 2) continue;
    const t1 = tangentAt(run, 0, 1);
    const t2 = tangentAt(run, run.length - 1, -1);
    fitCubic(run, t1, t2, error, out);
  }
  return out;
}

/**
 * Indices of the corners of an open polyline. The closed version walks off one end into
 * the other, which on a line that is not a loop would invent a corner where the two ends
 * happen to point at each other; here the window stays inside the line and the two ends
 * are never corners, because a corner is where one curve stops and the next begins.
 */
function openCorners(pts, { k = CORNER_WINDOW, angle = CORNER_ANGLE } = {}) {
  const n = pts.length;
  if (n < 2 * k + 2) return [];
  const turn = new Float32Array(n);
  for (let i = k; i < n - k; i++) {
    const v1 = sub(pts[i], pts[i - k]);
    const v2 = sub(pts[i + k], pts[i]);
    const l = len(v1) * len(v2);
    turn[i] = l > 1e-9 ? Math.acos(Math.max(-1, Math.min(1, dot(v1, v2) / l))) : 0;
  }
  const out = [];
  for (let i = k; i < n - k; i++) {
    if (turn[i] < angle) continue;
    let peak = true;
    for (let d = -k; d <= k; d++) {
      const j = i + d;
      if (d && j >= k && j < n - k && turn[j] > turn[i]) peak = false;
    }
    if (peak && (!out.length || i - out[out.length - 1] > k)) out.push(i);
  }
  return out;
}

const luma = (d, p) => 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];

/**
 * Otsu's threshold: the luminance that splits the art into dark and light with the least
 * variance inside each side. Picked from the art rather than fixed at the middle of the
 * range, because a mark is rarely balanced around it; a pale logo thresholded at 128
 * comes out blank, and this is the published way to avoid guessing.
 */
export function otsuThreshold(image, { alphaMin = 128 } = {}) {
  const hist = new Float64Array(256);
  let n = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    if (image.data[i * 4 + 3] < alphaMin) continue;
    hist[Math.round(luma(image.data, i * 4))]++;
    n++;
  }
  if (!n) return 128;
  let sum = 0;
  for (let v = 0; v < 256; v++) sum += v * hist[v];
  let backSum = 0;
  let back = 0;
  let best = 128;
  let bestVar = -1;
  for (let t = 0; t < 256; t++) {
    back += hist[t];
    if (!back) continue;
    const fore = n - back;
    if (!fore) break;
    backSum += t * hist[t];
    const between = (back * fore * (backSum / back - (sum - backSum) / fore) ** 2) / (n * n);
    if (between > bestVar) {
      bestVar = between;
      best = t;
    }
  }
  // Otsu names the top of the dark class, which on flat art is the ink's own luminance.
  // Cutting there puts the ink halfway up the soft edge and the whole mark came out at
  // half coverage. The cut belongs in the gap, so it is moved to the middle of the empty
  // run it sits in; where the art is continuous there is no gap and nothing moves.
  let hi = best;
  while (hi > 0 && !hist[hi]) hi--;
  let lo = best + 1;
  while (lo < 256 && !hist[lo]) lo++;
  return lo < 256 ? Math.round((hi + lo) / 2) : best;
}

/**
 * One colour, or a few levels of one: the art cut at a luminance rather than sorted into
 * the colours it happens to have. Each level is traced from a field that crosses a half
 * between light and dark, so the contour lands between pixels the way a colour layer's
 * does, instead of following the pixel grid.
 *
 * Levels nest, each inside the one before, and are returned light to dark so the darkest
 * is drawn last. Each takes the average colour of the pixels it covers, so a mark cut
 * this way still looks like itself and can still be snapped to the brief.
 */
export function monoLevels(image, { levels = 1, threshold = null, alphaMin = 128, soft = 8 } = {}) {
  const { width: w, height: h } = image;
  const base = threshold ?? otsuThreshold(image, { alphaMin });
  // The outermost level is all the ink; the rest split it so each band holds about the
  // same number of pixels. Spreading the cuts evenly from the threshold down to black was
  // tried first and wastes most of them: a mark's ink occupies a narrow strip of the
  // range, so the lower cuts landed in empty space and eight levels gave three.
  let cuts = [base];
  if (levels > 1) {
    const hist = new Float64Array(256);
    let ink = 0;
    for (let i = 0; i < image.width * image.height; i++) {
      if (image.data[i * 4 + 3] < alphaMin) continue;
      const l = Math.round(luma(image.data, i * 4));
      if (l > base) continue;
      hist[l]++;
      ink++;
    }
    for (let step = 1; step < levels && ink; step++) {
      const want = (ink * (levels - step)) / levels;
      let seen = 0;
      let at = 0;
      for (let v = 0; v <= base; v++) {
        seen += hist[v];
        at = v;
        if (seen >= want) break;
      }
      if (at < cuts[cuts.length - 1]) cuts.push(at);
    }
  }
  return cuts.map((cut) => {
    const field = new Float32Array(w * h);
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let i = 0; i < w * h; i++) {
      const p = i * 4;
      const a = image.data[p + 3] / 255;
      if (a <= 0) continue;
      // Otsu's dark class is everything up to and including the threshold, so a pixel
      // sitting exactly on it is ink. Testing strictly below it threw away a whole mark
      // whose only colour happened to land on the number Otsu chose.
      const ink = Math.min(1, Math.max(0, (cut + 0.5 + soft - luma(image.data, p)) / (2 * soft)));
      field[i] = a * ink;
      if (field[i] >= 0.5) {
        r += image.data[p];
        g += image.data[p + 1];
        b += image.data[p + 2];
        n++;
      }
    }
    return { cut, field, rgb: n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : [0, 0, 0], pixels: n };
  });
}

/** A scalar field sampled between its pixels, clamped at the edges. */
function sampleField(field, w, h, x, y) {
  const fx = Math.min(w - 1, Math.max(0, x - 0.5));
  const fy = Math.min(h - 1, Math.max(0, y - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const a = field[y0 * w + x0] * (1 - tx) + field[y0 * w + x1] * tx;
  const b = field[y1 * w + x0] * (1 - tx) + field[y1 * w + x1] * tx;
  return a * (1 - ty) + b * ty;
}

/**
 * Moves a centre line onto the real middle of the ink and measures how wide it is there.
 *
 * The skeleton comes off whole pixels, so it can only ever sit on a pixel centre. A line
 * an even number of pixels wide has no middle pixel, and its skeleton lands half a pixel
 * to one side; on a 2.4 px ring that alone held the trace to 64% of the source however
 * well the width was guessed. Here each point is pushed along the perpendicular onto the
 * centre of mass of the ink it crosses, which is where the line really is, and the ink it
 * crosses on the way adds up to how wide the line is, to a fraction of a pixel rather
 * than the whole pixel a distance transform can tell apart. Shifts are smoothed over
 * three points, because a profile read per point on its own makes the line shiver.
 */
function refineLine(points, field, w, h, reach) {
  const step = 0.25;
  const shifts = new Float64Array(points.length);
  const widths = new Float64Array(points.length);
  for (let i = 0; i < points.length; i++) {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-9) continue;
    tx /= tl;
    ty /= tl;
    const nx = -ty;
    const ny = tx;
    let moment = 0;
    let mass = 0;
    for (let s = -reach; s <= reach + 1e-9; s += step) {
      const v = sampleField(field, w, h, points[i][0] + nx * s, points[i][1] + ny * s);
      moment += v * s;
      mass += v;
    }
    if (mass <= 1e-6) continue;
    shifts[i] = Math.max(-1.5, Math.min(1.5, moment / mass));
    widths[i] = mass * step;
  }
  const out = points.map((p, i) => {
    const a = points[Math.max(0, i - 1)];
    const b = points[Math.min(points.length - 1, i + 1)];
    let tx = b[0] - a[0];
    let ty = b[1] - a[1];
    const tl = Math.hypot(tx, ty);
    if (tl < 1e-9) return p;
    tx /= tl;
    ty /= tl;
    const s = (shifts[Math.max(0, i - 1)] + shifts[i] + shifts[Math.min(points.length - 1, i + 1)]) / 3;
    return [p[0] - ty * s, p[1] + tx * s];
  });
  // The median, so a blob where two lines cross does not drag the whole line thicker.
  const seen = Array.from(widths).filter((v) => v > 0).sort((a, b) => a - b);
  const width = seen.length ? seen[seen.length >> 1] : 0;
  return { points: out, width };
}

/**
 * Walks an open line's two ends out to where the ink really stops.
 *
 * Thinning eats roughly half the line's width off each end, so a stroke traced from the
 * skeleton alone finishes short and its round cap leaves a notch in the drawing. Each end
 * carries on in its own direction while there is still ink under it, which puts the cap
 * back where the pen lifted.
 */
function extendEnds(points, field, w, h, limit, freeStart, freeEnd) {
  if (points.length < 2 || limit <= 0) return points;
  const out = points.slice();
  for (const end of [0, 1]) {
    if (end === 0 ? !freeStart : !freeEnd) continue;
    const at = end === 0 ? 0 : out.length - 1;
    const back = end === 0 ? Math.min(out.length - 1, 3) : Math.max(0, out.length - 4);
    const from = out[at];
    let dx = from[0] - out[back][0];
    let dy = from[1] - out[back][1];
    const l = Math.hypot(dx, dy);
    if (l < 1e-9) continue;
    dx /= l;
    dy /= l;
    let far = 0;
    for (let s = 0.25; s <= limit + 1e-9; s += 0.25) {
      if (sampleField(field, w, h, from[0] + dx * s, from[1] + dy * s) < 0.5) break;
      far = s;
    }
    if (far <= 0) continue;
    const tip = [from[0] + dx * far, from[1] + dy * far];
    if (end === 0) out.unshift(tip);
    else out.push(tip);
  }
  return out;
}

/** A centre line as cubic Beziers: split at its corners, smooth elsewhere. */
export function fitPolyline(points, error, closed = false, corner = CORNER) {
  if (closed) {
    const n = points.length;
    const loop = n > 2 && points[0][0] === points[n - 1][0] && points[0][1] === points[n - 1][1] ? points.slice(0, -1) : points;
    return loop.length >= 3 ? fitLoop(loop, error, corner) : [];
  }
  if (points.length < 2) return [];
  const cuts = [0, ...openCorners(points, corner), points.length - 1];
  const out = [];
  for (let c = 0; c + 1 < cuts.length; c++) {
    const run = points.slice(cuts[c], cuts[c + 1] + 1);
    if (run.length < 2) continue;
    fitCubic(run, tangentAt(run, 0, 1), tangentAt(run, run.length - 1, -1), error, out);
  }
  return out;
}

/**
 * Centre lines as path text. Unlike a filled loop these are not closed with Z unless the
 * line really is a ring, because closing an open line would draw a chord back to its start.
 */
function strokesToPath(lines, dx, dy) {
  return lines
    .map(({ curves, closed }) => {
      if (!curves.length) return "";
      const p = (q) => `${r2(q[0] - dx)} ${r2(q[1] - dy)}`;
      return `M${p(curves[0][0])}${curves.map((c) => `C${p(c[1])} ${p(c[2])} ${p(c[3])}`).join("")}${closed ? "Z" : ""}`;
    })
    .join("");
}

// ---------------------------------------------------------------- pixel art, exactly

/**
 * The exact outline of every pixel of one label, as loops along pixel edges with the
 * region on the right; with even-odd filling the pairing at a corner where two pixels
 * touch diagonally does not matter, so any is taken. Collinear steps are merged.
 */
export function pixelLoops(labels, width, height, label) {
  const at = (x, y) => (x < 0 || y < 0 || x >= width || y >= height ? -2 : labels[y * width + x]);
  const out = new Map();
  const addEdge = (ax, ay, bx, by) => {
    const k = `${ax},${ay}`;
    if (!out.has(k)) out.set(k, []);
    out.get(k).push([bx, by]);
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (at(x, y) !== label) continue;
      if (at(x, y - 1) !== label) addEdge(x, y, x + 1, y);
      if (at(x + 1, y) !== label) addEdge(x + 1, y, x + 1, y + 1);
      if (at(x, y + 1) !== label) addEdge(x + 1, y + 1, x, y + 1);
      if (at(x - 1, y) !== label) addEdge(x, y + 1, x, y);
    }
  }
  const loops = [];
  for (const [startKey, list] of out) {
    while (list.length) {
      const [sx, sy] = startKey.split(",").map(Number);
      const loop = [[sx, sy]];
      let cur = list.pop();
      while (cur) {
        const [cx, cy] = cur;
        if (cx === sx && cy === sy) break;
        loop.push([cx, cy]);
        const nxt = out.get(`${cx},${cy}`);
        cur = nxt?.pop();
      }
      // merge collinear points
      const merged = loop.filter((p, i) => {
        const a = loop[(i - 1 + loop.length) % loop.length];
        const b = loop[(i + 1) % loop.length];
        return !((a[0] === p[0] && p[0] === b[0]) || (a[1] === p[1] && p[1] === b[1]));
      });
      if (merged.length >= 4) loops.push(merged);
    }
  }
  return loops;
}

// ---------------------------------------------------------------- path text

function curvesToPath(loopCurves, dx, dy) {
  return loopCurves
    .map((curves) => {
      if (!curves.length) return "";
      const p = (q) => `${r2(q[0] - dx)} ${r2(q[1] - dy)}`;
      return `M${p(curves[0][0])}${curves.map((c) => `C${p(c[1])} ${p(c[2])} ${p(c[3])}`).join("")}Z`;
    })
    .join("");
}

function polysToPath(loops, dx, dy) {
  return loops
    .map((loop) => {
      let d = `M${loop[0][0] - dx} ${loop[0][1] - dy}`;
      for (let i = 1; i < loop.length; i++) {
        const [x, y] = loop[i];
        const [px, py] = loop[i - 1];
        d += x === px ? `V${y - dy}` : y === py ? `H${x - dx}` : `L${x - dx} ${y - dy}`;
      }
      return `${d}Z`;
    })
    .join("");
}

/**
 * The same path moved into another frame, x' = s x + tx and y' = s y + ty, with the
 * coordinates written out, so a placed icon carries plain paths a renderer can check
 * rather than a transform group.
 */
export function transformPath(d, s, tx, ty) {
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let out = "";
  let i = 0;
  const X = () => r2(s * Number(tokens[i++]) + tx);
  const Y = () => r2(s * Number(tokens[i++]) + ty);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M" || cmd === "L") out += `${cmd}${X()} ${Y()}`;
    else if (cmd === "H") out += `H${X()}`;
    else if (cmd === "V") out += `V${Y()}`;
    else if (cmd === "C") out += `C${X()} ${Y()} ${X()} ${Y()} ${X()} ${Y()}`;
    else if (cmd === "Z" || cmd === "z") out += "Z";
    else throw new Error(`unexpected path command ${cmd}`);
  }
  return out;
}

/** Parses the path text written here (absolute M, L, H, V, C, Z) back into polygons. */
export function pathToPolygons(d, { step = 1 } = {}) {
  const polys = [];
  let cur = null;
  let x = 0;
  let y = 0;
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  let i = 0;
  const num = () => Number(tokens[i++]);
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") {
      x = num();
      y = num();
      cur = [[x, y]];
      polys.push(cur);
    } else if (cmd === "L") {
      x = num();
      y = num();
      cur.push([x, y]);
    } else if (cmd === "H") {
      x = num();
      cur.push([x, y]);
    } else if (cmd === "V") {
      y = num();
      cur.push([x, y]);
    } else if (cmd === "C") {
      const b = [[x, y], [num(), num()], [num(), num()], [num(), num()]];
      const length = len(sub(b[1], b[0])) + len(sub(b[2], b[1])) + len(sub(b[3], b[2]));
      const n = Math.max(2, Math.ceil(length / step));
      for (let s = 1; s <= n; s++) cur.push(bezierAt(b, s / n));
      [x, y] = b[3];
    } else if (cmd === "Z" || cmd === "z") {
      // closed by the fill
    } else throw new Error(`unexpected path command ${cmd}`);
  }
  return polys;
}

// ---------------------------------------------------------------- rendering

/**
 * Draws even-odd filled polygons into a coverage mask with 4 sub-scanlines per pixel
 * and exact horizontal coverage, which is enough to compare a vector with its source.
 */
export function coverage(polys, width, height) {
  const edges = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const [x1, y1] = poly[i];
      const [x2, y2] = poly[(i + 1) % poly.length];
      if (y1 === y2) continue;
      edges.push(y1 < y2 ? [x1, y1, x2, y2] : [x2, y2, x1, y1]);
    }
  }
  edges.sort((a, b) => a[1] - b[1]);
  const cov = new Float32Array(width * height);
  const SUB = 4;
  const xs = [];
  // an active edge list: edges join when the scanline reaches their top, leave past their bottom
  let nextEdge = 0;
  let active = [];
  for (let row = 0; row < height; row++) {
    for (let s = 0; s < SUB; s++) {
      const sy = row + (s + 0.5) / SUB;
      xs.length = 0;
      while (nextEdge < edges.length && edges[nextEdge][1] <= sy) active.push(edges[nextEdge++]);
      active = active.filter((e) => e[3] > sy);
      for (const [x1, y1, x2, y2] of active) xs.push(x1 + ((sy - y1) / (y2 - y1)) * (x2 - x1));
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const a = Math.max(0, xs[k]);
        const b = Math.min(width, xs[k + 1]);
        if (b <= a) continue;
        const ia = Math.floor(a);
        const ib = Math.floor(b);
        const base = row * width;
        if (ia === ib) cov[base + ia] += (b - a) / SUB;
        else {
          cov[base + ia] += (ia + 1 - a) / SUB;
          for (let p = ia + 1; p < ib; p++) cov[base + p] += 1 / SUB;
          if (ib < width) cov[base + ib] += (b - ib) / SUB;
        }
      }
    }
  }
  for (let i = 0; i < cov.length; i++) if (cov[i] > 1) cov[i] = 1;
  return cov;
}

/**
 * Draws stroked polylines into a coverage mask: a pixel is covered by however far it is
 * inside half the stroke width of the line. Measuring the distance to the line, rather
 * than building an outline around it and filling that, is what a round cap and a round
 * join already are, so corners and ends come out right with no special case.
 */
export function strokeCoverage(polys, width, height, strokeWidth) {
  const cov = new Float32Array(width * height);
  const r = Math.max(0.25, strokeWidth / 2);
  for (const poly of polys) {
    for (let s = 0; s + 1 < poly.length; s++) {
      const a = poly[s];
      const b = poly[s + 1];
      const vx = b[0] - a[0];
      const vy = b[1] - a[1];
      const vv = vx * vx + vy * vy;
      const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0]) - r - 1));
      const x1 = Math.min(width - 1, Math.ceil(Math.max(a[0], b[0]) + r + 1));
      const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1]) - r - 1));
      const y1 = Math.min(height - 1, Math.ceil(Math.max(a[1], b[1]) + r + 1));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const px = x + 0.5 - a[0];
          const py = y + 0.5 - a[1];
          let t = vv > 1e-12 ? (px * vx + py * vy) / vv : 0;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          const dx = px - t * vx;
          const dy = py - t * vy;
          const edge = r + 0.5 - Math.hypot(dx, dy);
          const v = edge <= 0 ? 0 : edge >= 1 ? 1 : edge;
          const i = y * width + x;
          if (v > cov[i]) cov[i] = v;
        }
      }
    }
  }
  return cov;
}

/**
 * Composites coloured layers (bottom first) into an RGBA image: every fill first, then
 * every centre line on top, because a line traced down the middle of its own colour is
 * never meant to be buried under a colour that sits above it.
 */
export function renderLayers(layers, width, height, { crisp = false } = {}) {
  const out = new Uint8Array(width * height * 4);
  const paint = (cov, rgb) => {
    for (let i = 0; i < width * height; i++) {
      let a = cov[i];
      if (crisp) a = a >= 0.5 ? 1 : 0;
      if (a <= 0) continue;
      const p = i * 4;
      const da = out[p + 3] / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) out[p + c] = Math.round((rgb[c] * a + out[p + c] * da * (1 - a)) / (oa || 1));
      out[p + 3] = Math.round(oa * 255);
    }
  };
  for (const layer of layers) if (layer.d) paint(coverage(pathToPolygons(layer.d), width, height), layer.rgb);
  for (const layer of layers) {
    if (!layer.strokes?.length) continue;
    // One mask for the whole layer, taking the greater coverage where two of its lines
    // overlap, so a crossing is not blended over itself and left darker than the line.
    const cov = new Float32Array(width * height);
    for (const s of layer.strokes) {
      const one = strokeCoverage(pathToPolygons(s.d), width, height, s.width);
      for (let i = 0; i < cov.length; i++) if (one[i] > cov[i]) cov[i] = one[i];
    }
    paint(cov, layer.rgb);
  }
  return { width, height, data: out };
}

// ---------------------------------------------------------------- the whole step

const DETAIL = { low: 1.6, normal: 0.8, high: 0.4 };

/**
 * How sharp a turn has to be before it counts as a corner rather than part of a curve,
 * in radians. The dial runs the other way round, because "keep more corners" is the
 * thing anyone actually wants: 0 keeps only the sharpest, 100 keeps nearly every bend,
 * and the default of 45 is the angle the tracer has always used.
 */
const CORNER_ANGLE = 0.95;
const CORNER_WINDOW = 3;
const CORNER = { angle: CORNER_ANGLE, k: CORNER_WINDOW };
// Illustrator offers a Corners dial here and onmodel deliberately does not. It was built
// and measured first: on a rectangle, a five-pointed star and a twelve-tooth cog the
// output stopped changing at the default and above, because a corner must also be the
// sharpest turn in its window and a certain distance from the last one, and past a point
// there are simply no more corners to find. All the dial could do was find fewer, which
// makes the trace round off real corners and grow, since the fitter then subdivides the
// run to hold its error. That trade is what --detail already does, and more honestly.


/** A crop of an RGBA image. */
function cropImage(image, x0, y0, w, h) {
  const data = new Uint8Array(w * h * 4);
  // The crop may reach outside the image, to leave a margin a stroke can stand in; what
  // falls outside stays transparent.
  const sx0 = Math.max(0, x0);
  const sx1 = Math.min(image.width, x0 + w);
  if (sx1 > sx0) {
    for (let y = 0; y < h; y++) {
      const sy = y0 + y;
      if (sy < 0 || sy >= image.height) continue;
      data.set(image.data.subarray((sy * image.width + sx0) * 4, (sy * image.width + sx1) * 4), (y * w + (sx0 - x0)) * 4);
    }
  }
  return { width: w, height: h, data };
}

function bounds(image, alphaMin = 1) {
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (image.data[(y * image.width + x) * 4 + 3] < alphaMin) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 };
}

/**
 * Whether a mark is pixel art, judged from the image alone: small, few colours, and
 * hard-edged (almost no visible pixel is partly transparent). A small anti-aliased
 * flat icon has a soft rim and is traced smooth instead. A sprite from a pixel-mode
 * project is pixel art whatever its edges, which the caller says with `pixel: true`.
 */
export function isPixelArt(image, { maxSide = 256, maxColours = 64, maxSoft = 0.005 } = {}) {
  if (Math.max(image.width, image.height) > maxSide) return false;
  const colours = new Set();
  let visible = 0;
  let soft = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const a = image.data[i * 4 + 3];
    if (a === 0) continue;
    visible++;
    if (a < 255) soft++;
    if (a >= 128) colours.add((image.data[i * 4] << 16) | (image.data[i * 4 + 1] << 8) | image.data[i * 4 + 2]);
    if (colours.size > maxColours) return false;
  }
  return colours.size >= 1 && soft / visible <= maxSoft;
}

/**
 * Compares a render with its source pixel by pixel: the silhouette's overlap, the
 * share of the source's pixels whose colour the render keeps (within `keep` CIE76,
 * so snapping a colour to its brand value counts as kept, while a lost accent or
 * outline does not), the mean colour drift where both are opaque, and a map of where
 * they differ. It never looks through the tracer's own colours, so a colour the tracer
 * missed cannot hide.
 */
export function fidelity(source, render, { alphaMin = 128, keep = 15 } = {}) {
  const n = source.width * source.height;
  let inter = 0;
  let union = 0;
  let kept = 0;
  let opaque = 0;
  let drift = 0;
  let both = 0;
  const diff = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const so = source.data[p + 3] >= alphaMin;
    const ro = render.data[p + 3] >= alphaMin;
    if (so || ro) union++;
    if (so && ro) inter++;
    let same = so === ro;
    if (so) {
      opaque++;
      if (ro) {
        const d = deltaE76(labOf(source.data[p], source.data[p + 1], source.data[p + 2]), labOf(render.data[p], render.data[p + 1], render.data[p + 2]));
        if (d <= keep) kept++;
        else same = false;
        drift += d;
        both++;
      }
    }
    // the difference map: the source faded to grey, mismatches in red
    if (!same) diff.set([220, 38, 38, 255], p);
    else if (so) {
      const g = Math.round(0.6 * (0.3 * source.data[p] + 0.59 * source.data[p + 1] + 0.11 * source.data[p + 2]) + 0.4 * 255);
      diff.set([g, g, g, 255], p);
    }
  }
  return {
    silhouette: union ? Math.round((inter / union) * 1000) / 1000 : 1,
    colourKept: opaque ? Math.round((kept / opaque) * 1000) / 1000 : 1,
    drift: both ? Math.round((drift / both) * 100) / 100 : 0,
    banding: banding(source, render, alphaMin),
    diff: { width: source.width, height: source.height, data: diff },
  };
}

/**
 * The share of the art where the trace put an edge that the source does not have.
 *
 * Banding is the one thing a per-pixel measure cannot see. Posterising a gradient into
 * flat bands can hold every pixel to within a few of its old colour, so the share that
 * kept its colour stays near perfect, while the eye sees rings: the error is small
 * everywhere but it steps, and a step is what we notice. Comparing how sharply each
 * pixel differs from its neighbours, in the trace against the source, finds exactly
 * those steps, and nothing else about the trace creates them.
 */
function banding(source, render, alphaMin, step = 7) {
  const { width: w, height: h } = source;
  const lum = (d, i) => 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let inside = 0;
  let stepped = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // Only where both are solid, so the silhouette's own edge is not read as a band.
      if (source.data[i * 4 + 3] < alphaMin || render.data[i * 4 + 3] < alphaMin) continue;
      let edgy = true;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        if (source.data[j * 4 + 3] < alphaMin || render.data[j * 4 + 3] < alphaMin) edgy = false;
      }
      if (!edgy) continue;
      inside++;
      let sMax = 0;
      let rMax = 0;
      for (const j of [i - 1, i + 1, i - w, i + w]) {
        sMax = Math.max(sMax, Math.abs(lum(source.data, i) - lum(source.data, j)));
        rMax = Math.max(rMax, Math.abs(lum(render.data, i) - lum(render.data, j)));
      }
      // An invented edge is a step in the trace where the source was smooth. Asking only
      // that the trace steps more than the source is too weak a test: at a real band edge
      // both step hard, and the difference between two large numbers sat right on top of
      // the difference for a gradient, leaving nothing to set a threshold between.
      if (rMax > step && sMax < step / 2.5) stepped++;
    }
  }
  return inside ? Math.round((stepped / inside) * 1000) / 1000 : 0;
}

/**
 * Turns a mark into vector layers. Returns { refused } with the measurement when the
 * art is not flat, otherwise the layers, the SVG and Android texts, the render and
 * the facts.
 */
export function vectorize(image, { palette = [], names = new Map(), detail = "normal", maxColours = 12, flatTarget = 4, minInterior = 0.6, tokenPrefix = "brand", title = "mark", pixel = null, stroke = 0, tone = 0, maxPixels = 16e6, noise = null, mono = null } = {}) {
  if (image.width * image.height > maxPixels) {
    // Tracing walks every pixel once per colour, twice more to grow and blur it, and
    // again to follow its contour, so what a decoder shrugs at this does not. Saying so
    // with the numbers beats looking like a hang.
    return {
      refused: `this image is ${image.width}x${image.height}, ${Math.round((image.width * image.height) / 1e6)} megapixels, and the most that is traced is ${Math.round(maxPixels / 1e6)}; tracing works from the shapes, not the detail, so scale it down and trace that`,
      facts: { width: image.width, height: image.height, maxPixels },
    };
  }
  const box = bounds(image, 1);
  if (!box) return { refused: "the image is empty: nothing in it is visible" };
  // Room for a stroke to stand in. A mark trimmed tight has its outermost line against
  // the very edge, and a stroke down the middle of it would be drawn half off the canvas,
  // while the distance transform, which counts outside the image as empty, would read
  // that line as half the width it is. Filled tracing needs no such room, so it keeps the
  // old two pixels and never grows the canvas past the source.
  const pad = stroke > 0 ? Math.ceil(stroke / 2) + 2 : 2;
  const loose = stroke > 0;
  const x0 = loose ? box.x0 - pad : Math.max(0, box.x0 - pad);
  const y0 = loose ? box.y0 - pad : Math.max(0, box.y0 - pad);
  const w = (loose ? box.x1 + pad + 1 : Math.min(image.width, box.x1 + pad + 1)) - x0;
  const h = (loose ? box.y1 + pad + 1 : Math.min(image.height, box.y1 + pad + 1)) - y0;
  const src = cropImage(image, x0, y0, w, h);
  // One colour, or a few levels of one. Rather than a path of its own, the art is first
  // repainted into those levels and then traced like any flat mark, which is exactly what
  // it now is: the stacking, the brand snapping, the measuring and the verdict all apply
  // without knowing it was ever shaded. Only the outermost level's coverage is kept as
  // alpha, so the edge of the mark stays between pixels instead of landing on the grid.
  const monoOn = mono != null && mono !== false;
  let monoLevelCount = 0;
  let monoCuts = [];
  if (monoOn) {
    monoLevelCount = Math.max(1, Math.min(16, Math.round(tone || 0) || 1));
    const built = monoLevels(src, { levels: monoLevelCount, threshold: typeof mono === "number" ? mono : null });
    monoCuts = built.map((b) => b.cut);
    for (let i = 0; i < w * h; i++) {
      let level = -1;
      for (let L = 0; L < built.length; L++) if (built[L].field[i] >= 0.5) level = L;
      const p = i * 4;
      if (level < 0) {
        src.data[p + 3] = 0;
        continue;
      }
      src.data[p] = built[level].rgb[0];
      src.data[p + 1] = built[level].rgb[1];
      src.data[p + 2] = built[level].rgb[2];
      src.data[p + 3] = Math.round(255 * Math.min(1, Math.max(0, built[0].field[i])));
    }
  }
  const exact = monoOn ? false : (pixel ?? isPixelArt(src));
  // pixel art has no soft edge: a partly transparent pixel is in (from half) or out
  let hardened = 0;
  if (exact) {
    for (let i = 0; i < w * h; i++) {
      const a = src.data[i * 4 + 3];
      if (a === 0 || a === 255) continue;
      hardened++;
      src.data[i * 4 + 3] = a >= 128 ? 255 : 0;
    }
  }
  // Full tone: as many colours as the shading needs rather than the few a flat mark has.
  // It differs from a flat trace only in how far it is willing to keep splitting and how
  // close two tones may be and stay apart, since tones sit near each other by nature.
  // Sampling every pixel rather than the interior was tried and is no better: a smooth
  // gradient moves slowly enough that its pixels agree with their neighbours anyway, and
  // on art thin enough to have no interior the fallback already reads every pixel.
  const toneMax = exact ? 0 : monoOn ? (monoLevelCount > 1 ? monoLevelCount : 0) : Math.max(0, Math.round(tone || 0));
  const found = exact
    ? exactColours(src)
    : toneMax > 0
      ? flatColours(src, { maxColours: toneMax, target: flatTarget, far: 4, merge: 3 })
      : flatColours(src, { maxColours, target: flatTarget });
  if (!exact && !found.colours.length) return { refused: "no colours could be read from this art: nothing in it is opaque enough to measure", facts: { opaque: found.opaque ?? 0 } };
  if (!exact && !toneMax) {
    // Line work is judged by its colours alone. It has no interior to measure, and
    // measuring it anyway called a pure black two-pixel line painted and textured, which
    // is as flat as art gets.
    if (!found.thin && found.flatShare < minInterior) return { refused: `this art is textured or painted, not flat: only ${Math.round(found.flatShare * 100)}% of the part that can be judged is flat colour (at least ${Math.round(minInterior * 100)}% is needed), so tracing it would give thousands of shapes and a worse file than the PNG`, facts: { flatShare: found.flatShare, interiorShare: found.interiorShare } };
    if (found.meanError > flatTarget) return { refused: `this art has gradients or shading: ${found.colours.length} flat colours still miss its pixels by ${found.meanError} on average (at most ${flatTarget} is flat), so a vector would band or need thousands of shapes`, facts: { interiorShare: found.interiorShare, meanError: found.meanError, colours: found.colours.length } };
  }
  const { finals, map } = exact ? { finals: found.colours.map((rgb) => ({ hex: toHex(rgb), rgb, name: null, brand: false })), map: found.colours.map((_, i) => i) } : brandColours(found.colours, palette, names);
  if (exact) {
    const snapped = brandColours(found.colours, palette, names, { snap: 3 });
    // pixel art keeps its exact colours; a colour that is a palette colour takes its name
    finals.forEach((f, i) => {
      const s = snapped.finals[snapped.map[i]];
      f.name = s.brand && s.hex === f.hex ? s.name : `extra-${i + 1}`;
      f.brand = s.brand && s.hex === f.hex;
    });
  }
  const lab = exact ? null : found.lab;
  let labels;
  if (exact) labels = exactLabels(src, found.colours);
  else {
    const raw = labelPixels(src, lab, found.colours.map((rgb) => ({ rgb })));
    labels = raw.map((l) => (l < 0 ? -1 : map[l]));
    // Full tone leaves far more specks behind, since neighbouring tones are a hair apart
    // and every bit of noise lands in whichever band it happens to fall; a bigger floor
    // keeps the trace from turning into thousands of one-pixel shapes.
    const minArea = noise != null ? Math.max(1, Math.round(noise)) : toneMax ? Math.max(12, Math.round(found.opaque * 0.0003)) : Math.max(6, Math.round(found.opaque * 0.00005));
    labels = cleanLabels(Int16Array.from(labels), w, h, finals.length, { minArea });
  }
  const order = exact ? [...finals.keys()] : layerOrder(labels, w, h, finals.length);
  const tolerance = DETAIL[detail] ?? DETAIL.normal;
  // Centre lines: the parts of a colour no wider than `stroke` pixels are traced as
  // stroked lines down their middle instead of as filled outlines, and their pixels are
  // left out of the fill. Off unless asked for: a filled outline is the right shape for
  // a solid mark, and only line work wants this.
  const strokesFor = new Map();
  const strokeCovered = new Uint8Array(w * h);
  if (!exact && stroke > 0) {
    for (const c of order) {
      const got = strokeLines(labels, w, h, c, { maxWidth: stroke });
      if (!got.lines.length) continue;
      strokesFor.set(c, got.lines);
      for (let i = 0; i < w * h; i++) if (got.covered[i]) strokeCovered[i] = 1;
    }
  }
  // Lab for every pixel that shows at all, the soft rim included. `found.lab` stops at the
  // opaque ones, and the rim is exactly what tells a centre line where the ink really ends.
  let inkLab = null;
  if (strokesFor.size) {
    inkLab = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      if (src.data[i * 4 + 3] === 0) continue;
      const l = labOf(src.data[i * 4], src.data[i * 4 + 1], src.data[i * 4 + 2]);
      inkLab[i * 3] = l[0];
      inkLab[i * 3 + 1] = l[1];
      inkLab[i * 3 + 2] = l[2];
    }
  }
  const layers = [];
  if (exact) {
    for (const c of order) {
      const loops = pixelLoops(labels, w, h, c);
      if (!loops.length) continue;
      layers.push({ index: c, ...finals[c], d: polysToPath(loops, 0, 0), loops: loops.length, curves: loops.reduce((t, l) => t + l.length, 0) });
    }
  } else {
    const silhouette = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) silhouette[i] = src.data[i * 4 + 3] / 255;
    const soft = blur(silhouette, w, h, 0.6);
    const minLoop = noise != null ? Math.max(1, noise) : Math.max(4, found.opaque * 0.00003);
    // The interior: opaque pixels at least two pixels from any transparent one.
    let interior = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) interior[i] = labels[i] >= 0 ? 1 : 0;
    for (let pass = 0; pass < 2; pass++) {
      const next = new Uint8Array(interior);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = y * w + x;
          if (!interior[i]) continue;
          for (let dy = -1; dy <= 1 && next[i]; dy++) for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h || !interior[yy * w + xx]) {
              next[i] = 0;
              break;
            }
          }
        }
      }
      interior = next;
    }
    for (let li = 0; li < order.length; li++) {
      // Each layer is its own colour plus the colours above it, but only in the
      // interior: lower layers run on under the upper ones so no gap opens between two
      // colours, yet stop short of the silhouette, because two anti-aliased edges
      // stacked on one contour let the lower colour bleed through as a dark or pale
      // fringe (in any renderer). The region is carried two pixels out into
      // transparency, blurred, and cut by the soft silhouette, so where a colour meets
      // the outside its edge is the silhouette's own contour.
      const own = order[li];
      const above = new Set(order.slice(li + 1));
      const bin = new Float32Array(w * h);
      for (let i = 0; i < w * h; i++) bin[i] = (labels[i] === own && !strokeCovered[i]) || (interior[i] && above.has(labels[i])) ? 1 : 0;
      for (let grow = 0; grow < 2; grow++) {
        const next = new Float32Array(bin);
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const i = y * w + x;
            if (bin[i] || labels[i] >= 0) continue;
            if ((x > 0 && bin[i - 1]) || (x < w - 1 && bin[i + 1]) || (y > 0 && bin[i - w]) || (y < h - 1 && bin[i + w])) next[i] = 1;
          }
        }
        bin.set(next);
      }
      const field = blur(bin, w, h, 0.9);
      for (let i = 0; i < w * h; i++) field[i] = Math.min(field[i], soft[i]);
      const loops = contours(field, w, h, 0.5).filter((l) => Math.abs(polygonArea(l)) >= minLoop);
      const lines = strokesFor.get(order[li]) ?? [];
      if (!loops.length && !lines.length) continue;
      const fitted = loops.map((l) => fitLoop(l, tolerance));
      let fittedLines = [];
      if (lines.length) {
        // This layer's own ink: how opaque each pixel is, faded out as its colour moves
        // away from the layer's, so a line is read off its own colour and not a
        // neighbouring one.
        const ink = new Float32Array(w * h);
        const target = labOf(...finals[order[li]].rgb);
        for (let i = 0; i < w * h; i++) {
          const a = src.data[i * 4 + 3] / 255;
          if (a <= 0) continue;
          const d = deltaE76([inkLab[i * 3], inkLab[i * 3 + 1], inkLab[i * 3 + 2]], target);
          if (d >= 24) continue;
          ink[i] = a * (1 - d / 24);
        }
        const reach = stroke / 2 + 1.5;
        fittedLines = lines
          .map((ln) => {
            const refined = refineLine(ln.points, ink, w, h, reach);
            const width = refined.width > 0.3 ? refined.width : ln.width;
            const whole = ln.closed ? refined.points : extendEnds(refined.points, ink, w, h, width, ln.freeStart, ln.freeEnd);
            return { curves: fitPolyline(whole, tolerance, ln.closed), closed: ln.closed, width };
          })
          .filter((s) => s.curves.length);
      }
      // Lines of one width share a path, so a drawing of many strokes is a few paths
      // rather than one per line.
      const byWidth = new Map();
      for (const s of fittedLines) {
        const k = r2(s.width);
        if (!byWidth.has(k)) byWidth.set(k, []);
        byWidth.get(k).push(s);
      }
      layers.push({
        index: order[li],
        ...finals[order[li]],
        d: curvesToPath(fitted, 0, 0),
        loops: loops.length,
        curves: fitted.reduce((t, c) => t + c.length, 0),
        strokes: [...byWidth].map(([k, ss]) => ({ width: Number(k), d: strokesToPath(ss, 0, 0) })),
        lines: fittedLines.length,
        lineCurves: fittedLines.reduce((t, s) => t + s.curves.length, 0),
      });
    }
  }
  // The silhouette alone, one path: what a one-colour icon (a themed or notification
  // icon) needs, far smaller than every colour layer drawn in white.
  let silhouettePath = null;
  if (exact) {
    const mask = Int16Array.from(labels, (l) => (l >= 0 ? 0 : -1));
    silhouettePath = polysToPath(pixelLoops(mask, w, h, 0), 0, 0);
  } else {
    const soft = blur(Float32Array.from({ length: w * h }, (_, i) => src.data[i * 4 + 3] / 255), w, h, 0.6);
    const minLoop = noise != null ? Math.max(1, noise) : Math.max(4, found.opaque * 0.00003);
    silhouettePath = curvesToPath(contours(soft, w, h, 0.5).filter((l) => Math.abs(polygonArea(l)) >= minLoop).map((l) => fitLoop(l, tolerance)), 0, 0);
  }
  const render = renderLayers(layers, w, h, { crisp: exact });
  const fid = fidelity(src, render);
  // How much silhouette agreement is even reachable. A quarter-pixel error along each
  // edge costs a solid mark almost nothing and a hairline a fifth of itself, so the bar
  // set for a blob calls every trace of a 2.4 px line poor however exact it is. Where
  // centre lines were used the width is known, so the bar is set against what that width
  // allows; the raw figure is still reported beside it. It applies to the share that kept
  // its colour as well, which counts a pixel against the trace when the render is not
  // solid there at all, so on a hairline it carries the same penalty twice over.
  // Where centre lines were used the width is measured; otherwise it is read off how much
  // of the art has four opaque neighbours, since a line W pixels wide has about (W-2)/W of
  // itself in that state. Either way the bar moves with the art and not with how it was
  // traced, so a filled trace and a stroked one of the same drawing stay comparable.
  const strokeWidths = layers.flatMap((l) => (l.strokes ?? []).map((s) => s.width)).sort((a, b) => a - b);
  const measured = strokeWidths.length ? strokeWidths[strokeWidths.length >> 1] : 0;
  const share = exact ? 1 : Math.min(1, (found.measurable ?? 0) / Math.max(1, found.opaque ?? 1));
  const estimated = measured > 0 ? measured : share >= 0.98 ? 0 : 2 / (1 - share);
  // Only thin art needs the allowance, and only thin art should be described as having a
  // line weight at all. Past about sixteen pixels a quarter-pixel error costs under three
  // percent, which is noise, and the estimate stops meaning anything: a solid sphere came
  // out as "a 98 px line", which is not a sentence about a sphere.
  const hairline = estimated > 0 && estimated < 16 ? estimated : 0;
  const ceiling = hairline > 0 ? Math.min(1, 1 - 0.5 / Math.max(1, hairline)) : 1;
  // Banding keeps a trace from being called good however well every single pixel came
  // out. Flat bands across a gradient can hold every pixel to within a few of its old
  // colour, so the share that kept its colour stays near perfect while the eye sees
  // rings. Art that was already banded scores about 0.03 here and a posterised gradient
  // about 0.10, so the line sits between them.
  const banded = fid.banding > 0.06;
  const verdict = exact
    ? fid.silhouette >= 0.999 && fid.colourKept >= 0.999
      ? "exact"
      : "approximate"
    : fid.silhouette >= 0.97 * ceiling && fid.colourKept >= 0.93 * ceiling && !banded
      ? "good"
      : fid.silhouette >= 0.93 * ceiling && fid.colourKept >= 0.85 * ceiling
        ? "approximate"
        : "poor";
  const token = (name) => `${tokenPrefix}-${name}`;
  const svg = svgText(layers, w, h, { title, crisp: exact, token });
  const facts = {
    mode: exact ? "pixel" : "flat",
    width: w,
    height: h,
    colours: finals.length,
    layers: layers.length,
    loops: layers.reduce((t, l) => t + l.loops, 0),
    [exact ? "points" : "curves"]: layers.reduce((t, l) => t + l.curves, 0),
    ...(stroke > 0 && !exact
      ? {
          strokeMax: stroke,
          lines: layers.reduce((t, l) => t + (l.lines ?? 0), 0),
          lineCurves: layers.reduce((t, l) => t + (l.lineCurves ?? 0), 0),
        }
      : {}),
    ...(hairline > 0 && ceiling < 1 ? { hairline: Math.round(hairline * 100) / 100, silhouetteCeiling: Math.round(ceiling * 1000) / 1000 } : {}),
    // Full tone is the one mode that can honestly lose to the PNG it came from, so it is
    // weighed against one: the same pixels, encoded, for a figure rather than a feeling.
    ...(monoOn ? { mono: monoLevelCount, cuts: monoCuts } : {}),
    ...(fid.banding ? { banding: fid.banding } : {}),
    ...(toneMax ? { tone: toneMax, vsPNG: Math.round((Buffer.byteLength(svg) / Math.max(1, encodePNG(src).length)) * 100) / 100 } : {}),
    bytes: Buffer.byteLength(svg),
    silhouette: fid.silhouette,
    colourKept: fid.colourKept,
    drift: fid.drift,
    ...(exact ? { hardened } : { interiorShare: found.interiorShare, flatShare: found.flatShare, ...(found.thin ? { thin: true } : {}), meanError: found.meanError, detail }),
    verdict,
  };
  return {
    layers: layers.map(({ index, ...l }) => l),
    silhouette: silhouettePath,
    tokens: finals.filter((f, i) => layers.some((l) => l.index === i)).map((f) => ({ name: token(f.name), hex: f.hex, brand: f.brand })),
    svg,
    android: androidText(layers, w, h, { token }),
    androidColours: androidColoursText(finals.filter((f, i) => layers.some((l) => l.index === i)), { token }),
    render,
    diff: fid.diff,
    source: src,
    crop: { x: x0, y: y0, width: w, height: h },
    facts,
  };
}

function exactColours(image) {
  const seen = new Map();
  for (let i = 0; i < image.width * image.height; i++) {
    if (image.data[i * 4 + 3] !== 255) continue;
    const k = (image.data[i * 4] << 16) | (image.data[i * 4 + 1] << 8) | image.data[i * 4 + 2];
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return { colours: [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => [(k >> 16) & 255, (k >> 8) & 255, k & 255]) };
}

function exactLabels(image, colours) {
  const index = new Map(colours.map((c, i) => [(c[0] << 16) | (c[1] << 8) | c[2], i]));
  const labels = new Int16Array(image.width * image.height).fill(-1);
  for (let i = 0; i < image.width * image.height; i++) {
    if (image.data[i * 4 + 3] !== 255) continue;
    labels[i] = index.get((image.data[i * 4] << 16) | (image.data[i * 4 + 1] << 8) | image.data[i * 4 + 2]) ?? -1;
  }
  return labels;
}

const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** The SVG: one path per colour, its fill a brand-named CSS variable with the real colour as fallback. */
export function svgText(layers, w, h, { title = "mark", crisp = false, token = (n) => n } = {}) {
  const colour = (l) => `var(--${token(l.name)},${l.hex})`;
  const paths = layers.filter((l) => l.d).map((l) => `  <path fill-rule="evenodd" style="fill:${colour(l)}" d="${l.d}"/>`);
  for (const l of layers) {
    for (const s of l.strokes ?? []) {
      paths.push(`  <path fill="none" stroke-width="${r2(s.width)}" stroke-linecap="round" stroke-linejoin="round" style="stroke:${colour(l)}" d="${s.d}"/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"${crisp ? ' shape-rendering="crispEdges"' : ""}>\n  <title>${xmlEsc(title)}</title>\n${paths.join("\n")}\n</svg>\n`;
}

const resName = (name) => name.replace(/[^a-z0-9]+/gi, "_").toLowerCase();

/**
 * An Android vector drawable: the same paths, filled from colour resources, or all in
 * one colour (`fill`, such as "#FFFFFFFF") for a themed or notification icon.
 */
export function androidText(layers, w, h, { token = (n) => n, size = 48, fill = null } = {}) {
  const scale = size / Math.max(w, h);
  const colour = (l) => fill ?? `@color/${resName(token(l.name))}`;
  const paths = layers
    .filter((l) => l.d)
    .map((l) => `    <path\n        android:fillColor="${colour(l)}"\n        android:fillType="evenOdd"\n        android:pathData="${l.d}" />`);
  for (const l of layers) {
    for (const s of l.strokes ?? []) {
      paths.push(
        `    <path\n        android:fillColor="@android:color/transparent"\n        android:strokeColor="${colour(l)}"\n        android:strokeWidth="${r2(s.width)}"\n        android:strokeLineCap="round"\n        android:strokeLineJoin="round"\n        android:pathData="${s.d}" />`,
      );
    }
  }
  return `<?xml version="1.0" encoding="utf-8"?>\n<vector xmlns:android="http://schemas.android.com/apk/res/android"\n    android:width="${Math.round(w * scale)}dp"\n    android:height="${Math.round(h * scale)}dp"\n    android:viewportWidth="${w}"\n    android:viewportHeight="${h}">\n${paths.join("\n")}\n</vector>\n`;
}

export function androidColoursText(colours, { token = (n) => n } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${colours.map((c) => `    <color name="${resName(token(c.name))}">${c.hex.toUpperCase()}</color>`).join("\n")}\n</resources>\n`;
}
