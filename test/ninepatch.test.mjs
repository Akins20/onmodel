import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { findBand, ninePatchInsets, renderNinePatch, androidNinePatch, readAndroidNinePatch, styleBoxTexture, ninePatchCSS, centreIsEmpty, isCrisp } from "../src/ninepatch.mjs";
import { loadFont, textPath } from "../src/font.mjs";
import { pathToPolygons, coverage } from "../src/vector.mjs";
import { makeNinePatch } from "../src/ninepatchset.mjs";
import { checkRun, failuresOf } from "../src/check.mjs";
import { encodePNG } from "../src/png.mjs";
import { decodeImage } from "../src/image.mjs";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "onmodel.mjs");

/**
 * A rounded UI panel, anti-aliased by supersampling, with the things real art carries: an
 * outline that wobbles by a fraction of a pixel, noise, a gradient, and optionally a
 * feature in the middle that must not be stretched.
 */
function panel(W, H, { R = 12, B = 4, wobble = 0, noise = 0, seed = 7, emblem = 0, dot = false, glow = 0, vgrad = 0 } = {}) {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  const gauss = () => {
    let u = 0;
    while (!u) u = rnd();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rnd());
  };
  const d = new Uint8Array(W * H * 4);
  const phase = rnd() * 6.28;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let cov = 0;
      let inner = 0;
      for (let sy = 0; sy < 4; sy++) {
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4;
          const py = y + (sy + 0.5) / 4;
          const w = wobble * Math.sin(px * 0.37 + py * 0.29 + phase);
          const inside = (m, r) => {
            const cx = Math.min(Math.max(px, m + r), W - m - r);
            const cy = Math.min(Math.max(py, m + r), H - m - r);
            return Math.hypot(px - cx, py - cy) <= r + w;
          };
          if (inside(0, R)) cov++;
          if (inside(B, Math.max(1, R - B))) inner++;
        }
      }
      const t = inner / 16;
      let c = [232 * t + 40 * (1 - t), 236 * t + 52 * (1 - t), 244 * t + 86 * (1 - t)];
      if (vgrad) c = c.map((v) => v - vgrad * (y / H));
      if (emblem && Math.hypot(x - W / 2, y - H / 2) < emblem) c = [200, 60, 60];
      if (dot && Math.hypot(x - W / 2 - 3, y - H / 2) < 1.6) c = [180, 180, 190];
      if (glow) {
        const g = glow * Math.exp(-((x - W / 2) ** 2 + (y - H / 2) ** 2) / (2 * 18 * 18));
        c = c.map((v) => v - g);
      }
      d.set([...c.map((v) => Math.max(0, Math.min(255, Math.round(v + noise * gauss())))), Math.round((cov / 16) * 255)], (y * W + x) * 4);
    }
  }
  return { width: W, height: H, data: d };
}

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} is not within ${tol} of ${b}`);

test("a clean rounded panel stretches both ways from just inside its corners", () => {
  const i = ninePatchInsets(panel(160, 96));
  assert.ok(i.across.stretches && i.down.stretches);
  for (const side of ["left", "top", "right", "bottom"]) near(i[side], 10, 1, side);
});

test("wobble, noise and gradients do not cut the band short", () => {
  // Demanding exact sameness found bands a few pixels wide in panels like these; every one
  // of them stretches cleanly, and mirror-symmetric art must get mirror-symmetric insets.
  const cases = [
    ["wobble 0.3", { wobble: 0.3 }],
    ["noise 4", { noise: 4, seed: 1 }],
    ["noise 8", { noise: 8, seed: 7 }],
    ["wobble and noise", { wobble: 0.3, noise: 4 }],
    ["vertical gradient", { vgrad: 80 }],
    ["gradient and noise", { vgrad: 80, noise: 4, seed: 3 }],
  ];
  for (const [label, opts] of cases) {
    const i = ninePatchInsets(panel(160, 96, opts));
    assert.ok(i.across.stretches && i.down.stretches, label);
    near(i.left, i.right, 2, `${label} left vs right`);
    near(i.top, i.bottom, 2, `${label} top vs bottom`);
    assert.ok(i.left <= 12 && i.top <= 12, `${label}: the band reaches the corners (${i.left}, ${i.top})`);
  }
  const big = ninePatchInsets(panel(640, 400, { R: 50, B: 10, wobble: 0.3, noise: 3 }));
  assert.ok(big.across.lines > 500 && big.down.lines > 300, "a big panel keeps a big band");
});

test("a feature in the middle is never stretched", () => {
  // An emblem or a glow splits the plain band; taking either half would leave the feature
  // in a fixed corner and push it off centre as the panel grows.
  const emblem = ninePatchInsets(panel(160, 96, { emblem: 24 }));
  assert.equal(emblem.across.stretches, false);
  assert.equal(emblem.across.split, true);
  const glow = ninePatchInsets(panel(160, 96, { glow: 55 }));
  assert.ok(!glow.across.stretches && !glow.down.stretches, "a soft glow is a feature too");
  // A dot three pixels across on a plain fill, and on a gradient.
  assert.ok(!ninePatchInsets(panel(160, 96, { dot: true })).down.stretches);
  const onGradient = panel(160, 96, { vgrad: 80 });
  for (let y = 46; y < 50; y++) for (let x = 60; x < 63; x++) onGradient.data.set([150, 150, 160, 255], (y * 160 + x) * 4);
  assert.equal(ninePatchInsets(onGradient).down.stretches, false);
});

test("given insets are measured, not trusted", () => {
  const smear = ninePatchInsets(panel(160, 96, { emblem: 24 }), [40, 20, 40, 20]);
  assert.equal(smear.given, true);
  assert.ok(smear.across.failing > 0 && smear.down.failing > 0, "stretching through the emblem is measured as a smear");
  const clean = ninePatchInsets(panel(160, 96), [14, 14, 14, 14]);
  assert.equal(clean.across.failing + clean.down.failing, 0);
  assert.throws(() => ninePatchInsets(panel(160, 96), [80, 0, 80, 0]), /nothing to stretch/);
});

test("the Android nine-patch round-trips, and a bad border is named", () => {
  const art = panel(40, 30, { R: 6, B: 2 });
  const ins = { left: 7, top: 6, right: 8, bottom: 5 };
  const pad = { left: 9, top: 7, right: 9, bottom: 7 };
  const np = androidNinePatch(art, ins, pad);
  assert.equal(np.width, 42);
  const back = readAndroidNinePatch(np);
  assert.deepEqual(back.problems, []);
  assert.deepEqual(back.insets, ins);
  assert.deepEqual(back.content, pad);
  assert.deepEqual([...back.art.data], [...art.data]);

  const grey = { ...np, data: Uint8Array.from(np.data) };
  grey.data.set([0, 0, 0, 128], 20 * 4);
  assert.match(readAndroidNinePatch(grey).problems.join(), /neither the border's clear colour nor opaque black/);
  // Two stretch regions across are valid Android, held apart on purpose; they are counted, so the
  // command can say plainly why it cannot convert them, rather than calling the file invalid.
  const split = { ...np, data: Uint8Array.from(np.data) };
  split.data.set([0, 0, 0, 0], 20 * 4);
  const two = readAndroidNinePatch(split);
  assert.deepEqual(two.problems, []);
  assert.equal(two.regions.across, 2);

  // Red layout-bound ticks on the bottom and right do not change stretching, and the legacy
  // opaque white border is what aapt accepts as clear.
  const bounds = { ...np, data: Uint8Array.from(np.data) };
  bounds.data.set([255, 0, 0, 255], ((np.height - 1) * np.width + 2) * 4);
  const withBounds = readAndroidNinePatch(bounds);
  assert.deepEqual(withBounds.problems, []);
  assert.deepEqual(withBounds.insets, ins);
  assert.equal(withBounds.notes.length, 1);
  const white = { ...np, data: Uint8Array.from(np.data) };
  for (let x = 0; x < np.width; x++) {
    for (const y of [0, np.height - 1]) if (white.data[(y * np.width + x) * 4 + 3] === 0) white.data.set([255, 255, 255, 255], (y * np.width + x) * 4);
  }
  for (let y = 0; y < np.height; y++) {
    for (const x of [0, np.width - 1]) if (white.data[(y * np.width + x) * 4 + 3] === 0) white.data.set([255, 255, 255, 255], (y * np.width + x) * 4);
  }
  const whiteRead = readAndroidNinePatch(white);
  assert.deepEqual(whiteRead.problems, []);
  assert.deepEqual(whiteRead.insets, ins);
});

test("the StyleBoxTexture is the file Godot itself writes", () => {
  // Godot 4.7.2 saved this StyleBoxTexture from GDScript; only its random resource id
  // differs from what onmodel writes.
  const godot = `[gd_resource type="StyleBoxTexture" format=3]

