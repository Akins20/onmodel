import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { checkRun, findRuns, failuresOf, recheckFile } from "../src/check.mjs";
import { encodePNG, encodePNG24 } from "../src/png.mjs";

/**
 * The no-API gate against run directories laid out as the tool writes them: a run
 * folder with store/, icons/ and sprites/ subfolders. A run whose files still match
 * their recorded rules passes; one whose files were resized, given an alpha channel
 * or deleted fails on exactly those checks; files are found under the run folder,
 * not at the path recorded when they were made; and a gate that found nothing fails.
 */

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "onmodel.mjs");

function solid(width, height, [r, g, b, a] = [40, 60, 90, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, a], i * 4);
  return { width, height, data };
}

/** A run folder with a store/ subfolder holding store.json and the given target files. */
async function storeRun(targets) {
  const run = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  const dir = path.join(run, "store");
  await mkdir(dir, { recursive: true });
  const recorded = [];
  for (const t of targets) {
    if (t.buffer) await writeFile(path.join(dir, t.rel), t.buffer);
    recorded.push({ key: t.key, width: t.width ?? 120, height: t.height ?? 63, rel: t.rel, file: t.recorded ?? path.join(dir, t.rel) });
  }
  await writeFile(path.join(dir, "store.json"), JSON.stringify({ tool: "onmodel", kind: "store", name: "demo", dir, candidates: [{ index: 1, files: { targets: recorded } }] }));
  return run;
}

test("a store run found in its store/ subfolder, whose files still match their rules, passes", async () => {
  const run = await storeRun([{ key: "og", rel: "01.og.png", buffer: encodePNG24(solid(120, 63)) }]);
  const results = await checkRun({ dir: run });
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "store");
  assert.equal(failuresOf(results).length, 0, "nothing should fail");
  const checks = results[0].files[0].checks.map((c) => c.check);
  assert.ok(checks.includes("opaque") && checks.includes("no alpha channel"));
});

test("a resized, transparent, alpha-channel or missing file fails on exactly that check", async () => {
  const run = await storeRun([
    { key: "og", rel: "01.og.png", buffer: encodePNG24(solid(100, 50)) }, // recorded 120x63
    { key: "github", rel: "01.github.png", buffer: encodePNG(solid(120, 63, [40, 60, 90, 120])) }, // translucent
    { key: "play-feature", rel: "01.play-feature.png", buffer: encodePNG(solid(120, 63)) }, // opaque but RGBA
    { key: "og", rel: "02.og.png" }, // never written
  ]);
  const fails = failuresOf(await checkRun({ dir: run }));
  const on = (file) => fails.filter((f) => f.file === file).map((f) => f.check);
  assert.deepEqual(on("01.og.png"), ["size"]);
  assert.ok(on("01.github.png").includes("opaque"));
  assert.deepEqual(on("01.play-feature.png"), ["no alpha channel"], "an opaque RGBA file still has an alpha channel");
  assert.deepEqual(on("02.og.png"), ["present"]);
});

test("files are found under the run folder, not at the path recorded when they were made", async () => {
  // recorded on another machine: an absolute Windows path that does not exist here
  const run = await storeRun([{ key: "og", rel: undefined, recorded: "C:\\Users\\someone\\onmodel-out\\demo\\store\\01.og.png", buffer: null }]);
  await writeFile(path.join(run, "store", "01.og.png"), encodePNG24(solid(120, 63)));
  const results = await checkRun({ dir: run });
  assert.equal(failuresOf(results).length, 0, "the file beside store.json is the one checked");
  assert.equal(path.dirname(results[0].files[0].file), path.join(run, "store"));
});

