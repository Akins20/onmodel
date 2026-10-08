import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IMAGE_SIZES, ASPECT_RATIOS } from "./gemini.mjs";
import { parseColor, toHex } from "./color.mjs";
import { paletteFromBrief } from "./brief.mjs";

/**
 * Configuration: every knob has a default, and the order of precedence, lowest to
 * highest, is built-in defaults, onmodel.config.json, environment, flags. The
 * brief is read with the config so every command has it; the palette comes from
 * the config or, when the config names none, from the brief's Palette section.
 */

export const CONFIG_FILE = "onmodel.config.json";
export const THINKING_LEVELS = ["off", "low", "medium", "high"];

export const DEFAULTS = {
  // The art brief: what the product is, who sees the art, the direction. Required.
  brief: "onmodel/brief.md",
  // Images the model must stay consistent with (a logo, a model sheet, a style
  // sheet), shown to it before every prompt.
  references: [],
  // The colours the art must use, as hex; empty means the brief's Palette section.
  palette: [],
  context: { files: [], decisions: "onmodel/decisions.md" },
  // The image model, and the text model that judges candidates.
  model: "gemini-nano-banana-2.1",
  judge: "gemini-3.8-flash",
  size: "1K",
  aspectRatio: "1:1",
  // Candidates per request; the measured checks and the judge pick between them.
  candidates: 3,
  // The image model's thinking; empty leaves its default, { "level": "low" } spends less.
  thinking: {},
  judgeThinking: { level: "high" },
  // The flat colour the model paints behind a subject, keyed to transparency
  // afterwards: "auto" picks the key furthest from the palette; a hex forces one;
  // null keeps whatever background the model paints.
  background: "auto",
  // Keying: how far from the key colour (CIEDE2000) still counts as background,
  // and whether the key's tint is removed from the edge pixels it bled into.
  key: { tolerance: 30, despill: true },
  // Exact output sizes to write beside the full-size result, as "64x64" or "64".
  sizes: [],
  // Pixel-art mode: the grid the art lives on and how many colours it may use.
  // null means ordinary art. { "grid": 32, "colors": 16 } is a 32 by 32 sprite.
  pixel: null,
  // Snap every output's colours to the palette (always on in pixel mode).
  quantize: false,
  // Sprites: the cell every frame is placed in (a number, "64x48", or null for the
  // pixel grid, else 128), how much of it the character fills, where its feet stand,
  // and the actions: [{ "name": "walk", "frames": 6, "fps": 10, "motion": "a steady
  // walk", "facing": "right", "mirror": "walk_left", "loop": true }]. A strip whose
  // frames drift past the thresholds is painted again up to `retries` times, then a
  // frame still off is repainted alone up to `frameRetries` times.
  sprite: {
    frame: null,
    fill: 0.9,
    anchor: "bottom",
    actions: [],
    thresholds: { shape: 0.5, size: 0.15, palette: 15, jump: 0.45 },
    retries: 2,
    frameRetries: 1,
    // Rounds in which the judge's named frames are repainted with its fix, kept
    // only when a second judgement scores the action no worse. 0 turns it off.
    judgeRepairs: 1,
    maxFrames: 8,
  },
  // Refuse to start a call that would carry a run past this many dollars.
  budgetUSD: 2,
  out: "onmodel-out",
  ledger: "usage.jsonl",
  pricing: {},
  json: false,
};

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** Deep-merges plain objects; arrays and scalars in `over` replace. */
export function merge(base, over) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over ?? {})) {
    if (v === undefined) continue;
    out[k] = isObject(v) && isObject(base?.[k]) ? merge(base[k], v) : v;
  }
  return out;
}

/** A colour as six-digit lowercase hex, or null when it is not a colour. */
export function normalizeHex(value) {
  const c = parseColor(String(value ?? "").trim());
  return c ? toHex(c.rgb) : null;
}

export function envOverrides(env = process.env) {
  const o = {};
  if (env.GEMINI_MODEL) o.model = env.GEMINI_MODEL;
  if (env.ONMODEL_JUDGE) o.judge = env.ONMODEL_JUDGE;
  if (env.ONMODEL_OUT) o.out = env.ONMODEL_OUT;
  if (env.ONMODEL_BRIEF) o.brief = env.ONMODEL_BRIEF;
  if (env.ONMODEL_BUDGET !== undefined && env.ONMODEL_BUDGET !== "") o.budgetUSD = Number(env.ONMODEL_BUDGET);
  if (env.ONMODEL_THINKING) o.thinking = { level: env.ONMODEL_THINKING };
  return o;
}

