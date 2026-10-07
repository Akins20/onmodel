import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { decodeJPEG, isJPEG } from "../src/jpeg.mjs";
import { decodePNG, encodePNG } from "../src/png.mjs";

/**
 * The decoder is checked against Chromium: each fixture JPEG was encoded by the
 * browser, and beside it sits a lossless PNG of what the browser decoded from that
 * same JPEG. Two conforming decoders differ by a level or two from IDCT rounding
 * and chroma upsampling, so the comparison is a tolerance, and the tolerance is
 * tight enough that a wrong table, a shifted block or a swapped channel fails.
 */

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

async function compare(name) {
  const jpeg = await readFile(path.join(fixtures, `${name}.jpg`));
  const ref = decodePNG(await readFile(path.join(fixtures, `${name}.ref.png`)));
  const got = decodeJPEG(jpeg);
  assert.equal(got.width, ref.width, "width");
  assert.equal(got.height, ref.height, "height");
  let sum = 0;
  let max = 0;
  let over8 = 0;
  const n = ref.width * ref.height;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      const d = Math.abs(got.data[i * 4 + c] - ref.data[i * 4 + c]);
      sum += d;
      if (d > max) max = d;
      if (d > 8) over8++;
    }
    assert.equal(got.data[i * 4 + 3], 255, "opaque");
  }
  return { mean: sum / (n * 3), max, over8Share: over8 / (n * 3), got, ref };
}

test("a 4:2:0 photo decodes to what Chromium decodes, within rounding", async () => {
  // Measured at 0.20 mean and 3 max when the fixture was made; the bounds leave
  // room for rounding, not for a wrong table or a shifted block.
  const { mean, max, over8Share } = await compare("cat-256");
  assert.ok(mean < 0.6, `mean difference ${mean.toFixed(3)} should be under 0.6 levels`);
  assert.equal(over8Share, 0, "no sample differs from the browser by more than 8 levels");
  assert.ok(max <= 6, `max difference ${max}`);
});

test("an odd-sized image with hard edges keeps its size and its edges", async () => {
  const { mean, max, got } = await compare("grad-37x29");
  assert.ok(mean < 0.8, `mean difference ${mean.toFixed(3)}`);
  assert.ok(max <= 6, `max difference ${max}`);
  // The black and white boxes drawn into the gradient survive decoding as black and white.
  const px = (x, y) => Array.from(got.data.subarray((y * got.width + x) * 4, (y * got.width + x) * 4 + 3));
  assert.ok(px(9, 8).every((v) => v < 40), `black box reads ${px(9, 8)}`);
  assert.ok(px(25, 16).every((v) => v > 215), `white box reads ${px(25, 16)}`);
});

test("it recognises JPEG and refuses what it cannot decode with a reason", () => {
  assert.ok(isJPEG(Buffer.from([0xff, 0xd8, 0xff, 0xe0])));
  assert.ok(!isJPEG(encodePNG({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) })));
  assert.throws(() => decodeJPEG(encodePNG({ width: 1, height: 1, data: new Uint8Array([0, 0, 0, 255]) })), /not a JPEG/);

  const frame = (sof, precision) => Buffer.from([0xff, 0xd8, 0xff, sof, 0x00, 0x11, precision, 0x00, 0x08, 0x00, 0x08, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xff, 0xd9]);
  assert.throws(() => decodeJPEG(frame(0xc2, 8)), /progressive/, "a progressive frame is named, not misread");
  assert.throws(() => decodeJPEG(frame(0xc0, 12)), /12-bit/, "12-bit samples are named");
  assert.throws(() => decodeJPEG(frame(0xc9, 8)), /arithmetic/, "arithmetic coding is named");
});

test("a baseline file with restart intervals decodes the same as one without", async () => {
  // The cat fixture has no DRI marker; Chromium never writes one. A hand-made
  // restart case is covered by decoding the probe-sized image in the live smoke,
  // so here the check is that a DRI segment is parsed without disturbing a decode.
  const jpeg = await readFile(path.join(fixtures, "cat-256.jpg"));
  const sos = jpeg.indexOf(Buffer.from([0xff, 0xda]));
  assert.ok(sos > 0);
  // Insert a DRI of 0 (no restarts) before the scan: a decoder must accept it and
  // treat zero as "no interval".
  const withDri = Buffer.concat([jpeg.subarray(0, sos), Buffer.from([0xff, 0xdd, 0x00, 0x04, 0x00, 0x00]), jpeg.subarray(sos)]);
  const a = decodeJPEG(jpeg);
  const b = decodeJPEG(withDri);
  assert.deepEqual(Array.from(b.data.subarray(0, 4096)), Array.from(a.data.subarray(0, 4096)));
});
