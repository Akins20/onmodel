import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { makeSheet, makeSprites, stripAspect, stripSubject, frameSubject, retryNote, actionScale, onKey, sharedPalette, rowOnGrey, matchStripScale } from "../src/sprites.mjs";
import { measureAction } from "../src/measure.mjs";
import { DEFAULTS, merge, validate, parseActions } from "../src/config.mjs";
import { encodePNG, decodePNG, isPNG } from "../src/png.mjs";
import { apngInfo } from "../src/anim.mjs";

/**
 * The sprite pipeline end to end against a simulated image model. The fake paints
 * shapes on magenta: a model sheet is three circles, a strip is a row of poses the
 * test scripts (a circle is on model, a bar is a changed shape, a tall ellipse is a
 * changed size, a green circle is a changed colour), and a repainted frame is one
 * circle. So every path runs (retries, repairs, slicing failures, the budget) with
 * the real keying, slicing, measuring, packing and exporting.
 */

const RED = [230, 57, 70];
const GREEN = [30, 160, 60];
const MAGENTA = [255, 0, 255];

function paintPoses(poses, { width, height = 120, radius = 35 }) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([...MAGENTA, 255], i * 4);
  const n = poses.length;
  poses.forEach((pose, i) => {
    const cx = ((i + 0.5) * width) / n;
    const colour = pose.colour ?? RED;
    const baseline = height - 12;
    const rx = pose.shape === "bar" ? radius * 1.4 : radius;
    const ry = pose.shape === "bar" ? radius * 0.3 : pose.shape === "tall" ? radius * 1.5 : radius;
    const cy = baseline - ry;
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const inside = pose.shape === "bar" ? Math.abs(x - cx) <= rx && Math.abs(y - cy) <= ry : ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
        if (inside) data.set([...colour, 255], (y * width + x) * 4);
      }
    }
  });
  return encodePNG({ width, height, data });
}

const circles = (n) => Array.from({ length: n }, () => ({ shape: "circle" }));
const USAGE = { promptTokenCount: 300, candidatesTokenCount: 1392, totalTokenCount: 2569, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }], thoughtsTokenCount: 877 };

/**
 * script.strip(name, attempt, count) returns the poses to paint for that strip (or
 * null for a clean row of circles) and `width` to paint them across; script.frame
 * (frame, attempt) the poses for a repainted frame.
 */
function fakeApi(script = {}) {
  const calls = [];
  const counters = {};
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    const u = String(url);
    calls.push({ url: u, body });
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (u.includes("gemini-3.8-flash:generateContent")) {
      const props = body.generationConfig.responseSchema.properties;
      let data;
      if (props.reads_as) {
        const asked = body.contents[0].parts.map((p) => p.text ?? "").join("\n").match(/## Action\n"([^"]+)"/)?.[1];
        counters[`judge:${asked}`] = (counters[`judge:${asked}`] ?? 0) + 1;
        data = script.judge?.(asked, counters[`judge:${asked}`]) ?? { reads_as: 82, on_model: 90, smooth: 86, problems: [], frame_notes: [{ frame: 2, note: "the mouth could open wider" }], fix_frames: [], verdict: "keep" };
      } else data = { candidates: [1, 2, 3].map((index) => ({ index, on_brief: 70 + index, on_model: 100, craft: 80, problems: [], strengths: [] })), pick: 2, reason: "The views agree.", edit: "" };
      return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 2000, candidatesTokenCount: 150, thoughtsTokenCount: 600, totalTokenCount: 2750 } });
    }
    const prompt = body.contents[body.contents.length - 1].parts.at(-1).text;
    let png;
    let m;
    if (/A model sheet/.test(prompt)) png = paintPoses(circles(3), { width: 330 });
    else if ((m = prompt.match(/Paint frame (\d+) of (\d+)/))) {
      const frame = Number(m[1]);
      counters[`frame${frame}`] = (counters[`frame${frame}`] ?? 0) + 1;
      // A frame painted alone comes back at twice the strip's scale, as it does from
      // the real model (a square image with the character filling most of it).
      png = paintPoses(script.frame?.(frame, counters[`frame${frame}`]) ?? circles(1), { width: 240, height: 240, radius: 70 });
    } else if ((m = prompt.match(/Action "([^"]+)"/))) {
      const name = m[1];
      counters[name] = (counters[name] ?? 0) + 1;
      const count = Number((prompt.match(/Paint (\d+) frames/) ?? [0, 1])[1]);
      const scripted = script.strip?.(name, counters[name], count);
      png = paintPoses(scripted ?? circles(count), { width: 110 * count });
    } else throw new Error(`the fake does not know this prompt: ${prompt.slice(0, 80)}`);
    return ok({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: png.toString("base64") } }] }, finishReason: "STOP" }], usageMetadata: USAGE });
  };
  return { calls, fetchImpl, counters };
}

