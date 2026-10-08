import { resolveImagePrice, resolveTextPrice, estimateBatchCost, estimateJudgeCost } from "./pricing.mjs";

/**
 * What a planned workload would cost before any of it runs, so a big batch gets a
 * number first. It prices only what calls the API: images at the pricing page's own
 * per-image figure plus the measured thinking allowance, and the judge at a typical
 * allowance (see estimateJudgeCost). Icons, the store crops and check call nothing
 * and are listed as free. The sprite figure is a range, because retries and repaints
 * are decided by what the model sends back: the best case is one strip per action
 * with no retries, the worst is every retry and repaint the config allows. A part
 * with no price is null, never zero, and the reason is returned with the plan.
 */

const round = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const JUDGE_THINKING = { off: 0, low: 600, medium: 1800, high: 3500 };
/** Adds costs, any of which may be null (unpriced); the sum is null if any part is. */
const add = (...parts) => (parts.some((p) => p == null) ? null : round(parts.reduce((t, p) => t + p, 0)));

/**
 * How many images a sprite run paints, best and worst, for one shared formula that
 * `price` and the sprites run's own pre-run estimate both use: the best is one pass
 * of each strip; the worst is every strip painted 1 + retries times, every frame
 * repainted frameRetries times, and (when judged) every judged-repair pass
 * repainting every frame.
 */
export function spriteImageCounts(sp, actions, { judge = true } = {}) {
  const stripFrames = sp?.stripFrames ?? 8;
  const retries = sp?.retries ?? 2;
  const frameRetries = sp?.frameRetries ?? 1;
  const judgeRepairs = judge ? sp?.judgeRepairs ?? 1 : 0;
  const stripsOf = (frames) => Math.max(1, Math.ceil(frames / stripFrames));
  const frames = actions.reduce((t, a) => t + a.frames, 0);
  const strips = actions.reduce((t, a) => t + stripsOf(a.frames), 0);
  return { best: strips, worst: strips * (1 + retries) + frames * frameRetries + frames * judgeRepairs, retries, frameRetries, judgeRepairs };
}

/** Refuses a plan that is not the workload asked for, rather than pricing a different one. */
function validatePlan(config, { subjects, count, sprites }) {
  if (!(Number.isInteger(subjects) && subjects >= 0)) throw new Error("--subjects must be a whole number, such as --subjects 8");
  if (count != null && !(Number.isInteger(count) && count >= 1)) throw new Error("--count must be a whole number of 1 or more, such as --count 3");
  const max = config.sprite?.maxFrames ?? 24;
  for (const a of sprites) {
    if (!a.name) throw new Error("--sprites: every action needs a name, as name:frames");
    if (!(Number.isInteger(a.frames) && a.frames >= 1 && a.frames <= max)) throw new Error(`--sprites: action ${a.name} needs a frame count from 1 to ${max}, as ${a.name}:6`);
  }
}

