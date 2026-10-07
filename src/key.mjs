import { parseColor, toHex } from "./color.mjs";

/**
 * What turns a model's picture into a usable asset. The model has no alpha
 * channel and answers in JPEG, so a subject is asked for on a flat key colour and
 * the key is removed here, with the edge pixels un-mixed rather than cut, so no
 * magenta rim survives. Then the geometry: trim to the subject, fit into an exact
 * size, resize with premultiplied alpha so transparent black never bleeds into an
 * edge, and quantise to a palette. Every step also measures, because a keyed
 * image that is 2% fringe and a key colour still sitting in the subject are facts
 * the caller should see, not surprises in the game.
 *
 * Images are { width, height, data } with 8-bit RGBA samples throughout.
 */

// sRGB to CIELAB (D65), with the gamma curve in a table so a megapixel costs
// milliseconds. Distances here are CIE76 (Euclidean in Lab), which is plenty for
// deciding whether a pixel is the key colour; the finer CIEDE2000 lives in color.mjs
// for the places a human-visible difference is being judged.
const LINEAR = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  LINEAR[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);

export function labOf(r, g, b) {
  const R = LINEAR[r];
  const G = LINEAR[g];
  const B = LINEAR[b];
  const x = f((0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047);
  const y = f(0.2126729 * R + 0.7151522 * G + 0.072175 * B);
  const z = f((0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

export const deltaE76 = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const rgbOf = (hex) => {
  const c = parseColor(hex);
  if (!c) throw new Error(`${hex} is not a colour`);
  return c.rgb;
};

export const KEY_CANDIDATES = ["#ff00ff", "#00ff00", "#0000ff", "#00ffff", "#ffff00"];

/**
 * The key colour furthest from everything in the palette, so a brand that uses
 * magenta is never keyed on magenta. With no palette the classic magenta stands.
 */
export function chooseKey(palette = [], candidates = KEY_CANDIDATES) {
  if (!palette.length) return candidates[0];
  const labs = palette.map((p) => labOf(...rgbOf(p)));
  let best = candidates[0];
  let bestGap = -1;
  for (const c of candidates) {
    const lab = labOf(...rgbOf(c));
    const gap = Math.min(...labs.map((l) => deltaE76(lab, l)));
    if (gap > bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  return best;
}

const blank = (width, height) => ({ width, height, data: new Uint8Array(width * height * 4) });

/**
 * Removes a flat key colour. A pixel within `tolerance` of the key becomes
 * transparent, one past one and a half times that stays opaque, and the band
 * between is a soft edge whose colour is un-mixed from the key (the pixel is a
 * blend of subject and key in the ratio its alpha says, so the subject's own
 * colour is recovered rather than a pinkish one kept). Returns the keyed image and
 * what was measured along the way.
 */
export function keyOut(image, keyHex, { tolerance = 30, despill = true } = {}) {
  const { width, height, data } = image;
  const key = rgbOf(keyHex);
  const keyLab = labOf(...key);
  // An anti-aliased edge is a blend of subject and key, and in Lab a blend sits
  // well past the key, so the soft band reaches to twice the tolerance. The key is
  // chosen far from the palette, which is what keeps a real subject colour out of
  // the band.
  const soft = tolerance * 2;
  const keyHue = Math.atan2(keyLab[2], keyLab[1]);
  const out = blank(width, height);
  const d = out.data;
  const dist = new Float32Array(width * height);
  let transparent = 0;
  let semi = 0;
  let residue = 0;
  for (let i = 0, p = 0; i < width * height; i++, p += 4) {
    const r = data[p];
    const g = data[p + 1];
    const b = data[p + 2];
    const lab = labOf(r, g, b);
    const de = deltaE76(lab, keyLab);
    dist[i] = de;
    let alpha;
    if (de <= tolerance) alpha = 0;
    else if (de >= soft) alpha = 255;
    else alpha = Math.round((255 * (de - tolerance)) / (soft - tolerance));
    if (alpha === 0) transparent++;
    else if (alpha < 255) semi++;
    else {
      // Residue: an opaque pixel of the key's own hue, with real chroma. The key
      // has leaked into the subject, or the model painted with it.
      const chroma = Math.hypot(lab[1], lab[2]);
      let hue = Math.abs(Math.atan2(lab[2], lab[1]) - keyHue);
      if (hue > Math.PI) hue = 2 * Math.PI - hue;
      if (chroma > 15 && hue < (25 * Math.PI) / 180) residue++;
    }
    if (alpha === 0) {
      d[p + 3] = 0;
      continue;
    }
    if (alpha < 255 && despill) {
      const a = alpha / 255;
      d[p] = clamp((r - key[0] * (1 - a)) / a);
      d[p + 1] = clamp((g - key[1] * (1 - a)) / a);
      d[p + 2] = clamp((b - key[2] * (1 - a)) / a);
    } else {
      d[p] = r;
      d[p + 1] = g;
      d[p + 2] = b;
    }
    d[p + 3] = alpha;
  }
  // The rim. A JPEG's anti-aliased edge leaves a one-pixel ring that is a blend of
  // subject and key but already past the soft band, so it stayed opaque with the
  // key's tint. For a pixel that touches transparency, and only such a pixel, the
  // ramp is widened to three times the tolerance and the colour un-mixed; an
  // interior pixel of the same colour is left alone, so a subject genuinely near
  // the key's hue never goes translucent inside.
  const beside = (i, x, y, below) => (x > 0 && d[(i - 1) * 4 + 3] < below) || (x < width - 1 && d[(i + 1) * 4 + 3] < below) || (y > 0 && d[(i - width) * 4 + 3] < below) || (y < height - 1 && d[(i + width) * 4 + 3] < below);
  const wide = tolerance * 3;
  const softened = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (d[i * 4 + 3] !== 255 || dist[i] >= wide || !beside(i, x, y, 1)) continue;
      softened.push(i);
    }
  }
  for (const i of softened) {
    const p = i * 4;
    const alpha = Math.max(1, Math.round((255 * (dist[i] - tolerance)) / (wide - tolerance)));
    d[p + 3] = alpha;
    semi++;
    if (despill) {
      const a = alpha / 255;
      d[p] = clamp((data[p] - key[0] * (1 - a)) / a);
      d[p + 1] = clamp((data[p + 1] - key[1] * (1 - a)) / a);
      d[p + 2] = clamp((data[p + 2] - key[2] * (1 - a)) / a);
    }
  }
  // What is left of the rim after that, against the interior: a rim still much
  // closer to the key than the inside would mean a tint the pass did not reach.
  let rimSum = 0;
  let rimN = 0;
  let inSum = 0;
  let inN = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (d[i * 4 + 3] !== 255) continue;
      if (beside(i, x, y, 255)) {
        rimSum += dist[i];
        rimN++;
      } else if (i % 7 === 0) {
        inSum += dist[i];
        inN++;
      }
    }
  }
  const total = width * height;
  const opaque = total - transparent;
  const bounds = alphaBounds(out);
  return {
    image: out,
    facts: {
      key: toHex(key),
      tolerance,
      background: round(transparent / total),
      fringe: round(semi / total),
      residue: opaque ? round(residue / opaque) : 0,
      rimSoftened: softened.length,
      rimDelta: rimN ? round(rimSum / rimN, 1) : null,
      interiorDelta: inN ? round(inSum / inN, 1) : null,
      bounds,
      touchesEdge: bounds ? { top: bounds.y === 0, left: bounds.x === 0, bottom: bounds.y + bounds.height === height, right: bounds.x + bounds.width === width } : null,
    },
  };
}

const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const round = (v, places = 4) => Math.round(v * 10 ** places) / 10 ** places;

/** The box around every pixel whose alpha reaches `threshold`; null for an empty image. */
export function alphaBounds(image, threshold = 1) {
  const { width, height, data } = image;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= threshold) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
}

export function crop(image, x, y, width, height) {
  const out = blank(width, height);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= image.height) continue;
    for (let col = 0; col < width; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= image.width) continue;
      const s = (sy * image.width + sx) * 4;
      const t = (row * width + col) * 4;
      out.data[t] = image.data[s];
      out.data[t + 1] = image.data[s + 1];
      out.data[t + 2] = image.data[s + 2];
      out.data[t + 3] = image.data[s + 3];
    }
  }
  return out;
}

