import { readFile, readdir, access } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { decodeImage } from "./image.mjs";
import { checkIcon, STORE_TARGETS } from "./rules.mjs";
import { icoInfo } from "./ico.mjs";
import { seam } from "./tile.mjs";
import { pathToPolygons } from "./vector.mjs";
import { MODES, variants, layout, adjacencyReport, coverage } from "./terrain.mjs";
import { verifyTrim } from "./trim.mjs";
import { bandSmear, findBand, readAndroidNinePatch } from "./ninepatch.mjs";
import { parseFnt } from "./bmfont.mjs";

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
/** Either path separator, so a summary written on Windows is read anywhere and the other way round. */
const SEP = /[\\/]/;

/** Each summary and the subfolder of a run it is written to (icons/, sprites/, store/). */
const LAYOUT = [
  ["generate.json", null],
  ["icons.json", "icons"],
  ["sprites.json", "sprites"],
  ["atlas.json", "atlas"],
  ["ninepatch.json", "ninepatch"],
  ["bitmapfont.json", "bitmapfont"],
  ["store.json", "store"],
  ["vector.json", "vector"],
  ["text.json", "text"],
  ["lockup.json", "lockup"],
  ["tile.json", "tile"],
  ["normal.json", "normal"],
  ["terrain.json", "terrain"],
  ["shape.json", "shape"],
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

/** The first of a file's candidate places that reads as text, or the "missing" result. */
async function readText(file) {
  const tries = Array.isArray(file) ? file : [file];
  for (const f of tries) {
    try {
      return { file: f, text: await readFile(f, "utf8") };
    } catch {
      // try the next place
    }
  }
  return { file: tries[0], error: "missing", checks: [{ check: "present", ok: false, detail: `not on disk under the run folder (${path.basename(tries[0])})` }] };
}

const vectors = (list) => {
  const n = list.split(",").map((v) => Number(v.trim()));
  const pts = [];
  for (let i = 0; i + 1 < n.length; i += 2) pts.push([n[i], n[i + 1]]);
  return { pts, ok: n.length % 2 === 0 && n.every(Number.isFinite) };
};

/**
 * Re-reads a terrain TileSet and holds every cell's peering bits to the shape drawn there.
 * Which shape sits at which cell is arithmetic from the mode and the column count, so a
 * bit added, dropped or moved by hand in the .tres is caught: it is exactly the error that
 * looks fine in the editor and tears a hole in the map later.
 */
export async function recheckTileSet(file, expected = null, cellSize = null) {
  const got = await readText(file);
  if (got.error) return got;
  const { text } = got;
  const modeNum = /terrain_set_0\/mode = (\d+)/.exec(text);
  const mode = modeNum ? Object.keys(MODES).find((k) => MODES[k] === Number(modeNum[1])) ?? null : null;
  const tiles = [...text.matchAll(/^(\d+):(\d+)\/0 = 0$/gm)].map((m) => `${m[1]}:${m[2]}`);
  const bits = new Map(tiles.map((t) => [t, []]));
  for (const m of text.matchAll(/^(\d+):(\d+)\/0\/terrains_peering_bit\/(\w+) = 0$/gm)) bits.get(`${m[1]}:${m[2]}`)?.push(m[3]);
  // A tile that is not in the terrain is never chosen by the painter, however right its
  // bits are, so both lines that put it there are needed.
  const inSet = new Set([...text.matchAll(/^(\d+):(\d+)\/0\/terrain_set = 0$/gm)].map((m) => `${m[1]}:${m[2]}`));
  const inTerrain = new Set([...text.matchAll(/^(\d+):(\d+)\/0\/terrain = 0$/gm)].map((m) => `${m[1]}:${m[2]}`));
  const checks = [{ check: "terrain", ok: Boolean(mode), detail: mode ? `a terrain set in ${mode} mode` : "no terrain set the tool knows is declared" }];
  if (cellSize) {
    const region = /texture_region_size = Vector2i\((\d+), (\d+)\)/.exec(text);
    const ok = Boolean(region) && Number(region[1]) === cellSize && Number(region[2]) === cellSize;
    checks.push({ check: "region", ok, detail: region ? `${region[1]}x${region[2]} tiles; the atlas is cut in ${cellSize}px cells` : "no tile size declared" });
  }
  if (mode && tiles.length) {
    const plan = layout(mode, Math.max(...tiles.map((t) => Number(t.split(":")[0]))) + 1);
    let wrong = 0;
    for (const c of plan.cells) {
      const have = bits.get(`${c.col}:${c.row}`);
      if (!have || have.slice().sort().join() !== c.bits.slice().sort().join()) wrong++;
    }
    const outside = tiles.filter((t) => !inSet.has(t) || !inTerrain.has(t)).length;
    checks.push(
      { check: "tiles", ok: tiles.length === plan.cells.length && (expected == null || tiles.length === expected), detail: `${tiles.length} tiles declared; ${mode} mode needs ${plan.cells.length}` },
      { check: "painted", ok: outside === 0, detail: outside ? `${outside} tiles are not in the terrain, so the painter never uses them` : "every tile is in the terrain" },
      { check: "bits", ok: wrong === 0, detail: wrong ? `${wrong} cells declare different peering bits from the shape drawn there` : "every cell declares the bits of the shape drawn there" },
    );
  } else if (mode) {
    checks.push({ check: "tiles", ok: false, detail: "no tiles declared" });
  }
  return { file: got.file, bytes: Buffer.byteLength(text), checks };
}

/** Re-reads a shape's points file: the shapes still parse and are what the run reported. */
export async function recheckPoints(file, facts = {}) {
  const got = await readText(file);
  if (got.error) return got;
  const shapes = [...got.text.matchAll(/PackedVector2Array\(([^)]*)\)/g)].map((m) => vectors(m[1]));
  const total = shapes.reduce((t, s) => t + s.pts.length, 0);
  const checks = [
    { check: "parses", ok: shapes.length > 0 && shapes.every((s) => s.ok && s.pts.length >= 3), detail: `${shapes.length} shape${shapes.length === 1 ? "" : "s"}, ${total} points` },
    { check: "shapes", ok: facts.shapes == null || (shapes.length === facts.shapes && total === facts.points), detail: `the run reported ${facts.shapes ?? "?"} shapes and ${facts.points ?? "?"} points` },
    { check: "budget", ok: facts.budget == null || shapes.every((s) => s.pts.length <= facts.budget), detail: `the most points in one shape is ${Math.max(0, ...shapes.map((s) => s.pts.length))}; the budget was ${facts.budget ?? "not recorded"}` },
  ];
  return { file: got.file, bytes: Buffer.byteLength(got.text), checks, first: shapes[0]?.pts ?? null };
}

