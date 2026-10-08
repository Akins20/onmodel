import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ImageClient, JudgeClient, text, imagePart } from "./gemini.mjs";
import { requireBrief, loadDecisions, briefSection, decisionsSection } from "./brief.mjs";
import { decodeImage, encodePNG } from "./image.mjs";
import { decodePNG } from "./png.mjs";
import { chooseKey, keyOut, quantize, hardenAlpha, fillBackground, blit, resize, medianCut, trim, alphaBounds } from "./key.mjs";
import { toHex } from "./color.mjs";
import { sliceStrip, placeFrames, mirror } from "./strip.mjs";
import { measureAction, paletteDelta, normalisePair, iou, silhouette, HARD_FLAGS } from "./measure.mjs";
import { packActions, atlasJSON, atlasCSS, atlasHeader } from "./atlas.mjs";
import { encodeAPNG, encodeGIF } from "./anim.mjs";
import { generate, preambleParts, slug } from "./generate.mjs";
import { spriteImageCounts } from "./plan.mjs";
import { renderContactHTML, renderSpritesHTML } from "./html.mjs";

/**
 * Sprites, built the way an animation studio keeps a character on model: first a
 * model sheet (front, side and back views of the character, approved once), then
 * every action painted as a strip of poses with the sheet beside the painter. One
 * strip holds all of an action's frames in one generation, which is what keeps them
 * one style; the strip is sliced where the poses are, every frame is measured
 * against the sheet and its neighbours, and a strip that drifts is painted again,
 * then a frame that still drifts is repainted alone between its neighbours. What
 * survives is placed at one scale on one baseline, packed into an atlas, exported
 * for the engines and previewed as APNG and GIF.
 *
 * Works for any sequence, not only characters: without a sheet, frames are held to
 * each other (colours to the first frame, every step to the one before).
 */

const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;
const pad2 = (n) => String(n).padStart(2, "0");

const FACING = { right: "facing right", left: "facing left", front: "facing the viewer", back: "facing away from the viewer" };

/** A strip's aspect ratio, wide enough that every pose gets room. */
export function stripAspect(count) {
  if (count <= 1) return "1:1";
  if (count === 2) return "3:2";
  if (count <= 4) return "16:9";
  return "21:9";
}

/** The subject for a strip: the character, the action, and how the row is laid out. */
export function stripSubject({ character, action, count, hasSheet, note = "", part = null }) {
  const facing = FACING[action.facing] ?? FACING.right;
  const same = hasSheet ? "the same character as the model sheet" : "the same character in every frame";
  let order;
  if (part) {
    // One strip of a longer action: say which frames these are and what they join.
    const carries = part.index > 0 ? ", carrying straight on from the frame shown just before this strip" : "";
    const closes = action.loop && part.index === part.of - 1 ? ", the last of them leading smoothly back into the action's first frame, shown" : "";
    order = `Paint frames ${part.from + 1} to ${part.to + 1} of the ${part.total} frames of this action in a single horizontal row, left to right in the order they play${carries}${closes}.`;
  } else
    order =
      count === 1
        ? "Paint one frame of this pose."
        : `Paint ${count} frames of this action in a single horizontal row, left to right in the order they play${action.loop && count > 2 ? ", so the last frame leads smoothly back into the first" : ""}.`;
  return [
    "## Subject",
    character,
    `Action "${action.name}": ${action.motion}.`,
    order,
    `Every frame is ${same}, at the same size and proportions, ${facing}, with its feet on one shared baseline. Leave a clear gap of background between frames; no frame touches another frame or the edge of the image. No numbers, labels, arrows or panel borders.`,
    note ? `The previous attempt went wrong: ${note} Fix that.` : "",
    "Paint it now.",
  ]
    .filter(Boolean)
    .join("\n");
}

/** The subject for one frame repainted alone between its neighbours. */
export function frameSubject({ character, action, index, count, hasSheet, hasNeighbours, fix = null }) {
  const facing = FACING[action.facing] ?? FACING.right;
  const like = [hasSheet ? "the model sheet" : null, hasNeighbours ? "the neighbouring frames shown" : null].filter(Boolean).join(" and ");
  return [
    "## Subject",
    character,
    `Action "${action.name}": ${action.motion}.`,
    `Paint frame ${index + 1} of ${count} of this action: one single pose, ${facing}${like ? `, the same character at the same size as ${like}` : ""}${hasNeighbours ? ", the pose that comes between them" : ""}.`,
    fix ? `What to fix in this frame: ${fix}` : "",
    "Paint it now.",
  ]
    .filter(Boolean)
    .join("\n");
}

const listFrames = (xs) => (xs.length === 1 ? `frame ${xs[0]}` : `frames ${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** What went wrong with a strip, in words the painter can act on next time. */
export function retryNote(slice, measured, count, offset = 0) {
  const bits = [];
  if (slice.method === "equal") bits.push(`it drew ${slice.found} separate pose${slice.found === 1 ? "" : "s"} where ${count} were asked for, or let poses touch`);
  if (slice.method === "merged") bits.push(`it drew ${slice.found} separate pieces where ${count} poses were asked for`);
  const by = (flag) => measured.frames.filter((f) => f.flags.includes(flag)).map((f) => f.index + 1 + offset);
  if (by("shape").length) bits.push(`${listFrames(by("shape"))} changed the character's shape`);
  if (by("size").length) bits.push(`${listFrames(by("size"))} drew the character at a different size`);
  if (by("colour").length) bits.push(`${listFrames(by("colour"))} changed its colours`);
  if (by("empty").length) bits.push(`${listFrames(by("empty"))} came out empty`);
  if (measured.jumps.length) bits.push(`the motion jumps at ${listFrames(measured.jumps.map((i) => i + 1 + offset))}`);
  return bits.length ? `${bits.join("; ")}.` : "";
}

