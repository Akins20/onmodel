import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * The reports: one self-contained HTML file beside the images, light first with a
 * dark toggle. The contact sheet shows each candidate as the model painted it and
 * as it was keyed (over a checkerboard, so transparency is visible), the measured
 * facts, the judge's scores and the pick. The sprites report shows each action
 * playing, its frames with their measurements, every attempt and repair, and the
 * atlas. Images are referenced relatively, through the real path on both sides, so
 * a Windows short path in one place and a long one in another still meet.
 */

export const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function realPath(p) {
  try {
    return realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

export function relativeSrc(from, file) {
  if (!file) return "";
  return path.relative(realPath(from), realPath(path.resolve(file))).split(path.sep).join("/");
}

const pct = (v) => `${Math.round((v ?? 0) * 100)}%`;

const BASE_CSS = `:root{--bg:#fbfafc;--fg:#1b1a1f;--mut:#6a6676;--line:#e6e3ea;--card:#fff;--acc:#6a1b5a;--ok:#2a7d4f;--warn:#b23a48;color-scheme:light}
:root[data-theme="dark"]{--bg:#131217;--fg:#eceaf1;--mut:#a09cab;--line:#2c2a33;--card:#1b1a20;--acc:#d08ac1;--ok:#6fcf97;--warn:#f08a96;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#131217;--fg:#eceaf1;--mut:#a09cab;--line:#2c2a33;--card:#1b1a20;--acc:#d08ac1;--ok:#6fcf97;--warn:#f08a96;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;padding:28px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{max-width:1200px;margin:0 auto 20px;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:baseline}
h1{font-size:24px;margin:0}.lead{color:var(--mut);margin:0;flex:1 1 100%}
button.theme{margin-left:auto;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}
.verdict{max-width:1200px;margin:0 auto 20px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.verdict b{color:var(--acc)}.verdict .edit{color:var(--mut);margin:6px 0 0}
h2{font-size:16px;margin:0 0 10px}figure{margin:0}figcaption{font-size:12px;color:var(--mut);margin-top:4px}
.checker{background:conic-gradient(#ccc 25%,#fff 0 50%,#ccc 0 75%,#fff 0) 0 0/16px 16px}
.warn{color:var(--warn)}.okc{color:var(--ok)}
table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}th{text-align:left;font-weight:500;color:var(--mut);padding:3px 6px 3px 0}td{padding:3px 6px 3px 0}
.score{display:grid;grid-template-columns:70px 1fr 32px;align-items:center;gap:8px;font-size:13px;margin:3px 0}
.score i{display:block;height:6px;border-radius:3px;background:linear-gradient(90deg,var(--acc) var(--v),var(--line) var(--v))}.score b{text-align:right;font-weight:500}
.k{margin:8px 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}ul{margin:0;padding-left:18px;font-size:13px}
.cost{color:var(--mut);font-size:12px;margin:10px 0 0}
.judge{margin-top:8px;border-top:1px solid var(--line);padding-top:8px}`;

const THEME_SCRIPT = `<script>
(function(){var b=document.querySelector("button.theme"),r=document.documentElement;function cur(){return r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}function show(){b.textContent=cur()==="dark"?"Light":"Dark"}b.addEventListener("click",function(){r.setAttribute("data-theme",cur()==="dark"?"light":"dark");show()});show()})();
</script>`;

function page(title, css, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
${BASE_CSS}
${css}
</style></head><body>
${body}
${THEME_SCRIPT}
</body></html>`;
}

function factsTable(facts) {
  if (!facts) return "";
  const rows = [];
  if (facts.keying) {
    const k = facts.keying;
    rows.push(["Background removed", pct(k.background)], ["Soft edge", `${Math.round(k.fringe * 1000) / 10}%`], ["Key left in subject", pct(k.residue)]);
    const sides = Object.entries(k.touchesEdge ?? {}).filter(([, v]) => v).map(([s]) => s);
    rows.push(["Touches edge", sides.length ? sides.join(", ") : "no"]);
  }
  rows.push(["Fill", pct(facts.fill)], ["Colours", String(facts.colours)]);
  if (facts.paletteDrift) rows.push(["Palette drift", `mean ${facts.paletteDrift.mean}, max ${facts.paletteDrift.max}`]);
  if (facts.grid) rows.push(["On grid", pct(facts.grid.share)]);
  return `<table>${rows.map(([k, v]) => `<tr><th>${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}</table>`;
}

function scoreBar(label, value) {
  const v = Math.max(0, Math.min(100, Number(value) || 0));
  return `<div class="score"><span>${esc(label)}</span><i style="--v:${v}%"></i><b>${v}</b></div>`;
}

const CONTACT_CSS = `main{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card.pick{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc)}.card.off{color:var(--mut)}
.badge{font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:var(--acc);color:#fff;border-radius:999px;padding:2px 8px;vertical-align:middle;margin-left:6px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pair img{width:100%;display:block;border-radius:8px;border:1px solid var(--line)}
.views{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:8px}.views img{width:100%;height:96px;object-fit:contain;display:block;border-radius:6px;border:1px solid var(--line)}
.outs{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0}.out img{max-width:128px;max-height:128px;border:1px solid var(--line);border-radius:6px}`;

export function renderContactHTML(summary, dir) {
  const cards = summary.candidates
    .map((c) => {
      const picked = summary.pick === c.index;
      const j = c.judgement;
      if (!c.files?.image) {
        return `<section class="card off"><h2>Candidate ${c.index}</h2><p class="warn">Not painted: ${esc(c.blocked ?? c.error ?? "unknown")}</p></section>`;
      }
      const outputs = (c.files.outputs ?? [])
        .map((o) => `<figure class="out"><img class="checker" src="${esc(relativeSrc(dir, o.preview ?? o.file))}" alt="" style="image-rendering:pixelated"><figcaption>${o.width}x${o.height}</figcaption></figure>`)
        .join("");
      const views = c.views
        ? `<div class="views">${Object.entries(c.views)
            .map(([v, file]) => `<figure><img class="checker" loading="lazy" src="${esc(relativeSrc(dir, file))}" alt=""><figcaption>${esc(v)}</figcaption></figure>`)
            .join("")}</div>${c.sheet ? `<p class="cost">${c.sheet.found} views found (${esc(c.sheet.method)}), height spread ${pct(c.sheet.heightSpread)}, colour spread ${c.sheet.colourSpread}</p>` : ""}`
        : "";
      return `<section class="card${picked ? " pick" : ""}" id="c${c.index}">
<h2>Candidate ${c.index}${picked ? ' <span class="badge">pick</span>' : ""}</h2>
<div class="pair">
<figure><img loading="lazy" src="${esc(relativeSrc(dir, c.files.source))}" alt=""><figcaption>as painted</figcaption></figure>
<figure><img class="checker" loading="lazy" src="${esc(relativeSrc(dir, c.files.image))}" alt=""><figcaption>keyed</figcaption></figure>
</div>
${views}
${outputs ? `<div class="outs">${outputs}</div>` : ""}
${factsTable(c.facts)}
${j ? `<div class="judge">${scoreBar("on brief", j.on_brief)}${scoreBar("on model", j.on_model)}${scoreBar("craft", j.craft)}${j.problems?.length ? `<p class="k">Problems</p><ul>${j.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}${j.strengths?.length ? `<p class="k">Strengths</p><ul>${j.strengths.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}</div>` : ""}
<p class="cost">$${(c.costUSD ?? 0).toFixed(3)} · ${c.usage?.imageTokens ?? 0} image tokens, ${c.usage?.thoughtsTokens ?? 0} thinking</p>
</section>`;
    })
    .join("\n");
  const judge = summary.judgement;
  const body = `<header><h1>${esc(summary.name)}${summary.kind === "sheet" ? " model sheet" : ""}</h1><button class="theme" type="button">Dark</button><p class="lead">${esc(String(summary.subject).split("\n")[0])} · ${esc(summary.model)} at ${esc(summary.size)}${summary.key ? ` · keyed on ${esc(summary.key)}` : ""}${summary.estimatedCostUSD != null ? ` · $${summary.estimatedCostUSD.toFixed(3)}` : ""} · ${esc(summary.generatedAt)}</p></header>
${judge && !judge.error ? `<div class="verdict"><b>Pick: ${judge.pick ? `candidate ${judge.pick}` : "none"}.</b> ${esc(judge.reason)}${judge.edit ? `<p class="edit">Edit to try: ${esc(judge.edit)}</p>` : ""}</div>` : judge?.error ? `<div class="verdict warn">The judge failed: ${esc(judge.error)}</div>` : ""}
<main>${cards}</main>`;
  return page(`${summary.name}: candidates`, CONTACT_CSS, body);
}

const SPRITES_CSS = `section.block{max-width:1200px;margin:0 auto 18px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
.row{display:flex;flex-wrap:wrap;gap:14px;align-items:flex-start}
.sheetv img{height:120px;border:1px solid var(--line);border-radius:6px}
.atlas img{max-width:100%;border:1px solid var(--line);border-radius:6px;image-rendering:pixelated}
.play img{border:1px solid var(--line);border-radius:8px}
.frames{display:flex;flex-wrap:wrap;gap:8px}.frames figure{text-align:center}.frames img{border:1px solid var(--line);border-radius:6px}
.frames .bad img{outline:2px solid var(--warn);outline-offset:1px}
.attempts{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-top:6px}
.attempts figure img{width:100%;border:1px solid var(--line);border-radius:6px}.attempts .best img{outline:2px solid var(--acc);outline-offset:1px}
.meta{color:var(--mut);font-size:13px;margin:0 0 10px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace}`;

function frameFacts(f) {
  const bits = [];
  if (f.iou !== undefined) bits.push(`shape ${f.iou}`);
  if (f.heightRatio !== undefined && f.heightRatio !== null) bits.push(`height ${f.heightRatio}`);
  if (f.paletteDelta !== undefined && f.paletteDelta !== null) bits.push(`colour ${f.paletteDelta}`);
  if (f.iouPrevious !== undefined) bits.push(`step ${f.iouPrevious}`);
  return bits.join(" · ");
}

export function renderSpritesHTML(summary, dir) {
  const pixel = Boolean(summary.pixel);
  const show = Math.max(1, Math.floor(96 / Math.max(summary.cell.width, summary.cell.height)));
  const imgStyle = `width:${summary.cell.width * show}px;height:${summary.cell.height * show}px;${pixel ? "image-rendering:pixelated;" : ""}`;
  const sheet = summary.sheet?.views
    ? `<section class="block"><h2>Model sheet <span class="meta">candidate ${summary.sheet.pick}</span></h2><div class="row sheetv">${Object.entries(summary.sheet.views)
        .map(([v, f]) => `<figure><img class="checker" src="${esc(relativeSrc(dir, f))}" alt=""><figcaption>${esc(v)}</figcaption></figure>`)
        .join("")}</div></section>`
    : `<section class="block"><p class="meta">No model sheet: frames were held to each other only.</p></section>`;
  const atlas = summary.atlas
    ? `<section class="block atlas"><h2>Atlas <span class="meta">${summary.atlas.width}x${summary.atlas.height}, frames ${summary.atlas.frame.width}x${summary.atlas.frame.height}, one action per row</span></h2><img class="checker" src="${esc(relativeSrc(dir, summary.atlas.image))}" alt="" style="width:${Math.min(1100, summary.atlas.width * show)}px"><p class="meta">Exports: <code>${esc(path.basename(summary.atlas.image))}</code> <code>${esc(path.basename(summary.atlas.json))}</code> (TexturePacker hash with frame tags) <code>${esc(path.basename(summary.atlas.css))}</code> <code>${esc(path.basename(summary.atlas.header))}</code></p></section>`
    : "";
  const actions = summary.actions
    .map((a) => {
      if (a.error) return `<section class="block"><h2>${esc(a.name)}</h2><p class="warn">${esc(a.error)}</p></section>`;
      const flaggedSet = new Set(a.final?.flagged ?? []);
      const frames = (a.files?.frames ?? [])
        .map((f, i) => {
          const facts = a.final?.frames?.[i];
          const flags = facts?.flags ?? [];
          return `<figure class="${flaggedSet.has(i) ? "bad" : ""}"><img class="checker" src="${esc(relativeSrc(dir, f))}" alt="" style="${imgStyle}"><figcaption>${i + 1}${flags.length ? ` <span class="warn">${esc(flags.join(", "))}</span>` : ""}<br>${esc(facts ? frameFacts(facts) : "")}</figcaption></figure>`;
        })
        .join("");
      const attempts = a.attempts
        .map((t) => (t.source ? `<figure class="${t.index === a.best ? "best" : ""}"><img loading="lazy" src="${esc(relativeSrc(dir, t.source))}" alt=""><figcaption>strip ${t.index}${t.index === a.best ? " (used)" : ""}: ${t.slicing?.found}/${a.frames} poses, ${esc(t.slicing?.method)}${t.flagged?.length ? `, flagged ${t.flagged.map((x) => x + 1).join(", ")}` : ""}${t.note ? `<br>asked to fix: ${esc(t.note)}` : ""}</figcaption></figure>` : `<figure><figcaption class="warn">strip ${t.index}: not painted (${esc(t.blocked)})</figcaption></figure>`))
        .join("");
      const repairs = a.judgeRepairs?.length
        ? `<p class="k">Repaired for the judge</p><ul>${a.judgeRepairs
            .map((r) => `<li>pass ${r.pass}: ${r.frames.map((x) => `frame ${x.frame + 1} (${esc(x.fix)}) ${x.accepted ? "passed the measurements" : `<span class="warn">failed them${x.flags ? `: ${esc(x.flags.join(", "))}` : ""}</span>`}`).join("; ")}. Score ${r.before.score} to ${r.after?.score ?? "n/a"}: ${r.kept ? '<span class="okc">kept</span>' : "put back"}</li>`)
            .join("")}</ul>`
        : "";
      const fixes = a.fixes?.length ? `<p class="k">Repainted frames</p><ul>${a.fixes.map((x) => `<li>frame ${x.frame + 1}, try ${x.attempt}: ${esc((x.before ?? []).join(", ") || "none")} to ${esc((x.after ?? []).join(", ") || "none")}, ${x.accepted ? '<span class="okc">kept</span>' : "dropped"}</li>`).join("")}</ul>` : "";
      const j = a.judgement;
      const judge = j && !j.error ? `<div class="judge">${scoreBar("reads as", j.reads_as)}${scoreBar("on model", j.on_model)}${scoreBar("smooth", j.smooth)}<p class="meta">Verdict: <b class="${j.verdict === "keep" ? "okc" : "warn"}">${esc(j.verdict)}</b></p>${j.problems?.length ? `<p class="k">Problems</p><ul>${j.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}${j.frame_notes?.length ? `<p class="k">Frame notes</p><ul>${j.frame_notes.map((n) => `<li>frame ${n.frame}: ${esc(n.note)}</li>`).join("")}</ul>` : ""}</div>` : j?.error ? `<p class="warn">The judge failed: ${esc(j.error)}</p>` : "";
      const mirrored = a.mirror && a.mirrorFiles ? `<figure><img class="checker" src="${esc(relativeSrc(dir, a.mirrorFiles.preview))}" alt="" style="${imgStyle}"><figcaption>${esc(a.mirror)} (mirrored)</figcaption></figure>` : "";
      return `<section class="block" id="${esc(a.name)}"><h2>${esc(a.name)}</h2>
<p class="meta">${esc(a.motion)} · ${a.frames} frames at ${a.fps} fps · ${esc(a.facing)} · ${a.loop ? "loops" : "plays once"} · ${a.attempts.length} strip${a.attempts.length === 1 ? "" : "s"}${a.fixes?.length ? `, ${a.fixes.length} repaint${a.fixes.length === 1 ? "" : "s"}` : ""}${a.final?.meanIoU != null ? ` · shape match ${a.final.meanIoU}` : ""}${a.stopped ? ` · <span class="warn">stopped: ${esc(a.stopped)}</span>` : ""}</p>
<div class="row play"><figure><img class="checker" src="${esc(relativeSrc(dir, a.files?.preview))}" alt="" style="${imgStyle}"><figcaption>playing</figcaption></figure>${mirrored}<div class="frames">${frames}</div></div>
${judge}
${repairs}
<p class="k">Strips</p><div class="attempts">${attempts}</div>
${fixes}
</section>`;
    })
    .join("\n");
  const body = `<header><h1>${esc(summary.name)} sprites</h1><button class="theme" type="button">Dark</button><p class="lead">${esc(summary.character)} · ${summary.cell.width}x${summary.cell.height} · ${esc(summary.model)} at ${esc(summary.size)} · keyed on ${esc(summary.key)}${summary.estimatedCostUSD != null ? ` · $${summary.estimatedCostUSD.toFixed(3)}` : ""} · ${esc(summary.generatedAt)}</p></header>
${summary.stopped ? `<div class="verdict warn">The run stopped early: ${esc(summary.stopped)}</div>` : ""}
${sheet}
${atlas}
${actions}`;
  return page(`${summary.name}: sprites`, SPRITES_CSS, body);
}
