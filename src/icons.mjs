import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { decodeImage, encodePNG } from "./image.mjs";
import { trim, resize, blit, alphaBounds, fillBackground } from "./key.mjs";
import { parseColor, toHex } from "./color.mjs";
import { contrastRatio } from "./pixels.mjs";
import { dominantPalette } from "./measure.mjs";
import { encodeICO, icoInfo } from "./ico.mjs";
import { checkIcon, DENSITIES, ADAPTIVE, MASKABLE_SAFE_RADIUS, PLAY_MAX_BYTES, RULES_AS_OF, RULE_SOURCES } from "./rules.mjs";
import { slug } from "./generate.mjs";
import { parseCandidateId, fileBase } from "./edit.mjs";
import { renderIconsHTML } from "./html.mjs";

/**
 * One mark, every icon a platform asks for: Android adaptive layers at every
 * density with the monochrome layer and the XML that wires them, legacy and round
 * launcher icons, notification icons, the Play Store icon; the iOS asset catalog
 * with its dark and tinted variants and the layer to import into Icon Composer;
 * the web's favicons, touch icon and manifest icons with a maskable one; and the
 * Expo files with the app.json lines. Nothing is generated here: it is all
 * derived from the mark, so it can be rebuilt whenever the mark changes, and every
 * file is checked against the rulebook before it is reported as done.
 */

const round = (v, places = 2) => Math.round(v * 10 ** places) / 10 ** places;
const blank = (width, height) => ({ width, height, data: new Uint8Array(width * height * 4) });
const rgbOf = (hex) => parseColor(hex).rgb;

/** How far the mark's visible pixels reach from its centre, in its own pixels. */
export function markRadius(mark) {
  const cx = mark.width / 2;
  const cy = mark.height / 2;
  let r = 0;
  for (let y = 0; y < mark.height; y++) {
    for (let x = 0; x < mark.width; x++) {
      if (mark.data[(y * mark.width + x) * 4 + 3] < 16) continue;
      const d = Math.hypot(Math.abs(x + 0.5 - cx) + 0.5, Math.abs(y + 0.5 - cy) + 0.5);
      if (d > r) r = d;
    }
  }
  return r || Math.hypot(cx, cy);
}

/**
 * The mark on a transparent square of `size`, centred. `radius` (a share of the
 * size) fits the mark by its real reach from the centre, which is what a circular
 * safe zone asks; `box` fits its bounding box. Pixel art is enlarged by a whole
 * number with hard pixels, never blurred.
 */
export function placeMark(mark, size, { radius = null, box = null, pixel = false } = {}) {
  // Resampling softens the edge: shrinking leaves a fringe up to a destination
  // pixel wide, and enlarging spreads it over about half a source pixel more, so a
  // radius fit leaves room for both or the fringe pokes out of a safe zone. Hard
  // pixel art has no fringe and needs neither.
  const reach = markRadius(mark) + (pixel ? 0 : 0.5);
  let s = radius ? (radius * size - (pixel ? 0 : 1)) / reach : ((box ?? 1) * size) / Math.max(mark.width, mark.height);
  s = Math.min(s, size / Math.max(mark.width, mark.height));
  let scaled;
  if (pixel && s >= 1) {
    const k = Math.max(1, Math.floor(s));
    scaled = resize(mark, mark.width * k, mark.height * k, { filter: "nearest" });
  } else scaled = resize(mark, Math.max(1, Math.round(mark.width * s)), Math.max(1, Math.round(mark.height * s)), { filter: pixel ? "box" : "auto" });
  const out = blank(size, size);
  blit(out, scaled, Math.floor((size - scaled.width) / 2), Math.floor((size - scaled.height) / 2));
  return out;
}

