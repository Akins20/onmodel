import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeStore, storeSubject } from "../src/store.mjs";
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

  for (const key of Object.keys(STORE_TARGETS)) {
    const t = STORE_TARGETS[key];
    const file = path.join(result.dir, "store", `01.${key}.png`);
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
  assert.ok(decodePNG(await readFile(path.join(result.dir, "store", "01.github.png"))), "github preview decodes");
  assert.ok(readFile(path.join(result.dir, "store", "01.github.png")).then((b) => b.length <= 1024 * 1024));

  await access(path.join(result.dir, "store.json"));
  await access(path.join(result.dir, "store.html"));
  await access(path.join(result.dir, "contact.html"));
  const html = await readFile(path.join(result.dir, "store.html"), "utf8");
  assert.match(html, /store graphics/);
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
  await access(path.join(result.dir, "store", "01.og.png"));

  await assert.rejects(() => withKey(() => makeStore({ config, name: "bad", targets: ["billboard"], fetch: fetchImpl, log: () => {} })), /unknown store target/);
});