/** Crops to the subject with transparent padding around it; an empty image is returned as it is. */
export function trim(image, { padding = 0, threshold = 1 } = {}) {
  const b = alphaBounds(image, threshold);
  if (!b) return image;
  return crop(image, b.x - padding, b.y - padding, b.width + padding * 2, b.height + padding * 2);
}

// Separable resampling with premultiplied alpha: a transparent pixel's colour
// must not pull on its neighbours, so colour is weighted by alpha on the way in
// and divided back out at the end.
function boxWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const out = [];
  for (let i = 0; i < dstLen; i++) {
    const start = i * scale;
    const end = start + scale;
    const taps = [];
    for (let j = Math.floor(start); j < Math.min(srcLen, Math.ceil(end)); j++) {
      const w = Math.min(end, j + 1) - Math.max(start, j);
      if (w > 1e-9) taps.push([j, w / scale]);
    }
    out.push(taps);
  }
  return out;
}

function linearWeights(srcLen, dstLen) {
  const scale = srcLen / dstLen;
  const out = [];
  for (let i = 0; i < dstLen; i++) {
    const c = (i + 0.5) * scale - 0.5;
    const j0 = Math.max(0, Math.min(srcLen - 1, Math.floor(c)));
    const j1 = Math.min(srcLen - 1, j0 + 1);
    const t = c < 0 ? 0 : Math.min(1, c - j0);
    out.push(j0 === j1 ? [[j0, 1]] : [[j0, 1 - t], [j1, t]]);
  }
  return out;
}

