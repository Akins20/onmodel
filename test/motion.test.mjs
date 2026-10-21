import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BEZIERS, ANDROID_EASINGS, bezierEase, easing, svgPaths, textPaths, buildScene, groupMatrix, pose, unsettled, frameTimes, frameDiff, valueAt } from "../src/motion.mjs";
import { androidAVD, lottieJSON, animatedSVG, lottieShapes } from "../src/motionout.mjs";
import { readAVD, readLottie, readSVG } from "../src/motionread.mjs";
import { makeMotion, compareScenes, faithful, findFfmpeg, checkTimes } from "../src/motionset.mjs";
import { checkRun, failuresOf, gifFrameCount } from "../src/check.mjs";
import { apngInfo } from "../src/anim.mjs";
import { decodeImage } from "../src/image.mjs";
import { tinyFont } from "./fixtures/tinyfont.mjs";

const bin = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "onmodel.mjs");

/** A mark of three shapes in a 100 by 100 box: a square, a ring with a hole, and a half-clear dot. */
const MARK = [
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
  '<path id="box" fill="#102030" d="M10 10L40 10L40 40L10 40Z"/>',
  '<path id="ring" fill="var(--accent, #F4B52E)" fill-rule="evenodd" d="M50 50C50 40 60 30 70 30C80 30 90 40 90 50C90 60 80 70 70 70C60 70 50 60 50 50ZM60 50C60 45 65 40 70 40C75 40 80 45 80 50C80 55 75 60 70 60C65 60 60 55 60 50Z"/>',
  '<path id="dot" fill="#2A9D8F" fill-opacity="0.5" d="M20 70L30 70L30 80L20 80Z"/>',
  "</svg>",
].join("");

/** The box pops in, the ring spins once, and the dot fades in while it drops into place. */
function spec(extra = {}) {
  return {
    name: "demo",
    canvas: { width: 100, height: 100 },
    duration: 500,
    fps: 50,
    background: "#ffffff",
    sources: { mark: { svg: "mark.svg" } },
    layers: [
      { id: "box", pivot: [25, 25], path: "mark:box" },
      { id: "spin", pivot: [70, 50], children: [{ id: "ring", path: "mark:ring" }] },
      { id: "dot", path: "mark:dot" },
    ],
    animate: [
      { target: "box", scale: [0.5, 1], at: 0, for: 200, ease: "overshoot" },
      { target: "spin", rotate: [0, 360], at: 100, for: 300, ease: "fast-out-slow-in" },
      { target: "dot", opacity: [0, 1], at: 200, for: 200, ease: "decelerate" },
      { target: "dot", translateY: [-10, 0], at: 200, for: 200, ease: [0.2, 0, 0, 1] },
    ],
    ...extra,
  };
}

async function sceneDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "onmodel-motion-"));
  await writeFile(path.join(dir, "mark.svg"), MARK);
  return dir;
}

async function sceneOf(extra = {}) {
  const dir = await sceneDir();
  return { dir, scene: await buildScene(spec(extra), dir) };
}

test("named easings compute the curves the players use, and end where they start from", () => {
  assert.equal(easing("linear").at(0.3), 0.3);
  assert.ok(Math.abs(easing("ease-in-out").at(0.5) - 0.5) < 1e-9, "a symmetric curve passes through the middle");
  assert.ok(Math.abs(bezierEase(BEZIERS["ease-in-out"], 0.25) + bezierEase(BEZIERS["ease-in-out"], 0.75) - 1) < 1e-6);
  assert.ok(Math.abs(ANDROID_EASINGS.overshoot(0.5) - 1.125) < 1e-12, "Android's overshoot with tension 2 goes past the end");
  assert.ok(Math.abs(ANDROID_EASINGS.anticipate(0.5) + 0.125) < 1e-12, "and anticipate pulls back first");
  assert.ok(Math.abs(ANDROID_EASINGS["accelerate-decelerate"](0.5) - 0.5) < 1e-12);
  for (const name of [...Object.keys(BEZIERS), ...Object.keys(ANDROID_EASINGS)]) {
    const e = easing(name);
    assert.ok(Math.abs(e.at(0)) < 1e-9, `${name} starts at 0`);
    assert.ok(Math.abs(e.at(1) - 1) < 1e-3, `${name} ends at 1 (got ${e.at(1)})`);
  }
  assert.equal(easing("fast_out_slow_in").name, "fast-out-slow-in", "Android's own spelling is accepted");
  assert.equal(easing([0.2, 0, 0, 1]).kind, "bezier");
  assert.throws(() => easing("springy"), /no easing named "springy"; use one of linear, ease/);
  assert.throws(() => easing([1.5, 0, 0, 1]), /x values must lie between 0 and 1/);
  assert.throws(() => easing([0, 1]), /needs four/);
});