/** Lower is better: frames that are wrong, then jumps, then poses that ran together, then shape. */
export const attemptScore = (slice, measured) => measured.flagged.length * 10 + measured.jumps.length * 3 + (slice.method === "gaps" ? 0 : 20) - (measured.meanIoU ?? 0);

/** How wrong one frame's facts are, for deciding whether a repaint helped. */
const frameBadness = (f) => f.flags.filter((x) => HARD_FLAGS.includes(x)).length * 10 + (f.iou !== undefined ? 1 - f.iou : 0) + (f.paletteDelta ?? 0) / 100 + Math.abs((f.heightRatio ?? 1) - 1);

/** A keyed frame back on the key colour, padded, as PNG bytes: how a neighbour is shown to the painter. */
export function onKey(frame, key) {
  const margin = Math.round(Math.max(frame.width, frame.height) * 0.2);
  const canvas = { width: frame.width + margin * 2, height: frame.height + margin * 2, data: new Uint8Array((frame.width + margin * 2) * (frame.height + margin * 2) * 4) };
  blit(canvas, frame, margin, margin);
  return encodePNG(fillBackground(canvas, key));
}

/** One scale for an action: its median frame fills the cell to `fill`, unless its largest frame would not fit. */
export function actionScale(frames, { width, height, fill }) {
  const heights = frames.map((f) => f.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)] || 1;
  const maxH = Math.max(...frames.map((f) => f.height), 1);
  const maxW = Math.max(...frames.map((f) => f.width), 1);
  return Math.min((height * fill) / median, (height * 0.98) / maxH, (width * 0.98) / maxW);
}

/** A row of frames on grey, enlarged, for the judge (a model reads alpha as nothing). */
export function rowOnGrey(frames, { scale = 1, gap = 8, grey = "#808080" } = {}) {
  const w = frames[0].width * scale;
  const h = frames[0].height * scale;
  const out = { width: frames.length * (w + gap) + gap, height: h + gap * 2, data: new Uint8Array((frames.length * (w + gap) + gap) * (h + gap * 2) * 4) };
  frames.forEach((f, i) => blit(out, scale === 1 ? f : resize(f, w, h, { filter: "nearest" }), gap + i * (w + gap), gap));
  return fillBackground(out, grey);
}

/** One palette for a whole sprite, so no colour flickers between frames or actions. */
export function sharedPalette(frames, count) {
  const samples = [];
  for (const f of frames) {
    for (let i = 0; i < f.width * f.height; i++) if (f.data[i * 4 + 3] >= 128) samples.push([f.data[i * 4], f.data[i * 4 + 1], f.data[i * 4 + 2]]);
  }
  const step = Math.max(1, Math.floor(samples.length / 60_000));
  return medianCut(step === 1 ? samples : samples.filter((_, i) => i % step === 0), count).map((c) => toHex(c));
}

const SHEET_VIEWS = ["front", "side", "back"];

const sheetScore = (c) => (c.sheet.method === "gaps" ? 0 : 10) + c.sheet.heightSpread * 5 + (c.sheet.colourSpread ?? 0) / 10 - (c.judgement?.on_brief ?? 0) / 100;

/**
 * Cuts a keyed sheet into its three views, writes each as <base>.<view>.png in `dir`,
 * and measures how well they agree (height spread, colour spread). Used for every
 * sheet candidate and again for an edited one, so an edit can stand in for its parent.
 */
export async function sliceSheetViews(keyed, dir, base) {
  const slice = sliceStrip(keyed, 3);
  const views = {};
  const images = slice.cells.map((cell) => cell.image);
  for (const [i, image] of images.entries()) {
    const file = path.join(dir, `${base}.${SHEET_VIEWS[i]}.png`);
    await writeFile(file, encodePNG(image));
    views[SHEET_VIEWS[i]] = file;
  }
  const heights = images.map((im) => im.height);
  const sorted = [...heights].sort((a, b) => a - b);
  let colourSpread = 0;
  for (let i = 0; i < images.length; i++) for (let j = i + 1; j < images.length; j++) colourSpread = Math.max(colourSpread, paletteDelta(images[i], images[j]) ?? 0);
  return { views, sheet: { found: slice.found, method: slice.method, heights, heightSpread: round((sorted[sorted.length - 1] - sorted[0]) / (sorted[1] || 1)), colourSpread: round(colourSpread, 2) } };
}

/**
 * The model sheet: the character three times in one row, front, side and back, the
 * reference every later frame is drawn from and measured against. It runs through
 * the ordinary generation loop (candidates, keying, the judge) at a wide ratio
 * without the sized outputs, then each candidate is sliced into its three views and
 * measured for agreement between them.
 */