/** Re-reads an OccluderPolygon2D and holds it to the first shape in the points file. */
export async function recheckOccluder(file, first = null) {
  const got = await readText(file);
  if (got.error) return got;
  const m = /^polygon = PackedVector2Array\(([^)]*)\)$/m.exec(got.text);
  const poly = m ? vectors(m[1]) : null;
  const same = Boolean(poly && first) && poly.pts.length === first.length && poly.pts.every(([x, y], i) => Math.abs(x - first[i][0]) < 0.01 && Math.abs(y - first[i][1]) < 0.01);
  const checks = [
    { check: "parses", ok: Boolean(poly?.ok) && poly.pts.length >= 3, detail: poly ? `${poly.pts.length} points` : "no polygon in it" },
    ...(first ? [{ check: "matches", ok: same, detail: same ? "the same points as the first shape" : "differs from the first shape in the points file" }] : []),
  ];
  return { file: got.file, bytes: Buffer.byteLength(got.text), checks };
}

/**
 * Re-reads a trimmed atlas and everything that records where its frames sat, and puts
 * every frame back. The untrimmed grid is written beside the atlas (for the CSS), so the
 * frames can be restored from the JSON on disk and compared with their cells pixel for
 * pixel; the Godot margins and the C header are each held to the same record, so a hand
 * edit to one of them fails that file. The grid is a recorded output like the rest (onmodel atlas
 * packs a trimmed run again from it), so a missing one fails as missing; the other files are
 * still held to each other, which is said.
 */