/** Source over: `top` drawn on `bottom`, both the same size. */
export function over(bottom, top) {
  const out = { width: bottom.width, height: bottom.height, data: new Uint8Array(bottom.data) };
  for (let i = 0; i < out.width * out.height; i++) {
    const p = i * 4;
    const a = top.data[p + 3] / 255;
    if (!a) continue;
    const b = out.data[p + 3] / 255;
    const oa = a + b * (1 - a);
    for (let c = 0; c < 3; c++) out.data[p + c] = Math.round((top.data[p + c] * a + out.data[p + c] * b * (1 - a)) / oa);
    out.data[p + 3] = Math.round(oa * 255);
  }
  return out;
}

/** Shapes as functions of u, v in -1..1: true inside. */
const rounded = (r) => (u, v) => {
  const ax = Math.abs(u);
  const ay = Math.abs(v);
  if (ax > 1 || ay > 1) return false;
  if (ax <= 1 - r || ay <= 1 - r) return true;
  return (ax - (1 - r)) ** 2 + (ay - (1 - r)) ** 2 <= r * r;
};
export const MASKS = {
  circle: (u, v) => u * u + v * v <= 1,
  squircle: (u, v) => Math.abs(u) ** 4 + Math.abs(v) ** 4 <= 1,
  "rounded square": rounded(0.4),
  teardrop: (u, v) => (u > 0 && v > 0 ? rounded(0.2) : rounded(1))(u, v),
  "app icon": (u, v) => Math.abs(u) ** 5 + Math.abs(v) ** 5 <= 1,
};

/** The image cut to a shape, its edge antialiased by sampling each pixel 4 x 4. */
export function applyMask(image, inside) {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      let hits = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const u = ((x + (sx + 0.5) / 4) / image.width) * 2 - 1;
          const v = ((y + (sy + 0.5) / 4) / image.height) * 2 - 1;
          if (inside(u, v)) hits++;
        }
      }
      out.data[(y * image.width + x) * 4 + 3] = Math.round((out.data[(y * image.width + x) * 4 + 3] * hits) / 16);
    }
  }
  return out;
}

/** A square of `size` filled with a shape in a colour, inset by `inset` of the size. */
function shapeFill(size, hex, inside, inset = 0) {
  const filled = fillBackground(blank(size, size), hex);
  const shrink = (u, v) => inside(u / (1 - inset * 2), v / (1 - inset * 2));
  return applyMask(filled, shrink);
}

/** The mark as one colour, keeping its alpha: what a themed icon or a notification is. */
export function silhouetteOf(image, hex = "#ffffff") {
  const [r, g, b] = rgbOf(hex);
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data.length) };
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4;
    if (!image.data[p + 3]) continue;
    out.data[p] = r;
    out.data[p + 1] = g;
    out.data[p + 2] = b;
    out.data[p + 3] = image.data[p + 3];
  }
  return out;
}

/** The mark in grey, by luminance: what the system colours for a tinted icon. */
export function greyOf(image) {
  const out = { width: image.width, height: image.height, data: new Uint8Array(image.data) };
  for (let i = 0; i < image.width * image.height; i++) {
    const p = i * 4;
    const l = Math.round(0.2126 * image.data[p] + 0.7152 * image.data[p + 1] + 0.0722 * image.data[p + 2]);
    out.data[p] = out.data[p + 1] = out.data[p + 2] = l;
  }
  return out;
}

/**
 * The colour behind the mark: the first brand colour, in the brief's order, that
 * the mark's main colour stands out on (a contrast of 3 or more, what large
 * graphics need), else whichever of the brand colours, white and near-black
 * stands out most.
 */
export function chooseBackground(mark, palette = []) {
  const main = dominantPalette(mark, { count: 1 })[0]?.color ?? [0, 0, 0];
  for (const hex of palette) {
    const c = contrastRatio(rgbOf(hex), main);
    if (c >= 3) return { hex: toHex(rgbOf(hex)), contrast: round(c), reason: "the first brand colour the mark stands out on" };
  }
  const options = [...palette, "#ffffff", "#141418"].map((hex) => ({ hex: toHex(rgbOf(hex)), contrast: round(contrastRatio(rgbOf(hex), main)) }));
  const best = options.sort((a, b) => b.contrast - a.contrast)[0];
  return { ...best, reason: palette.length ? "no brand colour stood out enough against the mark, so the strongest contrast was taken" : "no palette, so the strongest contrast was taken" };
}