/**
 * Resizes. `nearest` keeps every pixel crisp (pixel art); `box` averages the area
 * a destination pixel covers (the right filter for shrinking); `linear` blends
 * neighbours (for enlarging smoothly); `auto` picks box when shrinking and linear
 * when enlarging.
 */
export function resize(image, width, height, { filter = "auto" } = {}) {
  if (width === image.width && height === image.height) return image;
  if (filter === "nearest") {
    const out = blank(width, height);
    const sx = image.width / width;
    const sy = image.height / height;
    for (let y = 0; y < height; y++) {
      const row = Math.min(image.height - 1, Math.floor((y + 0.5) * sy)) * image.width;
      for (let x = 0; x < width; x++) {
        const s = (row + Math.min(image.width - 1, Math.floor((x + 0.5) * sx))) * 4;
        const t = (y * width + x) * 4;
        out.data[t] = image.data[s];
        out.data[t + 1] = image.data[s + 1];
        out.data[t + 2] = image.data[s + 2];
        out.data[t + 3] = image.data[s + 3];
      }
    }
    return out;
  }
  const kind = filter === "auto" ? (width <= image.width && height <= image.height ? "box" : "linear") : filter;
  const weights = kind === "box" ? boxWeights : linearWeights;
  const wx = weights(image.width, width);
  const wy = weights(image.height, height);
  // Horizontal pass into premultiplied floats.
  const mid = new Float32Array(width * image.height * 4);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sx, w] of wx[x]) {
        const s = (y * image.width + sx) * 4;
        const pa = image.data[s + 3] / 255;
        r += image.data[s] * pa * w;
        g += image.data[s + 1] * pa * w;
        b += image.data[s + 2] * pa * w;
        a += pa * w;
      }
      const m = (y * width + x) * 4;
      mid[m] = r;
      mid[m + 1] = g;
      mid[m + 2] = b;
      mid[m + 3] = a;
    }
  }
  const out = blank(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (const [sy, w] of wy[y]) {
        const m = (sy * width + x) * 4;
        r += mid[m] * w;
        g += mid[m + 1] * w;
        b += mid[m + 2] * w;
        a += mid[m + 3] * w;
      }
      const t = (y * width + x) * 4;
      if (a > 1e-6) {
        out.data[t] = clamp(r / a);
        out.data[t + 1] = clamp(g / a);
        out.data[t + 2] = clamp(b / a);
      }
      out.data[t + 3] = clamp(a * 255);
    }
  }
  return out;
}

/**
 * Scales the image to fit inside width by height, keeping its proportions, on a
 * transparent canvas of exactly that size. `align` places it: center, or bottom
 * for a sprite that stands on the floor of its cell.
 */
export function fitInto(image, width, height, { filter = "auto", align = "center" } = {}) {
  const scale = Math.min(width / image.width, height / image.height);
  const tw = Math.max(1, Math.round(image.width * scale));
  const th = Math.max(1, Math.round(image.height * scale));
  const scaled = resize(image, tw, th, { filter });
  const out = blank(width, height);
  const ox = Math.floor((width - tw) / 2);
  const oy = align === "bottom" ? height - th : align === "top" ? 0 : Math.floor((height - th) / 2);
  blit(out, scaled, ox, oy);
  return out;
}

