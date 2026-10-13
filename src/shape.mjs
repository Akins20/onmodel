import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { encodePNG } from "./png.mjs";
import { slug } from "./generate.mjs";
import { loadMark } from "./icons.mjs";
import { silhouettePolygons, shapeFit, packedVector2, occluderPolygon } from "./silhouette.mjs";

/**
 * `onmodel shape`: the collision and occlusion shape of a piece of art, traced from its
 * own silhouette.
 *
 * A game needs to know where a thing IS, not only what it looks like, and that shape is
 * already in the picture: it is the edge of what is opaque. onmodel traces contours at
 * sub-pixel precision for its vector work, so the outline comes nearly free. What it
 * needs on top is to be made simple, because a collision body with two thousand points is
 * a performance bug in the shape of an answer.
 *
 * Simplifying can go wrong in two different directions and they are reported separately,
 * because one of them is much worse than the other. A shape that MISSES part of the
 * sprite lets a sword pass through a shoulder. A shape that claims EMPTY SPACE makes the
 * player collide with nothing, which feels broken in a way players notice immediately.
 * Comparing areas hides this: cutting the corner off a dent adds as much area as it takes
 * away, so the polygon is drawn back and set against the art pixel by pixel instead.
 */

const GOOD_FIT = 0.95;

export async function makeShape({ config, name = null, candidate = null, markPath = null, points = 16, alphaMin = 128, log = (s) => process.stderr.write(s) }) {
  const { mark, file } = await loadMark({ config, name, candidate, markPath });
  const label = slug(name ?? path.basename(file).replace(/\.[^.]+$/, ""));
  const dir = path.join(config.out, label, "shape");
  await mkdir(dir, { recursive: true });

  const polygons = silhouettePolygons(mark, { maxPoints: points, alphaMin });
  if (!polygons.length) throw new Error("nothing opaque enough to take a shape from: the art may be empty or its alpha may be too soft");
  const fit = shapeFit(mark, polygons, { alphaMin });

  // The art with the shape drawn over it, because a number cannot show you WHERE the
  // shape is wrong and the eye finds it at once.
  const preview = { width: mark.width, height: mark.height, data: Uint8Array.from(mark.data) };
  for (const poly of polygons) {
    const pts = poly.points;
    for (let i = 0; i < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[(i + 1) % pts.length];
      const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
      for (let s = 0; s <= steps; s++) {
        const x = Math.round(ax + ((bx - ax) * s) / steps);
        const y = Math.round(ay + ((by - ay) * s) / steps);
        if (x < 0 || y < 0 || x >= mark.width || y >= mark.height) continue;
        const p = (y * mark.width + x) * 4;
        preview.data[p] = 60;
        preview.data[p + 1] = 230;
        preview.data[p + 2] = 90;
        preview.data[p + 3] = 255;
      }
    }
  }

  const base = path.join(dir, label);
  const files = {
    occluder: `${base}.occluder.tres`,
    preview: `${base}.shape.png`,
    points: `${base}.points.txt`,
  };
  await writeFile(files.occluder, occluderPolygon(polygons[0].points));
  await writeFile(files.preview, encodePNG(preview));
  // A CollisionPolygon2D is a node, not a resource, so there is nothing to write it into.
  // The points go out in Godot's own notation, ready to paste or to set from a script.
  await writeFile(
    files.points,
    polygons
      .map((p, i) => `# shape ${i + 1}: ${p.points.length} points, simplified from ${p.from} at a tolerance of ${p.tolerance}\n${packedVector2(p.points)}\n`)
      .join("\n"),
  );

  const verdict = fit.fit >= GOOD_FIT ? "good" : fit.extra > fit.missed ? "baggy" : "tight";
  const facts = {
    width: mark.width,
    height: mark.height,
    shapes: polygons.length,
    points: polygons.reduce((t, p) => t + p.points.length, 0),
    from: polygons.reduce((t, p) => t + p.from, 0),
    budget: points,
    tolerance: polygons[0].tolerance,
    ...fit,
    verdict,
  };
  const summary = { tool: "onmodel", kind: "shape", name: label, dir, mark: file, generatedAt: new Date().toISOString(), files, facts };
  await writeFile(path.join(dir, "shape.json"), JSON.stringify(summary, null, 2));
  log(`  ${label}: ${facts.points} points from ${facts.from}, fit ${fit.fit}, ${verdict}\n`);
  return summary;
}
