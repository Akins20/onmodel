import { realpathSync } from "node:fs";
import path from "node:path";

/**
 * The contact sheet: one self-contained HTML file beside the images, light first
 * with a dark toggle, showing each candidate as the model painted it and as it
 * was keyed (over a checkerboard, so transparency is visible), the measured facts,
 * the judge's scores and notes, and the pick. It references the images relatively,
 * through the real path on both sides, so a Windows short path in one place and a
 * long one in another still point at the same file.
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

export function renderContactHTML(summary, dir) {
  const cards = summary.candidates
    .map((c) => {
      const picked = summary.pick === c.index;
      const j = c.judgement;
      if (!c.files?.image) {
        return `<section class="card off"><h2>Candidate ${c.index}</h2><p class="warn">Not painted: ${esc(c.blocked ?? c.error ?? "unknown")}</p></section>`;
      }
      const outputs = (c.files.outputs ?? [])
        .map((o) => `<figure class="out"><img src="${esc(relativeSrc(dir, o.preview ?? o.file))}" alt="" style="image-rendering:pixelated"><figcaption>${o.width}x${o.height}</figcaption></figure>`)
        .join("");
      return `<section class="card${picked ? " pick" : ""}" id="c${c.index}">
<h2>Candidate ${c.index}${picked ? ' <span class="badge">pick</span>' : ""}</h2>
<div class="pair">
<figure><img loading="lazy" src="${esc(relativeSrc(dir, c.files.source))}" alt=""><figcaption>as painted</figcaption></figure>
<figure class="checker"><img loading="lazy" src="${esc(relativeSrc(dir, c.files.image))}" alt=""><figcaption>keyed</figcaption></figure>
</div>
${outputs ? `<div class="outs">${outputs}</div>` : ""}
${factsTable(c.facts)}
${j ? `<div class="judge">${scoreBar("on brief", j.on_brief)}${scoreBar("on model", j.on_model)}${scoreBar("craft", j.craft)}${j.problems?.length ? `<p class="k">Problems</p><ul>${j.problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}${j.strengths?.length ? `<p class="k">Strengths</p><ul>${j.strengths.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>` : ""}</div>` : ""}
<p class="cost">$${(c.costUSD ?? 0).toFixed(3)} · ${c.usage?.imageTokens ?? 0} image tokens, ${c.usage?.thoughtsTokens ?? 0} thinking</p>
</section>`;
    })
    .join("\n");
  const judge = summary.judgement;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(summary.name)}: candidates</title><style>
:root{--bg:#fbfafc;--fg:#1b1a1f;--mut:#6a6676;--line:#e6e3ea;--card:#fff;--acc:#6a1b5a;--ok:#2a7d4f;--warn:#b23a48;color-scheme:light}
:root[data-theme="dark"]{--bg:#131217;--fg:#eceaf1;--mut:#a09cab;--line:#2c2a33;--card:#1b1a20;--acc:#d08ac1;color-scheme:dark}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#131217;--fg:#eceaf1;--mut:#a09cab;--line:#2c2a33;--card:#1b1a20;--acc:#d08ac1;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;padding:28px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{max-width:1200px;margin:0 auto 20px;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:baseline}
h1{font-size:24px;margin:0}.lead{color:var(--mut);margin:0;flex:1 1 100%}
button.theme{margin-left:auto;border:1px solid var(--line);background:var(--card);color:var(--fg);border-radius:999px;padding:4px 12px;cursor:pointer}
.verdict{max-width:1200px;margin:0 auto 20px;padding:14px 16px;border:1px solid var(--line);border-radius:12px;background:var(--card)}
.verdict b{color:var(--acc)}.verdict .edit{color:var(--mut);margin:6px 0 0}
main{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card.pick{border-color:var(--acc);box-shadow:0 0 0 2px var(--acc)}
.card.off{color:var(--mut)}.warn{color:var(--warn)}
h2{font-size:16px;margin:0 0 10px}.badge{font-size:11px;text-transform:uppercase;letter-spacing:.06em;background:var(--acc);color:#fff;border-radius:999px;padding:2px 8px;vertical-align:middle;margin-left:6px}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}figure{margin:0}figcaption{font-size:12px;color:var(--mut);margin-top:4px}
.pair img{width:100%;display:block;border-radius:8px;border:1px solid var(--line)}
.checker img{background:conic-gradient(#ccc 25%,#fff 0 50%,#ccc 0 75%,#fff 0) 0 0/16px 16px}
.outs{display:flex;flex-wrap:wrap;gap:10px;margin:10px 0}.out img{max-width:128px;max-height:128px;border:1px solid var(--line);border-radius:6px;background:conic-gradient(#ccc 25%,#fff 0 50%,#ccc 0 75%,#fff 0) 0 0/8px 8px}
table{width:100%;border-collapse:collapse;font-size:13px;margin:10px 0}th{text-align:left;font-weight:500;color:var(--mut);padding:3px 0;width:46%}td{padding:3px 0}
.judge{margin-top:8px;border-top:1px solid var(--line);padding-top:8px}.score{display:grid;grid-template-columns:70px 1fr 32px;align-items:center;gap:8px;font-size:13px;margin:3px 0}
.score i{display:block;height:6px;border-radius:3px;background:linear-gradient(90deg,var(--acc) var(--v),var(--line) var(--v))}.score b{text-align:right;font-weight:500}
.k{margin:8px 0 2px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut)}ul{margin:0;padding-left:18px;font-size:13px}
.cost{color:var(--mut);font-size:12px;margin:10px 0 0}
</style></head><body>
<header><h1>${esc(summary.name)}</h1><button class="theme" type="button">Dark</button><p class="lead">${esc(summary.subject)} · ${esc(summary.model)} at ${esc(summary.size)}${summary.key ? ` · keyed on ${esc(summary.key)}` : ""}${summary.estimatedCostUSD != null ? ` · $${summary.estimatedCostUSD.toFixed(3)}` : ""} · ${esc(summary.generatedAt)}</p></header>
${judge && !judge.error ? `<div class="verdict"><b>Pick: ${judge.pick ? `candidate ${judge.pick}` : "none"}.</b> ${esc(judge.reason)}${judge.edit ? `<p class="edit">Edit to try: ${esc(judge.edit)}</p>` : ""}</div>` : judge?.error ? `<div class="verdict warn">The judge failed: ${esc(judge.error)}</div>` : ""}
<main>${cards}</main>
<script>
(function(){var b=document.querySelector("button.theme"),r=document.documentElement;function cur(){return r.getAttribute("data-theme")||(matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light")}function show(){b.textContent=cur()==="dark"?"Light":"Dark"}b.addEventListener("click",function(){r.setAttribute("data-theme",cur()==="dark"?"light":"dark");show()});show()})();
</script>
</body></html>`;
}
