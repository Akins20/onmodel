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

It makes single images (icons, illustrations, stickers, empty states) and animated
sequences: sprite sheets for games and any other run of frames that must stay the same
thing from frame to frame. Any candidate can be edited by continuing its conversation
with the model. One mark becomes every icon Android, iOS, the web and Expo ask for,
checked against a dated rulebook. And an on-brand hero becomes the store graphics and
link previews a listing and a repository need, each at its exact size with no alpha.

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

For an animated character, the model sheet first, then the actions:

```bash
onmodel sheet --subject "Chomp, a round cream creature with a huge mouth and one big eye" --name chomp --pixel 32:8
onmodel sprites --name chomp --pixel 32:8 --actions "chomp:4:the mouth opening wide then snapping shut;hurt:4:flinching back, then recovering"
```

That writes `onmodel-out/chomp/sprites/chomp.png` (the atlas) with `chomp.json`,
`chomp.css` and `chomp.h` beside it, an animated preview of every action, and
`sprites.html` to look at all of it. A sheet and two four-frame actions cost about $0.40
to $0.70, depending on how many strips need painting again.

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

## Edits

Every candidate's sidecar keeps its whole conversation with the image model, so an
edit is the next turn of that conversation rather than a fresh request:

```bash
onmodel edit --name bag-tag --candidate 1 --change "Recolour the rear handle to the same plum as the bag"
```

The model changes the picture it already made instead of painting a new one, which
keeps everything the change did not mention and costs one image (about $0.04, and a
cent for the judge). The result is keyed, sized and measured like any candidate, then
measured against its parent (the share of pixels that changed visibly, and how much of
the silhouette survived) and judged on two questions: was the change made, and was
everything else kept. On the live run that recolour moved 1% of the pixels with the
silhouette at 0.997, and the judge kept it.

Without `--candidate` the run's pick is edited. Edits chain flat per candidate: the
first edit of candidate 1 is `1e1`, and `--candidate 1e1` makes `1e2` with `1e1`
recorded as its parent, so any step can be returned to. The contact sheet gains an
Edits section with each before and after.

A model sheet is edited the same way with `--sheet`:

```bash
onmodel edit --name chomp-player --sheet --change "Make the eye a single white dot, the same in all three views"
onmodel sprites --name chomp-player --pick 2e1
```

The edited sheet is cut into its front, side and back views and measured for
agreement like any sheet candidate, and it is added to `sheet.json` beside the
originals. The sheet's pick does not change on its own; `sprites --pick 2e1` holds the
frames to the edit.

## Icons

```bash
onmodel icons --name bag-tag --candidate 1e1          # the mark from a run (the pick by default)
onmodel icons --mark logo.png --background "#F4E9F1"  # or from any PNG with transparency
```

One mark becomes every icon a platform asks for. Nothing is generated: it is all
derived, so it costs nothing and can be rebuilt whenever the mark changes.

- **Android:** adaptive foreground and monochrome layers at every density, the
  `mipmap-anydpi-v26` XML and the background colour resource, legacy and round
  launcher icons, notification icons (white on transparent), and the 512 px Play icon.
- **iOS:** an `AppIcon.appiconset` with the default icon (opaque, as the App Store
  requires), dark and tinted variants and `Contents.json`, plus the foreground layer
  and background colour to import into Icon Composer for the layered Liquid Glass icons
  of the 26 releases.
- **Web:** `favicon.ico` (16, 32 and 48 px), PNG favicons, the 180 px touch icon, 192
  and 512 px manifest icons and a maskable one, with the manifest entries and the head
  tags to paste.
- **Expo:** `icon.png`, the adaptive foreground and monochrome images, dark and tinted
  icons, and the `app.json` lines.

The mark is placed by its real reach from its centre, not its bounding box, so a round
mark fills a circular safe zone instead of being shrunk to fit a square, with room left
for the antialiased edge. Pixel art is enlarged by whole numbers and stays hard at every
size. The background is the first colour in the brief's palette the mark stands out on
(a contrast of 3 or more), else the strongest contrast available, and the report says
which and why; `--background` sets it.

**The rulebook.** Every file is checked against what its platform asks, read from the
platforms' own pages on 2026-10-08 with the source named in the report: exact sizes, no
transparency and no alpha channel where the App Store forbids it (opaque icons are
written as 24-bit PNG, since App Store Connect rejects the channel itself), the Android
safe zone (66 dp) and the maskable one (a circle of 40% radius) for the mark but not the
full-bleed background,
white-only notification icons, one-colour themed icons, the Play icon under 1024 KB. A
failure makes the command exit with code 2. Android's guidance conflicts with itself (a
logo at least 48 dp across, inside a 66 dp circle no mask clips, which a square logo
cannot do), so a logo under 48 dp is a warning that says why, never a failure.

