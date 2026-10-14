import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeImage, encodePNG } from "./image.mjs";
import { slug } from "./generate.mjs";
import { loadMark } from "./icons.mjs";
import { resize } from "./key.mjs";
import { godotImport } from "./atlas.mjs";
import { ninePatchInsets, centreIsEmpty, renderNinePatch, androidNinePatch, readAndroidNinePatch, styleBoxTexture, ninePatchCSS } from "./ninepatch.mjs";

/**
 * `onmodel ninepatch`: a panel, button or frame made to stretch to any size, with the
 * insets found from the art and written for Godot (a StyleBoxTexture any theme can use),
 * Android (a .9.png) and the web (CSS border-image).
 *
 * A file given with --mark is used exactly as it is, transparent gutter and all, so insets
 * given with --insets mean what they say on that file. A generated run (--name) is cut to
 * its art first, since a generation sits in a much bigger canvas.
 *
 * Generated art is usually far too big for UI: a 1K panel has corners a hundred pixels
 * wide, and a Godot StyleBoxTexture has no scale of its own. --scale shrinks the art first
 * and everything is measured after.
 */

const MAX_SIDE = 2048;

export async function makeNinePatch({ config, name = null, candidate = null, markPath = null, insets = null, content = null, scale = null, log = (s) => process.stderr.write(s) }) {
  let art;
  let file;
  if (markPath) {
    file = markPath;
    try {
      art = decodeImage(await readFile(markPath));
    } catch (err) {
      throw new Error(`could not read ${markPath}: ${err.message}`);
    }
  } else {
    const got = await loadMark({ config, name, candidate, markPath: null });
    art = got.mark;
    file = got.file;
  }
  // An Android nine-patch already says where it stretches: its marks become the insets and
  // its border is taken off, so an existing .9.png converts for Godot and the web as it is.
  let fromAndroid = null;
  if (markPath && /\.9\.png$/i.test(markPath)) {
    const read = readAndroidNinePatch(art);
    if (read.problems.length) throw new Error(`${path.basename(markPath)} is not a valid nine-patch: ${read.problems.slice(0, 3).join("; ")}`);
    if (read.regions.across > 1 || read.regions.down > 1) {
      throw new Error(`${path.basename(markPath)} stretches ${read.regions.across} regions across and ${read.regions.down} down, to hold something between them at its size; a Godot StyleBoxTexture, a NinePatchRect and CSS border-image each stretch one region, so it cannot convert as it is. Draw the held part as its own image on top`);
    }
    if (!read.insets) throw new Error(`${path.basename(markPath)} marks no stretch on its top or left border`);
    fromAndroid = read;
    art = read.art;
    if (!insets) insets = [read.insets.left, read.insets.top, read.insets.right, read.insets.bottom];
    if (!content && read.content) content = [read.content.left, read.content.top, read.content.right, read.content.bottom];
    if (scale != null && scale !== 1) throw new Error("a .9.png is already at its density; scaling it would blur its marks, so --scale is refused");
  }
  const source = { width: art.width, height: art.height };
  if (scale != null && scale !== 1) art = resize(art, Math.max(3, Math.round(art.width * scale)), Math.max(3, Math.round(art.height * scale)), { filter: config.pixel ? "nearest" : "box" });
  if (art.width > MAX_SIDE || art.height > MAX_SIDE) throw new Error(`the art is ${art.width}x${art.height}; UI art over ${MAX_SIDE}px a side is far bigger than any panel needs, so shrink it with --scale (0.25 makes it a quarter)`);
  if (art.width < 3 || art.height < 3) throw new Error(`the art is ${art.width}x${art.height}; a nine-patch needs at least 3 pixels each way`);

  const label = slug(name ?? path.basename(file).replace(/\.[^.]+$/, "").replace(/\.9$/, ""));
  const dir = path.join(config.out, label, "ninepatch");
  await mkdir(dir, { recursive: true });

  const found = ninePatchInsets(art, insets);
  if (!found.given && !found.across.stretches && !found.down.stretches) {
    const why = found.across.split || found.down.split
      ? `something in the middle (an emblem, a glow, a label) splits the plain band, and stretching around it would push it off centre. Paint the panel plain and put the feature on top as its own image${found.crisp ? "" : ". If the panel really is plain, heavy compression noise can split it too (JPEG at low quality)"}`
      : "no band of alike lines holds the middle in either direction. A textured middle (wood, stone, a pattern) has to tile rather than stretch, which onmodel does not do yet";
    throw new Error(`this art cannot stretch as a nine-patch: ${why}; or give --insets to stretch it anyway and see the smear measured`);
  }
  const box = { left: found.left, top: found.top, right: found.right, bottom: found.bottom };
  const pad = content ? { left: content[0], top: content[1], right: content[2], bottom: content[3] } : box;
  if (pad.left + pad.right >= art.width || pad.top + pad.bottom >= art.height) throw new Error(`content padding ${[pad.left, pad.top, pad.right, pad.bottom].join(",")} leaves no room for content in a ${art.width}x${art.height} image`);
  const drawCenter = !centreIsEmpty(art, box);

  // Android resource names are lower case letters, digits and underscores.
  const android = label.replace(/[^a-z0-9_]+/g, "_").replace(/^[^a-z]+/, "") || "panel";
  const base = path.join(dir, label);
  const files = {
    image: `${base}.png`,
    stylebox: `${base}.stylebox.tres`,
    android: path.join(dir, `${android}.9.png`),
    css: `${base}.css`,
    preview: `${base}.preview.png`,
  };
  const texture = config.ninepatch?.resPath ? `${String(config.ninepatch.resPath).replace(/\/+$/, "")}/${label}.png` : `res://${label}.png`;
  await writeFile(files.image, encodePNG(art));
  await writeFile(`${files.image}.import`, godotImport({ pixel: Boolean(config.pixel) }));
  await writeFile(files.stylebox, styleBoxTexture({ texture, insets: box, content: pad, drawCenter }));
  await writeFile(files.android, encodePNG(androidNinePatch(art, box, pad)));
  await writeFile(files.css, ninePatchCSS({ file: `${label}.png`, className: label, insets: box, drawCenter }));
  await writeFile(files.preview, encodePNG(previewSheet(art, box)));

  const stretches = found.across.stretches && found.down.stretches;
  const smears = found.across.failing + found.down.failing;
  const verdict = smears ? "smears" : stretches ? "good" : found.across.stretches ? "across only" : "down only";
  const sides = [box.left, box.top, box.right, box.bottom];
  const facts = {
    width: art.width,
    height: art.height,
    sourceWidth: source.width,
    sourceHeight: source.height,
    scale: scale ?? 1,
    insets: box,
    content: pad,
    given: found.given,
    crisp: Boolean(found.crisp),
    fromAndroid: Boolean(fromAndroid),
    across: found.across,
    down: found.down,
    drawCenter,
    // The same insets in each engine's own order.
    godotNinePatchRect: { patch_margin_left: box.left, patch_margin_top: box.top, patch_margin_right: box.right, patch_margin_bottom: box.bottom },
    unityBorder: { left: box.left, bottom: box.bottom, right: box.right, top: box.top },
    cssSlice: `${box.top} ${box.right} ${box.bottom} ${box.left}`,
    // Mirror-symmetric art should get mirror-symmetric insets; a lopsided pair usually means
    // a shadow or a highlight on one side, which is worth a look.
    lopsided: Math.abs(box.left - box.right) > Math.max(2, art.width * 0.05) || Math.abs(box.top - box.bottom) > Math.max(2, art.height * 0.05),
    bigCorners: Math.max(...sides) > 64,
    verdict,
  };
  const summary = { tool: "onmodel", kind: "ninepatch", name: label, dir, mark: path.basename(file), generatedAt: new Date().toISOString(), files, facts };
  await writeFile(path.join(dir, "ninepatch.json"), JSON.stringify(summary, null, 2));
  log(`  ${label}: insets L${box.left} T${box.top} R${box.right} B${box.bottom}, ${verdict}\n`);
  return summary;
}

/** The art beside two stretched copies, so what stretching does can be seen at a glance. */
function previewSheet(art, insets) {
  const sizes = [
    [art.width, art.height],
    [Math.round(art.width * 2.2), Math.round(art.height * 1.4)],
    [Math.round(art.width * 1.2), Math.round(art.height * 2.2)],
  ].map(([w, h]) => [Math.max(w, insets.left + insets.right + 1), Math.max(h, insets.top + insets.bottom + 1)]);
  const gap = 16;
  const width = sizes.reduce((t, [w]) => t + w, 0) + gap * (sizes.length + 1);
  const height = Math.max(...sizes.map(([, h]) => h)) + gap * 2;
  const out = { width, height, data: new Uint8Array(width * height * 4) };
  let x = gap;
  for (const [w, h] of sizes) {
    const r = renderNinePatch(art, insets, w, h);
    for (let y = 0; y < h; y++) out.data.set(r.data.subarray(y * w * 4, (y + 1) * w * 4), ((gap + y) * width + x) * 4);
    x += w + gap;
  }
  return out;
}
