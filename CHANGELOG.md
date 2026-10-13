# Changelog

## Unreleased

- Terrain sets (`onmodel terrain`): the 16 or 47 cells a Godot TileMapLayer needs to paint
  a material rather than place tiles, composited from one seamless fill with every peering
  bit derived from the shape. 47 and not 256, because a corner only means anything when
  both sides beside it are already there. The fill has to tile, since two cells side by
  side hold it at the same phase, so its own join is measured here too, on the fill as the
  cells hold it. Each cell holds the WHOLE fill once, scaled to the cell (32 px unless
  `--cell` says otherwise): sampling a bigger fill took only its top-left corner, so every
  join in the map joined two different phases of it and seamed at 8.85x its grain while
  the fill itself measured as seamless. Shrinking averages areas, which keeps the fill's
  wrap; enlarging blends across the wrap rather than clamping to the edge, which seamed at
  3.61x; pixel art is enlarged without blending. The fill has to be solid, since the cell
  shapes are what make a terrain transparent.
  The checking is the point: a set one bit out looks fine in the editor and tears a hole in
  the map later, so every pair of cells that can ever sit side by side is checked along its
  shared edge, 338 of 338 for the 47-cell set. EVERY pair is the wrong test, since most
  cannot occur together and demanding they agree marks a correct set as broken; one random
  map is too weak, since a 24 by 24 one placed only 38 of the 47 cells and a notch in any of
  the other nine passed. Which pairs occur depends only on the window of squares around
  them, so trying every way to fill it finds all of them, exactly. Sides-only is reported
  rather than flattered, since MATCH_SIDES has no bit for a corner and 32 of the 128 pairs
  that can touch join; that is the mode, not a fault.
  The rounding that makes a corner look drawn stops short of every edge on purpose: blur
  reaching an edge would change the pixels along it and two cells meant to butt together
  would stop matching. The blur runs twice and so reaches twice its radius, which a first
  clamp missed (a requested `--round 8` on a 32 px cell broke 36 of the 47 cells), and it
  also steps down until it cannot eat a shape, since a wide `--margin` leaves each side a
  neck the rounding cut through. Pixels come whole: a `--round` of 2.5 drew every cell
  empty, and an empty set passes every edge check, so whole numbers are required and each
  cell is also checked to draw the shape its bits declare.

- Normal maps (`onmodel normal`), derived from the art rather than painted, so a 2D light
  knows which way each pixel faces. A painted sprite has no geometry, so the height is
  invented from luminance, which is an assumption and is wrong wherever colour and depth
  are unrelated: dark paint becomes a dent. That is reported, not hidden, along with how
  much of the art's variation was fine enough to come out as noise. What can be proven is:
  unit-length normals, flat art encoding exactly flat, and the gradient decoded back out
  of the written pixels and compared with the one it was made from. The decisive check is
  a picture, since no number can say bumps read as bumps rather than dents, so every run
  writes the art lit from four corners; a dome lit from each corner in turn is brightest
  at that corner, held by a test. Godot wants X+ Y+ Z+, the OpenGL convention, which is
  the default, with `--invert-y` for the other.
- Collision and occlusion shapes (`onmodel shape`), traced from the art's own silhouette
  and simplified to a point budget, since a body of two thousand points is a performance
  bug in the shape of an answer. A body is what the art ENCLOSES, not only what it inks:
  measured against the ink alone, a correct shape for a drawn mug reported claiming four
  times its own area as empty space. The two ways simplifying goes wrong are reported
  separately because one is much worse: missing part of the sprite lets a sword through a
  shoulder, claiming empty space makes the player collide with nothing. Comparing areas
  hides the difference, so the polygon is drawn back and compared pixel by pixel. The
  budget is met by simplifying harder, never by cutting the tail off a loop.
- One scale for the whole character, not one for each action. Scaling each action to fill
  its own cell was hiding the very thing this tool exists to catch: an action painted
  larger than the rest was quietly shrunk to fit, so the character changed size the moment
  it jumped and every measurement still passed. The scale is taken across every frame of
  every action now, and how far the actions differ in height at that one scale is reported
  instead of being normalised away.
- The gate covers the five commands nothing was checking: vector, text, lockup, tile and
  normal. Two get a real re-measurement rather than a format check, because their
  correctness IS a measurement. A tile's join is taken again from the pixels on disk, so a
  re-export that brightens one edge is caught even though the file still decodes at the
  right size. A normal map is re-derived from its own pixels: every texel must decode close
  to a unit vector pointing out of the surface, which a resize, a JPEG round trip or a
  channel swap stops satisfying long before it looks wrong to a person. A terrain set is
  checked pair by pair again from the atlas on disk and each cell is held to the shape its
  bits declare, so a notch touched up on one edge is caught, and so is an atlas re-saved
  with its alpha flattened (every edge still agrees, solid against solid). Every cell's
  peering bits in the TileSet are held to the shape drawn there, every tile must still be
  in the terrain (one taken out is never painted), and the tile size must match the cells. A shape's points must
  still parse, match the count the run reported and stay within budget, and its occluder
  must still hold the first of them.
