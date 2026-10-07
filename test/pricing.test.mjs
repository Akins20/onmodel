import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveImagePrice, resolveTextPrice, estimateImageCost, estimateTextCost, estimateBatchCost, describePrice, matchKey, IMAGE_PRICING } from "../src/pricing.mjs";

test("an image call is priced from what it used: prompt in, image tokens at the image rate, thinking at the text rate", () => {
  // The real usage of the first live probe: a 1K image from gemini-nano-banana-2.1.
  const price = resolveImagePrice("gemini-nano-banana-2.1");
  const usage = { promptTokens: 42, candidatesTokens: 1392, imageTokens: 1120, thoughtsTokens: 877 };
  const cost = estimateImageCost(usage, price);
  // 42 x 1.5 + 1120 x 30 + (272 + 877) x 7.5, per million.
  assert.ok(Math.abs(cost - 0.042281) < 1e-6, `cost ${cost}`);
  assert.equal(estimateImageCost({ promptTokens: 0, candidatesTokens: 1120, imageTokens: 1120, thoughtsTokens: 0 }, price), 0.0336, "the image tokens alone are the page's per-image figure");
});

test("a dry run estimates a batch from the per-image figure plus a thinking allowance, and caps can refuse it", () => {
  const price = resolveImagePrice("gemini-nano-banana-2.1");
  const cost = estimateBatchCost({ images: 24, size: "1K", price, thinkingTokens: 900 });
  assert.ok(Math.abs(cost - 0.9684) < 1e-4, `24 images about $0.97, got ${cost}`);
  assert.equal(estimateBatchCost({ images: 3, size: "512px", price }), null, "a size the model does not offer has no estimate");
  assert.equal(estimateBatchCost({ images: 3, size: "512px", price: resolveImagePrice("gemini-3.1-flash-image"), thinkingTokens: 0 }), 0.135);
});

test("prices resolve by exact id or prefix, config wins, and an unknown model has no price", () => {
  assert.equal(matchKey(IMAGE_PRICING, "models/gemini-3.1-flash-image-preview"), "gemini-3.1-flash-image");
  assert.equal(matchKey(IMAGE_PRICING, "gemini-3.1-flash-lite-image"), "gemini-3.1-flash-lite-image", "the longer key wins over its prefix");
  assert.equal(resolveImagePrice("imagen-9"), null, "no price is invented for a model the table does not know");
  const custom = resolveImagePrice("gemini-nano-banana-2.1", { "gemini-nano-banana-2.1": { input: 1, output: 2, imageOutput: 10 } });
  assert.equal(custom.imageOutput, 10);
  assert.equal(custom.source, "config");
});

test("text prices follow their dated tiers and bill thinking as output", () => {
  const now = resolveTextPrice("gemini-3.8-flash", {}, new Date("2026-10-07"));
  const later = resolveTextPrice("gemini-3.8-flash", {}, new Date("2027-02-01"));
  assert.equal(now.output, 3.75);
  assert.equal(later.output, 7.5, "the announced step applies from its date");
  const cost = estimateTextCost({ promptTokens: 10_000, cachedTokens: 8_000, candidatesTokens: 500, thoughtsTokens: 1_500 }, now);
  // 2000 x 0.75 + 8000 x 0.075 + 2000 x 3.75, per million.
  assert.ok(Math.abs(cost - 0.0096) < 1e-6, `cost ${cost}`);
});

test("a price describes itself, including the image rate", () => {
  assert.match(describePrice(resolveImagePrice("gemini-3-pro-image")), /\$120\/M image out/);
  assert.match(describePrice(resolveTextPrice("gemini-3.8-flash")), /\$0.075\/M cached/);
  assert.equal(describePrice(null), "no price");
});
