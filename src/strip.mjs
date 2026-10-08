import { crop, trim, resize, alphaBounds } from "./key.mjs";

/**
 * Strips: several poses in one picture. One generation holds every frame in one
 * style, which is what keeps a sequence consistent, and costs one image instead of
 * one per frame. The slicing reads where the poses actually are from the keyed
 * alpha instead of trusting equal spacing, because a model's spacing is only
 * roughly even; and every frame of an action is then placed at one shared scale on
 * one baseline, so the character neither grows nor floats between frames.
 */

const blank = (width, height) => ({ width, height, data: new Uint8Array(width * height * 4) });

/** For each column (or row), whether any pixel in it has alpha at or above `alphaMin`. */
export function inkProfile(image, { axis = "x", alphaMin = 8 } = {}) {
  const { width, height, data } = image;
  const n = axis === "x" ? width : height;
  const out = new Uint8Array(n);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] >= alphaMin) out[axis === "x" ? x : y] = 1;
    }
  }
  return out;
}

/** Runs of ink in a profile, as [start, end) pairs, with gaps shorter than `minGap` bridged. */
export function inkRuns(profile, { minGap = 2 } = {}) {
  const runs = [];
  let start = -1;
  let gap = 0;
  for (let i = 0; i <= profile.length; i++) {
    const ink = i < profile.length && profile[i];
    if (ink) {
      if (start < 0) start = i;
      gap = 0;
    } else if (start >= 0) {
      gap++;
      if (gap >= minGap || i === profile.length) {
        runs.push([start, i - gap + 1]);
        start = -1;
        gap = 0;
      }
    }
  }
  return runs.map(([a, b]) => [a, Math.min(b, profile.length)]);
}

/**
 * Slices a keyed strip into `count` cells. When the alpha shows exactly `count`
 * separate poses they are taken as they are; when it shows more (a thrown object,
 * a detached shadow) the narrowest gaps are closed until `count` remain; when it
 * shows fewer (two poses touching) the strip is divided equally, and the method
 * says so, because a frame cut through a pose is a fact the caller must see.
 */
export function sliceStrip(image, count, { axis = "x", minGap = 2, alphaMin = 8 } = {}) {
  const profile = inkProfile(image, { axis, alphaMin });
  let runs = inkRuns(profile, { minGap });
  const found = runs.length;
  let method = "gaps";
  if (runs.length > count) {
    while (runs.length > count) {
      let narrowest = 0;
      let width = Infinity;
      for (let i = 0; i + 1 < runs.length; i++) {
        const gap = runs[i + 1][0] - runs[i][1];
        if (gap < width) {
          width = gap;
          narrowest = i;
        }
      }
      runs.splice(narrowest, 2, [runs[narrowest][0], runs[narrowest + 1][1]]);
    }
    method = "merged";
  } else if (runs.length < count) {
    const total = axis === "x" ? image.width : image.height;
    runs = Array.from({ length: count }, (_, i) => [Math.round((i * total) / count), Math.round(((i + 1) * total) / count)]);
    method = "equal";
  }
  const cells = runs.map(([a, b]) => {
    const cell = axis === "x" ? crop(image, a, 0, b - a, image.height) : crop(image, 0, a, image.width, b - a);
    const bounds = alphaBounds(cell);
    return { start: a, end: b, image: trim(cell), empty: !bounds };
  });
  return { cells, found, method };
}

/**
 * One scale for a whole action: the largest that lets every frame fit `fill` of
 * the cell, so a frame drawn a little bigger does not come out a little bigger.
 */
export function sharedScale(frames, { width, height, fill = 0.9 }) {
  let maxW = 1;
  let maxH = 1;
  for (const f of frames) {
    if (f.width > maxW) maxW = f.width;
    if (f.height > maxH) maxH = f.height;
  }
  return Math.min((width * fill) / maxW, (height * fill) / maxH);
}

/**
 * Places frames in cells of width by height at a shared scale, feet on a common
 * baseline (anchor "bottom") or centred. Returns one image per frame.
 */
export function placeFrames(frames, { width, height, fill = 0.9, anchor = "bottom", filter = "auto", scale = null }) {
  const s = scale ?? sharedScale(frames, { width, height, fill });
  const margin = Math.round((height * (1 - fill)) / 2);
  return frames.map((f) => {
    const tw = Math.max(1, Math.round(f.width * s));
    const th = Math.max(1, Math.round(f.height * s));
    const scaled = resize(f, tw, th, { filter });
    const out = blank(width, height);
    const x = Math.floor((width - tw) / 2);
    // A frame taller than the fill line (a jump at its peak) keeps its feet as low
    // as the cell allows rather than losing its head off the top.
    const y = anchor === "bottom" ? Math.max(0, height - margin - th) : anchor === "top" ? margin : Math.floor((height - th) / 2);
    for (let row = 0; row < th; row++) {
      const dy = y + row;
      if (dy < 0 || dy >= height) continue;
      for (let col = 0; col < tw; col++) {
        const dx = x + col;
        if (dx < 0 || dx >= width) continue;
        const src = (row * tw + col) * 4;
        const dst = (dy * width + dx) * 4;
        out.data[dst] = scaled.data[src];
        out.data[dst + 1] = scaled.data[src + 1];
        out.data[dst + 2] = scaled.data[src + 2];
        out.data[dst + 3] = scaled.data[src + 3];
      }
    }
    return out;
  });
}

/** The image flipped left to right: a walk to the left is the walk to the right, mirrored. */
export function mirror(image) {
  const { width, height, data } = image;
  const out = blank(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (y * width + x) * 4;
      const dst = (y * width + (width - 1 - x)) * 4;
      out.data[dst] = data[src];
      out.data[dst + 1] = data[src + 1];
      out.data[dst + 2] = data[src + 2];
      out.data[dst + 3] = data[src + 3];
    }
  }
  return out;
}