test("an SVG's paths are read in paint order, split into subpaths, with their fills, rules and opacity", () => {
  const whole = svgPaths(MARK);
  assert.deepEqual(whole.paths.map((p) => p.id), ["box", "ring", "dot"]);
  assert.equal(whole.width, 100);
  assert.deepEqual(whole.paths[1].fill, [244, 181, 46], "a var() fill falls to its given colour");
  assert.equal(whole.paths[1].rule, "evenodd");
  assert.equal(whole.paths[2].alpha, 0.5);
  const split = svgPaths(MARK, { split: true });
  assert.deepEqual(split.paths.map((p) => p.id), ["boxs0", "rings0", "rings1", "dots0"], "each subpath gets its own id");
  assert.ok(split.paths[2].d.startsWith("M60 50"));
  assert.throws(() => svgPaths('<svg viewBox="0 0 1 1"><g transform="scale(2)"><path d="M0 0L1 1Z"/></g></svg>'), /transform attributes/);
  assert.throws(() => svgPaths('<svg viewBox="0 0 1 1"><path id="r" d="m0 0 l1 1 z"/></svg>'), /path r uses SVG commands motion does not read/);
  assert.throws(() => svgPaths('<svg viewBox="0 0 1 1"><path d="M0 0A1 1 0 0 1 1 1Z"/></svg>'), /arcs or quadratics/);
  assert.throws(() => svgPaths('<svg viewBox="0 0 1 1"><path fill="url(#g)" d="M0 0L1 1Z"/></svg>'), /a fill motion cannot read/);
});

