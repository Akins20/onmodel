import { trim, resize, alphaBounds, labOf, deltaE76 } from "./key.mjs";

/**
 * Whether a frame is still the same character, measured rather than felt. Four
 * numbers carry most of it: how much the silhouettes overlap once both are drawn
 * at the same height (shape), how tall the frame is against the reference (size),
 * how far its colours sit from the reference's (palette), and how much it differs
 * from the frame before it (a jump). Each is a plain fact a threshold can act on,
 * so a drifting frame is regenerated instead of noticed in the game.
 */

const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;

/** The opaque mask of an image, with its bounds and area. */
export function silhouette(image, { alphaMin = 128 } = {}) {
  const { width, height, data } = image;
  const mask = new Uint8Array(width * height);
  let area = 0;
  for (let i = 0; i < width * height; i++) {
    if (data[i * 4 + 3] >= alphaMin) {
      mask[i] = 1;
      area++;
    }
  }
  return { mask, width, height, area, bounds: alphaBounds(image, alphaMin) };
}

/** Intersection over union of two masks of the same size. */
export function iou(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("iou needs masks of one size");
  let inter = 0;
  let union = 0;
  for (let i = 0; i < a.mask.length; i++) {
    const x = a.mask[i];
    const y = b.mask[i];
    if (x && y) inter++;
    if (x || y) union++;
  }
  return union ? inter / union : 0;
}

/**
 * Both images trimmed and scaled to the same height, feet on the same line and
 * centred, on one canvas, so their shapes can be compared independent of how big
 * each was drawn.
 */
export function normalisePair(a, b, { height = 128 } = {}) {
  const ta = trim(a);
  const tb = trim(b);
  const fit = (img) => {
    const s = height / img.height;
    return resize(img, Math.max(1, Math.round(img.width * s)), height, { filter: "auto" });
  };
  const fa = fit(ta);
  const fb = fit(tb);
  const width = Math.max(fa.width, fb.width);
  const place = (img) => {
    const out = { width, height, data: new Uint8Array(width * height * 4) };
    const x0 = Math.floor((width - img.width) / 2);
    for (let y = 0; y < height; y++) {
      out.data.set(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4), (y * width + x0) * 4);
    }
    return out;
  };
  return [place(fa), place(fb)];
}

/**
 * The few colours an image is mostly made of, from its opaque pixels: a coarse
 * histogram, then near-duplicates merged, most used first.
 */
export function dominantPalette(image, { count = 8, alphaMin = 128, merge = 8 } = {}) {
  const bins = new Map();
  let total = 0;
  const { width, height, data } = image;
  const step = Math.max(1, Math.floor((width * height) / 40_000));
  for (let i = 0; i < width * height; i += step) {
    const p = i * 4;
    if (data[p + 3] < alphaMin) continue;
    const key = ((data[p] >> 3) << 10) | ((data[p + 1] >> 3) << 5) | (data[p + 2] >> 3);
    const bin = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
    bin.n++;
    bin.r += data[p];
    bin.g += data[p + 1];
    bin.b += data[p + 2];
    bins.set(key, bin);
    total++;
  }
  const sorted = [...bins.values()].sort((x, y) => y.n - x.n).map((b) => ({ rgb: [Math.round(b.r / b.n), Math.round(b.g / b.n), Math.round(b.b / b.n)], n: b.n }));
  const out = [];
  for (const c of sorted) {
    const lab = labOf(...c.rgb);
    const hit = out.find((o) => deltaE76(o.lab, lab) < merge);
    if (hit) hit.n += c.n;
    else out.push({ rgb: c.rgb, lab, n: c.n });
    if (out.length >= count * 3) break;
  }
  return out
    .sort((x, y) => y.n - x.n)
    .slice(0, count)
    .map((o) => ({ color: o.rgb, lab: o.lab, share: total ? round(o.n / total) : 0 }));
}

/**
 * How far one image's colours sit from another's: each of the frame's main
 * colours against the nearest of the reference's, weighted by how much of the
 * frame it covers. Under about 8 is the same palette; past 15 something changed.
 */
export function paletteDelta(image, reference) {
  const mine = dominantPalette(image);
  const theirs = dominantPalette(reference, { count: 12 });
  if (!mine.length || !theirs.length) return null;
  let sum = 0;
  let weight = 0;
  for (const c of mine) {
    const nearest = Math.min(...theirs.map((t) => deltaE76(c.lab, t.lab)));
    sum += nearest * c.share;
    weight += c.share;
  }
  return weight ? round(sum / weight, 2) : null;
}

/** Mean absolute difference of two same-size images over every channel, 0 to 1. */
export function frameDelta(a, b) {
  if (a.width !== b.width || a.height !== b.height) throw new Error("frameDelta needs images of one size");
  let sum = 0;
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i]);
  return round(sum / (a.data.length * 255), 4);
}

