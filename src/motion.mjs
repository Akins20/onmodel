/**
 * Motion: shapes onmodel already made, moved over time.
 *
 * A motion spec names its shapes (an SVG onmodel traced, split into its pieces, or a line of text
 * set letter by letter from a real font), arranges them in a tree of groups, and moves the groups:
 * translate, scale and rotate about a pivot, and opacity, each property keyframed from one value to
 * another over a span of milliseconds with an easing. That is the model Android's animated vector
 * drawables, Lottie and CSS all share, so one timeline is written to all three, and to GIF, APNG and
 * video by drawing it here.
 *
 * Every group transforms the way Android's VectorDrawable groups do: scale, then rotate, both about
 * the pivot, then translate. Lottie's anchor and position say the same thing, so a timeline means the
 * same in every format it is written to.
 *
 * Easing is either a cubic Bezier (CSS's and Android's pathInterpolator) or one of Android's own
 * interpolators, computed here exactly as the framework computes them, so the drawable played by the
 * phone and the frames drawn here agree.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToPolygons, coverage } from "./vector.mjs";
import { loadFont } from "./font.mjs";
import { parseColor } from "./color.mjs";

// ---------------------------------------------------------------- easing

/** Named cubic Beziers: CSS's keywords and Android's material curves. */
export const BEZIERS = {
  linear: [0, 0, 1, 1],
  ease: [0.25, 0.1, 0.25, 1],
  "ease-in": [0.42, 0, 1, 1],
  "ease-out": [0, 0, 0.58, 1],
  "ease-in-out": [0.42, 0, 0.58, 1],
  "fast-out-slow-in": [0.4, 0, 0.2, 1],
  "linear-out-slow-in": [0, 0, 0.2, 1],
  "fast-out-linear-in": [0.4, 0, 1, 1],
};

/** Android's framework interpolators, as android.view.animation computes them with their default settings. */
export const ANDROID_EASINGS = {
  overshoot: (t) => {
    const T = 2;
    const s = t - 1;
    return s * s * ((T + 1) * s + T) + 1;
  },
  anticipate: (t) => {
    const T = 2;
    return t * t * ((T + 1) * t - T);
  },
  "anticipate-overshoot": (t) => {
    const T = 3;
    const a = (u) => u * u * ((T + 1) * u - T);
    const o = (u) => u * u * ((T + 1) * u + T);
    return t < 0.5 ? 0.5 * a(t * 2) : 0.5 * (o(t * 2 - 2) + 2);
  },
  bounce: (t) => {
    const b = (u) => u * u * 8;
    const s = t * 1.1226;
    if (s < 0.3535) return b(s);
    if (s < 0.7408) return b(s - 0.54719) + 0.7;
    if (s < 0.9644) return b(s - 0.8526) + 0.9;
    return b(s - 1.0435) + 0.95;
  },
  accelerate: (t) => t * t,
  decelerate: (t) => 1 - (1 - t) * (1 - t),
  "accelerate-cubic": (t) => t * t * t,
  "decelerate-cubic": (t) => 1 - (1 - t) ** 3,
  "accelerate-decelerate": (t) => Math.cos((t + 1) * Math.PI) / 2 + 0.5,
};

/** The progress of a cubic Bezier easing at time fraction u, found by solving x(s) = u. */
export function bezierEase([x1, y1, x2, y2], u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  const bx = (s) => 3 * x1 * s * (1 - s) ** 2 + 3 * x2 * s * s * (1 - s) + s ** 3;
  const by = (s) => 3 * y1 * s * (1 - s) ** 2 + 3 * y2 * s * s * (1 - s) + s ** 3;
  const dx = (s) => 3 * x1 * (1 - s) ** 2 + 6 * (x2 - x1) * s * (1 - s) + 3 * (1 - x2) * s * s;
  let s = u;
  for (let k = 0; k < 8; k++) {
    const d = dx(s);
    if (Math.abs(d) < 1e-6) break;
    const next = s - (bx(s) - u) / d;
    if (next < 0 || next > 1) break;
    s = next;
  }
  if (Math.abs(bx(s) - u) > 1e-7) {
    let lo = 0;
    let hi = 1;
    for (let k = 0; k < 60; k++) {
      s = (lo + hi) / 2;
      if (bx(s) < u) lo = s;
      else hi = s;
    }
  }
  return by(s);
}

