import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkRun, findRuns, failuresOf, recheckFile } from "../src/check.mjs";
import { encodePNG, encodePNG24 } from "../src/png.mjs";

/**
 * The no-API gate against run directories built by hand: a run whose files still
 * match their recorded rules passes, and one whose files were resized, given an
 * alpha channel or deleted fails on exactly those checks. Nothing calls the API.
 */

function solid(width, height, [r, g, b, a] = [40, 60, 90, 255]) {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set([r, g, b, a], i * 4);
  return { width, height, data };
}

test("a store run whose files still match their recorded rules passes", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  await mkdir(path.join(dir, "store"), { recursive: true });
  const og = path.join(dir, "store", "01.og.png");
  await writeFile(og, encodePNG24(solid(120, 63)));
  await writeFile(path.join(dir, "store.json"), JSON.stringify({ tool: "onmodel", kind: "store", name: "demo", candidates: [{ index: 1, files: { targets: [{ key: "og", width: 120, height: 63, file: og }] } }] }));
  const results = await checkRun({ dir });
  assert.equal(results.length, 1);
  assert.equal(results[0].kind, "store");
  assert.equal(failuresOf(results).length, 0, "nothing should fail");
  const opaque = results[0].files[0].checks.find((c) => c.check === "opaque");
  assert.ok(opaque.ok, "the 24-bit PNG reads as opaque");
});

test("a resized, transparent or missing file fails on exactly that check", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  await mkdir(path.join(dir, "store"), { recursive: true });
  const ogFile = path.join(dir, "store", "01.og.png");
  const ghFile = path.join(dir, "store", "01.github.png");
  const pfFile = path.join(dir, "store", "01.play-feature.png");
  await writeFile(ogFile, encodePNG24(solid(100, 50))); // recorded as 120x63 => size fails
  await writeFile(ghFile, encodePNG(solid(120, 63, [40, 60, 90, 120]))); // alpha present => opaque fails
  // pfFile deliberately not written => present fails
  await writeFile(
    path.join(dir, "store.json"),
    JSON.stringify({
      tool: "onmodel",
      kind: "store",
      name: "demo",
      candidates: [
        {
          index: 1,
          files: {
            targets: [
              { key: "og", width: 120, height: 63, file: ogFile },
              { key: "github", width: 120, height: 63, file: ghFile },
              { key: "play-feature", width: 120, height: 63, file: pfFile },
            ],
          },
        },
      ],
    }),
  );
  const fails = failuresOf(await checkRun({ dir }));
  const checks = fails.map((f) => f.check);
  assert.ok(checks.includes("size"), "the resized file fails the size check");
  assert.ok(checks.includes("opaque"), "the file with alpha fails the opaque check");
  assert.ok(checks.includes("present"), "the missing file fails the present check");
});

test("an icon file is re-checked against its persisted rule", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  const good = path.join(dir, "icon-48.png");
  const bad = path.join(dir, "icon-32.png");
  await writeFile(good, encodePNG(solid(48, 48)));
  await writeFile(bad, encodePNG(solid(32, 32)));
  await writeFile(
    path.join(dir, "icons.json"),
    JSON.stringify({
      tool: "onmodel",
      kind: "icons",
      name: "mark",
      files: [
        { platform: "web", rel: "icon-48.png", path: good, bytes: 1, rule: { width: 48, height: 48 }, checks: [] },
        { platform: "web", rel: "icon-32.png", path: bad, bytes: 1, rule: { width: 48, height: 48 }, checks: [] },
      ],
    }),
  );
  const results = await checkRun({ dir });
  assert.equal(results[0].kind, "icons");
  const fails = failuresOf(results);
  assert.equal(fails.length, 1, "only the 32px file, held to a 48px rule, fails");
  assert.equal(fails[0].file, "icon-32.png");
  assert.equal(fails[0].check, "size");
});

test("findRuns lists only directories that hold a summary", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-out-"));
  await mkdir(path.join(out, "a"), { recursive: true });
  await mkdir(path.join(out, "b"), { recursive: true });
  await mkdir(path.join(out, "empty"), { recursive: true });
  await writeFile(path.join(out, "a", "store.json"), "{}");
  await writeFile(path.join(out, "b", "icons.json"), "{}");
  await writeFile(path.join(out, "empty", "notes.txt"), "hi");
  const runs = await findRuns(out);
  assert.deepEqual(
    runs.map((d) => path.basename(d)).sort(),
    ["a", "b"],
  );
  assert.deepEqual(await findRuns(path.join(out, "does-not-exist")), []);
});

test("recheckFile reports a file that will not decode", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-check-"));
  const junk = path.join(dir, "broken.png");
  await writeFile(junk, Buffer.from("not an image at all"));
  const r = await recheckFile(junk, { width: 10, height: 10 });
  assert.ok(r.error, "a non-image is reported as an error");
  assert.ok(r.checks.some((c) => c.check === "decodes" && !c.ok));
});