/**
 * A frame against its reference (the model sheet's matching view) and against the
 * frame before it. Returns the numbers and the flags the thresholds raise.
 */
export function compareFrame(frame, { reference = null, previous = null, thresholds = {} } = {}) {
  const t = { shape: 0.5, size: 0.15, palette: 15, jump: 0.5, ...thresholds };
  const out = { flags: [] };
  if (reference) {
    const [a, b] = normalisePair(frame, reference);
    out.iou = round(iou(silhouette(a), silhouette(b)));
    const fb = alphaBounds(frame);
    const rb = alphaBounds(reference);
    out.heightRatio = fb && rb ? round(fb.height / rb.height) : null;
    out.paletteDelta = paletteDelta(frame, reference);
    if (out.iou < t.shape) out.flags.push("shape");
    if (out.heightRatio !== null && Math.abs(out.heightRatio - 1) > t.size) out.flags.push("size");
    if (out.paletteDelta !== null && out.paletteDelta > t.palette) out.flags.push("colour");
  }
  if (previous) {
    const [a, b] = normalisePair(frame, previous);
    out.iouPrevious = round(iou(silhouette(a), silhouette(b)));
    if (out.iouPrevious < t.jump) out.flags.push("jump");
  }
  return out;
}

export const DEFAULT_THRESHOLDS = { shape: 0.5, size: 0.15, palette: 15, jump: 0.45 };

/** Flags that mean the frame itself is wrong, as opposed to a jump that may be its neighbour's fault. */
export const HARD_FLAGS = ["empty", "shape", "size", "colour"];

/**
 * Every frame of an action, measured. A strip and the model sheet are painted at
 * different pixel scales, so a frame's height is judged against the action's own
 * median frame, while its shape (both drawn at one height) and its colours are
 * judged against the reference view. Each frame is also compared with the one
 * before it, and the first with the last when the action loops, since the seam is
 * a step like any other. Without a reference, colours are held to the first frame.
 */
export function measureAction(frames, { reference = null, thresholds = {}, loop = true } = {}) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const heights = frames.map((f) => alphaBounds(f)?.height ?? 0);
  const present = heights.filter((h) => h > 0).sort((a, b) => a - b);
  const median = present.length ? present[Math.floor(present.length / 2)] : 0;
  const perFrame = frames.map((frame, i) => {
    const facts = { index: i, height: heights[i], flags: [] };
    if (!heights[i]) {
      facts.flags.push("empty");
      return facts;
    }
    facts.heightRatio = median ? round(heights[i] / median) : null;
    if (facts.heightRatio !== null && Math.abs(facts.heightRatio - 1) > t.size) facts.flags.push("size");
    if (reference) {
      const [a, b] = normalisePair(frame, reference);
      facts.iou = round(iou(silhouette(a), silhouette(b)));
      facts.paletteDelta = paletteDelta(frame, reference);
      if (facts.iou < t.shape) facts.flags.push("shape");
      if (facts.paletteDelta !== null && facts.paletteDelta > t.palette) facts.flags.push("colour");
    } else if (i > 0 && heights[0]) {
      facts.paletteDelta = paletteDelta(frame, frames[0]);
      if (facts.paletteDelta !== null && facts.paletteDelta > t.palette) facts.flags.push("colour");
    }
    const before = i > 0 ? i - 1 : loop && frames.length > 2 ? frames.length - 1 : -1;
    if (before >= 0 && heights[before]) {
      const [a, b] = normalisePair(frame, frames[before]);
      facts.iouPrevious = round(iou(silhouette(a), silhouette(b)));
      if (facts.iouPrevious < t.jump) facts.flags.push(i === 0 ? "seam" : "jump");
    }
    return facts;
  });
  const ious = perFrame.map((f) => f.iou).filter((v) => v !== undefined);
  return {
    frames: perFrame,
    thresholds: t,
    medianHeight: median,
    meanIoU: ious.length ? round(ious.reduce((a, b) => a + b, 0) / ious.length) : null,
    minIoU: ious.length ? Math.min(...ious) : null,
    flagged: perFrame.filter((f) => f.flags.some((x) => HARD_FLAGS.includes(x))).map((f) => f.index),
    jumps: perFrame.filter((f) => f.flags.includes("jump") || f.flags.includes("seam")).map((f) => f.index),
  };
}

/** The silhouettes' overlap of consecutive frames, and which frames break the run. */
export function sequenceSmoothness(frames, { jump = 0.5 } = {}) {
  const steps = [];
  for (let i = 1; i < frames.length; i++) {
    const [a, b] = normalisePair(frames[i], frames[i - 1]);
    steps.push(round(iou(silhouette(a), silhouette(b))));
  }
  const breaks = steps.map((v, i) => (v < jump ? i + 1 : -1)).filter((i) => i >= 0);
  return { steps, breaks, min: steps.length ? Math.min(...steps) : null };
}