export async function recheckTrimmed(a, at) {
  const files = [];
  const json = await readText(at(a.json));
  if (json.error) return [{ rel: String(a.json).split(/[\\/]/).pop(), ...json }];
  let frames;
  try {
    frames = JSON.parse(json.text).frames;
  } catch (err) {
    return [{ rel: path.basename(json.file), file: json.file, error: "not JSON", checks: [{ check: "parses", ok: false, detail: err.message }] }];
  }
  const { width: fw, height: fh } = a.frame;
  // Where each frame's cell sits in the grid: one action per row, frames left to right.
  const placements = [];
  a.actions.forEach((act, row) => {
    for (let i = act.from; i <= act.to; i++) {
      const name = `${act.name}_${i - act.from}`;
      const f = frames?.[name];
      if (!f) continue;
      placements.push({ name, index: i, x: f.frame.x, y: f.frame.y, width: f.frame.w, height: f.frame.h, cellX: (i - act.from) * fw, cellY: row * fh, trim: { x: f.spriteSourceSize.x, y: f.spriteSourceSize.y, sourceW: fw, sourceH: fh } });
    }
  });
  const expected = a.actions.reduce((t, x) => t + x.to - x.from + 1, 0);
  // Phaser and PixiJS restore a frame only when it says it was trimmed; one marked untrimmed
  // is drawn at the cell's corner, so every frame of the action jitters.
  const unmarked = placements.filter((p) => frames[p.name]?.trimmed !== true).length;
  // Engines size each frame from its sourceSize, so one that misstates the cell draws that frame
  // somewhere else; and none of onmodel's frames is rotated.
  const missized = placements.filter((p) => frames[p.name]?.sourceSize?.w !== fw || frames[p.name]?.sourceSize?.h !== fh).length;
  const rotated = placements.filter((p) => frames[p.name]?.rotated).length;
  const jsonChecks = [
    { check: "frames", ok: placements.length === expected, detail: `${placements.length} of the ${expected} frames are in the JSON` },
    { check: "trimmed", ok: unmarked === 0, detail: unmarked ? `${unmarked} frames are not marked trimmed, so Phaser and PixiJS draw them at the cell's corner` : "every frame is marked trimmed" },
    { check: "cells", ok: missized === 0 && rotated === 0, detail: missized || rotated ? `${missized} frames state a cell other than ${fw}x${fh} and ${rotated} say they are rotated` : `every frame's cell is ${fw}x${fh}, unrotated` },
  ];
  const cells = a.cells ? await recheckFile(at(a.cells), a.trim ? { width: a.trim.gridWidth, height: a.trim.gridHeight } : null) : null;
  if (cells && !cells.error && cells.checks.every((c) => c.ok)) {
    const atlas = await recheckFile(at(a.image), null);
    if (!atlas.error) {
      const v = verifyTrim(decodeImage(await readFile(atlas.file)), placements, decodeImage(await readFile(cells.file)), { alpha: a.trim?.alpha ?? 1 });
      jsonChecks.push({
        check: "restores",
        ok: v.moved === 0 && v.lost === 0,
        detail: v.moved ? `${v.moved} frames do not come back where they were (the record, the atlas or the grid was changed): ${v.wrong.join("; ")}` : v.lost ? `${v.lost} visible pixels were cut` : "every frame comes back exactly where it was in its cell",
      });
    }
  } else {
    jsonChecks.push({ check: "restores", ok: true, warn: true, detail: "the untrimmed grid is not beside the atlas, so frames are checked against each other's records only" });
  }
  files.push({ rel: path.basename(json.file), file: json.file, bytes: Buffer.byteLength(json.text), checks: jsonChecks });
  if (cells) files.push({ rel: String(a.cells).split(/[\\/]/).pop(), ...cells });

  // The Godot margins: region plus margin must be the cell, with the pixels where the JSON says.
  const tres = await readText(at(a.godot));
  if (tres.error) files.push({ rel: String(a.godot).split(/[\\/]/).pop(), ...tres });
  else {
    const blocks = new Map();
    for (const m of tres.text.matchAll(/\[sub_resource type="AtlasTexture" id="AtlasTexture_(\d+)"\]\r?\n(?:[^[]*?)region = Rect2\(([^)]*)\)(?:\r?\nmargin = Rect2\(([^)]*)\))?/g)) {
      blocks.set(Number(m[1]), { region: m[2].split(",").map(Number), margin: m[3] ? m[3].split(",").map(Number) : [0, 0, 0, 0] });
    }
    let wrong = 0;
    for (const p of placements) {
      const b = blocks.get(p.index);
      const want = [p.x, p.y, p.width, p.height].join();
      const margin = [p.trim.x, p.trim.y, p.trim.sourceW - p.width, p.trim.sourceH - p.height].join();
      if (!b || b.region.join() !== want || b.margin.join() !== margin) wrong++;
    }
    const texture = /\[ext_resource type="Texture2D" path="([^"]+)" id="1_atlas"\]/.exec(tres.text)?.[1] ?? "";
    const atlasName = String(a.image).split(SEP).pop();
    const order = [...tres.text.matchAll(/"texture": SubResource\("AtlasTexture_(\d+)"\)/g)].map((m) => Number(m[1]));
    const inOrder = order.length === expected && order.every((v, k) => v === k);
    files.push({
      rel: path.basename(tres.file),
      file: tres.file,
      bytes: Buffer.byteLength(tres.text),
      checks: [
        { check: "margins", ok: wrong === 0 && blocks.size === expected, detail: wrong ? `${wrong} frames' region or margin disagree with the JSON, so Godot draws them somewhere else` : `${blocks.size} frames, each restored to its ${fw}x${fh} cell` },
        { check: "texture", ok: texture.endsWith(`/${atlasName}`), detail: `the frames are cut from ${texture || "nothing"}; the atlas is ${atlasName}` },
        { check: "order", ok: inOrder, detail: inOrder ? "every animation walks its frames in order" : "the animations no longer walk the frames in the atlas's order" },
      ],
    });
  }

  // The C header: each row is x, y, w, h, ox, oy, sw, sh in frame order.
  const h = await readText(at(a.header));
  if (h.error) files.push({ rel: String(a.header).split(/[\\/]/).pop(), ...h });
  else {
    const table = /_FRAMES\[\d+\] = \{([\s\S]*?)\};/.exec(h.text);
    const rows = table ? [...table[1].matchAll(/\{([^}]*)\}/g)].map((m) => m[1].split(",").map((v) => Number(v.trim()))) : [];
    const byIndex = new Map(placements.map((p) => [p.index, p]));
    let wrong = 0;
    rows.forEach((r, i) => {
      const p = byIndex.get(i);
      if (!p || r.join() !== [p.x, p.y, p.width, p.height, p.trim.x, p.trim.y, p.trim.sourceW, p.trim.sourceH].join()) wrong++;
    });
    const cw = Number((/_FRAME_W = (\d+);/.exec(h.text) ?? [])[1]);
    const ch = Number((/_FRAME_H = (\d+);/.exec(h.text) ?? [])[1]);
    files.push({
      rel: path.basename(h.file),
      file: h.file,
      bytes: Buffer.byteLength(h.text),
      checks: [
        { check: "offsets", ok: rows.length === expected && wrong === 0, detail: wrong || rows.length !== expected ? `${wrong} of ${rows.length} rows disagree with the JSON (${expected} frames expected)` : `${rows.length} rows, each with the offset that puts it back` },
        { check: "cell", ok: cw === fw && ch === fh, detail: `FRAME_W ${cw}, FRAME_H ${ch}; the cells are ${fw}x${fh}` },
      ],
    });
  }
  return files;
}

