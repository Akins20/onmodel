import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { ImageClient, text } from "./gemini.mjs";
import { requireBrief, briefSection, contextSections, loadDecisions, decisionsSection, sectionOf } from "./brief.mjs";
import { decodeImage, encodePNG } from "./image.mjs";
import { chooseKey, keyOut, trim, fitInto, quantize, colorCount, alphaBounds, gridAdherence, resize, hardenAlpha } from "./key.mjs";
import { judgeCandidates } from "./judge.mjs";
import { renderContactHTML } from "./html.mjs";

/**
 * The generation loop for a single subject: the brief, the references and the
 * palette go to the image model with the subject; each candidate comes back,
 * is keyed to transparency, trimmed, measured, cut to the sizes asked for and
 * written with a sidecar that records what made it; then the judge ranks them
 * against the brief and picks one. Everything measured is kept beside the image,
 * because a number the next run can compare against is worth more than a
 * picture that merely looked right once.
 */

export const slug = (s) =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60) || "art";

const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;

/** The rules every painting request carries, shaped by the key, the palette and the mode. */
export function painterRules({ key, palette = [], pixel = null }) {
  const lines = ["You are painting production art for a real product. Follow the brief, the references and the subject exactly, and invent nothing the brief does not ask for."];
  lines.push(
    key
      ? `Paint only the subject, centred, filling about 70% of the frame, on a flat solid background of exactly ${key} that covers every background pixel. No shadow or reflection on the background, no gradient, no vignette, no ground plane, no frame, no border.`
      : "Compose the image as the brief and the subject ask.",
  );
  lines.push("No text, letters, numbers, logos, signatures or watermarks anywhere in the image.");
  if (palette.length) lines.push(`Use only these colours, plus a near-black for outlines and a near-white for highlights where the brief allows them: ${palette.join(", ")}.`);
  if (pixel) lines.push(`This is pixel art on a ${pixel.grid} by ${pixel.grid} grid, drawn large: crisp square pixels, hard edges, no anti-aliasing, no gradients, no more than ${pixel.colors ?? 16} colours.`);
  return `## Rules\n${lines.join("\n")}`;
}

/** The text parts that precede the references and the subject. */
export async function preambleParts(config, decisions, key) {
  const parts = [text(painterRules({ key, palette: config.palette, pixel: config.pixel })), text(briefSection(config.briefText))];
  if (decisions.length) parts.push(text(decisionsSection(decisions)));
  const extra = await contextSections(config);
  if (extra) parts.push(text(extra));
  if (config.references.length) {
    const notes = sectionOf(config.briefText, "References");
    parts.push(text(`## References\nThe images that follow are the references. Stay consistent with them: the same character, proportions, line, palette and style.${notes ? `\n${notes}` : ""}`));
  }
  return { parts, extra };
}

/**
 * Turns the model's picture into the assets asked for and measures it on the way:
 * keyed to transparency, trimmed, fitted to each size, quantised where the mode
 * asks, with the facts a judge or a later run can hold it to.
 */
export function processCandidate(raw, { config, key }) {
  let image = raw;
  let keying = null;
  if (key) {
    const keyed = keyOut(raw, key, config.key);
    image = keyed.image;
    keying = keyed.facts;
  }
  const bounds = alphaBounds(image);
  const facts = {
    width: raw.width,
    height: raw.height,
    keying,
    fill: bounds ? round((bounds.width * bounds.height) / (raw.width * raw.height)) : 0,
    colours: colorCount(image),
    paletteDrift: config.palette.length ? quantize(image, { palette: config.palette }).drift : null,
  };
  const trimmed = trim(image);
  const sizes = config.sizes.length ? config.sizes : config.pixel ? [{ width: config.pixel.grid, height: config.pixel.grid }] : [];
  const outputs = [];
  for (const { width, height } of sizes) {
    let out = fitInto(trimmed, width, height, { filter: config.pixel ? "box" : "auto", align: config.pixel ? "bottom" : "center" });
    if (config.quantize || config.pixel) {
      out = quantize(out, { palette: config.palette.length ? config.palette : null, count: config.pixel?.colors ?? 16 }).image;
    }
    // Pixel art has no soft edge: the shrink's fractional alpha becomes a grey halo
    // when the sprite is drawn at scale, so every pixel is made opaque or clear.
    if (config.pixel) out = hardenAlpha(out);
    outputs.push({ width, height, image: out });
  }
  if (config.pixel) {
    // How much the model's own drawing was on a grid, before it was shrunk: the
    // cell is the frame divided by the grid it was asked for.
    const cell = Math.max(2, Math.round(Math.min(raw.width, raw.height) / config.pixel.grid));
    facts.grid = gridAdherence(image, cell);
  }
  return { image, trimmed, facts, outputs };
}