[ext_resource type="Texture2D" path="res://panel.png" id="1_texture"]

[resource]
content_margin_left = 12.0
content_margin_top = 10.0
content_margin_right = 14.0
content_margin_bottom = 16.0
texture = ExtResource("1_texture")
texture_margin_left = 12.0
texture_margin_top = 10.0
texture_margin_right = 14.0
texture_margin_bottom = 16.0
draw_center = false
`;
  const box = { left: 12, top: 10, right: 14, bottom: 16 };
  assert.equal(styleBoxTexture({ texture: "res://panel.png", insets: box, drawCenter: false }), godot);
  assert.ok(!/draw_center/.test(styleBoxTexture({ texture: "res://panel.png", insets: box })), "the default is left out, as Godot leaves it out");

  const css = ninePatchCSS({ file: "panel.png", className: "panel", insets: box });
  assert.match(css, /border-width: 10px 14px 16px 12px;/, "CSS sides run top, right, bottom, left");
  assert.match(css, /url\("panel.png"\) 10 14 16 12 fill \/ 10px 14px 16px 12px stretch;/);
});

test("stretching keeps the corners exactly and repeats the band", () => {
  const art = panel(40, 30, { R: 6, B: 2 });
  const ins = { left: 7, top: 6, right: 8, bottom: 5 };
  const big = renderNinePatch(art, ins, 100, 70);
  for (let y = 0; y < ins.top; y++) {
    for (let x = 0; x < ins.left; x++) assert.deepEqual([...big.data.subarray((y * 100 + x) * 4, (y * 100 + x) * 4 + 4)], [...art.data.subarray((y * 40 + x) * 4, (y * 40 + x) * 4 + 4)]);
  }
  const hollow = { width: 9, height: 9, data: new Uint8Array(9 * 9 * 4) };
  for (let y = 0; y < 9; y++) for (let x = 0; x < 9; x++) if (x < 2 || y < 2 || x > 6 || y > 6) hollow.data.set([10, 10, 10, 255], (y * 9 + x) * 4);
  assert.equal(centreIsEmpty(hollow, { left: 2, top: 2, right: 2, bottom: 2 }), true);
});

test("onmodel ninepatch writes every format and the gate measures the bands again from disk", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-9p-"));
  const file = path.join(out, "panel.png");
  await writeFile(file, encodePNG(panel(160, 96, { wobble: 0.3, noise: 3 })));
  const made = await makeNinePatch({ config: { out }, markPath: file, log: () => {} });
  assert.equal(made.facts.verdict, "good");
  assert.deepEqual(made.facts.unityBorder, { left: made.facts.insets.left, bottom: made.facts.insets.bottom, right: made.facts.insets.right, top: made.facts.insets.top });

  const run = path.join(out, "panel");
  const before = await checkRun({ dir: run });
  assert.equal(failuresOf(before).length, 0, JSON.stringify(failuresOf(before)));
  const fail = async () => failuresOf(await checkRun({ dir: run })).map((f) => `${f.file}:${f.check}`);

  // A dot painted into the middle of the panel since: the band no longer stretches clean.
  const art = decodeImage(await readFile(made.files.image));
  const dotted = { ...art, data: Uint8Array.from(art.data) };
  for (let y = 46; y < 50; y++) for (let x = 78; x < 82; x++) dotted.data.set([20, 20, 20, 255], (y * 160 + x) * 4);
  await writeFile(made.files.image, encodePNG(dotted));
  assert.deepEqual(await fail(), ["panel.png:stretches", "panel.9.png:art"]);
  await writeFile(made.files.image, encodePNG(art));

  // A mark moved on the .9.png: Android would stretch the wrong lines.
  const np = decodeImage(await readFile(made.files.android));
  const moved = { ...np, data: Uint8Array.from(np.data) };
  moved.data.set([0, 0, 0, 0], (0 * np.width + 1 + made.facts.insets.left) * 4);
  await writeFile(made.files.android, encodePNG(moved));
  assert.deepEqual(await fail(), ["panel.9.png:marks"]);
  await writeFile(made.files.android, encodePNG(np));

  // A margin changed by hand in the StyleBox.
  const sb = await readFile(made.files.stylebox, "utf8");
  await writeFile(made.files.stylebox, sb.replace(/texture_margin_left = [\d.]+/, "texture_margin_left = 3.0"));
  assert.deepEqual(await fail(), ["panel.stylebox.tres:margins"]);
  await writeFile(made.files.stylebox, sb);
  assert.equal((await fail()).length, 0);
});

test("an Android .9.png given as the art keeps its own marks", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-9p-"));
  const art = panel(60, 40, { R: 8, B: 3 });
  const file = path.join(out, "button.9.png");
  await writeFile(file, encodePNG(androidNinePatch(art, { left: 9, top: 9, right: 9, bottom: 9 }, { left: 12, top: 10, right: 12, bottom: 10 })));
  const made = await makeNinePatch({ config: { out }, markPath: file, log: () => {} });
  assert.equal(made.name, "button");
  assert.equal(made.facts.fromAndroid, true);
  assert.deepEqual(made.facts.insets, { left: 9, top: 9, right: 9, bottom: 9 });
  assert.deepEqual(made.facts.content, { left: 12, top: 10, right: 12, bottom: 10 });
  assert.equal(made.facts.width, 60, "the border is taken off");
  await assert.rejects(makeNinePatch({ config: { out }, markPath: file, scale: 0.5, log: () => {} }), /blur its marks/);
});

test("art that cannot stretch is refused with the reason, and one-way art says which way", async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-9p-"));
  const badge = path.join(out, "badge.png");
  await writeFile(badge, encodePNG(panel(160, 96, { emblem: 24 })));
  await assert.rejects(makeNinePatch({ config: { out }, markPath: badge, log: () => {} }), /splits the plain band/);

  // A bar patterned top to bottom stretches across only, and keeps its height fixed.
  const bar = panel(160, 48, { R: 6, B: 2 });
  for (let y = 0; y < 48; y++) for (let x = 0; x < 160; x++) bar.data[(y * 160 + x) * 4 + 1] = Math.max(0, bar.data[(y * 160 + x) * 4 + 1] - Math.round(30 * Math.sin(y / 3)));
  const barFile = path.join(out, "bar.png");
  await writeFile(barFile, encodePNG(bar));
  const made = await makeNinePatch({ config: { out }, markPath: barFile, log: () => {} });
  assert.equal(made.facts.verdict, "across only");
  assert.equal(made.facts.insets.top + made.facts.insets.bottom, 0);
});

test("the CLI refuses malformed sides and scales", () => {
  const run = (...args) => spawnSync(process.execPath, [bin, "ninepatch", ...args], { encoding: "utf8" });
  const bad = run("--mark", "x.png", "--insets", "1,2,3");
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /one whole number, or four/);
  const scale = run("--mark", "x.png", "--scale", "3");
  assert.match(scale.stderr, /0.05 to 1/);
});

function aapt2() {
  const sdk = process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Android", "Sdk", "build-tools");
  if (!sdk || !existsSync(sdk)) return null;
  const versions = readdirSync(sdk).filter((v) => !/rc/.test(v)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const exe = versions.length && path.join(sdk, versions[versions.length - 1], process.platform === "win32" ? "aapt2.exe" : "aapt2");
  return exe && existsSync(exe) ? exe : null;
}

test("aapt2 compiles the .9.png and records the same stretch the insets say", { skip: !aapt2() && "no Android SDK build-tools" }, async () => {
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-9p-"));
  const file = path.join(out, "panel.png");
  await writeFile(file, encodePNG(panel(160, 96, { noise: 3 })));
  const made = await makeNinePatch({ config: { out }, markPath: file, log: () => {} });
  const res = path.join(out, "res", "drawable");
  await mkdir(res, { recursive: true });
  await copyFile(made.files.android, path.join(res, "panel.9.png"));
  const compiled = path.join(out, "compiled");
  await mkdir(compiled);
  const r = spawnSync(aapt2(), ["compile", path.join("res", "drawable", "panel.9.png"), "-o", "compiled"], { cwd: out, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const flat = await readFile(path.join(compiled, (await readdir(compiled))[0]));
  const png = flat.subarray(flat.indexOf(Buffer.from([0x89, 0x50, 0x4e, 0x47])));
  let pos = 8;
  let divs = null;
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("latin1", pos + 4, pos + 8);
    if (type === "npTc") {
      const c = png.subarray(pos + 8, pos + 8 + len);
      const nx = c[1];
      const ny = c[2];
      divs = { x: [c.readInt32BE(32), c.readInt32BE(36)], y: [c.readInt32BE(32 + 4 * nx), c.readInt32BE(36 + 4 * nx)], count: nx + ny };
    }
    if (type === "IEND") break;
    pos += 12 + len;
  }
  const f = made.facts;
  assert.deepEqual(divs, { x: [f.insets.left, f.width - f.insets.right], y: [f.insets.top, f.height - f.insets.bottom], count: 4 });
});

const OUT = [30, 40, 70, 255];
const BORDER = [90, 110, 150, 255];
const FILL = [225, 230, 240, 255];
function img(W, H, f) {
  const d = new Uint8Array(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) d.set(f(x, y) ?? [0, 0, 0, 0], (y * W + x) * 4);
  return { width: W, height: H, data: d };
}
/** A pixel-art frame: an outline, a border, a fill. */
const frame = (W, H, o, b, fill = () => FILL) =>
  img(W, H, (x, y) => {
    const d = Math.min(x, y, W - 1 - x, H - 1 - y);
    return d < o ? OUT : d < o + b ? BORDER : fill(x, y);
  });

test("crisp pixel-art frames get exact insets, down to 3x3", () => {
  // Hard-edged art is compared line for line exactly, so a one-pixel outline stays a frame at
  // any size; a tolerance there let the outline into the band.
  assert.equal(isCrisp(frame(9, 9, 1, 2)), true);
  assert.equal(isCrisp(panel(160, 96, { noise: 3 })), false, "noise is not crisp");
  for (const [W, o, b, want] of [[3, 1, 0, 1], [5, 1, 0, 1], [7, 1, 1, 2], [9, 1, 2, 3], [24, 1, 3, 4]]) {
    const i = ninePatchInsets(frame(W, W, o, b));
    assert.deepEqual([i.left, i.top, i.right, i.bottom], [want, want, want, want], `${W}x${W}`);
  }
});

test("a texture never pulls the border into the band", () => {
  // A striped or banded fill used to raise the noise estimate until the border passed as fill.
  const stripes = ninePatchInsets(frame(64, 40, 1, 3, (x) => (Math.floor(x / 2) % 2 ? [200, 200, 200, 255] : [120, 120, 120, 255])));
  assert.equal(stripes.across.stretches, false, "vertical stripes cannot stretch across");
  assert.ok(stripes.top >= 4 && stripes.bottom >= 4, "and down, the band stays inside the border");
  const bands = ninePatchInsets(frame(96, 64, 1, 2, (x, y) => (Math.floor(y / 3) % 2 ? [200, 200, 210, 255] : [170, 170, 180, 255])));
  assert.equal(bands.down.stretches, false);
  assert.ok(bands.left >= 3 && bands.right >= 3);
});

/** A button with a centred label set from a real font, optionally with noise. */
function button(text, fontFile, px, W, H, noise = 0) {
  const font = loadFont(readFileSyncCached(fontFile));
  const t = textPath(font, text, { size: px });
  const ox = Math.round((W - t.width) / 2);
  const oy = Math.round((H - t.height) / 2);
  const cov = coverage(pathToPolygons(t.d.replace(/(-?\d*\.?\d+)\s+(-?\d*\.?\d+)/g, (m, a, b) => `${Number(a) + ox} ${Number(b) + oy}`)), W, H, { rule: "nonzero" });
  let q = 11;
  const r = () => ((q = (Math.imul(q, 1664525) + 1013904223) >>> 0) / 4294967296);
  return img(W, H, (x, y) => {
    const d = Math.min(x, y, W - 1 - x, H - 1 - y);
    const c = cov[y * W + x];
    const base = d < 1 ? OUT : FILL.map((v, k) => (k === 3 ? 255 : Math.round(v + (30 - v) * c)));
    return base.map((v, k) => (k === 3 ? v : Math.max(0, Math.min(255, Math.round(v + (r() - 0.5) * 2 * noise)))));
  });
}
const cache = new Map();
function readFileSyncCached(f) {
  if (!cache.has(f)) cache.set(f, readFileSync(f));
  return cache.get(f);
}

test("a label is never stretched, even where the gap between its words holds the middle", { skip: !existsSync("C:/Windows/Fonts/arialbd.ttf") && "Arial Bold is not installed" }, () => {
  // The few clear columns between two words used to become the band, so stretching pulled the
  // words apart; and a label wide enough to fill the middle's outer thirds polluted the plain
  // line, which is now put to a vote among the lines.
  for (const [text, px, W, H] of [["Log out", 18, 160, 48], ["PLAY NOW", 22, 240, 64], ["Go on", 20, 120, 40]]) {
    for (const noise of [0, 3, 6]) {
      const i = ninePatchInsets(button(text, "C:/Windows/Fonts/arialbd.ttf", px, W, H, noise));
      assert.ok(!i.across.stretches && !i.down.stretches, `${text} with noise ${noise}: across ${i.across.stretches}, down ${i.down.stretches}`);
    }
  }
  // The same button without the label stretches both ways.
  const plain = ninePatchInsets(button(" ", "C:/Windows/Fonts/arialbd.ttf", 18, 160, 48, 3));
  assert.ok(plain.across.stretches && plain.down.stretches);
});

test("a tail, notch or tab two pixels deep at the outline is not stretched", () => {
  // The tolerance an edge earns covers an outline wobbling by a fraction of a pixel, not a feature
  // two pixels deep, which the full edge contrast used to let through.
  const notch = frame(96, 64, 1, 2);
  for (let y = 0; y < 2; y++) for (let x = 44; x < 52; x++) notch.data.set([0, 0, 0, 0], (y * 96 + x) * 4);
  assert.equal(ninePatchInsets(notch).across.stretches, false);
  const tab = img(96, 66, (x, y) => (y < 2 ? (x >= 40 && x < 56 ? OUT : null) : (() => { const yy = y - 2; const d = Math.min(x, yy, 95 - x, 63 - yy); return d < 1 ? OUT : d < 3 ? BORDER : FILL; })()));
  const t = ninePatchInsets(tab);
  assert.equal(t.across.stretches, false, "the tab cannot be widened");
  assert.equal(t.down.stretches, true, "but the panel below it still stretches down");
  // A header bar is not a feature in the middle: the body stretches and the header stays put.
  const dialog = ninePatchInsets(img(120, 90, (x, y) => { const d = Math.min(x, y, 119 - x, 89 - y); if (d < 1) return OUT; if (y < 22) return [80, 100, 160, 255]; if (y === 22) return OUT; return FILL; }));
  assert.ok(dialog.down.stretches && dialog.top >= 23);
});

test("given insets are measured against their own band, and none on an axis is not a smear", () => {
  // A single line beside a feature, as Android keys do, repeats only itself.
  const art = frame(66, 66, 1, 2);
  for (let y = 20; y < 40; y++) for (let x = 20; x < 46; x++) art.data.set([200, 60, 60, 255], (y * 66 + x) * 4);
  const one = ninePatchInsets(art, [3, 45, 3, 20]);
  assert.equal(one.down.failing, 0, "one row stretched is alike to itself");
  // Insets of nothing on an axis mean no frame there, as when none is found: nothing to smear.
  const bar = ninePatchInsets(frame(160, 48, 1, 2), [5, 0, 5, 0]);
  assert.equal(bar.down.stretches, false);
  assert.equal(bar.down.failing, 0);
});

test("a CSS class never starts with a digit", () => {
  const css = ninePatchCSS({ file: "3d-button.png", className: "3d-button", insets: { left: 4, top: 4, right: 4, bottom: 4 } });
  assert.match(css, /^\.np-3d-button \{/m);
});

test("plain panels that went through JPEG stretch, and big-radius buttons with a gradient too", async () => {
  // JPEG quantises averages until most differences read as nothing, so its noise read as none and a
  // single blip on a block edge split a plain panel; and a pill's few straight rows were judged
  // against a corner row. Generated art arrives as JPEG, so this is the common case.
  const { encodeJPEG, decodeJPEG } = await import("../src/jpeg.mjs");
  for (const [W, H, o] of [[96, 48, 1], [128, 64, 2], [200, 120, 3]]) {
    for (const q of [80, 85, 90]) {
      const im = decodeJPEG(encodeJPEG(frame(W, H, 1, o), { quality: q }));
      const i = ninePatchInsets(im);
      assert.ok(i.across.stretches && i.down.stretches, `${W}x${H} q${q}`);
      assert.ok(Math.abs(i.left - i.right) <= 3 && Math.abs(i.top - i.bottom) <= 3, `${W}x${H} q${q}: L${i.left} R${i.right} T${i.top} B${i.bottom}`);
    }
  }
  for (const [W, H, R] of [[160, 32, 13], [240, 48, 21], [192, 64, 28], [160, 96, 45]]) {
    const i = ninePatchInsets(panel(W, H, { R, B: 2, vgrad: 30 }));
    assert.ok(i.across.stretches && i.down.stretches, `${W}x${H} R${R}`);
  }
});

test("a thick frame, an inner line or a clear gutter round crisp art keeps exact insets", () => {
  for (const [W, o, b, inner] of [[12, 1, 4, 0], [16, 1, 5, 0], [32, 2, 10, 0], [16, 1, 3, 1], [24, 2, 6, 1]]) {
    const f = img(W, W, (x, y) => { const d = Math.min(x, y, W - 1 - x, W - 1 - y); return d < o ? OUT : d < o + b ? BORDER : d < o + b + inner ? [250, 250, 255, 255] : FILL; });
    const i = ninePatchInsets(f);
    const want = o + b + inner;
    assert.deepEqual([i.left, i.top, i.right, i.bottom], [want, want, want, want], `${W} ${o}+${b}+${inner}`);
  }
  for (const gutter of [4, 10, 12]) {
    const C = 24 + 2 * gutter;
    const f = img(C, C, (x, y) => { const xx = x - gutter; const yy = y - gutter; if (xx < 0 || yy < 0 || xx >= 24 || yy >= 24) return null; const d = Math.min(xx, yy, 23 - xx, 23 - yy); return d < 1 ? OUT : d < 3 ? BORDER : FILL; });
    assert.equal(ninePatchInsets(f).left, gutter + 3, `gutter ${gutter}`);
  }
});

test("a big gentle gradient is soft art, and a dither is a texture, not a feature", () => {
  const W = 800;
  const H = 600;
  const big = img(W, H, (x, y) => { const d = Math.min(x, y, W - 1 - x, H - 1 - y); if (d < 2) return OUT; const t = y / H; return [225 - 8 * t, 230 - 8 * t, 240 - 8 * t, 255].map(Math.round); });
  assert.equal(isCrisp(big), false, "one-level steps on a big panel are a gradient, not crisp edges");
  const i = ninePatchInsets(big);
  assert.ok(i.down.stretches && i.top < 40 && i.bottom < 40, `T${i.top} B${i.bottom}`);
  const dither = ninePatchInsets(frame(24, 24, 1, 2, (x, y) => ((x + y) % 2 ? [225, 230, 240, 255] : [205, 210, 225, 255])));
  assert.ok(!dither.across.stretches && !dither.down.stretches);
  assert.ok(!dither.across.split && !dither.down.split, "it is refused as a texture, not as an emblem in the middle");
});

test("output the finder made passes the gate it is checked by", async () => {
  // The gate used to measure found insets by a different method and failed noisy output nobody had
  // touched; it runs the finder itself now.
  const { encodeJPEG, decodeJPEG } = await import("../src/jpeg.mjs");
  const out = await mkdtemp(path.join(tmpdir(), "onmodel-9p-"));
  let s = 1271;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
  for (let n = 0; n < 6; n++) {
    const base = frame(96, 96, 1, 2);
    const noisy = { ...base, data: base.data.map((v, k) => (k % 4 === 3 ? v : Math.max(0, Math.min(255, Math.round(v + (rnd() - 0.5) * 8))))) };
    const file = path.join(out, `p${n}.png`);
    await writeFile(file, encodePNG(decodeJPEG(encodeJPEG(noisy, { quality: 80 }))));
    let made;
    try {
      made = await makeNinePatch({ config: { out }, markPath: file, log: () => {} });
    } catch {
      continue;
    }
    const fails = failuresOf(await checkRun({ dir: path.join(out, made.name) }));
    assert.deepEqual(fails, [], `p${n}: ${JSON.stringify(fails)}`);
  }
});
