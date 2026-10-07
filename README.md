# onmodel

Images, sprites and sets kept on model. A character drawn consistently with its model
sheet is "on model"; this tool keeps generated art that way. You give it the product's
real brief, palette and reference images, it asks a small Gemini image model for
candidates, keys them to transparency, measures each one, cuts the sizes you asked
for, and has a text model judge them against the brief with the measurements stated
as facts. What survives is a usable asset with a record of what made it, not a pretty
picture that merely looked right once.

It exists so one coding agent can produce production art without opening a design
tool: Claude Code writes the brief from the codebase, runs the loop, triages the
candidates with you, and wires the result into the project. It works just as well for
a person at a terminal. Zero dependencies beyond Node 20.

This is the first phase, one subject at a time. Sprite sheets and animation actions,
edit turns as a command, and the deterministic layer that turns one mark into every
icon and store image a platform wants are the next phases; see "What it does not do
yet" below before you plan around them.

## Quick start

```bash
npm i -g @akins20/onmodel                      # or: npx onmodel ...
export GEMINI_API_KEY=...                      # read from the environment only, never stored
onmodel init                                   # onmodel.config.json, onmodel/brief.md, onmodel/decisions.md
# fill in the brief: Product and Art direction are required, Palette is what keeps it on brand
onmodel generate --subject "a shopping bag with a round price tag hanging from one handle" --name bag-tag --sizes 128,512
```

A run of three candidates plus a judgement costs about $0.15 at today's prices. Open
`onmodel-out/bag-tag/contact.html` to see them side by side.

For a sprite:

```bash
onmodel generate --subject "the player creature facing right, mouth wide open, idle" --name player-idle --pixel 32:8
```

## What a run does

1. **Reads the brief**, the settled decisions, any context files, and the palette (from
   the config, or from the brief's Palette section when the config names none).
2. **Chooses the key colour**: the one furthest from the palette among magenta, green,
   blue, cyan and yellow, so a plum brand is keyed on green and a mint game on blue,
   never on its own colours. `background` in the config can force one or keep the
   model's own background.
3. **Asks the model** for each candidate, with the rules and brief first, the references
   as images, and the subject last. The model paints the subject centred on the flat
   key colour at the size and ratio you set.
4. **Keys and measures** each answer: background removed, soft edge, key colour left in
   the subject, whether the subject touches the frame, how much of the frame it fills,
   how many colours it uses, how far it drifted from the palette, and in pixel mode how
   much of it was really on a grid.
5. **Cuts the sizes** you asked for, proportions kept, on a transparent canvas, with
   premultiplied resampling so edges never darken; in pixel mode shrinks to the grid,
   snaps to the palette and hardens the alpha.
6. **Judges** the candidates with a text model that is shown each one flattened on grey
   with its facts, and asked for on-brief, on-model and craft scores, problems,
   strengths, a pick and the one edit that would improve it.
7. **Writes** everything beside the images: the sized outputs, a sidecar per candidate
   with the prompt and turns, a summary, and the contact sheet.

## The brief

The model is never asked to paint without one, because a model given no direction
paints the average of everything, and that average is what makes generated art look
generated. `onmodel init` writes the template.

- **Product**: what it is, and what this art is for. Required.
- **Audience**: who sees it, on what screens, at what sizes.
- **Art direction**: the style in words a painter could follow, and what it should sit
  beside. Required.
- **Palette**: hex colours in order of importance, each with its job. These become the
  palette the model is told to use and the one drift is measured against.
- **References**: what each file in `references` is and what to take from it. The
  files themselves go to the model as images before every prompt.
- **Do not**: what must never appear.

Settled decisions (`onmodel/decisions.md`, one bullet each with the reason) are given
to the painter and the judge as closed: the judge never marks a candidate down for
honouring one.

## Keying

The image models have no alpha channel and answer in JPEG, so transparency is made
here. A pixel within `key.tolerance` (a CIE76 colour distance, 30 by default) of the
key becomes transparent; one past twice that stays opaque; the band between is a soft
edge whose colour is un-mixed from the key in the ratio its alpha says, so the
subject's own colour is recovered rather than a pinkish one kept. A JPEG's
anti-aliasing also leaves a one-pixel ring past the soft band, opaque and tinted with
the key; a pixel that touches transparency, and only such a pixel, gets a wider ramp
and is un-mixed too, while an interior pixel of the same colour is left alone, so a
subject genuinely near the key's hue never goes translucent inside. The measurements
say how it went: the share of the frame removed, the share that is soft edge, the
share of the subject that is still the key's own hue (the model painted with it, or
the key leaked), and the rim's distance from the key against the interior's.

## Pixel mode

`--pixel 32` (or `"pixel": { "grid": 32, "colors": 8 }`) tells the model to draw
pixel art large and crisp on that grid, then shrinks the result to the grid with an
area filter, snaps every pixel to the palette (or to the best `colors` colours found
by median cut when there is no palette), and makes every pixel fully opaque or clear.
A preview enlarged with hard pixels is written for people, and that preview is what
the judge sees, since the sprite, not the painting, is what ships. The facts include
how much of the painting was actually on a grid; a small model imitates pixel art
more than it draws on a grid, and the shrink is what makes the output honest.

## The judge