/** An easing from a spec: a name from either set, or [x1, y1, x2, y2]. */
export function easing(spec = "linear") {
  if (Array.isArray(spec)) {
    if (spec.length !== 4 || !spec.every(Number.isFinite)) throw new Error(`an easing given as numbers needs four, the cubic Bezier's x1, y1, x2, y2; got ${JSON.stringify(spec)}`);
    if (spec[0] < 0 || spec[0] > 1 || spec[2] < 0 || spec[2] > 1) throw new Error(`a cubic Bezier easing's x values must lie between 0 and 1; got ${JSON.stringify(spec)}`);
    return { kind: "bezier", name: null, p: spec, at: (u) => bezierEase(spec, u) };
  }
  const name = String(spec).toLowerCase().replace(/_/g, "-");
  if (BEZIERS[name]) return { kind: "bezier", name, p: BEZIERS[name], at: (u) => (name === "linear" ? Math.min(1, Math.max(0, u)) : bezierEase(BEZIERS[name], u)) };
  if (ANDROID_EASINGS[name]) return { kind: "android", name, at: (u) => ANDROID_EASINGS[name](Math.min(1, Math.max(0, u))) };
  throw new Error(`no easing named "${spec}"; use one of ${[...Object.keys(BEZIERS), ...Object.keys(ANDROID_EASINGS)].join(", ")}, or four Bezier numbers`);
}

// ---------------------------------------------------------------- sources

/** The commands onmodel's own paths use; anything else needs flattening before it can move. */
const OWN_COMMANDS = /^[MLHVCZ0-9.,\se+-]*$/;

/** Splits a path into its subpaths, each starting at its own M. */
export function subpaths(d) {
  return String(d)
    .split(/(?=M)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 1);
}

/**
 * The filled paths of an SVG, in paint order: { id, d, fill, alpha, rule }. Paths are read with
 * absolute commands only (what onmodel's own SVGs write) and without transforms, so a shape keeps
 * the coordinates it was drawn in; `split` gives every subpath its own id, `<path id>s<k>`.
 */
