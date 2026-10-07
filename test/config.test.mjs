import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEFAULTS, merge, validate, envOverrides, flagOverrides, loadConfig, init, normalizeHex } from "../src/config.mjs";

test("the defaults validate as they are, and a copy can be changed without touching them", () => {
  const cfg = validate(merge(DEFAULTS, {}));
  assert.equal(cfg.model, "gemini-nano-banana-2.1");
  assert.equal(cfg.background, "auto");
  assert.equal(cfg.budgetUSD, 2);
  cfg.palette.push("#000000");
  assert.deepEqual(DEFAULTS.palette, [], "validate works on a copy");
});

test("validation names the first problem in plain words and normalises colours", () => {
  const bad = (over, re) => assert.throws(() => validate(merge(DEFAULTS, over)), re);
  bad({ size: "3K" }, /size must be one of/);
  bad({ aspectRatio: "7:3" }, /aspectRatio must be one of/);
  bad({ candidates: 0 }, /candidates must be a whole number from 1 to 8/);
  bad({ candidates: 2.5 }, /candidates/);
  bad({ background: "purple-ish" }, /background must be/);
  bad({ key: { tolerance: 0, despill: true } }, /key.tolerance/);
  bad({ key: { tolerance: 20, despill: "yes" } }, /key.despill/);
  bad({ budgetUSD: -1 }, /budgetUSD/);
  bad({ thinking: { level: "max" } }, /thinking.level/);
  bad({ palette: ["#12345"] }, /palette colour "#12345" is not a colour/);
  bad({ references: [""] }, /references must be a list/);
  bad({ brief: "" }, /brief must be the path/);

  const cfg = validate(merge(DEFAULTS, { palette: ["#ABC", "rgb(106, 27, 90)"], background: "#FF00FF", budgetUSD: null }));
  assert.deepEqual(cfg.palette, ["#aabbcc", "#6a1b5a"]);
  assert.equal(cfg.background, "#ff00ff");
  assert.equal(cfg.budgetUSD, null, "null means no cap");
  assert.equal(normalizeHex("not a colour"), null);
});

test("environment and flags override in that order, and lists split on commas", () => {
  assert.deepEqual(envOverrides({ GEMINI_MODEL: "gemini-3.1-flash-image", ONMODEL_BUDGET: "0.5", ONMODEL_THINKING: "low", ONMODEL_OUT: "art" }), {
    model: "gemini-3.1-flash-image",
    budgetUSD: 0.5,
    thinking: { level: "low" },
    out: "art",
  });
  const flags = flagOverrides({ references: "logo.svg, sheet.png", palette: "#fff,#000", background: "none", candidates: "4", aspect: "16:9", budget: "1" });
  assert.deepEqual(flags.references, ["logo.svg", "sheet.png"]);
  assert.deepEqual(flags.palette, ["#fff", "#000"]);
  assert.equal(flags.background, null, '"none" keeps the model\'s own background');
  assert.equal(flags.candidates, 4);
  assert.equal(flags.aspectRatio, "16:9");
  assert.equal(flags.budgetUSD, 1);
  const merged = validate(merge(merge(merge(DEFAULTS, { model: "a-file-model", size: "2K" }), envOverrides({ GEMINI_MODEL: "env-model" })), flagOverrides({ model: "flag-model" })));
  assert.equal(merged.model, "flag-model", "a flag beats the environment, which beats the file");
  assert.equal(merged.size, "2K", "the file's other values stay");
});

test("loadConfig reads the file and the brief, and takes the palette from the brief when the config names none", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-cfg-"));
  const brief = path.join(dir, "brief.md");
  await writeFile(brief, "# Art brief\n\n## Product\nA maze game for Android where a round creature eats dots and runs from ghosts; these are its sprites.\n\n## Art direction\nChunky flat shapes with a two pixel black outline, no gradients, one light from the top left.\n\n## Palette\nPlayer #F5C400, enemy #E63946, maze #1D1A1E.\n");
  const configPath = path.join(dir, "onmodel.config.json");
  await writeFile(configPath, JSON.stringify({ brief, candidates: 2 }));
  const cfg = await loadConfig({ config: configPath }, {});
  assert.equal(cfg.candidates, 2);
  assert.match(cfg.briefText, /round creature/);
  assert.deepEqual(cfg.palette, ["#f5c400", "#e63946", "#1d1a1e"], "the brief's palette fills an empty config palette");

  await writeFile(configPath, JSON.stringify({ brief, palette: ["#111111"] }));
  const explicit = await loadConfig({ config: configPath }, {});
  assert.deepEqual(explicit.palette, ["#111111"], "a configured palette wins over the brief");

  await assert.rejects(() => loadConfig({ config: path.join(dir, "missing.json") }, {}), /could not read/);
  const noFile = await loadConfig({}, {});
  assert.equal(noFile.model, DEFAULTS.model, "no config file in the working directory is fine");
});

test("init writes the config, brief and decisions once and leaves existing files alone", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-init-"));
  const first = await init({ cwd: dir });
  assert.equal(first.length, 3);
  for (const f of first) await access(f);
  const starter = JSON.parse(await readFile(path.join(dir, "onmodel.config.json"), "utf8"));
  assert.equal(starter.model, DEFAULTS.model);
  assert.ok(!("json" in starter), "a run-time flag is not written to the file");
  assert.match(await readFile(path.join(dir, "onmodel", "brief.md"), "utf8"), /## Art direction/);
  await writeFile(path.join(dir, "onmodel", "brief.md"), "mine");
  const second = await init({ cwd: dir });
  assert.deepEqual(second, []);
  assert.equal(await readFile(path.join(dir, "onmodel", "brief.md"), "utf8"), "mine");
});