const BRIEF = `# Player art brief

## Product
Chomp is a maze game for Android where a round, hungry creature eats dots; this art is the player as an animated sprite drawn at small sizes.

## Art direction
Chunky flat shapes, one flat red body, a dark outline, no gradients, friendly and greedy, readable against a dark maze at a glance.

## Palette
Body #E63946, outline #1D1A1E, highlight #FFFFFF.
`;

async function setup(over = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-spr-"));
  const config = validate(
    merge(DEFAULTS, {
      brief: path.join(dir, "brief.md"),
      out: path.join(dir, "out"),
      background: "#ff00ff",
      palette: ["#e63946", "#1d1a1e", "#ffffff"],
      budgetUSD: 5,
      sprite: { frame: 64, actions: [{ name: "chomp", frames: 4, fps: 8, motion: "mouth opening wide then snapping shut", mirror: "chomp_left" }, { name: "die", frames: 3, loop: false, motion: "spinning and shrinking away" }], retries: 2, frameRetries: 1 },
      ...over,
    }),
  );
  config.briefText = BRIEF;
  return { dir, config };
}

async function withKey(fn) {
  const before = process.env.GEMINI_API_KEY;
  process.env.GEMINI_API_KEY = "test-key-not-real";
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = before;
  }
}

const quiet = () => {};