export function svgPaths(text, { split = false, file = "the SVG" } = {}) {
  const view = /viewBox="\s*([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)[\s,]+([-\d.]+)\s*"/.exec(text);
  const width = view ? Number(view[3]) : Number(/\bwidth="([\d.]+)/.exec(text)?.[1] ?? 0);
  const height = view ? Number(view[4]) : Number(/\bheight="([\d.]+)/.exec(text)?.[1] ?? 0);
  if (/<g[^>]*\btransform=|<path[^>]*\btransform=/.test(text)) throw new Error(`${file} places shapes with transform attributes; motion reads plain coordinates, so trace or export it without them`);
  const out = [];
  const tags = text.match(/<path\b[^>]*>/g) ?? [];
  tags.forEach((tag, i) => {
    const attr = (name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
    const style = attr("style") ?? "";
    const fromStyle = (name) => new RegExp(`${name}\\s*:\\s*([^;]+)`).exec(style)?.[1]?.trim() ?? null;
    const d = attr("d");
    if (!d) return;
    if (!OWN_COMMANDS.test(d)) throw new Error(`${file}: path ${attr("id") ?? i} uses SVG commands motion does not read (relative coordinates, arcs or quadratics); onmodel's own SVGs write absolute M, L, H, V, C and Z`);
    let fill = attr("fill") ?? fromStyle("fill") ?? "#000000";
    const variable = /var\(\s*--[\w-]+\s*,\s*([^)]+)\)/.exec(fill);
    if (variable) fill = variable[1].trim();
    if (fill === "none") return;
    const colour = parseColor(fill);
    if (!colour) throw new Error(`${file}: path ${attr("id") ?? i} has a fill motion cannot read: ${fill}`);
    const alpha = colour.a * Number(attr("fill-opacity") ?? fromStyle("fill-opacity") ?? 1) * Number(attr("opacity") ?? fromStyle("opacity") ?? 1);
    const rule = (attr("fill-rule") ?? fromStyle("fill-rule") ?? "nonzero").toLowerCase() === "evenodd" ? "evenodd" : "nonzero";
    const id = attr("id") ?? `p${i}`;
    const pieces = split ? subpaths(d) : [d];
    pieces.forEach((piece, k) => out.push({ id: split ? `${id}s${k}` : id, d: piece, fill: colour.rgb, alpha, rule }));
  });
  return { width, height, paths: out };
}

/**
 * A line of text as one path per character, each placed where the font sets it: the pen moves by
 * the advances and the kerning, and the path is the glyph's own outline. Ids are the characters'
 * indexes in the text; spaces move the pen and draw nothing.
 */
export function textPaths({ font, text, size, at = [0, 0], fill = "#000000", letterSpacing = 0, kerning = true }) {
  const colour = parseColor(fill);
  if (!colour) throw new Error(`a text layer's fill must be a colour; got ${fill}`);
  const scale = size / font.unitsPerEm;
  const [x0, baseline] = at;
  const out = [];
  let pen = 0;
  let prev = null;
  Array.from(String(text)).forEach((ch, i) => {
    const gid = font.glyphFor(ch.codePointAt(0));
    if (kerning && prev != null) pen += font.kernBetween(prev, gid);
    const d = font.glyphPath(gid, (p) => [x0 + (pen + p.x) * scale, baseline - p.y * scale]);
    if (d) out.push({ id: String(i), d, fill: colour.rgb, alpha: colour.a, rule: "nonzero", char: ch });
    pen += font.advanceOf(gid) + (letterSpacing * font.unitsPerEm) / 1000;
    prev = gid;
  });
  return { paths: out, width: pen * scale };
}

/** Loads every source a spec names, relative to the spec's own folder. */
async function loadSources(spec, dir) {
  const sources = new Map();
  for (const [name, src] of Object.entries(spec.sources ?? {})) {
    if (src.svg) {
      const file = path.resolve(dir, src.svg);
      let text;
      try {
        text = await readFile(file, "utf8");
      } catch (err) {
        throw new Error(`source "${name}": could not read ${file}: ${err.message}`);
      }
      sources.set(name, { ...svgPaths(text, { split: Boolean(src.split), file: path.basename(file) }), file });
    } else if (src.text != null) {
      if (!src.font) throw new Error(`source "${name}" sets text, so it needs a font`);
      const file = path.resolve(dir, src.font);
      const font = loadFont(await readFile(file), { variation: src.variation ?? null, instance: src.instance ?? null });
      if (!Number.isFinite(src.size) || src.size <= 0) throw new Error(`source "${name}" needs a size, the font size in canvas units`);
      sources.set(name, { ...textPaths({ font, text: src.text, size: src.size, at: src.at ?? [0, 0], fill: src.fill ?? "#000000", letterSpacing: src.letterSpacing ?? 0, kerning: src.kerning !== false }), file });
    } else throw new Error(`source "${name}" needs an svg or a text`);
  }
  return sources;
}

// ---------------------------------------------------------------- the scene

const PROPS = ["translateX", "translateY", "scaleX", "scaleY", "rotate", "opacity"];
const REST = { translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, rotate: 0, opacity: 1 };

/** Reads a node's static values: translate [x, y], pivot [x, y], scale n or [x, y], rotate, opacity. */
function staticValues(node, where) {
  const pair = (v, name) => {
    if (v == null) return null;
    if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite)) throw new Error(`${where}: ${name} must be [x, y]`);
    return v;
  };
  const translate = pair(node.translate, "translate") ?? [0, 0];
  const pivot = pair(node.pivot, "pivot") ?? [0, 0];
  const scale = node.scale == null ? null : Array.isArray(node.scale) ? pair(node.scale, "scale") : [node.scale, node.scale];
  const values = {
    translateX: translate[0],
    translateY: translate[1],
    scaleX: node.scaleX ?? scale?.[0] ?? 1,
    scaleY: node.scaleY ?? scale?.[1] ?? 1,
    rotate: node.rotate ?? 0,
    opacity: node.opacity ?? 1,
  };
  for (const [k, v] of Object.entries(values)) if (!Number.isFinite(v)) throw new Error(`${where}: ${k} must be a number`);
  if (values.opacity < 0 || values.opacity > 1) throw new Error(`${where}: opacity runs from 0 to 1`);
  return { values, pivot, given: { translate: node.translate != null, scaleX: node.scaleX != null || node.scale != null, scaleY: node.scaleY != null || node.scale != null, rotate: node.rotate != null, opacity: node.opacity != null } };
}

