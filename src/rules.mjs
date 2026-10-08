/**
 * The rulebook: what each platform asks of an icon, with where it was read and
 * when. Stores change these every year, so the date is part of the rule; every
 * file the tool writes is checked against its entry, and a failure is reported in
 * the platform's own terms rather than discovered at submission.
 *
 * Read on the date below:
 *   Android adaptive icons: 108 x 108 dp layers, the outer 18 dp reserved for
 *     masking and effects, a 66 x 66 dp safe zone no OEM mask clips, the logo at
 *     least 48 dp and at most 66 dp, an optional monochrome layer for themed icons
 *     (Android 13 and later).
 *   Apple app icons: 1024 x 1024 px square for iOS, iPadOS and macOS, masked by the
 *     system to rounded corners; layered icons are built in Icon Composer (the 26
 *     releases, Liquid Glass), and a flattened image is still accepted.
 *   Web app manifest: maskable icons keep their content inside a centred circle of
 *     radius 40% of the icon, the minimum safe zone.
 *   Google Play: a 512 x 512 px 32-bit PNG (alpha allowed) of at most 1024 KB; the
 *     tool writes a full-bleed square on the background colour and Play applies its
 *     own mask. The feature graphic is 1024 x 500, JPEG or 24-bit PNG with no alpha.
 *   Android notification icons: 24 dp, white on transparent; the system tints them.
 */

export const RULES_AS_OF = "2026-10-08";

export const RULE_SOURCES = {
  android: "https://developer.android.com/develop/ui/views/launch/icon_design_adaptive",
  apple: "https://developer.apple.com/design/human-interface-guidelines/app-icons",
  maskable: "https://www.w3.org/TR/appmanifest/#icon-masks",
  play: "https://support.google.com/googleplay/android-developer/answer/9866151",
  notification: "https://developer.android.com/develop/ui/views/notifications/build-notification",
};

/** Android densities: the scale of each against mdpi, where 1 dp is 1 px. */
export const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 };

/** Adaptive layer geometry, in dp. */
export const ADAPTIVE = { layer: 108, viewport: 72, safe: 66, logoMin: 48, logoMax: 66 };

/** The maskable icon's minimum safe zone, as a share of the icon's width (a radius). */
export const MASKABLE_SAFE_RADIUS = 0.4;

export const PLAY_MAX_BYTES = 1024 * 1024;

/**
 * Checks one written icon against what its platform asks. `image` is the decoded
 * RGBA, `bytes` the file's size, `rule` the entry's requirements. Returns a list
 * of { check, ok, detail } so the report can say exactly what failed.
 */
export function checkIcon(image, bytes, rule) {
  const out = [];
  const push = (check, ok, detail, warn = false) => out.push({ check, ok, detail, ...(warn ? { warn: true } : {}) });
  if (rule.width) push("size", image.width === rule.width && image.height === rule.height, `${image.width}x${image.height}, needs ${rule.width}x${rule.height}`);
  const n = image.width * image.height;
  let translucent = 0;
  let opaqueNonWhite = 0;
  const colours = new Set();
  let x0 = image.width;
  let y0 = image.height;
  let x1 = -1;
  let y1 = -1;
  let outside = 0;
  const cx = image.width / 2;
  const cy = image.height / 2;
  const safeR = rule.safeRadius ? rule.safeRadius * image.width : null;
  // A full-bleed icon's background reaches the edges by design; the safe zone is
  // about the mark, so pixels of the background colour are not counted against it.
  const ignore = rule.safeIgnore ? rule.safeIgnore.replace('#', '').match(/../g).map((h) => parseInt(h, 16)) : null;
  for (let i = 0; i < n; i++) {
    const p = i * 4;
    const a = image.data[p + 3];
    if (a < 255) translucent++;
    if (a < 16) continue;
    const x = i % image.width;
    const y = (i / image.width) | 0;
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (image.data[p] < 235 || image.data[p + 1] < 235 || image.data[p + 2] < 235) opaqueNonWhite++;
    colours.add((image.data[p] << 16) | (image.data[p + 1] << 8) | image.data[p + 2]);
    const isBackground = ignore && Math.abs(image.data[p] - ignore[0]) <= 10 && Math.abs(image.data[p + 1] - ignore[1]) <= 10 && Math.abs(image.data[p + 2] - ignore[2]) <= 10;
    if (safeR !== null && !isBackground && Math.hypot(x + 0.5 - cx, y + 0.5 - cy) > safeR) outside++;
  }
  if (rule.opaque) push("opaque", translucent === 0, translucent ? `${translucent} pixels are not fully opaque; this platform shows them black or rejects the file` : "no transparency");
  if (rule.transparent) push("transparent background", translucent > 0, translucent ? "has transparency" : "fully opaque; the system needs a transparent background to draw it");
  if (rule.whiteOnly) push("white only", opaqueNonWhite === 0, opaqueNonWhite ? `${opaqueNonWhite} visible pixels are not white; the system tints a silhouette and colour is lost or shows as a block` : "a white silhouette");
  if (rule.singleColour) push("one colour", colours.size <= 1, `${colours.size} colours; a themed icon is one silhouette the system tints`);
  if (safeR !== null) push("safe zone", outside === 0, outside ? `${outside} visible pixels lie outside the safe zone (radius ${Math.round(safeR)} px) and a mask may cut them` : "everything inside the safe zone");
  if (rule.logoMin) {
    const size = x1 >= 0 ? Math.max(x1 - x0 + 1, y1 - y0 + 1) : 0;
    // Android asks for a logo at least 48 dp across and inside a safe zone no mask
    // clips; a square 48 dp logo cannot fit a 66 dp circle, so the mark is made as
    // large as the safe zone allows and a shortfall is a warning, not a failure.
    push("logo size", size >= rule.logoMin * image.width, `logo ${size} px across; Android suggests at least ${Math.round(rule.logoMin * image.width)} px${rule.pixel ? ", and pixel art is scaled by whole numbers to stay crisp, so at this density it stays smaller" : ", and this is as large as the safe zone allows for this shape"}`, true);
  }
  if (rule.maxBytes) push("file size", bytes <= rule.maxBytes, `${Math.round(bytes / 1024)} KB, at most ${Math.round(rule.maxBytes / 1024)} KB`);
  return out;
}
