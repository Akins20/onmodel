import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stampAlias } from "../scripts/stamp-alias.mjs";

/**
 * The plain-name alias `onmodel`: it is stamped with the main package's version and
 * pins the main package to exactly that version, and its command loads the main
 * package's own command file, which the main package ships.
 */

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the alias is stamped with the main version and pins the main package to it", () => {
  const stamped = stampAlias({ name: "onmodel", version: "0.0.0", dependencies: { "@akins20/onmodel": "0.0.0" } }, "1.2.3");
  assert.equal(stamped.version, "1.2.3");
  assert.equal(stamped.dependencies["@akins20/onmodel"], "1.2.3", "an exact pin, so the two never drift");
});

test("the alias's command loads the main package's command, which the main package ships", async () => {
  const main = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const alias = JSON.parse(await readFile(path.join(root, "alias", "onmodel", "package.json"), "utf8"));
  assert.equal(alias.name, "onmodel");
  assert.equal(alias.bin.onmodel, "bin.mjs");
  assert.ok(alias.files.includes("bin.mjs"));
  const bin = await readFile(path.join(root, "alias", "onmodel", "bin.mjs"), "utf8");
  const target = bin.match(/import\("([^"]+)"\)/)[1];
  assert.equal(target, `${main.name}/${main.bin.onmodel}`, "it imports the main package's bin by its published path");
  assert.ok(main.files.includes("bin"), "and the main package publishes that folder");
  await access(path.join(root, main.bin.onmodel));
});