**How it will look.** `icons.html` shows the icon through every Android launcher mask
(circle, squircle, rounded square, teardrop), the iOS mask, a maskable circle, as a
themed icon, as a notification on a dark bar and as a 16 px favicon, then every file
with its checks and the snippets to paste.

## Store graphics and link previews

```bash
onmodel store --name shop-promo --subject "the shop's objects grouped on the left, open plum space on the right"
onmodel store --name shop-promo --targets og,github --size 2K   # just the link previews, crisper
```

A store needs one thing an image model makes and nothing else can: an on-brand hero.
`store` paints it (full-bleed, no text, keyed on nothing), judges it against the brief
like any candidate, then crops that hero to cover each target's exact canvas and writes
it as a 24-bit PNG with no alpha, because every store that takes a PNG rejects one with
an alpha channel. When a PNG would be over the target's byte cap and the target takes
JPEG, it is written as the highest-quality JPEG that fits instead. The hero is the only
cost; the crops are deterministic and free. Everything lands in `<out>/<name>/store/`,
beside any run of the same name, as `icons/` and `sprites/` do.

- **Google Play feature graphic**, 1024 x 500.
- **Open Graph link preview**, 1200 x 630, which also serves an X large card.
- **GitHub repository social preview**, 1280 x 640.

Choose a subset with `--targets`, and pass a `--mark` to carry a logo into the hero as
a reference. The subject you give is wrapped in a banner's framing: landscape and
full-bleed, the key elements near the centre because stores crop the sides, and a calm
area left where a store overlays the app name. Each graphic is checked for its exact
size, no alpha and the target's byte cap (GitHub's is 1 MB); a failure exits with code
2. `store.html` shows each hero with its crops, checks and the judge's scores, and the
sizes are read from the stores' own pages on 2026-10-08 with the source named.

