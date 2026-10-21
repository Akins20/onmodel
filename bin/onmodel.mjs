#!/usr/bin/env node
import { parseArgs } from "node:util";
import path from "node:path";
import { readFile } from "node:fs/promises";
import { loadConfig, init, parseActions } from "../src/config.mjs";
import { estimatePlan } from "../src/plan.mjs";
import { listModels } from "../src/gemini.mjs";
import { resolveImagePrice, resolveTextPrice, PRICING_AS_OF } from "../src/pricing.mjs";
import { generate, slug } from "../src/generate.mjs";
import { makeSheet, makeSprites } from "../src/sprites.mjs";
import { editCandidate } from "../src/edit.mjs";
import { makeIcons } from "../src/icons.mjs";
import { makeStore } from "../src/store.mjs";
import { makeText } from "../src/text.mjs";
import { makeLockup } from "../src/lockup.mjs";
import { makeTileset } from "../src/tileset.mjs";
import { makeNormalMap } from "../src/normalmap.mjs";
import { makeShape } from "../src/shape.mjs";
import { makeTerrain } from "../src/terrainset.mjs";
import { makeAtlas } from "../src/repack.mjs";
import { makeNinePatch } from "../src/ninepatchset.mjs";
import { makeBitmapFont } from "../src/bitmapfontset.mjs";
import { parseVariation } from "../src/variation.mjs";
import { makeVector } from "../src/vectorize.mjs";
import { makeMotion, FORMATS as MOTION_FORMATS } from "../src/motionset.mjs";
import { checkRun, findRuns, failuresOf } from "../src/check.mjs";

const HELP = `onmodel: images, sprites and sets kept on model

Usage
  onmodel <command> [flags]

Commands
  init                              write onmodel.config.json, onmodel/brief.md and onmodel/decisions.md
  models [--filter banana]          the models the key can use, which make images, and what they cost
  generate --subject "..."          paint a subject from the brief: candidates, keyed, measured, judged
           [--name slug] [--count 3] [--sizes 64,128] [--pixel 32[:16]] [--quantize]
           [--references a.png,b.png] [--palette #hex,#hex] [--background auto|#hex|none]
           [--size 1K] [--aspect 1:1] [--model id] [--judge id] [--no-judge] [--budget 2]
  edit --name x --change "..."      continue a candidate's conversation with one change, then measure and
           [--candidate 2|2e1] [--in dir] [--sheet] [--no-judge]    judge it: was the change made, was
                                    the rest kept; --sheet edits the model sheet and cuts the edit into views
  icons --name x [--candidate 2]    every icon Android, iOS, the web and Expo ask for, from one mark, checked
        or --mark logo.png          against a dated rulebook, with mask previews  [--background #hex] (free)
  vector --name x [--candidate 2]   trace a flat or pixel-art mark into an SVG with brand-named fills and an
         or --mark logo.png         Android vector drawable, drawn back and measured  [--detail low|normal|high]
                                    [--stroke 4] line work as stroked centre lines; [--tone 16] shaded art in that
                                    many tones instead of refusing it; [--mono] one colour by luminance (the cut is
                                    chosen from the art, or set it with [--threshold 128]), with [--tone N] for
                                    N levels; [--noise 40] ignore shapes under that many pixels (free)
  text --string "ACME" --font f.ttf  a wordmark or lettermark set from a real font, not drawn: the letters are
       [--name slug] [--px 128]      the type designer's own outlines, so they cannot come out malformed;
       [--tracking 20] [--colour #hex] [--no-kerning]   a variable font is set by [--variation "wght=700,wdth=90"]
       [--instance Bold]             or a named instance, its advances and kerning moving with it (free)
  terrain --mark fill.png or --name run  the 16 or 47 cells a Godot TileMapLayer needs to paint a
          [--mode both|sides]        material, composited from one seamless fill (scaled to one cell)
          [--cell 32] [--round 4]    with every peering bit derived, then every pair of cells that can
          [--terrain name]           touch is checked edge by edge; --round is clamped so edges stay exact (free)
  bitmapfont --font f.ttf [--px 16]  a bitmap font set from a real font's outlines, written as an AngelCode
          [--chars "..."] [--mono]   .fnt with its page (Godot imports it as a FontFile); text set from the
          [--cover 50] [--no-kerning] files read back must match the glyphs as built, pixel for pixel;
          [--variation "wght=700"] [--instance Bold]  a variable font set at those coordinates or that instance (free)
  ninepatch --mark panel.png or --name run  a panel, button or frame that stretches to any size: the
          [--scale 0.25]             insets found from the art (the bands whose lines are alike),
          [--insets l,t,r,b]         written as a Godot StyleBoxTexture, an Android .9.png and CSS
          [--content l,t,r,b]        border-image; a .9.png given as --mark keeps its own marks (free)
  shape --mark art.png or --name run  the collision and occlusion shape traced from the art's own
        [--points 16]                silhouette, simplified to a budget, with an OccluderPolygon2D and
                                     the outline drawn over the art to show where it is wrong (free)
  normal --mark art.png or --name run  a normal map derived from the art so a 2D light knows which way each
         [--strength 1] [--blur 1]    pixel faces, with the Godot CanvasTexture and the art lit from four
         [--wrap] [--invert-y]        corners; the height comes from luminance, which is said not hidden (free)
  tile --mark t.png or --name run   check whether a texture really tiles, close the join if it does not,
       [--band 8] [--grid 3]        and write a Godot TileSet; the join is measured against the
       [--no-fix] [--normal]        texture's own grain, so busy and smooth are judged alike;
       [--collision]                --collision bakes a body and an occluder into the TileSet;
                                    --normal derives a tiling normal map and a CanvasTexture too (free)
  lockup --string "ACME" --font f.ttf  a traced symbol and a set wordmark placed together as one mark
         --mark logo.png or --name run  [--layout beside|above] [--px 128] [--gap 0.5] [--symbol 1.2]
         [--variation "wght=700"] [--instance Bold]  the symbol is sized and centred on the cap height, not
                                    the em; a variable font is set at those coordinates or that instance (free)
  store --name x [--subject "..."]  an on-brand hero painted, judged, then cropped to each store's exact
        [--targets play-feature,og,github] [--mark logo.png]    canvas as a 24-bit PNG (no alpha)
        [--count 3] [--size 2K] [--budget 2] [--no-judge]
  motion --spec crow.motion.json    shapes onmodel made (a traced SVG, text set from a font), moved by a
         [--name slug] [--size 432]  keyframed timeline, written as an Android animated vector drawable
         [--formats android,lottie,svg,gif,apng,mp4,poster]   (splash screens), Lottie JSON, an SVG
         [--hold 500] [--keep-frames] animated with CSS, a GIF, an APNG, an MP4 (ffmpeg) and a poster;
                                    every vector file is read back the way its player reads it and drawn
                                    against the timeline, and the end is held to the artwork at rest (free)
  sheet --subject "..." --name x    the model sheet: front, side and back views every frame is held to
           [--count 3] [--no-judge]
  sprites --name x                  paint each action as a strip, measure it against the sheet, repair
           [--actions "walk:6:a steady walk;jump:5"] [--frame 32] [--subject "..."]
           [--pick 2] [--no-sheet] [--no-judge] [--budget 2]
                                    then pack the atlas with JSON, CSS and C exports and APNG/GIF previews
           [--trim] [--alpha 1] [--padding 2] [--pivot]
                                    --trim cuts each frame to its pixels and records where it sat;
                                    --pivot writes the point every frame stands on
  atlas --name x [--trim] [--pivot] pack a sprites run again, trimmed or with a pivot, every frame
        [--alpha 1] [--padding 2]   put back from the record and compared with its cell (free)
  check [--name x | --in dir]       re-check written outputs against the rulebook, no API (a CI gate);
                                    no target checks every run under --out. Exits 2 on any failure.
  price [--subjects N] [--store]    what a planned batch would cost before it runs, no API
        [--sprites "walk:6;run:8"] [--count 3] [--size 2K] [--no-judge]
  cost [--out dir]                  what every run has cost so far, from the ledger

Flags for every command
  --config <file>  --out <dir>  --brief <file>  --thinking off|low|medium|high  --json  -h, --help

The key comes from GEMINI_API_KEY in the environment and is never stored. Prices are
built in as of ${PRICING_AS_OF}; the config's "pricing" block overrides them.
`;