test("a scene is built from a spec: the tree, the tracks, a stagger, and the mistakes it refuses", async () => {
  const dir = await sceneDir();
  const build = (s) => buildScene(s, dir);
  const { scene } = await sceneOf();
  assert.equal(scene.width, 100);
  assert.equal(scene.duration, 500);
  assert.deepEqual(scene.background, [255, 255, 255]);
  assert.equal(scene.tracks.size, 5, "scale is two tracks; rotate, opacity and translateY one each");
  const box = scene.roots[0];
  assert.equal(valueAt(box, "scaleX", scene.tracks, 0), 0.5);
  assert.equal(valueAt(box, "scaleX", scene.tracks, 200), 1);
  assert.equal(valueAt(box, "scaleX", scene.tracks, 400), 1, "held after its last segment");
  assert.ok(valueAt(box, "scaleX", scene.tracks, 100) > 1, "overshoot goes past 1 on the way");
  assert.equal(valueAt(scene.roots[2], "opacity", scene.tracks, 100), 0, "before its first animation a track holds that animation's start");

  const staggered = await build({
    ...spec(),
    layers: [
      { id: "a", path: "mark:box" },
      { id: "b", path: "mark:dot" },
    ],
    animate: [{ target: ["a", "b"], stagger: 100, scale: [0, 1], at: 0, for: 100 }],
  });
  const [a, b] = staggered.roots;
  assert.equal(valueAt(a, "scaleX", staggered.tracks, 100), 1);
  assert.equal(valueAt(b, "scaleX", staggered.tracks, 50), 0, "the second starts 100 ms later");
  assert.ok(Math.abs(valueAt(b, "scaleX", staggered.tracks, 150) - 0.5) < 1e-9);

  const withoutCanvas = await build({ ...spec(), canvas: undefined });
  assert.equal(withoutCanvas.width, 100, "the first SVG source gives the canvas");
  const open = await build({ ...spec(), duration: undefined });
  assert.equal(open.duration, 400, "the duration is the last animation's end when none is given");

  const animate = (list) => ({ ...spec(), animate: list });
  await assert.rejects(build(animate([{ target: "box", scaleX: [0, 1], at: 0, for: 200 }, { target: "box", scaleX: [1, 2], at: 100, for: 200 }])), /two animations move scaleX at once/);
  await assert.rejects(build({ ...spec(), layers: [{ id: "box", scale: 0.8, path: "mark:box" }], animate: [{ target: "box", scale: [0.5, 1], for: 100 }] }), /its scaleX is 0.8, but its first animation starts from 0.5/);
  await assert.rejects(build({ ...spec(), duration: 100 }), /the duration is 100 ms but an animation runs to 400 ms/);
  await assert.rejects(build({ ...spec(), layers: [{ id: "arc-0", path: "mark:box" }], animate: [] }), /layer id "arc-0" must start with a letter/);
  await assert.rejects(build({ ...spec(), layers: [{ id: "both", path: "mark:box", children: [{ id: "c", path: "mark:dot" }] }], animate: [] }), /both draws paths and holds layers/);
  await assert.rejects(build({ ...spec(), layers: [{ id: "one", path: "mark:box" }, { id: "two", path: "mark:box" }], animate: [] }), /mark:box is drawn twice/);
  await assert.rejects(build(animate([{ target: "nobody", scale: [0, 1], for: 100 }])), /there is no layer "nobody"/);
  await assert.rejects(build(animate([{ target: "box", skew: [0, 1], for: 100 }])), /"skew" is not something motion moves/);
  await assert.rejects(build(animate([{ target: "box", opacity: [0, 2], for: 100 }])), /opacity runs from 0 to 1/);
  await assert.rejects(build(animate([{ target: "box", for: 100 }])), /names no property to move/);
  await assert.rejects(build({ ...spec(), layers: [] }), /at least one layer/);
  await assert.rejects(build({ ...spec(), fps: 200 }), /fps runs from 1 to 120/);
  await assert.rejects(build({ ...spec(), layers: [{ id: "x", path: "logo:box" }], animate: [] }), /there is no source "logo"/);
  await assert.rejects(build({ ...spec(), layers: [{ id: "x", path: "mark:lid" }], animate: [] }), /mark:lid names no path; mark has box, ring, dot/);
  await assert.rejects(build({ ...spec(), sources: { mark: { svg: "nowhere.svg" } } }), /could not read/);
  await assert.rejects(build({ ...spec(), background: "sky" }), /background sky is not a colour/);
});

test("a group transforms about its pivot the way Android's groups do, and a child inherits its parent", async () => {
  const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const scaled = groupMatrix({ translateX: 0, translateY: 0, scaleX: 2, scaleY: 2, rotate: 0 }, [10, 10]);
  assert.deepEqual(apply(scaled, [10, 10]), [10, 10], "the pivot stays put");
  assert.deepEqual(apply(scaled, [20, 10]), [30, 10]);
  const turned = groupMatrix({ translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotate: 90 }, [10, 10]);
  const [x, y] = apply(turned, [20, 10]);
  assert.ok(Math.abs(x - 10) < 1e-9 && Math.abs(y - 20) < 1e-9, "a quarter turn, clockwise on a screen");
  const moved = groupMatrix({ translateX: 5, translateY: -3, scaleX: 1, scaleY: 1, rotate: 0 }, [40, 40]);
  assert.deepEqual(apply(moved, [1, 1]), [6, -2], "translate is applied after the pivot transforms");

  const { scene } = await sceneOf({
    layers: [{ id: "outer", translate: [10, 0], children: [{ id: "inner", scale: 2, path: "mark:box" }] }],
    animate: [],
  });
  const posed = pose(scene, 0);
  assert.equal(posed.length, 1);
  assert.deepEqual(posed[0].m, [2, 0, 0, 2, 10, 0], "the parent's translate carries the child's scale");
});

