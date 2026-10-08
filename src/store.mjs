import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { generate, slug } from "./generate.mjs";
import { decodeImage } from "./image.mjs";
import { encodePNG24 } from "./png.mjs";
import { coverInto, fillBackground } from "./key.mjs";
import { checkIcon, STORE_TARGETS, RULES_AS_OF, RULE_SOURCES } from "./rules.mjs";
import { renderStoreHTML } from "./html.mjs";

/**
 * Store and link-preview graphics, the generative kind: a single on-brand hero is
 * painted by the model (full-bleed, no text, keyed on nothing), judged against the
 * brief like any candidate, and then each hero is cropped to cover a store's exact
 * canvas and written as a 24-bit PNG with no alpha, because every store that takes
 * a PNG rejects one with an alpha channel. The crop is deterministic and free: the
 * only cost is the hero itself. Screenshot framing (a capture inside a phone, a
 * caption over it) is typesetting over real screens and stays in ui-critic; this is
 * the piece only an image model can make.
 *
 * Targets (sizes and formats in rules.mjs, read on a dated basis):
 *   play-feature  1024 x 500  Google Play feature graphic
 *   og            1200 x 630  Open Graph (also serves an X large card)
 *   github        1280 x 640  GitHub repository social preview
 */

/**
 * The subject wraps whatever the user asked for (or a default drawn from the brief)
 * in the framing a promotional banner needs: landscape, full-bleed, centre-safe
 * because stores crop the sides, and room for an overlaid name. The painter rules
 * already forbid text and hold the palette, so those are not repeated here.
 */
export function storeSubject(subject) {
  const base = subject?.trim() || "The product's world as a single striking hero scene that sells it at a glance.";
  return `A promotional hero banner for the product, landscape and full-bleed to every edge. ${base} Compose it edge to edge with no border, frame or band of plain background; keep the key elements near the centre, because the store crops the sides; leave a calm area where a store could later overlay the app name; make it read at a glance.`;
}

export async function makeStore({ config, subject = null, name = null, targets = null, markPath = null, count = null, judge = true, log = (s) => process.stderr.write(s), fetch: fetchImpl }) {
  const keys = (targets && targets.length ? targets : Object.keys(STORE_TARGETS)).map((k) => k.toLowerCase());
  for (const k of keys) if (!STORE_TARGETS[k]) throw new Error(`unknown store target ${JSON.stringify(k)}; choose from ${Object.keys(STORE_TARGETS).join(", ")}`);
  const label = slug(name ?? "store-graphics");
  const dir = path.join(config.out, label);
  const references = markPath ? [...config.references, markPath] : config.references;
  const storeConfig = { ...config, background: null, references };

  // The hero: the whole generate loop, keyed on nothing, judged against the brief.
  const run = await generate({
    config: storeConfig,
    subject: storeSubject(subject),
    name: label,
    count,
    judge,
    aspectRatio: "16:9",
    outputs: false,
    kind: "store",
    dir,
    fetch: fetchImpl,
    log,
  });

  const bg = config.palette[0] ?? "#1c1b1f";
  const storeDir = path.join(dir, "store");
  await mkdir(storeDir, { recursive: true });
  const failures = [];
  const warnings = [];

  for (const c of run.candidates) {
    if (!c.files?.image) continue;
    const hero = decodeImage(await readFile(c.files.image));
    c.files.hero = c.files.image;
    c.files.targets = [];
    for (const key of keys) {
      const t = STORE_TARGETS[key];
      const flat = fillBackground(coverInto(hero, t.width, t.height), bg);
      const buffer = encodePNG24(flat);
      const file = path.join(storeDir, `${String(c.index).padStart(2, "0")}.${key}.png`);
      await writeFile(file, buffer);
      const checks = checkIcon(flat, buffer.length, { width: t.width, height: t.height, opaque: true, maxBytes: t.maxBytes });
      c.files.targets.push({ key, label: t.label, channel: t.channel, width: t.width, height: t.height, file, bytes: buffer.length, checks });
      for (const ch of checks) {
        if (ch.ok) continue;
        (ch.warn ? warnings : failures).push({ candidate: c.index, target: key, check: ch.check, detail: ch.detail });
      }
      log(`  ${String(c.index).padStart(2, "0")} ${key}: ${t.width}x${t.height}, ${Math.max(1, Math.round(buffer.length / 1024))} KB, ${checks.every((x) => x.ok) ? "passes" : checks.filter((x) => !x.ok).map((x) => x.check).join(" + ") + " failed"}\n`);
    }
  }

  const sources = {};
  for (const key of keys) sources[STORE_TARGETS[key].source] = RULE_SOURCES[STORE_TARGETS[key].source];
  const summary = {
    tool: "onmodel",
    kind: "store",
    name: label,
    subject: run.subject,
    dir,
    model: config.model,
    size: config.size,
    aspectRatio: "16:9",
    palette: config.palette,
    references,
    targets: keys,
    background: bg,
    rulesAsOf: RULES_AS_OF,
    sources,
    candidates: run.candidates,
    pick: run.pick,
    judgement: run.judgement,
    failures,
    warnings,
    usage: run.usage,
    estimatedCostUSD: run.estimatedCostUSD,
    generatedAt: run.generatedAt,
  };
  await writeFile(path.join(dir, "store.json"), JSON.stringify(summary, null, 2));
  const htmlPath = path.join(dir, "store.html");
  await writeFile(htmlPath, renderStoreHTML(summary, dir));
  const painted = run.candidates.filter((c) => c.files?.targets?.length).length;
  log(`  ${painted * keys.length} graphics across ${painted} hero${painted === 1 ? "" : "es"}, ${failures.length} failed, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}\n`);
  return { ...summary, htmlPath };
}
