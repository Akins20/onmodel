import { test } from "node:test";
import assert from "node:assert/strict";
import { estimatePlan } from "../src/plan.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";

/**
 * The dry-run planner, priced from the built-in table with no API: a plan scales
 * with its images, the judge is an allowance that --no-judge removes, sprites come
 * back as a best-to-worst range, and an unknown model is reported as having no price
 * rather than being given an invented one.
 */

function cfg(over = {}) {
  const c = validate(merge(DEFAULTS, { brief: "x", ...over }));
  c.palette = ["#6a1b5a"];
  return c;
}

test("a generate plan scales with subjects and candidates, and the judge can be dropped", () => {
  const c = cfg();
  const one = estimatePlan(c, { subjects: 1, count: 3, size: "1K" });
  const two = estimatePlan(c, { subjects: 2, count: 3, size: "1K" });
  assert.equal(two.items[0].images, 6);
  assert.ok(two.best > one.best, "two subjects cost more than one");
  assert.ok(two.best < one.best * 2 + 0.0001 && two.best > one.best * 1.9, "roughly double");

  const judged = estimatePlan(c, { subjects: 1, count: 3, size: "1K", judge: true });
  const not = estimatePlan(c, { subjects: 1, count: 3, size: "1K", judge: false });
  assert.ok(judged.best > not.best, "the judge adds cost");
  assert.equal(not.items[0].judgeCalls, 0);
  assert.equal(not.judge, null);
});

test("a bigger size costs more per image", () => {
  const c = cfg();
  const k1 = estimatePlan(c, { subjects: 1, count: 2, size: "1K", judge: false });
  const k2 = estimatePlan(c, { subjects: 1, count: 2, size: "2K", judge: false });
  assert.ok(k2.best > k1.best, "2K costs more than 1K");
});

test("a store plan prices the heroes and lists the crops as free", () => {
  const c = cfg();
  const p = estimatePlan(c, { store: true, count: 3, size: "2K", judge: false });
  assert.equal(p.items[0].label, "store");
  assert.equal(p.items[0].images, 3);
  assert.ok(p.free.includes("the store crops"));
  assert.ok(p.best > 0);
});

test("a sprite plan is a best-to-worst range: strips, retries, frame repaints and judged repairs", () => {
  const c = cfg({ sprite: { stripFrames: 8, retries: 2, frameRetries: 1, judgeRepairs: 1 } });
  const p = estimatePlan(c, { sprites: [{ name: "walk", frames: 6 }, { name: "run", frames: 10 }], count: 2, size: "1K" });
  const it = p.items[0];
  // walk: 1 strip, run: ceil(10/8)=2 strips => 3 strips; sheet = 2 candidates; 16 frames
  assert.equal(it.images, 2 + 3, "best: sheet + one pass of each strip");
  assert.equal(it.imagesWorst, 2 + 3 * (1 + 2) + 16 * 1 + 16 * 1, "worst: strips 1+retries times, every frame repainted, every frame in a judged repair");
  assert.equal(it.judgeCalls, 1 + 2, "best: a sheet judge plus one per action");
  assert.equal(it.judgeCallsWorst, 1 + 2 * (1 + 1), "worst: plus the second judgement of each repair pass");
  assert.ok(it.worst > it.best, "the range is real");
  assert.ok(p.assumptions.some((a) => /repainted/.test(a)));
});

test("a plan that is not the workload asked for is refused, not priced as another", () => {
  const c = cfg();
  assert.throws(() => estimatePlan(c, { subjects: NaN }), /--subjects must be a whole number/);
  assert.throws(() => estimatePlan(c, { subjects: 1, count: 0 }), /--count/);
  assert.throws(() => estimatePlan(c, { sprites: [{ name: "walk", frames: NaN }] }), /walk needs a frame count/);
  assert.throws(() => estimatePlan(c, { sprites: [{ name: "long", frames: c.sprite.maxFrames + 1 }] }), /from 1 to/);
  assert.doesNotThrow(() => estimatePlan(c, { subjects: 0, store: true }), "zero subjects beside a store run is a real plan");
});

test("combining generate, store and sprites sums into one total", () => {
  const c = cfg();
  const p = estimatePlan(c, { subjects: 2, store: true, sprites: [{ name: "idle", frames: 4 }], count: 2, size: "1K" });
  assert.equal(p.items.length, 3);
  const sum = p.items.reduce((t, i) => t + i.best, 0);
  assert.ok(Math.abs(p.best - sum) < 0.0001, "the total is the sum of the items");
});

test("no plan flags gives a default single-run estimate", () => {
  const p = estimatePlan(cfg(), {});
  assert.equal(p.items.length, 1);
  assert.match(p.items[0].detail, /default/);
});

test("an unknown model is reported as having no price, not given an invented one", () => {
  const p = estimatePlan(cfg({ model: "no-such-image-model" }), { subjects: 2, count: 3, judge: false });
  assert.equal(p.priceKnown, false);
  assert.equal(p.best, null, "no number at all, not $0");
  assert.equal(p.items[0].best, null);
  assert.ok(p.missing.some((m) => /no-such-image-model/.test(m)));
});

test("a size the model has no per-image price for is unpriced, with the reason", () => {
  const p = estimatePlan(cfg(), { subjects: 8, size: "512px" });
  assert.equal(p.best, null, "the judge alone is not passed off as the cost of 24 images");
  assert.ok(p.missing.some((m) => /512px/.test(m)));
});

test("references are flagged as adding uncounted input cost", () => {
  const p = estimatePlan(cfg({ references: ["a.png", "b.png"] }), { subjects: 1 });
  assert.ok(p.assumptions.some((a) => /reference/.test(a)));
});
