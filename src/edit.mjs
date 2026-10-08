import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { ImageClient, JudgeClient, text, imagePart } from "./gemini.mjs";
import { requireBrief, briefSection, loadDecisions, decisionsSection } from "./brief.mjs";
import { decodeImage, encodePNG } from "./image.mjs";
import { decodePNG } from "./png.mjs";
import { resize } from "./key.mjs";
import { normalisePair, iou, silhouette } from "./measure.mjs";
import { processCandidate, writeOutputs, describeFacts, slug } from "./generate.mjs";
import { judgeView } from "./judge.mjs";
import { renderContactHTML } from "./html.mjs";

/**
 * Edits: a candidate's sidecar keeps its whole conversation with the image model,
 * so "make the tag magenta" is sent as the next turn of that conversation rather
 * than as a fresh request. The model changes the picture it already made instead
 * of painting a new one, which keeps everything the change did not mention and
 * costs one image. The result is keyed, measured and sized like any candidate,
 * measured against its parent for how much it moved, and judged on two questions:
 * was the change made, and was everything else kept.
 *
 * Edits are numbered per candidate: the first edit of candidate 2 is 2e1, and an
 * edit of 2e1 becomes 2e2 with 2e1 recorded as its parent, so a chain stays flat
 * and every step can be returned to.
 */

const pad2 = (n) => String(n).padStart(2, "0");
const round = (v, places = 3) => Math.round(v * 10 ** places) / 10 ** places;

export function parseCandidateId(value) {
  const m = String(value ?? "").trim().match(/^(\d+)(?:e(\d+))?$/i);
  if (!m) throw new Error(`"${value}" is not a candidate: use its number, such as 2, or an edit, such as 2e1`);
  const root = Number(m[1]);
  const edit = m[2] ? Number(m[2]) : 0;
  return { root, edit, id: edit ? `${root}e${edit}` : String(root) };
}

export const fileBase = ({ root, edit }) => `${pad2(root)}${edit ? `e${edit}` : ""}`;

export function editPrompt(change, key) {
  return [
    "## Edit",
    change.trim(),
    `Change only that. Keep everything else exactly as it is: the subject, its pose, proportions, colours and size, and the composition${key ? `, on the same flat ${key} background` : ""}.`,
    "Paint it now.",
  ].join("\n");
}

/**
 * How far an edit moved the picture: the share of pixels that changed visibly, and
 * how much of the silhouette survived. A recolour moves pixels and keeps the
 * silhouette; an edit that redrew the subject moves both.
 */
export function editFacts(parent, edited) {
  const e = edited.width === parent.width && edited.height === parent.height ? edited : resize(edited, parent.width, parent.height);
  let changed = 0;
  for (let i = 0; i < parent.width * parent.height; i++) {
    const p = i * 4;
    const d = Math.max(Math.abs(parent.data[p] - e.data[p]), Math.abs(parent.data[p + 1] - e.data[p + 1]), Math.abs(parent.data[p + 2] - e.data[p + 2]), Math.abs(parent.data[p + 3] - e.data[p + 3]));
    if (d > 32) changed++;
  }
  const [a, b] = normalisePair(parent, e);
  return { changed: round(changed / (parent.width * parent.height)), silhouette: round(iou(silhouette(a), silhouette(b))) };
}

export const EDIT_JUDGEMENT = {
  type: "OBJECT",
  properties: {
    applied: { type: "INTEGER", description: "0 to 100: the change asked for is made, fully and correctly" },
    preserved: { type: "INTEGER", description: "0 to 100: everything the change did not ask for is as it was" },
    problems: { type: "ARRAY", items: { type: "STRING" } },
    verdict: { type: "STRING", enum: ["keep", "retry"] },
  },
  required: ["applied", "preserved", "problems", "verdict"],
};

async function judgeEdit({ config, decisions, change, before, after, facts, ledgerPath, runLabel, fetch: fetchImpl }) {
  const client = new JudgeClient({ model: config.judge, thinking: config.judgeThinking, pricing: config.pricing, ledgerPath, runLabel, fetch: fetchImpl });
  const parts = [
    text("You are checking one edit to production art. You see the picture before and after, and the change that was asked for. Say whether the change was made, fully and correctly, and whether everything it did not ask for was kept. The measured facts are true. A settled decision is never a problem. Say keep, or retry when the change is missing or something else moved."),
    text(briefSection(config.briefText)),
  ];
  if (decisions.length) parts.push(text(decisionsSection(decisions)));
  parts.push(text(`## Change asked for\n${change}`));
  parts.push(text(`## Measured\n${Math.round(facts.changed * 100)}% of the pixels changed visibly; the silhouette overlaps the original by ${facts.silhouette}.`));
  parts.push(text("BEFORE"), await imagePart(await judgeView(before)));
  parts.push(text("AFTER"), await imagePart(await judgeView(after)));
  parts.push(text("## Task\nJudge the edit. The grey is not part of the art; it stands for transparency."));
  const { data } = await client.generateJSON({ parts, schema: EDIT_JUDGEMENT, op: `judge:${runLabel}` });
  return { data, summary: client.summary() };
}