test("prompts: the strip says how many frames, which way, whether it loops, and what went wrong last time", () => {
  assert.equal(stripAspect(1), "1:1");
  assert.equal(stripAspect(4), "16:9");
  assert.equal(stripAspect(6), "21:9");
  const action = { name: "walk", motion: "a steady walk", facing: "left", loop: true };
  const s = stripSubject({ character: "a red ball", action, count: 6, hasSheet: true, note: "frame 2 changed the character's shape." });
  assert.match(s, /^## Subject\na red ball/);
  assert.match(s, /Paint 6 frames of this action in a single horizontal row/);
  assert.match(s, /last frame leads smoothly back into the first/);
  assert.match(s, /same character as the model sheet/);
  assert.match(s, /facing left/);
  assert.match(s, /The previous attempt went wrong: frame 2 changed the character's shape\. Fix that\./);
  assert.match(stripSubject({ character: "x", action: { ...action, loop: false }, count: 4, hasSheet: false }), /same character in every frame/);
  assert.doesNotMatch(stripSubject({ character: "x", action: { ...action, loop: false }, count: 4, hasSheet: false }), /leads smoothly back/);
  assert.match(frameSubject({ character: "x", action, index: 2, count: 6, hasSheet: true, hasNeighbours: true }), /Paint frame 3 of 6 .*the model sheet and the neighbouring frames shown, the pose that comes between them/);

  const measured = { frames: [{ index: 0, flags: [] }, { index: 1, flags: ["shape"] }, { index: 2, flags: ["size", "jump"] }], jumps: [2] };
  const note = retryNote({ method: "equal", found: 2 }, measured, 3);
  assert.match(note, /drew 2 separate poses where 3 were asked for/);
  assert.match(note, /frame 2 changed the character's shape/);
  assert.match(note, /frame 3 drew the character at a different size/);
  assert.match(note, /the motion jumps at frame 3/);
});

test("an action is measured against the sheet for shape and colour, against itself for size, and around its seam", () => {
  // The pipeline measures keyed frames, so these are painted with the magenta made transparent.
  const keyed = (png) => {
    const img = decodePNG(png);
    for (let i = 0; i < img.width * img.height; i++) if (img.data[i * 4] === 255 && img.data[i * 4 + 1] === 0 && img.data[i * 4 + 2] === 255) img.data[i * 4 + 3] = 0;
    return img;
  };
  const ref = keyed(paintPoses(circles(1), { width: 120 }));
  const frame = (pose) => keyed(paintPoses([pose], { width: 120 }));
  const clean = measureAction([frame({}), frame({}), frame({})], { reference: ref });
  assert.deepEqual(clean.flagged, []);
  assert.deepEqual(clean.jumps, []);
  assert.ok(clean.meanIoU > 0.9);
  const drift = measureAction([frame({}), frame({ shape: "bar" }), frame({ shape: "tall" }), frame({ colour: GREEN })], { reference: ref, loop: false });
  assert.deepEqual(drift.frames[1].flags.includes("shape"), true);
  assert.ok(drift.frames[2].flags.includes("size"), `a taller frame is a size drift, got ${drift.frames[2].flags}`);
  assert.ok(drift.frames[3].flags.includes("colour"));
  assert.deepEqual(drift.flagged, [1, 2, 3]);
  const seam = measureAction([frame({ shape: "bar" }), frame({}), frame({}), frame({})], { loop: true });
  assert.ok(seam.frames[0].flags.includes("seam"), "the first frame is compared with the last when the action loops");
  const noRef = measureAction([frame({}), frame({ colour: GREEN })]);
  assert.ok(noRef.frames[1].flags.includes("colour"), "without a sheet, colours are held to the first frame");
});

test("a frame repainted alone is brought into the strip's scale before it is measured", () => {
  const box = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) });
  const measured = { medianHeight: 70, frames: [{ height: 70, flags: [] }, { height: 56, flags: [] }, { height: 120, flags: ["size"] }] };
  const repaint = box(150, 140);
  const kept = matchStripScale(repaint, measured, 1);
  assert.deepEqual([kept.width, kept.height], [60, 56], "as tall as the frame it replaces, so an intended squash survives");
  const corrected = matchStripScale(repaint, measured, 2);
  assert.deepEqual([corrected.width, corrected.height], [75, 70], "a frame that was the wrong size is brought to the median");
  assert.equal(matchStripScale(box(10, 56), measured, 1).height, 56);
});

test("helpers: one scale per action, neighbours shown on the key colour, one palette for the whole sprite", () => {
  const box = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h * 4).fill(255) });
  assert.ok(Math.abs(actionScale([box(10, 40), box(10, 40), box(10, 42)], { width: 64, height: 64, fill: 0.9 }) - 57.6 / 40) < 1e-9, "the median frame fills the cell");
  assert.ok(Math.abs(actionScale([box(10, 40), box(10, 40), box(10, 100)], { width: 64, height: 64, fill: 0.9 }) - 62.72 / 100) < 1e-9, "unless the tallest would not fit");
  const shown = decodePNG(onKey(box(10, 10), "#ff00ff"));
  assert.ok(shown.width > 10 && isPNG(onKey(box(4, 4), "#00ff00")));
  assert.deepEqual(Array.from(shown.data.subarray(0, 3)), MAGENTA, "the padding is the key colour");
  const a = { width: 2, height: 1, data: new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]) };
  const b = { width: 2, height: 1, data: new Uint8Array([0, 255, 0, 255, 0, 0, 0, 0]) };
  assert.equal(sharedPalette([a, b], 3).length, 3, "the palette is drawn from every frame, transparent pixels left out");
  const row = rowOnGrey([a, b], { scale: 2 });
  assert.equal(row.height, 2 + 16);
});

