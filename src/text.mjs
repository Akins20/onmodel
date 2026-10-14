import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { slug } from "./generate.mjs";
import { loadFont, textPath } from "./font.mjs";
import { paletteNames, pathToPolygons, coverage, svgText, androidText, androidColoursText } from "./vector.mjs";
import { labOf, deltaE76 } from "./key.mjs";
import { parseColor, toHex } from "./color.mjs";

/**
 * `onmodel text`: a wordmark or lettermark set from a real font, as an SVG with a
 * brand-named fill, an Android vector drawable with its colour resource, and a CSS file
 * of the token.
 *
 * Nothing here is painted and nothing is traced. The letters are the outlines the type
 * designer drew, read out of the font and written as paths, so they are right by
 * construction rather than right on inspection. That matters because no measurement
 * onmodel takes could tell a good R from a bad one: it would happily report a mangled
 * word as a perfect match for the mangled word it was given.
 *
 * What can still go wrong is narrow and is checked: a character the font does not have,
 * and a character the font claims to have but draws nothing for.
 */

const snake = (s) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();

/** The palette colour nearest the one asked for, so a wordmark is named like everything else. */
function brandFill(colour, palette, names) {
  const want = colour ? (parseColor(colour)?.rgb ?? null) : null;
  if (colour && !want) throw new Error(`--colour ${colour} is not a colour: give it as #rrggbb or rgb(r, g, b)`);
  const usable = palette.map((hex) => ({ hex, rgb: parseColor(hex)?.rgb })).filter((p) => p.rgb);
  if (!usable.length) {
    const rgb = want ?? [0, 0, 0];
    return { hex: toHex(rgb), rgb, name: "ink", brand: false };
  }
  // With no colour asked for, the darkest brand colour: it is what a wordmark is usually
  // set in and the one that still reads at a small size.
  let best = usable[0];
  let bestScore = Infinity;
  for (const p of usable) {
    const score = want ? deltaE76(labOf(...p.rgb), labOf(...want)) : labOf(...p.rgb)[0];
    if (score < bestScore) {
      bestScore = score;
      best = p;
    }
  }
  // A colour asked for that is nowhere near the brief keeps its own value rather than
  // being quietly snapped to something else.
  if (want && bestScore > 12) return { hex: toHex(want), rgb: want, name: "ink", brand: false };
  return { hex: best.hex, rgb: best.rgb, name: names.get(best.hex) ?? `colour-${palette.indexOf(best.hex) + 1}`, brand: true };
}

export async function makeText({ config, text, fontPath, name = null, size = 128, tracking = 0, colour = null, kerning = true, log = (s) => process.stderr.write(s) }) {
  if (!text || !String(text).trim()) throw new Error("text needs --string \"<the words>\"");
  if (!fontPath) throw new Error('text needs --font <file.ttf>: the letters are set from a real font, not drawn');
  const label = slug(name ?? String(text));
  const dir = path.join(config.out, label, "text");
  await mkdir(dir, { recursive: true });
  const opts = config.vector ?? {};
  const tokenPrefix = opts.tokenPrefix ?? "brand";

  const font = loadFont(await readFile(fontPath));
  // Place it where it will sit, rather than moving the path text afterwards: shifting a
  // path by rewriting its numbers means parsing them back out, and it threw away the
  // rounding on the way through.
  const pad = Math.max(1, Math.round(size * 0.06));
  const scale = size / font.unitsPerEm;
  // The canvas is the ink's own bounds joined with the advance box, not the advance box alone:
  // an italic f overhangs its advance, a j reaches left of its pen and a ring rises over the
  // ascender, and a canvas cut to the advances cropped them while calling the set exact.
  const probe = textPath(font, text, { size, letterSpacing: tracking, kerning, x: 0, y: font.ascender * scale });
  let ux0 = 0;
  let uy0 = 0;
  let ux1 = probe.width;
  let uy1 = probe.height;
  for (const poly of pathToPolygons(probe.d)) {
    for (const [x, y] of poly) {
      if (x < ux0) ux0 = x;
      if (y < uy0) uy0 = y;
      if (x > ux1) ux1 = x;
      if (y > uy1) uy1 = y;
    }
  }
  const set = textPath(font, text, { size, letterSpacing: tracking, kerning, x: pad - ux0, y: pad - uy0 + font.ascender * scale });
  const names = paletteNames(config.briefText);
  const fill = brandFill(colour, config.palette ?? [], names);
  const token = (n) => `${tokenPrefix}-${n}`;

  const w = Math.max(1, Math.ceil(ux1 - ux0) + pad * 2);
  const h = Math.max(1, Math.ceil(uy1 - uy0) + pad * 2);
  const d = set.d;

  const layers = [{ ...fill, d, rule: "nonzero", loops: (d.match(/M/g) ?? []).length, curves: (d.match(/C/g) ?? []).length }];
  const svg = svgText(layers, w, h, { title: label, token });

  // The one thing worth drawing back: that the path carries ink at all. A word that
  // parsed into nothing would otherwise be written out as a valid, empty SVG.
  const cov = coverage(pathToPolygons(d), w, h, { rule: "nonzero" });
  let on = 0;
  for (const v of cov) if (v > 0.5) on++;
  const inkShare = Math.round((on / (w * h)) * 1000) / 1000;

  const facts = {
    mode: "set from a font",
    font: path.basename(fontPath),
    unitsPerEm: font.unitsPerEm,
    text: String(text),
    glyphs: set.glyphs,
    size,
    tracking,
    kerning,
    width: w,
    height: h,
    loops: layers[0].loops,
    curves: layers[0].curves,
    bytes: Buffer.byteLength(svg),
    inkShare,
    missing: set.missing,
    blank: set.blank,
    verdict: set.missing.length || set.blank.length || !on ? "incomplete" : "exact",
  };

  const data = new Uint8Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = Math.min(1, cov[i]);
    if (a <= 0) continue;
    data[i * 4] = fill.rgb[0];
    data[i * 4 + 1] = fill.rgb[1];
    data[i * 4 + 2] = fill.rgb[2];
    data[i * 4 + 3] = Math.round(a * 255);
  }

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
  await writeFile(files.css, `:root {\n  --${token(fill.name)}: ${fill.hex};\n}\n`);
  await writeFile(files.drawable, androidText(layers, w, h, { token }));
  await writeFile(files.colours, androidColoursText([fill], { token }));
  await writeFile(files.render, encodePNG({ width: w, height: h, data }));

  const summary = {
    tool: "onmodel",
    kind: "text",
    name: label,
    dir,
    generatedAt: new Date().toISOString(),
    files,
    facts,
    tokens: [{ name: token(fill.name), hex: fill.hex, brand: fill.brand }],
  };
  await writeFile(path.join(dir, "text.json"), JSON.stringify(summary, null, 2));
  log(`  ${label}: "${text}" set in ${facts.font} at ${size}, ${facts.curves} curves, ${Math.round(facts.bytes / 102.4) / 10} KB, ${facts.verdict}\n`);
  if (set.missing.length) log(`  not in the font: ${set.missing.join(" ")}\n`);
  if (set.blank.length) log(`  in the font but drawn empty: ${set.blank.join(" ")}\n`);
  return summary;
}