/** Builds the tree of groups and paths from a spec's layers, with every reference resolved. */
function buildTree(spec, sources) {
  const ids = new Set();
  let auto = 0;
  const pathIds = new Set();
  const refer = (ref, where) => {
    const m = /^([\w-]+):(.+)$/.exec(String(ref));
    if (!m) throw new Error(`${where}: a path is named source:id, such as mark:p0s1; got ${ref}`);
    const src = sources.get(m[1]);
    if (!src) throw new Error(`${where}: there is no source "${m[1]}"`);
    return { src, name: m[1], id: m[2] };
  };
  const visit = (node, where) => {
    if (typeof node !== "object" || node == null) throw new Error(`${where}: a layer is an object`);
    const id = node.id ?? `g${++auto}`;
    if (!/^[A-Za-z_][\w]*$/.test(id)) throw new Error(`${where}: layer id "${id}" must start with a letter and hold only letters, digits and underscores (Android names its groups by it)`);
    if (ids.has(id)) throw new Error(`${where}: layer id "${id}" is used twice`);
    ids.add(id);
    const { values, pivot } = staticValues(node, `layer ${id}`);
    const paths = [];
    const refs = node.path != null ? [node.path] : node.paths != null ? (Array.isArray(node.paths) ? node.paths : [node.paths]) : [];
    const except = new Set(node.except ?? []);
    for (const ref of refs) {
      const { src, name, id: pid } = refer(ref, `layer ${id}`);
      const picked = pid === "*" ? src.paths.filter((p) => !except.has(p.id)) : src.paths.filter((p) => p.id === pid);
      if (!picked.length) throw new Error(`layer ${id}: ${ref} names no path; ${name} has ${src.paths.slice(0, 12).map((p) => p.id).join(", ")}${src.paths.length > 12 ? ", ..." : ""}`);
      for (const p of picked) {
        const key = `${name}:${p.id}`;
        if (pathIds.has(key)) throw new Error(`layer ${id}: ${key} is drawn twice; a path belongs to one layer`);
        pathIds.add(key);
        const fill = node.fill != null ? parseColor(node.fill) : null;
        if (node.fill != null && !fill) throw new Error(`layer ${id}: fill ${node.fill} is not a colour`);
        paths.push({ ...p, key, fill: fill ? fill.rgb : p.fill, alpha: fill ? fill.a : p.alpha });
      }
    }
    const children = (node.children ?? []).map((c, k) => visit(c, `layer ${id}, child ${k + 1}`));
    if (paths.length && children.length) throw new Error(`layer ${id} both draws paths and holds layers; put the paths in a layer of their own`);
    return { id, values, pivot, paths, children, named: node.id != null };
  };
  const roots = (spec.layers ?? []).map((n, k) => visit(n, `layer ${k + 1}`));
  if (!roots.length) throw new Error("a motion spec needs at least one layer");
  return roots;
}

/** Every node of a tree, parents first. */
export function walk(roots, fn, parent = null) {
  for (const n of roots) {
    fn(n, parent);
    walk(n.children, fn, n);
  }
}

/**
 * The animations, compiled into one track per node and property: segments in time order, each
 * { t0, t1, v0, v1, ease }. A list entry may move several properties of one or many layers at once;
 * `stagger` starts each layer of a list that many milliseconds after the one before.
 */
