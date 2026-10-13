/**
 * Normal maps, derived rather than painted.
 *
 * A 2D light in an engine needs to know which way each pixel of a sprite faces. That is a
 * normal map, and nobody paints one by hand: it is computed from the art. So it is
 * computed here, deterministically, with no model call and nothing to drift.
 *
 * The honest part first, because it governs everything else. There is no geometry behind
 * a painted sprite, so the height it is lit by has to be invented, and the usual invention
 * is luminance: darker is lower. That is an ASSUMPTION, not a measurement, and it is wrong
 * wherever colour and depth are unrelated. A dark stripe painted on a flat wall becomes a
 * groove in the wall. No amount of care in the arithmetic fixes that, so the tool says it
 * rather than hiding it, and reports how much of the art's variation is fine enough to
 * come out as noise.
 *
 * What CAN be proven is proven. The encoding is checked to be unit length everywhere, flat
 * art is checked to encode exactly flat, the gradient is decoded back out of the written
 * pixels and compared against the gradient it was made from, and for a tile the normal map
 * is held to the same join measurement as the colour it accompanies, because a seamless
 * tile lit by a seamed normal map still shows a grid.
 */

/** Rec. 601 luminance, 0 to 1. */
const luma = (d, p) => (0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2]) / 255;

/**
 * The height the lighting will be computed from, taken from luminance.
 *
 * Pixels that are not visible take the average of what is, rather than zero: a sprite on
 * transparency would otherwise have a cliff all the way round its edge and light up like
 * it had been stamped out of metal.
 */
export function heightField(image, { alphaMin = 1 } = {}) {
  const { width: w, height: h, data } = image;
  const field = new Float32Array(w * h);
  const inside = new Uint8Array(w * h);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] < alphaMin) continue;
    inside[i] = 1;
    field[i] = luma(data, i * 4);
    sum += field[i];
    n++;
  }
  const mean = n ? sum / n : 0.5;
  for (let i = 0; i < w * h; i++) if (!inside[i]) field[i] = mean;
  return { field, inside, mean, visible: n };
}

/** A separable box blur run three times, which is close enough to a Gaussian and cheap. */
export function smooth(field, w, h, radius, wrap = false) {
  if (radius < 1) return Float32Array.from(field);
  let a = Float32Array.from(field);
  let b = new Float32Array(w * h);
  const at = (i, n) => (wrap ? ((i % n) + n) % n : i < 0 ? 0 : i >= n ? n - 1 : i);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let t = 0;
        for (let k = -radius; k <= radius; k++) t += a[y * w + at(x + k, w)];
        b[y * w + x] = t / (2 * radius + 1);
      }
    }
    for (let x = 0; x < w; x++) {
      for (let y = 0; y < h; y++) {
        let t = 0;
        for (let k = -radius; k <= radius; k++) t += b[at(y + k, h) * w + x];
        a[y * w + x] = t / (2 * radius + 1);
      }
    }
  }
  return a;
}

const enc = (v) => Math.max(0, Math.min(255, Math.round((v + 1) * 127.5)));
const dec = (v) => v / 127.5 - 1;

/**
 * The slope of the height field at each pixel, by Sobel.
 *
 * `wrap` reads off the opposite edge instead of clamping, which a tile needs: clamped, the
 * outermost column has no neighbour beyond it, the slope there is wrong, and the tile's
 * lighting shows a seam the colour does not.
 */
export function gradients(field, w, h, wrap = false) {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const at = (x, y) => {
    const cx = wrap ? ((x % w) + w) % w : x < 0 ? 0 : x >= w ? w - 1 : x;
    const cy = wrap ? ((y % h) + h) % h : y < 0 ? 0 : y >= h ? h - 1 : y;
    return field[cy * w + cx];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const tl = at(x - 1, y - 1);
      const tc = at(x, y - 1);
      const tr = at(x + 1, y - 1);
      const ml = at(x - 1, y);
      const mr = at(x + 1, y);
      const bl = at(x - 1, y + 1);
      const bc = at(x, y + 1);
      const br = at(x + 1, y + 1);
      gx[y * w + x] = (tr + 2 * mr + br - (tl + 2 * ml + bl)) / 8;
      gy[y * w + x] = (bl + 2 * bc + br - (tl + 2 * tc + tr)) / 8;
    }
  }
  return { gx, gy };
}

/**
 * A normal map from an image.
 *
 * `strength` scales the slope, `blur` is the radius the height is softened over before it
 * is differentiated (without it, every speck of grain becomes a bump), and `wrap` makes
 * the result tile. The green channel points UP the image by default, which is the OpenGL
 * convention; `invertY` writes the DirectX one instead.
 */
