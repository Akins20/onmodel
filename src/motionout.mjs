/**
 * One timeline written for every place it has to play: an Android animated vector drawable (the
 * splash screen, icons), Lottie JSON (screens inside an app, on Android, iOS and the web), and an
 * SVG animated with CSS (a web page). Each is read back by motionread.mjs and drawn again, so a
 * writer that says something the timeline did not is caught on the run that made it.
 */

import { walk, valueAt, BEZIERS } from "./motion.mjs";

const PROPS = ["translateX", "translateY", "scaleX", "scaleY", "rotate", "opacity"];
const r4 = (v) => {
  const s = (Math.round(v * 10000) / 10000).toString();
  return s === "-0" ? "0" : s;
};
const hex2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0").toUpperCase();
const hexColour = ([r, g, b]) => `#${hex2(r)}${hex2(g)}${hex2(b)}`;
const xmlEsc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/**
 * Sample times inside a segment for an easing no Bezier can say: the segment's ends and every frame
 * of the timeline's own frame grid between them, so each frame a player draws lands on a sample.
 */
function sampleTimes(t0, t1, fps) {
  const step = 1000 / fps;
  const out = [t0];
  for (let k = Math.floor(t0 / step) + 1; k * step < t1 - 1e-6; k++) if (k * step > t0 + 1e-6) out.push(k * step);
  out.push(t1);
  return out;
}

// ---------------------------------------------------------------- Android

/** Android's interpolator resource for an easing, or a pathInterpolator written inline. */
const ANDROID_RES = {
  linear: "linear",
  "fast-out-slow-in": "fast_out_slow_in",
  "linear-out-slow-in": "linear_out_slow_in",
  "fast-out-linear-in": "fast_out_linear_in",
  overshoot: "overshoot",
  anticipate: "anticipate",
  "anticipate-overshoot": "anticipate_overshoot",
  bounce: "bounce",
  accelerate: "accelerate_quad",
  decelerate: "decelerate_quad",
  "accelerate-cubic": "accelerate_cubic",
  "decelerate-cubic": "decelerate_cubic",
  "accelerate-decelerate": "accelerate_decelerate",
};

const ANDROID_PROP = { translateX: "translateX", translateY: "translateY", scaleX: "scaleX", scaleY: "scaleY", rotate: "rotation" };

/**
 * The scene as one Android animated vector drawable, its vector and animations inlined. Groups take
 * the transforms; a group cannot fade, so a layer's opacity becomes the fillAlpha of every path in
 * it, which only works while one layer on the way down to a path animates its opacity. Returns
 * { xml, problems }: with problems the drawable cannot say what the timeline says and is not written.
 */
