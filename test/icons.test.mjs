import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeICO, icoInfo } from "../src/ico.mjs";
import { checkIcon, ADAPTIVE, RULES_AS_OF } from "../src/rules.mjs";
import { placeMark, markRadius, chooseBackground, applyMask, MASKS, silhouetteOf, greyOf, makeIcons, loadMark } from "../src/icons.mjs";
import { colorCount } from "../src/key.mjs";
import { encodePNG, decodePNG } from "../src/png.mjs";
import { DEFAULTS, merge, validate } from "../src/config.mjs";

const blank = (w, h) => ({ width: w, height: h, data: new Uint8Array(w * h * 4) });
function disc(size, rgb, r = size / 2) {
  const img = blank(size, size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if ((x + 0.5 - size / 2) ** 2 + (y + 0.5 - size / 2) ** 2 <= r * r) img.data.set([...rgb, 255], (y * size + x) * 4);
  return img;
}
const px = (img, x, y) => Array.from(img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));
const PLUM = [106, 27, 90];

test("an icon file holds bitmaps for small sizes and PNG for 256, at the sizes asked", () => {
  const ico = encodeICO([disc(48, PLUM), disc(16, PLUM), disc(256, PLUM), disc(32, PLUM)]);
  assert.deepEqual(icoInfo(ico).map((e) => [e.width, e.format]), [[16, "bmp"], [32, "bmp"], [48, "bmp"], [256, "png"]], "sorted, small ones as bitmaps");
  assert.throws(() => encodeICO([blank(16, 8)]), /square/);
  assert.throws(() => encodeICO([]), /at least one/);
  // The 16 px bitmap: rows bottom up in BGRA, then the mask, and the centre pixel is plum.
  const e = icoInfo(ico)[0];
  const offset = ico.readUInt32LE(6 + 12);
  assert.equal(ico.readInt32LE(offset + 8), 32, "the bitmap height counts the mask rows too");
  const row = 15 - 8;
  const p = offset + 40 + (row * 16 + 8) * 4;
  assert.deepEqual([ico[p + 2], ico[p + 1], ico[p], ico[p + 3]], [...PLUM, 255]);
  assert.ok(e.bytes > 16 * 16 * 4);
});

test("the rulebook checks size, opacity, white-only, one colour, the safe zone and file size, and warns on logo size", () => {
  const ok = (checks) => checks.filter((c) => !c.ok && !c.warn).map((c) => c.check);
  assert.deepEqual(ok(checkIcon(disc(64, PLUM), 100, { width: 32, height: 32 })), ["size"]);
  assert.deepEqual(ok(checkIcon(disc(64, PLUM), 100, { opaque: true })), ["opaque"], "a disc on transparency is not opaque");
  assert.deepEqual(ok(checkIcon(disc(64, PLUM), 100, { whiteOnly: true })), ["white only"]);
  assert.deepEqual(ok(checkIcon(silhouetteOf(disc(64, PLUM)), 100, { whiteOnly: true, singleColour: true, transparent: true })), []);
  assert.deepEqual(ok(checkIcon(disc(64, PLUM, 32), 100, { safeRadius: 0.4 })), ["safe zone"], "a disc to the edge leaves a 40% circle");
  assert.deepEqual(ok(checkIcon(disc(64, PLUM, 24), 100, { safeRadius: 0.4 })), []);
  const fullBleed = disc(64, PLUM, 20);
  for (let i = 0; i < 64 * 64; i++) if (!fullBleed.data[i * 4 + 3]) fullBleed.data.set([244, 233, 241, 255], i * 4);
  assert.deepEqual(ok(checkIcon(fullBleed, 100, { safeRadius: 0.4 })), ["safe zone"], "the background counts unless it is named");
  assert.deepEqual(ok(checkIcon(fullBleed, 100, { safeRadius: 0.4, safeIgnore: "#f4e9f1" })), [], "named, the background is ignored and only the mark is held to the zone");
  assert.deepEqual(ok(checkIcon(disc(64, PLUM), 2_000_000, { maxBytes: 1024 * 1024 })), ["file size"]);
  const small = checkIcon(disc(108, PLUM, 10), 100, { logoMin: ADAPTIVE.logoMin / ADAPTIVE.layer });
  assert.equal(small[0].ok, false);
  assert.equal(small[0].warn, true, "a small logo is a warning, never a failure");
  assert.match(small[0].detail, /as large as the safe zone allows/);
  assert.match(checkIcon(disc(108, PLUM, 10), 100, { logoMin: 0.44, pixel: true })[0].detail, /scaled by whole numbers/);
  assert.equal(RULES_AS_OF, "2026-10-08");
});