test("text is set one path per character from a font's own outlines, kerned and spaced", () => {
  const font = {
    unitsPerEm: 1000,
    glyphFor: (cp) => (cp === 32 ? 0 : cp),
    advanceOf: (g) => (g === 0 ? 250 : 500),
    kernBetween: (a, b) => (a === 65 && b === 66 ? -100 : 0),
    glyphPath: (g, map) => {
      if (g === 0) return null;
      const p = [
        [0, 0],
        [400, 0],
        [400, 700],
      ].map(([x, y]) => map({ x, y }));
      return `M${p[0][0]} ${p[0][1]}L${p[1][0]} ${p[1][1]}L${p[2][0]} ${p[2][1]}Z`;
    },
  };
  const got = textPaths({ font, text: "AB C", size: 100, at: [10, 80], fill: "#336699" });
  assert.deepEqual(got.paths.map((p) => p.id), ["0", "1", "3"], "ids are the characters' indexes; the space draws nothing");
  assert.ok(got.paths[0].d.startsWith("M10 80L50 80L50 10Z"), `the first glyph stands on the baseline, up the page: ${got.paths[0].d}`);
  assert.ok(got.paths[1].d.startsWith("M50 80"), "the pen moved one advance less the kern");
  assert.ok(got.paths[2].d.startsWith("M125 80"), "and across the space");
  assert.equal(got.width, 165);
  assert.deepEqual(got.paths[0].fill, [51, 102, 153]);
  const spaced = textPaths({ font, text: "AB", size: 100, at: [10, 80], letterSpacing: 100 });
  assert.ok(spaced.paths[1].d.startsWith("M60 80"), "letter spacing is in thousandths of an em");
  const unkerned = textPaths({ font, text: "AB", size: 100, at: [10, 80], kerning: false });
  assert.ok(unkerned.paths[1].d.startsWith("M60 80"));
  assert.throws(() => textPaths({ font, text: "A", size: 10, fill: "bright" }), /must be a colour/);
});

test("a text source in a spec is set from a real font file, relative to the spec", async () => {
  const dir = await sceneDir();
  await writeFile(path.join(dir, "t.ttf"), tinyFont());
  const s = {
    ...spec(),
    sources: { word: { text: "AB", font: "t.ttf", size: 50, at: [10, 60], fill: "#123456" } },
    layers: [{ id: "word", paths: "word:*" }],
    animate: [{ target: "word", opacity: [0, 1], for: 100 }],
    duration: 100,
  };
  const scene = await buildScene(s, dir);
  const paths = scene.roots[0].paths;
  assert.deepEqual(paths.map((p) => p.key), ["word:0", "word:1"]);
  assert.deepEqual(paths[0].fill, [0x12, 0x34, 0x56]);
  assert.ok(paths[0].d.startsWith("M15 60"), `the square's first point, 100 units in at a twentieth: ${paths[0].d}`);
  assert.ok(paths[1].d.startsWith("M45 60"), "the triangle one advance of 600 units along");
  await assert.rejects(buildScene({ ...s, sources: { word: { text: "AB", font: "t.ttf" } } }, dir), /needs a size/);
  await assert.rejects(buildScene({ ...s, sources: { word: { text: "AB", size: 50 } } }, dir), /needs a font/);
  await assert.rejects(buildScene({ ...s, sources: { word: { size: 50 } } }, dir), /needs an svg or a text/);
});

