import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { slug } from "./generate.mjs";
import { loadMark } from "./icons.mjs";
import { normalMap, lightingStrip } from "./normal.mjs";
import { seam } from "./tile.mjs";
import { atlasCanvasTexture, GODOT_FILTER_NEAREST, GODOT_REPEAT_ENABLED } from "./atlas.mjs";

/**
 * `onmodel normal`: a normal map derived from the art, so a 2D light knows which way each
 * pixel faces, plus the Godot CanvasTexture that binds the two together and a strip of the
 * art lit from four corners.
 *
 * The strip is the point. Numbers can show the encoding is faithful and that a tile still
 * tiles; they cannot show that the bumps read as bumps rather than dents, which is what
 * goes wrong when the green channel is the wrong way round. Looking at four lights moving
 * round the art settles that in a second.
 *
 * And the standing caveat, repeated here because it governs the whole feature: the height
 * is taken from luminance, because a painted sprite has no geometry to measure. Dark
 * paint becomes a dent. That is inherent, it is reported rather than hidden, and a run
 * says how much of the art's variation was fine enough to come out as noise.
 */

const FLAT_ABOVE = 0.9;

export async function makeNormalMap({
  config,
  name = null,
  candidate = null,
  markPath = null,
  strength = 1,
  blur = 1,
  wrap = false,
  invertY = false,
  log = (s) => process.stderr.write(s),
}) {
  const { mark, file } = await loadMark({ config, name, candidate, markPath });
  const label = slug(name ?? path.basename(file).replace(/\.[^.]+$/, ""));
  const dir = path.join(config.out, label, "normal");
  await mkdir(dir, { recursive: true });

  const made = normalMap(mark, { strength, blur, wrap, invertY });
  const strip = lightingStrip(mark, made.image, { invertY });

  // A tile lit by a normal map that does not tile still shows a grid, however seamless
  // its colour is, so the map is held to the same join measurement as the colour.
  const join = wrap ? seam(made.image) : null;

  const base = path.join(dir, label);
  const files = {
    normal: `${base}.normal.png`,
    lit: `${base}.lit.png`,
    source: `${base}.source.png`,
    canvas: `${base}.canvas.tres`,
  };
  const res = (n) => (config.normal?.resPath ? `${String(config.normal.resPath).replace(/\/+$/, "")}/${n}` : `res://${n}`);
  await writeFile(files.normal, encodePNG(made.image));
  await writeFile(files.lit, encodePNG(strip));
  await writeFile(files.source, encodePNG(mark));
  await writeFile(
    files.canvas,
    atlasCanvasTexture({
      diffuse: res(`${label}.source.png`),
      normal: res(`${label}.normal.png`),
      filter: config.pixel ? GODOT_FILTER_NEAREST : null,
      repeat: wrap ? GODOT_REPEAT_ENABLED : null,
    }),
  );

  const verdict = made.facts.flatShare > FLAT_ABOVE ? "flat" : wrap && join.ratio > 1.5 ? "seams" : "derived";
  const facts = { ...made.facts, width: made.image.width, height: made.image.height, ...(join ? { join: join.ratio } : {}), verdict };
  const summary = { tool: "onmodel", kind: "normal", name: label, dir, mark: file, generatedAt: new Date().toISOString(), files, facts };
  await writeFile(path.join(dir, "normal.json"), JSON.stringify(summary, null, 2));

  log(`  ${label}: normal map at strength ${strength}, green ${made.facts.green}, ${verdict}\n`);
  return summary;
}
