import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { decodeImage } from "./image.mjs";
import { checkIcon, STORE_TARGETS } from "./rules.mjs";
import { icoInfo } from "./ico.mjs";
import { seam } from "./tile.mjs";
import { pathToPolygons } from "./vector.mjs";

/**
 * A no-API gate: re-read what a run already wrote and hold it to the same rules,
 * so a store or a launcher never finds the problem first. It calls nothing, costs
 * nothing, and decodes every raster from disk rather than trusting the verdicts
 * recorded when it was made, so a file edited, re-exported or corrupted since is
 * caught. Icons and store graphics carry hard platform rules and are re-checked in
 * full; generated images and sprite atlases have no platform rule, so they are
 * checked for the lighter promise that they still decode at their recorded size.
 *
 * Files are found under the folder their summary sits in, never at the path written
 * when they were made: that path belongs to the machine and folder that made them,
 * so a run committed to a repository, copied, or checked on a CI runner still works.
 *
 * Returns one entry per output set with each file's re-run checks; the caller counts
 * the failures and sets the exit code.
 */

const isRaster = (p) => /\.(png|jpe?g)$/i.test(p);

/** Each summary and the subfolder of a run it is written to (icons/, sprites/, store/). */
const LAYOUT = [
  ["generate.json", null],
  ["icons.json", "icons"],
  ["sprites.json", "sprites"],
  ["store.json", "store"],
  ["vector.json", "vector"],
  ["text.json", "text"],
  ["lockup.json", "lockup"],
  ["tile.json", "tile"],
  ["normal.json", "normal"],
];

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

/** The folder holding a summary: the kind's subfolder of a run, or the folder given itself. */
async function locate(dir, file, sub) {
  for (const base of sub ? [path.join(dir, sub), dir] : [dir]) if (await exists(path.join(base, file))) return base;
  return null;
}

/**
 * The places a recorded file may be, under the folder its summary sits in: its
 * recorded relative path, its own name beside the summary, or its path relative to
 * the folder the summary recorded (older runs that kept files in a subfolder).
 */
function candidatesFor(base, { rel = null, recorded = null, summaryDir = null }) {
  const tries = [];
  if (rel) tries.push(path.join(base, ...String(rel).split(/[\\/]/)));
  if (recorded) {
    tries.push(path.join(base, String(recorded).split(/[\\/]/).pop()));
    if (summaryDir) {
      const r = path.relative(summaryDir, recorded);
      if (r && !r.startsWith("..") && !path.isAbsolute(r)) tries.push(path.join(base, r));
    }
  }
  return [...new Set(tries)];
}

/** Re-reads one file (the first of its candidate places that exists) and applies its rule. */
export async function recheckFile(file, rule = null) {
  const tries = Array.isArray(file) ? file : [file];
  let chosen = tries[0];
  let buffer = null;
  for (const f of tries) {
    try {
      buffer = await readFile(f);
      chosen = f;
      break;
    } catch {
      // try the next place
    }
  }
  if (!buffer) return { file: chosen, error: "missing", checks: [{ check: "present", ok: false, detail: `not on disk under the run folder (${path.basename(chosen)})` }] };
  if (rule?.ico) {
    try {
      const sizes = icoInfo(buffer).map((e) => e.width);
      return { file: chosen, bytes: buffer.length, checks: [{ check: "sizes", ok: rule.ico.every((s) => sizes.includes(s)), detail: `holds ${sizes.join(", ")} px; needs ${rule.ico.join(", ")}` }] };
    } catch (err) {
      return { file: chosen, bytes: buffer.length, error: `not a valid ICO: ${err.message}`, checks: [{ check: "decodes", ok: false, detail: err.message }] };
    }
  }
  let image;
  try {
    image = decodeImage(buffer);
  } catch (err) {
    return { file: chosen, bytes: buffer.length, error: `will not decode: ${err.message}`, checks: [{ check: "decodes", ok: false, detail: err.message }] };
  }
  return { file: chosen, bytes: buffer.length, width: image.width, height: image.height, checks: rule ? checkIcon(image, buffer.length, rule, buffer) : [] };
}

/**
 * Re-reads an SVG and holds it to what was recorded. There is no decoder to lean on here,
 * so the test is that every path still parses into real geometry and that the canvas is
 * still the size the run said: a file truncated, hand-edited or re-exported by a tool that
 * dropped a path fails both.
 */