test("every format read back the way its player reads it draws the timeline", async () => {
  const { scene } = await sceneOf();
  const times = checkTimes(scene);
  assert.equal(times.length, 26, "every frame at 50 fps over 500 ms");

  const { xml, problems } = androidAVD(scene);
  assert.deepEqual(problems, []);
  assert.match(xml, /android:fillType="evenOdd"/);
  assert.match(xml, /@android:interpolator\/overshoot/);
  assert.match(xml, /<pathInterpolator android:controlX1="0.2" android:controlY1="0" android:controlX2="0" android:controlY2="1" \/>/);
  assert.match(xml, /android:propertyName="rotation" android:valueFrom="0" android:valueTo="360" android:startOffset="100" android:duration="300"/);
  assert.match(xml, /android:name="dot_0" android:fillColor="#2A9D8F" android:fillAlpha="0"/, "a fading layer's path starts at the fade's start, times its own alpha");
  const avd = compareScenes(scene, readAVD(xml), { scale: 2.56, times });
  assert.equal(avd.max, 0, `the drawable drawn back is the timeline: ${JSON.stringify(avd)}`);

  const lottie = lottieJSON(scene);
  assert.equal(lottie.op, 26, "the out point is one frame past the last");
  assert.equal(lottie.layers[0].shapes.length, 3);
  assert.equal(lottie.layers[0].shapes[0].nm, "dot", "the last layer is written first, since the first item draws on top");
  const back = readLottie(JSON.stringify(lottie));
  assert.equal(back.hiddenAt(500), false, "the last frame shows");
  assert.equal(back.hiddenAt(520), true, "and the one after it does not");
  const lot = compareScenes(scene, back, { scale: 2.56, times });
  assert.equal(lot.max, 0, `the Lottie drawn back is the timeline: ${JSON.stringify(lot)}`);

  const svg = animatedSVG(scene);
  assert.match(svg, /@keyframes m_spin\{0%\{transform:translate\(70px,50px\) rotate\(0deg\) scale\(1,1\) translate\(-70px,-50px\);opacity:1\}/);
  assert.match(svg, /#spin\{transform-box:view-box;transform-origin:0 0;[^}]*animation:m_spin 500ms linear 0s 1 both\}/);
  assert.match(svg, /prefers-reduced-motion:reduce/);
  assert.match(svg, /fill-rule="evenodd"/);
  const svgd = compareScenes(scene, readSVG(svg), { scale: 2.56, times });
  assert.ok(faithful(svgd), `the SVG drawn back is within rounding of the timeline: ${JSON.stringify(svgd)}`);

  const { scene: looping } = await sceneOf({ loop: true });
  assert.match(animatedSVG(looping), /500ms linear 0s infinite both/);
});

test("an Android drawable says a static group opacity through its paths, and refuses what it cannot say", async () => {
  const { scene } = await sceneOf({
    layers: [{ id: "faded", opacity: 0.5, children: [{ id: "inner", path: "mark:box" }, { id: "dot", path: "mark:dot" }] }],
    animate: [{ target: "dot", opacity: [0, 1], for: 100 }],
    duration: 100,
  });
  const { xml, problems } = androidAVD(scene);
  assert.deepEqual(problems, []);
  assert.match(xml, /android:fillColor="#102030" android:fillAlpha="0.5"/, "the box carries its parent's opacity");
  assert.match(xml, /android:propertyName="fillAlpha" android:valueFrom="0" android:valueTo="0.25"/, "the dot's fade is scaled by its own and its parent's alpha");
  assert.equal(compareScenes(scene, readAVD(xml), { scale: 2.56, times: checkTimes(scene) }).max, 0);

  const { scene: nested } = await sceneOf({
    layers: [{ id: "outer", children: [{ id: "inner", path: "mark:box" }] }],
    animate: [{ target: ["outer", "inner"], opacity: [0, 1], for: 100 }],
    duration: 100,
  });
  assert.match(androidAVD(nested).problems[0], /layers outer and inner both animate opacity and one holds the other/);

  const { scene: slow } = await sceneOf({ duration: 1200, android: { splash: true } });
  assert.match(androidAVD(slow).problems[0], /runs 1200 ms; Android 12 and later stop a splash icon's animation at 1000 ms/);
  assert.doesNotMatch(androidAVD(await sceneOf({ duration: 1200 }).then((s) => s.scene)).problems.join(), /1000 ms/, "only a splash is held to a second");
});

test("it ends on the artwork, or says exactly what does not", async () => {
  const { scene } = await sceneOf();
  assert.deepEqual(unsettled(scene), [], "a full turn counts as rest");
  const { scene: off } = await sceneOf({ animate: [{ target: "box", scale: [0.5, 1.2], for: 200 }, { target: "spin", rotate: [0, 350], for: 200 }] });
  assert.deepEqual(unsettled(off), ["box.scaleX ends at 1.2, not 1", "box.scaleY ends at 1.2, not 1", "spin.rotate ends at 350, not 0"]);

  const dir = await sceneDir();
  const write = async (name, s) => {
    const file = path.join(dir, `${name}.json`);
    await writeFile(file, JSON.stringify(s));
    return file;
  };
  const out = path.join(dir, "out");
  const unsettledSpec = await write("off", { ...spec(), name: "off", animate: [{ target: "box", scale: [0.5, 1.2], for: 200 }] });
  const bad = await makeMotion({ config: { out }, specPath: unsettledSpec, formats: ["svg"], log: () => {} });
  assert.equal(bad.facts.verdict, "problems");
  assert.match(bad.facts.failures[0], /does not end on the artwork: box.scaleX ends at 1.2, not 1/);
  assert.equal(bad.facts.settles.ok, false);
  const waived = await makeMotion({ config: { out }, specPath: await write("frame", { ...spec(), name: "frame", endsOn: "frame", animate: [{ target: "box", scale: [0.5, 1.2], for: 200 }] }), formats: ["svg"], log: () => {} });
  assert.equal(waived.facts.verdict, "good");
  assert.deepEqual(waived.facts.settles, { ok: true, skipped: true });
});

test("frames sit on the grid, hold at the end, and are compared premultiplied", () => {
  const t = frameTimes(500, 50);
  assert.equal(t.length, 26);
  assert.equal(t[0], 0);
  assert.equal(t[25], 500);
  assert.equal(t[1], 20);
  const held = frameTimes(500, 50, 100);
  assert.equal(held.length, 31);
  assert.deepEqual(held.slice(-5), [500, 500, 500, 500, 500]);
  assert.equal(frameTimes(900, 60).length, 55);
  assert.equal(frameTimes(900, 60).at(-1), 900, "the last frame lands on the end even when the grid does not");
  const a = { width: 1, height: 1, data: new Uint8ClampedArray([255, 0, 0, 2]) };
  const b = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 2]) };
  assert.deepEqual(frameDiff(a, b), { max: 2, share: 0 }, "a nearly transparent pixel has nearly no colour to differ by");
  const c = { width: 1, height: 1, data: new Uint8ClampedArray([0, 0, 255, 255]) };
  assert.deepEqual(frameDiff(a, c), { max: 255, share: 1 });
  assert.deepEqual(frameDiff(a, { width: 2, height: 1, data: new Uint8ClampedArray(8) }), { max: 255, share: 1 });
});