/**
 * Holds a sprite pivot to the point the run recorded: every JSON frame's `pivot` and `anchor`,
 * normalised to its cell, and the header's PIVOT_X and PIVOT_Y. Phaser resets a sprite's origin
 * from the JSON pivot on every animation frame, so one edited by hand moves the sprite.
 */
export async function recheckPivot(a, at) {
  const out = [];
  const json = await readText(at(a.json));
  if (!json.error) {
    let frames = {};
    try {
      frames = JSON.parse(json.text).frames ?? {};
    } catch {
      frames = {};
    }
    let wrong = 0;
    let count = 0;
    for (const f of Object.values(frames)) {
      count++;
      const w = f.sourceSize?.w ?? a.frame.width;
      const h = f.sourceSize?.h ?? a.frame.height;
      const want = { x: Math.round((a.pivot.x / w) * 10000) / 10000, y: Math.round((a.pivot.y / h) * 10000) / 10000 };
      for (const key of ["pivot", "anchor"]) if (f[key]?.x !== want.x || f[key]?.y !== want.y) wrong++;
    }
    out.push({ rel: `${path.basename(json.file)} (pivot)`, file: json.file, checks: [{ check: "pivot", ok: count > 0 && wrong === 0, detail: wrong ? `${wrong} pivot or anchor values differ from the recorded pivot (${a.pivot.x}, ${a.pivot.y})` : `every frame's pivot and anchor put it at (${a.pivot.x}, ${a.pivot.y})` }] });
  }
  const h = await readText(at(a.header));
  if (!h.error) {
    const px = Number((/_PIVOT_X = ([-\d.]+)f;/.exec(h.text) ?? [])[1]);
    const py = Number((/_PIVOT_Y = ([-\d.]+)f;/.exec(h.text) ?? [])[1]);
    const ok = px === Number(Number(a.pivot.x).toFixed(1)) && py === Number(Number(a.pivot.y).toFixed(1));
    out.push({ rel: `${path.basename(h.file)} (pivot)`, file: h.file, checks: [{ check: "pivot", ok, detail: `PIVOT_X ${px}, PIVOT_Y ${py}; recorded (${a.pivot.x}, ${a.pivot.y})` }] });
  }
  return out;
}

/**
 * Re-reads a nine-patch: the art still stretches where the run said (each band measured
 * again on the pixels, so detail painted into a band since is caught), the .9.png's border
 * is still one Android will compile and marks the same insets around the same art, and the
 * StyleBoxTexture still holds the same margins.
 */
