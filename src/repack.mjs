import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeImage, encodePNG } from "./image.mjs";
import { packActions, atlasJSON, atlasCSS, atlasHeader, atlasGodot, godotImport, GODOT_FILTER_NEAREST } from "./atlas.mjs";
import { trimAtlas, verifyTrim, pivotOf, restoreFrame } from "./trim.mjs";
import { normalMap } from "./normal.mjs";
import { slug } from "./generate.mjs";
import { toolVersion } from "./config.mjs";

/**
 * Writes a sprite atlas and everything engines read beside it, trimmed or as a grid.
 *
 * Shared by `sprites`, which packs what it just painted, and `atlas`, which packs a run
 * that already exists, so the two can never disagree about what a trimmed atlas is.
 *
 * A trimmed atlas is verified before it is reported: every frame is put back into a cell
 * from the record just made and compared with the untrimmed cell, pixel for pixel. The
 * CSS stays on the untrimmed grid, written beside it as `<label>.cells.png`, because a
 * steps() animation walks equal frames and a CSS background gains nothing from trimming;
 * deflate already stores the transparent runs for next to nothing.
 */
export async function writeAtlasFiles(grid, { dir, label, config, placement = null, version = null }) {
  const sp = config.sprite ?? {};
  const pixel = Boolean(config.pixel);
  const alpha = sp.trimAlpha ?? 1;
  // Painted art keeps one transparent texel inside its region so linear filtering still has
  // the empty cell to blend its soft edge into; pixel art is drawn nearest and cut flush.
  const trimmed = sp.trim ? trimAtlas(grid, { alpha, margin: pixel ? 0 : 1, padding: sp.padding ?? 2 }) : null;
  const sheet = trimmed ?? grid;
  const where = placement ?? { fill: sp.fill ?? 0.9, anchor: sp.anchor ?? "bottom" };
  const pivot = sp.pivot ? pivotOf(grid.frame, where) : null;
  const prefix = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "SPRITE";
  const files = {
    image: path.join(dir, `${label}.png`),
    json: path.join(dir, `${label}.json`),
    css: path.join(dir, `${label}.css`),
    header: path.join(dir, `${label}.h`),
    godot: path.join(dir, `${label}.tres`),
    ...(trimmed ? { cells: path.join(dir, `${label}.cells.png`) } : {}),
    ...(sp.normal ? { normal: path.join(dir, `${label}.normal.png`) } : {}),
  };
  await writeFile(files.image, encodePNG(sheet.image));
  await writeFile(`${files.image}.import`, godotImport({ pixel }));
  if (trimmed) await writeFile(files.cells, encodePNG(grid.image));
  await writeFile(files.json, JSON.stringify(atlasJSON(sheet, { file: `${label}.png`, version: version ?? (await toolVersion()), pivot }), null, 2));
  await writeFile(files.css, atlasCSS(grid, { file: path.basename(trimmed ? files.cells : files.image), prefix: label, pixelated: pixel }));
  await writeFile(files.header, atlasHeader(sheet, { file: `${label}.png`, prefix, guard: `${prefix}_ATLAS_H`, pivot }));
  const res = (n) => (sp.resPath ? `${String(sp.resPath).replace(/\/+$/, "")}/${n}` : `res://${n}`);
  let normalFacts = null;
  if (sp.normal) {
    // Derived on the untrimmed grid, exactly as an untrimmed sheet is, then cut into the
    // trimmed layout. Deriving it on the trimmed sheet let a frame that reaches its cell's
    // edge be lit by its neighbour across the padding, which the grid never did.
    const lit = normalMap(grid.image, { strength: sp.normalStrength ?? 1, blur: pixel ? 0 : 1 });
    let normalImage = lit.image;
    if (trimmed) {
      normalImage = { width: trimmed.image.width, height: trimmed.image.height, data: new Uint8Array(trimmed.image.width * trimmed.image.height * 4) };
      for (let i = 0; i < normalImage.data.length; i += 4) normalImage.data.set([128, 128, 255, 255], i);
      for (const p of trimmed.placements) {
        for (let y = 0; y < p.height; y++) {
          const from = ((p.cellY + p.trim.y + y) * lit.image.width + p.cellX + p.trim.x) * 4;
          normalImage.data.set(lit.image.data.subarray(from, from + p.width * 4), ((p.y + y) * normalImage.width + p.x) * 4);
        }
      }
    }
    await writeFile(files.normal, encodePNG(normalImage));
    await writeFile(`${files.normal}.import`, godotImport({ pixel, normalMap: true }));
    normalFacts = lit.facts;
  }
  await writeFile(
    files.godot,
    atlasGodot(sheet, {
      file: `${label}.png`,
      resPath: res(`${label}.png`),
      normal: sp.normal ? res(`${label}.normal.png`) : null,
      filter: pixel ? GODOT_FILTER_NEAREST : null,
    }),
  );

  const record = {
    ...files,
    layout: trimmed ? "trimmed" : "grid",
    width: sheet.image.width,
    height: sheet.image.height,
    frame: grid.frame,
    actions: grid.ranges.map((x) => ({ name: x.name, from: x.from, to: x.to, fps: x.fps, loop: x.loop !== false })),
    ...(normalFacts ? { normalFacts, normalStrength: sp.normalStrength ?? 1 } : {}),
    ...(sp.resPath ? { resPath: sp.resPath } : {}),
  };
  if (trimmed) {
    const check = verifyTrim(trimmed.image, trimmed.placements, grid.image, { alpha });
    const before = grid.image.width * grid.image.height;
    const after = trimmed.image.width * trimmed.image.height;
    record.trim = {
      alpha,
      margin: pixel ? 0 : 1,
      padding: sp.padding ?? 2,
      gridWidth: grid.image.width,
      gridHeight: grid.image.height,
      // Negative when frames that fill their cells gain more padding than trimming saves.
      fewerTexels: Math.round((1 - after / before) * 1000) / 1000,
      verdict: check.verdict,
      moved: check.moved,
      lost: check.lost,
      faint: check.faint,
      wrong: check.wrong,
      empty: trimmed.placements.filter((p) => p.trim.empty).map((p) => p.name),
    };
  }
  if (pivot) {
    // AnimatedSprite2D draws centred on its node; this offset puts the pivot on the node.
    record.pivot = { x: pivot.x, y: pivot.y, godotOffset: { x: grid.frame.width / 2 - pivot.x, y: grid.frame.height / 2 - pivot.y } };
  }
  return record;
}

