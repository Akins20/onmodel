import { readFile, readdir, access } from "node:fs/promises";
import path from "node:path";
import { decodeImage } from "./image.mjs";
import { checkIcon, STORE_TARGETS } from "./rules.mjs";
import { icoInfo } from "./ico.mjs";

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

  return results;
}

/** The failures across a set of run results, each tagged with its run and file. */
export function failuresOf(results) {
  const fails = [];
  for (const r of results) for (const f of r.files) for (const c of f.checks) if (!c.ok && !c.warn) fails.push({ kind: r.kind, name: r.name, file: f.rel, check: c.check, detail: c.detail });
  return fails;
}