export async function recheckNinePatch(data, at) {
  const f = data.facts ?? {};
  const ins = f.insets ?? {};
  const pad = f.content ?? ins;
  const files = [];
  const art = await recheckFile(at(data.files.image), f.width && f.height ? { width: f.width, height: f.height } : null);
  let image = null;
  if (!art.error) {
    image = decodeImage(await readFile(art.file));
    const bands = [];
    for (const [axis, a, start, end] of [["x", f.across, ins.left, (f.width ?? 0) - ins.right], ["y", f.down, ins.top, (f.height ?? 0) - ins.bottom]]) {
      if (!a?.stretches) continue;
      // Measured the way the run measured it: found insets by the finder itself, so output nobody
      // has touched cannot fail on a difference in method; given insets against their own band.
      let now;
      if (f.given) now = bandSmear(image, axis, start, end);
      else {
        const found = findBand(image, axis, { crisp: f.crisp ?? null });
        let failing = 0;
        for (let i = start; i < end; i++) if (!found.ok[i]) failing++;
        now = { failing, lines: end - start };
      }
      bands.push({ axis, now });
    }
    // The same rule that made it: a band whose lines are not alike smears, whether the insets
    // were found or given.
    const worse = bands.filter((b) => b.now.failing > 0);
    art.checks = [
      ...art.checks,
      {
        check: "stretches",
        ok: worse.length === 0,
        detail: worse.length ? worse.map((b) => `${b.now.failing} of the ${b.now.lines} lines it stretches ${b.axis === "x" ? "across" : "down"} are not alike, so stretching smears them`).join("; ") : `${bands.map((b) => `${b.now.lines} alike lines ${b.axis === "x" ? "across" : "down"}`).join(", ") || "no stretching axis recorded"}`,
      },
    ];
  }
  files.push({ rel: path.basename(art.file), ...art });

  const np = await recheckFile(at(data.files.android), f.width && f.height ? { width: f.width + 2, height: f.height + 2 } : null);
  if (!np.error) {
    const read = readAndroidNinePatch(decodeImage(await readFile(np.file)));
    const same = (a, b) => Boolean(a && b) && a.left === b.left && a.top === b.top && a.right === b.right && a.bottom === b.bottom;
    const artSame = image && read.art && read.art.width === image.width && read.art.height === image.height && read.art.data.every((v, i) => v === image.data[i]);
    np.checks = [
      ...np.checks,
      { check: "border", ok: read.problems.length === 0, detail: read.problems.length ? read.problems.slice(0, 3).join("; ") : "clear or opaque black, one run a side, as aapt2 requires" },
      { check: "marks", ok: same(read.insets, ins) && same(read.content, pad), detail: `marks ${read.insets ? `${read.insets.left},${read.insets.top},${read.insets.right},${read.insets.bottom}` : "none"} for insets ${ins.left},${ins.top},${ins.right},${ins.bottom}` },
      { check: "art", ok: Boolean(artSame), detail: artSame ? "the art inside the border is the art itself" : "the art inside the border differs from the nine-patch image" },
    ];
  }
  files.push({ rel: path.basename(np.file), ...np });

  const sb = await readText(at(data.files.stylebox));
  if (sb.error) files.push({ rel: String(data.files.stylebox).split(/[\\/]/).pop(), ...sb });
  else {
    const num = (key) => Number((new RegExp(`^${key} = ([-\\d.]+)`, "m").exec(sb.text) ?? [])[1]);
    const tex = ["left", "top", "right", "bottom"].map((s) => num(`texture_margin_${s}`));
    const con = ["left", "top", "right", "bottom"].map((s) => num(`content_margin_${s}`));
    const want = [ins.left, ins.top, ins.right, ins.bottom];
    const wantPad = [pad.left, pad.top, pad.right, pad.bottom];
    const ok = tex.every((v, i) => v === want[i]) && con.every((v, i) => v === wantPad[i]);
    files.push({ rel: path.basename(sb.file), file: sb.file, bytes: Buffer.byteLength(sb.text), checks: [{ check: "margins", ok, detail: `texture margins ${tex.join(",")} for ${want.join(",")}; content ${con.join(",")}` }] });
  }
  return files;
}

/**
 * Re-reads a bitmap font: the .fnt still parses (whatever line endings a checkout gave it)
 * and still holds the characters, kerning and metrics the run wrote; its page is still an
 * RGBA image, the only kind Godot's BMFont importer reads as "glyph in alpha" (a lossless
 * optimiser that turns it grey-and-alpha makes Godot refuse the font); and every glyph's
 * rectangle still lies on the page with ink in it.
 */