test("the model sheet is three views, sliced, measured, and the judge's pick is kept", async () => {
  const { config } = await setup();
  const { calls, fetchImpl } = fakeApi();
  const result = await withKey(() => makeSheet({ config, subject: "Chomp, a round red creature with a huge mouth", name: "player", fetch: fetchImpl, log: quiet }));
  assert.equal(result.sheet.pick, 2);
  assert.equal(result.sheet.pickedBy, "judge");
  assert.deepEqual(Object.keys(result.sheet.views), ["front", "side", "back"]);
  for (const c of result.sheet.candidates) {
    assert.equal(c.sheet.found, 3);
    assert.equal(c.sheet.method, "gaps");
    assert.ok(c.sheet.heightSpread < 0.05, "three circles of one size agree");
  }
  const saved = JSON.parse(await readFile(path.join(config.out, "player", "sheet.json"), "utf8"));
  assert.equal(saved.subject, "Chomp, a round red creature with a huge mouth", "the character is kept without the sheet's layout text");
  assert.equal(saved.key, "#ff00ff");
  for (const f of Object.values(saved.views)) await access(f);
  const paint = calls.find((c) => c.url.includes("nano-banana"));
  assert.deepEqual(paint.body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "1K" });
  const rules = paint.body.contents[0].parts[0].text;
  assert.match(rules, /laid out as the subject describes/, "a row layout, not a centred subject");
  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /model sheet/);
  assert.match(html, /figcaption>side</);
});

