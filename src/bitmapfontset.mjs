import { writeFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { decodeImage, encodePNG } from "./image.mjs";
import { slug } from "./generate.mjs";
import { loadFont } from "./font.mjs";
import { createHash } from "node:crypto";
import { ASCII, buildBitmapFont, writeFnt, writeFntXML, parseFnt, setText, fntFromBuild } from "./bmfont.mjs";

/**
 * `onmodel bitmapfont --font f.ttf --px 16`: a bitmap font from a real font, written as an
 * AngelCode .fnt with its page, which Godot imports as a FontFile and libGDX, raylib,
 * MonoGame and most other engines read as it is, and the same font as BMFont XML, the only
 * form Phaser loads.
 *
 * The proof is the preview: text is set from the .fnt and page read back off disk, and
 * again from the glyphs as they were built, and the two must agree pixel for pixel, so a
 * metric written one pixel out cannot pass.
 */

const digest = (v) => createHash("sha256").update(v).digest("hex").slice(0, 16);

const PANGRAMS = ["The quick brown fox jumps over the lazy dog.", "THE QUICK BROWN FOX JUMPS OVER THE LAZY DOG!", "0123456789 ?&@#%$*+-=/()[]{}<>,;:'\"_|~^`\\"];
const MAX_PREVIEW = 4096;

export async function makeBitmapFont({ config, fontPath, px = 16, chars = null, mono = false, cover = 50, kerning = true, name = null, log = (s) => process.stderr.write(s) }) {
  if (!fontPath) throw new Error("bitmapfont needs --font <a .ttf file>");
  let buffer;
  try {
    buffer = await readFile(fontPath);
  } catch (err) {
    throw new Error(`could not read the font ${fontPath}: ${err.message}`);
  }
  const font = loadFont(buffer);
  if (chars != null && !String(chars).length) throw new Error("--chars is empty; leave it out for printable ASCII, or give the characters to set");
  const set = chars ?? ASCII;
  const unique = [...new Set(Array.from(set))];
  if (unique.length > 512) throw new Error(`${unique.length} characters is more than one bitmap font page should carry; pass up to 512 with --chars`);
  const fileBase = path.basename(fontPath).replace(/\.[^.]+$/, "");
  const label = slug(name ?? `${fileBase}-${px}${mono ? "-mono" : ""}`);
  // Built before anything is written, so a font that cannot fit its page leaves no folder behind.
  const bm = buildBitmapFont(font, { px, chars: set, mono, cover, kerning });
  const dir = path.join(config.out, label, "bitmapfont");
  await mkdir(dir, { recursive: true });
  const files = {
    fnt: path.join(dir, `${label}.fnt`),
    xml: path.join(dir, `${label}.xml`),
    page: path.join(dir, `${label}_0.png`),
    preview: path.join(dir, `${label}.preview.png`),
  };
  const face = font.family ?? fileBase;
  await writeFile(files.page, encodePNG(bm.page));
  await writeFile(files.fnt, writeFnt(bm, { face, pageFile: path.basename(files.page) }));
  await writeFile(files.xml, writeFntXML(bm, { face, pageFile: path.basename(files.page) }));
  if (mono) {
    // A crisp font should scale by whole steps of its size and never be smoothed between them.
    files.import = `${files.fnt}.import`;
    await writeFile(files.import, "[params]\n\nscaling_mode=1\n");
  }

  // Set text from what is on disk now, and from what was built, and compare.
  const fromDisk = parseFnt(await readFile(files.fnt, "utf8"));
  const pageBack = decodeImage(await readFile(files.page));
  const have = new Set(bm.glyphs.map((g) => g.ch));
  const lines = PANGRAMS.map((l) => Array.from(l).filter((ch) => have.has(ch)).join("")).filter((l) => l.trim());
  const listed = bm.glyphs.filter((g) => !g.space).map((g) => g.ch);
  for (let i = 0; i < listed.length; i += 32) lines.push(listed.slice(i, i + 32).join(" "));
  // An advance only shows by moving what follows it, so for checking, every character (whitespace
  // too) is followed by one glyph with ink; a line's last glyph and a no-break space are tested too.
  const mark = bm.glyphs.find((g) => g.width && g.ch === "H")?.ch ?? bm.glyphs.find((g) => g.width)?.ch ?? null;
  const followed = mark ? bm.glyphs.map((g) => g.ch + mark) : [];
  // Every kerning pair set once, side by side, so a pair written wrong cannot hide in a pangram
  // that never used it.
  const pairs = bm.kernings.map((k) => String.fromCodePoint(k.first) + String.fromCodePoint(k.second));
  const checked = [...lines];
  for (let i = 0; i < followed.length; i += 24) checked.push(followed.slice(i, i + 24).join(""));
  for (let i = 0; i < pairs.length; i += 24) checked.push(pairs.slice(i, i + 24).join(" "));
  // Each line compared on its own, all of them, so a big font with many characters is checked
  // in full while the preview image stays a size anyone can open.
  const disk = { chars: fromDisk.chars, kernings: fromDisk.kernings, lineHeight: fromDisk.common.lineHeight, page: pageBack, base: fromDisk.common.base, refBase: bm.base };
  const built = fntFromBuild(bm);
  let differ = 0;
  for (const line of checked) {
    const a = setText([line], disk);
    const b = setText([line], built);
    if (a.width !== b.width || a.height !== b.height) differ += Math.max(a.width * a.height, b.width * b.height);
    else for (let i = 0; i < a.data.length; i += 4) if (a.data[i] !== b.data[i] || a.data[i + 1] !== b.data[i + 1] || a.data[i + 2] !== b.data[i + 2]) differ++;
  }
  const rows = Math.max(1, Math.min(lines.length, Math.floor((MAX_PREVIEW - 8) / bm.lineHeight)));
  const shown = lines.slice(0, rows);
  await writeFile(files.preview, encodePNG(setText(shown, disk)));

  const verdict = differ ? "mismatch" : bm.lost.length ? "lost" : bm.missing.length || bm.blank.length ? "incomplete" : "complete";
  const facts = {
    px,
    face,
    mono,
    cover: mono ? cover : null,
    lineHeight: bm.lineHeight,
    base: bm.base,
    pageWidth: bm.page.width,
    pageHeight: bm.page.height,
    requested: unique.length,
    written: bm.glyphs.length,
    missing: bm.missing,
    blank: bm.blank,
    lost: bm.lost,
    broken: bm.broken,
    syntheticSpace: bm.syntheticSpace,
    kerning: kerning ? font.kerning : "off",
    kernings: bm.kernings.length,
    previewLines: shown.length,
    linesChecked: checked.length,
    pairsChecked: pairs.length,
    previewDiffers: differ,
    // What was written, so the gate can tell when the .fnt or its page changed afterwards.
    fntDigest: digest((await readFile(files.fnt, "utf8")).replace(/\r\n/g, "\n")),
    pageDigest: digest(Buffer.from(pageBack.data)),
    verdict,
  };
  const summary = { tool: "onmodel", kind: "bitmapfont", name: label, dir, font: path.basename(fontPath), generatedAt: new Date().toISOString(), files, facts };
  await writeFile(path.join(dir, "bitmapfont.json"), JSON.stringify(summary, null, 2));
  log(`  ${label}: ${bm.glyphs.length} glyphs at ${px}px on a ${bm.page.width}x${bm.page.height} page, ${bm.kernings.length} kerning pairs, ${verdict}\n`);
  return summary;
}
