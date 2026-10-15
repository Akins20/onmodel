import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { slug } from "./generate.mjs";
import { loadMark } from "./icons.mjs";
import { loadFont, textPath, describeVariation } from "./font.mjs";
import { vectorize, paletteNames, transformPath, pathToPolygons, renderLayers, svgText, androidText, androidColoursText } from "./vector.mjs";
import { parseColor } from "./color.mjs";

/**
 * `onmodel lockup`: a traced symbol and a wordmark set from a font, placed together as
 * one mark, which is what a combination logo is.
 *
 * Both halves already exist and neither is painted here: the symbol is traced and
 * measured as `vector` does it, the letters are the font's own outlines as `text` does
 * it. What this adds is the arrangement, and the arrangement is where a lockup is
 * usually got wrong.
 *
 * Two rules do most of the work. The symbol is sized against the CAP HEIGHT, not the
 * ascender and not the em: the ascender holds room above the capitals for accents that
 * most words never use, so sizing to it leaves the symbol looking small beside the word.
 * And side by side, the symbol is centred on the band between the baseline and the cap
 * line rather than on the whole text block, because a descender hanging off one letter
 * should not drag the symbol down with it.
 */

const snake = (s) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();

/** What a path actually covers, taken from the path itself rather than from metrics. */
export function pathBounds(d) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const poly of pathToPolygons(d)) {
    for (const [x, y] of poly) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  return x1 < x0 ? null : { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

/** What a set of layers covers between them, strokes included. */
function unionBounds(layers) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const l of layers) {
    for (const d of [l.d, ...(l.strokes ?? []).map((st) => st.d)]) {
      const b = d && pathBounds(d);
      if (!b) continue;
      x0 = Math.min(x0, b.x0);
      y0 = Math.min(y0, b.y0);
      x1 = Math.max(x1, b.x1);
      y1 = Math.max(y1, b.y1);
    }
  }
  return x1 < x0 ? null : { x0, y0, x1, y1, width: x1 - x0, height: y1 - y0 };
}

/** Moves and scales a layer, its centre lines included, since a stroke scales with it. */
const place = (layer, s, tx, ty) => ({
  ...layer,
  d: layer.d ? transformPath(layer.d, s, tx, ty) : "",
  strokes: (layer.strokes ?? []).map((st) => ({ width: Math.round(st.width * s * 100) / 100, d: transformPath(st.d, s, tx, ty) })),
});