Screenshot framing (a capture inside a phone, a caption over it) is typesetting over
real screens, not generation; that lives in [ui-critic](https://github.com/Akins20/ui-critic)'s
`assets` command, where the captures already are.

## Sprites and sequences

A studio keeps a character on model with a model sheet: the character drawn once from
the front, the side and the back, approved, and pinned beside every animator's desk.
This works the same way.

**The sheet.** `onmodel sheet --subject "..." --name chomp` asks for the character three
times in one row, front, side facing right, and back, on one baseline. It runs through
the ordinary loop (candidates, keying, the judge) and each candidate is sliced into its
three views and measured for agreement between them: the spread of their heights and
how far their colours drift apart. The judge's pick is kept when it sliced into three
clean views; otherwise the best by measurement. `sheet.json` records the pick, and
`--pick 2` on `sprites` uses a different candidate.

**Strips.** Each action is painted as one strip: all of its frames in a single row, in
one generation, with the sheet shown to the painter. One generation is what keeps the
frames one style, and it costs one image instead of one per frame. The strip is sliced
where the poses actually are, read from the keyed alpha, since a model's spacing is
only roughly even. Too many pieces are merged at the narrowest gaps; too few means poses
ran together, so the strip is divided equally and that is reported, never hidden.
An action longer than `sprite.stripFrames` (eight) is painted as several balanced
strips (ten frames is five and five): each strip after the first is shown the frame
just before it and told which frames it is, the join is measured like any other step
and a strip that does not follow on is painted again, the last strip of a looping
action is shown the first frame it must lead back into, and every strip is brought to
the first's scale before the action is measured as one. A live ten-frame run joined
at 0.94 with its heights within 5%; an action can run to 24 frames.

**Measured against the sheet.** Every frame's silhouette is compared with the sheet's
matching view (side for facing right, mirrored for left, front, back), both drawn at one
height so the comparison is about shape and not size; its colours are compared with the
view's; its height is compared with the action's own median frame, because a strip and
a sheet are painted at different pixel scales; and each frame is compared with the one
before it, and the first with the last when the action loops, to catch a jump. The
thresholds are in `sprite.thresholds` and can be loosened per action (a squash, a die
that shrinks away).

**Repairs, measured and judged.** A strip that drifts is painted again, up to
`sprite.retries` times, and told exactly what went wrong ("frame 2 changed the
character's shape; the motion jumps at frames 2 and 3"); the best attempt is kept. A
frame still wrong is repainted alone, with its neighbours shown, up to
`sprite.frameRetries` times, brought into the strip's scale (a frame painted alone comes
back about twice the size), and kept only if it measures better. Then the judge looks
inside the silhouette, where measurement cannot see: eyes, mouths, markings. When it
says redo it names each frame and the one change that would put it right; those frames
are repainted with that change, must still pass every measurement, and a second
judgement decides whether the repair stays or the action is put back as it was
(`sprite.judgeRepairs`, one round by default).

**Placed, packed, exported.** Frames are placed in cells of `sprite.frame` (the pixel
grid in pixel mode, else 128) at one scale per action, anchored on the median frame so
the character is the same size from action to action, feet on one baseline. In pixel
mode the whole sprite shares one palette, the brief's or one found across every frame,
so nothing flickers. An action can be mirrored (`"mirror": "walk_left"`). The atlas
puts one action per row and comes with:

- `<name>.json`: the TexturePacker hash with Aseprite's frame tags and per-frame
  durations, which Phaser, PixiJS, Godot importers and most engines read.
- `<name>.css`: a sprite class and a `steps()` animation per action.
- `<name>.h`: a C header with the frame and action tables and a frame-at-time helper,
  for raylib and anything else that speaks C.
- `preview.png` (APNG) and `preview.gif` per action, enlarged with hard pixels in pixel
  mode so people can see them.

**Any sequence.** `--no-sheet` (or no sheet on disk) holds the frames to each other
instead: colours to the first frame, every step to the one before. A plant growing, a
loading animation, a logo assembling itself: anything that must stay the same thing
while it changes.

Actions are set in the config or with `--actions "name:frames[:motion];..."`, or a path
to a JSON file of them:

```json
"sprite": {
  "frame": 32,
  "actions": [
    { "name": "chomp", "frames": 4, "fps": 10, "motion": "the mouth opening wide then snapping shut", "facing": "right", "mirror": "chomp_left" },
    { "name": "die", "frames": 6, "motion": "spinning and shrinking away", "loop": false, "thresholds": { "size": 0.9, "shape": 0.3 } }
  ],
  "retries": 2,
  "frameRetries": 1,
  "judgeRepairs": 1
}
```

## Costs and budgets

Prices are built in as of 2026-10-07. An image call bills three things and the API's
usage metadata separates them: the prompt at the input rate, the generated image's
tokens at the image rate, and the model's thinking at the text rate. A 1K image from
`gemini-nano-banana-2.1` is 1120 image tokens ($0.0336) plus around 900 tokens of
thought, about $0.04 all in; three candidates and a judgement come to about $0.15.
Every call is appended to `<out>/usage.jsonl` and `onmodel cost` totals it per run.

Sprites cost what their strips and repairs cost. The live runs on a 32px pixel-art
character: a three-candidate sheet $0.17, two four-frame actions $0.29 (two strips each
needed painting again because poses ran together), and one action with a judged repair
of three frames $0.24. Before a sprite run starts it states the cost if every strip
lands first time and the most it could cost with every retry.

`budgetUSD` (2 by default) is a cap per run. A batch whose estimate cannot fit is
refused before a cent is spent, and a run whose real thinking ran past the estimate
stops before the call that would pass the cap. `onmodel models` lists the models the
key can use, which make images, and what each costs.

Before a large batch, `onmodel price` estimates it without calling anything:

```bash
onmodel price --subjects 8 --count 3 --size 2K      # eight subjects, three each
onmodel price --sprites "walk:8;run:8;jump:5"        # a sheet and three actions
onmodel price --store                                # one store run; the crops are free
```

It prices images from the per-image figure plus the thinking allowance, states the
judge as an allowance rather than a measured cost, gives sprites as a best-to-worst
range (from one strip per action up to every retry, frame repaint and judged repair
the config allows), and lists icons, the store crops and check as free. Anything it
cannot price (an unknown model, a size with no per-image figure) shows as "no price"
with the reason, never as an invented number, and a plan it cannot read is refused.

## What you get

In `<out>/<name>/`:

- `01.source.jpg`: the bytes as the model sent them.
- `01.png`: keyed to transparency, full size.
- `01.128x128.png` and so on: the sizes asked for; in pixel mode also `*.preview.png`.
- `01.json`: the prompt, the preamble, the turns to continue from, the usage, the facts.
- `generate.json`: the run, every candidate's facts and judgement, the pick, the cost.
- `contact.html`: as painted, keyed over a checkerboard, the outputs, the facts, the
  judge's scores and notes, the pick. Light first, with a dark toggle.

For a character, in `<out>/<name>/`:

- `sheet.json` and `sheet/`: the sheet candidates, each with its three views as PNGs.
- `sprites/<name>.png`, `.json`, `.css`, `.h`: the atlas and its exports.
- `sprites/<action>/`: every strip as painted and keyed, every repaint, the placed
  frames, and `preview.png` (APNG) and `preview.gif`.
- `sprites/sprites.json` and `sprites/sprites.html`: every attempt, measurement,
  repair and judgement, and the actions playing.

## Checking outputs in CI

Generated assets live in the repository, and a wrong edit, a lossy re-export or an
alpha channel added by another tool is the kind of thing a store rejects at
submission, not at review. `onmodel check` re-reads what a run wrote and holds it to
the same rulebook, without the API, so it fits a commit hook or a CI step.

```bash
onmodel check --name shop-promo     # one run, by name under --out
onmodel check --in path/to/run      # or a directory directly
onmodel check                       # every run under --out
```

It decodes every raster from disk rather than trusting the verdicts recorded when the
files were made, so it catches a file resized, re-exported, given an alpha channel or
deleted since. Icons and store graphics are re-checked against their full rules (exact
size, no alpha, the byte caps, the safe zones); generated images and sprite atlases,
which have no platform rule, are held to the lighter promise that they still decode at
their recorded size. Any failure exits with code 2, naming the file and the rule.

## Commands

| command | does |
| --- | --- |
| `init` | write `onmodel.config.json`, `onmodel/brief.md`, `onmodel/decisions.md` |
| `models [--filter banana]` | the models the key can use, which make images, and the price of each |
| `generate --subject "..."` | paint a subject from the brief: candidates, keyed, measured, sized, judged |
| `icons --name x` or `--mark file.png` | every icon Android, iOS, the web and Expo ask for, checked against the rulebook, with mask previews (free) |
| `store --name x [--subject "..."]` | an on-brand hero painted and judged, then cropped to the Play feature graphic, the Open Graph and the GitHub previews, no alpha |
| `edit --name x --change "..."` | continue a candidate's conversation with one change; measured against its parent and judged |
| `sheet --subject "..." --name x` | the model sheet: front, side and back views, sliced and measured |
| `sprites --name x` | each action as a strip, measured against the sheet, repaired, packed and exported |
| `check [--name x \| --in dir]` | re-check written outputs against the rulebook, no API; no target checks every run under `--out`; exits 2 on failure |
| `price [--subjects N] [--store] [--sprites "..."]` | what a planned batch would cost before it runs, no API |
| `cost [--out dir]` | what every run has cost so far, from the ledger |

Flags for `generate`: `--name slug`, `--count 3`, `--sizes 64,128`, `--pixel 32[:16]`,
`--quantize`, `--references a.png,b.png`, `--palette #hex,#hex`, `--background
auto|#hex|none`, `--size 1K`, `--aspect 1:1`, `--model id`, `--judge id`,
`--no-judge`, `--budget 2`, `--thinking off|low|medium|high`. For `sprites`:
`--actions "name:frames[:motion];..."` or a JSON file, `--frame 32`, `--subject "..."`,
`--pick 2`, `--no-sheet`. For `store`: `--subject "..."`, `--targets
play-feature,og,github`, `--mark logo.png`, `--count 3`, `--size 2K`, `--budget 2`,
`--no-judge`. For `edit`: `--candidate 2` or `2e1` (the pick by default),
`--change "..."`, `--in dir`, `--sheet`, `--no-judge`. For `check`: `--name x` or `--in dir`,
else every run under `--out`. For `price`: `--subjects N`, `--sprites "name:frames;..."`,
`--store`, `--count`, `--size`, `--no-judge`. For every command: `--config`, `--out`,
`--brief`, `--json`.

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
  "sprite": { "frame": null, "fill": 0.9, "anchor": "bottom", "actions": [], "thresholds": { "shape": 0.5, "size": 0.15, "palette": 15, "jump": 0.45 }, "retries": 2, "frameRetries": 1, "judgeRepairs": 1, "stripFrames": 8, "maxFrames": 24 },
  "budgetUSD": 2,
  "out": "onmodel-out",
  "ledger": "usage.jsonl",
  "pricing": {}
}
```

## What it does not do yet

- **A judge that always gets to keep.** A judged repair round can improve an action
  but does not guarantee a "keep": on the live runs the hurt action went from 50 to 64
  and was kept, while a ten-frame run's repair scored 62.7 to 57.7 and was put back.
  At 32 pixels most of what the judge names is a stray pixel or two. Raise
  `sprite.judgeRepairs` to 2, or edit the frame by hand from the saved sources.
- **Editing a sprite frame by command.** `edit` works on generate candidates and on
  model sheets (`--sheet`); a single sprite frame is repaired through the measured and
  judged repaints, not edited directly.
- **Store screenshot sets.** `store` makes the generative graphics (the feature graphic,
  the link previews). Framing real screenshots inside a phone with a caption is
  typesetting, not generation, so it stays in [ui-critic](https://github.com/Akins20/ui-critic)'s
  `assets` command where the captures already are, rather than being rebuilt here.
- **Icon Composer files.** Apple's layered `.icon` format is not documented, so the
  tool writes a flattened asset catalog Xcode accepts and the foreground layer and
  background colour to import into Icon Composer by hand.
- **Video.** Sequences ship as atlases, APNG and GIF; video files and video generation
  are not in scope.

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
