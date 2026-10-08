#!/usr/bin/env node
// Gives the onmodel alias the main package's version and pins its dependency to that
// exact version, at release time, so the two can never drift apart.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function stampAlias(alias, version) {
  return { ...alias, version, dependencies: { ...alias.dependencies, "@akins20/onmodel": version } };
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const main = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const file = path.join(root, "alias", "onmodel", "package.json");
  const alias = JSON.parse(await readFile(file, "utf8"));
  await writeFile(file, JSON.stringify(stampAlias(alias, main.version), null, 2) + "\n");
  process.stdout.write(`onmodel stamped at ${main.version}\n`);
}
