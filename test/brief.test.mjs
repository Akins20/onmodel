import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { briefProblems, requireBrief, sectionOf, paletteFromBrief, parseDecisions, decisionsSection, briefSection } from "../src/brief.mjs";

const GOOD = `# Chomp art brief

## Product
Chomp is a maze game for Android where a round creature eats dots and runs from ghosts. This art is its player character and three enemies, as sprites.

## Audience
Players aged ten to forty on mid-range Android phones, in portrait, at 48 to 96 pixels per sprite on screen; they know Pac-Man and Crossy Road.

## Art direction
Chunky flat shapes with a two pixel black outline, no gradients, a single light from the top left, friendly and a little greedy. Sits beside Crossy Road and Alto's Odyssey.

## Palette
Body #F5C400 for the player, enemy reds #E63946 and #B5171E, the maze #1D1A1E, highlights #FFFFFF and a soft shadow #6b6570. #abc is a test.

## Do not
No text, no watermark, no gradients, no realistic fur.
`;

test("a brief needs Product and Art direction, filled in, with the template text gone", async () => {
  assert.deepEqual(briefProblems(GOOD), []);
  assert.deepEqual(briefProblems(""), ["the brief is empty"]);
  const problems = briefProblems("# x\n\n## Product\nShort.\n\n## Audience\nPeople.\n");
  assert.ok(problems.some((p) => p.includes('"## Product" section is too short')));
  assert.ok(problems.some((p) => p.includes('no "## Art direction"')));
  const template = await readFile(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "brief.example.md"), "utf8");
  assert.ok(briefProblems(template).some((p) => p.includes("template text")), "an unfilled template is refused");
});

test("requireBrief says what is missing and where to start", () => {
  assert.throws(() => requireBrief({ briefText: "", brief: "onmodel/brief.md" }), /brief is empty.*onmodel init/s);
  assert.doesNotThrow(() => requireBrief({ briefText: GOOD }));
  assert.match(briefSection(GOOD), /^## Brief\n# Chomp art brief/);
});

test("sections and the palette are read out of the brief in order, without repeats", () => {
  assert.match(sectionOf(GOOD, "Do not"), /^No text/);
  assert.equal(sectionOf(GOOD, "Benchmarks"), "");
  assert.deepEqual(paletteFromBrief(GOOD), ["#f5c400", "#e63946", "#b5171e", "#1d1a1e", "#ffffff", "#6b6570", "#aabbcc"]);
  assert.deepEqual(paletteFromBrief("## Palette\nnone yet"), []);
});

test("decisions are the bullets of the file, examples and prose left out", () => {
  const text = "# Settled\n\nProse that is not a decision.\n- Example: this one is from the template.\n- the cat has no collar: it is a stray\n2. outlines stay black: the set was drawn that way\n";
  assert.deepEqual(parseDecisions(text), ["the cat has no collar: it is a stray", "outlines stay black: the set was drawn that way"]);
  assert.match(decisionsSection(parseDecisions(text)), /## Settled decisions[\s\S]*1\. the cat has no collar/);
  assert.equal(decisionsSection([]), "");
});
