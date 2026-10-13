import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { slug } from "./generate.mjs";
import { loadMark } from "./icons.mjs";
import { seam } from "./tile.mjs";
import { terrainAtlas, adjacencyReport, coverage, renderMap, variants, MODES } from "./terrain.mjs";
import { atlasTileSet, godotImport } from "./atlas.mjs";

/**
 * `onmodel terrain`: the 16 or 47 cells a Godot TileMapLayer needs to paint a material,
 * composited from one seamless fill, with every peering bit derived rather than typed.
 *
 * The cells are the easy half. The hard half, and the one that goes wrong silently, is
 * whether the set actually holds together: a terrain set one bit out looks perfectly fine
 * in the editor and tears a hole in the map three hours later. So the set is laid into a
 * real patch of terrain and every internal edge is checked. Pairs of cells are NOT what
 * to check, which the first attempt did and which marks correct sets as broken, because
 * most pairs cannot occur together and what their shared edge does is nobody's business.
 *
 * The fill has to tile, because two cells side by side hold it at the same phase and show
 * the material carrying on across the join. `onmodel tile` is how you get one, and the
 * fill's own join is measured here too, on the fill as the cells hold it after scaling, so
 * a bad one is named rather than inherited.
 *
 * The fill also has to be solid. A terrain's material is the ground itself; the shape of
 * each cell is what makes it transparent, and holes in the fill would sit in every cell and
 * make the edge check judge the fill's holes instead of the cells' shapes.
 */

export async function makeTerrain({
  config,
  name = null,
  candidate = null,
  markPath = null,
  mode = "both",
  size = null,
  columns = 8,
  margin = null,
  round = null,
  terrainName = null,
  log = (s) => process.stderr.write(s),
}) {
  if (!Object.hasOwn(MODES, String(mode))) throw new Error(`--mode must be ${Object.keys(MODES).join(" or ")}`);
  const { mark, file } = await loadMark({ config, name, candidate, markPath });
  const label = slug(name ?? path.basename(file).replace(/\.[^.]+$/, ""));
  const dir = path.join(config.out, label, "terrain");
  await mkdir(dir, { recursive: true });

  const atlas = terrainAtlas(mark, { mode, size, columns, margin, round, pixel: Boolean(config.pixel) });
  // Nearest-neighbour enlarging repeats every pixel, so half of all neighbouring pairs are
  // identical and the grain reads as nothing; a doubled pixel-art fill then measured its
  // join at 15x the grain. It cannot add or remove a seam, so the fill as painted is judged.
  const fillJoin = seam(atlas.fillFilter === "nearest" ? mark : atlas.fill);
  let holes = 0;
  for (let i = 3; i < atlas.fill.data.length; i += 4) if (atlas.fill.data[i] < 128) holes++;
  const report = adjacencyReport(atlas);
  const covered = coverage(atlas);
  const expected = variants(mode).length;

  const base = path.join(dir, label);
  const files = {
    atlas: `${base}.png`,
    tileset: `${base}.tres`,
    map: `${base}.map.png`,
    fill: `${base}.fill.png`,
  };
  await writeFile(files.atlas, encodePNG(atlas.image));
  await writeFile(`${files.atlas}.import`, godotImport({ pixel: Boolean(config.pixel) }));
  await writeFile(files.fill, encodePNG(atlas.fill));
  await writeFile(files.map, encodePNG(renderMap(atlas, { width: 20, height: 14 })));
  await writeFile(
    files.tileset,
    atlasTileSet(atlas.image, {
      file: `${label}.png`,
      resPath: config.tile?.resPath ? `${String(config.tile.resPath).replace(/\/+$/, "")}/${label}.png` : null,
      tileWidth: atlas.cellSize,
      tileHeight: atlas.cellSize,
      terrain: { mode: MODES[mode], name: terrainName ?? label, cells: atlas.cells },
    }),
  );

  // Sides-only cannot close a diagonal: it has no bit for the corner, so where two cells
  // disagree about what is above them the edge steps. That is the mode, not a fault, and
  // it is the reason to choose corners-and-sides for anything meant to look seamless.
  const seamless = mode === "both";
  const empty = covered.hollow > 0 || covered.gaps > 0 || covered.misdrawn > 0 || holes > 0;
  const verdict = atlas.cells.length !== expected || report.missing > 0 || empty ? "incomplete" : seamless && report.joins < 1 ? "breaks" : "complete";
  const facts = {
    mode,
    godotMode: MODES[mode],
    cells: atlas.cells.length,
    expected,
    cellSize: atlas.cellSize,
    columns: atlas.columns,
    margin: atlas.margin,
    round: atlas.round,
    fillWidth: mark.width,
    fillHeight: mark.height,
    fillFilter: atlas.fillFilter,
    fillHoles: holes,
    hollowCells: covered.hollow,
    fullCellGaps: covered.gaps,
    misdrawnCells: covered.misdrawn,
    width: atlas.image.width,
    height: atlas.image.height,
    fillJoin: fillJoin.ratio,
    pairs: report.edges,
    pairsMatched: report.matched,
    missingCells: report.missing,
    joins: report.joins,
    seamless,
    verdict,
  };
  const summary = { tool: "onmodel", kind: "terrain", name: label, dir, mark: file, generatedAt: new Date().toISOString(), files, facts, broken: report.broken };
  await writeFile(path.join(dir, "terrain.json"), JSON.stringify(summary, null, 2));
  log(`  ${label}: ${atlas.cells.length} of ${expected} cells, ${report.matched} of ${report.edges} possible pairs join, ${verdict}\n`);
  return summary;
}