export function estimatePlan(config, { subjects = 0, count = null, size = null, sprites = [], store = false, judge = true } = {}) {
  validatePlan(config, { subjects, count, sprites });
  const imgPrice = resolveImagePrice(config.model, config.pricing);
  const txtPrice = resolveTextPrice(config.judge, config.pricing);
  const n = count ?? config.candidates;
  const sz = size ?? config.size;
  const think = JUDGE_THINKING[config.judgeThinking?.level] ?? JUDGE_THINKING.high;
  const judgeOf = (candidates) => (judge ? estimateJudgeCost(txtPrice, { candidates, thinkingTokens: think }) : 0);
  const imagesOf = (images) => (images ? estimateBatchCost({ images, size: sz, price: imgPrice }) : 0);

  const missing = [];
  if (!imgPrice) missing.push(`no price for the image model ${config.model}; add it to the config's "pricing" block`);
  else if (!imgPrice.perImage?.[sz]) missing.push(`no per-image price for ${config.model} at ${sz}${imgPrice.source === "config" ? ' (the config\'s "pricing" entry needs a "perImage" figure for that size)' : `; it is priced at ${Object.keys(imgPrice.perImage ?? {}).join(", ") || "no size"}`}`);
  if (judge && !txtPrice) missing.push(`no price for the judge ${config.judge}; add it to the config's "pricing" block`);

  const items = [];
  const assumptions = [];

  if (subjects > 0) {
    const cost = add(imagesOf(subjects * n), ...Array.from({ length: subjects }, () => judgeOf(n)));
    items.push({ label: `generate`, detail: `${subjects} subject${subjects === 1 ? "" : "s"} x ${n} candidate${n === 1 ? "" : "s"} at ${sz}${judge ? ", judged" : ""}`, images: subjects * n, judgeCalls: judge ? subjects : 0, best: cost, worst: cost });
  }

  if (store) {
    const cost = add(imagesOf(n), judgeOf(n));
    items.push({ label: `store`, detail: `${n} hero${n === 1 ? "" : "es"} at ${sz}${judge ? ", judged" : ""}; the crops to each target are free`, images: n, judgeCalls: judge ? 1 : 0, best: cost, worst: cost });
  }

  if (sprites.length) {
    const counts = spriteImageCounts(config.sprite, sprites, { judge });
    const { retries, frameRetries, judgeRepairs } = counts;
    const sheetImages = n; // the sheet runs the candidate loop
    const best = sheetImages + counts.best;
    const worst = sheetImages + counts.worst;
    const judgeBest = judge ? 1 + sprites.length : 0;
    const judgeWorst = judge ? 1 + sprites.length * (1 + judgeRepairs) : 0;
    const judgeCost = (calls) => (judge ? add(judgeOf(n), ...Array.from({ length: calls - 1 }, () => judgeOf(2))) : 0);
    items.push({
      label: `sprites`,
      detail: `a ${n}-candidate sheet + ${sprites.length} action${sprites.length === 1 ? "" : "s"} (${sprites.map((a) => `${a.name}:${a.frames}`).join(", ")}) at ${sz}${judge ? ", judged" : ""}`,
      images: best,
      imagesWorst: worst,
      judgeCalls: judgeBest,
      judgeCallsWorst: judgeWorst,
      best: add(imagesOf(best), judgeCost(judgeBest)),
      worst: add(imagesOf(worst), judgeCost(judgeWorst)),
    });
    assumptions.push(`sprites: best is one strip per action with no retries or repaints; worst is every strip painted ${1 + retries} times, every frame repainted ${frameRetries} time${frameRetries === 1 ? "" : "s"}${judge ? `, and ${judgeRepairs} judged repair pass${judgeRepairs === 1 ? "" : "es"} repainting every frame and judged again` : ""}.`);
  }

  if (!items.length) {
    const cost = add(imagesOf(n), judgeOf(n));
    items.push({ label: `generate`, detail: `1 subject x ${n} candidate${n === 1 ? "" : "s"} at ${sz}${judge ? ", judged" : ""} (default; pass --subjects, --sprites or --store to plan more)`, images: n, judgeCalls: judge ? 1 : 0, best: cost, worst: cost });
  }

  const best = add(...items.map((i) => i.best));
  const worst = add(...items.map((i) => i.worst));
  if (config.references?.length) assumptions.push(`${config.references.length} reference image${config.references.length === 1 ? "" : "s"} add input tokens to every call that are not in the per-image figure, so the real cost is a little higher.`);
  if (judge) assumptions.push(`the judge is an allowance (brief + candidates in, a short verdict out), not a measured cost; a real run reports the true figure.`);
  return {
    model: config.model,
    judge: judge ? config.judge : null,
    size: sz,
    priceKnown: best != null,
    missing,
    free: ["icons", "the store crops", "check"],
    items,
    best,
    worst,
    assumptions,
  };
}
