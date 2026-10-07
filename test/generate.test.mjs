import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generate, painterRules, processCandidate, slug } from "../src/generate.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";
import { decodePNG } from "../src/png.mjs";
import { decodeJPEG } from "../src/jpeg.mjs";
import { colorCount } from "../src/key.mjs";

/**
 * The generation loop end to end against a simulated API: the image model answers
 * with the probe cat on magenta, the judge answers with a ranking, and the whole
 * run (prompt assembly, keying, sizes, sidecars, contact sheet, ledger, budget)
 * is checked without a key or a bill.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const BRIEF = `# Cat art brief

## Product
A maze game where a round orange cat eats dots and runs from dogs; this art is the cat as an app icon and a sticker, warm and a little greedy.

## Audience
Players on mid-range Android phones who know Pac-Man; they see it at 48 to 192 pixels.

## Art direction
Chunky flat shapes with a thick near-black outline, no gradients, one light from the top left, friendly and simple, sits beside Crossy Road.

## Palette
Fur #F5A623, outline #1D1A1E, eyes and teeth #FFFFFF.

## Do not
No text, no watermark, no realistic fur.
`;

const USAGE = { promptTokenCount: 42, candidatesTokenCount: 1392, totalTokenCount: 2311, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }], thoughtsTokenCount: 877 };

function fakeApi(jpegBase64, { blockThird = true, judgement, usage = USAGE } = {}) {
  const calls = [];
  let paints = 0;
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    const u = String(url);
    calls.push({ url: u, body });
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (u.includes("gemini-3.8-flash:generateContent")) {
      const data = judgement ?? {
        candidates: [
          { index: 1, on_brief: 70, on_model: 100, craft: 60, problems: ["the left ear is cut"], strengths: ["warm colour"] },
          { index: 2, on_brief: 85, on_model: 100, craft: 80, problems: [], strengths: ["clean silhouette"] },
        ],
        pick: 2,
        reason: "Candidate 2 reads as the brief's cat at 48 pixels.",
        edit: "Thicken the outline to match the palette's near-black.",
      };
      return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 200, thoughtsTokenCount: 900, totalTokenCount: 4100 } });
    }
    paints += 1;
    if (blockThird && paints === 3) return ok({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 40, totalTokenCount: 40 } });
    return ok({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: jpegBase64 } }] }, finishReason: "STOP" }], usageMetadata: usage });
  };
  return { calls, fetchImpl };
}

async function setup(over = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-gen-"));
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, BRIEF);
  const config = validate(merge(DEFAULTS, { brief, background: "#ff00ff", sizes: ["64"], candidates: 3, out: path.join(dir, "out"), budgetUSD: 1, ...over }));
  config.briefText = BRIEF;
  if (!config.palette.length) config.palette = ["#f5a623", "#1d1a1e", "#ffffff"];
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

test("the rules carry the key, the palette and the mode, and names become slugs", () => {
  const rules = painterRules({ key: "#00ff00", palette: ["#f5a623"], pixel: { grid: 32, colors: 8 } });
  assert.match(rules, /exactly #00ff00/);
  assert.match(rules, /#f5a623/);
  assert.match(rules, /32 by 32 grid/);
  assert.match(rules, /No text/);
  assert.doesNotMatch(painterRules({ key: null }), /flat solid background/);
  assert.equal(slug("The Cat, Waving!"), "the-cat-waving");
  assert.equal(slug(""), "art");
});

test("a run paints, keys, measures, sizes, judges and writes everything beside the images", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup();
  const { calls, fetchImpl } = fakeApi(jpeg.toString("base64"));
  const result = await withKey(() => generate({ config, subject: "the cat head, waving one paw", name: "cat wave", fetch: fetchImpl, log: () => {} }));

  assert.equal(result.name, "cat-wave");
  assert.equal(result.candidates.length, 3);
  const [c1, c2, c3] = result.candidates;
  assert.ok(c1.facts.keying.background > 0.3, "the magenta was keyed away");
  assert.equal(c1.facts.colours > 3, true);
  assert.ok(c1.facts.paletteDrift, "drift against the brief's palette is measured");
  assert.equal(c1.files.outputs[0].width, 64);
  assert.equal(c3.blocked, "SAFETY");
  assert.equal(result.pick, 2, "the judge's pick is the run's pick");
  assert.equal(c2.judgement.on_brief, 85);
  assert.match(result.judgement.edit, /Thicken/);
  assert.ok(result.estimatedCostUSD > 0.08, `two images and a judge cost real money, got ${result.estimatedCostUSD}`);

  for (const f of ["01.source.jpg", "01.png", "01.64x64.png", "01.json", "02.png", "03.json", "generate.json", "contact.html"]) await access(path.join(result.dir, f));
  const out64 = decodePNG(await readFile(path.join(result.dir, "01.64x64.png")));
  assert.equal(out64.width, 64);
  assert.ok(out64.data[3] === 0, "the sized output keeps its transparent corner");
  const sidecar = JSON.parse(await readFile(path.join(result.dir, "01.json"), "utf8"));
  assert.match(sidecar.prompt, /^## Subject\nthe cat head, waving one paw/);
  assert.ok(sidecar.preamble[0].startsWith("## Rules"));
  assert.equal(sidecar.turns.length, 2, "the turns are kept so the candidate can be edited later");
  const html = await readFile(path.join(result.dir, "contact.html"), "utf8");
  assert.match(html, /id="c2" class="card pick"|class="card pick" id="c2"/);
  assert.match(html, /Not painted: SAFETY/);
  assert.match(html, /prefers-color-scheme/);

  const paint = calls[0].body;
  const texts = paint.contents[0].parts.filter((p) => p.text).map((p) => p.text);
  assert.ok(texts[0].startsWith("## Rules"), "rules first");
  assert.ok(texts[1].startsWith("## Brief"), "then the brief");
  assert.match(texts[0], /exactly #ff00ff/);
  assert.match(texts[0], /#f5a623, #1d1a1e, #ffffff/);
  assert.ok(texts[texts.length - 1].startsWith("## Subject"), "the subject last");
  assert.deepEqual(paint.generationConfig.imageConfig, { aspectRatio: "1:1", imageSize: "1K" });

  const judgeCall = calls.find((c) => c.url.includes("gemini-3.8-flash"));
  const judgeTexts = judgeCall.body.contents[0].parts.filter((p) => p.text).map((p) => p.text).join("\n");
  assert.match(judgeTexts, /### Candidate 1\nMeasured: background removed \d+%/);
  assert.match(judgeTexts, /### Candidate 2/);
  assert.doesNotMatch(judgeTexts, /### Candidate 3/, "a blocked candidate is not judged");
  assert.equal(judgeCall.body.contents[0].parts.filter((p) => p.inlineData).length, 2);
  assert.ok(judgeCall.body.generationConfig.responseSchema.properties.pick);

  const ledger = (await readFile(path.join(config.out, "usage.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(ledger.filter((e) => !String(e.op).startsWith("judge:")).length, 3);
  assert.equal(ledger.filter((e) => e.ok && !String(e.op).startsWith("judge:")).length, 2);
  assert.equal(ledger.filter((e) => String(e.op).startsWith("judge:")).length, 1);
});

test("a batch that cannot fit the budget is refused before a cent is spent", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup({ budgetUSD: 0.05 });
  const { calls, fetchImpl } = fakeApi(jpeg.toString("base64"));
  await assert.rejects(() => withKey(() => generate({ config, subject: "the cat", fetch: fetchImpl, log: () => {} })), (err) => err.code === "BUDGET" && /3 more images at 1K.*\$0.05 cap/.test(err.message));
  assert.equal(calls.length, 0, "nothing reached the API");
});

test("when real thinking runs heavier than the estimate, the run stops before the call that would pass the cap, and the judge still ranks what was painted", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup({ budgetUSD: 0.2 });
  // Three candidates estimate at about $0.12, under the cap; but the model thinks
  // for 20,000 tokens on the first, which alone costs about $0.19.
  const heavy = { ...USAGE, thoughtsTokenCount: 20_000, totalTokenCount: 21_434 };
  const { calls, fetchImpl } = fakeApi(jpeg.toString("base64"), { usage: heavy, judgement: { candidates: [{ index: 1, on_brief: 80, on_model: 100, craft: 70, problems: [], strengths: [] }], pick: 1, reason: "Only one.", edit: "" } });
  const logs = [];
  const result = await withKey(() => generate({ config, subject: "the cat", fetch: fetchImpl, log: (s) => logs.push(s) }));
  assert.equal(result.candidates.length, 1);
  assert.ok(logs.some((l) => /stopped, budget/.test(l)), logs.join(""));
  assert.equal(calls.filter((c) => c.url.includes("nano-banana")).length, 1, "the second paint never reached the API");
  assert.equal(result.pick, 1);
});

test("without a judge there is no pick, and without a brief there is no run", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup({ candidates: 1 });
  const { calls, fetchImpl } = fakeApi(jpeg.toString("base64"), { blockThird: false });
  const result = await withKey(() => generate({ config, subject: "the cat", judge: false, fetch: fetchImpl, log: () => {} }));
  assert.equal(result.pick, null);
  assert.equal(result.judgement, null);
  assert.ok(calls.every((c) => !c.url.includes("gemini-3.8-flash")));
  const empty = { ...config, briefText: "" };
  await assert.rejects(() => generate({ config: empty, subject: "the cat", fetch: fetchImpl, log: () => {} }), /needs a brief/);
  await assert.rejects(() => generate({ config, subject: "  ", fetch: fetchImpl, log: () => {} }), /needs --subject/);
});

test("pixel mode shrinks to the grid with hard pixels, snaps to the palette, and measures the grid", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup({ pixel: { grid: 16, colors: 6 }, sizes: [] });
  const raw = decodeJPEG(jpeg);
  const processed = processCandidate(raw, { config, key: "#ff00ff" });
  assert.equal(processed.outputs.length, 1);
  assert.equal(processed.outputs[0].width, 16);
  assert.ok(colorCount(processed.outputs[0].image) <= config.palette.length, "snapped to the brief's palette");
  assert.ok(processed.facts.grid && processed.facts.grid.cell >= 2);
  for (let i = 3; i < processed.outputs[0].image.data.length; i += 4) {
    const a = processed.outputs[0].image.data[i];
    assert.ok(a === 0 || a === 255, `pixel art has no soft edge, found alpha ${a}`);
  }
  const { calls, fetchImpl } = fakeApi(jpeg.toString("base64"), { blockThird: false, judgement: { candidates: [{ index: 1, on_brief: 80, on_model: 100, craft: 70, problems: [], strengths: [] }], pick: 1, reason: "Only one.", edit: "" } });
  const result = await withKey(() => generate({ config: { ...config, candidates: 1 }, subject: "the cat", fetch: fetchImpl, log: () => {} }));
  const out = result.candidates[0].files.outputs[0];
  assert.equal(out.width, 16);
  assert.ok(out.preview, "a hard-pixel preview is written for people");
  const preview = decodePNG(await readFile(out.preview));
  assert.equal(preview.width, 256);
  const judgeCall = calls.find((c) => c.url.includes("gemini-3.8-flash"));
  const shown = judgeCall.body.contents[0].parts.find((p) => p.inlineData);
  assert.equal(decodePNG(Buffer.from(shown.inlineData.data, "base64")).width, 256, "the judge sees the sprite that ships, not the painting");
  const written = JSON.parse(await readFile(path.join(result.dir, "generate.json"), "utf8"));
  assert.ok(!("judgeImage" in written.candidates[0]) && !("image" in written.candidates[0]), "pixel buffers never land in the JSON");
  assert.ok(!("judgeImage" in JSON.parse(await readFile(path.join(result.dir, "01.json"), "utf8"))));
});