test("Lottie shapes carry each curve's tangents and close where a path returns to its start", () => {
  const [tri] = lottieShapes("M0 0L10 0L10 10Z");
  assert.deepEqual(tri.v, [
    [0, 0],
    [10, 0],
    [10, 10],
  ]);
  assert.equal(tri.c, true);
  const [curve] = lottieShapes("M0 0C1 1 2 2 3 3L0 0Z");
  assert.equal(curve.v.length, 2, "the closing point back at the start is not a vertex of its own");
  assert.deepEqual(curve.o[0], [1, 1]);
  assert.deepEqual(curve.i[1], [-1, -1]);
  assert.equal(lottieShapes("M0 0L1 1ZM5 5L6 5L6 6Z").length, 2);
  assert.throws(() => lottieShapes("M0 0Q1 1 2 2"), /unexpected path command/);
});

test("the readers refuse what motion did not write rather than guessing", () => {
  assert.throws(() => readAVD('<animated-vector><aapt:attr name="android:drawable"><vector android:viewportWidth="1" android:viewportHeight="1"><path android:name="p" android:pathData="M0 0L1 1Z" /></vector></aapt:attr><target android:name="p"><aapt:attr name="android:animation"><set><objectAnimator android:propertyName="pathData" android:valueFrom="M0 0" android:valueTo="M1 1" android:duration="100" /></set></aapt:attr></target></animated-vector>'), /animates pathData, which motion does not write/);
  assert.throws(() => readAVD("<animated-vector></animated-vector>"), /has no <vector>/);
  assert.throws(() => readSVG('<svg viewBox="0 0 1 1"><g id="a" transform="matrix(1 0 0 1 0 0)"></g></svg>'), /a transform motion did not write/);
  const plain = readAVD('<vector android:viewportWidth="10" android:viewportHeight="10"><group android:name="g"><path android:fillColor="#80FF0000" android:pathData="M0 0L1 1Z" /></group></vector>');
  assert.deepEqual(plain.roots[0].children[0].paths[0].fill, [255, 0, 0], "an AARRGGBB colour puts alpha first");
  assert.equal(plain.roots[0].children[0].values.opacity, 128 / 255);
});

