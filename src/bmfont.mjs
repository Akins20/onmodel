/**
 * Bitmap fonts: a real TrueType font set into an atlas of glyphs at one pixel size, with
 * the metrics engines need, written as an AngelCode BMFont .fnt.
 *
 * The letters are the type designer's outlines, rasterised here, so they cannot come out
 * malformed the way painted letters do. What can go wrong is the bookkeeping: an offset
 * one pixel out drops every letter below the line, a kerning pair in the wrong place
 * closes up the wrong letters, and nothing about a .fnt looks wrong until text is set
 * with it. So text is set twice: once from the glyphs as they were made, and once from
 * the .fnt and page as they were written and read back, and the two must agree pixel for
 * pixel.
 *
 * Each glyph sits at a whole pixel. A bitmap font is drawn at whole pixels by every engine
 * that uses one, so positioning finer than that would be a promise nothing keeps.
 *
 * Crisp pixel-art fonts (--mono) cut coverage at a share of the pixel. At small sizes that
 * can make a thin stroke vanish or a curve break, and the font would look fine in a list
 * of characters and wrong in a word, so both are measured: a piece of a letter that
 * vanished is a failure, a stroke that broke is reported.
 */

import { contourToPath } from "./font.mjs";
import { pathToPolygons, coverage } from "./vector.mjs";
import { packRects } from "./trim.mjs";

/** Printable ASCII, the default set. */
export const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCodePoint(32 + i)).join("");

const isSpace = (ch) => /^\s$/u.test(ch);

/** The line metrics at a pixel size, rounded once so every glyph agrees with them. */
export function fontMetrics(font, px) {
  const s = px / font.unitsPerEm;
  const base = Math.round(font.ascender * s);
  const lineHeight = Math.max(1, Math.round((font.ascender - font.descender + Math.max(0, font.lineGap ?? 0)) * s));
  return { s, base, lineHeight };
}

/**
 * One glyph at a pixel size: its coverage cut to the ink, where it sits relative to the pen
 * and the baseline, and how far the pen moves. Non-zero winding, as TrueType fills.
 */
export function rasterGlyph(font, gid, px, { mono = false, cover = 50 } = {}) {
  const s = px / font.unitsPerEm;
  const advance = Math.round(font.advanceOf(gid) * s);
  const contours = font.contoursOf(gid);
  let xMin = Infinity;
  let yMin = Infinity;
  let xMax = -Infinity;
  let yMax = -Infinity;
  for (const c of contours) {
    for (const p of c) {
      if (p.x < xMin) xMin = p.x;
      if (p.x > xMax) xMax = p.x;
      if (p.y < yMin) yMin = p.y;
      if (p.y > yMax) yMax = p.y;
    }
  }
  if (!Number.isFinite(xMin)) return { width: 0, height: 0, x: 0, top: 0, alpha: new Uint8Array(0), soft: new Uint8Array(0), advance };
  const x0 = Math.floor(xMin * s);
  const top = Math.floor(-yMax * s);
  const w = Math.max(1, Math.ceil(xMax * s) - x0);
  const h = Math.max(1, Math.ceil(-yMin * s) - top);
  const d = contours.map((c) => contourToPath(c, (p) => [p.x * s - x0, -p.y * s - top])).join("");
  const cov = coverage(pathToPolygons(d, { step: 0.25 }), w, h, { rule: "nonzero", sub: 16 });
  const soft = new Uint8Array(w * h);
  for (let i = 0; i < cov.length; i++) soft[i] = Math.round(cov[i] * 255);
  const cut = (cover / 100) * 255;
  const alpha = mono ? soft.map((v) => (v > 0 && v >= cut ? 255 : 0)) : soft;
  // Cut to the ink: control points can stand outside the curve, which would only waste page.
  let ix0 = w;
  let iy0 = h;
  let ix1 = -1;
  let iy1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!alpha[y * w + x]) continue;
      if (x < ix0) ix0 = x;
      if (x > ix1) ix1 = x;
      if (y < iy0) iy0 = y;
      if (y > iy1) iy1 = y;
    }
  }
  // The outline four times over, for crisp fonts: its pieces are the letter's real pieces (the
  // dot of an i and its stem are two), which is what a crisp render has to keep.
  let outline = null;
  if (mono) {
    const d4 = contours.map((c) => contourToPath(c, (p) => [(p.x * s - x0) * 4, (-p.y * s - top) * 4])).join("");
    const big = coverage(pathToPolygons(d4, { step: 0.5 }), w * 4, h * 4, { rule: "nonzero", sub: 4 });
    outline = { width: w * 4, height: h * 4, mask: big.map((v) => (v >= 0.5 ? 1 : 0)) };
  }
  const glyph = { width: 0, height: 0, x: 0, top: 0, alpha: new Uint8Array(0), advance, soft, softWidth: w, softHeight: h, outline };
  if (ix1 < 0) return glyph;
  const cw = ix1 - ix0 + 1;
  const ch = iy1 - iy0 + 1;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < ch; y++) out.set(alpha.subarray((iy0 + y) * w + ix0, (iy0 + y) * w + ix0 + cw), y * cw);
  return { ...glyph, width: cw, height: ch, x: x0 + ix0, top: top + iy0, alpha: out };
}