- A `.import` preset is written beside each PNG. Godot does not load a PNG, it loads the
  texture its importer made, and a perfect PNG imported wrong looks exactly like a bad one.
  Only `[params]` is written: Godot 4.7.2 was asked what it does with a params-only file
  and it fills in the uid and content hash itself while keeping every setting given. That
  closes the trap where 2D art touched by anything 3D is silently VRAM-compressed.
- An `AtlasTexture` may take a `CanvasTexture` as its atlas, which Godot confirmed by
  loading the chain back, so a sprite's normal map and its nearest filtering now travel
  inside the SpriteFrames resource. This is the only place filtering can travel with the
  art, since Godot 4 has no filter setting in a `.import` at all.
- `ratioAfter` in a tile's facts is renamed `ratioAfterByConstruction`, because after the
  fix the two edges are identical by construction and the number was reading as evidence
  when it was a tautology. A tile's transparency is reported too, since a texture with
  holes is a decal and not a floor.
- Normal map statistics count only where the art is. A sprite is mostly transparent
  padding, which encodes perfectly flat, so averaging it in made every figure look
  excellent in proportion to how much empty space the frame happened to have.
- Godot reads what onmodel writes. `sprites` now writes a `SpriteFrames` resource beside
  the atlas and the new `tile` writes a `TileSet`, so neither needs an importer or a
  plugin. Neither format is from memory: Godot 4.7.2 was asked to build each resource and
  save it, and these reproduce what it wrote. That caught what a guess gets wrong, since
  a SpriteFrames `loop` is written `1` or `0` rather than `true`, a frame's `duration` is
  a multiple of the animation's speed rather than a time, and a TileSet cell that is not
  declared is empty in the editor however good the pixels are. Godot loads both files
  back and reports the right animations, speeds, loops, regions and tiles. Sub-resource
  ids are numbered rather than random, as Godot's own are, so the same sprites give the
  same file and a diff shows what actually changed.
- Tiles that actually tile (`onmodel tile`). A painter paints one square and never sees
  it repeated, so it cannot know its right edge has to run into its left; across a floor
  that becomes a grid of seams. The join is measured against the texture's own grain,
  which is a ratio and so judges busy and smooth alike: noise has an enormous join in
  absolute terms and tiles perfectly, because every step across it is just as large, and
  an absolute threshold would have condemned it. Where the join is too sharp it is closed
  by moving both edges to meet in the middle and fading the correction inward, leaving
  the middle of the tile exactly as painted. The fix says what it is: it removes the
  line, it cannot make a brick carry on across the join, so how far it had to move the
  pixels is reported and a heavy correction is called `forced` rather than `fixed`. The
  tile is also written out laid three by three, which is the only way to really see it.
- A sprite action's `loop` now reaches the atlas, where it was dropped before, so a
  one-shot action arrives in Godot as one.

## 0.4.0 (2026-10-12)

- Lockups (`onmodel lockup`): a traced symbol and a wordmark set from a font, placed
  together as the one mark a combination logo is. Neither half is painted; what this adds
  is the arrangement. The symbol is sized against the cap height rather than the em or the
  ascender, since the ascender holds room for accents most words never use and sizing to
  it leaves the symbol looking small; side by side it is centred on the band between the
  baseline and the cap line rather than on the word's ink, so a descender on one letter
  cannot drag it off centre. Spacing is measured ink to ink: the traced symbol carries a
  margin from its crop and the first letter its own side bearing, and counting those in
  turned a gap of 20 into 30. `--layout beside` or `above`, with `--symbol` and `--gap` in
  cap heights. One SVG, one Android drawable and one set of tokens covering both halves.
- A font's cap height, measured off its H rather than read from OS/2, which plenty of
  fonts leave at zero or simply get wrong, falling back to the table and then to a share
  of the ascender.