test("an icons run in its icons/ subfolder is found and re-checked against each file's rule", async () => {
  const run = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  const dir = path.join(run, "icons");
  await mkdir(path.join(dir, "web"), { recursive: true });
  await writeFile(path.join(dir, "web", "icon-48.png"), encodePNG(solid(48, 48)));
  await writeFile(path.join(dir, "web", "icon-32.png"), encodePNG(solid(32, 32)));
  await writeFile(
    path.join(dir, "icons.json"),
    JSON.stringify({
      kind: "icons",
      name: "mark",
      files: [
        { rel: "web/icon-48.png", path: "C:\\elsewhere\\web\\icon-48.png", rule: { width: 48, height: 48 } },
        { rel: "web/icon-32.png", rule: { width: 48, height: 48 } },
      ],
    }),
  );
  const results = await checkRun({ dir: run });
  assert.equal(results[0].kind, "icons");
  const fails = failuresOf(results);
  assert.equal(fails.length, 1, "only the 32px file, held to a 48px rule, fails");
  assert.equal(fails[0].file, "web/icon-32.png");
  assert.equal(fails[0].check, "size");
});

test("an icon recorded without its rule fails instead of passing with nothing checked", async () => {
  const run = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  await mkdir(path.join(run, "icons"), { recursive: true });
  await writeFile(path.join(run, "icons", "a.png"), encodePNG(solid(16, 16)));
  await writeFile(path.join(run, "icons", "icons.json"), JSON.stringify({ kind: "icons", name: "old", files: [{ rel: "a.png" }] }));
  const fails = failuresOf(await checkRun({ dir: run }));
  assert.equal(fails.length, 1);
  assert.equal(fails[0].check, "rule");
  assert.match(fails[0].detail, /onmodel icons/);
});

test("a summary that cannot be read is a failure, not a silent skip", async () => {
  const run = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  await mkdir(path.join(run, "store"), { recursive: true });
  await writeFile(path.join(run, "store", "store.json"), '{"kind":"store","candidates":[');
  const fails = failuresOf(await checkRun({ dir: run }));
  assert.equal(fails.length, 1);
  assert.equal(fails[0].check, "summary");
});

test("findRuns lists run folders whose summaries sit in a kind's subfolder or at the top", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-out-"));
  for (const [d, f] of [
    ["a/store", "store.json"],
    ["b/icons", "icons.json"],
    ["c/sprites", "sprites.json"],
    ["d", "generate.json"],
  ]) {
    await mkdir(path.join(out, d), { recursive: true });
    await writeFile(path.join(out, d, f), "{}");
  }
  await mkdir(path.join(out, "empty"), { recursive: true });
  await writeFile(path.join(out, "empty", "notes.txt"), "hi");
  assert.deepEqual(
    (await findRuns(out)).map((d) => path.basename(d)),
    ["a", "b", "c", "d"],
  );
  assert.deepEqual(await findRuns(path.join(out, "does-not-exist")), []);
});

test("the check command exits 2 when it found nothing to check", async () => {
  const empty = await mkdtemp(path.join(tmpdir(), "onmodel-empty-"));
  const r = spawnSync(process.execPath, [bin, "check", "--in", empty, "--out", empty], { encoding: "utf8" });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing to check/);
});

test("recheckFile reports a file that will not decode", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  const junk = path.join(dir, "broken.png");
  await writeFile(junk, Buffer.from("not an image at all"));
  const r = await recheckFile(junk, { width: 10, height: 10 });
  assert.ok(r.error, "a non-image is reported as an error");
  assert.ok(r.checks.some((c) => c.check === "decodes" && !c.ok));
});

/** An image whose pixel at (x, y) is f(x, y). */
function art(w, h, f) {
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = f(x, y);
      const i = (y * w + x) * 4;
      data[i] = Math.max(0, Math.min(255, Math.round(r)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
      data[i + 3] = 255;
    }
  }
  return { width: w, height: h, data };
}

test("an SVG that has been truncated or resized since is caught", async () => {
  const { recheckSVG } = await import("../src/check.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-svg-"));
  const good = path.join(dir, "good.svg");
  await writeFile(good, '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 30" width="40" height="30">\n  <path d="M0 0L10 0L10 10Z"/>\n</svg>\n');
  const ok = await recheckSVG(good, { width: 40, height: 30 });
  assert.ok(ok.checks.every((c) => c.ok), JSON.stringify(ok.checks));

  // Re-exported at another size: the canvas no longer matches what the run recorded.
  const resized = await recheckSVG(good, { width: 64, height: 64 });
  assert.equal(resized.checks.find((c) => c.check === "size").ok, false);

  // A path left with no geometry in it, which a careless edit does.
  const empty = path.join(dir, "empty.svg");
  await writeFile(empty, '<svg viewBox="0 0 10 10"><path d=""/></svg>');
  const got = await recheckSVG(empty, { width: 10, height: 10 });
  assert.equal(got.checks.find((c) => c.check === "geometry").ok, false);

  const gone = await recheckSVG(path.join(dir, "nope.svg"), {});
  assert.equal(gone.error, "missing");
});