test("a motion run writes every format, records what it checked, and the gate re-checks it", async () => {
  const dir = await sceneDir();
  const specFile = path.join(dir, "demo.motion.json");
  await writeFile(specFile, JSON.stringify(spec()));
  const out = path.join(dir, "out");
  const made = await makeMotion({ config: { out }, specPath: specFile, formats: ["android", "lottie", "svg", "gif", "apng", "poster"], log: () => {} });
  assert.equal(made.facts.verdict, "good", made.facts.failures.join("; "));
  assert.equal(made.kind, "motion");
  for (const key of ["android", "lottie", "svg", "gif", "apng", "poster"]) assert.ok(existsSync(made.files[key]), `${key} written`);
  assert.equal(made.facts.readback.android.max, 0);
  assert.equal(made.facts.readback.lottie.max, 0);
  assert.ok(made.facts.readback.svg.max <= 48);
  assert.equal(made.facts.settles.ok, true);
  assert.equal(made.facts.pixels, 256, "a small canvas is drawn at 256 pixels");
  assert.equal(made.facts.gif.frames, 26);
  assert.equal(apngInfo(await readFile(made.files.apng)).frames, 26);
  assert.equal(gifFrameCount(await readFile(made.files.gif)), 26);
  const poster = decodeImage(await readFile(made.files.poster));
  assert.equal(poster.width, 256);
  assert.equal(poster.data[3], 255, "the poster is drawn over the background");
  assert.equal(made.facts.background, "#ffffff");
  assert.ok(made.facts.androidDigest && made.facts.lottieDigest && made.facts.svgDigest);
  const summary = JSON.parse(await readFile(path.join(made.dir, "motion.json"), "utf8"));
  assert.equal(summary.spec, path.resolve(specFile));
  const html = await readFile(path.join(made.dir, "motion.html"), "utf8");
  assert.match(html, /lottie-web/);
  assert.match(html, /demo\.svg/);

  const runDir = path.join(out, "demo");
  const clean = await checkRun({ dir: runDir });
  assert.equal(clean.length, 1);
  assert.equal(clean[0].kind, "motion");
  assert.deepEqual(failuresOf(clean), [], JSON.stringify(clean[0].files, null, 1));
  assert.deepEqual(clean[0].files.map((f) => f.rel).sort(), ["demo.apng.png", "demo.gif", "demo.lottie.json", "demo.poster.png", "demo.svg", "demo.xml"]);
  const timeline = clean[0].files.find((f) => f.rel === "demo.lottie.json").checks.find((c) => c.check === "timeline");
  assert.equal(timeline.detail, "drawn back, it matches the timeline exactly");

  // The Lottie edited by hand to spin half as far: the bytes differ, and so does the motion.
  const lottie = JSON.parse(await readFile(made.files.lottie, "utf8"));
  const spin = lottie.layers[0].shapes.find((g) => g.nm === "spin").it.find((x) => x.ty === "tr");
  spin.r.k[spin.r.k.length - 1].s = [180];
  await writeFile(made.files.lottie, JSON.stringify(lottie));
  const edited = await checkRun({ dir: runDir });
  const fails = failuresOf(edited);
  assert.deepEqual(fails.map((f) => [f.file, f.check]), [["demo.lottie.json", "timeline"]]);
  assert.match(fails[0].detail, /differs from the timeline by up to \d+ levels over [\d.]+% of the frame at \d+ ms/);
  const unchanged = edited[0].files.find((f) => f.rel === "demo.lottie.json").checks.find((c) => c.check === "unchanged");
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.warn, true, "with the spec in hand the timeline decides, not the bytes");

  // Without the spec, the bytes are all there is to hold the files to.
  await writeFile(path.join(made.dir, "motion.json"), JSON.stringify({ ...summary, spec: path.join(dir, "gone.json") }));
  await rm(made.files.gif);
  const blind = await checkRun({ dir: runDir });
  const blindFails = failuresOf(blind).map((f) => [f.file, f.check]);
  assert.deepEqual(blindFails, [
    ["demo.lottie.json", "unchanged"],
    ["demo.gif", "present"],
  ]);
  const androidTimeline = blind[0].files.find((f) => f.rel === "demo.xml").checks.find((c) => c.check === "timeline");
  assert.equal(androidTimeline.warn, true);
  assert.match(androidTimeline.detail, /not drawn against the timeline: the spec could not be loaded/);
});