const xml = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

/** Builds every icon in memory: [{ rel, image | buffer, rule, platform, note }]. */
export function buildIcons(mark, { background, pixel = false, name = "app" }) {
  const files = [];
  const add = (platform, rel, image, rule = null, note = null) => files.push({ platform, rel, image, rule, note });
  const safeR = ADAPTIVE.safe / 2 / ADAPTIVE.layer;
  const onBg = (size, radius) => over(fillBackground(blank(size, size), background), placeMark(mark, size, { radius, pixel }));

  // Android
  for (const [d, k] of Object.entries(DENSITIES)) {
    const layer = Math.round(ADAPTIVE.layer * k);
    const fg = placeMark(mark, layer, { radius: safeR, pixel });
    add("android", `android/res/mipmap-${d}/ic_launcher_foreground.png`, fg, { width: layer, height: layer, transparent: true, safeRadius: safeR, logoMin: ADAPTIVE.logoMin / ADAPTIVE.layer, pixel });
    add("android", `android/res/mipmap-${d}/ic_launcher_monochrome.png`, silhouetteOf(fg), { width: layer, height: layer, transparent: true, singleColour: true, safeRadius: safeR });
    const legacy = Math.round(48 * k);
    add("android", `android/res/mipmap-${d}/ic_launcher.png`, over(shapeFill(legacy, background, MASKS["rounded square"], 1 / 24), placeMark(mark, legacy, { radius: 0.3, pixel })), { width: legacy, height: legacy });
    add("android", `android/res/mipmap-${d}/ic_launcher_round.png`, over(shapeFill(legacy, background, MASKS.circle, 1 / 48), placeMark(mark, legacy, { radius: 0.29, pixel })), { width: legacy, height: legacy });
    const note = Math.round(24 * k);
    add("android", `android/res/drawable-${d}/ic_stat_notify.png`, silhouetteOf(placeMark(mark, note, { box: 20 / 24, pixel })), { width: note, height: note, transparent: true, whiteOnly: true });
  }
  add("android", "android/play-store-512.png", onBg(512, 0.36), { width: 512, height: 512, maxBytes: PLAY_MAX_BYTES });
  const adaptive = `<?xml version="1.0" encoding="utf-8"?>\n<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">\n    <background android:drawable="@color/ic_launcher_background" />\n    <foreground android:drawable="@mipmap/ic_launcher_foreground" />\n    <monochrome android:drawable="@mipmap/ic_launcher_monochrome" />\n</adaptive-icon>\n`;
  add("android", "android/res/mipmap-anydpi-v26/ic_launcher.xml", Buffer.from(adaptive));
  add("android", "android/res/mipmap-anydpi-v26/ic_launcher_round.xml", Buffer.from(adaptive));
  add("android", "android/res/values/ic_launcher_background.xml", Buffer.from(`<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">${background.toUpperCase()}</color>\n</resources>\n`));

  // iOS
  const iosRadius = 0.36;
  add("ios", "ios/AppIcon.appiconset/AppIcon.png", onBg(1024, iosRadius), { width: 1024, height: 1024, opaque: true }, "the default icon; flattened, which Xcode still accepts");
  add("ios", "ios/AppIcon.appiconset/AppIcon-dark.png", placeMark(mark, 1024, { radius: iosRadius, pixel }), { width: 1024, height: 1024, transparent: true }, "dark: the mark alone; the system draws the dark background");
  add("ios", "ios/AppIcon.appiconset/AppIcon-tinted.png", greyOf(placeMark(mark, 1024, { radius: iosRadius, pixel })), { width: 1024, height: 1024, transparent: true }, "tinted: the mark in grey; the system colours it");
  const contents = {
    images: [
      { filename: "AppIcon.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      { appearances: [{ appearance: "luminosity", value: "dark" }], filename: "AppIcon-dark.png", idiom: "universal", platform: "ios", size: "1024x1024" },
      { appearances: [{ appearance: "luminosity", value: "tinted" }], filename: "AppIcon-tinted.png", idiom: "universal", platform: "ios", size: "1024x1024" },
    ],
    info: { author: "onmodel", version: 1 },
  };
  add("ios", "ios/AppIcon.appiconset/Contents.json", Buffer.from(JSON.stringify(contents, null, 2) + "\n"));
  add("ios", "ios/icon-composer/foreground.png", placeMark(mark, 1024, { radius: iosRadius, pixel }), { width: 1024, height: 1024, transparent: true }, "the foreground layer to import into Icon Composer, with the background colour below");
  add("ios", "ios/icon-composer/README.txt", Buffer.from(`Icon Composer (Xcode 26 and later) builds layered icons with Liquid Glass.\nImport foreground.png as the foreground layer and set the background to ${background.toUpperCase()}.\nUntil then, AppIcon.appiconset is a flattened icon Xcode accepts as it is.\n`));

  // Web
  const fav = (size) => placeMark(mark, size, { box: 0.94, pixel });
  add("web", "web/favicon.ico", encodeICO([fav(16), fav(32), fav(48)]), { ico: [16, 32, 48] });
  add("web", "web/favicon-16x16.png", fav(16), { width: 16, height: 16 });
  add("web", "web/favicon-32x32.png", fav(32), { width: 32, height: 32 });
  add("web", "web/apple-touch-icon.png", onBg(180, iosRadius), { width: 180, height: 180, opaque: true });
  add("web", "web/icon-192.png", onBg(192, iosRadius), { width: 192, height: 192 });
  add("web", "web/icon-512.png", onBg(512, iosRadius), { width: 512, height: 512 });
  add("web", "web/icon-maskable-512.png", onBg(512, MASKABLE_SAFE_RADIUS), { width: 512, height: 512, opaque: true, safeRadius: MASKABLE_SAFE_RADIUS, safeIgnore: background });
  const manifest = {
    name,
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    background_color: background,
    theme_color: background,
  };
  add("web", "web/manifest.webmanifest", Buffer.from(JSON.stringify(manifest, null, 2) + "\n"));
  add(
    "web",
    "web/head.html",
    Buffer.from(
      `<link rel="icon" href="/favicon.ico" sizes="48x48">\n<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">\n<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">\n<link rel="apple-touch-icon" href="/apple-touch-icon.png">\n<link rel="manifest" href="/manifest.webmanifest">\n<meta name="theme-color" content="${xml(background)}">\n`,
    ),
  );

  // Expo
  add("expo", "expo/icon.png", onBg(1024, iosRadius), { width: 1024, height: 1024, opaque: true });
  const expoFg = placeMark(mark, 1024, { radius: safeR, pixel });
  add("expo", "expo/adaptive-icon.png", expoFg, { width: 1024, height: 1024, transparent: true, safeRadius: safeR, logoMin: ADAPTIVE.logoMin / ADAPTIVE.layer, pixel });
  add("expo", "expo/adaptive-icon-monochrome.png", silhouetteOf(expoFg), { width: 1024, height: 1024, transparent: true, singleColour: true, safeRadius: safeR });
  add("expo", "expo/icon-dark.png", placeMark(mark, 1024, { radius: iosRadius, pixel }), { width: 1024, height: 1024, transparent: true });
  add("expo", "expo/icon-tinted.png", greyOf(placeMark(mark, 1024, { radius: iosRadius, pixel })), { width: 1024, height: 1024, transparent: true });
  const appJson = {
    expo: {
      icon: "./assets/icon.png",
      android: { adaptiveIcon: { foregroundImage: "./assets/adaptive-icon.png", monochromeImage: "./assets/adaptive-icon-monochrome.png", backgroundColor: background.toUpperCase() } },
      ios: { icon: { light: "./assets/icon.png", dark: "./assets/icon-dark.png", tinted: "./assets/icon-tinted.png" } },
    },
  };
  add("expo", "expo/app.json", Buffer.from(JSON.stringify(appJson, null, 2) + "\n"), null, "the lines to merge into app.json; copy the PNGs to ./assets");
  return files;
}

/** How each platform will show the icon: the shapes launchers cut it to, and the tinted silhouettes. */
export function buildPreviews(mark, { background, pixel = false }) {
  const safeR = ADAPTIVE.safe / 2 / ADAPTIVE.layer;
  const layer = 432;
  const composed = over(fillBackground(blank(layer, layer), background), placeMark(mark, layer, { radius: safeR, pixel }));
  const view = Math.round((ADAPTIVE.viewport / ADAPTIVE.layer) * layer);
  const off = Math.round((layer - view) / 2);
  const viewport = blank(view, view);
  for (let y = 0; y < view; y++) viewport.data.set(composed.data.subarray(((y + off) * layer + off) * 4, ((y + off) * layer + off + view) * 4), y * view * 4);
  const previews = [];
  for (const shape of ["circle", "squircle", "rounded square", "teardrop"]) previews.push({ rel: `previews/android-${shape.replace(/ /g, "-")}.png`, caption: `Android, ${shape} mask`, image: applyMask(viewport, MASKS[shape]) });
  const ios = over(fillBackground(blank(512, 512), background), placeMark(mark, 512, { radius: 0.36, pixel }));
  previews.push({ rel: "previews/ios.png", caption: "iOS, system mask", image: applyMask(ios, MASKS["app icon"]) });
  const maskable = over(fillBackground(blank(512, 512), background), placeMark(mark, 512, { radius: MASKABLE_SAFE_RADIUS, pixel }));
  previews.push({ rel: "previews/maskable-circle.png", caption: "Web, maskable icon in a circle", image: applyMask(maskable, MASKS.circle) });
  const mono = silhouetteOf(placeMark(mark, 192, { radius: safeR * (108 / 72), pixel }), "#a8c7fa");
  previews.push({ rel: "previews/themed.png", caption: "Android themed icon, as a launcher tints it", image: applyMask(over(fillBackground(blank(192, 192), "#1f2a3c"), mono), MASKS.circle) });
  const notification = silhouetteOf(placeMark(mark, 96, { box: 20 / 24, pixel }));
  previews.push({ rel: "previews/notification.png", caption: "Notification icon on a dark bar", image: over(fillBackground(blank(96, 96), "#202124"), notification) });
  const fav = placeMark(mark, 16, { box: 0.94, pixel });
  previews.push({ rel: "previews/favicon-16-x8.png", caption: "Favicon at 16 px, enlarged 8 times", image: resize(over(fillBackground(blank(16, 16), "#ffffff"), fav), 128, 128, { filter: "nearest" }) });
  return previews;
}

/** Where the mark comes from: a file, or a candidate (or edit) of a run, preferring its grid output in pixel mode. */
export async function loadMark({ config, name = null, candidate = null, markPath = null }) {
  let file = markPath;
  if (!file) {
    if (!name) throw new Error("icons needs --mark <file> or --name <run> to take the mark from");
    const dir = path.join(config.out, slug(name));
    let summary;
    try {
      summary = JSON.parse(await readFile(path.join(dir, "generate.json"), "utf8"));
    } catch {
      throw new Error(`no run in ${dir} to take a mark from; pass --mark <file>`);
    }
    if (candidate == null && summary.pick == null) throw new Error("icons needs --candidate: the run has no pick");
    const id = parseCandidateId(candidate ?? summary.pick);
    let sidecar;
    try {
      sidecar = JSON.parse(await readFile(path.join(dir, `${fileBase(id)}.json`), "utf8"));
    } catch {
      throw new Error(`there is no candidate ${id.id} in ${dir}`);
    }
    const grid = config.pixel ? (sidecar.files?.outputs ?? []).find((o) => o.width === config.pixel.grid && o.height === config.pixel.grid) : null;
    file = grid?.file ?? sidecar.files?.image;
    if (!file) throw new Error(`candidate ${id.id} was not painted`);
  }
  const raw = decodeImage(await readFile(file));
  if (!alphaBounds(raw)) throw new Error(`${file} is empty: nothing in it is visible`);
  const mark = trim(raw);
  let transparent = false;
  for (let i = 3; i < raw.data.length; i += 4) if (raw.data[i] < 255) {
    transparent = true;
    break;
  }
  return { mark, file, transparent };
}

export async function makeIcons({ config, name = null, candidate = null, markPath = null, background = null, log = (s) => process.stderr.write(s) }) {
  const { mark, file, transparent } = await loadMark({ config, name, candidate, markPath });
  const label = slug(name ?? path.basename(file).replace(/\.[^.]+$/, ""));
  const pixel = Boolean(config.pixel) || Math.max(mark.width, mark.height) <= 128;
  const bg = background ? { hex: toHex(rgbOf(background)), contrast: round(contrastRatio(rgbOf(background), dominantPalette(mark, { count: 1 })[0]?.color ?? [0, 0, 0])), reason: "set by --background" } : chooseBackground(mark, config.palette);
  const dir = path.join(config.out, label, "icons");
  if (!transparent) log(`  the mark has no transparency, so it will sit on the background as a square; a keyed mark from generate looks better\n`);
  log(`  ${label}: icons from ${path.basename(file)} (${mark.width}x${mark.height}${pixel ? ", pixel art, hard pixels" : ""}), on ${bg.hex} (contrast ${bg.contrast}, ${bg.reason})\n`);

  const files = buildIcons(mark, { background: bg.hex, pixel, name: label });
  const written = [];
  for (const f of files) {
    const target = path.join(dir, f.rel);
    await mkdir(path.dirname(target), { recursive: true });
    const buffer = f.image && !Buffer.isBuffer(f.image) ? encodePNG(f.image) : f.image;
    await writeFile(target, buffer);
    const entry = { platform: f.platform, path: target, rel: f.rel, bytes: buffer.length, note: f.note ?? null, rule: f.rule ?? null, checks: [] };
    if (/\.(xml|json|html|webmanifest|txt)$/.test(f.rel)) entry.text = buffer.toString("utf8");
    if (f.image && !Buffer.isBuffer(f.image)) {
      entry.width = f.image.width;
      entry.height = f.image.height;
      if (f.rule) entry.checks = checkIcon(f.image, buffer.length, f.rule);
    } else if (f.rule?.ico) {
      const sizes = icoInfo(buffer).map((e) => e.width);
      entry.checks = [{ check: "sizes", ok: f.rule.ico.every((s) => sizes.includes(s)), detail: `holds ${sizes.join(", ")} px; needs ${f.rule.ico.join(", ")}` }];
    }
    written.push(entry);
  }
  const previews = buildPreviews(mark, { background: bg.hex, pixel });
  for (const p of previews) {
    p.path = path.join(dir, p.rel);
    await mkdir(path.dirname(p.path), { recursive: true });
    await writeFile(p.path, encodePNG(p.image));
    delete p.image;
  }
  const failures = written.flatMap((f) => f.checks.filter((c) => !c.ok && !c.warn).map((c) => ({ file: f.rel, ...c })));
  const warnings = written.flatMap((f) => f.checks.filter((c) => !c.ok && c.warn).map((c) => ({ file: f.rel, ...c })));
  const summary = { tool: "onmodel", kind: "icons", name: label, dir, mark: file, markSize: { width: mark.width, height: mark.height }, pixel, transparent, background: bg, rulesAsOf: RULES_AS_OF, sources: RULE_SOURCES, files: written, previews, failures, warnings, generatedAt: new Date().toISOString() };
  await writeFile(path.join(dir, "icons.json"), JSON.stringify(summary, null, 2));
  const htmlPath = path.join(dir, "icons.html");
  await writeFile(htmlPath, renderIconsHTML(summary, dir));
  log(`  ${written.length} files, ${written.reduce((t, f) => t + f.checks.length, 0)} checks, ${failures.length} failed, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}\n`);
  return { ...summary, htmlPath };
}
