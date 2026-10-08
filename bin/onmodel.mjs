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
           [--candidate 2|2e1] [--in dir] [--no-judge]    judge it: was the change made, was the rest kept
  icons --name x [--candidate 2]    every icon Android, iOS, the web and Expo ask for, from one mark, checked
        or --mark logo.png          against a dated rulebook, with mask previews  [--background #hex] (free)
  store --name x [--subject "..."]  an on-brand hero painted, judged, then cropped to each store's exact
        [--targets play-feature,og,github] [--mark logo.png]    canvas as a 24-bit PNG (no alpha)
        [--count 3] [--size 2K] [--budget 2] [--no-judge]
  sheet --subject "..." --name x    the model sheet: front, side and back views every frame is held to
           [--count 3] [--no-judge]
  sprites --name x                  paint each action as a strip, measure it against the sheet, repair
           [--actions "walk:6:a steady walk;jump:5"] [--frame 32] [--subject "..."]
           [--pick 2] [--no-sheet] [--no-judge] [--budget 2]
                                    then pack the atlas with JSON, CSS and C exports and APNG/GIF previews
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
  change: { type: "string" },
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
      const result = await editCandidate({ config, name: flags.name, dir: flags.in ?? null, candidate: flags.candidate ?? null, change: flags.change, judge: !flags["no-judge"] });
      const lines = [
        result.files.image ? `${result.id} from ${result.parent}: ${result.files.image}` : `${result.id} from ${result.parent}: not painted (${result.blocked})`,
        result.facts?.edit ? `changed ${Math.round(result.facts.edit.changed * 100)}% of the pixels, silhouette kept ${result.facts.edit.silhouette}` : null,
        result.judgement && !result.judgement.error ? `judge: ${result.judgement.verdict}, change made ${result.judgement.applied}, rest kept ${result.judgement.preserved}${result.judgement.problems?.length ? `; ${result.judgement.problems.join("; ")}` : ""}` : null,
        `cost ${money(result.estimatedCostUSD)}; open ${result.htmlPath}`,
        result.files.image ? `edit it again with --candidate ${result.id}` : null,
      ].filter(Boolean);
      emit(config, lines.join("\n"), { command: "edit", ...result });
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
      const result = await makeSprites({ config, name: flags.name, subject: flags.subject ?? null, judge: !flags["no-judge"], useSheet: !flags["no-sheet"], sheetPick: flags.pick ? Number(flags.pick) : null });
      const lines = result.actions.map((a) =>
        a.error
          ? `  ${a.name}: ${a.error}`
          : `  ${a.name}: ${a.frames} frames from ${a.parts > 1 ? `${a.parts} strips (${a.attempts.length} painted)` : `strip ${a.best} of ${a.attempts.length}`}${a.fixes.length ? `, ${a.fixes.filter((x) => x.accepted).length}/${a.fixes.length} repaints kept` : ""}, still flagged ${JSON.stringify((a.final?.flagged ?? []).map((i) => i + 1))}${a.judgement?.verdict ? `, judge says ${a.judgement.verdict}` : ""}`,
      );
      const out = [`${result.name} sprites in ${result.dir}`, ...lines];
      if (result.atlas) out.push(`atlas ${result.atlas.width}x${result.atlas.height}: ${[result.atlas.image, result.atlas.json, result.atlas.css, result.atlas.header].map((f) => path.basename(f)).join(", ")}`);
      if (result.stopped) out.push(`stopped early: ${result.stopped}`);
      out.push(`cost ${money(result.estimatedCostUSD)}; open ${result.htmlPath}`);
      emit(config, out.join("\n"), { command: "sprites", ...result });
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