/** 8-connected pieces of a mask: one label per pixel, 0 for none, and how many there are. */
function pieces(mask, w, h) {
  const label = new Int32Array(w * h);
  let n = 0;
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || label[i]) continue;
    n++;
    const stack = [i];
    label[i] = n;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w;
      const py = (p / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = px + dx;
          const y = py + dy;
          if (x < 0 || y < 0 || x >= w || y >= h) continue;
          const q = y * w + x;
          if (mask[q] && !label[q]) {
            label[q] = n;
            stack.push(q);
          }
        }
      }
    }
  }
  return { label, count: n };
}

/**
 * What cutting a glyph to crisp pixels did to it, against the outline's own pieces (taken
 * at four times the size, so the dot of an i and its stem are two pieces however close a
 * small render draws them). A piece that left no crisp pixel at all is lost; a piece that
 * came out as several is broken.
 */
export function monoDamage(glyph, cover = 50) {
  const w = glyph.softWidth;
  const h = glyph.softHeight;
  const o = glyph.outline;
  if (!w || !h || !o) return { lost: 0, broken: 0 };
  const seen = pieces(o.mask, o.width, o.height);
  const cut = (cover / 100) * 255;
  const crisp = glyph.soft.map((v) => (v > 0 && v >= cut ? 1 : 0));
  const kept = pieces(crisp, w, h);
  let lost = 0;
  let broken = 0;
  for (let k = 1; k <= seen.count; k++) {
    const inside = new Set();
    for (let y = 0; y < o.height; y++) {
      for (let x = 0; x < o.width; x++) {
        if (seen.label[y * o.width + x] !== k) continue;
        const q = kept.label[(y >> 2) * w + (x >> 2)];
        if (q) inside.add(q);
      }
    }
    if (!inside.size) lost++;
    else if (inside.size > 1) broken++;
  }
  return { lost, broken };
}

/**
 * The whole font: every requested character the font has, packed onto one page with
 * `spacing` clear pixels around each glyph, the kerning pairs among them, and what is
 * missing. White glyphs with coverage in alpha, the layout BMFont calls "glyph in alpha"
 * and the one Godot reads unconverted.
 */
export function buildBitmapFont(font, { px = 16, chars = ASCII, mono = false, cover = 50, kerning = true, spacing = 1, maxPage = 4096 } = {}) {
  const metrics = fontMetrics(font, px);
  const list = [...new Set(Array.from(chars))];
  const missing = [];
  const glyphs = [];
  let syntheticSpace = false;
  for (const ch of list) {
    const code = ch.codePointAt(0);
    if (!font.has(code)) {
      if (ch === " ") {
        // A font with no space still needs one to set words; a quarter of an em is the usual.
        glyphs.push({ ch, code, gid: 0, width: 0, height: 0, x: 0, top: 0, alpha: new Uint8Array(0), advance: Math.round(px / 4), space: true });
        syntheticSpace = true;
      } else missing.push(ch);
      continue;
    }
    const gid = font.glyphFor(code);
    const g = rasterGlyph(font, gid, px, { mono, cover });
    glyphs.push({ ch, code, gid, ...g, space: isSpace(ch) });
  }
  const blank = glyphs.filter((g) => !g.space && !g.width).map((g) => g.ch);
  const damage = mono ? glyphs.filter((g) => !g.space).map((g) => ({ ch: g.ch, ...monoDamage(g, cover) })) : [];
  const lost = damage.filter((d) => d.lost).map((d) => d.ch);
  const broken = damage.filter((d) => d.broken).map((d) => d.ch);

  const drawn = glyphs.filter((g) => g.width);
  let page = { width: 1, height: 1, data: new Uint8Array(4) };
  if (drawn.length) {
    let packed;
    try {
      packed = packRects(drawn.map((g) => ({ w: g.width, h: g.height })), { padding: spacing, maxSide: maxPage });
    } catch {
      throw new Error(`${drawn.length} glyphs at ${px}px do not fit on one ${maxPage}x${maxPage} page; ask for fewer characters with --chars, or a smaller --px`);
    }
    page = { width: packed.width, height: packed.height, data: new Uint8Array(packed.width * packed.height * 4) };
    drawn.forEach((g, i) => {
      g.px = packed.at[i].x;
      g.py = packed.at[i].y;
      for (let y = 0; y < g.height; y++) {
        for (let x = 0; x < g.width; x++) {
          const a = g.alpha[y * g.width + x];
          if (a) page.data.set([255, 255, 255, a], ((g.py + y) * page.width + g.px + x) * 4);
        }
      }
    });
  }
  const pairs = [];
  if (kerning) {
    for (const a of glyphs) {
      if (!a.gid) continue;
      for (const b of glyphs) {
        if (!b.gid) continue;
        const k = Math.round(font.kernBetween(a.gid, b.gid) * metrics.s);
        if (k) pairs.push({ first: a.code, second: b.code, amount: k });
      }
    }
  }
  return { px, ...metrics, glyphs, page, kernings: pairs, missing, blank, lost, broken, syntheticSpace, mono, cover, spacing };
}

