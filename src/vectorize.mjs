import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { resize } from "./key.mjs";
import { loadMark } from "./icons.mjs";
import { slug } from "./generate.mjs";
import { vectorize, paletteNames } from "./vector.mjs";
import { renderVectorHTML } from "./html.mjs";

/**
 * `onmodel vector`: a mark (a run's pick, a candidate or edit, or any PNG) traced into
 * an SVG with brand-named fills, an Android vector drawable with its colour resources,
 * and a CSS file of the tokens, then drawn back and measured against the source. It
 * calls no model and costs nothing. Art that is not flat is refused with the reason,
 * and the command exits 2 for a refusal or a poor match.
 */

const snake = (s) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "").toLowerCase();

export async function makeVector({ config, name = null, candidate = null, markPath = null, detail = null, log = (s) => process.stderr.write(s) }) {
  const { mark, file, transparent } = await loadMark({ config, name, candidate, markPath });
  const label = slug(name ?? path.basename(file).replace(/\.[^.]+$/, ""));
  const dir = path.join(config.out, label, "vector");
  await mkdir(dir, { recursive: true });
  const opts = config.vector ?? {};
  const tokenPrefix = opts.tokenPrefix ?? "brand";
  if (!transparent) log(`  the mark has no transparency, so its background will be traced as a shape; a keyed mark from generate traces better\n`);
  log(`  ${label}: tracing ${path.basename(file)} (${mark.width}x${mark.height})\n`);
  const started = Date.now();
  const v = vectorize(mark, {
    palette: config.palette,
    names: paletteNames(config.briefText),
    detail: detail ?? opts.detail ?? "normal",
    maxColours: opts.maxColours ?? 12,
    tokenPrefix,
    title: label,
    // a pixel-mode project's sprites are pixel art even when their edges are soft
    pixel: config.pixel ? true : null,
  });
  const summary = { tool: "onmodel", kind: "vector", name: label, dir, mark: file, markSize: { width: mark.width, height: mark.height }, generatedAt: new Date().toISOString(), ms: Date.now() - started };
  const sourceFile = path.join(dir, `${label}.source.png`);
  await writeFile(sourceFile, encodePNG(v.source ?? mark));
  summary.files = { source: sourceFile };
  if (v.refused) {
    summary.refused = v.refused;
    summary.facts = v.facts ?? null;
    log(`  refused: ${v.refused}\n`);
  } else {
    const base = path.join(dir, label);
    const files = {
      source: sourceFile,
      svg: `${base}.svg`,
      css: `${base}.tokens.css`,
      render: `${base}.render.png`,
      diff: `${base}.diff.png`,
      drawable: path.join(dir, "android", "drawable", `${snake(label)}.xml`),
      colours: path.join(dir, "android", "values", `${snake(tokenPrefix)}_colours.xml`),
    };
    await mkdir(path.dirname(files.drawable), { recursive: true });
    await mkdir(path.dirname(files.colours), { recursive: true });
    await writeFile(files.svg, v.svg);
    await writeFile(files.css, `:root {\n${v.tokens.map((t) => `  --${t.name}: ${t.hex};`).join("\n")}\n}\n`);
    await writeFile(files.drawable, v.android);
    await writeFile(files.colours, v.androidColours);
    // Pixel art is shown enlarged with hard pixels; a flat mark at its own size.
    const scale = v.facts.mode === "pixel" ? Math.max(1, Math.floor(256 / Math.max(v.render.width, v.render.height))) : 1;
    const up = (im) => (scale > 1 ? resize(im, im.width * scale, im.height * scale, { filter: "nearest" }) : im);
    await writeFile(files.render, encodePNG(up(v.render)));
    await writeFile(files.diff, encodePNG(up(v.diff)));
    if (scale > 1) await writeFile(sourceFile, encodePNG(up(v.source)));
    Object.assign(summary, { files, facts: v.facts, tokens: v.tokens, layers: v.layers.map(({ d, ...l }) => ({ ...l, pathBytes: d.length })), crop: v.crop });
    const f = v.facts;
    log(`  ${f.mode === "pixel" ? "pixel art, exact" : `${f.colours} colours, ${f.curves} curves`}: silhouette ${f.silhouette}, colour kept ${Math.round(f.colourKept * 1000) / 10}%, drift ${f.drift}, ${Math.round(f.bytes / 102.4) / 10} KB, ${f.verdict}\n`);
  }
  await writeFile(path.join(dir, "vector.json"), JSON.stringify(summary, null, 2));
  const htmlPath = path.join(dir, "vector.html");
  await writeFile(htmlPath, renderVectorHTML(summary, dir));
  return { ...summary, htmlPath };
}
