/**
 * Reads back what motionout.mjs wrote, each format the way its own player reads it, into a scene
 * motion.mjs can draw: Android's groups and object animators with the framework's interpolators,
 * Lottie's anchor and position with each keyframe's own easing curve, and the SVG's CSS keyframes.
 * Drawn again and compared with the timeline, frame by frame, they show whether each file says
 * what the timeline says.
 */

import { easing, bezierEase } from "./motion.mjs";
import { parseColor } from "./color.mjs";

const IDENTITY = () => ({ translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1 });
const attrs = (s) => {
  const out = {};
  // Names may hold colons (android:name) and hyphens (fill-rule, data-key).
  for (const m of String(s).matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
};
const unesc = (s) => String(s).replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&amp;/g, "&");

function addSegment(tracks, id, prop, seg) {
  const key = `${id}.${prop}`;
  if (!tracks.has(key)) tracks.set(key, { id, prop, segments: [] });
  tracks.get(key).segments.push(seg);
}

function finish(tracks) {
  let end = 0;
  for (const tr of tracks.values()) {
    tr.segments.sort((a, b) => a.t0 - b.t0);
    end = Math.max(end, tr.segments[tr.segments.length - 1].t1);
  }
  return end;
}

// ---------------------------------------------------------------- Android

/** Android's interpolator resources by name, as the framework computes them. */
const ANDROID_NAMES = {
  linear: "linear",
  fast_out_slow_in: "fast-out-slow-in",
  linear_out_slow_in: "linear-out-slow-in",
  fast_out_linear_in: "fast-out-linear-in",
  overshoot: "overshoot",
  anticipate: "anticipate",
  anticipate_overshoot: "anticipate-overshoot",
  bounce: "bounce",
  accelerate_quad: "accelerate",
  decelerate_quad: "decelerate",
  accelerate_cubic: "accelerate-cubic",
  decelerate_cubic: "decelerate-cubic",
  accelerate_decelerate: "accelerate-decelerate",
};

/** An Android colour, #RGB, #ARGB, #RRGGBB or #AARRGGBB, as { rgb, a }. */
function androidColour(s) {
  let h = String(s).replace("#", "");
  if (h.length === 3 || h.length === 4) h = h.split("").map((c) => c + c).join("");
  // Android puts alpha first: AARRGGBB.
  if (h.length === 8) return { rgb: [2, 4, 6].map((i) => parseInt(h.slice(i, i + 2), 16)), a: parseInt(h.slice(0, 2), 16) / 255 };
  const c = parseColor(`#${h}`);
  if (!c) throw new Error(`the drawable has a colour Android would not read: ${s}`);
  return c;
}