export async function recheckSVG(file, { width = null, height = null } = {}) {
  const tries = Array.isArray(file) ? file : [file];
  let chosen = tries[0];
  let text = null;
  for (const f of tries) {
    try {
      text = await readFile(f, "utf8");
      chosen = f;
      break;
    } catch {
      // try the next place
    }
  }
  if (text == null) return { file: chosen, error: "missing", checks: [{ check: "present", ok: false, detail: `not on disk under the run folder (${path.basename(chosen)})` }] };
  const checks = [];
  const box = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(text);
  if (width != null && height != null) {
    const got = box ? `${Number(box[1])}x${Number(box[2])}` : "no viewBox";
    checks.push({ check: "size", ok: Boolean(box) && Number(box[1]) === width && Number(box[2]) === height, detail: `${got}; was ${width}x${height}` });
  }
  const ds = [...text.matchAll(/ d="([^"]*)"/g)].map((m) => m[1]);
  checks.push({ check: "paths", ok: ds.length > 0, detail: `${ds.length} path${ds.length === 1 ? "" : "s"}` });
  let points = 0;
  let bad = null;
  for (const d of ds) {
    try {
      for (const poly of pathToPolygons(d)) points += poly.length;
    } catch (err) {
      bad = err.message;
      break;
    }
  }
  checks.push({ check: "geometry", ok: !bad && points > 0, detail: bad ?? `${points} points` });
  return { file: chosen, bytes: Buffer.byteLength(text), checks };
}

/** Finds the run directories under an output dir: the ones holding a summary, directly or in a kind's subfolder. */
export async function findRuns(outDir) {
  let entries;
  try {
    entries = await readdir(outDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const d = path.join(outDir, e.name);
    for (const [file, sub] of LAYOUT) {
      if (await locate(d, file, sub)) {
        dirs.push(d);
        break;
      }
    }
  }
  return dirs.sort();
}

/** A summary: null when absent, { data } when read, { error } when present but unreadable. */
async function readSummary(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    return err.code === "ENOENT" ? null : { error: err.message };
  }
  try {
    return { data: JSON.parse(text) };
  } catch (err) {
    return { error: `not valid JSON: ${err.message}` };
  }
}