/** The AngelCode BMFont text format, in its own field order, one space between fields. */
export function writeFnt(bm, { face = "font", pageFile = "font_0.png", bold = false, italic = false } = {}) {
  const lines = [
    `info face="${String(face).replace(/"/g, "")}" size=${bm.px} bold=${bold ? 1 : 0} italic=${italic ? 1 : 0} charset="" unicode=1 stretchH=100 smooth=${bm.mono ? 0 : 1} aa=1 padding=0,0,0,0 spacing=${bm.spacing},${bm.spacing} outline=0`,
    `common lineHeight=${bm.lineHeight} base=${bm.base} scaleW=${bm.page.width} scaleH=${bm.page.height} pages=1 packed=0 alphaChnl=0 redChnl=4 greenChnl=4 blueChnl=4`,
    `page id=0 file="${pageFile}"`,
    `chars count=${bm.glyphs.length}`,
  ];
  for (const g of bm.glyphs) {
    const drawn = g.width > 0;
    lines.push(`char id=${g.code} x=${drawn ? g.px : 0} y=${drawn ? g.py : 0} width=${g.width} height=${g.height} xoffset=${drawn ? g.x : 0} yoffset=${drawn ? bm.base + g.top : 0} xadvance=${g.advance} page=0 chnl=15`);
  }
  if (bm.kernings.length) {
    lines.push(`kernings count=${bm.kernings.length}`);
    for (const k of bm.kernings) lines.push(`kerning first=${k.first} second=${k.second} amount=${k.amount}`);
  }
  return lines.join("\n") + "\n";
}

/**
 * The same font in BMFont's XML form, which is the only one Phaser 3 loads (its loader parses the
 * data file as XML) and which three-bmfont-text and others read too.
 */
export function writeFntXML(bm, { face = "font", pageFile = "font_0.png", bold = false, italic = false } = {}) {
  const q = (v) => String(v).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const lines = [
    `<?xml version="1.0"?>`,
    `<font>`,
    `  <info face="${q(face)}" size="${bm.px}" bold="${bold ? 1 : 0}" italic="${italic ? 1 : 0}" charset="" unicode="1" stretchH="100" smooth="${bm.mono ? 0 : 1}" aa="1" padding="0,0,0,0" spacing="${bm.spacing},${bm.spacing}" outline="0"/>`,
    `  <common lineHeight="${bm.lineHeight}" base="${bm.base}" scaleW="${bm.page.width}" scaleH="${bm.page.height}" pages="1" packed="0" alphaChnl="0" redChnl="4" greenChnl="4" blueChnl="4"/>`,
    `  <pages>`,
    `    <page id="0" file="${q(pageFile)}"/>`,
    `  </pages>`,
    `  <chars count="${bm.glyphs.length}">`,
  ];
  for (const g of bm.glyphs) {
    const drawn = g.width > 0;
    lines.push(`    <char id="${g.code}" x="${drawn ? g.px : 0}" y="${drawn ? g.py : 0}" width="${g.width}" height="${g.height}" xoffset="${drawn ? g.x : 0}" yoffset="${drawn ? bm.base + g.top : 0}" xadvance="${g.advance}" page="0" chnl="15"/>`);
  }
  lines.push(`  </chars>`);
  if (bm.kernings.length) {
    lines.push(`  <kernings count="${bm.kernings.length}">`);
    for (const k of bm.kernings) lines.push(`    <kerning first="${k.first}" second="${k.second}" amount="${k.amount}"/>`);
    lines.push(`  </kernings>`);
  }
  lines.push(`</font>`);
  return lines.join("\n") + "\n";
}