const list = (s) => String(s).split(",").map((x) => x.trim()).filter(Boolean);

/**
 * The --actions shorthand: actions separated by semicolons, each
 * "name:frames[:motion]", so "chomp:4:mouth opening wide then snapping shut;
 * die:6:spinning and shrinking away" is two actions. A motion may contain commas.
 */
export function parseActions(textValue) {
  return String(textValue)
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, frames, ...rest] = entry.split(":");
      const motion = rest.join(":").trim();
      return { name: (name ?? "").trim(), frames: Number(frames), ...(motion ? { motion } : {}) };
    });
}

const FACINGS = ["right", "left", "front", "back"];

/** Checks the sprite block and fills each action's defaults, throwing the first problem in plain words. */
function validateSprite(sp) {
  if (!isObject(sp)) throw new Error("sprite must be an object");
  if (!(Number.isInteger(sp.maxFrames) && sp.maxFrames >= 1 && sp.maxFrames <= 12)) throw new Error("sprite.maxFrames must be from 1 to 12");
  if (sp.frame !== null) {
    const m = String(sp.frame).trim().match(/^(\d+)(?:\s*[x×]\s*(\d+))?$/i);
    if (!m) throw new Error('sprite.frame must be a size such as 32 or "64x48", or null');
    const width = Number(m[1]);
    const height = Number(m[2] ?? m[1]);
    if (!(width >= 4 && height >= 4 && width <= 2048 && height <= 2048)) throw new Error("sprite.frame must be from 4 to 2048 pixels a side");
    sp.frame = { width, height };
  }
  if (!(typeof sp.fill === "number" && sp.fill >= 0.3 && sp.fill <= 1)) throw new Error("sprite.fill must be a share of the cell from 0.3 to 1");
  if (!["bottom", "center", "top"].includes(sp.anchor)) throw new Error("sprite.anchor must be bottom, center or top");
  if (!(Number.isInteger(sp.retries) && sp.retries >= 0 && sp.retries <= 5)) throw new Error("sprite.retries must be from 0 to 5");
  if (!(Number.isInteger(sp.frameRetries) && sp.frameRetries >= 0 && sp.frameRetries <= 3)) throw new Error("sprite.frameRetries must be from 0 to 3");
  if (!(Number.isInteger(sp.judgeRepairs) && sp.judgeRepairs >= 0 && sp.judgeRepairs <= 2)) throw new Error("sprite.judgeRepairs must be from 0 to 2");
  const checkThresholds = (t, where) => {
    if (!isObject(t)) throw new Error(`${where} must be an object`);
    for (const [k, v] of Object.entries(t)) {
      if (!["shape", "size", "palette", "jump"].includes(k)) throw new Error(`${where}.${k} is not a threshold (shape, size, palette, jump)`);
      if (!(typeof v === "number" && v >= 0 && Number.isFinite(v))) throw new Error(`${where}.${k} must be a number`);
    }
  };
  checkThresholds(sp.thresholds, "sprite.thresholds");
  if (!Array.isArray(sp.actions)) throw new Error("sprite.actions must be a list of actions");
  const names = new Set();
  sp.actions = sp.actions.map((a, i) => {
    if (!isObject(a)) throw new Error(`sprite.actions[${i}] must be an object`);
    const name = String(a.name ?? "").trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(name)) throw new Error(`sprite.actions[${i}].name must be letters, digits, spaces, dashes or underscores`);
    if (!(Number.isInteger(a.frames) && a.frames >= 1 && a.frames <= sp.maxFrames)) throw new Error(`action ${name} needs frames from 1 to ${sp.maxFrames}`);
    const fps = a.fps ?? 8;
    if (!(typeof fps === "number" && fps >= 0.5 && fps <= 60)) throw new Error(`action ${name}: fps must be from 0.5 to 60`);
    const facing = a.facing ?? "right";
    if (!FACINGS.includes(facing)) throw new Error(`action ${name}: facing must be one of ${FACINGS.join(", ")}`);
    const mirrorName = a.mirror == null ? null : String(a.mirror).trim();
    if (mirrorName !== null && !/^[A-Za-z0-9][A-Za-z0-9 _-]*$/.test(mirrorName)) throw new Error(`action ${name}: mirror must name the mirrored action`);
    for (const n of [name, mirrorName].filter(Boolean)) {
      if (names.has(n)) throw new Error(`the action name ${n} is used twice`);
      names.add(n);
    }
    if (a.loop !== undefined && typeof a.loop !== "boolean") throw new Error(`action ${name}: loop must be true or false`);
    if (a.thresholds !== undefined) checkThresholds(a.thresholds, `action ${name}.thresholds`);
    return { name, frames: a.frames, fps, motion: String(a.motion ?? name).trim(), facing, mirror: mirrorName, loop: a.loop ?? true, ...(a.thresholds ? { thresholds: a.thresholds } : {}) };
  });
  return sp;
}

