import { resolveImagePrice, resolveTextPrice, estimateBatchCost, estimateJudgeCost } from "./pricing.mjs";

/**
 * What a planned workload would cost before any of it runs, so a big batch gets a
 * number first. It prices only what calls the API: images at the pricing page's own
 * per-image figure plus the measured thinking allowance, and the judge at a typical
 * allowance (see estimateJudgeCost). Icons, the store crops and check call nothing
 * and are listed as free. The sprite figure is a range, because retries and repaints
 * are decided by what the model sends back: the best case is one strip per action
 * with no retries, the worst assumes every strip is painted the full retry count.
 * Every assumption is returned so the caller can state it rather than hide it.
 */

const round = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4);
const JUDGE_THINKING = { off: 0, low: 600, medium: 1800, high: 3500 };

export function estimatePlan(config, { subjects = 0, count = null, size = null, sprites = [], store = false, judge = true } = {}) {
  const imgPrice = resolveImagePrice(config.model, config.pricing);
  const txtPrice = resolveTextPrice(config.judge, config.pricing);
  const n = count ?? config.candidates;
  const sz = size ?? config.size;
  const think = JUDGE_THINKING[config.judgeThinking?.level] ?? JUDGE_THINKING.high;
  const judgeOf = (candidates) => (judge ? estimateJudgeCost(txtPrice, { candidates, thinkingTokens: think }) : 0) ?? 0;
  const imagesOf = (images) => estimateBatchCost({ images, size: sz, price: imgPrice }) ?? 0;

  const items = [];
  const assumptions = [];
  const priceKnown = Boolean(imgPrice) && (!judge || Boolean(txtPrice));

  if (subjects > 0) {
    const images = subjects * n;
    const judgeCost = judge ? subjects * judgeOf(n) : 0;
    const cost = round(imagesOf(images) + judgeCost);
    items.push({ label: `generate`, detail: `${subjects} subject${subjects === 1 ? "" : "s"} x ${n} candidate${n === 1 ? "" : "s"} at ${sz}${judge ? ", judged" : ""}`, images, judgeCalls: judge ? subjects : 0, best: cost, worst: cost });
  }

  if (store) {
    const images = n;
    const judgeCost = judge ? judgeOf(n) : 0;
    const cost = round(imagesOf(images) + judgeCost);
    items.push({ label: `store`, detail: `${n} hero${n === 1 ? "" : "es"} at ${sz}${judge ? ", judged" : ""}; the crops to each target are free`, images, judgeCalls: judge ? 1 : 0, best: cost, worst: cost });
  }

  if (sprites.length) {
    const stripFrames = config.sprite?.stripFrames ?? 8;
    const retries = config.sprite?.retries ?? 2;
    const stripsOf = (frames) => Math.max(1, Math.ceil((frames || 1) / stripFrames));
    const stripBest = sprites.reduce((t, a) => t + stripsOf(a.frames), 0);
    const stripWorst = sprites.reduce((t, a) => t + stripsOf(a.frames) * (1 + retries), 0);
    const sheetImages = n; // the sheet runs the candidate loop
    const judgeCost = judge ? judgeOf(n) + sprites.length * judgeOf(2) : 0;
    const best = round(imagesOf(sheetImages + stripBest) + judgeCost);
    const worst = round(imagesOf(sheetImages + stripWorst) + judgeCost);
    items.push({
      label: `sprites`,
      detail: `a ${n}-candidate sheet + ${sprites.length} action${sprites.length === 1 ? "" : "s"} (${sprites.map((a) => `${a.name}:${a.frames || 1}`).join(", ")}) at ${sz}${judge ? ", judged" : ""}`,
      images: sheetImages + stripBest,
      imagesWorst: sheetImages + stripWorst,
      judgeCalls: judge ? 1 + sprites.length : 0,
      best,
      worst,
    });
    assumptions.push(`sprites: best is one strip per action with no retries; worst assumes every strip is repainted the full ${retries} retries. A judged repair repaints a flagged frame for about $${round(imagesOf(1))} each, on top.`);
  }

  if (!items.length) {
    items.push({ label: `generate`, detail: `1 subject x ${n} candidate${n === 1 ? "" : "s"} at ${sz}${judge ? ", judged" : ""} (default; pass --subjects, --sprites or --store to plan more)`, images: n, judgeCalls: judge ? 1 : 0, best: round(imagesOf(n) + judgeOf(n)), worst: round(imagesOf(n) + judgeOf(n)) });
  }

  const best = round(items.reduce((t, i) => t + (i.best ?? 0), 0));
  const worst = round(items.reduce((t, i) => t + (i.worst ?? i.best ?? 0), 0));
  if (config.references?.length) assumptions.push(`${config.references.length} reference image${config.references.length === 1 ? "" : "s"} add input tokens to every call that are not in the per-image figure, so the real cost is a little higher.`);
  if (judge) assumptions.push(`the judge is an allowance (brief + candidates in, a short verdict out), not a measured cost; a real run reports the true figure.`);
  return {
    model: config.model,
    judge: judge ? config.judge : null,
    size: sz,
    priceKnown,
    free: ["icons", "the store crops", "check"],
    items,
    best,
    worst,
    assumptions,
  };
}