/** Re-checks every output in one run directory against the rules that made it. */
export async function checkRun({ dir }) {
  const results = [];
  const load = async (file, sub) => {
    const base = await locate(dir, file, sub);
    if (!base) return null;
    const s = await readSummary(path.join(base, file));
    if (s?.error) {
      results.push({ kind: file.replace(".json", ""), name: path.basename(dir), dir: base, files: [{ rel: file, error: s.error, checks: [{ check: "summary", ok: false, detail: `could not be read: ${s.error}` }] }] });
      return null;
    }
    return s ? { base, data: s.data } : null;
  };

  const icons = await load("icons.json", "icons");
  if (icons) {
    const { base, data } = icons;
    const files = [];
    for (const f of data.files ?? []) {
      if (!isRaster(f.rel) && !f.rule?.ico) continue;
      const r = await recheckFile(candidatesFor(base, { rel: f.rel }), f.rule ?? null);
      // An icon made before onmodel recorded each icon's rule has nothing to be held to;
      // that is a gap to close, not a pass.
      if (!f.rule) r.checks = [...r.checks, { check: "rule", ok: false, detail: "made before onmodel recorded each icon's rule; run `onmodel icons` again to record them" }];
      files.push({ rel: f.rel, ...r });
    }
    results.push({ kind: "icons", name: data.name, dir: base, files });
  }

  const store = await load("store.json", "store");
  if (store) {
    const { base, data } = store;
    const files = [];
    for (const c of data.candidates ?? []) {
      for (const t of c.files?.targets ?? []) {
        const rule = { width: t.width, height: t.height, opaque: true, maxBytes: STORE_TARGETS[t.key]?.maxBytes };
        files.push({ rel: t.rel ?? String(t.file).split(/[\\/]/).pop(), target: t.key, ...(await recheckFile(candidatesFor(base, { rel: t.rel, recorded: t.file, summaryDir: data.dir }), rule)) });
      }
    }
    results.push({ kind: "store", name: data.name, dir: base, files });
  }

  // generate.json is also written by a store run (kind "store"); don't re-count it.
  const gen = await load("generate.json", null);
  if (gen && gen.data.kind !== "store") {
    const { base, data } = gen;
    const files = [];
    for (const c of data.candidates ?? []) {
      for (const o of c.files?.outputs ?? []) {
        files.push({ rel: String(o.file).split(/[\\/]/).pop(), ...(await recheckFile(candidatesFor(base, { recorded: o.file, summaryDir: data.dir }), { width: o.width, height: o.height })) });
      }
    }
    if (files.length) results.push({ kind: data.kind || "generate", name: data.name, dir: base, files });
  }

  const sprites = await load("sprites.json", "sprites");
  if (sprites?.data.atlas?.image) {
    const { base, data } = sprites;
    const file = { rel: String(data.atlas.image).split(/[\\/]/).pop(), ...(await recheckFile(candidatesFor(base, { recorded: data.atlas.image, summaryDir: data.dir }), { width: data.atlas.width, height: data.atlas.height })) };
    results.push({ kind: "sprites", name: data.name, dir: base, files: [file] });
  }

  // A traced or set mark: the SVG is the deliverable, so it is the SVG that is re-read.
  for (const [file, kind] of [["vector.json", "vector"], ["text.json", "text"], ["lockup.json", "lockup"]]) {
    const run = await load(file, kind);
    if (!run?.data?.files?.svg) continue;
    const { base, data } = run;
    const f = data.facts ?? {};
    const rel = String(data.files.svg).split(/[\/]/).pop();
    const files = [{ rel, ...(await recheckSVG(candidatesFor(base, { rel, recorded: data.files.svg, summaryDir: data.dir }), { width: f.width ?? null, height: f.height ?? null })) }];
    if (data.files.render) {
      const r = String(data.files.render).split(/[\/]/).pop();
      files.push({ rel: r, ...(await recheckFile(candidatesFor(base, { rel: r, recorded: data.files.render, summaryDir: data.dir }), f.width && f.height ? { width: f.width, height: f.height } : null)) });
    }
    results.push({ kind, name: data.name, dir: base, files });
  }

  // A tile is the one output whose correctness is a measurement rather than a format, so
  // the measurement is taken again rather than the recorded verdict being believed.
  const tile = await load("tile.json", "tile");
  if (tile?.data?.files?.tile) {
    const { base, data } = tile;
    const f = data.facts ?? {};
    const rel = String(data.files.tile).split(/[\/]/).pop();
    const got = await recheckFile(candidatesFor(base, { rel, recorded: data.files.tile, summaryDir: data.dir }), f.width && f.height ? { width: f.width, height: f.height } : null);
    if (!got.error) {
      const buffer = await readFile(got.file);
      const now = seam(decodeImage(buffer));
      got.checks = [...got.checks, { check: "tiles", ok: now.ratio <= 1.5, detail: `the join is ${now.ratio}x the texture's own grain${f.verdict ? `; the run left it ${f.verdict}` : ""}` }];
    }
    const files = [{ rel, ...got }];
    if (data.files.normal) {
      const r = String(data.files.normal).split(/[\/]/).pop();
      files.push({ rel: r, ...(await recheckNormal(candidatesFor(base, { rel: r, recorded: data.files.normal, summaryDir: data.dir }), { wrap: true })) });
    }
    results.push({ kind: "tile", name: data.name, dir: base, files });
  }

  const normal = await load("normal.json", "normal");
  if (normal?.data?.files?.normal) {
    const { base, data } = normal;
    const f = data.facts ?? {};
    const rel = String(data.files.normal).split(/[\/]/).pop();
    const got = await recheckNormal(candidatesFor(base, { rel, recorded: data.files.normal, summaryDir: data.dir }), { wrap: Boolean(f.wrap) });
    results.push({ kind: "normal", name: data.name, dir: base, files: [{ rel, ...got }] });
  }

  return results;
}

/**
 * Re-reads a normal map and checks it is still one. Every pixel must decode to something
 * close to a unit vector pointing out of the surface; a map that has been resized with a
 * smoothing filter, recompressed as JPEG, or had its channels swapped stops satisfying
 * that long before it looks wrong to a person.
 */
export async function recheckNormal(file, { wrap = false } = {}) {
  const got = await recheckFile(file, null);
  if (got.error) return got;
  const buffer = await readFile(got.file);
  const image = decodeImage(buffer);
  let worst = 0;
  let backwards = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4;
    const x = image.data[p] / 127.5 - 1;
    const y = image.data[p + 1] / 127.5 - 1;
    const z = image.data[p + 2] / 127.5 - 1;
    const len = Math.hypot(x, y, z);
    if (Math.abs(len - 1) > worst) worst = Math.abs(len - 1);
    if (z <= 0) backwards++;
  }
  const checks = [
    { check: "unit", ok: worst <= 0.12, detail: `the worst normal is ${Math.round(worst * 1000) / 1000} off unit length` },
    { check: "outward", ok: backwards === 0, detail: backwards ? `${backwards} pixels point into the surface` : "every normal points out of the surface" },
  ];
  if (wrap) {
    const now = seam(image);
    checks.push({ check: "tiles", ok: now.ratio <= 1.5, detail: `the join is ${now.ratio}x its own grain` });
  }
  return { ...got, checks: [...got.checks, ...checks] };
}

/** The failures across a set of run results, each tagged with its run and file. */
export function failuresOf(results) {
  const fails = [];
  for (const r of results) for (const f of r.files) for (const c of f.checks) if (!c.ok && !c.warn) fails.push({ kind: r.kind, name: r.name, file: f.rel, check: c.check, detail: c.detail });
  return fails;
}