const OPTIONS = {
  config: { type: "string" },
  out: { type: "string" },
  brief: { type: "string" },
  model: { type: "string" },
  judge: { type: "string" },
  size: { type: "string" },
  aspect: { type: "string" },
  candidates: { type: "string" },
  count: { type: "string" },
  sizes: { type: "string" },
  pixel: { type: "string" },
  quantize: { type: "boolean" },
  background: { type: "string" },
  references: { type: "string" },
  palette: { type: "string" },
  context: { type: "string" },
  decisions: { type: "string" },
  thinking: { type: "string" },
  budget: { type: "string" },
  subject: { type: "string" },
  name: { type: "string" },
  "no-judge": { type: "boolean" },
  frame: { type: "string" },
  actions: { type: "string" },
  "no-sheet": { type: "boolean" },
  pick: { type: "string" },
  candidate: { type: "string" },
  mark: { type: "string" },
  targets: { type: "string" },
  subjects: { type: "string" },
  sprites: { type: "string" },
  store: { type: "boolean" },
  sheet: { type: "boolean" },
  detail: { type: "string" },
  stroke: { type: "string" },
  tone: { type: "string" },
  mono: { type: "boolean" },
  threshold: { type: "string" },
  string: { type: "string" },
  font: { type: "string" },
  px: { type: "string" },
  tracking: { type: "string" },
  colour: { type: "string" },
  color: { type: "string" },
  "no-kerning": { type: "boolean" },
  variation: { type: "string" },
  instance: { type: "string" },
  layout: { type: "string" },
  gap: { type: "string" },
  symbol: { type: "string" },
  band: { type: "string" },
  grid: { type: "string" },
  "no-fix": { type: "boolean" },
  strength: { type: "string" },
  blur: { type: "string" },
  wrap: { type: "boolean" },
  "invert-y": { type: "boolean" },
  normal: { type: "boolean" },
  points: { type: "string" },
  collision: { type: "boolean" },
  trim: { type: "boolean" },
  insets: { type: "string" },
  chars: { type: "string" },
  cover: { type: "string" },
  content: { type: "string" },
  scale: { type: "string" },
  pivot: { type: "boolean" },
  alpha: { type: "string" },
  padding: { type: "string" },
  mode: { type: "string" },
  cell: { type: "string" },
  columns: { type: "string" },
  margin: { type: "string" },
  round: { type: "string" },
  terrain: { type: "string" },
  noise: { type: "string" },
  change: { type: "string" },
  spec: { type: "string" },
  formats: { type: "string" },
  hold: { type: "string" },
  "keep-frames": { type: "boolean" },
  in: { type: "string" },
  json: { type: "boolean" },
  filter: { type: "string" },
  help: { type: "boolean", short: "h" },
};

function emit(config, text, json) {
  if (config?.json) process.stdout.write(`${JSON.stringify(json)}\n`);
  else process.stdout.write(`${text}\n`);
}

const money = (v) => (v == null ? "no price" : `$${v.toFixed(4)}`);