/** An animated vector drawable as the phone plays it. */
export function readAVD(xml) {
  const vectorTag = /<vector\b([^>]*)>/.exec(xml);
  if (!vectorTag) throw new Error("the drawable has no <vector>");
  const va = attrs(vectorTag[1]);
  const width = Number(va["android:viewportWidth"]);
  const height = Number(va["android:viewportHeight"]);
  const inner = xml.slice(vectorTag.index + vectorTag[0].length, xml.indexOf("</vector>"));
  const roots = [];
  const stack = [];
  let auto = 0;
  const push = (node) => (stack.length ? stack[stack.length - 1].children : roots).push(node);
  for (const m of inner.matchAll(/<group\b([^>]*)>|<\/group>|<path\b([^>]*?)\/>/g)) {
    if (m[0].startsWith("</group")) {
      stack.pop();
      continue;
    }
    if (m[1] !== undefined) {
      const a = attrs(m[1]);
      const values = IDENTITY();
      values.translateX = Number(a["android:translateX"] ?? 0);
      values.translateY = Number(a["android:translateY"] ?? 0);
      values.scaleX = Number(a["android:scaleX"] ?? 1);
      values.scaleY = Number(a["android:scaleY"] ?? 1);
      values.rotate = Number(a["android:rotation"] ?? 0);
      const node = { id: a["android:name"] ?? `g_${++auto}`, values, pivot: [Number(a["android:pivotX"] ?? 0), Number(a["android:pivotY"] ?? 0)], paths: [], children: [] };
      push(node);
      stack.push(node);
      continue;
    }
    // A path is a leaf of its own, so the fillAlpha Android animates on it is that leaf's opacity.
    const a = attrs(m[2]);
    const colour = androidColour(a["android:fillColor"] ?? "#000000");
    const values = IDENTITY();
    values.opacity = Number(a["android:fillAlpha"] ?? 1) * colour.a;
    const id = a["android:name"] ?? `p_${++auto}`;
    push({ id, values, pivot: [0, 0], paths: [{ key: id, d: unesc(a["android:pathData"]), fill: colour.rgb, alpha: 1, rule: a["android:fillType"] === "evenOdd" ? "evenodd" : "nonzero" }], children: [] });
  }
  const tracks = new Map();
  const PROP = { translateX: "translateX", translateY: "translateY", scaleX: "scaleX", scaleY: "scaleY", rotation: "rotate", fillAlpha: "opacity" };
  for (const t of xml.matchAll(/<target android:name="([^"]+)">([\s\S]*?)<\/target>/g)) {
    for (const o of t[2].matchAll(/<objectAnimator\b([^>]*?)(?:\/>|>([\s\S]*?)<\/objectAnimator>)/g)) {
      const a = attrs(o[1]);
      const prop = PROP[a["android:propertyName"]];
      if (!prop) throw new Error(`the drawable animates ${a["android:propertyName"]}, which motion does not write`);
      let ease;
      const res = /@android:interpolator\/(\w+)/.exec(a["android:interpolator"] ?? "");
      if (res) {
        if (!ANDROID_NAMES[res[1]]) throw new Error(`the drawable uses the interpolator ${res[1]}, which motion does not write`);
        ease = easing(ANDROID_NAMES[res[1]]);
      } else if (o[2] && /<pathInterpolator/.test(o[2])) {
        const pa = attrs(/<pathInterpolator\b([^>]*)\/>/.exec(o[2])[1]);
        ease = easing(["controlX1", "controlY1", "controlX2", "controlY2"].map((k) => Number(pa[`android:${k}`])));
      } else ease = easing("accelerate-decelerate"); // what an ObjectAnimator uses when none is given
      const t0 = Number(a["android:startOffset"] ?? 0);
      const t1 = t0 + Number(a["android:duration"] ?? 300);
      addSegment(tracks, t[1], prop, { t0, t1, v0: Number(a["android:valueFrom"]), v1: Number(a["android:valueTo"]), ease });
    }
  }
  return { width, height, roots, tracks, duration: finish(tracks), background: null };
}

// ---------------------------------------------------------------- Lottie

/** Lottie's keyframes for one dimension of a property, as segments. */
function lottieSegments(prop, dim, fps, scale = 1, offset = 0) {
  const ks = prop.k;
  const segs = [];
  const at = (kf) => (Array.isArray(kf.s) ? kf.s[dim] : kf.s) * scale + offset;
  for (let k = 0; k + 1 < ks.length; k++) {
    const kf = ks[k];
    const next = ks[k + 1];
    const t0 = (kf.t * 1000) / fps;
    const t1 = (next.t * 1000) / fps;
    if (t1 <= t0) continue;
    if (kf.h) {
      segs.push({ t0, t1, v0: at(kf), v1: at(kf), ease: easing("linear") });
      continue;
    }
    const pick = (arr) => (Array.isArray(arr) ? (arr[dim] ?? arr[0]) : arr);
    const p = [pick(kf.o.x), pick(kf.o.y), pick(kf.i.x), pick(kf.i.y)];
    segs.push({ t0, t1, v0: at(kf), v1: at(next), ease: { kind: "bezier", p, at: (u) => bezierEase(p, u) } });
  }
  return segs;
}