- Wordmarks, set rather than drawn (`onmodel text --string "ACME" --font f.ttf`). The
  image models cannot be trusted with letters, and nothing onmodel measures could catch it
  if one came out wrong: silhouette, colour and drift have no notion of whether a shape is
  an R, so a mangled word would be reported as a perfect match for the mangled word it was
  given. Closing that by measuring harder is not possible; closing it by not drawing them
  is. The letters are read out of the font as the outlines the type designer drew and
  written as paths, arriving as the same SVG, Android vector drawable and CSS token as
  every other mark, with the fill named from the brief's palette. TrueType is read
  directly: the table directory, `cmap` in formats 4 and 12, `glyf` with its composite
  glyphs, `loca`, `hmtx` advances and `kern` pairs, with the quadratic curves TrueType
  stores converted to the cubics everything else here writes. OpenType's CFF flavour holds
  its outlines as Type 2 charstrings, a different parser entirely, and is named and turned
  down rather than read wrongly. Two things can still go wrong and both are checked: a
  character the font has not got, and a character the font claims to have but draws
  nothing for. Verified against a real system font, and Chromium draws the result within
  8 levels on 98.8% of pixels of onmodel's own render.

## 0.3.0 (2026-10-12)

- One colour (`onmodel vector --mono`): the art cut at a luminance instead of sorted into
  the colours it has, so a mark becomes a single shape for a stamp, a stencil or one-ink
  print. The cut is read off the art by Otsu's method, since a pale mark cut at the middle
  of the range comes out blank; `--threshold` sets it by hand, and `--tone <n>` gives n
  nested levels, each holding about the same amount of ink. The colour is the average of
  the ink, so it still snaps to the brief and still arrives as a named variable. Rather
  than a path of its own, the art is repainted into those levels and traced as the flat
  mark it then is, which keeps the stacking, the snapping and the measuring.
- Two traps in cutting by luminance, both of which quietly emptied a mark. Otsu names the
  top of the dark class, which on flat art is the ink's own luminance, so cutting there
  put the whole mark halfway up the soft edge at half coverage; the cut is moved into the
  gap between the two classes, and where the art is continuous there is no gap and nothing
  moves. And spreading levels evenly from the cut down to black wasted most of them,
  because a mark's ink sits in a narrow strip of the range: eight levels gave three. They
  are placed by how much ink is under them instead.
- `--noise <px>`: the smallest shape worth tracing, in pixels. It was already decided from
  the size of the art, which is right until it is not.
- Input is bounded. An image over 16 megapixels is turned down with its size rather than
  left to look like a hang, since tracing walks every pixel once per colour and again to
  follow each contour; over 64 megapixels it is turned down before being decoded at all,
  read from the PNG header, because a decoded pixel is four bytes.
- The allowance for thin art now applies to the share of pixels that kept their colour as
  well as to the silhouette. That share counts a pixel against the trace when the render
  is not solid there at all, so on a hairline it was carrying the same penalty twice and a
  good one-colour trace of a 3 px line came out poor.
- Illustrator's Corners dial was built, measured and then taken out again, which is worth
  recording so it is not built twice. On a rectangle, a five-pointed star and a
  twelve-tooth cog the output stopped changing at the default and above, because a corner
  must also be the sharpest turn in its window and a certain distance from the last one,
  so past a point there are no more corners to find. All the dial could do was find fewer,
  which rounds off real corners and grows the file, and that trade is what `--detail`
  already does.

- Full tone (`onmodel vector --tone <n>`): shaded art traced in up to that many tones
  instead of refused. Smooth shading becomes nested bands of flat colour, which is what a
  vector can hold, and the colour search splits on a finer error and merges less because
  tones sit close together by nature. A lit sphere, which a flat trace refuses outright,
  comes out in 14 tones at 0.6x the size of the same pixels as a PNG with 99.5% of pixels
  within a hair of their old colour. Painted and textured art is still refused without
  the flag; with it, the result is weighed against a PNG of the same pixels and reports
  the ratio, so a photograph says plainly that it came out ten times the size of its own
  PNG rather than quietly being ten times the size.
- Banding is measured, which no per-pixel figure can see. Flat bands across a gradient
  can hold every pixel to within a few of its old colour, so the share that kept its
  colour stays near perfect while the eye sees rings: the error is small everywhere but
  it steps, and a step is what we notice. The share of the art where the trace put an
  edge the source does not have is reported, and a trace that bands is never called good.
  Art that was banded to begin with keeps its own edges and is not charged for them: a
  posterised gradient measures 0.07 to 0.10 and cel shading 0.02 to 0.04, at every size
  tried.
- A colour search that could not converge ran for ever. Settling drops a colour that wins
  no pixels of its own, so pushing one and settling could leave the count exactly where
  it was, and against a smooth gradient, which no finite palette satisfies, the loop's own
  condition never came true. It is bounded now, and when the mean of what was missed lands
  between two tones and owns neither, the search seeds on the pixel furthest from every
  colour instead, which is a colour the art really has. Flat art never showed either
  fault, because its misses die away after a few colours and the other exit is taken
  first; the same seeding fix takes banded art from five colours and a mean error of 9.4
  to nine colours and a mean error of 0.