/** What an atlas holds and whether a trimmed one puts every frame back, in plain lines. */
function atlasLines(a) {
  const names = [a.image, a.json, a.godot, a.header].map((f) => path.basename(f)).join(", ");
  const lines = [`atlas ${a.width}x${a.height}: ${names}; CSS ${path.basename(a.css)} on ${path.basename(a.cells ?? a.image)}`];
  const t = a.trim;
  if (t) {
    const share = Math.round(Math.abs(t.fewerTexels) * 100);
    lines.push(
      t.fewerTexels >= 0
        ? `trimmed from the ${t.gridWidth}x${t.gridHeight} grid: ${share}% fewer texels, padding ${t.padding}${t.margin ? ", one clear texel kept round each frame for filtering" : ""}`
        : `trimmed, but ${share}% MORE texels than the ${t.gridWidth}x${t.gridHeight} grid: the frames fill their cells, so padding costs more than trimming saves; the grid is the better atlas here`,
      t.verdict === "exact"
        ? `every frame put back from the record matches its cell pixel for pixel${t.faint ? ` (${t.faint} pixels fainter than alpha ${t.alpha} were cut on purpose)` : ""}${t.empty.length ? `; ${t.empty.length} frames are empty` : ""}`
        : t.verdict === "lossy"
          ? `${t.lost} visible pixels (half opaque or more) were cut by --alpha ${t.alpha}; lower it`
          : `${t.moved} frames do not come back where they were: ${t.wrong.join("; ")}`,
    );
  }
  if (a.pivot) lines.push(`pivot (${a.pivot.x}, ${a.pivot.y}) in each ${a.frame.width}x${a.frame.height} cell; in Godot set the AnimatedSprite2D offset to (${a.pivot.godotOffset.x}, ${a.pivot.godotOffset.y}) to stand it on its node`);
  return lines;
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({ options: OPTIONS, allowPositionals: true, strict: true });
  } catch (err) {
    process.stderr.write(`onmodel: ${err.message}\n\n${HELP}`);
    process.exit(2);
  }
  const { values: flags, positionals } = parsed;
  const command = positionals[0];
  if (flags.help || !command) {
    process.stdout.write(HELP);
    process.exit(flags.help ? 0 : 2);
  }
  switch (command) {
    case "init": {
      const written = await init();
      process.stdout.write(written.length ? `wrote:\n${written.map((f) => `  ${f}`).join("\n")}\nFill in onmodel/brief.md (Product and Art direction at least), then: onmodel generate --subject "..."\n` : "nothing to write: the config, brief and decisions already exist\n");
      return;
    }
    case "models": {
      const config = await loadConfig(flags);
      const models = await listModels(flags.filter);
      const rows = models.map((m) => {
        const price = m.image ? resolveImagePrice(m.name, config.pricing) : resolveTextPrice(m.name, config.pricing);
        const cost = m.image ? (price?.perImage ? Object.entries(price.perImage).map(([s, v]) => `${s} $${v}`).join(", ") : "no price") : price ? `$${price.input}/M in, $${price.output}/M out` : "no price";
        return { ...m, cost };
      });
      emit(config, rows.map((m) => `${m.image ? "image " : "text  "} ${m.name.padEnd(36)} ${m.cost}`).join("\n"), { command: "models", models: rows });
      return;
    }
    case "generate": {
      const config = await loadConfig(flags);
      const result = await generate({ config, subject: flags.subject, name: flags.name, judge: !flags["no-judge"] });
      const lines = [
        `${result.name}: ${result.candidates.filter((c) => c.files?.image).length} of ${result.candidates.length} candidates painted into ${result.dir}`,
        result.pick ? `pick: candidate ${result.pick}${result.judgement?.reason ? ` (${result.judgement.reason})` : ""}` : result.judgement?.error ? `judge failed: ${result.judgement.error}` : "no pick",
        result.judgement?.edit ? `edit to try: ${result.judgement.edit}` : null,
        `cost ${money(result.estimatedCostUSD)}; open ${result.htmlPath}`,
      ].filter(Boolean);
      emit(config, lines.join("\n"), { command: "generate", ...result });
      return;
    }
    case "icons": {
      const config = await loadConfig({ ...flags, background: undefined });
      const result = await makeIcons({ config, name: flags.name ?? null, candidate: flags.candidate ?? null, markPath: flags.mark ?? null, background: flags.background ?? null });
      const counts = Object.entries(result.files.reduce((m, f) => ({ ...m, [f.platform]: (m[f.platform] ?? 0) + 1 }), {})).map(([p, n]) => `${p} ${n}`);
      const lines = [
        `${result.name} icons in ${result.dir}: ${counts.join(", ")} files, on ${result.background.hex}`,
        result.failures.length ? `${result.failures.length} checks failed:\n${result.failures.map((f) => `  ${f.file}: ${f.check}, ${f.detail}`).join("\n")}` : `every file passes its platform's rules (as of ${result.rulesAsOf})`,
        result.warnings.length ? `${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}:\n${result.warnings.map((w) => `  ${w.file}: ${w.check}, ${w.detail}`).join("\n")}` : null,
        `open ${result.htmlPath}`,
      ];
      emit(config, lines.join("\n"), { command: "icons", ...result });
      if (result.failures.length) process.exitCode = 2;
      return;
    }
    case "vector": {
      const config = await loadConfig(flags);
      if (flags.detail && !["low", "normal", "high"].includes(flags.detail)) throw new Error("--detail must be low, normal or high");
      let stroke = null;
      if (flags.stroke != null) {
        stroke = Number(flags.stroke);
        if (!Number.isFinite(stroke) || stroke <= 0 || stroke > 64) throw new Error("--stroke must be a width in pixels, between 0 and 64");
      }
      let tone = null;
      if (flags.tone != null) {
        tone = Number(flags.tone);
        if (!Number.isFinite(tone) || tone < 2 || tone > 256) throw new Error("--tone must be a number of colours, between 2 and 256");
      }
      let mono = null;
      if (flags.threshold != null) {
        const at = Number(flags.threshold);
        if (!Number.isFinite(at) || at < 0 || at > 255) throw new Error("--threshold must be a luminance from 0 to 255");
        mono = at;
      } else if (flags.mono) mono = true;
      if (flags.threshold != null && !flags.mono) throw new Error("--threshold is the luminance --mono cuts at, so pass --mono too");
      let noise = null;
      if (flags.noise != null) {
        noise = Number(flags.noise);
        if (!Number.isFinite(noise) || noise < 0 || noise > 1e6) throw new Error("--noise must be an area in pixels");
      }
      const result = await makeVector({ config, name: flags.name ?? null, candidate: flags.candidate ?? null, markPath: flags.mark ?? null, detail: flags.detail ?? null, stroke, tone, mono, noise });
      const f = result.facts ?? {};
      const lines = result.refused
        ? [`${result.name}: not traced. ${result.refused}`, `open ${result.htmlPath}`]
        : [
            `${result.name} vector in ${result.dir}: ${f.verdict} (${f.mode === "pixel" ? "pixel art, exact" : `${f.colours} colours, ${f.curves} curves`}${f.lines ? `, ${f.lines} centre line${f.lines === 1 ? "" : "s"} at ${f.hairline} px` : ""}, ${Math.max(1, Math.round(f.bytes / 1024))} KB)`,
            `silhouette ${f.silhouette}${f.silhouetteCeiling ? ` (about ${f.silhouetteCeiling} is the most a ${f.hairline} px line allows)` : ""}, ${Math.round(f.colourKept * 1000) / 10}% of pixels kept their colour, drift ${f.drift}`,
            ...(f.mono ? [`cut at luminance ${f.cuts.join(", ")}${f.mono > 1 ? ` for ${f.mono} levels` : ""}; anything lighter is not ink and was left out`] : []),
            ...(f.banding > 0.06 ? [`the shading came out in ${f.colours} flat bands and ${Math.round(f.banding * 100)}% of the art has a step the source does not; look at the render, not the difference map, which only shows pixels that changed a lot`] : []),
            ...(f.vsPNG != null ? [f.vsPNG > 1 ? `this SVG is ${f.vsPNG}x the size of the same pixels as a PNG, so keep the PNG unless you need a vector` : `${f.vsPNG}x the size of the same pixels as a PNG`] : []),
            `fills: ${result.tokens.map((t) => `--${t.name}`).join(", ")}`,
            `open ${result.htmlPath}`,
          ];
      emit(config, lines.join("\n"), { command: "vector", ...result });
      if (result.refused || f.verdict === "poor") process.exitCode = 2;
      return;
    }
    case "text": {
      const config = await loadConfig(flags);
      const num = (v, what, lo, hi) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`--${what} must be a number between ${lo} and ${hi}`);
        return n;
      };
      const result = await makeText({
        config,
        text: flags.string ?? null,
        fontPath: flags.font ?? null,
        name: flags.name ?? null,
        size: num(flags.px, "px", 4, 4096) ?? 128,
        tracking: num(flags.tracking, "tracking", -500, 2000) ?? 0,
        colour: flags.colour ?? flags.color ?? null,
        kerning: !flags["no-kerning"],
        variation: flags.variation != null ? parseVariation(flags.variation) : null,
        instance: flags.instance ?? null,
      });
      const f = result.facts;
      const lines = [
        `${result.name} text in ${result.dir}: ${f.verdict} ("${f.text}" set in ${f.font}${f.setting ? ` as ${f.setting}` : ""}, ${f.curves} curves, ${Math.max(1, Math.round(f.bytes / 1024))} KB)`,
        f.verdict === "exact"
          ? "the letters are the font's own outlines, so there is nothing to measure and nothing to drift"
          : `${[f.missing.length ? `not in the font: ${f.missing.join(" ")}` : null, f.blank.length ? `in the font but drawn empty: ${f.blank.join(" ")}` : null, f.inkShare ? null : "the path carries no ink at all"].filter(Boolean).join("; ")}`,
        `fill: --${result.tokens[0].name}`,
      ];
      emit(config, lines.join("\n"), { command: "text", ...result });
      if (f.verdict !== "exact") process.exitCode = 2;
      return;
    }
    case "lockup": {
      const config = await loadConfig(flags);
      const num = (v, what, lo, hi) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`--${what} must be a number between ${lo} and ${hi}`);
        return n;
      };
      const result = await makeLockup({
        config,
        text: flags.string ?? null,
        fontPath: flags.font ?? null,
        name: flags.name ?? null,
        candidate: flags.candidate ?? null,
        markPath: flags.mark ?? null,
        layout: flags.layout ?? "beside",
        px: num(flags.px, "px", 4, 4096) ?? 128,
        tracking: num(flags.tracking, "tracking", -500, 2000) ?? 0,
        gap: num(flags.gap, "gap", 0, 8) ?? 0.5,
        symbol: num(flags.symbol, "symbol", 0.1, 8) ?? 1.2,
        kerning: !flags["no-kerning"],
        variation: flags.variation != null ? parseVariation(flags.variation) : null,
        instance: flags.instance ?? null,
        detail: flags.detail ?? null,
      });
      const f = result.facts;
      const lines = [
        `${result.name} lockup in ${result.dir}: ${f.verdict} (${f.layout}, ${f.width}x${f.height}, ${f.curves} curves, ${Math.max(1, Math.round(f.bytes / 1024))} KB)`,
        `symbol ${f.symbol.width}x${f.symbol.height} from ${f.symbol.from} (${f.symbol.verdict}), "${f.word.text}" set in ${f.word.font}${f.word.setting ? ` as ${f.word.setting}` : ""} at ${f.word.px}, cap height ${f.word.capHeight}, gap ${f.gap}`,
        ...(f.word.missing.length ? [`not in the font: ${f.word.missing.join(" ")}`] : []),
        `fills: ${result.tokens.map((t) => `--${t.name}`).join(", ")}`,
      ];
      emit(config, lines.join("\n"), { command: "lockup", ...result });
      if (f.verdict === "incomplete" || f.verdict === "poor") process.exitCode = 2;
      return;
    }
    case "terrain": {
      const config = await loadConfig(flags);
      // Pixels only come whole: a --round of 2.5 indexed half a pixel, read nothing, and left
      // every cell empty, which the edge check then called perfect.
      const num = (v, what, lo, hi) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${what} must be a whole number between ${lo} and ${hi}`);
        return n;
      };
      const result = await makeTerrain({
        config,
        name: flags.name ?? null,
        candidate: flags.candidate ?? null,
        markPath: flags.mark ?? null,
        mode: flags.mode ?? "both",
        size: num(flags.cell, "cell", 4, 512),
        columns: num(flags.columns, "columns", 1, 32) ?? 8,
        margin: num(flags.margin, "margin", 1, 256),
        round: num(flags.round, "round", 0, 64),
        terrainName: flags.terrain ?? null,
      });
      const f = result.facts;
      const lines = [
        `${result.name} terrain in ${result.dir}: ${f.verdict} (${f.cells} of ${f.expected} cells at ${f.cellSize}px, ${f.width}x${f.height})`,
        f.fillFilter === "none"
          ? `the ${f.fillWidth}x${f.fillHeight} fill is one cell exactly, so each cell holds it as painted`
          : `the ${f.fillWidth}x${f.fillHeight} fill was scaled to one ${f.cellSize}px cell (${f.fillFilter}), so each cell holds all of it${f.fillWidth !== f.fillHeight ? ", stretched to square" : ""}`,
        `${f.pairsMatched} of the ${f.pairs} pairs of cells that can ever touch join exactly${f.missingCells ? `, and ${f.missingCells} shapes a map can ask for have no cell` : ""}`,
        f.seamless
          ? f.joins === 1
            ? "every neighbour a map could ever ask for fits, so the terrain paints without a seam"
            : "some neighbours do not fit, so the map will tear where they meet"
          : "sides-only has no bit for a corner, so where two cells disagree about what is above them the edge steps; use --mode both for seamless terrain",
        f.fillJoin > 1.5
          ? `the fill does not tile (its own join is ${f.fillJoin}x its grain), so the material will seam between cells: run onmodel tile --mark on it, then build from the file it writes (${config.out}/<name>/tile/<name>.png)`
          : `the fill tiles (join ${f.fillJoin}x its grain), so the material carries across cells`,
        ...(f.fillHoles ? [`the fill has ${f.fillHoles} see-through pixels; a terrain's material has to be solid, since the cell shapes are what make it transparent`] : []),
        ...(f.hollowCells || f.fullCellGaps ? [`${f.hollowCells} cells have no material at their centre and the full cell has ${f.fullCellGaps} empty pixels, so the set would paint holes`] : []),
        ...(f.misdrawnCells ? [`${f.misdrawnCells} cells draw a different shape from the bits they declare; a --margin this wide leaves each side a neck too thin to survive the rounding`] : []),
        `look at ${path.basename(result.files.map)}: the set laid into a patch of terrain, which is the only way to see it hold together`,
      ];
      emit(config, lines.join("\n"), { command: "terrain", ...result });
      if (f.verdict !== "complete") process.exitCode = 2;
      return;
    }
    case "shape": {
      const config = await loadConfig(flags);
      let points = 16;
      if (flags.points != null) {
        points = Number(flags.points);
        if (!Number.isInteger(points) || points < 3 || points > 256) throw new Error("--points must be a whole number from 3 to 256");
      }
      const result = await makeShape({ config, name: flags.name ?? null, candidate: flags.candidate ?? null, markPath: flags.mark ?? null, points });
      const f = result.facts;
      const lines = [
        `${result.name} shape in ${result.dir}: ${f.verdict} (${f.shapes} shape${f.shapes === 1 ? "" : "s"}, ${f.points} points from ${f.from})`,
        `it covers ${Math.round(f.covers * 100)}% of the art, misses ${Math.round(f.missed * 100)}%, and claims ${Math.round(f.extra * 100)}% that is empty`,
        f.verdict === "baggy"
          ? "it bulges into empty space, which makes things collide with nothing: raise --points"
          : f.verdict === "tight"
            ? "it cuts inside the art, which lets things pass through the sprite: raise --points"
            : "close enough to the art to use as a body",
        `look at ${path.basename(result.files.preview)}: the outline drawn over the art, which shows WHERE it is wrong`,
      ];
      emit(config, lines.join("\n"), { command: "shape", ...result });
      if (f.verdict !== "good") process.exitCode = 2;
      return;
    }
    case "normal": {
      const config = await loadConfig(flags);
      const num = (v, what, lo, hi) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`--${what} must be a number between ${lo} and ${hi}`);
        return n;
      };
      const result = await makeNormalMap({
        config,
        name: flags.name ?? null,
        candidate: flags.candidate ?? null,
        markPath: flags.mark ?? null,
        strength: num(flags.strength, "strength", 0.05, 10) ?? 1,
        blur: num(flags.blur, "blur", 0, 32) ?? 1,
        wrap: Boolean(flags.wrap),
        invertY: Boolean(flags["invert-y"]),
      });
      const f = result.facts;
      const lines = [
        `${result.name} normal map in ${result.dir}: ${f.verdict} (${f.width}x${f.height}, green ${f.green})`,
        f.verdict === "flat"
          ? "the art has almost no light and shade in it, so the map is nearly featureless and a Light2D will do nothing with it"
          : f.verdict === "seams"
            ? `the map does not tile (join ${f.join}x the grain), so the lighting will show a grid even though the colour does not`
            : `the encoding is faithful to ${f.gradientError} on average${f.join ? `, and it tiles (join ${f.join}x the grain)` : ""}`,
        `the height came from luminance, because a painted sprite has no geometry: dark paint becomes a dent, and ${Math.round(f.grainShare * 100)}% of this art's variation was finer than the blur`,
        `look at ${path.basename(result.files.lit)}: the art lit from four corners, which is the only way to see that bumps read as bumps`,
      ];
      emit(config, lines.join("\n"), { command: "normal", ...result });
      if (f.verdict !== "derived") process.exitCode = 2;
      return;
    }
    case "tile": {
      const config = await loadConfig(flags);
      const num = (v, what, lo, hi) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isFinite(n) || n < lo || n > hi) throw new Error(`--${what} must be a number between ${lo} and ${hi}`);
        return n;
      };
      const result = await makeTileset({
        config,
        name: flags.name ?? null,
        candidate: flags.candidate ?? null,
        markPath: flags.mark ?? null,
        band: num(flags.band, "band", 1, 512),
        grid: num(flags.grid, "grid", 2, 8) ?? 3,
        fix: !flags["no-fix"],
        normal: Boolean(flags.normal),
        collision: Boolean(flags.collision),
        strength: num(flags.strength, "strength", 0.05, 10) ?? 1,
        blur: num(flags.blur, "blur", 0, 32) ?? 1,
      });
      const f = result.facts;
      const said = {
        seamless: "it already tiles: the join is no sharper than the texture's own grain",
        fixed: `the join was ${f.ratioBefore}x the texture's own grain and is closed; ${Math.round(f.moved * 100)}% of pixels moved, by ${f.mean} on average`,
        forced: `the join was ${f.ratioBefore}x the texture's own grain. It is closed, but the correction was heavy (${f.mean} on average), so it will show: paint this one again rather than rely on the fix`,
        seams: `the join is ${f.ratioBefore}x the texture's own grain and was left alone, so it will seam`,
      }[f.verdict];
      const lines = [
        `${result.name} tile in ${result.dir}: ${f.verdict} (${f.width}x${f.height})`,
        said,
        ...(f.transparent > 0.02 ? [`${Math.round(f.transparent * 100)}% of this is see-through, so it is a decal rather than a floor; the join is measured on colour alone and a hole in the art is not a seam`] : []),
        ...(f.normal ? [`a normal map was derived too, joining at ${f.normal.join}x the grain, with a Godot CanvasTexture binding it to the colour`] : []),
        ...(f.collision ? [`a collision body of ${f.collision.points} points is in the TileSet, on a physics and an occlusion layer, fitting the tile to ${f.collision.fit}`] : []),
        `look at ${path.basename(result.files.tiled)}: the tile laid ${f.grid} by ${f.grid}, which is the only way to really see it`,
      ];
      emit(config, lines.join("\n"), { command: "tile", ...result });
      if (f.verdict === "forced" || f.verdict === "seams") process.exitCode = 2;
      return;
    }
    case "store": {
      const config = await loadConfig(flags);
      const result = await makeStore({
        config,
        subject: flags.subject ?? null,
        name: flags.name ?? null,
        targets: flags.targets ? flags.targets.split(",").map((s) => s.trim()).filter(Boolean) : null,
        markPath: flags.mark ?? null,
        count: flags.count ? Number(flags.count) : undefined,
        judge: !flags["no-judge"],
      });
      const lines = [
        `${result.name} store graphics in ${result.dir}: ${result.targets.join(", ")}${result.pick ? `, pick candidate ${result.pick}` : ""}`,
        result.failures.length ? `${result.failures.length} checks failed:\n${result.failures.map((f) => `  ${f.candidate ? `#${f.candidate} ` : ""}${f.target}: ${f.check}, ${f.detail}`).join("\n")}` : `every graphic meets its target's size and format (as of ${result.rulesAsOf})`,
        `cost ${money(result.estimatedCostUSD)}; open ${result.htmlPath}`,
      ];
      emit(config, lines.join("\n"), { command: "store", ...result });
      if (result.failures.length) process.exitCode = 2;
      return;
    }
    case "edit": {
      const config = await loadConfig(flags);
      const sheetDir = flags.sheet && flags.name ? path.join(config.out, slug(flags.name), "sheet") : null;
      const result = await editCandidate({ config, name: flags.name, dir: flags.in ?? sheetDir, candidate: flags.candidate ?? null, change: flags.change, judge: !flags["no-judge"] });
      const lines = [
        result.files.image ? `${result.id} from ${result.parent}: ${result.files.image}` : `${result.id} from ${result.parent}: not painted (${result.blocked})`,
        result.facts?.edit ? `changed ${Math.round(result.facts.edit.changed * 100)}% of the pixels, silhouette kept ${result.facts.edit.silhouette}` : null,
        result.views ? `sheet: ${result.sheet.found} views found (${result.sheet.method}), height spread ${result.sheet.heightSpread}, colour spread ${result.sheet.colourSpread}; hold the sprites to it with: onmodel sprites --name ${flags.name ?? "<name>"} --pick ${result.id}` : null,
        result.judgement && !result.judgement.error ? `judge: ${result.judgement.verdict}, change made ${result.judgement.applied}, rest kept ${result.judgement.preserved}${result.judgement.problems?.length ? `; ${result.judgement.problems.join("; ")}` : ""}` : null,
        `cost ${money(result.estimatedCostUSD)}; open ${result.htmlPath}`,
        result.files.image ? `edit it again with --candidate ${result.id}` : null,
      ].filter(Boolean);
      emit(config, lines.join("\n"), { command: "edit", ...result });
      return;
    }
    case "motion": {
      // --size is the raster size here, in pixels, not a Gemini size such as 1K.
      const config = await loadConfig({ ...flags, size: undefined });
      const num = (v, what, lo, hi) => {
        if (v == null) return null;
        const n = Number(v);
        if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`--${what} must be a whole number between ${lo} and ${hi}`);
        return n;
      };
      const formats = flags.formats ? flags.formats.split(",").map((s) => s.trim()).filter(Boolean) : null;
      if (formats && !formats.length) throw new Error(`--formats takes a list from ${MOTION_FORMATS.join(", ")}`);
      const result = await makeMotion({ config, specPath: flags.spec ?? null, name: flags.name ?? null, size: num(flags.size, "size", 16, 4096), formats, hold: num(flags.hold, "hold", 0, 10000) ?? 0, keepFrames: Boolean(flags["keep-frames"]) });
      const f = result.facts;
      const rb = f.readback ?? {};
      const read = Object.entries(rb).map(([k, d]) => `${k} ${d.max === 0 ? "exact" : `within ${d.max} levels over ${(d.share * 100).toFixed(2)}%`}`);
      const lines = [
        `${result.name} motion in ${result.dir}: ${f.verdict} (${Math.round(f.duration)} ms at ${f.fps} fps, ${f.paths} paths in ${f.layers} layers, ${f.animations} animations, ${f.width}x${f.height})`,
        ...(read.length ? [`read back the way each player reads it: ${read.join("; ")}`] : []),
        f.settles.skipped ? "the end is not held to the artwork (endsOn is not artwork)" : f.settles.ok ? "it ends on the artwork: every layer back at rest, and the last frame the artwork drawn still" : `it does not end on the artwork: ${f.settles.off.join("; ") || `the last frame differs by ${f.settles.max} levels`}`,
        ...(f.android ? [f.android.problems.length ? `Android: not written; ${f.android.problems.join("; ")}` : `Android: ${path.basename(result.files.android)}${f.android.splash ? ", a splash icon (108dp, under 1000 ms)" : ""}, ${Math.max(1, Math.round(f.android.bytes / 1024))} KB`] : []),
        ...(result.files.lottie ? [`Lottie: ${path.basename(result.files.lottie)}, ${Math.max(1, Math.round(f.lottieBytes / 1024))} KB; SVG: ${path.basename(result.files.svg ?? "")}${f.svgBytes ? `, ${Math.max(1, Math.round(f.svgBytes / 1024))} KB` : ""}`] : []),
        ...(f.gif ? [`GIF ${f.gif.frames} frames at 50 fps, ${Math.max(1, Math.round(f.gif.bytes / 1024))} KB${f.apng ? `; APNG ${Math.max(1, Math.round(f.apng.bytes / 1024))} KB` : ""}`] : []),
        ...(f.mp4 ? [f.mp4.skipped ? `MP4: ${f.mp4.skipped}` : `MP4 ${f.mp4.width}x${f.mp4.height}, ${f.mp4.frames} frames at ${f.mp4.rate}, ${Math.max(1, Math.round(f.mp4.bytes / 1024))} KB (ffmpeg ${f.mp4.ffmpeg})`] : []),
        ...(f.failures.length ? [`${f.failures.length} problem${f.failures.length === 1 ? "" : "s"}:\n${f.failures.map((x) => `  ${x}`).join("\n")}`] : []),
        `open ${path.join(result.dir, "motion.html")}`,
      ];
      emit(config, lines.join("\n"), { command: "motion", ...result });
      if (f.verdict !== "good") process.exitCode = 2;
      return;
    }
    case "sheet": {
      const config = await loadConfig(flags);
      const result = await makeSheet({ config, subject: flags.subject, name: flags.name, count: flags.count ? Number(flags.count) : undefined, judge: !flags["no-judge"] });
      const picked = result.sheet.pick;
      const lines = [
        `${result.name} model sheet: ${result.sheet.candidates.length} of ${result.candidates.length} candidates sliced into views in ${result.dir}`,
        picked ? `using candidate ${picked} (picked by the ${result.sheet.pickedBy}); views ${Object.values(result.sheet.views).join(", ")}` : "no candidate could be sliced into three views; run again",
        `cost ${money(result.estimatedCostUSD)}; open ${result.htmlPath}`,
        picked ? `next: onmodel sprites --name ${result.name} --actions "..."` : null,
      ].filter(Boolean);
      emit(config, lines.join("\n"), { command: "sheet", ...result });
      return;
    }
    case "sprites": {
      const config = await loadConfig(flags);
      // --normal turns the sheet's lighting on for this run without editing the config.
      if (flags.normal) config.sprite = { ...config.sprite, normal: true };
      const result = await makeSprites({ config, name: flags.name, subject: flags.subject ?? null, judge: !flags["no-judge"], useSheet: !flags["no-sheet"], sheetPick: flags.pick ?? null });
      const lines = result.actions.map((a) =>
        a.error
          ? `  ${a.name}: ${a.error}`
          : `  ${a.name}: ${a.frames} frames from ${a.parts > 1 ? `${a.parts} strips (${a.attempts.length} painted)` : `strip ${a.best} of ${a.attempts.length}`}${a.fixes.length ? `, ${a.fixes.filter((x) => x.accepted).length}/${a.fixes.length} repaints kept` : ""}, still flagged ${JSON.stringify((a.final?.flagged ?? []).map((i) => i + 1))}${a.judgement?.verdict ? `, judge says ${a.judgement.verdict}` : ""}`,
      );
      const out = [`${result.name} sprites in ${result.dir}`, ...lines];
      if (result.atlas) out.push(...atlasLines(result.atlas));
      if (result.stopped) out.push(`stopped early: ${result.stopped}`);
      out.push(`cost ${money(result.estimatedCostUSD)}; open ${result.htmlPath}`);
      emit(config, out.join("\n"), { command: "sprites", ...result });
      if (result.atlas?.trim && result.atlas.trim.verdict !== "exact") process.exitCode = 2;
      return;
    }
    case "bitmapfont": {
      const config = await loadConfig(flags);
      const px = flags.px == null ? 16 : Number(flags.px);
      if (!(Number.isInteger(px) && px >= 4 && px <= 256)) throw new Error("--px must be a whole number of pixels from 4 to 256");
      const cover = flags.cover == null ? 50 : Number(flags.cover);
      if (!(Number.isInteger(cover) && cover >= 1 && cover <= 99)) throw new Error("--cover must be a whole percentage from 1 to 99");
      if (flags.cover != null && !flags.mono) throw new Error("--cover sets where a crisp pixel starts, so it needs --mono");
      const result = await makeBitmapFont({
        config,
        fontPath: flags.font ?? null,
        px,
        chars: flags.chars ?? null,
        mono: Boolean(flags.mono),
        cover,
        kerning: !flags["no-kerning"],
        variation: flags.variation != null ? parseVariation(flags.variation) : null,
        instance: flags.instance ?? null,
        name: flags.name ?? null,
      });
      const f = result.facts;
      const lines = [
        `${result.name} bitmap font in ${result.dir}: ${f.verdict} (${f.written} of ${f.requested} characters at ${f.px}px${f.setting ? `, ${f.setting}` : ""}${f.mono ? `, crisp at ${f.cover}% cover` : ""}, ${f.pageWidth}x${f.pageHeight} page)`,
        `line height ${f.lineHeight}, baseline ${f.base} down; ${f.kernings} kerning pairs${f.kerning === "off" ? " (kerning off)" : f.kerning ? ` from the font's ${f.kerning}` : ", the font has none"}`,
        f.previewDiffers ? `text set from the files on disk differs from the glyphs as built in ${f.previewDiffers} pixels, so a metric was written wrong` : `text set from the .fnt and page read back matches the glyphs as built, pixel for pixel`,
        ...(f.missing.length ? [`the font has no ${f.missing.map((c) => JSON.stringify(c)).join(" ")}; they are left out, not drawn with something else`] : []),
        ...(f.blank.length ? [`${f.blank.map((c) => JSON.stringify(c)).join(" ")} draw nothing at this size`] : []),
        ...(f.lost.length ? [`cutting to crisp pixels lost part of ${f.lost.map((c) => JSON.stringify(c)).join(" ")}; a lower --cover keeps thinner strokes, a bigger --px keeps them all`] : []),
        ...(f.broken.length ? [`strokes broke into pieces in ${f.broken.map((c) => JSON.stringify(c)).join(" ")}; usual for thin diagonals this small, and worth a look`] : []),
        ...(f.syntheticSpace ? ["the font has no space; a quarter of an em was used"] : []),
        `Godot imports ${path.basename(result.files.fnt)} as a FontFile: set the font size to ${f.px}${f.mono ? ` (or ${f.px * 2}, ${f.px * 3}: a crisp font scales by whole steps, and under half its size it draws nothing)` : ""}; look at ${path.basename(result.files.preview)}`,
      ];
      emit(config, lines.join("\n"), { command: "bitmapfont", ...result });
      if (f.verdict !== "complete") process.exitCode = 2;
      return;
    }
    case "ninepatch": {
      const config = await loadConfig(flags);
      // Sides come left, top, right, bottom, which is Godot's order; one value is all four.
      const sides = (v, what) => {
        if (v == null) return null;
        const n = String(v).split(/[ ,]+/).filter(Boolean).map(Number);
        const four = n.length === 1 ? [n[0], n[0], n[0], n[0]] : n;
        if (four.length !== 4 || !four.every((x) => Number.isInteger(x) && x >= 0)) throw new Error(`--${what} must be one whole number, or four (left,top,right,bottom)`);
        return four;
      };
      let scale = null;
      if (flags.scale != null) {
        scale = Number(flags.scale);
        if (!(scale >= 0.05 && scale <= 1)) throw new Error("--scale must be a share from 0.05 to 1");
      }
      const result = await makeNinePatch({ config, name: flags.name ?? null, candidate: flags.candidate ?? null, markPath: flags.mark ?? null, insets: sides(flags.insets, "insets"), content: sides(flags.content, "content"), scale });
      const f = result.facts;
      const axis = (a, way) => (a.stretches ? (a.failing ? `${a.failing} of the ${a.lines} lines it stretches ${way} are not alike, so they will smear` : `stretches ${way} over ${a.lines} alike lines`) : `does not stretch ${way}: ${a.split ? "something in the middle splits the plain band" : "no band of alike lines holds the middle"}, so keep its size ${way} fixed; at its own size it draws exactly as painted`);
      const lines = [
        `${result.name} nine-patch in ${result.dir}: ${f.verdict} (${f.width}x${f.height}${f.scale !== 1 ? `, scaled from ${f.sourceWidth}x${f.sourceHeight}` : ""}${f.fromAndroid ? ", read from the .9.png's own marks" : ""})`,
        `insets left ${f.insets.left}, top ${f.insets.top}, right ${f.insets.right}, bottom ${f.insets.bottom}${f.given ? " (given)" : ""}; content ${f.content.left},${f.content.top},${f.content.right},${f.content.bottom}`,
        `${axis(f.across, "across")}; ${axis(f.down, "down")}`,
        ...(f.lopsided ? ["the insets are lopsided; if the art is symmetric, a shadow or highlight on one side is probably why"] : []),
        ...(f.bigCorners ? ["corners over 64px are big for UI; --scale shrinks the art before measuring"] : []),
        `Godot: ${path.basename(result.files.stylebox)} as a StyleBox, or a NinePatchRect with patch margins ${f.insets.left},${f.insets.top},${f.insets.right},${f.insets.bottom}`,
        `Android: copy only ${path.basename(result.files.android)} into res/drawable-*/ (never resized); web: ${path.basename(result.files.css)}; look at ${path.basename(result.files.preview)}`,
      ];
      emit(config, lines.join("\n"), { command: "ninepatch", ...result });
      if (f.verdict === "smears") process.exitCode = 2;
      return;
    }
    case "atlas": {
      const config = await loadConfig(flags);
      if (flags.normal) config.sprite = { ...config.sprite, normal: true };
      const result = await makeAtlas({ config, name: flags.name });
      const out = [`${result.name} atlas in ${result.dir}, packed from ${path.basename(result.from)}`, ...atlasLines(result.atlas)];
      if (result.framesEdited) out.push(`${result.framesEdited} of ${result.framesCompared} frame files differ from the atlas, so one or the other was edited after the run; this was packed from the atlas, which is what ships, so an edit made only to a frame file is not in it`);
      emit(config, out.join("\n"), { command: "atlas", ...result });
      if (result.atlas.trim && result.atlas.trim.verdict !== "exact") process.exitCode = 2;
      return;
    }
    case "check": {
      const config = await loadConfig(flags);
      const dirs = flags.in ? [flags.in] : flags.name ? [path.join(config.out, slug(flags.name))] : await findRuns(config.out);
      const runs = [];
      for (const dir of dirs) runs.push(...(await checkRun({ dir })));
      // A gate that checked nothing has not passed: a mistyped name, a wrong --out or a
      // folder with no summary must fail the build, not wave it through.
      if (!runs.length) {
        emit(config, `nothing to check: no onmodel summary found in ${dirs.length ? dirs.join(", ") : config.out}`, { command: "check", runs: [], failures: [], checked: 0 });
        process.exitCode = 2;
        return;
      }
      const failures = failuresOf(runs);
      const lines = runs.map((r) => {
        const fails = r.files.flatMap((f) => f.checks.filter((c) => !c.ok && !c.warn).map((c) => `${f.rel} (${c.check}: ${c.detail})`));
        return `  ${r.kind} ${r.name}: ${r.files.length} files${fails.length ? `, ${fails.length} failed:\n    ${fails.join("\n    ")}` : " all pass"}`;
      });
      const out = [`checked ${runs.length} output set${runs.length === 1 ? "" : "s"} across ${dirs.length} run${dirs.length === 1 ? "" : "s"}`, ...lines, failures.length ? `${failures.length} checks failed` : "everything on disk still meets its rules"];
      emit(config, out.join("\n"), { command: "check", runs, failures });
      if (failures.length) process.exitCode = 2;
      return;
    }
    case "price": {
      const config = await loadConfig(flags);
      const plan = estimatePlan(config, {
        subjects: flags.subjects ? Number(flags.subjects) : 0,
        count: flags.count ? Number(flags.count) : null,
        size: flags.size ?? null,
        sprites: flags.sprites ? parseActions(flags.sprites) : [],
        store: Boolean(flags.store),
        judge: !flags["no-judge"],
      });
      const fmt = (v) => (v == null ? "no price" : `$${v.toFixed(4)}`);
      const lines = [`estimate on ${plan.model}${plan.judge ? ` + ${plan.judge}` : ""} at ${plan.size}:`];
      for (const it of plan.items) {
        const range = it.worst != null && it.worst !== it.best ? `${fmt(it.best)} to ${fmt(it.worst)}` : fmt(it.best);
        const calls = it.judgeCallsWorst && it.judgeCallsWorst !== it.judgeCalls ? `${it.judgeCalls} to ${it.judgeCallsWorst}` : `${it.judgeCalls}`;
        lines.push(`  ${it.label}: ${it.detail}`, `    ${it.images}${it.imagesWorst ? ` to ${it.imagesWorst}` : ""} images${it.judgeCalls ? ` + ${calls} judge calls` : ""} = ${range}`);
      }
      lines.push(plan.best == null ? "total: no price" : plan.best === plan.worst ? `total about ${fmt(plan.best)}` : `total ${fmt(plan.best)} to ${fmt(plan.worst)}`);
      for (const m of plan.missing) lines.push(`no price: ${m}`);
      lines.push(`free (no API): ${plan.free.join(", ")}`);
      for (const a of plan.assumptions) lines.push(`note: ${a}`);
      emit(config, lines.join("\n"), { command: "price", ...plan });
      return;
    }
    case "cost": {
      const config = await loadConfig(flags);
      const file = path.join(config.out, config.ledger);
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch {
        emit(config, `no ledger yet at ${file}`, { command: "cost", runs: [] });
        return;
      }
      const runs = new Map();
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let e;
        try {
          e = JSON.parse(line);
        } catch {
          continue;
        }
        const r = runs.get(e.run) ?? { run: e.run, calls: 0, images: 0, judge: 0, costUSD: 0, unknown: false, first: e.ts, last: e.ts };
        r.calls += 1;
        if (String(e.op).startsWith("judge:")) r.judge += 1;
        else if (e.ok) r.images += 1;
        if (e.costUSD == null) r.unknown = true;
        else r.costUSD += e.costUSD;
        if (e.ts < r.first) r.first = e.ts;
        if (e.ts > r.last) r.last = e.ts;
        runs.set(e.run, r);
      }
      const list = [...runs.values()].sort((a, b) => a.first.localeCompare(b.first));
      const total = list.reduce((t, r) => t + r.costUSD, 0);
      emit(
        config,
        [...list.map((r) => `${String(r.first).slice(0, 16).replace("T", " ")}  ${r.run.padEnd(24).slice(0, 24)}  ${String(r.images).padStart(3)} images  ${String(r.judge).padStart(2)} judge  ${money(r.unknown ? null : r.costUSD)}`), "", `total ${money(total)} over ${list.length} run${list.length === 1 ? "" : "s"}`].join("\n"),
        { command: "cost", runs: list, totalUSD: total },
      );
      return;
    }
    default:
      process.stderr.write(`onmodel: unknown command ${command}\n\n${HELP}`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`onmodel: ${err.message}\n`);
  process.exit(1);
});