/** Reads a BMFont text file back, whatever its line endings. */
export function parseFnt(text) {
  const out = { info: {}, common: {}, pages: [], chars: [], kernings: [] };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const kind = line.split(/\s+/, 1)[0];
    const fields = {};
    for (const m of line.matchAll(/(\w+)=("([^"]*)"|\S+)/g)) fields[m[1]] = m[3] ?? (/^-?\d+$/.test(m[2]) ? Number(m[2]) : m[2]);
    if (kind === "info") out.info = fields;
    else if (kind === "common") out.common = fields;
    else if (kind === "page") out.pages.push(fields);
    else if (kind === "char") out.chars.push(fields);
    else if (kind === "kerning") out.kernings.push(fields);
  }
  return out;
}

/**
 * Text set with a bitmap font, as an engine sets it: each glyph at the pen plus its offsets,
 * the pen moved by its advance and closed up by kerning, a new line every lineHeight. Ink is
 * laid over white, so the result can be looked at.
 */
export function setText(lines, { chars, kernings, lineHeight, page, base = null, refBase = null, ink = [29, 26, 30], margin: pad = 4 }) {
  // Engines that place glyphs on a baseline (Godot among them) read yoffset against base, so a
  // base written one pixel out moves every glyph; set against the base the font was built with,
  // that shows up here instead of in the game.
  const shift = base != null && refBase != null ? refBase - base : 0;
  const byCode = new Map(chars.map((c) => [c.id, c]));
  const kern = new Map(kernings.map((k) => [`${k.first},${k.second}`, k.amount]));
  // Room for anything drawn left of the pen or above the line (a combining mark that starts a line
  // sits wholly left of it), so nothing that is being compared falls off the edge unseen.
  const margin = pad + Math.max(0, ...chars.map((c) => -Math.min(c.xoffset ?? 0, (c.yoffset ?? 0) + shift)));
  const widths = lines.map((line) => {
    let pen = 0;
    let prev = null;
    let right = 0;
    for (const ch of Array.from(line)) {
      const c = byCode.get(ch.codePointAt(0));
      if (!c) continue;
      if (prev != null) pen += kern.get(`${prev},${c.id}`) ?? 0;
      right = Math.max(right, pen + c.xoffset + c.width, pen + c.xadvance);
      pen += c.xadvance;
      prev = c.id;
    }
    return right;
  });
  const width = Math.max(1, ...widths) + margin * 2;
  const height = lines.length * lineHeight + margin * 2;
  const out = { width, height, data: new Uint8Array(width * height * 4).fill(255) };
  lines.forEach((line, row) => {
    let pen = margin;
    let prev = null;
    const top = margin + row * lineHeight;
    for (const ch of Array.from(line)) {
      const c = byCode.get(ch.codePointAt(0));
      if (!c) continue;
      if (prev != null) pen += kern.get(`${prev},${c.id}`) ?? 0;
      for (let y = 0; y < c.height; y++) {
        for (let x = 0; x < c.width; x++) {
          const a = page.data[((c.y + y) * page.width + c.x + x) * 4 + 3];
          if (!a) continue;
          const tx = pen + c.xoffset + x;
          const ty = top + c.yoffset + shift + y;
          if (tx < 0 || ty < 0 || tx >= width || ty >= height) continue;
          const t = (ty * width + tx) * 4;
          // Ink over what is there, so overlapping letters darken as they would on screen.
          for (let k = 0; k < 3; k++) out.data[t + k] = Math.round(out.data[t + k] + (ink[k] - out.data[t + k]) * (a / 255));
        }
      }
      pen += c.xadvance;
      prev = c.id;
    }
  });
  return out;
}

/** The same font as setText reads it, straight from what was built, before anything is written. */
export function fntFromBuild(bm) {
  return {
    chars: bm.glyphs.map((g) => ({ id: g.code, x: g.px ?? 0, y: g.py ?? 0, width: g.width, height: g.height, xoffset: g.width ? g.x : 0, yoffset: g.width ? bm.base + g.top : 0, xadvance: g.advance })),
    kernings: bm.kernings,
    lineHeight: bm.lineHeight,
    page: bm.page,
  };
}