export async function makeSheet({ config, subject, name, count, judge = true, fetch: fetchImpl, log = (s) => process.stderr.write(s) }) {
  if (!subject?.trim()) throw new Error("sheet needs --subject: who the character is, in a sentence");
  const label = slug(name ?? subject);
  const dir = path.join(config.out, label, "sheet");
  const sheetSubject = `${subject.trim()}\nA model sheet: the same character three times in one row, left to right: a front view, a side view facing right, and a back view. The same size and proportions in all three, a neutral standing pose, feet on one shared baseline, and a clear gap of background between the views, none touching another or the edge of the image. No labels or text.`;
  const result = await generate({ config, subject: sheetSubject, name: label, count, judge, fetch: fetchImpl, log, dir, aspectRatio: "16:9", outputs: false, layout: "row", kind: "sheet" });
  for (const c of result.candidates) {
    if (!c.files?.image) continue;
    const cut = await sliceSheetViews(decodePNG(await readFile(c.files.image)), dir, pad2(c.index));
    c.views = cut.views;
    c.sheet = cut.sheet;
    log(`  ${label} sheet ${c.index}: ${c.sheet.found} views found (${c.sheet.method}), heights ${c.sheet.heights.join("/")}, colour spread ${c.sheet.colourSpread}\n`);
  }
  const usable = result.candidates.filter((c) => c.views);
  const judged = result.pick ? usable.find((c) => c.index === result.pick && c.sheet.method === "gaps") : null;
  const chosen = judged ?? [...usable].sort((a, b) => sheetScore(a) - sheetScore(b))[0] ?? null;
  const sheet = {
    tool: "onmodel",
    kind: "sheet",
    name: label,
    subject: subject.trim(),
    key: result.key,
    pick: chosen?.index ?? null,
    pickedBy: !chosen ? null : judged ? "judge" : "measurements",
    source: chosen?.files.source ?? null,
    keyed: chosen?.files.image ?? null,
    views: chosen?.views ?? null,
    candidates: usable.map((c) => ({ index: c.index, source: c.files.source, keyed: c.files.image, views: c.views, sheet: c.sheet, judgement: c.judgement ?? null })),
    generatedAt: new Date().toISOString(),
  };
  const sheetPath = path.join(config.out, label, "sheet.json");
  await writeFile(sheetPath, JSON.stringify(sheet, null, 2));
  await writeFile(path.join(dir, "generate.json"), JSON.stringify({ ...result, htmlPath: undefined }, null, 2));
  await writeFile(result.htmlPath, renderContactHTML(result, dir));
  return { ...result, sheet, sheetPath };
}

/** The sheet a run is held to, with its views decoded; `pick` chooses a different candidate than the one picked. */
export async function loadSheet(config, label, { pick = null } = {}) {
  const file = path.join(config.out, label, "sheet.json");
  let json;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch {
    return null;
  }
  let chosen = { source: json.source, keyed: json.keyed, views: json.views, pick: json.pick };
  // A pick is a candidate (2) or an edit of one (2e1), compared as text: Number("1e1")
  // is 10, so an edit's id must never pass through a number.
  const want = pick == null ? null : String(pick).trim().toLowerCase();
  if (want && want !== String(json.pick)) {
    const c = json.candidates.find((x) => String(x.index).toLowerCase() === want);
    if (!c) throw new Error(`the sheet has no candidate ${pick}; it has ${json.candidates.map((x) => x.index).join(", ") || "none"}`);
    chosen = { source: c.source, keyed: c.keyed, views: c.views, pick: c.index };
  }
  if (!chosen.views || !chosen.source) return null;
  const viewImages = {};
  for (const v of SHEET_VIEWS) if (chosen.views[v]) viewImages[v] = decodePNG(await readFile(chosen.views[v]));
  return { ...json, ...chosen, file, viewImages };
}

/** The sheet view an action is measured against, by the way the action faces. */
export function referenceView(sheet, facing) {
  if (!sheet?.viewImages) return null;
  const v = sheet.viewImages;
  if (facing === "front") return v.front ?? null;
  if (facing === "back") return v.back ?? null;
  if (facing === "left") return v.side ? mirror(v.side) : null;
  return v.side ?? null;
}

export const ACTION_JUDGEMENT = {
  type: "OBJECT",
  properties: {
    reads_as: { type: "INTEGER", description: "0 to 100: played in order, do the frames read as the named action" },
    on_model: { type: "INTEGER", description: "0 to 100: every frame the same character as the model sheet; with no sheet, the frames as one character" },
    smooth: { type: "INTEGER", description: "0 to 100: each step a small, even change, with no frame that jumps" },
    problems: { type: "ARRAY", items: { type: "STRING" } },
    frame_notes: {
      type: "ARRAY",
      items: { type: "OBJECT", properties: { frame: { type: "INTEGER" }, note: { type: "STRING" } }, required: ["frame", "note"] },
    },
    fix_frames: {
      type: "ARRAY",
      description: "the frames that need repainting, numbered from 1, each with the one change that would put it right; empty when none do",
      items: { type: "OBJECT", properties: { frame: { type: "INTEGER" }, fix: { type: "STRING" } }, required: ["frame", "fix"] },
    },
    verdict: { type: "STRING", enum: ["keep", "redo"] },
  },
  required: ["reads_as", "on_model", "smooth", "problems", "frame_notes", "fix_frames", "verdict"],
};

