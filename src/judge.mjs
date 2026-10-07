import { JudgeClient, text, imagePart } from "./gemini.mjs";
import { briefSection, decisionsSection, sectionOf } from "./brief.mjs";
import { encodePNG } from "./image.mjs";
import { fillBackground, fitInto } from "./key.mjs";

/**
 * The judge: a text model shown the brief, the references and every candidate
 * with its measured facts, asked which is on brief and on model, what is wrong
 * with each, which to take forward, and the one edit that would improve it. The
 * facts are given as true, so the judge reasons from them instead of guessing at
 * a colour count or whether the background was removed.
 */

export const JUDGEMENT = {
  type: "OBJECT",
  properties: {
    candidates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          index: { type: "INTEGER", description: "the candidate's number as given" },
          on_brief: { type: "INTEGER", description: "0 to 100: does it do what the brief and the subject ask, in the direction the brief describes" },
          on_model: { type: "INTEGER", description: "0 to 100: the same character, proportions, line, palette and style as the references; 100 when there are no references" },
          craft: { type: "INTEGER", description: "0 to 100: a clean silhouette, no artefacts, no stray marks, no text, nothing cut off" },
          problems: { type: "ARRAY", items: { type: "STRING" }, description: "what is wrong, each naming where" },
          strengths: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["index", "on_brief", "on_model", "craft", "problems", "strengths"],
      },
    },
    pick: { type: "INTEGER", description: "the number of the candidate to take forward, or 0 when none is usable" },
    reason: { type: "STRING", description: "two sentences on why that one" },
    edit: { type: "STRING", description: "one edit instruction, in the imperative, that would improve the pick; empty when it needs none" },
  },
  required: ["candidates", "pick", "reason", "edit"],
};

const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;

/** The measured facts of a candidate as one line the judge can read. */
export function factLine(facts) {
  if (!facts) return "no measurements";
  const bits = [];
  if (facts.keying) {
    const k = facts.keying;
    bits.push(`background removed ${pct(k.background)} of the frame`, `soft edge ${pct(k.fringe)}`, `key colour left in the subject ${pct(k.residue)}`);
    if (k.touchesEdge) {
      const sides = Object.entries(k.touchesEdge).filter(([, v]) => v).map(([s]) => s);
      bits.push(sides.length ? `subject touches the ${sides.join(" and ")} edge (cut off)` : "subject clear of every edge");
    }
  }
  if (facts.fill !== undefined) bits.push(`subject fills ${pct(facts.fill)} of the frame`);
  if (facts.colours !== undefined) bits.push(`${facts.colours} colours`);
  if (facts.paletteDrift) bits.push(`palette drift mean ${facts.paletteDrift.mean} max ${facts.paletteDrift.max} (CIE76; under 5 is on palette)`);
  if (facts.grid) bits.push(`${pct(facts.grid.share)} of ${facts.grid.cell}px cells are flat (pixel grid)`);
  return bits.join(", ");
}

/** A candidate as the judge should see it: flattened on grey (alpha reads as nothing to a model) and no larger than needed. */
export async function judgeView(image, { size = 512, background = "#808080" } = {}) {
  const fitted = image.width > size || image.height > size ? fitInto(image, size, size) : image;
  return encodePNG(fillBackground(fitted, background));
}

export async function judgeCandidates({ config, subject, candidates, decisions = [], extra = "", ledgerPath, runLabel, fetch: fetchImpl }) {
  const usable = candidates.filter((c) => c.image && !c.blocked);
  if (!usable.length) return { data: null, usage: null, skipped: "no candidate to judge" };
  const client = new JudgeClient({ model: config.judge, thinking: config.judgeThinking, pricing: config.pricing, ledgerPath, runLabel, fetch: fetchImpl });
  try {
    const parts = [
      text(
        "You are judging generated art for a real product against its brief, its references and the subject that was asked for. Score each candidate on brief (does it do what was asked, in the brief's direction), on model (is it the same character and style as the references; score 100 when there are none) and craft (clean silhouette, nothing cut off, no artefacts, no text). The measured facts given for each candidate are true: do not contradict them, and do not guess at what they already say. A settled decision is never a problem. Pick the one to take forward and say the single edit that would most improve it.",
      ),
      text(briefSection(config.briefText)),
    ];
    if (decisions.length) parts.push(text(decisionsSection(decisions)));
    if (extra) parts.push(text(extra));
    if (config.references.length) {
      const notes = sectionOf(config.briefText, "References");
      parts.push(text(`## References\n${notes || "The images the art must stay consistent with."}`));
      for (const [i, ref] of config.references.entries()) {
        parts.push(text(`Reference ${i + 1}: ${ref}`));
        parts.push(await imagePart(ref));
      }
    }
    parts.push(text(`## Subject\n${subject}`));
    for (const c of usable) {
      parts.push(text(`### Candidate ${c.index}\nMeasured: ${factLine(c.facts)}`));
      parts.push(await imagePart(await judgeView(c.judgeImage ?? c.image)));
    }
    parts.push(text(`## Task\nJudge candidates ${usable.map((c) => c.index).join(", ")}. The grey behind each one is not part of the art; it stands for transparency.`));
    const { data, usage } = await client.generateJSON({ parts, schema: JUDGEMENT, op: `judge:${runLabel}` });
    return { data, usage, summary: client.summary() };
  } finally {
    // nothing to close: the judge holds no cache
  }
}