test("a mark is placed by its real reach, so a round mark fills a circular safe zone, and pixel art stays hard", () => {
  const mark = disc(40, PLUM);
  assert.ok(Math.abs(markRadius(mark) - 20.5) < 1.5);
  const placed = placeMark(mark, 108, { radius: 33 / 108 });
  let far = 0;
  for (let y = 0; y < 108; y++) for (let x = 0; x < 108; x++) if (placed.data[(y * 108 + x) * 4 + 3] >= 16) far = Math.max(far, Math.hypot(x + 0.5 - 54, y + 0.5 - 54));
  assert.ok(far <= 33 && far > 30, `the disc reaches the safe circle and no further, fringe included: ${far}`);
  for (const size of [108, 162, 216, 324, 432]) {
    const at = placeMark(disc(97, PLUM), size, { radius: 33 / 108 });
    const r = (33 / 108) * size;
    let out = 0;
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (at.data[(y * size + x) * 4 + 3] >= 16 && Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) > r) out++;
    assert.equal(out, 0, `at ${size} px the antialiased edge stays inside the safe zone`);
  }
  const sprite = blank(8, 8);
  sprite.data.set([255, 0, 0, 255], 0);
  sprite.data.set([0, 0, 255, 255], (7 * 8 + 7) * 4);
  for (let i = 1; i < 63; i++) sprite.data.set([255, 220, 40, 255], i * 4);
  const big = placeMark(sprite, 100, { box: 1, pixel: true });
  assert.equal(colorCount(big), 3, "whole-number enlargement invents no colours");
  const boxed = placeMark({ width: 10, height: 10, data: new Uint8Array(400).fill(255) }, 64, { box: 0.5 });
  assert.equal(px(boxed, 32, 32)[3], 255);
  assert.equal(px(boxed, 4, 4)[3], 0);
});

test("the background is the first brand colour the mark stands out on, else the strongest contrast", () => {
  const plum = disc(40, PLUM);
  assert.deepEqual(chooseBackground(plum, ["#6a1b5a", "#a73669", "#f4e9f1"]).hex, "#f4e9f1", "plum on plum and magenta fail; blush stands out");
  const none = chooseBackground(plum, []);
  assert.equal(none.hex, "#ffffff");
  assert.match(none.reason, /no palette/);
  const cream = disc(40, [255, 230, 165]);
  assert.equal(chooseBackground(cream, ["#ffe6a5", "#ffdc28"]).hex, "#141418", "no brand colour stands out, so the strongest contrast wins");
});

test("masks cut the corners away and keep the middle; grey and silhouettes keep the alpha", () => {
  const sq = { width: 40, height: 40, data: new Uint8Array(40 * 40 * 4).fill(255) };
  const round = applyMask(sq, MASKS.circle);
  assert.equal(px(round, 0, 0)[3], 0);
  assert.equal(px(round, 20, 20)[3], 255);
  let partial = 0;
  for (let i = 3; i < round.data.length; i += 4) if (round.data[i] > 0 && round.data[i] < 255) partial++;
  assert.ok(partial > 20, `the edge is antialiased: ${partial} partly covered pixels`);
  const g = greyOf(disc(20, PLUM));
  const c = px(g, 10, 10);
  assert.ok(c[0] === c[1] && c[1] === c[2] && c[3] === 255);
  assert.equal(px(silhouetteOf(disc(20, PLUM), "#00ff00"), 10, 10)[1], 255);
});

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-icons-"));
  const config = validate(merge(DEFAULTS, { out: path.join(dir, "out"), palette: ["#6a1b5a", "#f4e9f1"] }));
  return { dir, config };
}

