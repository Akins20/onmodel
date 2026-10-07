/**
 * Built-in Gemini prices, so every run reports a real estimated cost with no
 * configuration. USD per one million tokens on the standard tier.
 *
 * An image model bills three things on one call, and the API's usage metadata
 * separates them: the prompt (text and reference images) at the input rate, the
 * generated image's tokens at the image-output rate, and the model's thinking plus
 * any text it says at the text-output rate. The per-image figures the pricing page
 * quotes are exactly the image tokens at that rate (a 1K image is 1120 tokens, so
 * 1120 x $30 per million is $0.0336), which is why the table carries the rates
 * rather than the figures: a 2K or 4K image, or a model that thinks longer, is
 * then priced from what it actually used.
 *
 * Sources: the official Gemini API pricing page, read on the date below. Prices
 * change; the `pricing` block of the config overrides any model here, and
 * `onmodel models` shows what will be used.
 */
export const PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";
export const PRICING_AS_OF = "2026-10-07";

/**
 * Image generation models. `sizes` are the imageSize values the model accepts;
 * `perImage` is the pricing page's own per-image figure for each, kept for the
 * dry-run estimate before anything is generated.
 */
export const IMAGE_PRICING = {
  "gemini-nano-banana-2.1": { input: 1.5, output: 7.5, imageOutput: 30, sizes: ["1K", "2K", "4K"], perImage: { "1K": 0.0336, "2K": 0.0504, "4K": 0.113 } },
  "gemini-3.1-flash-image": { input: 0.5, output: 3.0, imageOutput: 60, sizes: ["512px", "1K", "2K", "4K"], perImage: { "512px": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 } },
  "gemini-3.1-flash-lite-image": { input: 0.25, output: 1.5, imageOutput: 30, sizes: ["1K"], perImage: { "1K": 0.0336 } },
  "gemini-3-pro-image": { input: 2.0, output: 12.0, imageOutput: 120, sizes: ["1K", "2K", "4K"], perImage: { "1K": 0.134, "2K": 0.134, "4K": 0.24 } },
};

/** Text models usable as the judge; thinking is billed at the output rate. */
const flash38 = {
  tiers: [
    { from: "2000-01-01", input: 0.75, output: 3.75, cached: 0.075 },
    { from: "2027-01-01", input: 1.5, output: 7.5, cached: 0.15 },
  ],
};
export const TEXT_PRICING = {
  "gemini-3.8-flash": flash38,
  "gemini-3.7-flash": flash38,
  "gemini-3.5-flash": { input: 1.5, output: 9.0, cached: 0.15 },
  "gemini-3.5-flash-lite": { input: 0.3, output: 2.5, cached: 0.03 },
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.5, cached: 0.025 },
};

const bareId = (model) => String(model ?? "").replace(/^models\//, "");

/** The longest key in `table` that names the model exactly or as a dash-delimited prefix. */
export function matchKey(table, model) {
  const id = bareId(model);
  let best = null;
  for (const key of Object.keys(table ?? {})) {
    if ((id === key || id.startsWith(`${key}-`)) && (!best || key.length > best.length)) best = key;
  }
  return best;
}

/** The tier of an entry that applies on a date: the latest `from` at or before it. */
function tierFor(entry, date) {
  if (!entry?.tiers) return entry;
  const day = (date instanceof Date ? date : new Date(date ?? Date.now())).toISOString().slice(0, 10);
  let chosen = null;
  for (const tier of entry.tiers) if (tier.from <= day && (!chosen || tier.from >= chosen.from)) chosen = tier;
  return chosen ?? entry.tiers[0];
}

const usable = (entry) => Boolean(entry) && typeof entry.input === "number" && typeof entry.output === "number";

/**
 * Resolves a price: the config's overrides first (exact id or prefix), then the
 * built-in table. Returns null when nothing matches, so a cost is never invented.
 */
function resolve(table, model, overrides, date) {
  const fromConfig = matchKey(overrides, model);
  if (fromConfig) {
    const tier = tierFor(overrides[fromConfig], date);
    if (usable(tier)) return { ...overrides[fromConfig], ...tier, key: fromConfig, source: "config" };
  }
  const key = matchKey(table, model);
  if (!key) return null;
  const tier = tierFor(table[key], date);
  return usable(tier) ? { ...table[key], ...tier, key, source: "built-in", asOf: PRICING_AS_OF } : null;
}

export const resolveImagePrice = (model, overrides = {}, date = new Date()) => resolve(IMAGE_PRICING, model, overrides, date);
export const resolveTextPrice = (model, overrides = {}, date = new Date()) => resolve(TEXT_PRICING, model, overrides, date);

/**
 * The cost of one image-model call from its usage: prompt tokens at the input rate,
 * image tokens at the image-output rate, and everything else the model produced
 * (its thinking, any text) at the text-output rate. Null without a price.
 */
export function estimateImageCost(usage, price) {
  if (!usable(price) || typeof price.imageOutput !== "number") return null;
  const image = usage.imageTokens ?? 0;
  const spoken = Math.max(0, (usage.candidatesTokens ?? 0) - image) + (usage.thoughtsTokens ?? 0);
  const cost = ((usage.promptTokens ?? 0) / 1e6) * price.input + (image / 1e6) * price.imageOutput + (spoken / 1e6) * price.output;
  return Math.round(cost * 1e6) / 1e6;
}

/** The cost of one text call: cached prompt tokens at the cached rate, the rest at input, output plus thinking at output. */
export function estimateTextCost(usage, price) {
  if (!usable(price)) return null;
  const cached = usage.cachedTokens ?? 0;
  const uncached = Math.max(0, (usage.promptTokens ?? 0) - cached);
  const cost = (uncached / 1e6) * price.input + (cached / 1e6) * (price.cached ?? price.input) + (((usage.candidatesTokens ?? 0) + (usage.thoughtsTokens ?? 0)) / 1e6) * price.output;
  return Math.round(cost * 1e6) / 1e6;
}

/**
 * What a batch would cost before it runs, from the pricing page's per-image figure
 * plus a typical allowance for thinking, so a dry run can say "about $1.20" and a
 * cap can refuse before the first call.
 */
export function estimateBatchCost({ images, size = "1K", price, thinkingTokens = 900 }) {
  if (!price?.perImage || !(size in price.perImage)) return null;
  const perImage = price.perImage[size] + (thinkingTokens / 1e6) * price.output;
  return Math.round(images * perImage * 1e4) / 1e4;
}

/** A short description of a price for reports. */
export function describePrice(price) {
  if (!usable(price)) return "no price";
  const parts = [`$${price.input}/M in`, `$${price.output}/M out`];
  if (typeof price.imageOutput === "number") parts.push(`$${price.imageOutput}/M image out`);
  if (typeof price.cached === "number") parts.push(`$${price.cached}/M cached`);
  const origin = price.source === "config" ? "from config" : `built-in, as of ${price.asOf ?? PRICING_AS_OF}`;
  return `${parts.join(", ")} (${origin})`;
}