A text model (`gemini-3.8-flash` by default) sees the brief, the decisions, the
references, and each candidate on grey with its measured facts, and answers in a fixed
shape: per candidate, on-brief, on-model and craft out of 100 with problems and
strengths; then a pick and one edit. The facts are given as true, so the judge reasons
from them instead of guessing at a colour count or whether the background was removed.
`--no-judge` skips it and keeps the run cheaper.

## Costs and budgets

Prices are built in as of 2026-10-07. An image call bills three things and the API's
usage metadata separates them: the prompt at the input rate, the generated image's
tokens at the image rate, and the model's thinking at the text rate. A 1K image from
`gemini-nano-banana-2.1` is 1120 image tokens ($0.0336) plus around 900 tokens of
thought, about $0.04 all in; three candidates and a judgement come to about $0.15.
Every call is appended to `<out>/usage.jsonl` and `onmodel cost` totals it per run.

`budgetUSD` (2 by default) is a cap per run. A batch whose estimate cannot fit is
refused before a cent is spent, and a run whose real thinking ran past the estimate
stops before the call that would pass the cap. `onmodel models` lists the models the
key can use, which make images, and what each costs.

## What you get

In `<out>/<name>/`:

- `01.source.jpg`: the bytes as the model sent them.
- `01.png`: keyed to transparency, full size.
- `01.128x128.png` and so on: the sizes asked for; in pixel mode also `*.preview.png`.
- `01.json`: the prompt, the preamble, the turns to continue from, the usage, the facts.
- `generate.json`: the run, every candidate's facts and judgement, the pick, the cost.
- `contact.html`: as painted, keyed over a checkerboard, the outputs, the facts, the
  judge's scores and notes, the pick. Light first, with a dark toggle.

## Commands

| command | does |
| --- | --- |
| `init` | write `onmodel.config.json`, `onmodel/brief.md`, `onmodel/decisions.md` |
| `models [--filter banana]` | the models the key can use, which make images, and the price of each |
| `generate --subject "..."` | paint a subject from the brief: candidates, keyed, measured, sized, judged |
| `cost [--out dir]` | what every run has cost so far, from the ledger |

Flags for `generate`: `--name slug`, `--count 3`, `--sizes 64,128`, `--pixel 32[:16]`,
`--quantize`, `--references a.png,b.png`, `--palette #hex,#hex`, `--background
auto|#hex|none`, `--size 1K`, `--aspect 1:1`, `--model id`, `--judge id`,
`--no-judge`, `--budget 2`, `--thinking off|low|medium|high`. For every command:
`--config`, `--out`, `--brief`, `--json`.

## Configuration

Every knob has a default. Resolution order, lowest to highest: built-in defaults,
`onmodel.config.json`, environment (`GEMINI_MODEL`, `ONMODEL_JUDGE`, `ONMODEL_OUT`,
`ONMODEL_BRIEF`, `ONMODEL_BUDGET`, `ONMODEL_THINKING`), flags.

```json
{
  "brief": "onmodel/brief.md",
  "references": ["art/logo.png", "art/model-sheet.png"],
  "palette": [],
  "context": { "files": ["app/tokens.css"], "decisions": "onmodel/decisions.md" },
  "model": "gemini-nano-banana-2.1",
  "judge": "gemini-3.8-flash",
  "size": "1K",
  "aspectRatio": "1:1",
  "candidates": 3,
  "thinking": {},
  "judgeThinking": { "level": "high" },
  "background": "auto",
  "key": { "tolerance": 30, "despill": true },
  "sizes": ["128", "512"],
  "pixel": null,
  "quantize": false,
  "budgetUSD": 2,
  "out": "onmodel-out",
  "ledger": "usage.jsonl",
  "pricing": {}
}
```

## What it does not do yet

- **Sprite sheets and actions.** The sprite you get is one frame. Model sheets, named
  actions generated as strips and sliced, consistency measured frame to frame, atlas
  packing and the JSON, CSS and C header exports are the next phase; the keying,
  measurements and pixel mode here are what they will stand on.
- **Edits as a command.** Every candidate's turns are saved so an edit can continue
  from exactly where it was, and the client supports it; the `edit` command is not
  written yet.
- **Icon sets, store graphics and link previews from one mark.** Planned as a later
  phase, where ui-critic's small `assets` command moves to.
- **Video.** Frame sequences assembled into APNG, GIF or sheets are in scope later;
  video generation is not.

## Using it from Claude Code

Copy `skill/SKILL.md` to `~/.claude/skills/onmodel/SKILL.md`. `/onmodel` then teaches
Claude the loop: write the brief from the real product, pick a subject, run, read the
facts before the pictures, triage the candidates with the user, apply the judge's edit
where it is right, and put the output where the project expects it.

## Design notes

- The key is sent as a request header, never as a query parameter, never written to
  disk, never printed.
- The image models return baseline JPEG and cannot be asked for PNG, so the tool
  decodes JPEG itself, in plain JavaScript; checked against Chromium's decode of the
  same bytes it is within three levels on a full 1024px image.
- Every generated image carries Google's invisible SynthID watermark; fine for your
  own products, worth knowing.
- Thinking tokens are billed on image models too and are counted; `thinking.level`
  can lower them for simple subjects.

## License

MIT