const factsOf = (f) =>
  [
    `frame ${f.index + 1}:`,
    f.iou !== undefined ? `shape match with the sheet ${f.iou}` : null,
    f.heightRatio !== undefined ? `height ${f.heightRatio} of the action's median` : null,
    f.paletteDelta !== undefined && f.paletteDelta !== null ? `colour distance ${f.paletteDelta}` : null,
    f.iouPrevious !== undefined ? `overlap with the frame before ${f.iouPrevious}` : null,
    f.flags.length ? `flags ${f.flags.join(", ")}` : "no flags",
  ]
    .filter(Boolean)
    .join(" ");

async function judgeAction({ client, config, decisions, sheet, action, placed, measured, label }) {
  const scale = Math.max(1, Math.floor(160 / Math.max(placed[0].width, placed[0].height)));
  const parts = [
    text(
      "You are judging a short animation for a real product: the frames of one action, in order. Say whether, played in order, they read as the named action, whether every frame is the same character, and whether the motion is smooth. The measured facts given are true; do not contradict them. They cover the silhouette, size and colours, not the features inside, so look hard at eyes, mouth and markings. A settled decision is never a problem. Say keep, or redo when the action does not read or a frame breaks it, and list in fix_frames each frame to repaint with the one change that would put it right, in the imperative (for example: draw the eye in side profile, as on the model sheet).",
    ),
    text(briefSection(config.briefText)),
  ];
  if (decisions.length) parts.push(text(decisionsSection(decisions)));
  if (sheet?.source) parts.push(text("Model sheet: the character's front, side and back views."), await imagePart(sheet.source));
  parts.push(text(`## Action\n"${action.name}": ${action.motion}. ${action.frames} frames at ${action.fps} frames a second, ${action.loop ? "looping" : "played once"}, ${FACING[action.facing]}.`));
  parts.push(text(`### Measured\n${measured.frames.map(factsOf).join("\n")}`));
  parts.push(text("### The frames, left to right, numbered from 1"), await imagePart(encodePNG(rowOnGrey(placed, { scale }))));
  parts.push(text("## Task\nJudge the animation. The grey is not part of the art; it stands for transparency."));
  const { data } = await client.generateJSON({ parts, schema: ACTION_JUDGEMENT, op: `judge:${label}:${action.name}` });
  return data;
}

/**
 * An action's frames split into strips of at most `size`, as evenly as possible:
 * 10 frames at 8 a strip is 5 and 5, not 8 and 2.
 */
export function stripParts(count, size) {
  const n = Math.ceil(count / size);
  const base = Math.floor(count / n);
  let extra = count % n;
  const parts = [];
  let from = 0;
  for (let i = 0; i < n; i++) {
    const len = base + (extra > 0 ? 1 : 0);
    extra--;
    parts.push({ from, to: from + len - 1, count: len });
    from += len;
  }
  return parts;
}

/**
 * Paints one strip of an action until it is clean or the retries run out, and
 * returns the best attempt with its frames. A strip after the first is shown the
 * frame just before it and must follow on from it, which is checked like any
 * other step; the last strip of a looping action is shown the action's first frame.
 */
async function paintPart({ action, part, character, client, rowParts, references, labels, key, config, reference, thresholds, sheet, adir, record, log, previous, first }) {
  const sp = config.sprite;
  const multi = part.of > 1;
  const count = part.to - part.from + 1;
  const name = multi ? `${action.name} frames ${part.from + 1}-${part.to + 1}` : action.name;
  const refs = [...references, ...(previous ? [onKey(previous, key)] : []), ...(first ? [onKey(first, key)] : [])];
  const refLabels = [...labels, ...(previous ? ["The frame just before this strip: the first frame here follows on from it"] : []), ...(first ? ["The action's first frame: the last frame here leads back into it"] : [])];
  let best = null;
  let note = "";
  for (let a = 1; a <= 1 + sp.retries; a++) {
    let res;
    try {
      res = await client.generate({ prompt: stripSubject({ character, action, count, hasSheet: Boolean(sheet), note, part: multi ? part : null }), parts: rowParts, references: refs, labels: refLabels, aspectRatio: stripAspect(count), size: config.size, op: multi ? `${action.name}#part${part.index + 1}.strip${a}` : `${action.name}#strip${a}` });
    } catch (err) {
      if (err.code !== "BUDGET") throw err;
      record.stopped = err.message;
      log(`    ${action.name}: stopped, ${err.message}\n`);
      break;
    }
    const attempt = { index: a, ...(multi ? { part: part.index + 1, frames: [part.from + 1, part.to + 1] } : {}), costUSD: res.costUSD, blocked: res.blocked, note: note || null };
    record.attempts.push(attempt);
    if (res.blocked || !res.images.length) {
      log(`    ${name} strip ${a}: not painted (${res.blocked})\n`);
      continue;
    }
    const painted = res.images[0];
    const stem = multi ? `part${part.index + 1}.strip${a}` : `strip${a}`;
    attempt.source = path.join(adir, `${stem}.source.${painted.mimeType === "image/png" ? "png" : "jpg"}`);
    await writeFile(attempt.source, painted.buffer);
    const keyed = keyOut(decodeImage(painted.buffer), key, config.key);
    attempt.keyed = path.join(adir, `${stem}.png`);
    await writeFile(attempt.keyed, encodePNG(keyed.image));
    attempt.keying = keyed.facts;
    const slice = sliceStrip(keyed.image, count);
    const frames = slice.cells.map((c) => c.image);
    const measured = measureAction(frames, { reference, thresholds, loop: multi ? false : action.loop });
    let joinBroken = false;
    if (previous && alphaBounds(frames[0])) {
      const [x, y] = normalisePair(frames[0], previous);
      attempt.join = round(iou(silhouette(x), silhouette(y)));
      joinBroken = attempt.join < thresholds.jump;
    }
    attempt.slicing = { found: slice.found, method: slice.method };
    attempt.flagged = measured.flagged;
    attempt.jumps = measured.jumps;
    attempt.meanIoU = measured.meanIoU;
    attempt.score = round(attemptScore(slice, measured) + (joinBroken ? 3 : 0));
    log(`    ${name} strip ${a}: ${slice.found}/${count} poses (${slice.method}), flagged ${JSON.stringify(measured.flagged.map((i) => i + part.from + 1))}, jumps ${JSON.stringify(measured.jumps.map((i) => i + part.from + 1))}${attempt.join !== undefined ? `, join ${attempt.join}` : ""}${measured.meanIoU !== null ? `, shape ${measured.meanIoU}` : ""}, $${(res.costUSD ?? 0).toFixed(3)}\n`);
    if (!best || attempt.score < best.attempt.score) best = { attempt, frames, measured };
    if (slice.method === "gaps" && !measured.flagged.length && !measured.jumps.length && !joinBroken) break;
    note = [retryNote(slice, measured, count, multi ? part.from : 0), joinBroken ? "its first frame does not follow on from the frame shown just before this strip." : ""].filter(Boolean).join(" ");
  }
  return best;
}