test("one mark becomes every platform's icons, all passing their rules, with the snippets to wire them", async () => {
  const { dir, config } = await setup();
  const markFile = path.join(dir, "mark.png");
  const mark = disc(300, PLUM);
  for (let y = 120; y < 180; y++) for (let x = 120; x < 180; x++) mark.data.set([255, 255, 255, 255], (y * 300 + x) * 4);
  await writeFile(markFile, encodePNG(mark));
  const result = await makeIcons({ config, markPath: markFile, log: () => {} });
  assert.equal(result.name, "mark");
  assert.equal(result.background.hex, "#f4e9f1");
  assert.deepEqual(result.failures, []);
  assert.equal(result.pixel, false);
  const file = (rel) => path.join(result.dir, rel);
  const size = async (rel) => {
    const img = decodePNG(await readFile(file(rel)));
    return `${img.width}x${img.height}`;
  };
  assert.equal(await size("android/res/mipmap-xxxhdpi/ic_launcher_foreground.png"), "432x432");
  assert.equal(await size("android/res/mipmap-mdpi/ic_launcher_foreground.png"), "108x108");
  assert.equal(await size("android/res/mipmap-xxhdpi/ic_launcher.png"), "144x144");
  assert.equal(await size("android/res/drawable-xhdpi/ic_stat_notify.png"), "48x48");
  assert.equal(await size("android/play-store-512.png"), "512x512");
  assert.equal(await size("ios/AppIcon.appiconset/AppIcon.png"), "1024x1024");
  assert.equal(await size("web/apple-touch-icon.png"), "180x180");
  assert.equal(await size("expo/adaptive-icon.png"), "1024x1024");
  assert.deepEqual(icoInfo(await readFile(file("web/favicon.ico"))).map((e) => e.width), [16, 32, 48]);
  const ios = decodePNG(await readFile(file("ios/AppIcon.appiconset/AppIcon.png")));
  assert.ok(Array.from({ length: 1024 * 1024 }, (_, i) => ios.data[i * 4 + 3]).every((a) => a === 255), "the App Store icon has no transparency");
  // App Store Connect rejects the alpha channel itself, so opaque icons are 24-bit.
  for (const rel of ["ios/AppIcon.appiconset/AppIcon.png", "web/apple-touch-icon.png", "expo/icon.png"]) assert.equal((await readFile(file(rel)))[25], 2, `${rel} is a 24-bit PNG with no alpha channel`);
  const appIcon = result.files.find((f) => f.rel === "ios/AppIcon.appiconset/AppIcon.png");
  assert.ok(appIcon.checks.some((c) => c.check === "no alpha channel" && c.ok), "the alpha-channel check runs and passes");
  assert.deepEqual(appIcon.rule, { width: 1024, height: 1024, opaque: true }, "the rule is recorded for check to re-apply");
  const contents = JSON.parse(await readFile(file("ios/AppIcon.appiconset/Contents.json"), "utf8"));
  assert.deepEqual(contents.images.map((i) => i.appearances?.[0]?.value ?? "default"), ["default", "dark", "tinted"]);
  assert.match(await readFile(file("android/res/mipmap-anydpi-v26/ic_launcher.xml"), "utf8"), /<monochrome android:drawable="@mipmap\/ic_launcher_monochrome" \/>/);
  assert.match(await readFile(file("android/res/values/ic_launcher_background.xml"), "utf8"), /#F4E9F1/);
  const manifest = JSON.parse(await readFile(file("web/manifest.webmanifest"), "utf8"));
  assert.ok(manifest.icons.some((i) => i.purpose === "maskable"));
  const app = JSON.parse(await readFile(file("expo/app.json"), "utf8"));
  assert.equal(app.expo.android.adaptiveIcon.backgroundColor, "#F4E9F1");
  assert.equal(app.expo.ios.icon.dark, "./assets/icon-dark.png");
  assert.equal(result.previews.length, 9);
  for (const p of result.previews) await access(p.path);
  const html = await readFile(result.htmlPath, "utf8");
  assert.match(html, /Every file passes its platform's rules/);
  assert.match(html, /adaptive-icon/);
  assert.match(html, /developer\.android\.com/);
  const json = JSON.parse(await readFile(path.join(result.dir, "icons.json"), "utf8"));
  assert.equal(json.rulesAsOf, RULES_AS_OF);
  assert.ok(json.files.length >= 50);
});

test("the mark is taken from a run's candidate, its grid output in pixel mode, and a missing one says so", async () => {
  const { dir, config } = await setup();
  const run = path.join(config.out, "player");
  await mkdir(run, { recursive: true });
  await writeFile(path.join(run, "02.png"), encodePNG(disc(200, PLUM)));
  await writeFile(path.join(run, "02.32x32.png"), encodePNG(disc(32, PLUM)));
  await writeFile(path.join(run, "generate.json"), JSON.stringify({ pick: 2 }));
  await writeFile(path.join(run, "02.json"), JSON.stringify({ files: { image: path.join(run, "02.png"), outputs: [{ width: 32, height: 32, file: path.join(run, "02.32x32.png") }] } }));
  const painted = await loadMark({ config, name: "player" });
  assert.equal(path.basename(painted.file), "02.png");
  const pixel = await loadMark({ config: { ...config, pixel: { grid: 32, colors: 8 } }, name: "player" });
  assert.equal(path.basename(pixel.file), "02.32x32.png", "pixel mode takes the sprite, not the painting");
  await assert.rejects(() => loadMark({ config, name: "player", candidate: "5" }), /no candidate 5/);
  await assert.rejects(() => loadMark({ config, name: "nobody" }), /no run/);
  await assert.rejects(() => loadMark({ config }), /--mark/);
  const emptyFile = path.join(dir, "empty.png");
  await writeFile(emptyFile, encodePNG(blank(10, 10)));
  await assert.rejects(() => loadMark({ config, markPath: emptyFile }), /is empty/);
  const opaque = path.join(dir, "opaque.png");
  const solid = { width: 10, height: 10, data: new Uint8Array(400) };
  for (let i = 0; i < 100; i++) solid.data.set([200, 200, 200, 255], i * 4);
  await writeFile(opaque, encodePNG(solid));
  assert.equal((await loadMark({ config, markPath: opaque })).transparent, false);
});