test("the gate finds a motion run under its own subfolder and the CLI reports and exits on it", async () => {
  const dir = await sceneDir();
  const specFile = path.join(dir, "demo.motion.json");
  await writeFile(specFile, JSON.stringify(spec()));
  const out = path.join(dir, "out");
  const run = spawnSync(process.execPath, [bin, "motion", "--spec", specFile, "--out", out, "--formats", "android,svg", "--json"], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.command, "motion");
  assert.equal(result.facts.verdict, "good");
  assert.ok(!result.files.lottie && !result.files.gif, "only the formats asked for");
  const text = spawnSync(process.execPath, [bin, "motion", "--spec", specFile, "--out", out, "--formats", "android,svg"], { encoding: "utf8" });
  assert.match(text.stdout, /demo motion in .*: good \(500 ms at 50 fps, 3 paths in 4 layers, 5 animations, 100x100\)/);
  assert.match(text.stdout, /read back the way each player reads it: android exact; svg (exact|within \d+ levels)/);
  assert.match(text.stdout, /it ends on the artwork/);
  const check = spawnSync(process.execPath, [bin, "check", "--out", out], { encoding: "utf8" });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(check.stdout, /motion demo: 2 files all pass/);

  const slowFile = path.join(dir, "slow.json");
  await writeFile(slowFile, JSON.stringify({ ...spec(), name: "slow", duration: 1200, android: { splash: true } }));
  const slow = spawnSync(process.execPath, [bin, "motion", "--spec", slowFile, "--out", out, "--formats", "android"], { encoding: "utf8" });
  assert.equal(slow.status, 2, "a drawable that cannot be written is a failed run");
  assert.match(slow.stdout, /Android: not written; the splash animation runs 1200 ms/);
  assert.ok(!existsSync(path.join(out, "slow", "motion", "slow.xml")));

  const bogus = spawnSync(process.execPath, [bin, "motion", "--spec", specFile, "--out", out, "--formats", "webm"], { encoding: "utf8" });
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /--formats takes android, lottie, svg, gif, apng, mp4, poster; got webm/);
  const none = spawnSync(process.execPath, [bin, "motion", "--out", out], { encoding: "utf8" });
  assert.equal(none.status, 1);
  assert.match(none.stderr, /motion needs --spec/);
  const hold = spawnSync(process.execPath, [bin, "motion", "--spec", specFile, "--out", out, "--hold", "x"], { encoding: "utf8" });
  assert.equal(hold.status, 1);
  assert.match(hold.stderr, /--hold must be a whole number between 0 and 10000/);
});

const tools = findFfmpeg();
test("with ffmpeg installed the video holds every frame drawn, held at the end", { skip: !tools && "ffmpeg is not on the PATH" }, async () => {
  const dir = await sceneDir();
  const specFile = path.join(dir, "demo.motion.json");
  await writeFile(specFile, JSON.stringify(spec()));
  const made = await makeMotion({ config: { out: path.join(dir, "out") }, specPath: specFile, formats: ["mp4"], hold: 100, log: () => {} });
  assert.equal(made.facts.verdict, "good", made.facts.failures.join("; "));
  assert.equal(made.facts.mp4.frames, 31, "26 frames and five more held on the end");
  assert.equal(made.facts.mp4.width, 256);
  assert.equal(made.facts.mp4.rate, "50/1");
  assert.ok(!existsSync(path.join(made.dir, "frames")), "the frame files are cleaned up");
  assert.ok(made.facts.mp4.digest);
  const kept = await makeMotion({ config: { out: path.join(dir, "out2") }, specPath: specFile, formats: ["mp4"], keepFrames: true, log: () => {} });
  assert.ok(existsSync(path.join(kept.dir, "frames", "f00025.png")), "--keep-frames leaves the frames beside the video");
});

test("without ffmpeg the video is skipped with a note, not failed", async () => {
  const dir = await sceneDir();
  const specFile = path.join(dir, "demo.motion.json");
  await writeFile(specFile, JSON.stringify(spec()));
  const made = await makeMotion({ config: { out: path.join(dir, "out") }, specPath: specFile, formats: ["mp4", "poster"], env: { PATH: dir, ONMODEL_FFMPEG: path.join(dir, "no-ffmpeg") }, log: () => {} });
  assert.equal(made.facts.verdict, "good");
  assert.match(made.facts.mp4.skipped, /ffmpeg was not found/);
  assert.ok(!made.files.mp4);
  assert.ok(existsSync(made.files.poster));
});
