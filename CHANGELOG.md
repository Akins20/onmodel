# Changelog

## Unreleased

- Sheet edits (`onmodel edit --sheet`): a model sheet is edited by continuing its
  conversation like any candidate, and the edit is cut into its front, side and back
  views, measured for agreement and added to `sheet.json` beside the originals.
  `sprites --pick 2e1` holds the frames to it; the sheet's own pick never changes on
  its own. `--pick` now reads an edit's id as text; before, `1e1` would have been read
  as the number 10.
- The sprites run's own pre-run estimate now counts every strip of a long action and
  the judged repairs, using the same count as `price`, and its budget check covers
  every strip.
- Fixes from a review of store, check and price:
  - Opaque icons (the App Store icon, the touch icon, Expo's icon) are written as
    24-bit PNG. They were RGBA with every pixel opaque, and App Store Connect rejects
    an icon that has an alpha channel at all. Opaque rules now also fail a file that
    has the channel, not only one with see-through pixels.
  - `check` now finds icons and sprites, whose summaries sit in the run's `icons/`
    and `sprites/` subfolders; before this it only saw generate and store runs.
  - `check` finds each file under the run folder rather than at the path saved when
    it was made, so a run that has been committed, copied or checked on CI still works.
  - `check` now fails instead of passing when it found nothing, when a summary can't
    be read, or when an icon has no recorded rule (rerun `icons` to record them).
  - `store` writes into its own `<out>/<name>/store/` folder beside the run of the
    same name, as icons and sprites do, so it no longer overwrites a generate run.
  - `store` fails when no hero was painted, drops pixel mode for the banner and
    removes duplicate targets.
  - `store` shows your own subject in the report rather than the banner wrapper.
  - `store` writes a target as JPEG (baseline, in plain JavaScript, checked in
    Chromium) when its PNG would be over the target's byte cap and the target takes
    JPEG.
  - `price` shows "no price", with the reason, for anything it can't price instead
    of $0. Its sprite ceiling now counts frame repaints and judged repairs, and it
    refuses inputs it can't read instead of pricing a different plan.
- Dry-run batch pricing (`onmodel price`): what a planned workload would cost before
  any of it runs, with no API call. It prices generate runs (`--subjects N` by
  `--count` at `--size`), a store run (`--store`, the crops free), and sprites
  (`--sprites "walk:6;run:8"`) as a best-to-worst range, because retries and repaints
  are decided by what the model sends back; the best is one strip per action, the
  worst assumes every strip is repainted the full retry count. Images use the pricing
  page's own per-image figure plus the measured thinking allowance; the judge is a
  clearly labelled allowance, not a measured cost; references are flagged as adding
  input tokens the per-image figure leaves out; icons, the store crops and check are
  listed as free. An unknown model is reported as having no price rather than given an
  invented one.
- A no-API gate (`onmodel check`): re-read what a run already wrote and hold it to
  the same rulebook, so a store or a launcher never finds the problem first. It calls
  nothing and costs nothing, and it decodes every raster from disk rather than
  trusting the verdicts recorded when it was made, so a file resized, re-exported,
  given an alpha channel or deleted since is caught. Icons and store graphics carry
  hard platform rules and are re-checked in full (each icon's rule is now kept in
  `icons.json` for this); generated images and sprite atlases are held to the lighter
  promise that they still decode at their recorded size. `--name` or `--in` checks one
  run, no target checks every run under `--out`; any failure exits 2. Verified on the
  live outputs (after the fixes above: icons, generate, store and a sprite atlas, 100
  files, all passing) and on a size mismatch, a stray alpha channel and a missing file.
- Store graphics (`onmodel store`): one on-brand hero is painted by the model,
  full-bleed and without text, judged against the brief like any candidate, and then
  cropped to cover each target's exact canvas and written as a 24-bit PNG with no
  alpha, because every store that takes a PNG rejects one that has an alpha channel.
  Targets, with their sizes and formats read on a dated basis: the Google Play
  feature graphic (1024 x 500), the Open Graph link preview that also serves an X
  large card (1200 x 630), and the GitHub repository social preview (1280 x 640).
  Each is checked for size, no alpha and the target's byte cap; a failure exits 2.
  The crop is deterministic and free: the only cost is the hero. Screenshot framing
  (a capture inside a phone, a caption over it) is typesetting over real screens and
  stays in ui-critic; this is the piece only an image model can make. Live on the
  Pay in Style brief: two heroes at 2K, drift 4.99, six graphics all passing, the
  GitHub PNGs 615 and 648 KB under the 1 MB cap, for fourteen cents.
- A 24-bit RGB PNG writer (colour type 2) beside the RGBA one, and a cover-crop that
  fills a banner's canvas edge to edge where the contain-fit would letterbox it.
- Icons (`onmodel icons`): one mark becomes Android adaptive layers at every density
  with the monochrome layer and XML, legacy, round, notification and Play icons; an iOS
  asset catalog with dark and tinted variants plus the layer for Icon Composer; the web
  favicon.ico, touch, manifest and maskable icons with the manifest and head tags; and
  the Expo files with app.json lines. Every file is checked against a rulebook read from
  the platforms' pages on 2026-10-08, sources named; a failure exits 2; Android's
  conflicting 48 dp logo guidance is a warning that explains itself. Previews through
  every launcher mask, as a themed icon, a notification and a 16 px favicon. The ICO
  writer (bitmap and PNG entries) decodes exactly in Chromium.
- Edits (`onmodel edit`): a candidate's saved conversation is continued with one
  change, so the model alters the picture it made instead of painting a new one. The
  result is keyed, sized and measured, measured against its parent (pixels changed,
  silhouette kept) and judged on whether the change was made and the rest kept. Edits
  chain flat per candidate (2e1, 2e2) with each parent recorded; the contact sheet
  shows them before and after. Live: a recolour moved 1% of the pixels, silhouette
  0.997, kept.
- Long actions: an action longer than `sprite.stripFrames` (8) is painted as balanced
  strips, each after the first shown the frame before it, its join measured and
  retried like any step, the last strip of a loop shown the first frame, and every
  strip brought to the first's scale. Actions run to 24 frames. Live: ten frames as
  two strips, joined at 0.94, heights within 5%.
- Sprites and sequences (`onmodel sheet`, `onmodel sprites`). A model sheet first:
  the character's front, side and back views in one row, sliced and measured for
  agreement. Then each action painted as one strip with the sheet beside the painter,
  sliced where the poses are, and every frame measured: its silhouette and colours
  against the sheet's matching view, its height against the action's own median
  frame, each step against the frame before and the seam when it loops. A strip that
  drifts is painted again and told what went wrong; a frame still wrong is repainted
  alone between its neighbours and brought into the strip's scale. The judge looks
  inside the silhouette (eyes, mouths, markings), and when it says redo its named
  frames are repainted with its fix, must still pass the measurements, and are kept
  only if a second judgement scores the action no worse. Frames are placed at one
  scale per action on one baseline, share one palette in pixel mode, can be mirrored,
  and are packed one action per row with a TexturePacker JSON hash (Aseprite frame
  tags and durations), a CSS steps() sheet and a C header for raylib, plus APNG and GIF
  previews. Without a sheet any sequence works, held to itself. Live-verified on a
  32px pixel-art character.
- GIF and APNG writers in plain JavaScript, checked against Chromium's own decoders:
  exact colours, durations and disposal, and a 200-colour image that drives the LZW
  code size to 12 bits through repeated table resets, 57,600 pixels with no mismatch.
- A frame repainted alone was measured at its own scale, about twice a strip frame's,
  so every repaint failed the size check; it is now scaled into the strip's pixel
  space first. Found by the live run; the simulated model now paints lone frames at
  double scale, as the real one does.
- First working loop, for one subject at a time: the brief, the settled decisions,
  the context files and the reference images go to a Gemini image model ahead of
  the subject; each candidate comes back, is keyed to transparency, trimmed,
  measured, cut to the sizes asked for and written with a sidecar that holds its
  prompt and turns; a text model judges the candidates against the brief with the
  measured facts stated as true, picks one and names the edit that would improve it.
- Keying without an alpha channel: the subject is asked for on a flat key colour,
  chosen furthest from the palette so a magenta brand is never keyed on magenta;
  edge pixels are un-mixed from the key rather than cut; a one-pixel key-tinted rim
  that a JPEG's anti-aliasing leaves past the soft band is softened only where it
  touches transparency. Measured per candidate: background removed, soft edge, key
  colour left in the subject, the rim against the interior, bounds, edge contact.
- Pixel-art mode: the model draws large on a grid, the output is shrunk to the grid
  with an area filter, snapped to the palette, and made fully opaque or clear; the
  judge sees the sprite that ships, not the painting; a hard-pixel preview is written
  for people; how much of the painting was really on a grid is measured.
- A baseline JPEG decoder in plain JavaScript, since the image models answer in
  JPEG and offer no PNG; it matches Chromium's decode of the same bytes to within
  three levels.
- Prices built in as of 2026-10-07 with image tokens at the image rate and thinking
  at the text rate, which is how the API bills; a dry-run estimate before a batch; a
  per-run budget that refuses a batch that cannot fit and stops a run whose real
  thinking ran past the estimate; an append-only ledger and `onmodel cost`.
- A contact sheet beside the images: as painted, keyed over a checkerboard, the sized
  outputs, the facts, the judge's scores and notes, the pick; light first with a dark
  toggle.
