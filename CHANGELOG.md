# Changelog

## Unreleased

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