/** Copies `src` onto `dst` at (x, y), replacing what is there (no blending). */
export function blit(dst, src, x, y) {
  for (let row = 0; row < src.height; row++) {
    const dy = y + row;
    if (dy < 0 || dy >= dst.height) continue;
    for (let col = 0; col < src.width; col++) {
      const dx = x + col;
      if (dx < 0 || dx >= dst.width) continue;
      const s = (row * src.width + col) * 4;
      const t = (dy * dst.width + dx) * 4;
      dst.data[t] = src.data[s];
      dst.data[t + 1] = src.data[s + 1];
      dst.data[t + 2] = src.data[s + 2];
      dst.data[t + 3] = src.data[s + 3];
    }
  }
  return dst;
}

/**
 * Makes every pixel fully opaque or fully transparent. Pixel art has no soft
 * edges: a shrink leaves fractional alpha along the outline, and drawn at scale
 * that reads as a grey halo around the sprite.
 */
export function hardenAlpha(image, threshold = 128) {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4;
    if (out.data[p + 3] >= threshold) out.data[p + 3] = 255;
    else {
      out.data[p] = 0;
      out.data[p + 1] = 0;
      out.data[p + 2] = 0;
      out.data[p + 3] = 0;
    }
  }
  return out;
}

/** Flattens the image onto a solid colour (an App Store icon may not have alpha). */
export function fillBackground(image, hex) {
  const bg = rgbOf(hex);
  const out = blank(image.width, image.height);
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4;
    const a = image.data[p + 3] / 255;
    out.data[p] = clamp(image.data[p] * a + bg[0] * (1 - a));
    out.data[p + 1] = clamp(image.data[p + 1] * a + bg[1] * (1 - a));
    out.data[p + 2] = clamp(image.data[p + 2] * a + bg[2] * (1 - a));
    out.data[p + 3] = 255;
  }
  return out;
}

/** How many distinct colours the opaque pixels use. */
export function colorCount(image, { alphaMin = 128 } = {}) {
  const seen = new Set();
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4;
    if (image.data[p + 3] >= alphaMin) seen.add((image.data[p] << 16) | (image.data[p + 1] << 8) | image.data[p + 2]);
  }
  return seen.size;
}

/** Median-cut: `count` representative colours for a set of RGB samples. */
export function medianCut(samples, count) {
  if (!samples.length) return [];
  let boxes = [samples];
  while (boxes.length < count) {
    let pick = -1;
    let range = -1;
    let channel = 0;
    boxes.forEach((box, i) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let lo = 255;
        let hi = 0;
        for (const s of box) {
          if (s[c] < lo) lo = s[c];
          if (s[c] > hi) hi = s[c];
        }
        if (hi - lo > range) {
          range = hi - lo;
          pick = i;
          channel = c;
        }
      }
    });
    if (pick < 0 || range === 0) break;
    const box = boxes[pick].slice().sort((a, b) => a[channel] - b[channel]);
    const mid = box.length >> 1;
    boxes.splice(pick, 1, box.slice(0, mid), box.slice(mid));
  }
  const centroids = boxes.map((box) => {
    const sum = [0, 0, 0];
    for (const s of box) for (let c = 0; c < 3; c++) sum[c] += s[c];
    return sum.map((v) => v / box.length);
  });
  return refine(samples, centroids).map((c) => c.map(Math.round));
}

/**
 * A few rounds of k-means after the cut. Median cut splits on one channel at a
 * time, so with few colours it can leave a box holding two real colours and
 * average them into one that is in the image nowhere; moving each colour to the
 * mean of the pixels nearest it pulls those apart.
 */
function refine(samples, centroids, rounds = 8) {
  let current = centroids.map((c) => c.slice());
  for (let round = 0; round < rounds; round++) {
    const sums = current.map(() => [0, 0, 0, 0]);
    for (const s of samples) {
      let best = 0;
      let bestD = Infinity;
      for (let i = 0; i < current.length; i++) {
        const c = current[i];
        const dd = (s[0] - c[0]) ** 2 + (s[1] - c[1]) ** 2 + (s[2] - c[2]) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = i;
        }
      }
      const t = sums[best];
      t[0] += s[0];
      t[1] += s[1];
      t[2] += s[2];
      t[3] += 1;
    }
    let moved = 0;
    const next = current.map((c, i) => {
      const t = sums[i];
      if (!t[3]) return c;
      const n = [t[0] / t[3], t[1] / t[3], t[2] / t[3]];
      moved += Math.abs(n[0] - c[0]) + Math.abs(n[1] - c[1]) + Math.abs(n[2] - c[2]);
      return n;
    });
    current = next;
    if (moved < 0.5) break;
  }
  return current;
}