export async function editCandidate({ config, name = null, dir: dirOverride = null, candidate = null, change, judge = true, fetch: fetchImpl, log = (s) => process.stderr.write(s) }) {
  requireBrief(config);
  if (!change?.trim()) throw new Error("edit needs --change: what to change, in a sentence");
  if (!name && !dirOverride) throw new Error("edit needs --name (the run to edit) or --in (its folder)");
  const dir = dirOverride ?? path.join(config.out, slug(name));
  let summary;
  try {
    summary = JSON.parse(await readFile(path.join(dir, "generate.json"), "utf8"));
  } catch {
    throw new Error(`no run to edit in ${dir}: it has no generate.json`);
  }
  if (candidate == null && summary.pick == null) throw new Error("edit needs --candidate: the run has no pick to default to");
  const parentId = parseCandidateId(candidate ?? summary.pick);
  let parent;
  try {
    parent = JSON.parse(await readFile(path.join(dir, `${fileBase(parentId)}.json`), "utf8"));
  } catch {
    const known = (await readdir(dir)).filter((f) => /^\d{2}(e\d+)?\.json$/.test(f)).map((f) => parseCandidateId(f.replace(/\.json$/, "").replace(/^0+(?=\d)/, "")).id);
    throw new Error(`there is no candidate ${parentId.id} in ${dir}; there are ${known.join(", ") || "none"}`);
  }
  if (!parent.turns?.length || !parent.files?.image) throw new Error(`candidate ${parentId.id} has no saved conversation to continue (it was not painted, or was made by an older version)`);

  const taken = (await readdir(dir)).map((f) => f.match(new RegExp(`^${pad2(parentId.root)}e(\\d+)\\.json$`))).filter(Boolean).map((m) => Number(m[1]));
  const id = { root: parentId.root, edit: (taken.length ? Math.max(...taken) : 0) + 1 };
  id.id = `${id.root}e${id.edit}`;
  const base = path.join(dir, fileBase(id));
  const key = summary.key ?? null;
  const label = summary.name ?? slug(name);
  const ledgerPath = path.join(config.out, config.ledger);
  const client = new ImageClient({ model: summary.model ?? config.model, thinking: config.thinking, pricing: config.pricing, ledgerPath, runLabel: label, budgetUSD: config.budgetUSD, fetch: fetchImpl });
  const prompt = editPrompt(change, key);
  log(`  ${label}: editing candidate ${parentId.id} into ${id.id}: ${change.trim()}\n`);
  const result = await client.generate({ prompt, history: parent.turns, aspectRatio: summary.aspectRatio ?? config.aspectRatio, size: summary.size ?? config.size, op: `${label}#${id.id}` });

  const record = { id: id.id, parent: parentId.id, change: change.trim(), costUSD: result.costUSD, usage: result.usage, blocked: result.blocked, files: {}, parentImage: parent.files.image };
  let judgeSummary = null;
  if (!result.blocked && result.images.length) {
    const painted = result.images[0];
    record.files.source = `${base}.source.${painted.mimeType === "image/png" ? "png" : "jpg"}`;
    await writeFile(record.files.source, painted.buffer);
    const processed = processCandidate(decodeImage(painted.buffer), { config, key, outputs: summary.kind !== "sheet" });
    record.files.image = `${base}.png`;
    await writeFile(record.files.image, encodePNG(processed.image));
    record.files.outputs = (await writeOutputs(base, processed.outputs, config)).outputs;
    const before = decodePNG(await readFile(parent.files.image));
    record.facts = { ...processed.facts, edit: editFacts(before, processed.image) };
    log(`  ${id.id}: ${describeFacts(processed.facts)}, changed ${Math.round(record.facts.edit.changed * 100)}% of the pixels, silhouette ${record.facts.edit.silhouette}, $${(result.costUSD ?? 0).toFixed(3)}\n`);
    if (judge) {
      try {
        const decisions = await loadDecisions(config);
        const judged = await judgeEdit({ config, decisions, change: record.change, before, after: processed.image, facts: record.facts.edit, ledgerPath, runLabel: `${label}:${id.id}`, fetch: fetchImpl });
        record.judgement = judged.data;
        judgeSummary = judged.summary;
        log(`  judge: ${record.judgement.verdict}, change made ${record.judgement.applied}, rest kept ${record.judgement.preserved}\n`);
      } catch (err) {
        record.judgement = { error: err.message };
        log(`  judge failed: ${err.message}\n`);
      }
    }
  } else {
    log(`  ${id.id}: not painted (${result.blocked})\n`);
  }
  const costs = [client.summary().estimatedCostUSD, judgeSummary?.estimatedCostUSD].filter((v) => v != null);
  record.estimatedCostUSD = costs.length ? round(costs.reduce((a, b) => a + b, 0), 6) : null;
  // The sidecar carries the conversation forward, so this edit can be edited in turn.
  await writeFile(`${base}.json`, JSON.stringify({ ...record, index: id.id, prompt, turns: result.turns }, null, 2));
  summary.edits = [...(summary.edits ?? []), record];
  await writeFile(path.join(dir, "generate.json"), JSON.stringify(summary, null, 2));
  const htmlPath = path.join(dir, "contact.html");
  await writeFile(htmlPath, renderContactHTML(summary, dir));
  return { ...record, dir, htmlPath };
}
