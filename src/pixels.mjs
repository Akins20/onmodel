/**
 * Contrast measured from pixels, for screens whose structure carries no colours (a
 * native app's view hierarchy) and for text drawn over images on the web. It works
 * the way an accessibility scanner reads a screenshot: inside a text element's box
 * the most common colour is the background, and the glyph colour is the most
 * contrasting colour that still covers a meaningful share of the box. Anti-aliased
 * edge pixels are blends of the two; picking the most contrasting significant colour
 * instead of the second most common one keeps thin type from reading as low contrast.
 */

/** WCAG relative luminance of an sRGB colour given as [r, g, b] in 0..255. */
export function luminance([r, g, b]) {
  const lin = (v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** WCAG contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** A colour as a lowercase hex string. */
export function hex([r, g, b]) {
  return `#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;
}

/**
 * The colours inside a rectangle of an RGBA image, quantised to 16 levels a channel,
 * most common first, each with its pixel count and its exact average colour. Large
 * regions are sampled on a grid so a full-width banner costs the same as a label.
 */
export function regionColors(image, rect, maxSamples = 40_000) {
  const x0 = Math.max(0, Math.floor(rect.x));
  const y0 = Math.max(0, Math.floor(rect.y));
  const x1 = Math.min(image.width, Math.ceil(rect.x + rect.width));
  const y1 = Math.min(image.height, Math.ceil(rect.y + rect.height));
  if (x1 <= x0 || y1 <= y0) return { total: 0, colors: [] };
  const area = (x1 - x0) * (y1 - y0);
  const step = Math.max(1, Math.ceil(Math.sqrt(area / maxSamples)));
  const bins = new Map();
  let total = 0;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      const o = (y * image.width + x) * 4;
      const r = image.data[o];
      const g = image.data[o + 1];
      const b = image.data[o + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let bin = bins.get(key);
      if (!bin) {
        bin = { count: 0, r: 0, g: 0, b: 0 };
        bins.set(key, bin);
      }
      bin.count += 1;
      bin.r += r;
      bin.g += g;
      bin.b += b;
      total += 1;
    }
  }
  const colors = Array.from(bins.values())
    .map((bin) => ({ count: bin.count, rgb: [bin.r / bin.count, bin.g / bin.count, bin.b / bin.count] }))
    .sort((a, b) => b.count - a.count);
  return { total, colors };
}

/**
 * Estimates the contrast of the text inside a rectangle. Returns null when the box
 * holds no second colour to measure. A background that is not one dominant colour
 * (a photo, a gradient) is flagged `complex`, because the estimate is then a guess
 * and a guess must never be reported as a failure.
 */
export function estimateTextContrast(image, rect) {
  // Inset by a pixel so the element's own border or a neighbour's edge does not
  // count as glyph colour.
  const inset = { x: rect.x + 1, y: rect.y + 1, width: rect.width - 2, height: rect.height - 2 };
  const { total, colors } = regionColors(image, inset);
  if (total < 16 || colors.length < 2) return null;
  const background = colors[0];
  const rest = colors.slice(1);
  const top = rest[0].count;
  const floor = Math.max(3, total * 0.02, top * 0.15);
  let best = null;
  for (const c of rest) {
    if (c.count < floor) continue;
    const ratio = contrastRatio(c.rgb, background.rgb);
    if (!best || ratio > best.ratio) best = { ratio, rgb: c.rgb, count: c.count };
  }
  if (!best || best.ratio < 1.1) return null;
  const bgShare = background.count / total;
  return {
    ratio: Math.round(best.ratio * 100) / 100,
    fg: hex(best.rgb),
    bg: hex(background.rgb),
    bgShare: Math.round(bgShare * 100) / 100,
    complex: bgShare < 0.35,
  };
}

/**
 * The few colours that make up most of an image, for a screen-level palette fact
 * when nothing finer is known (a screenshot with no structure behind it).
 */
export function dominantColors(image, count = 6) {
  const { total, colors } = regionColors(image, { x: 0, y: 0, width: image.width, height: image.height }, 120_000);
  return colors.slice(0, count).map((c) => ({ color: hex(c.rgb), share: Math.round((c.count / total) * 1000) / 1000 }));
}