export async function recheckBitmapFont(data, at) {
  const f = data.facts ?? {};
  const files = [];
  const fnt = await readText(at(data.files.fnt));
  if (fnt.error) return [{ rel: String(data.files.fnt).split(/[\\/]/).pop(), ...fnt }];
  const parsed = parseFnt(fnt.text);
  // A character other than whitespace written as nothing draws nothing in the game.
  const blank = parsed.chars.filter((c) => (!c.width || !c.height) && !/^\s$/u.test(String.fromCodePoint(c.id))).map((c) => String.fromCodePoint(c.id));
  // The same rule that made it: a font the run itself failed (characters the font lacks, pieces of
  // letters lost at crisp sizes) is not shipped by a passing gate.
  const why = [
    ...(f.missing?.length ? [`the font lacks ${f.missing.join(" ")}`] : []),
    ...(f.lost?.length ? [`crisp pixels lost part of ${f.lost.join(" ")}`] : []),
    ...(f.previewDiffers ? ["text set from the files did not match the glyphs as built"] : []),
  ];
  const fntDigest = createHash("sha256").update(fnt.text.replace(/\r\n/g, "\n")).digest("hex").slice(0, 16);
  const fntChecks = [
    ...(f.fntDigest ? [{ check: "unchanged", ok: fntDigest === f.fntDigest, detail: fntDigest === f.fntDigest ? "the characters, offsets, advances and kerning the run wrote" : "the .fnt differs from what the run wrote (a glyph's place, offset, advance or a kerning amount was changed)" }] : []),
    { check: "made", ok: (f.verdict ?? "complete") === "complete", detail: f.verdict && f.verdict !== "complete" ? `the run called it ${f.verdict}: ${why.join("; ") || "see bitmapfont.json"}` : "the run completed" },
    { check: "blank", ok: blank.length === 0, detail: blank.length ? `${blank.join(" ")} are written with no glyph, so they draw nothing` : "every character but whitespace has a glyph" },
    { check: "chars", ok: parsed.chars.length === f.written, detail: `${parsed.chars.length} characters; the run wrote ${f.written}` },
    { check: "kerning", ok: parsed.kernings.length === (f.kernings ?? 0), detail: `${parsed.kernings.length} kerning pairs; the run wrote ${f.kernings ?? 0}` },
    { check: "metrics", ok: parsed.common.lineHeight === f.lineHeight && parsed.common.base === f.base && parsed.info.size === f.px, detail: `size ${parsed.info.size}, line height ${parsed.common.lineHeight}, base ${parsed.common.base}` },
  ];
  files.push({ rel: path.basename(fnt.file), file: fnt.file, bytes: Buffer.byteLength(fnt.text), checks: fntChecks });

  // The XML copy Phaser loads must say the same.
  if (data.files.xml) {
    const xml = await readText(at(data.files.xml));
    if (xml.error) files.push({ rel: String(data.files.xml).split(SEP).pop(), ...xml });
    else {
      const chars = (xml.text.match(/<char /g) ?? []).length;
      const kerns = (xml.text.match(/<kerning /g) ?? []).length;
      // Held to what the run wrote, not to the .fnt, so a hand edit to one fails only that one.
      const m = /<common lineHeight="(\d+)" base="(\d+)"/.exec(xml.text);
      const ok = chars === f.written && kerns === (f.kernings ?? 0) && Boolean(m) && Number(m[1]) === f.lineHeight && Number(m[2]) === f.base;
      files.push({ rel: path.basename(xml.file), file: xml.file, bytes: Buffer.byteLength(xml.text), checks: [{ check: "same", ok, detail: `${chars} characters and ${kerns} kerning pairs; the run wrote ${f.written} and ${f.kernings ?? 0}` }] });
    }
  }

  const pageName = parsed.pages[0]?.file ?? String(data.files.page).split(/[\\/]/).pop();
  const page = await recheckFile(at(path.join(path.dirname(String(data.files.fnt)), pageName)), parsed.common.scaleW && parsed.common.scaleH ? { width: parsed.common.scaleW, height: parsed.common.scaleH } : null);
  if (!page.error) {
    const buffer = await readFile(page.file);
    const colourType = buffer.length > 25 ? buffer[25] : -1;
    const hasTrns = buffer.includes(Buffer.from("tRNS"));
    const godotReads = colourType === 6 || ((colourType === 2 || colourType === 3) && hasTrns);
    const image = decodeImage(buffer);
    let outside = 0;
    let empty = 0;
    for (const c of parsed.chars) {
      if (!c.width || !c.height) continue;
      if (c.x < 0 || c.y < 0 || c.x + c.width > image.width || c.y + c.height > image.height) {
        outside++;
        continue;
      }
      let ink = false;
      for (let y = 0; y < c.height && !ink; y++) for (let x = 0; x < c.width && !ink; x++) if (image.data[((c.y + y) * image.width + c.x + x) * 4 + 3]) ink = true;
      if (!ink) empty++;
    }
    const pageDigest = createHash("sha256").update(Buffer.from(image.data)).digest("hex").slice(0, 16);
    page.checks = [
      ...page.checks,
      ...(f.pageDigest ? [{ check: "unchanged", ok: pageDigest === f.pageDigest, detail: pageDigest === f.pageDigest ? "the glyph pixels the run wrote" : "the page's pixels differ from what the run wrote" }] : []),
      { check: "rgba", ok: godotReads, detail: godotReads ? "an image with alpha, as Godot's BMFont importer needs" : `PNG colour type ${colourType}; Godot refuses a BMFont page without RGBA` },
      { check: "glyphs", ok: outside === 0 && empty === 0, detail: outside || empty ? `${outside} glyph rectangles fall off the page and ${empty} hold no ink` : "every glyph's rectangle is on the page with ink in it" },
    ];
  }
  files.push({ rel: path.basename(page.file), ...page });
  return files;
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

  // A sprite atlas, and the same atlas packed again by `onmodel atlas`. A grid atlas is held
  // to its size; a trimmed one to whether every frame still comes back where it was.
  for (const [summaryFile, kind] of [["sprites.json", "sprites"], ["atlas.json", "atlas"]]) {
    const run = await load(summaryFile, kind);
    if (!run?.data?.atlas?.image) continue;
    const { base, data } = run;
    const a = data.atlas;
    const at = (f) => candidatesFor(base, { rel: String(f).split(/[\\/]/).pop(), recorded: f, summaryDir: data.dir });
    const rel = String(a.image).split(/[\\/]/).pop();
    const files = [{ rel, ...(await recheckFile(at(a.image), { width: a.width, height: a.height })) }];
    if (a.layout === "trimmed") files.push(...(await recheckTrimmed(a, at)));
    if (a.pivot) files.push(...(await recheckPivot(a, at)));
    results.push({ kind, name: data.name, dir: base, files });
  }

  // A traced or set mark: the SVG is the deliverable, so it is the SVG that is re-read.
  for (const [file, kind] of [["vector.json", "vector"], ["text.json", "text"], ["lockup.json", "lockup"]]) {
    const run = await load(file, kind);
    if (!run?.data?.files?.svg) continue;
    const { base, data } = run;
    const f = data.facts ?? {};
    const rel = String(data.files.svg).split(/[\\/]/).pop();
    const files = [{ rel, ...(await recheckSVG(candidatesFor(base, { rel, recorded: data.files.svg, summaryDir: data.dir }), { width: f.width ?? null, height: f.height ?? null })) }];
    if (data.files.render) {
      const r = String(data.files.render).split(/[\\/]/).pop();
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
    const rel = String(data.files.tile).split(/[\\/]/).pop();
    const got = await recheckFile(candidatesFor(base, { rel, recorded: data.files.tile, summaryDir: data.dir }), f.width && f.height ? { width: f.width, height: f.height } : null);
    if (!got.error) {
      const buffer = await readFile(got.file);
      const now = seam(decodeImage(buffer));
      got.checks = [...got.checks, { check: "tiles", ok: now.ratio <= 1.5, detail: `the join is ${now.ratio}x the texture's own grain${f.verdict ? `; the run left it ${f.verdict}` : ""}` }];
    }
    const files = [{ rel, ...got }];
    if (data.files.normal) {
      const r = String(data.files.normal).split(/[\\/]/).pop();
      files.push({ rel: r, ...(await recheckNormal(candidatesFor(base, { rel: r, recorded: data.files.normal, summaryDir: data.dir }), { wrap: true })) });
    }
    results.push({ kind: "tile", name: data.name, dir: base, files });
  }

  // A terrain set is a measurement too: the atlas is decoded and every pair that can touch
  // again, so an atlas repainted or re-saved at the same size is caught rather than passed on
  // the numbers recorded when it was made. Where each cell sits is arithmetic from the mode
  // and the cell size, so nothing about the layout has to be believed either.
  const terrain = await load("terrain.json", "terrain");
  if (terrain?.data?.files?.atlas) {
    const { base, data } = terrain;
    const f = data.facts ?? {};
    const rel = String(data.files.atlas).split(/[\\/]/).pop();
    const got = await recheckFile(candidatesFor(base, { rel, recorded: data.files.atlas, summaryDir: data.dir }), f.width && f.height ? { width: f.width, height: f.height } : null);
    if (!got.error && Object.hasOwn(MODES, String(f.mode)) && f.cellSize) {
      const image = decodeImage(await readFile(got.file));
      const plan = layout(f.mode, Math.floor(image.width / f.cellSize));
      const fitsGrid = image.width % f.cellSize === 0 && image.height === plan.rows * f.cellSize;
      const checks = [{ check: "cells", ok: fitsGrid && plan.cells.length === variants(f.mode).length, detail: `${plan.cells.length} cells of ${f.cellSize}px in a ${image.width}x${image.height} atlas; ${f.mode} mode needs ${variants(f.mode).length}` }];
      if (fitsGrid) {
        const atlas = { image, cells: plan.cells, cellSize: f.cellSize, mode: f.mode };
        const map = adjacencyReport(atlas);
        const held = coverage(atlas);
        // Sides-only cannot close a diagonal, so its number is held to what it was, not to all.
        const fits = f.mode === "both" ? map.joins === 1 && map.missing === 0 : map.missing === 0 && (f.pairsMatched == null || map.matched === f.pairsMatched);
        checks.push(
          { check: "fits", ok: fits, detail: `${map.matched} of the ${map.edges} pairs that can touch join${f.pairsMatched != null ? `; ${f.pairsMatched} did when it was made` : ""}` },
          {
            check: "drawn",
            ok: held.hollow === 0 && held.gaps === 0 && held.misdrawn === 0,
            detail: held.hollow || held.gaps || held.misdrawn ? `${held.misdrawn} cells draw a different shape from their bits, ${held.hollow} are empty at the centre, and the full cell has ${held.gaps} empty pixels` : "every cell draws the shape its bits declare",
          },
        );
      }
      got.checks = [...got.checks, ...checks];
    } else if (!got.error) {
      got.checks = [...got.checks, { check: "cells", ok: false, detail: "terrain.json records no mode or cell size to lay the atlas out by; run onmodel terrain again" }];
    }
    const files = [{ rel, ...got }];
    if (data.files.tileset) {
      const r = String(data.files.tileset).split(/[\\/]/).pop();
      files.push({ rel: r, ...(await recheckTileSet(candidatesFor(base, { rel: r, recorded: data.files.tileset, summaryDir: data.dir }), f.expected ?? null, f.cellSize ?? null)) });
    }
    results.push({ kind: "terrain", name: data.name, dir: base, files });
  }

  // A shape is its points. The art it was traced from is not part of the run, so the fit
  // cannot be measured again here; what can be is that the points still parse, are still
  // the shapes and the count the run reported, stay within the budget, and that the
  // occluder still holds the first of them.
  const shape = await load("shape.json", "shape");
  if (shape?.data?.files?.points) {
    const { base, data } = shape;
    const f = data.facts ?? {};
    const files = [];
    const r = String(data.files.points).split(/[\\/]/).pop();
    const points = await recheckPoints(candidatesFor(base, { rel: r, recorded: data.files.points, summaryDir: data.dir }), f);
    files.push({ rel: r, ...points });
    if (data.files.occluder) {
      const o = String(data.files.occluder).split(/[\\/]/).pop();
      files.push({ rel: o, ...(await recheckOccluder(candidatesFor(base, { rel: o, recorded: data.files.occluder, summaryDir: data.dir }), points.first ?? null)) });
    }
    if (data.files.preview) {
      const p = String(data.files.preview).split(/[\\/]/).pop();
      files.push({ rel: p, ...(await recheckFile(candidatesFor(base, { rel: p, recorded: data.files.preview, summaryDir: data.dir }), f.width && f.height ? { width: f.width, height: f.height } : null)) });
    }
    for (const file of files) delete file.first;
    results.push({ kind: "shape", name: data.name, dir: base, files });
  }

  const ninepatch = await load("ninepatch.json", "ninepatch");
  if (ninepatch?.data?.files?.image) {
    const { base, data } = ninepatch;
    const at = (f) => candidatesFor(base, { rel: String(f).split(/[\\/]/).pop(), recorded: f, summaryDir: data.dir });
    results.push({ kind: "ninepatch", name: data.name, dir: base, files: await recheckNinePatch(data, at) });
  }

  const bitmapfont = await load("bitmapfont.json", "bitmapfont");
  if (bitmapfont?.data?.files?.fnt) {
    const { base, data } = bitmapfont;
    const at = (f) => candidatesFor(base, { rel: String(f).split(SEP).pop(), recorded: f, summaryDir: data.dir });
    results.push({ kind: "bitmapfont", name: data.name, dir: base, files: await recheckBitmapFont(data, at) });
  }

  const normal = await load("normal.json", "normal");
  if (normal?.data?.files?.normal) {
    const { base, data } = normal;
    const f = data.facts ?? {};
    const rel = String(data.files.normal).split(/[\\/]/).pop();
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