export function flagOverrides(flags = {}) {
  const o = {};
  if (flags.model) o.model = flags.model;
  if (flags.judge) o.judge = flags.judge;
  if (flags.size) o.size = flags.size;
  if (flags.aspect) o.aspectRatio = flags.aspect;
  if (flags.candidates !== undefined) o.candidates = Number(flags.candidates);
  if (flags.count !== undefined) o.candidates = Number(flags.count);
  if (flags.sizes) o.sizes = list(flags.sizes);
  if (flags.pixel !== undefined) {
    const m = String(flags.pixel).match(/^(\d+)(?:[:,/](\d+))?$/);
    o.pixel = m ? { grid: Number(m[1]), ...(m[2] ? { colors: Number(m[2]) } : {}) } : { grid: NaN };
  }
  if (flags.quantize) o.quantize = true;
  if (flags.frame !== undefined) o.sprite = { ...(o.sprite ?? {}), frame: flags.frame };
  if (flags.actionsList) o.sprite = { ...(o.sprite ?? {}), actions: flags.actionsList };
  else if (flags.actions) o.sprite = { ...(o.sprite ?? {}), actions: parseActions(flags.actions) };
  if (flags.out) o.out = flags.out;
  if (flags.brief) o.brief = flags.brief;
  if (flags.budget !== undefined) o.budgetUSD = Number(flags.budget);
  if (flags.background) o.background = /^(none|null|keep)$/i.test(flags.background) ? null : flags.background;
  if (flags.references) o.references = list(flags.references);
  if (flags.palette) o.palette = list(flags.palette);
  if (flags.context) o.context = { files: list(flags.context) };
  if (flags.decisions) o.context = { ...(o.context ?? {}), decisions: flags.decisions };
  if (flags.thinking) o.thinking = { level: flags.thinking };
  if (flags.json) o.json = true;
  return o;
}

