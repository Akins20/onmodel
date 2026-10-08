import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { editCandidate, parseCandidateId, fileBase, editPrompt, editFacts } from "../src/edit.mjs";
import { generate } from "../src/generate.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";
import { decodeJPEG } from "../src/jpeg.mjs";
import { encodePNG } from "../src/png.mjs";

/**
 * Edits against a simulated API: a run is generated first (the probe cat on
 * magenta), then edited. The fake answers an edit turn with the same cat with a
 * green patch painted on it, so the edit measurably changes some pixels and keeps
 * the silhouette, the way a recolour should.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const BRIEF = `# Cat art brief

## Product
A maze game where a round orange cat eats dots and runs from dogs; this art is the cat as an app icon and a sticker, warm and a little greedy.

## Art direction
Chunky flat shapes with a thick near-black outline, no gradients, one light from the top left, friendly and simple, sits beside Crossy Road.

## Palette
Fur #F5A623, outline #1D1A1E, eyes and teeth #FFFFFF.
`;
const USAGE = { promptTokenCount: 42, candidatesTokenCount: 1392, totalTokenCount: 2311, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }], thoughtsTokenCount: 877 };

async function fakeApi({ blockEdits = false } = {}) {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const patched = decodeJPEG(jpeg);
  for (let y = 110; y < 150; y++) for (let x = 108; x < 148; x++) patched.data.set([30, 160, 60, 255], (y * patched.width + x) * 4);
  const patchedPNG = encodePNG(patched);
  const calls = [];
  const fetchImpl = async (url, opts = {}) => {
    const body = JSON.parse(opts.body);
    const u = String(url);
    calls.push({ url: u, body });
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (u.includes("gemini-3.8-flash")) {
      const props = body.generationConfig.responseSchema.properties;
      const data = props.applied
        ? { applied: 88, preserved: 91, problems: [], verdict: "keep" }
        : { candidates: [1, 2].map((index) => ({ index, on_brief: 70 + index, on_model: 100, craft: 80, problems: [], strengths: [] })), pick: 2, reason: "Two reads better.", edit: "Make the eyes larger." };
      return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 1500, candidatesTokenCount: 80, thoughtsTokenCount: 400, totalTokenCount: 1980 } });
    }
    const last = body.contents[body.contents.length - 1].parts.at(-1).text ?? "";
    if (last.startsWith("## Edit")) {
      if (blockEdits) return ok({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 40, totalTokenCount: 40 } });
      return ok({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/png", data: patchedPNG.toString("base64") } }] }, finishReason: "STOP" }], usageMetadata: USAGE });
    }
    return ok({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: jpeg.toString("base64") } }] }, finishReason: "STOP" }], usageMetadata: USAGE });
  };
  return { calls, fetchImpl };
}

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-edit-"));
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, BRIEF);
  const config = validate(merge(DEFAULTS, { brief, background: "#ff00ff", sizes: ["64"], candidates: 2, out: path.join(dir, "out"), budgetUSD: 2 }));
  config.briefText = BRIEF;
  config.palette = ["#f5a623", "#1d1a1e", "#ffffff"];
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

test("candidate ids name a candidate or an edit, and file names follow them", () => {
  assert.deepEqual(parseCandidateId("2"), { root: 2, edit: 0, id: "2" });
  assert.deepEqual(parseCandidateId("2e3"), { root: 2, edit: 3, id: "2e3" });
  assert.deepEqual(parseCandidateId(4), { root: 4, edit: 0, id: "4" });
  assert.throws(() => parseCandidateId("two"), /is not a candidate/);
  assert.equal(fileBase({ root: 2, edit: 0 }), "02");
  assert.equal(fileBase({ root: 12, edit: 3 }), "12e3");
  const p = editPrompt("make the scarf red", "#ff00ff");
  assert.match(p, /^## Edit\nmake the scarf red\nChange only that\./);
  assert.match(p, /same flat #ff00ff background/);
});

test("an edit's facts say how much moved and whether the silhouette held", () => {
  const box = (fill) => {
    const img = { width: 20, height: 20, data: new Uint8Array(20 * 20 * 4) };
    for (let y = 5; y < 15; y++) for (let x = 5; x < 15; x++) img.data.set(fill, (y * 20 + x) * 4);
    return img;
  };
  const same = editFacts(box([200, 0, 0, 255]), box([200, 0, 0, 255]));
  assert.deepEqual(same, { changed: 0, silhouette: 1 });
  const recoloured = editFacts(box([200, 0, 0, 255]), box([0, 0, 200, 255]));
  assert.equal(recoloured.changed, 0.25, "a recolour moves the pixels of the subject");
  assert.equal(recoloured.silhouette, 1, "and keeps its shape");
});

test("an edit continues the candidate's conversation, is measured against it, judged, and recorded", async () => {
  const { config } = await setup();
  const api = await fakeApi();
  const run = await withKey(() => generate({ config, subject: "the cat head", name: "cat", fetch: api.fetchImpl, log: quiet }));
  assert.equal(run.pick, 2);
  const before = api.calls.length;
  const result = await withKey(() => editCandidate({ config, name: "cat", change: "paint a green patch on its forehead", fetch: api.fetchImpl, log: quiet }));
  assert.equal(result.id, "2e1", "the judge's pick is edited when no candidate is named");
  assert.equal(result.parent, "2");
  const paint = api.calls.slice(before).find((c) => c.url.includes("nano-banana"));
  assert.equal(paint.body.contents.length, 3, "the earlier turns go back with the new instruction");
  assert.equal(paint.body.contents[0].role, "user");
  assert.equal(paint.body.contents[1].role, "model");
  assert.ok(paint.body.contents[1].parts[0].inlineData, "the model's own picture is in the history it is asked to change");
  assert.match(paint.body.contents[2].parts.at(-1).text, /^## Edit\npaint a green patch on its forehead/);
  assert.deepEqual(paint.body.generationConfig.imageConfig, { aspectRatio: "1:1", imageSize: "1K" });

  for (const f of ["02e1.source.png", "02e1.png", "02e1.64x64.png", "02e1.json"]) await access(path.join(run.dir, f));
  assert.ok(result.facts.edit.changed > 0 && result.facts.edit.changed < 0.2, `a patch, not a repaint: ${result.facts.edit.changed}`);
  assert.ok(result.facts.edit.silhouette > 0.9, `the silhouette held: ${result.facts.edit.silhouette}`);
  assert.equal(result.judgement.verdict, "keep");
  assert.equal(result.judgement.applied, 88);
  const sidecar = JSON.parse(await readFile(path.join(run.dir, "02e1.json"), "utf8"));
  assert.equal(sidecar.parent, "2");
  assert.equal(sidecar.turns.length, 4, "the conversation grows, so the edit can be edited");
  const summary = JSON.parse(await readFile(path.join(run.dir, "generate.json"), "utf8"));
  assert.equal(summary.edits.length, 1);
  assert.equal(summary.edits[0].change, "paint a green patch on its forehead");
  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /<h2 class="edits">Edits<\/h2>/);
  assert.match(html, /paint a green patch on its forehead/);
  assert.match(html, /before \(2\)/);

  const chained = await withKey(() => editCandidate({ config, name: "cat", candidate: "2e1", change: "make the patch smaller", judge: false, fetch: api.fetchImpl, log: quiet }));
  assert.equal(chained.id, "2e2", "edits of a candidate are numbered in one flat chain");
  assert.equal(chained.parent, "2e1");
  const second = api.calls.filter((c) => c.url.includes("nano-banana")).at(-1);
  assert.equal(second.body.contents.length, 5, "the whole chain goes back");
  const again = await withKey(() => editCandidate({ config, name: "cat", candidate: "1", change: "close the mouth", judge: false, fetch: api.fetchImpl, log: quiet }));
  assert.equal(again.id, "1e1");
});

test("an edit the model will not paint is recorded, not thrown", async () => {
  const { config } = await setup();
  const api = await fakeApi({ blockEdits: true });
  await withKey(() => generate({ config, subject: "the cat head", name: "cat", judge: false, fetch: api.fetchImpl, log: quiet }));
  const result = await withKey(() => editCandidate({ config, name: "cat", candidate: "1", change: "x", fetch: api.fetchImpl, log: quiet }));
  assert.equal(result.blocked, "SAFETY");
  assert.equal(result.files.image, undefined);
  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /Not painted: SAFETY/);
});

test("edit says what is missing: the change, the run, or the candidate", async () => {
  const { config } = await setup();
  const api = await fakeApi();
  await assert.rejects(() => withKey(() => editCandidate({ config, name: "cat", change: " ", fetch: api.fetchImpl })), /needs --change/);
  await assert.rejects(() => withKey(() => editCandidate({ config, name: "nothing-here", change: "x", fetch: api.fetchImpl })), /no run to edit/);
  await withKey(() => generate({ config, subject: "the cat head", name: "cat", judge: false, fetch: api.fetchImpl, log: quiet }));
  await assert.rejects(() => withKey(() => editCandidate({ config, name: "cat", change: "x", fetch: api.fetchImpl })), /no pick to default to/);
  await assert.rejects(() => withKey(() => editCandidate({ config, name: "cat", candidate: "7", change: "x", fetch: api.fetchImpl })), /no candidate 7 .*there are 1, 2/s);
});