function compileTracks(spec, roots) {
  const byId = new Map();
  walk(roots, (n) => byId.set(n.id, n));
  const tracks = new Map();
  const add = (id, prop, seg, where) => {
    const node = byId.get(id);
    if (!node) throw new Error(`${where}: there is no layer "${id}"`);
    const key = `${id}.${prop}`;
    if (!tracks.has(key)) tracks.set(key, { id, prop, segments: [] });
    tracks.get(key).segments.push(seg);
  };
  (spec.animate ?? []).forEach((a, k) => {
    const where = `animation ${k + 1}`;
    const targets = Array.isArray(a.target) ? a.target : [a.target];
    if (!targets.length || targets.some((t) => typeof t !== "string")) throw new Error(`${where}: target names a layer, or a list of layers`);
    const at = a.at ?? 0;
    const span = a.for ?? a.duration;
    if (!Number.isFinite(at) || at < 0) throw new Error(`${where}: at is the start in milliseconds, 0 or more`);
    if (!Number.isFinite(span) || span <= 0) throw new Error(`${where}: for is the length in milliseconds, more than 0`);
    const stagger = a.stagger ?? 0;
    const ease = easing(a.ease ?? "linear");
    const moves = [];
    const pair = (v, name) => {
      if (!Array.isArray(v) || v.length !== 2) throw new Error(`${where}: ${name} is [from, to]`);
      return v;
    };
    for (const [key, v] of Object.entries(a)) {
      if (["target", "at", "for", "duration", "stagger", "ease"].includes(key)) continue;
      if (key === "scale") {
        const [f, t] = pair(v, key);
        moves.push(["scaleX", f, t], ["scaleY", f, t]);
      } else if (key === "translate") {
        const [f, t] = pair(v, key);
        if (!Array.isArray(f) || !Array.isArray(t)) throw new Error(`${where}: translate is [[x, y], [x, y]]`);
        moves.push(["translateX", f[0], t[0]], ["translateY", f[1], t[1]]);
      } else if (PROPS.includes(key)) {
        const [f, t] = pair(v, key);
        moves.push([key, f, t]);
      } else throw new Error(`${where}: "${key}" is not something motion moves; it moves ${["scale", "translate", ...PROPS].join(", ")}`);
    }
    if (!moves.length) throw new Error(`${where}: names no property to move`);
    for (const [prop, f, t] of moves) {
      if (!Number.isFinite(f) || !Number.isFinite(t)) throw new Error(`${where}: ${prop} values must be numbers`);
      if (prop === "opacity" && (f < 0 || f > 1 || t < 0 || t > 1)) throw new Error(`${where}: opacity runs from 0 to 1`);
    }
    targets.forEach((id, i) => {
      const t0 = at + i * stagger;
      for (const [prop, v0, v1] of moves) add(id, prop, { t0, t1: t0 + span, v0, v1, ease }, where);
    });
  });
  for (const track of tracks.values()) {
    track.segments.sort((a, b) => a.t0 - b.t0);
    for (let k = 1; k < track.segments.length; k++) {
      if (track.segments[k].t0 < track.segments[k - 1].t1 - 1e-9) throw new Error(`layer ${track.id}: two animations move ${track.prop} at once (${track.segments[k - 1].t0} to ${track.segments[k - 1].t1} ms and from ${track.segments[k].t0} ms)`);
    }
    const node = byId.get(track.id);
    const first = track.segments[0];
    const given = node.values[track.prop];
    // A layer's static value is what shows before its first animation starts; Android draws the
    // drawable's own attribute until then, so the two must agree.
    if (given !== REST[track.prop] && Math.abs(given - first.v0) > 1e-9) throw new Error(`layer ${track.id}: its ${track.prop} is ${given}, but its first animation starts from ${first.v0}; leave the static value out or make them the same`);
  }
  return tracks;
}

/** A property's value at time t: its static value, or its track's. */
export function valueAt(node, prop, tracks, t) {
  const track = tracks.get(`${node.id}.${prop}`);
  if (!track) return node.values[prop];
  const segs = track.segments;
  if (t <= segs[0].t0) return segs[0].v0;
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k];
    if (t < s.t1) {
      if (t < s.t0) return segs[k - 1].v1;
      return s.v0 + (s.v1 - s.v0) * s.ease.at((t - s.t0) / (s.t1 - s.t0));
    }
  }
  return segs[segs.length - 1].v1;
}

/**
 * Loads a motion spec: { name, canvas: { width, height }, duration, fps, background, sources,
 * layers, animate, endsOn, android }. Returns the scene every writer and the renderer share.
 */
export async function loadMotion(specPath) {
  let spec;
  try {
    spec = JSON.parse(await readFile(specPath, "utf8"));
  } catch (err) {
    throw new Error(`could not read the motion spec ${specPath}: ${err.message}`);
  }
  return buildScene(spec, path.dirname(path.resolve(specPath)), { specFile: path.basename(specPath) });
}