/**
 * `onmodel atlas --name <run>`: packs a sprites run again, trimmed or with a pivot, with no
 * call to anything. The frames are cut from the run's atlas on disk rather than from the
 * per-action frame files, because the atlas is what ships: a touch-up made to it after the
 * run is kept, and the frame files are compared with it so a difference is reported.
 */
export async function makeAtlas({ config, name, log = (s) => process.stderr.write(s) }) {
  if (!name) throw new Error("atlas needs --name <a sprites run>");
  const label = slug(name);
  if (label === "atlas") throw new Error('a run named "atlas" would write its atlas over the summary atlas.json; rename the run');
  const from = path.join(config.out, label, "sprites");
  let run;
  try {
    run = JSON.parse(await readFile(path.join(from, "sprites.json"), "utf8"));
  } catch {
    throw new Error(`no sprites run in ${from} to pack; run onmodel sprites --name ${label} first`);
  }
  const a = run.atlas;
  if (!a?.image || !a.frame || !Array.isArray(a.actions) || !a.actions.length) throw new Error(`${path.join(from, "sprites.json")} records no atlas to pack`);
  const name_ = (f) => path.join(from, String(f).split(/[\\/]/).pop());
  const sourceFile = name_(a.image);
  let shipped;
  try {
    shipped = decodeImage(await readFile(sourceFile));
  } catch (err) {
    throw new Error(`could not read the run's atlas ${sourceFile}: ${err.message}`);
  }
  const { width: fw, height: fh } = a.frame;
  const columns = Math.max(...a.actions.map((x) => x.to - x.from + 1));
  let gridImage = shipped;
  if (a.layout === "trimmed") {
    // A trimmed run's atlas is what ships, so its frames are put back into a grid from its
    // own record; a touch-up made to it since is kept that way.
    let frames;
    try {
      frames = JSON.parse(await readFile(name_(a.json), "utf8")).frames;
    } catch (err) {
      throw new Error(`could not read the run's atlas record ${name_(a.json)}: ${err.message}`);
    }
    gridImage = { width: columns * fw, height: a.actions.length * fh, data: new Uint8Array(columns * fw * a.actions.length * fh * 4) };
    a.actions.forEach((act, row) => {
      for (let i = act.from; i <= act.to; i++) {
        const f = frames?.[`${act.name}_${i - act.from}`];
        if (!f) throw new Error(`the run's atlas record has no frame ${act.name}_${i - act.from}`);
        const cell = restoreFrame(shipped, { x: f.frame.x, y: f.frame.y, width: f.frame.w, height: f.frame.h, trim: { x: f.spriteSourceSize.x, y: f.spriteSourceSize.y, sourceW: f.sourceSize.w, sourceH: f.sourceSize.h } });
        for (let y = 0; y < fh; y++) gridImage.data.set(cell.data.subarray(y * fw * 4, (y + 1) * fw * 4), ((row * fh + y) * gridImage.width + (i - act.from) * fw) * 4);
      }
    });
  }
  if (gridImage.width !== columns * fw || gridImage.height !== a.actions.length * fh) {
    throw new Error(`${path.basename(sourceFile)} is ${gridImage.width}x${gridImage.height}, not the ${columns * fw}x${a.actions.length * fh} grid of ${fw}x${fh} cells the run recorded`);
  }
  const cut = (row, col) => {
    const cell = { width: fw, height: fh, data: new Uint8Array(fw * fh * 4) };
    for (let y = 0; y < fh; y++) cell.data.set(gridImage.data.subarray(((row * fh + y) * gridImage.width + col * fw) * 4, ((row * fh + y) * gridImage.width + (col + 1) * fw) * 4), y * fw * 4);
    return cell;
  };
  const actions = a.actions.map((x, row) => ({ name: x.name, fps: x.fps, loop: x.loop !== false, frames: Array.from({ length: x.to - x.from + 1 }, (_, col) => cut(row, col)) }));

  // The frame files the run wrote, against the atlas: a difference means one was edited.
  let edited = 0;
  let compared = 0;
  const filesFor = new Map();
  for (const rec of run.actions ?? []) {
    if (rec.files?.frames) filesFor.set(rec.name, rec.files.frames);
    if (rec.mirror && rec.mirrorFiles?.frames) filesFor.set(rec.mirror, rec.mirrorFiles.frames);
  }
  for (const act of actions) {
    const list = filesFor.get(act.name) ?? [];
    for (const [i, f] of list.entries()) {
      if (!act.frames[i]) continue;
      let img;
      try {
        img = decodeImage(await readFile(path.join(from, slug(act.name), String(f).split(/[\\/]/).pop())));
      } catch {
        continue;
      }
      compared++;
      const cell = act.frames[i];
      // A trimmed run's frames come back without the pixels its own threshold let go, so those
      // are not counted as an edit to anything.
      const cut = a.layout === "trimmed" ? (a.trim?.alpha ?? 1) : 1;
      let differs = img.width !== cell.width || img.height !== cell.height;
      for (let k = 0; !differs && k < img.data.length; k += 4) {
        const fa = img.data[k + 3] < cut ? 0 : img.data[k + 3];
        const ca = cell.data[k + 3] < cut ? 0 : cell.data[k + 3];
        if (fa !== ca || (fa && (img.data[k] !== cell.data[k] || img.data[k + 1] !== cell.data[k + 1] || img.data[k + 2] !== cell.data[k + 2]))) differs = true;
      }
      if (differs) edited++;
    }
  }

  const dir = path.join(config.out, label, "atlas");
  await mkdir(dir, { recursive: true });
  const grid = packActions(actions);
  // The run's own pixel mode and normal map, unless this command was told otherwise, so the
  // same frames come out drawn the same way: crisp, cut flush and lit when the run was.
  const used = {
    ...config,
    pixel: config.pixel ?? run.pixel ?? null,
    sprite: {
      ...(config.sprite ?? {}),
      normal: Boolean(config.sprite?.normal || a.normal),
      ...(a.normalStrength != null ? { normalStrength: a.normalStrength } : {}),
      ...(a.resPath && !config.sprite?.resPath ? { resPath: a.resPath } : {}),
    },
  };
  const atlas = await writeAtlasFiles(grid, { dir, label, config: used, placement: run.placement ?? null });
  const summary = {
    tool: "onmodel",
    kind: "atlas",
    name: label,
    dir,
    from: sourceFile,
    generatedAt: new Date().toISOString(),
    pixel: used.pixel,
    framesCompared: compared,
    framesEdited: edited,
    atlas,
  };
  await writeFile(path.join(dir, "atlas.json"), JSON.stringify(summary, null, 2));
  log(`  ${label}: ${atlas.layout} atlas ${atlas.width}x${atlas.height}${atlas.trim ? `, ${atlas.trim.verdict}` : ""}\n`);
  return summary;
}