/** Paints, measures and repairs one action; returns its frames (trimmed, unplaced) and the record. */
async function runAction({ action, character, client, rowParts, singleParts, references, labels, key, config, reference, sheet, dir, log }) {
  const sp = config.sprite;
  const count = action.frames;
  const thresholds = { ...sp.thresholds, ...(action.thresholds ?? {}) };
  const adir = path.join(dir, slug(action.name));
  await mkdir(adir, { recursive: true });
  const record = { name: action.name, frames: count, fps: action.fps, facing: action.facing, loop: action.loop, mirror: action.mirror, motion: action.motion, attempts: [], fixes: [], dir: adir };
  const parts = stripParts(count, sp.stripFrames);
  record.parts = parts.length;
  const partFrames = [];
  const chosen = [];
  for (const [index, part] of parts.entries()) {
    const ctx = { index, of: parts.length, from: part.from, to: part.to, total: count };
    const painted = await paintPart({ action, part: ctx, character, client, rowParts, references, labels, key, config, reference, thresholds, sheet, adir, record, log, previous: index > 0 ? partFrames[index - 1].at(-1) : null, first: index > 0 && index === parts.length - 1 && action.loop ? partFrames[0][0] : null });
    if (!painted) {
      record.error = record.stopped ? "stopped by the budget before every strip was painted" : `no strip was painted${parts.length > 1 ? ` for frames ${part.from + 1} to ${part.to + 1}` : ""}`;
      return { record, frames: null };
    }
    painted.attempt.used = true;
    chosen.push(painted.attempt.index);
    partFrames.push(painted.frames);
  }
  record.best = parts.length === 1 ? chosen[0] : null;
  if (parts.length > 1) record.bestParts = chosen;
  // Each strip is painted at its own pixel scale; bring every one to the first's,
  // by their median frames, before the action is measured as a whole.
  const medianOf = (fs) => fs.map((f) => f.height).sort((a, b) => a - b)[Math.floor(fs.length / 2)] || 1;
  const m0 = medianOf(partFrames[0]);
  let frames = partFrames
    .map((fs, i) => {
      if (i === 0) return fs;
      const s = m0 / medianOf(fs);
      return Math.abs(s - 1) < 0.01 ? fs : fs.map((f) => resize(f, Math.max(1, Math.round(f.width * s)), Math.max(1, Math.round(f.height * s)), { filter: "auto" }));
    })
    .flat();
  let measured = measureAction(frames, { reference, thresholds, loop: action.loop });
  // Frames still wrong are repainted alone, between their neighbours.
  for (const i of [...measured.flagged]) {
    if (record.stopped) break;
    for (let k = 1; k <= sp.frameRetries; k++) {
      const got = await repaintFrame({ client, singleParts, character, action, frames, index: i, key, config, sheet, adir, tag: `fix${k}` });
      if (got.stopped) {
        record.stopped = got.stopped;
        log(`    ${action.name}: stopped, ${got.stopped}\n`);
        break;
      }
      const fix = { frame: i, attempt: k, costUSD: got.costUSD, accepted: false, before: measured.frames[i].flags };
      record.fixes.push(fix);
      if (!got.frame) {
        fix.blocked = got.blocked;
        continue;
      }
      fix.source = got.source;
      const trial = frames.slice();
      trial[i] = matchStripScale(got.frame, measured, i);
      const remeasured = measureAction(trial, { reference, thresholds, loop: action.loop });
      fix.after = remeasured.frames[i].flags;
      if (frameBadness(remeasured.frames[i]) < frameBadness(measured.frames[i])) {
        fix.accepted = true;
        frames = trial;
        measured = remeasured;
      }
      log(`    ${action.name} frame ${i + 1} repaint ${k}: ${JSON.stringify(fix.before)} -> ${JSON.stringify(fix.after)} ${fix.accepted ? "kept" : "dropped"}\n`);
      if (!measured.frames[i].flags.some((x) => HARD_FLAGS.includes(x))) break;
    }
  }
  record.final = finalFacts(measured);
  return { record, frames, measured, reference, thresholds };
}

