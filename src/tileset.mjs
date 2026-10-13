import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { slug } from "./generate.mjs";
import { loadMark } from "./icons.mjs";
import { seam, makeSeamless, tiled } from "./tile.mjs";
import { atlasTileSet, atlasCanvasTexture, GODOT_FILTER_NEAREST, GODOT_REPEAT_ENABLED } from "./atlas.mjs";
import { normalMap, lightingStrip } from "./normal.mjs";

/**
 * `onmodel tile`: a texture checked for whether it actually tiles, closed up if it does
 * not, laid out in a grid so it can be seen, and written as a Godot TileSet.
 *
 * A painter paints one square and never sees it repeated, so it has no way to know its
 * right edge has to run into its left. That is the gap this closes, and it closes it by
 * measuring rather than trusting: the join against the tile's own grain, which is a
 * ratio and so does not care whether the texture is busy or smooth.
 *
 * The fix is deliberately modest and says what it is. Moving the two edges to meet in
 * the middle removes the LINE; it cannot make a brick carry on across the join. When the
 * correction it had to make is large, that is reported as forced rather than fixed,
 * because a tile needing that much reconciliation was never going to tile and should be
 * painted again instead.
 */

const FIX_ABOVE = 1.5;
const FORCED_ABOVE = 8;

export async function makeTileset({ config, name = null, candidate = null, markPath = null, band = null, grid = 3, fix = true, normal = false, strength = 1, blur = 1, log = (s) => process.stderr.write(s) }) {
  const { mark, file } = await loadMark({ config, name, candidate, markPath });
  const label = slug(name ?? path.basename(file).replace(/\.[^.]+$/, ""));
  const dir = path.join(config.out, label, "tile");
  await mkdir(dir, { recursive: true });

  const before = seam(mark);
  const needed = before.ratio > FIX_ABOVE;
  const applied = fix && needed;
  const result = applied ? makeSeamless(mark, { band }) : { image: mark, band: { x: 0, y: 0 }, moved: 0, mean: 0 };
  const after = applied ? seam(result.image) : before;
  const verdict = !needed ? "seamless" : !applied ? "seams" : result.mean > FORCED_ABOVE ? "forced" : "fixed";

  const base = path.join(dir, label);
  const files = {
    tile: `${base}.png`,
    tiled: `${base}.tiled.png`,
    source: `${base}.source.png`,
    tileset: `${base}.tres`,
  };
  await writeFile(files.tile, encodePNG(result.image));
  await writeFile(files.tiled, encodePNG(tiled(result.image, grid)));
  await writeFile(files.source, encodePNG(mark));
  await writeFile(
    files.tileset,
    atlasTileSet(result.image, {
      file: `${label}.png`,
      resPath: config.tile?.resPath ? `${String(config.tile.resPath).replace(/\/+$/, "")}/${label}.png` : null,
      tileWidth: result.image.width,
      tileHeight: result.image.height,
    }),
  );

  // A floor lit by a normal map that does not tile shows a grid however seamless its
  // colour is, so the map is made wrapped and then held to the same join measurement.
  let lighting = null;
  if (normal) {
    const made = normalMap(result.image, { strength, blur, wrap: true });
    const joinOfNormal = seam(made.image);
    files.normal = `${base}.normal.png`;
    files.lit = `${base}.lit.png`;
    files.canvas = `${base}.canvas.tres`;
    await writeFile(files.normal, encodePNG(made.image));
    await writeFile(files.lit, encodePNG(lightingStrip(result.image, made.image)));
    const res = (n) => (config.tile?.resPath ? `${String(config.tile.resPath).replace(/\/+$/, "")}/${n}` : `res://${n}`);
    await writeFile(
      files.canvas,
      atlasCanvasTexture({
        diffuse: res(`${label}.png`),
        normal: res(`${label}.normal.png`),
        filter: config.pixel ? GODOT_FILTER_NEAREST : null,
        repeat: GODOT_REPEAT_ENABLED,
      }),
    );
    lighting = { ...made.facts, join: joinOfNormal.ratio };
  }

  const facts = {
    width: result.image.width,
    height: result.image.height,
    join: { x: before.x, y: before.y },
    grain: { x: before.grainX, y: before.grainY },
    ratioBefore: before.ratio,
    ratioAfter: after.ratio,
    fixed: applied,
    band: result.band,
    moved: result.moved,
    mean: result.mean,
    grid,
    ...(lighting ? { normal: lighting } : {}),
    verdict,
  };
  const summary = { tool: "onmodel", kind: "tile", name: label, dir, mark: file, generatedAt: new Date().toISOString(), files, facts };
  await writeFile(path.join(dir, "tile.json"), JSON.stringify(summary, null, 2));

  log(
    `  ${label}: ${facts.width}x${facts.height}, join ${before.ratio}x its own grain -> ${verdict}` +
      (lighting ? `, normal map joins at ${lighting.join}x` : "") +
      (applied ? `, closed over ${result.band.x}px, ${Math.round(result.moved * 100)}% of pixels moved by ${result.mean} on average` : "") +
      `\n`,
  );
  return summary;
}
