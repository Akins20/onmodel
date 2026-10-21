/**
 * A TrueType font built byte by byte, so the tests need no font file of their own and no
 * licence to ship one. Three glyphs: an empty .notdef, a square for A and a triangle for
 * B, at 1000 units to the em with an advance of 600.
 */
export function tinyFont({ unitsPerEm = 1000, advance = 600 } = {}) {
  const pad4 = (b) => (b.length % 4 ? Buffer.concat([b, Buffer.alloc(4 - (b.length % 4))]) : b);

  const simpleGlyph = (points, box) => {
    const head = Buffer.alloc(10);
    head.writeInt16BE(1, 0);
    for (let i = 0; i < 4; i++) head.writeInt16BE(box[i], 2 + i * 2);
    const ends = Buffer.alloc(2);
    ends.writeUInt16BE(points.length - 1, 0);
    const instr = Buffer.alloc(2);
    // every point sits on the curve, and every coordinate is a signed 16-bit step
    const flags = Buffer.alloc(points.length, 1);
    const xs = Buffer.alloc(points.length * 2);
    const ys = Buffer.alloc(points.length * 2);
    let px = 0;
    let py = 0;
    points.forEach(([x, y], i) => {
      xs.writeInt16BE(x - px, i * 2);
      ys.writeInt16BE(y - py, i * 2);
      px = x;
      py = y;
    });
    const g = Buffer.concat([head, ends, instr, flags, xs, ys]);
    return g.length % 2 ? Buffer.concat([g, Buffer.alloc(1)]) : g;
  };

  const square = simpleGlyph(
    [
      [100, 0],
      [500, 0],
      [500, 400],
      [100, 400],
    ],
    [100, 0, 500, 400],
  );
  const triangle = simpleGlyph(
    [
      [100, 0],
      [500, 0],
      [300, 500],
    ],
    [100, 0, 500, 500],
  );
  const glyf = Buffer.concat([square, triangle]);
  const numGlyphs = 3;

  const loca = Buffer.alloc((numGlyphs + 1) * 2);
  loca.writeUInt16BE(0, 0);
  loca.writeUInt16BE(0, 2);
  loca.writeUInt16BE(square.length / 2, 4);
  loca.writeUInt16BE((square.length + triangle.length) / 2, 6);

  const head = Buffer.alloc(54);
  head.writeUInt32BE(0x00010000, 0);
  head.writeUInt32BE(0x5f0f3cf5, 12);
  head.writeUInt16BE(unitsPerEm, 18);
  head.writeInt16BE(0, 50); // short loca

  const maxp = Buffer.alloc(32);
  maxp.writeUInt32BE(0x00010000, 0);
  maxp.writeUInt16BE(numGlyphs, 4);

  const hhea = Buffer.alloc(36);
  hhea.writeUInt32BE(0x00010000, 0);
  hhea.writeInt16BE(800, 4); // ascender
  hhea.writeInt16BE(-200, 6); // descender
  hhea.writeUInt16BE(numGlyphs, 34); // one metric per glyph

  const hmtx = Buffer.alloc(numGlyphs * 4);
  for (let g = 0; g < numGlyphs; g++) hmtx.writeUInt16BE(advance, g * 4);

  // cmap: one Windows BMP table, format 4, covering A to H through a glyph id array,
  // which is the form real fonts use and the one worth exercising. A and H are the
  // square, B is the triangle, and the letters between them are absent.
  const sub = Buffer.alloc(48);
  sub.writeUInt16BE(4, 0);
  sub.writeUInt16BE(48, 2);
  sub.writeUInt16BE(4, 6); // segCountX2
  sub.writeUInt16BE(72, 14); // endCode[0] = H
  sub.writeUInt16BE(0xffff, 16); // endCode[1]
  sub.writeUInt16BE(0, 18); // reservedPad
  sub.writeUInt16BE(65, 20); // startCode[0] = A
  sub.writeUInt16BE(0xffff, 22);
  sub.writeInt16BE(0, 24); // idDelta[0]: none, the array decides
  sub.writeInt16BE(1, 26);
  sub.writeUInt16BE(4, 28); // idRangeOffset[0]: the array starts four bytes on
  sub.writeUInt16BE(0, 30);
  [1, 2, 0, 0, 0, 0, 0, 1].forEach((g, i) => sub.writeUInt16BE(g, 32 + i * 2));
  const cmapHead = Buffer.alloc(12);
  cmapHead.writeUInt16BE(0, 0);
  cmapHead.writeUInt16BE(1, 2);
  cmapHead.writeUInt16BE(3, 4);
  cmapHead.writeUInt16BE(1, 6);
  cmapHead.writeUInt32BE(12, 8);
  const cmap = Buffer.concat([cmapHead, sub]);

  const parts = [
    ["cmap", cmap],
    ["glyf", glyf],
    ["head", head],
    ["hhea", hhea],
    ["hmtx", hmtx],
    ["loca", loca],
    ["maxp", maxp],
  ];
  const dir = Buffer.alloc(12 + parts.length * 16);
  dir.writeUInt32BE(0x00010000, 0);
  dir.writeUInt16BE(parts.length, 4);
  let at = dir.length;
  const bodies = [];
  parts.forEach(([name, body], i) => {
    const padded = pad4(body);
    dir.write(name, 12 + i * 16, 4, "latin1");
    dir.writeUInt32BE(at, 12 + i * 16 + 8);
    dir.writeUInt32BE(body.length, 12 + i * 16 + 12);
    bodies.push(padded);
    at += padded.length;
  });
  return Buffer.concat([dir, ...bodies]);
}