/** A Lottie shape's vertices and tangents back to path text. */
function lottiePath({ v, i, o }) {
  const pt = (p) => `${p[0]} ${p[1]}`;
  let d = `M${pt(v[0])}`;
  for (let k = 1; k <= v.length; k++) {
    const a = v[k - 1];
    const b = v[k % v.length];
    const c1 = [a[0] + o[k - 1][0], a[1] + o[k - 1][1]];
    const c2 = [b[0] + i[k % v.length][0], b[1] + i[k % v.length][1]];
    d += `C${pt(c1)} ${pt(c2)} ${pt(b)}`;
  }
  return `${d}Z`;
}

/** Lottie JSON as a Lottie player reads it: each group's anchor, position, scale, rotation and opacity. */
export function readLottie(json) {
  const doc = typeof json === "string" ? JSON.parse(json) : json;
  const fps = doc.fr;
  const tracks = new Map();
  let auto = 0;
  const node = (gr) => {
    const items = gr.it ?? [];
    const tr = items.find((x) => x.ty === "tr");
    const id = gr.nm && !gr.nm.includes(":") ? gr.nm : `n_${++auto}`;
    const shapes = items.filter((x) => x.ty === "sh");
    const fill = items.find((x) => x.ty === "fl");
    const values = IDENTITY();
    const anchor = tr?.a?.k ?? [0, 0];
    const pivot = [anchor[0], anchor[1]];
    const n = { id, values, pivot, paths: [], children: [] };
    if (tr) {
      const p = tr.p;
      if (p.s) {
        for (const [axis, prop, piv] of [["x", "translateX", pivot[0]], ["y", "translateY", pivot[1]]]) {
          const q = p[axis];
          if (q.a) for (const s of lottieSegments(q, 0, fps, 1, -piv)) addSegment(tracks, id, prop, s);
          else values[prop] = (Array.isArray(q.k) ? q.k[0] : q.k) - piv;
        }
      } else if (p.a) {
        for (const s of lottieSegments(p, 0, fps, 1, -pivot[0])) addSegment(tracks, id, "translateX", s);
        for (const s of lottieSegments(p, 1, fps, 1, -pivot[1])) addSegment(tracks, id, "translateY", s);
      } else {
        values.translateX = p.k[0] - pivot[0];
        values.translateY = p.k[1] - pivot[1];
      }
      if (tr.s.a) {
        for (const s of lottieSegments(tr.s, 0, fps, 0.01)) addSegment(tracks, id, "scaleX", s);
        for (const s of lottieSegments(tr.s, 1, fps, 0.01)) addSegment(tracks, id, "scaleY", s);
      } else {
        values.scaleX = tr.s.k[0] / 100;
        values.scaleY = tr.s.k[1] / 100;
      }
      if (tr.r.a) for (const s of lottieSegments(tr.r, 0, fps)) addSegment(tracks, id, "rotate", s);
      else values.rotate = Array.isArray(tr.r.k) ? tr.r.k[0] : tr.r.k;
      if (tr.o.a) for (const s of lottieSegments(tr.o, 0, fps, 0.01)) addSegment(tracks, id, "opacity", s);
      else values.opacity = (Array.isArray(tr.o.k) ? tr.o.k[0] : tr.o.k) / 100;
    }
    if (shapes.length) {
      const c = fill.c.k;
      n.paths.push({ key: gr.nm, d: shapes.map((s) => lottiePath(s.ks.k)).join(""), fill: [c[0] * 255, c[1] * 255, c[2] * 255], alpha: fill.o.k / 100, rule: fill.r === 2 ? "evenodd" : "nonzero" });
    }
    // The first item draws on top, so paint order is the reverse.
    for (const child of [...items].reverse()) if (child.ty === "gr") n.children.push(node(child));
    return n;
  };
  const layer = doc.layers[0];
  const roots = [...layer.shapes].reverse().map(node);
  const end = finish(tracks);
  // The out point is exclusive, so the last frame shown is the one before it, and a player draws
  // nothing at a frame outside the layer's in and out points.
  const hiddenAt = (t) => {
    const f = (t * fps) / 1000;
    return f < (layer.ip ?? 0) - 1e-6 || f >= Math.min(layer.op, doc.op) - 1e-6;
  };
  return { width: doc.w, height: doc.h, roots, tracks, duration: Math.max(end, ((doc.op - 1) * 1000) / fps), hiddenAt, background: null };
}