export function normalMap(image, { strength = 1, blur = 1, wrap = false, invertY = false, alphaMin = 1 } = {}) {
  const { width: w, height: h } = image;
  const { field, inside, visible } = heightField(image, { alphaMin });
  const soft = smooth(field, w, h, Math.max(0, Math.round(blur)), wrap);
  const { gx, gy } = gradients(soft, w, h, wrap);

  const data = new Uint8Array(w * h * 4);
  let flat = 0;
  let maxUnit = 0;
  let maxSlope = 0;
  let seen = 0;
  for (let i = 0; i < w * h; i++) {
    const dx = gx[i] * strength * 8;
    const dy = gy[i] * strength * 8;
    const len = Math.hypot(dx, dy, 1);
    // In image coordinates y runs down, so the surface normal is (-dx, -dy, 1). The green
    // channel holds Y measured UP the image, which is the opposite sign, and flipping it
    // back is the DirectX convention. Getting this wrong lights every bump as a dent.
    const nx = -dx / len;
    const nyUp = dy / len;
    const nz = 1 / len;
    const p = i * 4;
    data[p] = enc(nx);
    data[p + 1] = enc(invertY ? -nyUp : nyUp);
    data[p + 2] = enc(nz);
    data[p + 3] = 255;
    // Only where the art actually is. A sprite is mostly transparent padding, which
    // encodes perfectly flat, and averaging that in made every statistic look excellent
    // in proportion to how much empty space the frame had.
    if (!inside[i]) continue;
    seen++;
    if (data[p] === 128 && data[p + 1] === 128 && data[p + 2] === 255) flat++;
    const back = Math.hypot(dec(data[p]), dec(data[p + 1]), dec(data[p + 2]));
    if (Math.abs(back - 1) > maxUnit) maxUnit = Math.abs(back - 1);
    const slope = Math.hypot(dx, dy);
    if (slope > maxSlope) maxSlope = slope;
  }

  // The gradient read back out of the written pixels, against the gradient it was made
  // from. This proves the encoding is faithful; it cannot prove the height was ever real.
  let gradErr = 0;
  let gradMax = 0;
  for (let i = 0; i < w * h; i++) {
    if (!inside[i]) continue;
    const p = i * 4;
    const nx = dec(data[p]);
    const nyUp = invertY ? -dec(data[p + 1]) : dec(data[p + 1]);
    const nz = Math.max(1e-6, dec(data[p + 2]));
    const dxBack = -nx / nz;
    const dyBack = nyUp / nz;
    const e = Math.abs(dxBack - gx[i] * strength * 8) + Math.abs(dyBack - gy[i] * strength * 8);
    gradErr += e;
    if (e > gradMax) gradMax = e;
  }

  // How much of the art's variation is finer than the blur: the part that becomes noise
  // rather than form, and the honest measure of how much the luminance guess is costing.
  const fine = gradients(field, w, h, wrap);
  let fineSum = 0;
  let coarseSum = 0;
  for (let i = 0; i < w * h; i++) {
    if (!inside[i]) continue;
    fineSum += Math.hypot(fine.gx[i], fine.gy[i]);
    coarseSum += Math.hypot(gx[i], gy[i]);
  }
  const r3 = (v) => Math.round(v * 1000) / 1000;

  return {
    image: { width: w, height: h, data },
    facts: {
      strength,
      blur: Math.max(0, Math.round(blur)),
      wrap,
      green: invertY ? "down (DirectX)" : "up (OpenGL)",
      flatShare: r3(flat / Math.max(1, seen)),
      unitError: r3(maxUnit),
      gradientError: r3(gradErr / Math.max(1, seen)),
      gradientWorst: r3(gradMax),
      maxSlope: r3(maxSlope),
      // The steepest face in the map, as an angle, which is the form anyone can picture:
      // 45 degrees is a wall, 5 degrees is a surface you would have to look for.
      steepest: r3((Math.atan(maxSlope) * 180) / Math.PI),
      grainShare: coarseSum > 0 ? r3(Math.max(0, 1 - coarseSum / Math.max(1e-6, fineSum))) : 0,
      visible,
    },
  };
}

/**
 * The art lit by its own normal map, which is the only way to see whether the map is
 * right. A number can say the encoding is faithful; it cannot say the bumps look like
 * bumps rather than dents, and that is what goes wrong when the green channel is flipped.
 *
 * Plain Lambert with a little ambient, from a light in the given direction, where the
 * direction is given as it would be seen on screen: x to the right, y DOWN the image.
 */
export function relight(albedo, normal, { light = [-0.5, -0.5, 0.7], ambient = 0.35, invertY = false } = {}) {
  const { width: w, height: h } = albedo;
  const len = Math.hypot(light[0], light[1], light[2]) || 1;
  const lx = light[0] / len;
  const lyDown = light[1] / len;
  const lz = light[2] / len;
  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const p = i * 4;
    const nx = dec(normal.data[p]);
    const nyUp = invertY ? -dec(normal.data[p + 1]) : dec(normal.data[p + 1]);
    const nz = dec(normal.data[p + 2]);
    // The map stores Y up the image; the light is given with y down, so one is negated.
    const lambert = Math.max(0, nx * lx + nyUp * -lyDown + nz * lz);
    const k = Math.min(1.6, ambient + (1 - ambient) * lambert * 1.6);
    for (let c = 0; c < 3; c++) data[p + c] = Math.max(0, Math.min(255, Math.round(albedo.data[p + c] * k)));
    data[p + 3] = albedo.data[p + 3];
  }
  return { width: w, height: h, data };
}

/** The art lit from four corners in a row, so a flipped channel is obvious at a glance. */
export function lightingStrip(albedo, normal, { invertY = false, gap = 4 } = {}) {
  const dirs = [
    [-0.6, -0.6, 0.6],
    [0.6, -0.6, 0.6],
    [-0.6, 0.6, 0.6],
    [0.6, 0.6, 0.6],
  ];
  const { width: w, height: h } = albedo;
  const out = { width: w * dirs.length + gap * (dirs.length - 1), height: h, data: new Uint8Array((w * dirs.length + gap * (dirs.length - 1)) * h * 4) };
  dirs.forEach((light, k) => {
    const lit = relight(albedo, normal, { light, invertY });
    const x0 = k * (w + gap);
    for (let y = 0; y < h; y++) {
      const from = y * w * 4;
      out.data.set(lit.data.subarray(from, from + w * 4), (y * out.width + x0) * 4);
    }
  });
  return out;
}