const finalFacts = (m) => ({ flagged: m.flagged, jumps: m.jumps, meanIoU: m.meanIoU, minIoU: m.minIoU, frames: m.frames, thresholds: m.thresholds });

/**
 * A frame repainted alone is drawn at its own scale (a square image, the character
 * filling most of it), roughly twice the size of a frame cut from a strip, so
 * before it is measured or used it is brought into the strip's pixel space: as tall
 * as the frame it replaces, or as the action's median frame when the one it
 * replaces was itself the wrong size. An intended squash or stretch survives; a
 * frame that was wrong in size is corrected.
 */
export function matchStripScale(frame, measured, index) {
  const old = measured.frames[index];
  const target = !old?.height || old.flags.includes("size") ? measured.medianHeight : old.height;
  if (!target || !frame.height || frame.height === target) return frame;
  const s = target / frame.height;
  return resize(frame, Math.max(1, Math.round(frame.width * s)), Math.max(1, Math.round(target)), { filter: "auto" });
}

/**
 * Repaints one frame alone, with the sheet and its neighbours shown on the key
 * colour; `fix` is a change the judge asked for. Returns the keyed, trimmed frame,
 * or why there is none.
 */
async function repaintFrame({ client, singleParts, character, action, frames, index, key, config, sheet, adir, tag, fix = null }) {
  const count = frames.length;
  const prev = index > 0 ? frames[index - 1] : action.loop && count > 2 ? frames[count - 1] : null;
  const next = index < count - 1 ? frames[index + 1] : action.loop && count > 2 ? frames[0] : null;
  const references = [...(sheet ? [sheet.source] : []), ...(prev ? [onKey(prev, key)] : []), ...(next ? [onKey(next, key)] : [])];
  const labels = [...(sheet ? ["Model sheet: the character's front, side and back views"] : []), ...(prev ? ["The frame before"] : []), ...(next ? ["The frame after"] : [])];
  let res;
  try {
    res = await client.generate({ prompt: frameSubject({ character, action, index, count, hasSheet: Boolean(sheet), hasNeighbours: Boolean(prev || next), fix }), parts: singleParts, references, labels, aspectRatio: "1:1", size: config.size, op: `${action.name}#frame${index + 1}.${tag}` });
  } catch (err) {
    if (err.code !== "BUDGET") throw err;
    return { stopped: err.message };
  }
  if (res.blocked || !res.images.length) return { blocked: res.blocked ?? "no image in the answer", costUSD: res.costUSD };
  const painted = res.images[0];
  const source = path.join(adir, `frame${index + 1}.${tag}.source.${painted.mimeType === "image/png" ? "png" : "jpg"}`);
  await writeFile(source, painted.buffer);
  return { frame: trim(keyOut(decodeImage(painted.buffer), key, config.key).image), source, costUSD: res.costUSD };
}