export async function makeLockup({
  config,
  text,
  fontPath,
  name = null,
  candidate = null,
  markPath = null,
  layout = "beside",
  px = 128,
  tracking = 0,
  gap = 0.5,
  symbol = 1.2,
  kerning = true,
  variation = null,
  instance = null,
  detail = null,
  stroke = null,
  tone = null,
  mono = null,
  noise = null,
  log = (s) => process.stderr.write(s),
}) {
  if (!text || !String(text).trim()) throw new Error('lockup needs --string "<the words>"');
  if (!fontPath) throw new Error("lockup needs --font <file.ttf or .otf>: the letters are set from a real font, not drawn");
  if (!["beside", "above"].includes(layout)) throw new Error("--layout must be beside or above");

  const { mark, file } = await loadMark({ config, name, candidate, markPath });
  const label = slug(name ?? `${String(text)}-lockup`);
  const dir = path.join(config.out, label, "lockup");
  await mkdir(dir, { recursive: true });
  const opts = config.vector ?? {};
  const tokenPrefix = opts.tokenPrefix ?? "brand";
  const token = (n) => `${tokenPrefix}-${n}`;
  const names = paletteNames(config.briefText);

  const v = vectorize(mark, {
    palette: config.palette,
    names,
    detail: detail ?? opts.detail ?? "normal",
    maxColours: opts.maxColours ?? 12,
    tokenPrefix,
    title: label,
    pixel: config.pixel ? true : null,
    stroke: stroke ?? opts.stroke ?? 0,
    tone: tone ?? opts.tone ?? 0,
    mono: mono ?? opts.mono ?? null,
    noise: noise ?? opts.noise ?? null,
  });
  if (v.refused) throw new Error(`the symbol will not trace, so there is no lockup to make: ${v.refused}`);

  const font = loadFont(await readFile(fontPath), { variation, instance });
  const scale = px / font.unitsPerEm;
  const capPx = font.capHeight * scale;
  // Set with the baseline at zero, so the cap band runs from -capPx up to it.
  const set = textPath(font, text, { size: px, letterSpacing: tracking, kerning, x: 0, y: 0 });
  const wordBounds = pathBounds(set.d);
  if (!wordBounds) throw new Error("the words set to nothing: check the string and the font");

  const symH = capPx * symbol;
  const s = symH / Math.max(1, v.facts.height);
  const symW = v.facts.width * s;
  const gapPx = gap * capPx;

  // The symbol is placed first and then measured, because the gap people see is between
  // the ink and the ink. The traced symbol carries a margin from its crop, and the first
  // letter carries its own side bearing; left in, those two turn a gap of 20 into 30.
  const atOrigin = v.layers.map((l) => place(l, s, 0, 0));
  const symInk = unionBounds(atOrigin) ?? { x0: 0, y0: 0, x1: symW, y1: symH, width: symW, height: symH };

  let symAt;
  let wordAt;
  if (layout === "beside") {
    // Centred on the cap band, not on the whole text block.
    symAt = { x: -symInk.x0, y: -capPx / 2 - symInk.height / 2 - symInk.y0 };
    wordAt = { x: symInk.width + gapPx - wordBounds.x0, y: 0 };
  } else {
    const wide = Math.max(symInk.width, wordBounds.width);
    symAt = { x: (wide - symInk.width) / 2 - symInk.x0, y: -capPx - gapPx - symInk.height - symInk.y0 };
    wordAt = { x: (wide - wordBounds.width) / 2 - wordBounds.x0, y: 0 };
  }

  const symbolLayers = v.layers.map((l) => place(l, s, symAt.x, symAt.y));
  const wordLayer = {
    ...pickInk(v, config, names),
    d: transformPath(set.d, 1, wordAt.x, wordAt.y),
    rule: "nonzero",
    loops: (set.d.match(/M/g) ?? []).length,
    curves: (set.d.match(/C/g) ?? []).length,
  };

  // Put everything in positive space with a margin, measured from the paths themselves.
  const all = [...symbolLayers, wordLayer];
  const pad = Math.max(1, Math.round(capPx * 0.08));
  const box = unionBounds(all);
  if (!box) throw new Error("the lockup came out empty");
  const shifted = all.map((l) => place(l, 1, pad - box.x0, pad - box.y0));
  const w = Math.max(1, Math.ceil(box.width) + pad * 2);
  const h = Math.max(1, Math.ceil(box.height) + pad * 2);

  const svg = svgText(shifted, w, h, { title: label, token });
  const render = renderLayers(shifted, w, h);

  const tokens = [];
  for (const l of shifted) {
    if (!l.name || tokens.some((t) => t.name === token(l.name))) continue;
    tokens.push({ name: token(l.name), hex: l.hex, brand: Boolean(l.brand) });
  }

  const facts = {
    mode: `lockup, ${layout}`,
    layout,
    symbol: { from: path.basename(file), width: Math.round(symW), height: Math.round(symH), scale: Math.round(s * 1000) / 1000, verdict: v.facts.verdict, colours: v.facts.colours },
    word: { text: String(text), font: path.basename(fontPath), setting: describeVariation(font), variation: font.variation, instance: font.instance, px, tracking, capHeight: Math.round(capPx), missing: set.missing, blank: set.blank },
    gap: Math.round(gapPx),
    width: w,
    height: h,
    curves: shifted.reduce((t, l) => t + (l.curves ?? 0), 0),
    bytes: Buffer.byteLength(svg),
    verdict: set.missing.length || set.blank.length ? "incomplete" : v.facts.verdict,
  };

  const base = path.join(dir, label);
  const files = {
    svg: `${base}.svg`,
    css: `${base}.tokens.css`,
    render: `${base}.render.png`,
    drawable: path.join(dir, "android", "drawable", `${snake(label)}.xml`),
    colours: path.join(dir, "android", "values", `${snake(tokenPrefix)}_colours.xml`),
  };
  await mkdir(path.dirname(files.drawable), { recursive: true });
  await mkdir(path.dirname(files.colours), { recursive: true });
  await writeFile(files.svg, svg);
  await writeFile(files.css, `:root {\n${tokens.map((t) => `  --${t.name}: ${t.hex};`).join("\n")}\n}\n`);
  await writeFile(files.drawable, androidText(shifted, w, h, { token }));
  await writeFile(files.colours, androidColoursText(shifted.filter((l, i) => l.name && shifted.findIndex((o) => o.name === l.name) === i), { token }));
  await writeFile(files.render, encodePNG(render));

  const summary = { tool: "onmodel", kind: "lockup", name: label, dir, mark: file, generatedAt: new Date().toISOString(), files, facts, tokens };
  await writeFile(path.join(dir, "lockup.json"), JSON.stringify(summary, null, 2));
  log(`  ${label}: ${layout}, symbol ${Math.round(symW)}x${Math.round(symH)} beside "${text}" at ${px}, ${facts.curves} curves, ${Math.round(facts.bytes / 102.4) / 10} KB, ${facts.verdict}\n`);
  if (set.missing.length) log(`  not in the font: ${set.missing.join(" ")}\n`);
  return summary;
}

/** The colour the words take: the darkest of the brief, or of the symbol when there is no brief. */
function pickInk(v, config, names) {
  const palette = config.palette ?? [];
  if (palette.length) {
    let best = null;
    let dark = Infinity;
    for (const hex of palette) {
      const rgb = parseColor(hex)?.rgb;
      if (!rgb) continue;
      const l = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
      if (l < dark) {
        dark = l;
        best = { hex, rgb };
      }
    }
    if (best) return { hex: best.hex, rgb: best.rgb, name: names.get(best.hex) ?? `colour-${palette.indexOf(best.hex) + 1}`, brand: true };
  }
  // No palette: take the symbol's own darkest colour so the two halves still agree.
  let best = null;
  let dark = Infinity;
  for (const l of v.layers) {
    const lum = 0.299 * l.rgb[0] + 0.587 * l.rgb[1] + 0.114 * l.rgb[2];
    if (lum < dark) {
      dark = lum;
      best = l;
    }
  }
  return best ? { hex: best.hex, rgb: best.rgb, name: best.name, brand: Boolean(best.brand) } : { hex: "#000000", rgb: [0, 0, 0], name: "ink", brand: false };
}
