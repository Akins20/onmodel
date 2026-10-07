import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { resolveImagePrice, resolveTextPrice, estimateImageCost, estimateTextCost, estimateBatchCost, describePrice } from "./pricing.mjs";
import { mimeOf } from "./image.mjs";

/**
 * The Gemini clients: one that asks an image model for a picture, with reference
 * images and the earlier turns of an edit, and one that asks a text model for a
 * structured judgement. Both record every call's tokens and estimated cost in
 * memory and in an append-only ledger, and the image client refuses to start a
 * call that would carry the run past its budget. The key comes from the
 * environment only; it is sent as a header and never logged.
 */

const API = "https://generativelanguage.googleapis.com/v1beta";
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const BACKOFF_MS = [0, 3000, 8000, 15000];

export const IMAGE_SIZES = ["512px", "1K", "2K", "4K"];
export const ASPECT_RATIOS = ["1:1", "3:2", "2:3", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
export const MAX_OUTPUT_TOKENS_CEILING = 65_536;

function apiKey() {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error("GEMINI_API_KEY is not set (export it in your shell; this tool never stores it)");
  return key;
}

const headers = () => ({ "content-type": "application/json", "x-goog-api-key": apiKey() });

/** The models the key can use with generateContent, with which of them make images. */
export async function listModels(filter, fetchImpl = globalThis.fetch) {
  const res = await fetchImpl(`${API}/models?pageSize=1000`, { headers: { "x-goog-api-key": apiKey() } });
  if (!res.ok) throw new Error(`models: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = await res.json();
  return (body.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .map((m) => ({ name: m.name.replace(/^models\//, ""), displayName: m.displayName ?? "", image: /-image|banana/i.test(m.name) }))
    .filter((m) => !filter || m.name.includes(filter));
}

/** The API's thinkingConfig for the tool's thinking setting; undefined leaves the model's default. */
export function thinkingConfig(thinking = {}) {
  const out = {};
  if (thinking.budget !== undefined) out.thinkingBudget = thinking.budget;
  else if (thinking.level === "off") out.thinkingBudget = 0;
  else if (thinking.level) out.thinkingLevel = thinking.level;
  if (thinking.includeThoughts) out.includeThoughts = true;
  return Object.keys(out).length ? out : undefined;
}

/** Plain counts from usageMetadata, with the image tokens separated out, since they are priced apart. */
export function usageOf(meta = {}) {
  const sum = (details, modality) => (details ?? []).filter((d) => d.modality === modality).reduce((t, d) => t + (d.tokenCount ?? 0), 0);
  return {
    promptTokens: meta.promptTokenCount ?? 0,
    cachedTokens: meta.cachedContentTokenCount ?? 0,
    candidatesTokens: meta.candidatesTokenCount ?? 0,
    thoughtsTokens: meta.thoughtsTokenCount ?? 0,
    totalTokens: meta.totalTokenCount ?? 0,
    imageTokens: sum(meta.candidatesTokensDetails, "IMAGE"),
    promptImageTokens: sum(meta.promptTokensDetails, "IMAGE"),
  };
}

export const text = (t) => ({ text: t });

/** An inline image part from a file path or bytes; the format is read from the bytes, never the name. */
export async function imagePart(source) {
  const buffer = Buffer.isBuffer(source) || source instanceof Uint8Array ? Buffer.from(source) : await readFile(source);
  const mimeType = mimeOf(buffer);
  if (!mimeType) throw new Error(`${typeof source === "string" ? source : "the image"} is not a PNG, JPEG, WebP or GIF`);
  return { inlineData: { mimeType, data: buffer.toString("base64") } };
}

/** One generateContent call with backoff on transient failures; a 4xx is reported with the API's own words. */
async function call(fetchImpl, model, body, op) {
  let lastErr;
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt]));
    const res = await fetchImpl(`${API}/models/${model}:generateContent`, { method: "POST", headers: headers(), body: JSON.stringify(body) });
    if (RETRY_STATUSES.has(res.status)) {
      lastErr = new Error(`gemini: HTTP ${res.status} on attempt ${attempt + 1} (${op})`);
      continue;
    }
    if (!res.ok) {
      let detail = "";
      try {
        const err = await res.json();
        detail = err.error?.message ?? JSON.stringify(err).slice(0, 400);
      } catch {
        detail = "";
      }
      throw new Error(`gemini: HTTP ${res.status} (${op})${detail ? `: ${detail}` : ""}`);
    }
    return res.json();
  }
  throw lastErr ?? new Error(`gemini: request failed (${op})`);
}

async function appendLedger(ledgerPath, entry) {
  if (!ledgerPath) return;
  await mkdir(path.dirname(ledgerPath), { recursive: true });
  await appendFile(ledgerPath, JSON.stringify(entry) + "\n");
}

/**
 * Asks an image model for a picture. References go in as inline images before the
 * prompt, so the model keeps to them; an edit passes the earlier turns back, so
 * "make the scarf red" is applied to the image it already made rather than to a
 * fresh idea. Returns the image bytes as the model sent them (JPEG, usually) and
 * the turns to continue from.
 */
export class ImageClient {
  constructor({ model, thinking, pricing, ledgerPath, runLabel, budgetUSD = null, fetch: fetchImpl = globalThis.fetch }) {
    this.model = model;
    this.thinking = thinking ?? {};
    this.price = resolveImagePrice(model, pricing ?? {}, new Date());
    this.ledgerPath = ledgerPath;
    this.runLabel = runLabel ?? "";
    this.budgetUSD = budgetUSD;
    this.fetch = fetchImpl;
    this.spent = 0;
    this.calls = [];
  }

  /** What a number of images at a size would cost, from the price table, before anything is sent. */
  estimate({ images = 1, size = "1K" } = {}) {
    return estimateBatchCost({ images, size, price: this.price });
  }

  /** Throws, before the call, when it would carry the run past the budget. */
  assertBudget(images, size) {
    if (this.budgetUSD == null) return;
    const next = this.estimate({ images, size }) ?? 0;
    if (this.spent + next > this.budgetUSD + 1e-9) {
      const err = new Error(`budget: ${images} more image${images === 1 ? "" : "s"} at ${size} (about $${next.toFixed(3)}) would take the run past its $${this.budgetUSD} cap (spent $${this.spent.toFixed(3)} so far); raise budgetUSD or ask for less`);
      err.code = "BUDGET";
      throw err;
    }
  }

  async generate({ prompt, parts: preamble = [], references = [], labels = [], history = [], aspectRatio = "1:1", size = "1K", op = "generate" }) {
    if (!ASPECT_RATIOS.includes(aspectRatio)) throw new Error(`aspectRatio must be one of ${ASPECT_RATIOS.join(", ")}`);
    const sizes = this.price?.sizes ?? IMAGE_SIZES;
    if (!sizes.includes(size)) throw new Error(`${this.model} makes images at ${sizes.join(", ")}, not ${size}`);
    this.assertBudget(1, size);
    // The rules and the brief first, then the references, then the subject: the
    // stable part leads, and the thing to paint is the last thing read.
    const parts = [...preamble];
    for (const [i, ref] of references.entries()) {
      if (labels[i]) parts.push(text(labels[i]));
      parts.push(await imagePart(ref));
    }
    parts.push(text(prompt));
    const userTurn = { role: "user", parts };
    const body = {
      contents: [...history, userTurn],
      generationConfig: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio, imageSize: size } },
    };
    const tc = thinkingConfig(this.thinking);
    if (tc) body.generationConfig.thinkingConfig = tc;

    const started = Date.now();
    const out = await call(this.fetch, this.model, body, op);
    const usage = usageOf(out.usageMetadata);
    const costUSD = estimateImageCost(usage, this.price);
    const candidate = out.candidates?.[0];
    const base = { op, usage, costUSD, started, size, aspectRatio, references: references.length, historyTurns: history.length };
    if (!candidate || !candidate.content?.parts?.length) {
      const blocked = out.promptFeedback?.blockReason ?? candidate?.finishReason ?? "no candidate returned";
      await this.record({ ...base, finishReason: candidate?.finishReason ?? null, ok: false, blocked });
      return { images: [], text: "", usage, costUSD, finishReason: candidate?.finishReason ?? null, blocked, turns: history };
    }
    const allParts = candidate.content.parts;
    const images = allParts.filter((p) => p.inlineData?.data).map((p) => ({ mimeType: p.inlineData.mimeType, buffer: Buffer.from(p.inlineData.data, "base64") }));
    const said = allParts.filter((p) => p.text && !p.thought).map((p) => p.text).join("\n");
    const modelTurn = { role: "model", parts: allParts.filter((p) => !p.thought) };
    await this.record({ ...base, finishReason: candidate.finishReason, ok: images.length > 0, blocked: images.length ? null : "no image in the answer" });
    return { images, text: said, usage, costUSD, finishReason: candidate.finishReason, blocked: images.length ? null : "no image in the answer", turns: [...history, userTurn, modelTurn] };
  }

  async record({ op, usage, costUSD, started, finishReason, ok, blocked, size, aspectRatio, references, historyTurns }) {
    if (costUSD != null) this.spent += costUSD;
    const entry = {
      ts: new Date().toISOString(),
      run: this.runLabel,
      provider: "gemini",
      model: this.model,
      op,
      ...usage,
      costUSD,
      priceSource: this.price?.source ?? null,
      size,
      aspectRatio,
      references,
      historyTurns,
      thinking: thinkingConfig(this.thinking) ?? null,
      durationMs: Date.now() - started,
      finishReason,
      ok,
      blocked: blocked ?? null,
    };
    this.calls.push(entry);
    await appendLedger(this.ledgerPath, entry);
  }

  summary() {
    const totals = { calls: this.calls.length, images: 0, promptTokens: 0, imageTokens: 0, thoughtsTokens: 0, totalTokens: 0, blocked: 0 };
    let cost = 0;
    let known = Boolean(this.price);
    for (const c of this.calls) {
      for (const k of ["promptTokens", "imageTokens", "thoughtsTokens", "totalTokens"]) totals[k] += c[k] ?? 0;
      if (c.ok) totals.images += 1;
      if (c.blocked) totals.blocked += 1;
      if (c.costUSD == null) known = false;
      else cost += c.costUSD;
    }
    return { provider: "gemini", model: this.model, ...totals, estimatedCostUSD: known ? Math.round(cost * 1e6) / 1e6 : null, budgetUSD: this.budgetUSD, pricingKnown: Boolean(this.price), price: this.price ? describePrice(this.price) : null };
  }
}

/**
 * Asks a text model for a structured answer about images: a judgement against the
 * brief and the references, as JSON that fits a schema. A response cut off by the
 * output budget is retried with twice the budget, up to the ceiling.
 */
export class JudgeClient {
  constructor({ model, thinking, generation, pricing, ledgerPath, runLabel, fetch: fetchImpl = globalThis.fetch }) {
    this.model = model;
    this.thinking = thinking ?? { level: "high" };
    this.generation = generation ?? {};
    this.price = resolveTextPrice(model, pricing ?? {}, new Date());
    this.ledgerPath = ledgerPath;
    this.runLabel = runLabel ?? "";
    this.fetch = fetchImpl;
    this.calls = [];
  }

  async generateJSON({ parts, schema, op = "judge", temperature, maxOutputTokens }) {
    let budget = maxOutputTokens ?? this.generation.maxOutputTokens ?? 16_384;
    const tc = thinkingConfig(this.thinking);
    for (;;) {
      const body = {
        contents: [{ role: "user", parts }],
        generationConfig: { temperature: temperature ?? this.generation.temperature ?? 0.2, maxOutputTokens: budget, responseMimeType: "application/json", responseSchema: schema },
      };
      if (tc) body.generationConfig.thinkingConfig = tc;
      const started = Date.now();
      const out = await call(this.fetch, this.model, body, op);
      const candidate = out.candidates?.[0];
      if (!candidate) throw new Error(`gemini: ${out.promptFeedback?.blockReason ?? "no candidate returned"} (${op})`);
      const allParts = candidate.content?.parts ?? [];
      const thoughts = allParts.filter((p) => p.thought).map((p) => p.text ?? "").join("\n");
      const raw = allParts.filter((p) => !p.thought).map((p) => p.text ?? "").join("");
      const usage = usageOf(out.usageMetadata);
      let data;
      try {
        data = JSON.parse(raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, ""));
      } catch {
        await this.record({ op, usage, started, finishReason: candidate.finishReason, budget, ok: false });
        if (candidate.finishReason === "MAX_TOKENS" && budget < MAX_OUTPUT_TOKENS_CEILING) {
          budget = Math.min(budget * 2, MAX_OUTPUT_TOKENS_CEILING);
          continue;
        }
        throw new Error(`gemini: the judge's answer was not valid JSON (finishReason ${candidate.finishReason}, ${op})`);
      }
      await this.record({ op, usage, started, finishReason: candidate.finishReason, budget, ok: true });
      return { data, usage, thoughts, finishReason: candidate.finishReason };
    }
  }

  async record({ op, usage, started, finishReason, budget, ok }) {
    const entry = {
      ts: new Date().toISOString(),
      run: this.runLabel,
      provider: "gemini",
      model: this.model,
      op,
      ...usage,
      costUSD: estimateTextCost(usage, this.price),
      priceSource: this.price?.source ?? null,
      thinking: thinkingConfig(this.thinking) ?? null,
      maxOutputTokens: budget,
      durationMs: Date.now() - started,
      finishReason,
      ok,
    };
    this.calls.push(entry);
    await appendLedger(this.ledgerPath, entry);
  }

  summary() {
    const totals = { calls: this.calls.length, promptTokens: 0, candidatesTokens: 0, thoughtsTokens: 0, totalTokens: 0 };
    let cost = 0;
    let known = Boolean(this.price);
    for (const c of this.calls) {
      for (const k of Object.keys(totals)) if (k !== "calls") totals[k] += c[k] ?? 0;
      if (c.costUSD == null) known = false;
      else cost += c.costUSD;
    }
    return { provider: "gemini", model: this.model, ...totals, estimatedCostUSD: known ? Math.round(cost * 1e6) / 1e6 : null, pricingKnown: Boolean(this.price), price: this.price ? describePrice(this.price) : null };
  }
}