- Art with no interior to measure found no colours and wrote an empty SVG, a quiet nothing
  where a refusal or an honest big file belonged. That happens when no pixel agrees with
  its neighbours in colour, which is what a photograph looks like from here; the colours
  are now read off every pixel whenever there is too little interior to read them from.

- Centre lines (`onmodel vector --stroke <px>`): line work traced down the middle as
  stroked lines instead of around both sides as filled outlines. A pen stroke traced as
  an outline is a long thin loop with twice the points, and it stops being a line that
  can be reweighted or restyled. Parts of a colour no wider than the number given become
  open or closed paths with a stroke width, in the SVG and in the Android drawable, and
  leave the fill; anything wider stays a filled shape, so a mark that is part drawing and
  part solid comes out as both. Chamfer distance transform, Zhang-Suen thinning and a
  skeleton graph find the lines; the width is then read off the soft edge of the art, to
  a fraction of a pixel (2.42 for a 2.40 px line, 6.08 for 6.00), which a distance
  transform cannot do because it cannot tell a 2 px line from a 1 px one.
- Line art is no longer refused as painted. Flatness was the share of all the ink with
  four opaque neighbours, and a two-pixel line has almost none, so a pure black line
  measured as textured. That one share was answering two questions, and is now two: how
  flat the part that can be judged is, and how much of the art is too thin to judge.
- A hairline is no longer marked as though it were a blob. A quarter-pixel error along an
  edge costs a solid mark almost nothing and a 2.4 px line a fifth of itself, so every
  trace of line work came out poor however exact it was. The verdict is set against what
  the art's own line weight allows, measured where centre lines were used and estimated
  from the art otherwise so the two stay comparable, and the raw figure is reported
  beside it.
- Three traps in the skeleton, each of which quietly lost part of a drawing: branches
  counted by neighbours made every staircase corner a junction and broke a plain
  rectangle outline into eight pieces, where the crossing number keeps it one ring; a
  walk that preferred no particular step hopped around a junction on a diagonal and
  reported a four-way crossing as one long line; and a walk keyed by direction rather
  than by the pixels it claimed left 55 skeleton pixels in no run at all, so a whole arc
  of a ring went untraced. Verified in Chromium: 98.9% of pixels within 24 levels of
  onmodel's own render.

## 0.2.0 (2026-10-12)

- Vector output (`onmodel vector`): the image models only paint pixels, so a mark is
  traced after painting. Flat-colour art becomes an SVG and an Android vector
  drawable; pixel art converts exactly, every pixel; painted, shaded or textured art
  is refused with the measurement that says why. The art's flat colours are found from
  its interior pixels (a small accent or a thin outline seeds its own colour rather
  than being outvoted by a large background), snapped to the brief's palette and
  named after it, so every fill is a CSS variable such as `--brand-plum` with the real
  colour as fallback, and the Android drawable fills from colour resources. Colours
  stack bottom to top but overlap only in the interior, so no gap opens between two
  colours and no colour bleeds at the silhouette; pixels on the rim take their colour
  from inside, so key residue never turns into an outline. Contours are found at
  sub-pixel precision and fitted with curves between corners. The written SVG is
  parsed back, drawn and compared with the source (silhouette, pixels that kept their
  colour, drift, size) for a verdict, and Chromium draws the same files the same way
  (99.8 to 100 percent of pixels). Free, deterministic, exits 2 for a refusal or a poor
  match. Live: the Pay in Style bag tag traced into 5 brand colours in 15.5 KB, the
  2K store hero into 6 colours in 42 KB, the Chomp sprite exactly in 2.4 KB.
- Vector icons: when the mark traces well, `icons` also writes an SVG favicon (offered
  first in the head tags), an SVG foreground layer for Icon Composer, and Android
  vector drawables for the adaptive foreground, the themed monochrome layer and the
  notification icon, in `-anydpi` folders so they take over on the Android versions
  that read them while the PNGs serve older ones; the adaptive icon points at them.
  One-colour icons use the traced silhouette alone (about 2.5 KB). Each vector icon is
  checked to draw like its PNG. Pixel art keeps PNGs on Android, which draws vectors
  without crisp edges; a mark that does not trace keeps its PNGs, and the report says
  why.
- A sprite atlas now stamps the version of the tool that actually wrote it. The
  TexturePacker metadata carried a written-down `0.1.0`, so every atlas this release
  wrote would have claimed to come from the previous one; the version is read from the
  package instead, and an atlas given no version leaves the field out rather than
  naming the wrong one.

## 0.1.0 (2026-10-08)

The first release.

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