/** The scene from a spec already in hand, its sources read relative to `dir`. */
export async function buildScene(spec, dir, { specFile = null } = {}) {
  const sources = await loadSources(spec, dir);
  const width = spec.canvas?.width ?? [...sources.values()][0]?.width;
  const height = spec.canvas?.height ?? [...sources.values()][0]?.height;
  if (!(width > 0 && height > 0)) throw new Error("a motion spec needs canvas { width, height }, unless its first source is an SVG that gives them");
  const roots = buildTree(spec, sources);
  const tracks = compileTracks(spec, roots);
  let end = 0;
  for (const tr of tracks.values()) end = Math.max(end, tr.segments[tr.segments.length - 1].t1);
  const duration = spec.duration ?? end;
  if (!(duration > 0)) throw new Error("a motion spec needs a duration, or animations that give one");
  if (duration + 1e-9 < end) throw new Error(`the duration is ${duration} ms but an animation runs to ${end} ms`);
  const fps = spec.fps ?? 60;
  if (!(fps >= 1 && fps <= 120)) throw new Error("fps runs from 1 to 120");
  let background = null;
  if (spec.background != null) {
    const c = parseColor(spec.background);
    if (!c) throw new Error(`background ${spec.background} is not a colour`);
    background = c.rgb;
  }
  return {
    name: spec.name ?? "motion",
    width,
    height,
    duration,
    fps,
    background,
    roots,
    tracks,
    endsOn: spec.endsOn ?? "artwork",
    android: spec.android ?? {},
    loop: Boolean(spec.loop),
    specFile,
  };
}

// ---------------------------------------------------------------- evaluation

const mul = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/**
 * A group's own transform, as Android's VectorDrawable builds it: scale and rotate about the
 * pivot, then translate. [a, b, c, d, e, f] maps x, y to a x + c y + e, b x + d y + f.
 */
export function groupMatrix({ translateX, translateY, scaleX, scaleY, rotate }, [px, py]) {
  const r = (rotate * Math.PI) / 180;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  // T(tx + px, ty + py) . R . S . T(-px, -py)
  const a = cos * scaleX;
  const b = sin * scaleX;
  const c = -sin * scaleY;
  const d = cos * scaleY;
  return [a, b, c, d, translateX + px - (a * px + c * py), translateY + py - (b * px + d * py)];
}

/** Every path of the scene at time t, in paint order, with its whole transform and opacity. */
export function pose(scene, t, values = null) {
  const out = [];
  const visit = (nodes, parentM, parentO) => {
    for (const n of nodes) {
      const v = {};
      for (const p of PROPS) v[p] = values ? values(n, p) : valueAt(n, p, scene.tracks, t);
      const m = mul(parentM, groupMatrix(v, n.pivot));
      const o = parentO * v.opacity;
      for (const p of n.paths) out.push({ path: p, m, opacity: o });
      visit(n.children, m, o);
    }
  };
  visit(scene.roots, [1, 0, 0, 1, 0, 0], 1);
  return out;
}

/** Every path at rest: scale 1, no rotation, full opacity, each layer at its static translate. */
export function restPose(scene) {
  return pose(scene, 0, (n, p) => (p === "translateX" || p === "translateY" ? n.values[p] : REST[p]));
}

/** The properties that end somewhere other than rest, for the end-on-the-artwork check. */
export function unsettled(scene) {
  const off = [];
  walk(scene.roots, (n) => {
    for (const p of PROPS) {
      const end = valueAt(n, p, scene.tracks, scene.duration);
      const rest = p === "translateX" || p === "translateY" ? n.values[p] : REST[p];
      let d = end - rest;
      // A full turn is rest: a spin that ends at 360 shows the artwork exactly as 0 does.
      if (p === "rotate") {
        d %= 360;
        if (d > 180) d -= 360;
        if (d <= -180) d += 360;
      }
      if (Math.abs(d) > 1e-9) off.push(`${n.id}.${p} ends at ${+end.toFixed(4)}, not ${rest}`);
    }
  });
  return off;
}

// ---------------------------------------------------------------- drawing

const flatCache = new WeakMap();
/** A path flattened to polygons once, finely enough for the scale it is drawn at. */
function flattened(p, step) {
  let byStep = flatCache.get(p);
  if (!byStep) flatCache.set(p, (byStep = new Map()));
  if (!byStep.has(step)) byStep.set(step, pathToPolygons(p.d, { step }));
  return byStep.get(step);
}

/**
 * One frame: the posed paths drawn over the background (transparent without one) at `scale`
 * pixels per canvas unit, each clipped to its own bounds so a small shape costs little.
 */
