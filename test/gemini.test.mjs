import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ImageClient, JudgeClient, usageOf, imagePart, listModels, thinkingConfig } from "../src/gemini.mjs";

/**
 * The clients against a simulated API: fetch is replaced by a function that records
 * each request and answers like the real endpoint did in the live probe, so the
 * request shape, the bookkeeping and the failure paths are all checked without a
 * key or a bill.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");
const PROBE_USAGE = {
  promptTokenCount: 42,
  candidatesTokenCount: 1392,
  totalTokenCount: 2311,
  promptTokensDetails: [{ modality: "TEXT", tokenCount: 42 }],
  candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }],
  thoughtsTokenCount: 877,
};

function fakeApi(answers) {
  const calls = [];
  let n = 0;
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url: String(url), headers: opts.headers ?? {}, body });
    const answer = typeof answers === "function" ? answers(n++, body, String(url)) : answers;
    if (answer.status && answer.status !== 200) return { ok: false, status: answer.status, json: async () => answer.json ?? {}, text: async () => JSON.stringify(answer.json ?? {}) };
    return { ok: true, status: 200, json: async () => answer.json ?? answer };
  };
  return { calls, fetchImpl };
}

const imageAnswer = (jpegBase64, extra = {}) => ({
  candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: jpegBase64 } }] }, finishReason: "STOP" }],
  usageMetadata: PROBE_USAGE,
  ...extra,
});

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

test("usage separates the image tokens the model made from the tokens it spent thinking", () => {
  const u = usageOf(PROBE_USAGE);
  assert.equal(u.imageTokens, 1120);
  assert.equal(u.thoughtsTokens, 877);
  assert.equal(u.promptImageTokens, 0);
  assert.deepEqual(thinkingConfig({ level: "low" }), { thinkingLevel: "low" });
  assert.equal(thinkingConfig({}), undefined, "an empty setting leaves the model's default alone");
});

test("a generate call carries references before the prompt, asks for an image at the size and ratio, and books the cost", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const png = await readFile(path.join(fixtures, "grad-37x29.ref.png"));
  const { calls, fetchImpl } = fakeApi(imageAnswer(jpeg.toString("base64")));
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-gem-"));
  const ledger = path.join(dir, "usage.jsonl");
  await withKey(async () => {
    const client = new ImageClient({ model: "gemini-nano-banana-2.1", ledgerPath: ledger, runLabel: "t", budgetUSD: 1, fetch: fetchImpl });
    const result = await client.generate({ prompt: "the cat, waving", references: [png, jpeg], labels: ["Model sheet", null], aspectRatio: "1:1", size: "1K", op: "frame" });

    const req = calls[0];
    assert.equal(req.headers["x-goog-api-key"], "test-key-not-real", "the key is a header");
    assert.ok(!req.url.includes("test-key-not-real"), "and never in the URL");
    assert.match(req.url, /models\/gemini-nano-banana-2\.1:generateContent$/);
    assert.deepEqual(req.body.generationConfig.responseModalities, ["IMAGE"]);
    assert.deepEqual(req.body.generationConfig.imageConfig, { aspectRatio: "1:1", imageSize: "1K" });
    assert.equal(req.body.generationConfig.thinkingConfig, undefined, "the model's default thinking by default");
    const parts = req.body.contents[0].parts;
    assert.equal(parts[0].text, "Model sheet", "a label precedes its image");
    assert.equal(parts[1].inlineData.mimeType, "image/png", "the format comes from the bytes");
    assert.equal(parts[2].inlineData.mimeType, "image/jpeg");
    assert.equal(parts[3].text, "the cat, waving", "the prompt comes last");

    assert.equal(result.images.length, 1);
    assert.equal(result.images[0].mimeType, "image/jpeg");
    assert.ok(result.images[0].buffer.equals(jpeg), "the bytes come back as the model sent them");
    assert.equal(result.blocked, null);
    assert.equal(result.usage.imageTokens, 1120);
    assert.ok(Math.abs(result.costUSD - 0.042281) < 1e-6, `cost ${result.costUSD}`);
    assert.equal(result.turns.length, 2, "the user turn and the model turn, ready for an edit");
    assert.equal(result.turns[1].role, "model");
    assert.ok(result.turns[1].parts[0].inlineData, "the model's image rides along so an edit applies to it");

    const edit = await client.generate({ prompt: "make the scarf red", history: result.turns, op: "edit" });
    assert.equal(calls[1].body.contents.length, 3, "an edit sends the earlier turns and the new instruction");
    assert.equal(calls[1].body.contents[2].parts[0].text, "make the scarf red");
    assert.equal(edit.turns.length, 4);

    const lines = (await readFile(ledger, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].op, "frame");
    assert.equal(lines[0].size, "1K");
    assert.equal(lines[0].references, 2);
    assert.equal(lines[1].historyTurns, 2);
    const summary = client.summary();
    assert.equal(summary.images, 2);
    assert.ok(Math.abs(summary.estimatedCostUSD - 2 * 0.042281) < 1e-5);
    assert.match(summary.price, /\$30\/M image out/);
  });
});

test("thinking, when set, reaches the image model", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { calls, fetchImpl } = fakeApi(imageAnswer(jpeg.toString("base64")));
  await withKey(async () => {
    const client = new ImageClient({ model: "gemini-nano-banana-2.1", thinking: { level: "low" }, fetch: fetchImpl });
    await client.generate({ prompt: "x" });
    assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: "low" });
  });
});

test("a blocked prompt comes back as a reason, not an exception, and is counted", async () => {
  const { fetchImpl } = fakeApi({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 30, totalTokenCount: 30 } });
  await withKey(async () => {
    const client = new ImageClient({ model: "gemini-nano-banana-2.1", fetch: fetchImpl });
    const result = await client.generate({ prompt: "x" });
    assert.deepEqual(result.images, []);
    assert.equal(result.blocked, "SAFETY");
    assert.equal(client.summary().blocked, 1);
    assert.equal(client.summary().images, 0);
  });
});

test("the budget is checked before a call is made, and a size the model does not offer is refused", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { calls, fetchImpl } = fakeApi(imageAnswer(jpeg.toString("base64")));
  await withKey(async () => {
    const client = new ImageClient({ model: "gemini-nano-banana-2.1", budgetUSD: 0.05, fetch: fetchImpl });
    assert.ok(Math.abs(client.estimate({ images: 1, size: "1K" }) - 0.0404) < 1e-3, "about four cents an image with thinking");
    await client.generate({ prompt: "one" });
    await assert.rejects(() => client.generate({ prompt: "two" }), (err) => err.code === "BUDGET" && /past its \$0.05 cap/.test(err.message));
    assert.equal(calls.length, 1, "the second call never reached the API");
    await assert.rejects(() => client.generate({ prompt: "x", size: "512px" }), /makes images at 1K, 2K, 4K, not 512px/);
    await assert.rejects(() => client.generate({ prompt: "x", aspectRatio: "7:3" }), /aspectRatio must be one of/);
  });
});

test("an API refusal is reported in the API's own words", async () => {
  const { fetchImpl } = fakeApi({ status: 400, json: { error: { code: 400, message: 'Unknown name "outputMimeType"', status: "INVALID_ARGUMENT" } } });
  await withKey(async () => {
    const client = new ImageClient({ model: "gemini-nano-banana-2.1", fetch: fetchImpl });
    await assert.rejects(() => client.generate({ prompt: "x" }), /HTTP 400 \(generate\): Unknown name "outputMimeType"/);
  });
});

test("the judge asks for JSON that fits the schema, parses it, and widens the budget when the answer was cut off", async () => {
  const schema = { type: "OBJECT", properties: { verdict: { type: "STRING" } }, required: ["verdict"] };
  const { calls, fetchImpl } = fakeApi((n) =>
    n === 0
      ? { candidates: [{ content: { parts: [{ text: '{"verdict": "on mod' }] }, finishReason: "MAX_TOKENS" }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 100, thoughtsTokenCount: 15_000, totalTokenCount: 15_600 } }
      : { candidates: [{ content: { parts: [{ thought: true, text: "thinking" }, { text: '```json\n{"verdict": "on model"}\n```' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 20, thoughtsTokenCount: 800, totalTokenCount: 1320 } },
  );
  await withKey(async () => {
    const judge = new JudgeClient({ model: "gemini-3.8-flash", fetch: fetchImpl });
    const { data, thoughts, usage } = await judge.generateJSON({ parts: [{ text: "judge this" }], schema, op: "pick" });
    assert.deepEqual(data, { verdict: "on model" });
    assert.equal(thoughts, "thinking");
    assert.equal(usage.thoughtsTokens, 800);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].body.generationConfig.responseMimeType, "application/json");
    assert.deepEqual(calls[0].body.generationConfig.responseSchema, schema);
    assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: "high" }, "the judge thinks hard by default");
    assert.equal(calls[1].body.generationConfig.maxOutputTokens, calls[0].body.generationConfig.maxOutputTokens * 2, "the cut-off answer is retried with twice the budget");
    const s = judge.summary();
    assert.equal(s.calls, 2);
    assert.ok(s.estimatedCostUSD > 0);
  });
});

test("image parts read their format from the bytes, and the model list marks the ones that make images", async () => {
  const png = await readFile(path.join(fixtures, "grad-37x29.ref.png"));
  assert.equal((await imagePart(png)).inlineData.mimeType, "image/png");
  assert.equal((await imagePart(path.join(fixtures, "cat-256.jpg"))).inlineData.mimeType, "image/jpeg");
  await assert.rejects(() => imagePart(Buffer.from("not an image at all, really")), /not a PNG, JPEG, WebP or GIF/);
  const { fetchImpl } = fakeApi({ models: [{ name: "models/gemini-nano-banana-2.1", displayName: "Nano Banana 2.1", supportedGenerationMethods: ["generateContent"] }, { name: "models/gemini-3.8-flash", displayName: "Flash", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-1", supportedGenerationMethods: ["embedContent"] }] });
  await withKey(async () => {
    const models = await listModels(undefined, fetchImpl);
    assert.deepEqual(models.map((m) => [m.name, m.image]), [["gemini-nano-banana-2.1", true], ["gemini-3.8-flash", false]]);
  });
});