export function androidAVD(scene, { width = null, height = null } = {}) {
  const problems = [];
  const w = width ?? scene.android.width ?? `${r4((108 * scene.width) / Math.max(scene.width, scene.height))}dp`;
  const h = height ?? scene.android.height ?? `${r4((108 * scene.height) / Math.max(scene.width, scene.height))}dp`;
  if (scene.android.splash && scene.duration > 1000) problems.push(`the splash animation runs ${scene.duration} ms; Android 12 and later stop a splash icon's animation at 1000 ms`);
  const targets = [];
  const animated = (n, p) => scene.tracks.has(`${n.id}.${p}`);
  const interp = (ease, indent) => {
    if (ease.name && ANDROID_RES[ease.name]) return { attr: ` android:interpolator="@android:interpolator/${ANDROID_RES[ease.name]}"`, inner: "" };
    const [x1, y1, x2, y2] = ease.p;
    return {
      attr: "",
      inner: `\n${indent}    <aapt:attr name="android:interpolator">\n${indent}        <pathInterpolator android:controlX1="${r4(x1)}" android:controlY1="${r4(y1)}" android:controlX2="${r4(x2)}" android:controlY2="${r4(y2)}" />\n${indent}    </aapt:attr>\n${indent}`,
    };
  };
  const animator = (prop, s, scaleBy = 1) => {
    const ind = "                ";
    const { attr, inner } = interp(s.ease, ind);
    const head = `${ind}<objectAnimator android:propertyName="${prop}" android:valueFrom="${r4(s.v0 * scaleBy)}" android:valueTo="${r4(s.v1 * scaleBy)}" android:startOffset="${Math.round(s.t0)}" android:duration="${Math.round(s.t1 - s.t0)}" android:valueType="floatType"${attr}`;
    return inner ? `${head}>${inner}</objectAnimator>` : `${head} />`;
  };
  const lines = [];
  const visit = (n, depth, alphaChain) => {
    const ind = "    ".repeat(depth + 3);
    const v = {};
    for (const p of PROPS) v[p] = valueAt(n, p, scene.tracks, 0);
    const attrs = [`android:name="${n.id}"`];
    if (v.translateX) attrs.push(`android:translateX="${r4(v.translateX)}"`);
    if (v.translateY) attrs.push(`android:translateY="${r4(v.translateY)}"`);
    if (n.pivot[0]) attrs.push(`android:pivotX="${r4(n.pivot[0])}"`);
    if (n.pivot[1]) attrs.push(`android:pivotY="${r4(n.pivot[1])}"`);
    if (v.scaleX !== 1) attrs.push(`android:scaleX="${r4(v.scaleX)}"`);
    if (v.scaleY !== 1) attrs.push(`android:scaleY="${r4(v.scaleY)}"`);
    if (v.rotate) attrs.push(`android:rotation="${r4(v.rotate)}"`);
    lines.push(`${ind}<group ${attrs.join(" ")}>`);
    const groupAnims = [];
    for (const p of Object.keys(ANDROID_PROP)) if (animated(n, p)) for (const s of scene.tracks.get(`${n.id}.${p}`).segments) groupAnims.push(animator(ANDROID_PROP[p], s));
    if (groupAnims.length) targets.push({ name: n.id, anims: groupAnims });
    // The opacity reaching this layer's paths: a constant factor and at most one animated track.
    let chain = alphaChain;
    if (animated(n, "opacity")) {
      if (chain.track) problems.push(`layers ${chain.track.id} and ${n.id} both animate opacity and one holds the other; an Android vector cannot fade a group, only each path once, so give the fade to one of them`);
      chain = { factor: chain.factor, track: scene.tracks.get(`${n.id}.opacity`) };
    } else chain = { factor: chain.factor * n.values.opacity, track: chain.track };
    n.paths.forEach((p, k) => {
      const base = p.alpha * chain.factor;
      // Before its first animation a track holds that animation's starting value.
      const alpha0 = chain.track ? base * chain.track.segments[0].v0 : base;
      const name = chain.track ? `${n.id}_${k}` : null;
      const pa = [];
      if (name) pa.push(`android:name="${name}"`);
      pa.push(`android:fillColor="${hexColour(p.fill)}"`);
      if (Math.abs(alpha0 - 1) > 1e-9) pa.push(`android:fillAlpha="${r4(alpha0)}"`);
      if (p.rule === "evenodd") pa.push(`android:fillType="evenOdd"`);
      pa.push(`android:pathData="${xmlEsc(p.d)}"`);
      lines.push(`${ind}    <path ${pa.join(" ")} />`);
      if (name) targets.push({ name, anims: chain.track.segments.map((s) => animator("fillAlpha", s, base)) });
    });
    for (const c of n.children) visit(c, depth + 1, chain);
    lines.push(`${ind}</group>`);
  };
  for (const n of scene.roots) visit(n, 0, { factor: 1, track: null });
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<!-- ${xmlEsc(scene.name)}: written by onmodel motion${scene.specFile ? ` from ${xmlEsc(scene.specFile)}` : ""}; edit the spec, not this file. Plays ${Math.round(scene.duration)} ms. -->`,
    '<animated-vector xmlns:android="http://schemas.android.com/apk/res/android"',
    '    xmlns:aapt="http://schemas.android.com/aapt">',
    '    <aapt:attr name="android:drawable">',
    `        <vector android:width="${w}" android:height="${h}"`,
    `            android:viewportWidth="${r4(scene.width)}" android:viewportHeight="${r4(scene.height)}">`,
    ...lines,
    "        </vector>",
    "    </aapt:attr>",
    ...targets.flatMap((t) => [`    <target android:name="${t.name}">`, '        <aapt:attr name="android:animation">', "            <set>", ...t.anims, "            </set>", "        </aapt:attr>", "    </target>"]),
    "</animated-vector>",
    "",
  ].join("\n");
  return { xml, problems };
}

// ---------------------------------------------------------------- Lottie

/** A path's subpaths as Lottie's vertices with in and out tangents relative to each vertex. */
export function lottieShapes(d) {
  const tokens = d.match(/[MLHVCZ]|-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? [];
  const shapes = [];
  let cur = null;
  let x = 0;
  let y = 0;
  let i = 0;
  const num = () => Number(tokens[i++]);
  const close = () => {
    if (!cur || cur.v.length < 2) return;
    const n = cur.v.length - 1;
    if (Math.abs(cur.v[n][0] - cur.v[0][0]) < 1e-6 && Math.abs(cur.v[n][1] - cur.v[0][1]) < 1e-6) {
      cur.i[0] = cur.i[n];
      cur.v.pop();
      cur.i.pop();
      cur.o.pop();
    }
  };
  while (i < tokens.length) {
    const cmd = tokens[i++];
    if (cmd === "M") {
      close();
      x = num();
      y = num();
      cur = { v: [[x, y]], i: [[0, 0]], o: [[0, 0]] };
      shapes.push(cur);
    } else if (cmd === "L" || cmd === "H" || cmd === "V") {
      if (cmd === "L") {
        x = num();
        y = num();
      } else if (cmd === "H") x = num();
      else y = num();
      cur.v.push([x, y]);
      cur.i.push([0, 0]);
      cur.o.push([0, 0]);
    } else if (cmd === "C") {
      const c1 = [num(), num()];
      const c2 = [num(), num()];
      const p = [num(), num()];
      const last = cur.v.length - 1;
      cur.o[last] = [c1[0] - cur.v[last][0], c1[1] - cur.v[last][1]];
      cur.v.push(p);
      cur.i.push([c2[0] - p[0], c2[1] - p[1]]);
      cur.o.push([0, 0]);
      [x, y] = p;
    } else if (cmd !== "Z" && cmd !== "z") throw new Error(`unexpected path command ${cmd}`);
  }
  close();
  return shapes.filter((s) => s.v.length >= 2).map((s) => ({ ...s, c: true }));
}

const kfTime = (t, fps) => +((t * fps) / 1000).toFixed(4);
const LINEAR = { o: { x: [0], y: [0] }, i: { x: [1], y: [1] } };

/**
 * A property's keyframes from tracks that share one timeline (scale's x and y, say): Bezier
 * easings carried as they are, any other easing sampled once a frame with linear steps between,
 * holds where nothing moves.
 */
function keyframes(tracks, mapValue, fps, nodeValues) {
  // Lottie keys every value as an array, one entry per dimension, even a rotation.
  const map = (vs) => {
    const v = mapValue(vs);
    return Array.isArray(v) ? v : [v];
  };
  const segs = tracks[0].segments;
  const dims = map(tracks.map(() => 0)).length;
  const rep = (v) => Array.from({ length: dims }, () => v);
  const out = [];
  segs.forEach((s, k) => {
    const valuesAt = (t) => map(tracks.map((tr) => valueAtTrack(tr, t)));
    if (s.ease.kind === "bezier") {
      const [x1, y1, x2, y2] = s.ease.p;
      out.push({ t: kfTime(s.t0, fps), s: map(tracks.map((tr) => tr.segments[k].v0)), o: { x: rep(x1), y: rep(y1) }, i: { x: rep(x2), y: rep(y2) } });
    } else {
      for (const t of sampleTimes(s.t0, s.t1, fps).slice(0, -1)) out.push({ t: kfTime(t, fps), s: valuesAt(t), o: { x: rep(0), y: rep(0) }, i: { x: rep(1), y: rep(1) } });
    }
    const next = segs[k + 1];
    const endValue = map(tracks.map((tr) => tr.segments[k].v1));
    if (!next) out.push({ t: kfTime(s.t1, fps), s: endValue });
    else if (next.t0 > s.t1 + 1e-9) out.push({ t: kfTime(s.t1, fps), s: endValue, h: 1 });
  });
  return { a: 1, k: out };
  function valueAtTrack(tr, t) {
    return valueAt({ id: tr.id, values: nodeValues }, tr.prop, new Map([[`${tr.id}.${tr.prop}`, tr]]), t);
  }
}

/** True when two tracks change at the same moments with the same easings, so one keyframe list can carry both. */
function sameTiming(a, b) {
  if (!a || !b || a.segments.length !== b.segments.length) return false;
  return a.segments.every((s, k) => {
    const o = b.segments[k];
    return Math.abs(s.t0 - o.t0) < 1e-9 && Math.abs(s.t1 - o.t1) < 1e-9 && s.ease === o.ease;
  });
}

/** Two properties sampled together across the whole timeline, for a pair Lottie must key as one. */
function sampledPair(scene, n, pa, pb, map) {
  const out = [];
  const times = sampleTimes(0, scene.duration, scene.fps);
  times.forEach((t, k) => {
    const v = map([valueAt(n, pa, scene.tracks, t), valueAt(n, pb, scene.tracks, t)]);
    out.push(k < times.length - 1 ? { t: kfTime(t, scene.fps), s: v, o: { x: [0, 0], y: [0, 0] }, i: { x: [1, 1], y: [1, 1] } } : { t: kfTime(t, scene.fps), s: v });
  });
  return { a: 1, k: out };
}

/**
 * The scene as Lottie JSON: one shape layer holding the tree as nested groups, each with its own
 * transform (anchor at the pivot, position at the pivot plus the translate), which is the same
 * transform Android's groups apply. Lottie draws a group's first item on top, so children are
 * written in reverse.
 */
export function lottieJSON(scene) {
  const fps = scene.fps;
  const animated = (n, p) => scene.tracks.get(`${n.id}.${p}`);
  const prop = (n, p, map) => {
    const tr = animated(n, p);
    return tr ? keyframes([tr], (vs) => map(vs[0]), fps, n.values) : { a: 0, k: map(n.values[p]) };
  };
  const transform = (n) => {
    const [px, py] = n.pivot;
    const tx = animated(n, "translateX");
    const ty = animated(n, "translateY");
    const position =
      tx || ty
        ? { s: true, x: tx ? keyframes([tx], (vs) => vs[0] + px, fps, n.values) : { a: 0, k: n.values.translateX + px }, y: ty ? keyframes([ty], (vs) => vs[0] + py, fps, n.values) : { a: 0, k: n.values.translateY + py } }
        : { a: 0, k: [n.values.translateX + px, n.values.translateY + py] };
    const sx = animated(n, "scaleX");
    const sy = animated(n, "scaleY");
    const scaleMap = (vs) => [vs[0] * 100, vs[1] * 100];
    const scale = !sx && !sy ? { a: 0, k: scaleMap([n.values.scaleX, n.values.scaleY]) } : sameTiming(sx, sy) ? keyframes([sx, sy], scaleMap, fps, n.values) : sampledPair(scene, n, "scaleX", "scaleY", scaleMap);
    return {
      ty: "tr",
      nm: "Transform",
      a: { a: 0, k: [px, py] },
      p: position,
      s: scale,
      r: prop(n, "rotate", (v) => v),
      o: prop(n, "opacity", (v) => v * 100),
      sk: { a: 0, k: 0 },
      sa: { a: 0, k: 0 },
    };
  };
  const identity = { ty: "tr", nm: "Transform", a: { a: 0, k: [0, 0] }, p: { a: 0, k: [0, 0] }, s: { a: 0, k: [100, 100] }, r: { a: 0, k: 0 }, o: { a: 0, k: 100 }, sk: { a: 0, k: 0 }, sa: { a: 0, k: 0 } };
  const pathGroup = (p) => ({
    ty: "gr",
    nm: p.key,
    it: [
      ...lottieShapes(p.d).map((s, k) => ({ ty: "sh", nm: `${p.key}#${k}`, ks: { a: 0, k: { i: s.i, o: s.o, v: s.v, c: true } } })),
      { ty: "fl", nm: "Fill", c: { a: 0, k: [p.fill[0] / 255, p.fill[1] / 255, p.fill[2] / 255, 1] }, o: { a: 0, k: p.alpha * 100 }, r: p.rule === "evenodd" ? 2 : 1 },
      identity,
    ],
  });
  const group = (n) => ({ ty: "gr", nm: n.id, it: [...[...n.paths].reverse().map(pathGroup), ...[...n.children].reverse().map(group), transform(n)] });
  // A layer shows for frames ip <= f < op, so the out point is one frame past the end: with op at
  // the last frame, lottie-web drew nothing at all on the frame that should hold the finished mark.
  const frames = Math.round((scene.duration * fps) / 1000) + 1;
  return {
    v: "5.7.0",
    fr: fps,
    ip: 0,
    op: frames,
    w: scene.width,
    h: scene.height,
    nm: scene.name,
    ddd: 0,
    assets: [],
    layers: [
      {
        ddd: 0,
        ind: 1,
        ty: 4,
        nm: scene.name,
        sr: 1,
        ks: { o: { a: 0, k: 100 }, r: { a: 0, k: 0 }, p: { a: 0, k: [0, 0, 0] }, a: { a: 0, k: [0, 0, 0] }, s: { a: 0, k: [100, 100, 100] } },
        ao: 0,
        shapes: [...scene.roots].reverse().map(group),
        ip: 0,
        op: frames,
        st: 0,
        bm: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------- SVG with CSS

/** A group transform as CSS writes it: translate to the pivot, rotate, scale, translate back. */
const cssTransform = (v, [px, py]) => `translate(${r4(v.translateX + px)}px,${r4(v.translateY + py)}px) rotate(${r4(v.rotate)}deg) scale(${r4(v.scaleX)},${r4(v.scaleY)}) translate(${r4(-px)}px,${r4(-py)}px)`;
const svgTransform = (v, [px, py]) => `translate(${r4(v.translateX + px)} ${r4(v.translateY + py)}) rotate(${r4(v.rotate)}) scale(${r4(v.scaleX)} ${r4(v.scaleY)}) translate(${r4(-px)} ${r4(-py)})`;

/**
 * The scene as an SVG animated with CSS: each moving group gets its own keyframes, sampled once a
 * frame so any easing plays as drawn here, linear between samples. It plays once and holds the end
 * (or loops when the spec says so), which suits a page that shows it as it loads.
 */
export function animatedSVG(scene) {
  const fps = scene.fps;
  const times = (() => {
    const n = Math.max(1, Math.round((scene.duration * fps) / 1000));
    return Array.from({ length: n + 1 }, (_, k) => (scene.duration * k) / n);
  })();
  const css = [];
  const body = [];
  const visit = (n, depth) => {
    const ind = "  ".repeat(depth + 1);
    const moves = PROPS.some((p) => scene.tracks.has(`${n.id}.${p}`));
    const v0 = {};
    for (const p of PROPS) v0[p] = valueAt(n, p, scene.tracks, 0);
    if (moves) {
      const frames = times.map((t) => {
        const v = {};
        for (const p of PROPS) v[p] = valueAt(n, p, scene.tracks, t);
        return `${r4((t / scene.duration) * 100)}%{transform:${cssTransform(v, n.pivot)};opacity:${r4(v.opacity)}}`;
      });
      css.push(`@keyframes m_${n.id}{${frames.join("")}}`);
      css.push(`#${n.id}{transform-box:view-box;transform-origin:0 0;transform:${cssTransform(v0, n.pivot)};opacity:${r4(v0.opacity)};animation:m_${n.id} ${Math.round(scene.duration)}ms linear 0s ${scene.loop ? "infinite" : "1"} both}`);
      body.push(`${ind}<g id="${n.id}">`);
    } else {
      const op = n.values.opacity !== 1 ? ` opacity="${r4(n.values.opacity)}"` : "";
      body.push(`${ind}<g id="${n.id}" transform="${svgTransform(v0, n.pivot)}"${op}>`);
    }
    for (const p of n.paths) {
      const fo = Math.abs(p.alpha - 1) > 1e-9 ? ` fill-opacity="${r4(p.alpha)}"` : "";
      const rule = p.rule === "evenodd" ? ' fill-rule="evenodd"' : "";
      body.push(`${ind}  <path data-key="${xmlEsc(p.key)}" fill="${hexColour(p.fill).toLowerCase()}"${fo}${rule} d="${xmlEsc(p.d)}"/>`);
    }
    for (const c of n.children) visit(c, depth + 1);
    body.push(`${ind}</g>`);
  };
  for (const n of scene.roots) visit(n, 0);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${r4(scene.width)} ${r4(scene.height)}" width="${r4(scene.width)}" height="${r4(scene.height)}" data-duration="${Math.round(scene.duration)}" data-fps="${fps}">`,
    `  <title>${xmlEsc(scene.name)}</title>`,
    // With reduced motion the animation starts at its end, so the page shows the finished artwork
    // rather than the first frame, where parts may not have appeared yet.
    `  <style>${css.join("")}@media (prefers-reduced-motion:reduce){g{animation-delay:-${Math.round(scene.duration)}ms!important;animation-iteration-count:1!important}}</style>`,
    ...body,
    "</svg>",
    "",
  ].join("\n");
}

export { BEZIERS };