/** A one-line account of a candidate for the progress log. */
export function describeFacts(facts) {
  const bits = [];
  if (facts.keying) bits.push(`background ${Math.round(facts.keying.background * 100)}%`, `edge ${round(facts.keying.fringe * 100, 1)}%`);
  bits.push(`fill ${Math.round(facts.fill * 100)}%`, `${facts.colours} colours`);
  if (facts.paletteDrift) bits.push(`drift ${facts.paletteDrift.mean}`);
  if (facts.grid) bits.push(`grid ${Math.round(facts.grid.share * 100)}%`);
  if (facts.keying?.touchesEdge && Object.values(facts.keying.touchesEdge).some(Boolean)) bits.push("TOUCHES EDGE");
  return bits.join(", ");
}

export async function generate({ config, subject, name, count, judge = true, fetch: fetchImpl, log = (s) => process.stderr.write(s) }) {
  requireBrief(config);
  if (!subject?.trim()) throw new Error("generate needs --subject: what to paint, in a sentence");
  const label = slug(name ?? subject);
  const dir = path.join(config.out, label);
  await mkdir(dir, { recursive: true });
  const n = count ?? config.candidates;
  const key = config.background === "auto" ? chooseKey(config.palette) : config.background;
  const decisions = await loadDecisions(config);
  const { parts, extra } = await preambleParts(config, decisions, key);
  const ledgerPath = path.join(config.out, config.ledger);
  const client = new ImageClient({ model: config.model, thinking: config.thinking, pricing: config.pricing, ledgerPath, runLabel: label, budgetUSD: config.budgetUSD, fetch: fetchImpl });
  const estimate = client.estimate({ images: n, size: config.size });
  log(`  ${label}: ${n} candidate${n === 1 ? "" : "s"} from ${config.model} at ${config.size}${estimate != null ? `, about $${estimate.toFixed(3)}` : ""}${key ? `, keyed on ${key}` : ""}\n`);
  client.assertBudget(n, config.size);

  const prompt = `## Subject\n${subject.trim()}\nPaint it now.`;
  const labels = config.references.map((r, i) => `Reference ${i + 1}: ${path.basename(r)}`);
  const candidates = [];
  for (let i = 1; i <= n; i++) {
    const op = `${label}#${i}`;
    let result;
    try {
      result = await client.generate({ prompt, parts, references: config.references, labels, aspectRatio: config.aspectRatio, size: config.size, op });
    } catch (err) {
      if (err.code === "BUDGET") {
        log(`  ${i}/${n}: stopped, ${err.message}\n`);
        break;
      }
      throw err;
    }
    const candidate = { index: i, usage: result.usage, costUSD: result.costUSD, finishReason: result.finishReason, blocked: result.blocked, files: {} };
    if (result.blocked || !result.images.length) {
      log(`  ${i}/${n}: not painted (${result.blocked})\n`);
      candidates.push(candidate);
      continue;
    }
    const first = result.images[0];
    const base = path.join(dir, String(i).padStart(2, "0"));
    const sourceFile = `${base}.source.${first.mimeType === "image/png" ? "png" : "jpg"}`;
    await writeFile(sourceFile, first.buffer);
    candidate.files.source = sourceFile;
    let raw;
    try {
      raw = decodeImage(first.buffer);
    } catch (err) {
      candidate.error = `could not decode the model's image: ${err.message}`;
      log(`  ${i}/${n}: ${candidate.error}\n`);
      candidates.push(candidate);
      continue;
    }
    const processed = processCandidate(raw, { config, key });
    candidate.image = processed.image;
    candidate.facts = processed.facts;
    candidate.files.image = `${base}.png`;
    await writeFile(candidate.files.image, encodePNG(processed.image));
    candidate.files.outputs = [];
    for (const out of processed.outputs) {
      const file = `${base}.${out.width}x${out.height}.png`;
      await writeFile(file, encodePNG(out.image));
      candidate.files.outputs.push({ width: out.width, height: out.height, file });
      if (config.pixel) {
        // A preview a person can see: the sprite enlarged with hard pixels. It is
        // also what the judge sees, since the sprite, not the painting, is what ships.
        const scale = Math.max(1, Math.floor(256 / Math.max(out.width, out.height)));
        const preview = resize(out.image, out.width * scale, out.height * scale, { filter: "nearest" });
        const previewFile = `${base}.${out.width}x${out.height}.preview.png`;
        await writeFile(previewFile, encodePNG(preview));
        candidate.files.outputs[candidate.files.outputs.length - 1].preview = previewFile;
        if (!candidate.judgeImage) candidate.judgeImage = preview;
      }
    }
    candidate.turns = result.turns;
    log(`  ${i}/${n}: ${describeFacts(processed.facts)}, $${(result.costUSD ?? 0).toFixed(3)}\n`);
    candidates.push(candidate);
  }

  let judgement = null;
  let judgeSummary = null;
  if (judge && candidates.some((c) => c.image)) {
    try {
      const judged = await judgeCandidates({ config, subject, candidates, decisions, extra, ledgerPath, runLabel: label, fetch: fetchImpl });
      judgement = judged.data;
      judgeSummary = judged.summary ?? null;
      if (judgement) {
        for (const j of judgement.candidates ?? []) {
          const c = candidates.find((x) => x.index === j.index);
          if (c) c.judgement = j;
        }
        log(`  judge: pick ${judgement.pick || "none"}${judgement.reason ? `, ${judgement.reason}` : ""}\n`);
      }
    } catch (err) {
      judgement = { error: err.message };
      log(`  judge failed: ${err.message}\n`);
    }
  }
  const pick = judgement?.pick ? candidates.find((c) => c.index === judgement.pick) ?? null : null;

  const summary = {
    tool: "onmodel",
    kind: "generate",
    name: label,
    subject,
    dir,
    model: config.model,
    size: config.size,
    aspectRatio: config.aspectRatio,
    key,
    palette: config.palette,
    references: config.references,
    pixel: config.pixel,
    sizes: config.sizes,
    generatedAt: new Date().toISOString(),
    candidates: candidates.map(({ image, judgeImage, turns, ...rest }) => rest),
    pick: pick ? pick.index : null,
    judgement,
    usage: { images: client.summary(), judge: judgeSummary },
  };
  const costs = [client.summary().estimatedCostUSD, judgeSummary?.estimatedCostUSD].filter((v) => v != null);
  summary.estimatedCostUSD = costs.length ? round(costs.reduce((a, b) => a + b, 0), 6) : null;
  // The sidecars: one per candidate with its prompt and turns, so a candidate can
  // be edited later from exactly where it was, and the summary for the folder.
  for (const c of candidates) {
    await writeFile(path.join(dir, `${String(c.index).padStart(2, "0")}.json`), JSON.stringify({ ...c, image: undefined, judgeImage: undefined, prompt, preamble: parts.filter((p) => p.text).map((p) => p.text), turns: c.turns ?? null }, null, 2));
  }
  await writeFile(path.join(dir, "generate.json"), JSON.stringify(summary, null, 2));
  const htmlPath = path.join(dir, "contact.html");
  await writeFile(htmlPath, renderContactHTML(summary, dir));
  return { ...summary, htmlPath };
}