test("a normal map that has stopped being one is caught", async () => {
  const { recheckNormal } = await import("../src/check.mjs");
  const { normalMap } = await import("../src/normal.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-nm-"));
  const source = art(32, 32, (x, y) => { const v = 60 + 2 * x + 2 * y; return [v, v, v]; });
  const made = normalMap(source, { strength: 1, blur: 1 });
  const good = path.join(dir, "n.png");
  await writeFile(good, encodePNG(made.image));
  const ok = await recheckNormal(good);
  assert.ok(ok.checks.every((c) => c.ok), JSON.stringify(ok.checks));

  // Red and blue swapped: it still decodes as a PNG and still looks bluish, but most of
  // it now points INTO the surface, which no normal map ever does.
  const swapped = { width: 32, height: 32, data: Uint8Array.from(made.image.data) };
  for (let i = 0; i < 32 * 32; i++) {
    const p = i * 4;
    const r = swapped.data[p];
    swapped.data[p] = swapped.data[p + 2];
    swapped.data[p + 2] = r;
  }
  const bad = path.join(dir, "swapped.png");
  await writeFile(bad, encodePNG(swapped));
  const caught = await recheckNormal(bad);
  assert.equal(caught.checks.find((c) => c.check === "outward").ok, false);

  // A flat grey image is not a normal map either: nothing in it is unit length.
  const grey = path.join(dir, "grey.png");
  await writeFile(grey, encodePNG(art(16, 16, () => [128, 128, 128])));
  const notAMap = await recheckNormal(grey);
  assert.equal(notAMap.checks.find((c) => c.check === "unit").ok, false);
});

test("a tile whose join has been broken since fails the gate", async () => {
  const { makeSeamless } = await import("../src/tile.mjs");
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-tilechk-"));
  const runDir = path.join(dir, "ground", "tile");
  await mkdir(runDir, { recursive: true });

  const W = 48;
  const seamless = makeSeamless(art(W, W, (x, y) => { const v = 120 + 40 * Math.sin((2 * Math.PI * x * 2) / W) * Math.cos((2 * Math.PI * y * 2) / W); return [v, v * 0.9, v * 0.8]; })).image;
  const tileFile = path.join(runDir, "ground.png");
  await writeFile(tileFile, encodePNG(seamless));
  await writeFile(
    path.join(runDir, "tile.json"),
    JSON.stringify({ tool: "onmodel", kind: "tile", name: "ground", dir: runDir, files: { tile: tileFile }, facts: { width: W, height: W, verdict: "seamless" } }),
  );

  const before = await checkRun({ dir: path.join(dir, "ground") });
  assert.equal(failuresOf(before).length, 0, JSON.stringify(failuresOf(before)));
  assert.ok(before.some((r) => r.kind === "tile"), "the tile run is found at all");

  // Brighten one edge, which is what a careless re-export does. The tile still decodes
  // at the right size and still looks fine on its own; laid out, it seams.
  const broken = { width: W, height: W, data: Uint8Array.from(seamless.data) };
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < 3; x++) {
      const i = (y * W + x) * 4;
      broken.data[i] = 250;
      broken.data[i + 1] = 250;
      broken.data[i + 2] = 250;
    }
  }
  await writeFile(tileFile, encodePNG(broken));
  const after = await checkRun({ dir: path.join(dir, "ground") });
  const fails = failuresOf(after);
  assert.equal(fails.length, 1, JSON.stringify(fails));
  assert.equal(fails[0].check, "tiles");
  assert.match(fails[0].detail, /the join is .* its own grain|the texture's own grain/);
});
