import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * The art brief: what the product is, who sees the art, and the direction a painter
 * could follow. Nothing is generated without it, because a model given no
 * direction paints the average of everything, and the average of everything is
 * what makes generated art look generated. The palette and the settled decisions
 * ride along, and the references are described here while the files themselves go
 * to the model as images.
 */

/** Sections the model cannot paint on brief without. */
export const REQUIRED_SECTIONS = ["Product", "Art direction"];

/** Phrases that survive only when the template was never filled in. */
const TEMPLATE_MARKERS = ["<Product name>", "What the product is, in two sentences", "The style in words a painter could follow"];

/** Problems with a brief; an empty list means it is usable. */
export function briefProblems(text) {
  const problems = [];
  const body = (text ?? "").trim();
  if (!body) return ["the brief is empty"];
  for (const section of REQUIRED_SECTIONS) {
    const m = body.match(new RegExp(`^#{1,3}\\s*${section}\\b`, "im"));
    if (!m) {
      problems.push(`the brief has no "## ${section}" section`);
      continue;
    }
    const content = body.slice(m.index + m[0].length).split(/^#{1,3}\s/m)[0].trim();
    if (content.length < 40) problems.push(`the "## ${section}" section is too short to paint from`);
  }
  for (const marker of TEMPLATE_MARKERS) if (body.includes(marker)) problems.push(`the brief still contains the template text "${marker}"`);
  return problems;
}

/** Throws a clear, actionable error when the brief would not support a generation. */
export function requireBrief(config) {
  const problems = briefProblems(config.briefText);
  if (!problems.length) return;
  const where = config.brief ? `brief file ${config.brief}` : 'no brief configured (set "brief" in onmodel.config.json or pass --brief)';
  throw new Error(`generation needs a brief that says what the product is and what the art should look like: ${problems.join("; ")} (${where}). Run \`onmodel init\` for the template and fill in at least Product and Art direction.`);
}

/** The brief as a prompt section. */
export const briefSection = (text) => `## Brief\n${String(text ?? "").trim()}`;

/** One named section of the brief, without its heading; empty when absent. */
export function sectionOf(text, name) {
  const m = String(text ?? "").match(new RegExp(`^#{1,3}\\s*${name}\\b[^\\n]*\\n`, "im"));
  if (!m) return "";
  return String(text).slice(m.index + m[0].length).split(/^#{1,3}\s/m)[0].trim();
}

/** Hex colours named in the brief's Palette section, in the order written. */
export function paletteFromBrief(text) {
  const seen = new Set();
  const out = [];
  for (const m of sectionOf(text, "Palette").matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = `#${m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1]}`.toLowerCase();
    if (!seen.has(hex)) {
      seen.add(hex);
      out.push(hex);
    }
  }
  return out;
}

/**
 * Extra context the model is given: files from context.files (design tokens, a
 * style guide), each truncated so one large file cannot crowd out the images.
 */
export async function contextSections(config, limitPerFile = 6000) {
  const sections = [];
  for (const file of config.context?.files ?? []) {
    try {
      const raw = await readFile(path.resolve(file), "utf8");
      sections.push(`### Context file: ${file}\n${raw.length > limitPerFile ? raw.slice(0, limitPerFile) + "\n[truncated]" : raw}`);
    } catch (err) {
      sections.push(`### Context file: ${file}\n(could not be read: ${err.message})`);
    }
  }
  return sections.length ? `## Additional context\n${sections.join("\n\n")}` : "";
}

/** Bullet or numbered lines of a decisions file; the rest is ignored. */
export function parseDecisions(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (m && !/^Example:/i.test(m[1])) out.push(m[1]);
  }
  return out;
}

/** The configured decisions; a missing file means none. */
export async function loadDecisions(config) {
  const file = config?.context?.decisions;
  if (!file) return [];
  try {
    return parseDecisions(await readFile(path.resolve(file), "utf8"));
  } catch {
    return [];
  }
}

/** The prompt section that carries the settled decisions to the painter and the judge. */
export function decisionsSection(decisions) {
  if (!decisions?.length) return "";
  return `## Settled decisions\nThese are decided and are not to be changed or marked down, however you would have done it:\n${decisions.map((d, i) => `${i + 1}. ${d}`).join("\n")}`;
}
