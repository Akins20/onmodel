import { readFile, readdir } from "node:fs/promises";
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
 * Returns one entry per run with each file's re-run checks; the caller counts the
 * failures and sets the exit code.
 */

const isRaster = (p) => /\.(png|jpe?g)$/i.test(p);
const SUMMARIES = ["icons.json", "store.json", "sprites.json", "generate.json"];

/** Re-reads one file and applies its rule, or reports why it could not be read. */
export async function recheckFile(file, rule = null) {
  let buffer;
  try {
    buffer = await readFile(file);
  } catch (err) {
    return { file, error: `missing (${err.code ?? err.message})`, checks: [{ check: "present", ok: false, detail: "the recorded file is not on disk" }] };
  }
  if (rule?.ico) {
    try {
      const sizes = icoInfo(buffer).map((e) => e.width);
      return { file, bytes: buffer.length, checks: [{ check: "sizes", ok: rule.ico.every((s) => sizes.includes(s)), detail: `holds ${sizes.join(", ")} px; needs ${rule.ico.join(", ")}` }] };
    } catch (err) {
      return { file, bytes: buffer.length, error: `not a valid ICO: ${err.message}`, checks: [{ check: "decodes", ok: false, detail: err.message }] };
    }
  }
  let image;
  try {
    image = decodeImage(buffer);
  } catch (err) {
    return { file, bytes: buffer.length, error: `will not decode: ${err.message}`, checks: [{ check: "decodes", ok: false, detail: err.message }] };
  }
  return { file, bytes: buffer.length, width: image.width, height: image.height, checks: rule ? checkIcon(image, buffer.length, rule) : [] };
}

/** Finds the run directories under an output dir: the ones holding a summary. */
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
    const names = await readdir(d).catch(() => []);
    if (names.some((n) => SUMMARIES.includes(n))) dirs.push(d);
  }
  return dirs.sort();
}

/** Re-checks every output in one run directory against the rules that made it. */
export async function checkRun({ dir }) {
  const read = async (name) => {
    try {
      return JSON.parse(await readFile(path.join(dir, name), "utf8"));
    } catch {
      return null;
    }
  };
  const results = [];

  const icons = await read("icons.json");
  if (icons) {
    const files = [];
    for (const f of icons.files ?? []) {
      if (!isRaster(f.rel) && !f.rule?.ico) continue;
      files.push({ rel: f.rel, ...(await recheckFile(f.path ?? path.join(dir, f.rel), f.rule ?? null)) });
    }
    results.push({ kind: "icons", name: icons.name, dir, files });
  }

  const store = await read("store.json");
  if (store) {
    const files = [];
    for (const c of store.candidates ?? []) {
      for (const t of c.files?.targets ?? []) {
        const rule = { width: t.width, height: t.height, opaque: true, maxBytes: STORE_TARGETS[t.key]?.maxBytes };
        files.push({ rel: path.basename(t.file), target: t.key, ...(await recheckFile(t.file, rule)) });
      }
    }
    results.push({ kind: "store", name: store.name, dir, files });
  }

  // generate.json is also written by a store run (kind "store"); don't re-count it.
  const gen = await read("generate.json");
  if (gen && gen.kind !== "store") {
    const files = [];
    for (const c of gen.candidates ?? []) {
      for (const o of c.files?.outputs ?? []) {
        files.push({ rel: path.basename(o.file), ...(await recheckFile(o.file, { width: o.width, height: o.height })) });
      }
    }
    if (files.length) results.push({ kind: gen.kind || "generate", name: gen.name, dir, files });
  }

  const sprites = await read("sprites.json");
  if (sprites?.atlas?.image) {
    const file = { rel: path.basename(sprites.atlas.image), ...(await recheckFile(sprites.atlas.image, { width: sprites.atlas.width, height: sprites.atlas.height })) };
    results.push({ kind: "sprites", name: sprites.name, dir, files: [file] });
  }

  return results;
}

/** The failures across a set of run results, each tagged with its run and file. */
export function failuresOf(results) {
  const fails = [];
  for (const r of results) for (const f of r.files) for (const c of f.checks) if (!c.ok && !c.warn) fails.push({ kind: r.kind, name: r.name, file: f.rel, check: c.check, detail: c.detail });
  return fails;
}