/**
 * Maps every opaque pixel to the nearest colour of a palette, given or found by
 * median cut, and measures how far the image was from that palette before the
 * mapping: the drift is the fact, the mapping is the fix. Optional Floyd-Steinberg
 * dithering for continuous-tone art; never for pixel art.
 */
export function quantize(image, { palette = null, count = 16, dither = false, alphaMin = 128 } = {}) {
  const { width, height, data } = image;
  let colours;
  if (palette?.length) colours = palette.map(rgbOf);
  else {
    const samples = [];
    const step = Math.max(1, Math.floor((width * height) / 60_000));
    for (let i = 0; i < width * height; i += step) if (data[i * 4 + 3] >= alphaMin) samples.push([data[i * 4], data[i * 4 + 1], data[i * 4 + 2]]);
    colours = medianCut(samples, count);
  }
  if (!colours.length) return { image, palette: [], drift: { mean: 0, max: 0 }, mapped: 0 };
  const labs = colours.map((c) => labOf(...c));
  const memo = new Map();
  const nearest = (r, g, b) => {
    const k = (r << 16) | (g << 8) | b;
    let hit = memo.get(k);
    if (hit !== undefined) return hit;
    const lab = labOf(r, g, b);
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < labs.length; i++) {
      const dd = deltaE76(lab, labs[i]);
      if (dd < bestD) {
        bestD = dd;
        best = i;
      }
    }
    hit = { index: best, delta: bestD };
    memo.set(k, hit);
    return hit;
  };
  const out = { width, height, data: new Uint8Array(data) };
  const err = dither ? new Float32Array(width * height * 3) : null;
  let sum = 0;
  let max = 0;
  let mapped = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      const p = i * 4;
      if (data[p + 3] < alphaMin) continue;
      let r = data[p];
      let g = data[p + 1];
      let b = data[p + 2];
      if (err) {
        r = clamp(r + err[i * 3]);
        g = clamp(g + err[i * 3 + 1]);
        b = clamp(b + err[i * 3 + 2]);
      }
      const { index, delta } = nearest(data[p], data[p + 1], data[p + 2]);
      const target = err ? nearest(r, g, b).index : index;
      const c = colours[target];
      sum += delta;
      if (delta > max) max = delta;
      mapped++;
      out.data[p] = c[0];
      out.data[p + 1] = c[1];
      out.data[p + 2] = c[2];
      if (err) {
        const dr = r - c[0];
        const dg = g - c[1];
        const db = b - c[2];
        const spread = (dx, dy, w) => {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || nx >= width || ny >= height) return;
          const n = (ny * width + nx) * 3;
          err[n] += dr * w;
          err[n + 1] += dg * w;
          err[n + 2] += db * w;
        };
        spread(1, 0, 7 / 16);
        spread(-1, 1, 3 / 16);
        spread(0, 1, 5 / 16);
        spread(1, 1, 1 / 16);
      }
    }
  }
  return { image: out, palette: colours.map((c) => toHex(c)), drift: { mean: mapped ? round(sum / mapped, 2) : 0, max: round(max, 2) }, mapped };
}

/**
 * How much of an image sits on a pixel grid of `cell` pixels: the share of cells
 * whose pixels all agree with the cell's mean to within a few levels. Pixel art
 * that is really on the grid scores near 1; painted art, or pixel art the model
 * only imitated, scores low.
 */
export function gridAdherence(image, cell, { tolerance = 6 } = {}) {
  const { width, height, data } = image;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(height / cell);
  let uniform = 0;
  let cells = 0;
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let n = 0;
      const sum = [0, 0, 0, 0];
      const px = [];
      for (let y = cy * cell; y < Math.min(height, (cy + 1) * cell); y++) {
        for (let x = cx * cell; x < Math.min(width, (cx + 1) * cell); x++) {
          const p = (y * width + x) * 4;
          px.push(p);
          for (let c = 0; c < 4; c++) sum[c] += data[p + c];
          n++;
        }
      }
      if (!n) continue;
      cells++;
      const mean = sum.map((v) => v / n);
      const meanLab = labOf(clamp(mean[0]), clamp(mean[1]), clamp(mean[2]));
      let ok = true;
      for (const p of px) {
        if (Math.abs(data[p + 3] - mean[3]) > 16 || deltaE76(labOf(data[p], data[p + 1], data[p + 2]), meanLab) > tolerance) {
          ok = false;
          break;
        }
      }
      if (ok) uniform++;
    }
  }
  return { share: cells ? round(uniform / cells) : 0, cells, cell };
}