// ---------------------------------------------------------------- SVG

/** The transform motion writes, read back: translate(a, b) rotate(r) scale(sx, sy) translate(c, d). */
function readTransform(s) {
  const nums = (String(s).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).map(Number);
  if (nums.length !== 7) throw new Error(`the SVG has a transform motion did not write: ${s}`);
  const [a, b, r, sx, sy, c, d] = nums;
  return { values: { translateX: a + c, translateY: b + d, rotate: r, scaleX: sx, scaleY: sy }, pivot: [-c, -d] };
}

/** The animated SVG as a browser plays it, its CSS keyframes linear between samples. */
export function readSVG(text) {
  const view = /viewBox="0 0 ([\d.]+) ([\d.]+)"/.exec(text);
  const duration = Number(/data-duration="([\d.]+)"/.exec(text)?.[1] ?? 0);
  const css = /<style>([\s\S]*?)<\/style>/.exec(text)?.[1] ?? "";
  const frames = new Map();
  for (const m of css.matchAll(/@keyframes m_(\w+)\{((?:[\d.]+%\{[^}]*\})+)\}/g)) {
    frames.set(m[1], [...m[2].matchAll(/([\d.]+)%\{transform:([^;]*);opacity:([\d.]+)\}/g)].map((f) => ({ t: (Number(f[1]) / 100) * duration, ...readTransform(f[2]), opacity: Number(f[3]) })));
  }
  const tracks = new Map();
  const roots = [];
  const stack = [];
  for (const m of text.matchAll(/<g\b([^>]*)>|<\/g>|<path\b([^>]*?)\/>/g)) {
    if (m[0] === "</g>") {
      stack.pop();
      continue;
    }
    if (m[1] !== undefined) {
      const a = attrs(m[1]);
      const id = a.id;
      let values = IDENTITY();
      let pivot = [0, 0];
      const kf = frames.get(id);
      if (kf) {
        pivot = kf[0].pivot;
        values = { ...kf[0].values, opacity: kf[0].opacity };
        for (let k = 0; k + 1 < kf.length; k++) {
          for (const prop of ["translateX", "translateY", "scaleX", "scaleY", "rotate"]) addSegment(tracks, id, prop, { t0: kf[k].t, t1: kf[k + 1].t, v0: kf[k].values[prop], v1: kf[k + 1].values[prop], ease: easing("linear") });
          addSegment(tracks, id, "opacity", { t0: kf[k].t, t1: kf[k + 1].t, v0: kf[k].opacity, v1: kf[k + 1].opacity, ease: easing("linear") });
        }
      } else if (a.transform) {
        const tr = readTransform(a.transform);
        values = { ...tr.values, opacity: Number(a.opacity ?? 1) };
        pivot = tr.pivot;
      }
      const node = { id, values, pivot, paths: [], children: [] };
      (stack.length ? stack[stack.length - 1].children : roots).push(node);
      stack.push(node);
      continue;
    }
    const a = attrs(m[2]);
    const c = parseColor(a.fill);
    stack[stack.length - 1].paths.push({ key: unesc(a["data-key"] ?? ""), d: unesc(a.d), fill: c.rgb, alpha: Number(a["fill-opacity"] ?? 1) * c.a, rule: a["fill-rule"] === "evenodd" ? "evenodd" : "nonzero" });
  }
  finish(tracks);
  return { width: Number(view?.[1] ?? 0), height: Number(view?.[2] ?? 0), roots, tracks, duration, background: null };
}