test("a clean run paints one strip per action, packs the atlas, exports it, previews it and judges it", async () => {
  const { config } = await setup();
  const api = fakeApi();
  await withKey(() => makeSheet({ config, subject: "a round red creature", name: "player", fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => makeSprites({ config, name: "player", fetch: api.fetchImpl, log: quiet }));
  const [chomp, die] = result.actions;
  assert.equal(chomp.attempts.length, 1, "a clean strip is not painted twice");
  assert.equal(chomp.best, 1);
  assert.deepEqual(chomp.final.flagged, []);
  assert.ok(chomp.final.meanIoU > 0.9, `frames match the sheet, got ${chomp.final.meanIoU}`);
  assert.equal(die.frames, 3);
  assert.equal(result.sheet.pick, 2);

  assert.equal(result.atlas.width, 4 * 64, "as wide as the longest action");
  assert.equal(result.atlas.height, 3 * 64, "chomp, its mirror, and die");
  assert.deepEqual(result.atlas.actions.map((a) => a.name), ["chomp", "chomp_left", "die"]);
  const json = JSON.parse(await readFile(result.atlas.json, "utf8"));
  assert.equal(json.meta.image, "player.png");
  assert.equal(json.meta.frameTags.length, 3);
  assert.equal(json.frames["chomp_left_3"].frame.y, 64);
  assert.match(await readFile(result.atlas.css, "utf8"), /\.player-chomp_left \{ background-position: 0px -64px; animation: player-chomp_left 0\.5s steps\(4\) infinite; \}/);
  const header = await readFile(result.atlas.header, "utf8");
  assert.match(header, /#ifndef PLAYER_ATLAS_H/);
  assert.match(header, /PLAYER_CHOMP_LEFT = 1/);
  assert.match(header, /static const PlayerFrame PLAYER_FRAMES\[11\]/);
  assert.deepEqual(apngInfo(await readFile(chomp.files.preview)), { frames: 4, delaysMs: [125, 125, 125, 125] });
  assert.equal((await readFile(chomp.files.gif)).toString("ascii", 0, 6), "GIF89a");
  await access(chomp.mirrorFiles.preview);
  const atlas = decodePNG(await readFile(result.atlas.image));
  assert.equal(atlas.width, 256);

  assert.equal(chomp.judgement.verdict, "keep");
  assert.equal(api.calls.filter((c) => c.url.includes("gemini-3.8-flash") && c.body.generationConfig.responseSchema.properties.reads_as).length, 2, "each painted action is judged once, its mirror is not");
  const strip = api.calls.find((c) => c.url.includes("nano-banana") && /Action "chomp"/.test(c.body.contents[0].parts.at(-1).text));
  assert.deepEqual(strip.body.generationConfig.imageConfig, { aspectRatio: "16:9", imageSize: "1K" });
  const parts = strip.body.contents[0].parts;
  assert.ok(parts.some((p) => p.text?.startsWith("Model sheet")), "the sheet goes to the painter, labelled");
  assert.ok(parts.filter((p) => p.inlineData).length >= 1);
  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /chomp_left \(mirrored\)/);
  assert.match(html, /TexturePacker hash/);
  assert.ok(result.estimatedCostUSD > 0);
});

test("a strip whose frame changes shape is painted again, told what went wrong, and the better strip is used", async () => {
  const { config } = await setup({ sprite: { frame: 64, actions: [{ name: "chomp", frames: 4, motion: "chomping" }], retries: 2, frameRetries: 0 } });
  const api = fakeApi({ strip: (name, attempt) => (attempt === 1 ? [{}, { shape: "bar" }, {}, {}] : null) });
  await withKey(() => makeSheet({ config, subject: "a round red creature", name: "player", fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => makeSprites({ config, name: "player", judge: false, fetch: api.fetchImpl, log: quiet }));
  const chomp = result.actions[0];
  assert.equal(chomp.attempts.length, 2);
  assert.deepEqual(chomp.attempts[0].flagged, [1]);
  assert.equal(chomp.best, 2);
  assert.deepEqual(chomp.final.flagged, []);
  const second = api.calls.filter((c) => c.url.includes("nano-banana") && /Action "chomp"/.test(c.body.contents[0].parts.at(-1).text))[1];
  // A bar is also shorter than a circle and breaks the steps into and out of it, and the note says all of that.
  assert.match(second.body.contents[0].parts.at(-1).text, /The previous attempt went wrong: frame 2 changed the character's shape; frame 2 drew the character at a different size; the motion jumps at frames 2 and 3\. Fix that\./);
});

test("a frame that stays wrong through every strip is repainted alone between its neighbours", async () => {
  const { config } = await setup({ sprite: { frame: 64, actions: [{ name: "chomp", frames: 4, motion: "chomping" }], retries: 1, frameRetries: 1 } });
  const api = fakeApi({ strip: () => [{}, {}, { shape: "bar" }, {}] });
  await withKey(() => makeSheet({ config, subject: "a round red creature", name: "player", fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => makeSprites({ config, name: "player", judge: false, fetch: api.fetchImpl, log: quiet }));
  const chomp = result.actions[0];
  assert.equal(chomp.attempts.length, 2, "both strips were tried first");
  assert.equal(chomp.fixes.length, 1);
  assert.equal(chomp.fixes[0].frame, 2);
  assert.equal(chomp.fixes[0].accepted, true);
  assert.ok(chomp.fixes[0].before.includes("shape"));
  assert.deepEqual(chomp.final.flagged, [], "the repaint fixed it");
  const repaint = api.calls.find((c) => /Paint frame 3 of 4/.test(c.body.contents?.[0]?.parts?.at(-1)?.text ?? ""));
  const labels = repaint.body.contents[0].parts.filter((p) => p.text && !p.text.startsWith("##")).map((p) => p.text);
  assert.ok(labels.includes("The frame before") && labels.includes("The frame after"), `the neighbours are shown, labelled: ${labels}`);
  assert.deepEqual(repaint.body.generationConfig.imageConfig.aspectRatio, "1:1");
});

test("poses that run together are caught by the slicing and the painter is told how many it drew", async () => {
  const { config } = await setup({ sprite: { frame: 64, actions: [{ name: "chomp", frames: 4, motion: "chomping" }], retries: 2, frameRetries: 0 } });
  const api = fakeApi({ strip: (name, attempt) => (attempt === 1 ? [{}, {}] : null) });
  await withKey(() => makeSheet({ config, subject: "a round red creature", name: "player", fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => makeSprites({ config, name: "player", judge: false, fetch: api.fetchImpl, log: quiet }));
  const chomp = result.actions[0];
  assert.equal(chomp.attempts[0].slicing.method, "equal");
  assert.equal(chomp.attempts[0].slicing.found, 2);
  assert.equal(chomp.best, 2);
  assert.match(chomp.attempts[1].note, /drew 2 separate poses where 4 were asked for/);
});

test("without a sheet a sequence is held to itself, and the character comes from --subject", async () => {
  const { config } = await setup({ sprite: { frame: 48, actions: [{ name: "bounce", frames: 3, motion: "a bounce" }], retries: 0, frameRetries: 0 } });
  const api = fakeApi();
  await assert.rejects(() => withKey(() => makeSprites({ config, name: "ball", useSheet: false, judge: false, fetch: api.fetchImpl, log: quiet })), /needs --subject/);
  const result = await withKey(() => makeSprites({ config, name: "ball", subject: "a red ball", useSheet: false, judge: false, fetch: api.fetchImpl, log: quiet }));
  assert.equal(result.sheet, null);
  assert.equal(result.actions[0].final.meanIoU, null, "no sheet, no shape match against one");
  assert.deepEqual(result.actions[0].final.flagged, []);
  assert.equal(result.atlas.width, 3 * 48);
  assert.match(api.calls[0].body.contents[0].parts.at(-1).text, /same character in every frame/);
});

test("a run that cannot afford one strip per action is refused before anything is painted", async () => {
  const { config } = await setup({ budgetUSD: 0.05 });
  const api = fakeApi();
  await assert.rejects(() => withKey(() => makeSprites({ config, name: "x", subject: "a red ball", useSheet: false, fetch: api.fetchImpl, log: quiet })), (err) => err.code === "BUDGET");
  assert.equal(api.calls.length, 0);
});

test("pixel mode places frames on the grid, with one palette and hard alpha across the whole sprite", async () => {
  const { config } = await setup({ pixel: { grid: 32, colors: 4 }, sprite: { frame: null, actions: [{ name: "chomp", frames: 4, motion: "chomping", mirror: "chomp_left" }], retries: 0, frameRetries: 0 } });
  const api = fakeApi();
  const result = await withKey(() => makeSprites({ config, name: "player", subject: "a round red creature", useSheet: false, judge: false, fetch: api.fetchImpl, log: quiet }));
  assert.deepEqual(result.cell, { width: 32, height: 32 });
  assert.deepEqual(result.palette, ["#e63946", "#1d1a1e", "#ffffff"], "the brief's palette is the sprite's palette");
  const atlas = decodePNG(await readFile(result.atlas.image));
  assert.equal(atlas.width, 128);
  assert.equal(atlas.height, 64);
  const allowed = new Set(result.palette);
  for (let i = 0; i < atlas.width * atlas.height; i++) {
    const a = atlas.data[i * 4 + 3];
    assert.ok(a === 0 || a === 255, `hard alpha only, found ${a}`);
    if (a === 255) {
      const hexv = "#" + [0, 1, 2].map((c) => atlas.data[i * 4 + c].toString(16).padStart(2, "0")).join("");
      assert.ok(allowed.has(hexv), `${hexv} is not in the palette`);
    }
  }
  const preview = decodePNG(await readFile(result.actions[0].files.preview));
  assert.equal(preview.width, 128, "previews are enlarged with hard pixels so people can see them");
});

const REDO = { reads_as: 60, on_model: 50, smooth: 70, problems: ["frame 2 eye turns to face the viewer"], frame_notes: [], fix_frames: [{ frame: 2, fix: "draw the eye in side profile, as on the model sheet" }], verdict: "redo" };
const KEEP = { reads_as: 80, on_model: 88, smooth: 84, problems: [], frame_notes: [], fix_frames: [], verdict: "keep" };
const WORSE = { reads_as: 50, on_model: 40, smooth: 60, problems: ["now frame 2 is worse"], frame_notes: [], fix_frames: [{ frame: 2, fix: "x" }], verdict: "redo" };
const oneAction = { sprite: { frame: 64, actions: [{ name: "chomp", frames: 4, motion: "chomping" }], retries: 0, frameRetries: 0, judgeRepairs: 1 } };

test("when the judge says redo, its named frame is repainted with its fix, and a better second judgement keeps the repair", async () => {
  const { config } = await setup(oneAction);
  const api = fakeApi({ judge: (name, n) => (n === 1 ? REDO : KEEP) });
  await withKey(() => makeSheet({ config, subject: "a round red creature", name: "player", fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => makeSprites({ config, name: "player", fetch: api.fetchImpl, log: quiet }));
  const chomp = result.actions[0];
  assert.equal(chomp.judgeRepairs.length, 1);
  const [repair] = chomp.judgeRepairs;
  assert.equal(repair.kept, true);
  assert.deepEqual([repair.before.score, repair.after.score], [60, 84]);
  assert.equal(repair.frames[0].frame, 1, "frame 2, counted from 0");
  assert.equal(repair.frames[0].accepted, true, "the repaint passed the measurements");
  assert.equal(chomp.judgement.verdict, "keep", "the second judgement is the one reported");
  const repaint = api.calls.find((c) => /Paint frame 2 of 4/.test(c.body.contents?.[0]?.parts?.at(-1)?.text ?? ""));
  assert.match(repaint.body.contents[0].parts.at(-1).text, /What to fix in this frame: draw the eye in side profile, as on the model sheet/);
  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /Repaired for the judge/);
  assert.match(html, /Score 60 to 84: <span class="okc">kept/);
});

test("a repair the second judgement scores worse is put back", async () => {
  const { config } = await setup(oneAction);
  const api = fakeApi({ judge: (name, n) => (n === 1 ? REDO : WORSE) });
  await withKey(() => makeSheet({ config, subject: "a round red creature", name: "player", fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => makeSprites({ config, name: "player", fetch: api.fetchImpl, log: quiet }));
  const chomp = result.actions[0];
  assert.equal(chomp.judgeRepairs[0].kept, false);
  assert.equal(chomp.judgement.verdict, "redo", "the first judgement stands, since the repair was put back");
  assert.equal(chomp.judgement.on_model, 50);
});

test("a judged repaint that breaks the measurements is rejected before the judge is asked again", async () => {
  const { config } = await setup(oneAction);
  const api = fakeApi({ judge: () => REDO, frame: () => [{ shape: "bar" }] });
  await withKey(() => makeSheet({ config, subject: "a round red creature", name: "player", fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => makeSprites({ config, name: "player", fetch: api.fetchImpl, log: quiet }));
  const chomp = result.actions[0];
  assert.equal(chomp.judgeRepairs[0].frames[0].accepted, false);
  assert.ok(chomp.judgeRepairs[0].frames[0].flags.includes("shape"));
  assert.equal(chomp.judgeRepairs[0].kept, false);
  assert.equal(api.counters["judge:chomp"], 1, "no second judgement for a repair that was never applied");
});

test("sprite settings are checked in plain words and the --actions shorthand reads", () => {
  assert.deepEqual(parseActions("walk:6:a steady walk, arms swinging;jump:5"), [{ name: "walk", frames: 6, motion: "a steady walk, arms swinging" }, { name: "jump", frames: 5 }]);
  const bad = (sprite, re) => assert.throws(() => validate(merge(DEFAULTS, { sprite })), re);
  bad({ actions: [{ name: "walk", frames: 0 }] }, /needs frames from 1 to 8/);
  bad({ actions: [{ name: "walk", frames: 9 }] }, /needs frames from 1 to 8/);
  bad({ actions: [{ name: "walk", frames: 4, facing: "up" }] }, /facing must be one of right, left, front, back/);
  bad({ actions: [{ name: "walk", frames: 4, mirror: "walk" }] }, /used twice/);
  bad({ actions: [{ name: "walk", frames: 4 }, { name: "walk", frames: 2 }] }, /used twice/);
  bad({ actions: [{ name: "a/b", frames: 4 }] }, /name must be letters/);
  bad({ frame: "big" }, /sprite.frame must be a size/);
  bad({ fill: 1.5 }, /sprite.fill/);
  bad({ thresholds: { wobble: 1 } }, /is not a threshold/);
  bad({ retries: 9 }, /sprite.retries/);
  const ok = validate(merge(DEFAULTS, { sprite: { frame: "64x48", actions: [{ name: "walk", frames: 6 }] } }));
  assert.deepEqual(ok.sprite.frame, { width: 64, height: 48 });
  assert.deepEqual(ok.sprite.actions[0], { name: "walk", frames: 6, fps: 8, motion: "walk", facing: "right", mirror: null, loop: true });
});