/** Checks a merged config and normalises what it can; throws the first problem in plain words. */
export function validate(cfg) {
  if (typeof cfg.brief !== "string" || !cfg.brief.trim()) throw new Error("brief must be the path of the art brief");
  if (!Array.isArray(cfg.references) || cfg.references.some((r) => typeof r !== "string" || !r.trim())) throw new Error("references must be a list of image file paths");
  if (!Array.isArray(cfg.palette)) throw new Error("palette must be a list of hex colours");
  cfg.palette = cfg.palette.map((c) => {
    const hex = normalizeHex(c);
    if (!hex) throw new Error(`palette colour ${JSON.stringify(c)} is not a colour`);
    return hex;
  });
  for (const key of ["model", "judge"]) if (typeof cfg[key] !== "string" || !cfg[key].trim()) throw new Error(`${key} must name a Gemini model`);
  if (!IMAGE_SIZES.includes(cfg.size)) throw new Error(`size must be one of ${IMAGE_SIZES.join(", ")}`);
  if (!ASPECT_RATIOS.includes(cfg.aspectRatio)) throw new Error(`aspectRatio must be one of ${ASPECT_RATIOS.join(", ")}`);
  if (!(Number.isInteger(cfg.candidates) && cfg.candidates >= 1 && cfg.candidates <= 8)) throw new Error("candidates must be a whole number from 1 to 8");
  for (const key of ["thinking", "judgeThinking"]) {
    const t = cfg[key] ?? {};
    if (!isObject(t)) throw new Error(`${key} must be an object`);
    if (t.level !== undefined && !THINKING_LEVELS.includes(t.level)) throw new Error(`${key}.level must be one of ${THINKING_LEVELS.join(", ")}`);
    if (t.budget !== undefined && !(Number.isInteger(t.budget) && t.budget >= 0)) throw new Error(`${key}.budget must be a whole number of tokens`);
  }
  if (cfg.background !== null && cfg.background !== "auto") {
    const hex = normalizeHex(cfg.background);
    if (!hex) throw new Error('background must be "auto", a hex colour, or null');
    cfg.background = hex;
  }
  if (!isObject(cfg.key)) throw new Error("key must be an object");
  if (!(typeof cfg.key.tolerance === "number" && cfg.key.tolerance >= 1 && cfg.key.tolerance <= 80)) throw new Error("key.tolerance must be a colour distance from 1 to 80");
  if (typeof cfg.key.despill !== "boolean") throw new Error("key.despill must be true or false");
  if (!Array.isArray(cfg.sizes)) throw new Error('sizes must be a list such as ["64x64", "128"]');
  cfg.sizes = cfg.sizes.map((s) => {
    const m = String(s).trim().match(/^(\d+)(?:\s*[x×]\s*(\d+))?$/i);
    if (!m) throw new Error(`size ${JSON.stringify(s)} is not a size such as "64x64" or "64"`);
    const width = Number(m[1]);
    const height = Number(m[2] ?? m[1]);
    if (!(width >= 1 && height >= 1 && width <= 8192 && height <= 8192)) throw new Error(`size ${s} is out of range`);
    return { width, height };
  });
  if (cfg.pixel !== null) {
    if (!isObject(cfg.pixel)) throw new Error('pixel must be null or { "grid": 32, "colors": 16 }');
    if (!(Number.isInteger(cfg.pixel.grid) && cfg.pixel.grid >= 4 && cfg.pixel.grid <= 512)) throw new Error("pixel.grid must be a whole number of pixels from 4 to 512");
    if (cfg.pixel.colors !== undefined && !(Number.isInteger(cfg.pixel.colors) && cfg.pixel.colors >= 2 && cfg.pixel.colors <= 256)) throw new Error("pixel.colors must be from 2 to 256");
  }
  if (typeof cfg.quantize !== "boolean") throw new Error("quantize must be true or false");
  cfg.sprite = validateSprite({ ...cfg.sprite, thresholds: { ...cfg.sprite?.thresholds } });
  if (cfg.budgetUSD !== null && !(typeof cfg.budgetUSD === "number" && cfg.budgetUSD >= 0 && Number.isFinite(cfg.budgetUSD))) throw new Error("budgetUSD must be a number of dollars, or null for no cap");
  for (const key of ["out", "ledger"]) if (typeof cfg[key] !== "string" || !cfg[key].trim()) throw new Error(`${key} must be a path`);
  if (!isObject(cfg.pricing)) throw new Error("pricing must be an object of model prices");
  if (!isObject(cfg.context) || !Array.isArray(cfg.context.files ?? [])) throw new Error("context.files must be a list of file paths");
  return cfg;
}

export async function loadConfig(flags = {}, env = process.env) {
  const configPath = flags.config ?? path.join(process.cwd(), CONFIG_FILE);
  let file = {};
  try {
    file = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if (flags.config || err.code !== "ENOENT") throw new Error(`could not read ${configPath}: ${err.message}`);
  }
  if (flags.actions && /\.json$/i.test(String(flags.actions).trim())) {
    try {
      flags = { ...flags, actionsList: JSON.parse(await readFile(path.resolve(String(flags.actions).trim()), "utf8")) };
    } catch (err) {
      throw new Error(`could not read the actions file ${flags.actions}: ${err.message}`);
    }
  }
  const cfg = validate(merge(merge(merge(DEFAULTS, file), envOverrides(env)), flagOverrides(flags)));
  cfg.configPath = configPath;
  cfg.briefText = "";
  try {
    cfg.briefText = await readFile(path.resolve(cfg.brief), "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw new Error(`could not read the brief ${cfg.brief}: ${err.message}`);
  }
  if (!cfg.palette.length) cfg.palette = paletteFromBrief(cfg.briefText);
  return cfg;
}

/** Writes the starter config, brief and decisions file, leaving any that already exist alone. */
export async function init({ cwd = process.cwd() } = {}) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const exists = (p) => access(p).then(() => true, () => false);
  const written = [];
  const configPath = path.join(cwd, CONFIG_FILE);
  if (!(await exists(configPath))) {
    const starter = { ...DEFAULTS };
    delete starter.json;
    await writeFile(configPath, JSON.stringify(starter, null, 2) + "\n");
    written.push(configPath);
  }
  for (const [name, template] of [
    ["brief.md", "brief.example.md"],
    ["decisions.md", "decisions.example.md"],
  ]) {
    const target = path.join(cwd, "onmodel", name);
    if (await exists(target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, await readFile(path.join(here, "..", "templates", template), "utf8"));
    written.push(target);
  }
  return written;
}