export function drawPose(posed, scene, scale = 1, { background = scene.background } = {}) {
  const W = Math.max(1, Math.round(scene.width * scale));
  const H = Math.max(1, Math.round(scene.height * scale));
  const rgb = new Float32Array(W * H * 3);
  const alpha = new Float32Array(W * H);
  if (background) {
    for (let i = 0; i < W * H; i++) {
      rgb[i * 3] = background[0];
      rgb[i * 3 + 1] = background[1];
      rgb[i * 3 + 2] = background[2];
      alpha[i] = 1;
    }
  }
  for (const { path: p, m, opacity } of posed) {
    const a = p.alpha * opacity;
    if (a <= 0) continue;
    const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
    if (det < 1e-12) continue;
    const reach = Math.sqrt(det) * scale;
    const polys = flattened(p, Math.max(0.05, Math.min(1, 0.3 / Math.max(reach, 1e-3)))).map((poly) =>
      poly.map(([x, y]) => [(m[0] * x + m[2] * y + m[4]) * scale, (m[1] * x + m[3] * y + m[5]) * scale]),
    );
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const poly of polys) {
      for (const [x, y] of poly) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    const bx = Math.max(0, Math.floor(x0));
    const by = Math.max(0, Math.floor(y0));
    const bw = Math.min(W, Math.ceil(x1) + 1) - bx;
    const bh = Math.min(H, Math.ceil(y1) + 1) - by;
    if (bw <= 0 || bh <= 0) continue;
    const local = polys.map((poly) => poly.map(([x, y]) => [x - bx, y - by]));
    const cov = coverage(local, bw, bh, { rule: p.rule, sub: 4 });
    const [r, g, b] = p.fill;
    for (let yy = 0; yy < bh; yy++) {
      for (let xx = 0; xx < bw; xx++) {
        const c = cov[yy * bw + xx] * a;
        if (c <= 0) continue;
        const i = (by + yy) * W + bx + xx;
        rgb[i * 3] = r * c + rgb[i * 3] * (1 - c);
        rgb[i * 3 + 1] = g * c + rgb[i * 3 + 1] * (1 - c);
        rgb[i * 3 + 2] = b * c + rgb[i * 3 + 2] * (1 - c);
        alpha[i] = c + alpha[i] * (1 - c);
      }
    }
  }
  const data = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const A = alpha[i];
    // Colours were blended premultiplied; un-premultiply for a straight-alpha image.
    data[i * 4] = A > 0 ? Math.round(background ? rgb[i * 3] : rgb[i * 3] / A) : 0;
    data[i * 4 + 1] = A > 0 ? Math.round(background ? rgb[i * 3 + 1] : rgb[i * 3 + 1] / A) : 0;
    data[i * 4 + 2] = A > 0 ? Math.round(background ? rgb[i * 3 + 2] : rgb[i * 3 + 2] / A) : 0;
    data[i * 4 + 3] = Math.round(A * 255);
  }
  return { width: W, height: H, data };
}

/** The frame at time t. */
export function drawFrame(scene, t, scale = 1, opts = {}) {
  return drawPose(pose(scene, t), scene, scale, opts);
}

/** The times of every frame at fps, from 0 to the duration inclusive, plus any hold at the end. */
export function frameTimes(duration, fps, holdMs = 0) {
  const n = Math.max(1, Math.round((duration * fps) / 1000));
  const times = [];
  for (let k = 0; k <= n; k++) times.push(Math.min(duration, (k * 1000) / fps));
  const extra = Math.round((holdMs * fps) / 1000);
  for (let k = 0; k < extra; k++) times.push(duration);
  return times;
}

/**
 * How far apart two frames are: the largest channel difference and the share of pixels that differ
 * by more than `tol`. Colour is compared premultiplied, as it would show over any background: a
 * pixel all but transparent has no colour worth comparing, and un-premultiplied its colour swings
 * from black to full on the faintest change of alpha.
 */
export function frameDiff(a, b, tol = 8) {
  if (a.width !== b.width || a.height !== b.height) return { max: 255, share: 1 };
  let max = 0;
  let off = 0;
  for (let i = 0; i < a.width * a.height; i++) {
    const aa = a.data[i * 4 + 3];
    const ba = b.data[i * 4 + 3];
    let worst = Math.abs(aa - ba);
    for (let c = 0; c < 3; c++) worst = Math.max(worst, Math.abs((a.data[i * 4 + c] * aa) / 255 - (b.data[i * 4 + c] * ba) / 255));
    worst = Math.round(worst);
    if (worst > max) max = worst;
    if (worst > tol) off++;
  }
  return { max, share: off / (a.width * a.height) };
}
