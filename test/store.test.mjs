import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeStore, storeSubject, encodeForTarget } from "../src/store.mjs";
import { decodeJPEG, isJPEG } from "../src/jpeg.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";
import { decodePNG } from "../src/png.mjs";
import { STORE_TARGETS } from "../src/rules.mjs";

/**
 * The generative store graphics against a simulated API: one hero is painted and
 * judged, then cropped to each target's exact canvas as a 24-bit PNG with no alpha.
 * The whole thing (full-bleed subject, 16:9 request, exact sizes, opacity, the byte
 * caps and the report) is checked without a key or a bill.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

const BRIEF = `# Shop brief

## Product
A layaway fashion shop; this art is the store's promotional banner and link preview.

## Art direction
Flat, warm, plum and cream, one hero scene, sits beside a modern storefront.

## Palette
Plum #6a1b5a, rose #a73669, cream #f4e9f1, ink #1d1a1e.
`;

const USAGE = { promptTokenCount: 42, candidatesTokenCount: 1392, totalTokenCount: 2311, candidatesTokensDetails: [{ modality: "IMAGE", tokenCount: 1120 }], thoughtsTokenCount: 877 };

function fakeApi(jpegBase64, { blockThird = true } = {}) {
  const calls = [];
  let paints = 0;
  const fetchImpl = async (url, opts = {}) => {
    const body = opts.body ? JSON.parse(opts.body) : null;
    const u = String(url);
    calls.push({ url: u, body });
    const ok = (json) => ({ ok: true, status: 200, json: async () => json });
    if (u.includes("gemini-3.8-flash:generateContent")) {
      const data = {
        candidates: [
          { index: 1, on_brief: 72, on_model: 100, craft: 66, problems: ["busy on the right"], strengths: ["warm"] },
          { index: 2, on_brief: 88, on_model: 100, craft: 82, problems: [], strengths: ["reads at a glance"] },
        ],
        pick: 2,
        reason: "Candidate 2 sells the shop in one calm plum scene.",
        edit: "",
      };
      return ok({ candidates: [{ content: { parts: [{ text: JSON.stringify(data) }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3000, candidatesTokenCount: 200, thoughtsTokenCount: 900, totalTokenCount: 4100 } });
    }
    paints += 1;
    if (blockThird && paints === 3) return ok({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 40, totalTokenCount: 40 } });
    return ok({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: "image/jpeg", data: jpegBase64 } }] }, finishReason: "STOP" }], usageMetadata: USAGE });
  };
  return { calls, fetchImpl };
}

async function setup(over = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-store-"));
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, BRIEF);
  const config = validate(merge(DEFAULTS, { brief, background: "#ff00ff", candidates: 3, out: path.join(dir, "out"), budgetUSD: 2, ...over }));
  config.briefText = BRIEF;
  if (!config.palette.length) config.palette = ["#6a1b5a", "#a73669", "#f4e9f1", "#1d1a1e"];
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

test("the subject frames a full-bleed banner, wrapping the user's words or a default", () => {
  assert.match(storeSubject("a plum dress on a mannequin"), /full-bleed/);
  assert.match(storeSubject("a plum dress on a mannequin"), /a plum dress on a mannequin/);
  assert.match(storeSubject(null), /sells it at a glance/);
  assert.match(storeSubject(""), /crops the sides/);
});

test("a hero is painted and judged, then cropped to every target as a no-alpha 24-bit PNG", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup();
  const { calls, fetchImpl } = fakeApi(jpeg.toString("base64"));
  const result = await withKey(() => makeStore({ config, subject: "a plum storefront at dusk", name: "shop promo", fetch: fetchImpl, log: () => {} }));

  assert.equal(result.name, "shop-promo");
  assert.deepEqual(result.targets, ["play-feature", "og", "github"]);
  assert.equal(result.pick, 2);
  assert.equal(result.failures.length, 0, `no check should fail: ${JSON.stringify(result.failures)}`);
  assert.equal(result.background, "#6a1b5a", "the flatten colour is the first palette colour");

  // the model was asked for 16:9 and told to compose full bleed, not on a flat key
  const paint = calls.find((c) => c.body?.generationConfig)?.body;
  assert.equal(paint.generationConfig.imageConfig.aspectRatio, "16:9");
  const rules = paint.contents[0].parts.find((p) => p.text && p.text.startsWith("## Rules")).text;
  assert.doesNotMatch(rules, /flat solid background/, "a banner is not keyed on a flat colour");
  assert.match(rules, /No text/, "still no burnt-in text");
  const subject = paint.contents[0].parts.filter((p) => p.text).at(-1).text;
  assert.match(subject, /full-bleed/);
  assert.match(subject, /a plum storefront at dusk/);

  // the blocked third candidate makes no targets; the two painted ones each make all three
  const [c1, c2, c3] = result.candidates;
  assert.equal(c3.blocked, "SAFETY");
  assert.ok(!c3.files?.targets, "a candidate that was not painted makes no graphics");
  assert.equal(c1.files.targets.length, 3);
  assert.equal(c2.files.targets.length, 3);

  // its own folder beside any run of the same name, as icons/ and sprites/ are
  assert.equal(result.dir, path.join(config.out, "shop-promo", "store"));
  for (const key of Object.keys(STORE_TARGETS)) {
    const t = STORE_TARGETS[key];
    const file = path.join(result.dir, `01.${key}.png`);
    await access(file);
    const buf = await readFile(file);
    assert.equal(buf[25], 2, `${key} is a 24-bit (colour type 2) PNG with no alpha channel`);
    const img = decodePNG(buf);
    assert.equal(img.width, t.width, `${key} width`);
    assert.equal(img.height, t.height, `${key} height`);
    let translucent = 0;
    for (let i = 3; i < img.data.length; i += 4) if (img.data[i] < 255) translucent += 1;
    assert.equal(translucent, 0, `${key} is fully opaque`);
    assert.ok(buf.length <= t.maxBytes, `${key} is within its byte cap`);
  }
  assert.equal(c1.files.targets[0].rel, "01.play-feature.png", "each file's path is kept relative to the store folder");

  await access(path.join(result.dir, "store.json"));
  await access(path.join(result.dir, "store.html"));
  await access(path.join(result.dir, "contact.html"));
  const html = await readFile(path.join(result.dir, "store.html"), "utf8");
  assert.match(html, /store graphics/);
  assert.equal(result.request, "a plum storefront at dusk", "the user's own subject is kept");
  assert.match(html, /a plum storefront at dusk/, "and shown, not the banner wrapper");
  assert.match(html, /Every graphic meets its target|checks? failed/);
  assert.match(html, /prefers-color-scheme/);
  assert.ok(result.estimatedCostUSD > 0.08, `two heroes and a judge cost real money, got ${result.estimatedCostUSD}`);
});

test("a subset of targets can be chosen, and an unknown target is refused", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup({ candidates: 1 });
  const { fetchImpl } = fakeApi(jpeg.toString("base64"), { blockThird: false });
  const result = await withKey(() => makeStore({ config, name: "og only", targets: ["og"], fetch: fetchImpl, log: () => {} }));
  assert.deepEqual(result.targets, ["og"]);
  assert.equal(result.candidates[0].files.targets.length, 1);
  assert.equal(result.candidates[0].files.targets[0].key, "og");
  await access(path.join(result.dir, "01.og.png"));

  await assert.rejects(() => withKey(() => makeStore({ config, name: "bad", targets: ["billboard"], fetch: fetchImpl, log: () => {} })), /unknown store target/);

  const twice = await withKey(() => makeStore({ config, name: "dupes", targets: ["og", "OG", "github"], fetch: fetchImpl, log: () => {} }));
  assert.deepEqual(twice.targets, ["og", "github"], "a repeated target is made once");
  assert.equal(twice.candidates[0].files.targets.length, 2);
});

test("a store run leaves the generate run of the same name alone", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup({ candidates: 1 });
  const runDir = path.join(config.out, "app");
  await mkdir(runDir, { recursive: true });
  const sentinel = JSON.stringify({ kind: "generate", name: "app", note: "the mark" });
  await writeFile(path.join(runDir, "generate.json"), sentinel);
  await writeFile(path.join(runDir, "01.png"), "the mark's pixels");
  const { fetchImpl } = fakeApi(jpeg.toString("base64"), { blockThird: false });
  await withKey(() => makeStore({ config, name: "app", fetch: fetchImpl, log: () => {} }));
  assert.equal(await readFile(path.join(runDir, "generate.json"), "utf8"), sentinel, "the mark run's summary is untouched");
  assert.equal(await readFile(path.join(runDir, "01.png"), "utf8"), "the mark's pixels", "and so is its image");
});

test("a store run in which nothing was painted fails instead of reporting success", async () => {
  const { config } = await setup({ candidates: 2 });
  const blocked = async () => ({ ok: true, status: 200, json: async () => ({ promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 40, totalTokenCount: 40 } }) });
  const result = await withKey(() => makeStore({ config, name: "nothing", fetch: blocked, log: () => {} }));
  assert.equal(result.failures.length, 1);
  assert.equal(result.failures[0].check, "painted");
  assert.equal(result.failures[0].candidate, null);
});

test("a pixel-mode project's banner is not asked for on a sprite grid", async () => {
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const { config } = await setup({ candidates: 1, pixel: { grid: 32, colors: 16 } });
  assert.ok(config.pixel, "the project is in pixel mode");
  const { calls, fetchImpl } = fakeApi(jpeg.toString("base64"), { blockThird: false });
  await withKey(() => makeStore({ config, name: "pix", fetch: fetchImpl, log: () => {} }));
  const rules = calls.find((c) => c.body?.generationConfig).body.contents[0].parts.find((p) => p.text?.startsWith("## Rules")).text;
  assert.doesNotMatch(rules, /grid/, "no pixel-grid instruction for a 16:9 banner");
});

test("a target over its byte cap is written as the best JPEG that fits, when the target takes JPEG", () => {
  // noise compresses badly as PNG
  const w = 400;
  const h = 200;
  const data = new Uint8Array(w * h * 4);
  let seed = 7;
  for (let i = 0; i < w * h; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
    data.set([seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, 255], i * 4);
  }
  const image = { width: w, height: h, data };
  const cap = 120 * 1024;
  const out = encodeForTarget(image, { maxBytes: cap, jpeg: true });
  assert.equal(out.ext, "jpg");
  assert.ok(out.buffer.length <= cap, `fits the cap: ${out.buffer.length}`);
  assert.ok(out.pngBytes > cap, "the PNG really was over");
  assert.ok(isJPEG(out.buffer));
  assert.equal(decodeJPEG(out.buffer).width, w);
  assert.equal(encodeForTarget(image, { maxBytes: cap, jpeg: false }).ext, "png", "a target that takes only PNG keeps PNG");
  assert.equal(encodeForTarget({ width: 8, height: 8, data: new Uint8Array(256).fill(255) }, { maxBytes: cap, jpeg: true }).ext, "png", "under the cap stays lossless");
});