export async function makeSprites({ config, name, subject = null, judge = true, useSheet = true, sheetPick = null, fetch: fetchImpl, log = (s) => process.stderr.write(s) }) {
  requireBrief(config);
  const sp = config.sprite;
  if (!name?.trim()) throw new Error("sprites needs --name: the character's name, the one its model sheet was made under");
  if (!sp.actions.length) throw new Error('sprites needs actions: set "sprite": { "actions": [{ "name": "walk", "frames": 6, "motion": "a steady walk" }] } in the config, or pass --actions "walk:6:a steady walk"');
  const label = slug(name);
  const sheet = useSheet ? await loadSheet(config, label, { pick: sheetPick }) : null;
  if (useSheet && !sheet) log(`  no model sheet at ${path.join(config.out, label, "sheet.json")}; frames are held to each other only (run onmodel sheet first to give them a reference)\n`);
  const character = String(subject ?? sheet?.subject ?? "").trim();
  if (!character) throw new Error("sprites needs --subject (who the character is) when there is no model sheet to read it from");
  const key = sheet?.key ?? (config.background === "auto" ? chooseKey(config.palette) : config.background);
  if (!key) throw new Error("sprites need a key colour to cut the poses apart, so background cannot be none for sprites");
  const cell = sp.frame ?? (config.pixel ? { width: config.pixel.grid, height: config.pixel.grid } : { width: 128, height: 128 });
  const dir = path.join(config.out, label, "sprites");
  await mkdir(dir, { recursive: true });
  const decisions = await loadDecisions(config);
  const { parts: rowParts } = await preambleParts(config, decisions, key, { layout: "row" });
  const { parts: singleParts } = await preambleParts(config, decisions, key, { layout: "single" });
  const ledgerPath = path.join(config.out, config.ledger);
  const client = new ImageClient({ model: config.model, thinking: config.thinking, pricing: config.pricing, ledgerPath, runLabel: `${label}:sprites`, budgetUSD: config.budgetUSD, fetch: fetchImpl });
  // The same image counts `price` uses: every strip of a long action, and the judged repairs.
  const counts = spriteImageCounts(sp, sp.actions, { judge });
  const minimum = client.estimate({ images: counts.best, size: config.size });
  const most = client.estimate({ images: counts.worst, size: config.size });
  log(`  ${label}: ${sp.actions.length} action${sp.actions.length === 1 ? "" : "s"} at ${cell.width}x${cell.height}${sheet ? `, held to sheet candidate ${sheet.pick}` : ""}, about $${(minimum ?? 0).toFixed(2)} if every strip lands first time, at most $${(most ?? 0).toFixed(2)} with every retry and repaint (images only)\n`);
  client.assertBudget(counts.best, config.size);

  const references = [...(sheet ? [sheet.source] : []), ...config.references];
  const labels = [...(sheet ? ["Model sheet: the character's front, side and back views"] : []), ...config.references.map((r, i) => `Reference ${i + 1}: ${path.basename(r)}`)];
  const results = [];
  for (const action of sp.actions) {
    const ran = await runAction({ action, character, client, rowParts, singleParts, references, labels, key, config, reference: referenceView(sheet, action.facing), sheet, dir, log });
    results.push(ran);
    if (ran.record.stopped) break;
  }

  // Place every finished action at its own shared scale, then one palette for the
  // whole sprite in pixel mode, so no colour flickers between frames or actions.
  const finished = results.filter((r) => r.frames);
  const placeRaw = (r) => {
    const scale = actionScale(r.frames, { width: cell.width, height: cell.height, fill: sp.fill });
    r.record.scale = round(scale, 4);
    return placeFrames(r.frames, { width: cell.width, height: cell.height, fill: sp.fill, anchor: sp.anchor, filter: config.pixel ? "box" : "auto", scale });
  };
  for (const r of finished) r.placed = placeRaw(r);
  let palette = null;
  if ((config.pixel || config.quantize) && finished.length) palette = config.palette.length ? config.palette : sharedPalette(finished.flatMap((r) => r.placed), config.pixel?.colors ?? 16);
  const finalise = (placed) => {
    let out = placed;
    if (palette) out = out.map((f) => quantize(f, { palette }).image);
    if (config.pixel) out = out.map((f) => hardenAlpha(f));
    return out;
  };
  for (const r of finished) r.placed = finalise(r.placed);

  // The judge looks inside the silhouette, where the measurements cannot see. When
  // it says redo and names frames, those frames are repainted with its fix; a
  // repaint must still pass the measurements, and a second judgement decides
  // whether the repaired action is kept or put back as it was.
  let judgeSummary = null;
  if (judge && finished.length) {
    const judgeClient = new JudgeClient({ model: config.judge, thinking: config.judgeThinking, pricing: config.pricing, ledgerPath, runLabel: `${label}:sprites`, fetch: fetchImpl });
    const scoreOf = (j) => (j && !j.error ? round((j.reads_as + j.on_model + j.smooth) / 3, 1) : -1);
    const verdictLine = (j) => `judge ${j.verdict}, reads as ${j.reads_as}, on model ${j.on_model}, smooth ${j.smooth}`;
    for (const r of finished) {
      const action = sp.actions.find((a) => a.name === r.record.name);
      const ask = (placed, measured) => judgeAction({ client: judgeClient, config, decisions, sheet, action, placed, measured, label });
      try {
        r.record.judgement = await ask(r.placed, r.measured);
        log(`    ${r.record.name}: ${verdictLine(r.record.judgement)}\n`);
      } catch (err) {
        r.record.judgement = { error: err.message };
        log(`    ${r.record.name}: judge failed, ${err.message}\n`);
        continue;
      }
      r.record.judgeRepairs = [];
      for (let pass = 1; pass <= sp.judgeRepairs; pass++) {
        const before = r.record.judgement;
        if (before.verdict !== "redo" || !before.fix_frames?.length || r.record.stopped) break;
        const repair = { pass, before: { verdict: before.verdict, score: scoreOf(before) }, frames: [], kept: false };
        r.record.judgeRepairs.push(repair);
        let frames = r.frames.slice();
        let measured = r.measured;
        for (const { frame, fix } of before.fix_frames.slice(0, 3)) {
          const i = frame - 1;
          if (!(i >= 0 && i < frames.length)) continue;
          const got = await repaintFrame({ client, singleParts, character, action, frames, index: i, key, config, sheet, adir: r.record.dir, tag: `judged${pass}`, fix });
          if (got.stopped) {
            r.record.stopped = got.stopped;
            log(`    ${action.name}: stopped, ${got.stopped}\n`);
            break;
          }
          const entry = { frame: i, fix, costUSD: got.costUSD, accepted: false };
          repair.frames.push(entry);
          if (!got.frame) {
            entry.blocked = got.blocked;
            continue;
          }
          entry.source = got.source;
          const trial = frames.slice();
          trial[i] = matchStripScale(got.frame, measured, i);
          const remeasured = measureAction(trial, { reference: r.reference, thresholds: r.thresholds, loop: action.loop });
          entry.flags = remeasured.frames[i].flags;
          if (!entry.flags.some((x) => HARD_FLAGS.includes(x))) {
            entry.accepted = true;
            frames = trial;
            measured = remeasured;
          }
          log(`    ${action.name} frame ${frame} repainted for the judge (${fix}): ${entry.accepted ? "passes the measurements" : `rejected by the measurements, ${entry.flags.join(", ")}`}\n`);
        }
        if (!repair.frames.some((x) => x.accepted)) break;
        const saved = { frames: r.frames, measured: r.measured, placed: r.placed, scale: r.record.scale };
        r.frames = frames;
        r.measured = measured;
        r.placed = finalise(placeRaw(r));
        let after;
        try {
          after = await ask(r.placed, r.measured);
        } catch (err) {
          after = { error: err.message };
        }
        repair.after = after.error ? { error: after.error } : { verdict: after.verdict, score: scoreOf(after) };
        if (!after.error && scoreOf(after) >= scoreOf(before)) {
          repair.kept = true;
          r.record.judgement = after;
          r.record.final = finalFacts(measured);
          log(`    ${action.name}: repair kept, ${verdictLine(after)} (score ${repair.before.score} to ${repair.after.score})\n`);
        } else {
          Object.assign(r, { frames: saved.frames, measured: saved.measured, placed: saved.placed });
          r.record.scale = saved.scale;
          log(`    ${action.name}: repair put back, the second judgement was no better (score ${repair.before.score} to ${repair.after.score ?? "failed"})\n`);
          break;
        }
      }
    }
    judgeSummary = judgeClient.summary();
  }

  const previewScale = config.pixel ? Math.max(1, Math.floor(128 / Math.max(cell.width, cell.height))) : 1;
  const writeAction = async (actionName, frames, fps, folder) => {
    await mkdir(folder, { recursive: true });
    const files = { frames: [] };
    for (const [i, f] of frames.entries()) {
      const file = path.join(folder, `frame_${pad2(i)}.png`);
      await writeFile(file, encodePNG(f));
      files.frames.push(file);
    }
    const big = previewScale === 1 ? frames : frames.map((f) => resize(f, f.width * previewScale, f.height * previewScale, { filter: "nearest" }));
    const delayMs = Math.round(1000 / fps);
    files.preview = path.join(folder, "preview.png");
    await writeFile(files.preview, encodeAPNG(big.map((image) => ({ image, delayMs }))));
    files.gif = path.join(folder, "preview.gif");
    await writeFile(files.gif, encodeGIF(big.map((image) => ({ image, delayMs }))));
    return files;
  };
  const packed = [];
  for (const r of finished) {
    r.record.files = await writeAction(r.record.name, r.placed, r.record.fps, r.record.dir);
    packed.push({ name: r.record.name, frames: r.placed, fps: r.record.fps });
    if (r.record.mirror) {
      const mirrored = r.placed.map((f) => mirror(f));
      r.record.mirrorFiles = await writeAction(r.record.mirror, mirrored, r.record.fps, path.join(dir, slug(r.record.mirror)));
      packed.push({ name: r.record.mirror, frames: mirrored, fps: r.record.fps });
    }
  }

  let atlas = null;
  if (packed.length) {
    const sheetImage = packActions(packed);
    const prefix = label.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "") || "SPRITE";
    atlas = {
      image: path.join(dir, `${label}.png`),
      json: path.join(dir, `${label}.json`),
      css: path.join(dir, `${label}.css`),
      header: path.join(dir, `${label}.h`),
      width: sheetImage.image.width,
      height: sheetImage.image.height,
      frame: sheetImage.frame,
      actions: sheetImage.ranges.map((x) => ({ name: x.name, from: x.from, to: x.to, fps: x.fps })),
    };
    await writeFile(atlas.image, encodePNG(sheetImage.image));
    await writeFile(atlas.json, JSON.stringify(atlasJSON(sheetImage, { file: `${label}.png` }), null, 2));
    await writeFile(atlas.css, atlasCSS(sheetImage, { file: `${label}.png`, prefix: label, pixelated: Boolean(config.pixel) }));
    await writeFile(atlas.header, atlasHeader(sheetImage, { file: `${label}.png`, prefix, guard: `${prefix}_ATLAS_H` }));
  }

  const imageSummary = client.summary();
  const costs = [imageSummary.estimatedCostUSD, judgeSummary?.estimatedCostUSD].filter((v) => v != null);
  const summary = {
    tool: "onmodel",
    kind: "sprites",
    name: label,
    character,
    dir,
    model: config.model,
    size: config.size,
    key,
    cell,
    pixel: config.pixel,
    palette,
    sheet: sheet ? { file: sheet.file, pick: sheet.pick, source: sheet.source, views: sheet.views } : null,
    actions: results.map((r) => r.record),
    atlas,
    stopped: results.find((r) => r.record.stopped)?.record.stopped ?? null,
    generatedAt: new Date().toISOString(),
    usage: { images: imageSummary, judge: judgeSummary },
    estimatedCostUSD: costs.length ? round(costs.reduce((a, b) => a + b, 0), 6) : null,
  };
  await writeFile(path.join(dir, "sprites.json"), JSON.stringify(summary, null, 2));
  const htmlPath = path.join(dir, "sprites.html");
  await writeFile(htmlPath, renderSpritesHTML(summary, dir));
  return { ...summary, htmlPath };
}
