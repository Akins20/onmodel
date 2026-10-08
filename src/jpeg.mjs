/**
 * A baseline JPEG decoder, so the tool can read what an image model returns
 * without an image library. The Gemini image models answer with baseline JPEG
 * (one sequential Huffman-coded scan, 8-bit samples, 4:2:0 chroma, no restart
 * markers), and that is what this decodes, along with the nearby variants a
 * baseline file may use: 4:2:2 and 4:4:4 sampling, restart intervals, extended
 * sequential frames, greyscale, and Adobe files that store RGB. Progressive and
 * arithmetic-coded files are refused with a message that says so, rather than
 * decoded wrongly. The result has the same shape as decodePNG: { width, height,
 * data } with 8-bit RGBA samples.
 *
 * Chroma is upsampled with a triangle filter (what libjpeg calls fancy
 * upsampling), so colours at edges match what a browser shows to within a level
 * or two instead of the blockiness nearest-neighbour would add.
 */

/** Natural (row-major) index of each zigzag position. */
const ZIGZAG = new Uint8Array([
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37,
  44, 51, 58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
]);

/** COS[u * 8 + x] = C(u) cos((2x + 1) u pi / 16) / 2, the separable IDCT basis. */
const COS = new Float32Array(64);
for (let u = 0; u < 8; u++) {
  for (let x = 0; x < 8; x++) COS[u * 8 + x] = ((u === 0 ? Math.SQRT1_2 : 1) * Math.cos(((2 * x + 1) * u * Math.PI) / 16)) / 2;
}

export function isJPEG(buffer) {
  return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

/**
 * A canonical Huffman table as a 16-bit lookup: index by the next 16 bits of the
 * stream and read the code length and symbol in one step, instead of walking the
 * code one bit at a time.
 */
function buildHuffman(counts, symbols) {
  const lookup = new Uint16Array(1 << 16);
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < counts[len - 1]; i++) {
      const start = code << (16 - len);
      lookup.fill((len << 8) | symbols[k++], start, start + (1 << (16 - len)));
      code++;
    }
    code <<= 1;
  }
  return lookup;
}

/**
 * Reads entropy-coded bits, unstuffing 0xFF00 and stopping at a marker. Once a
 * marker is met the reader pads with zeros, which is how the standard says the
 * tail of an interval is to be read.
 */
class BitReader {
  constructor(data, pos) {
    this.data = data;
    this.pos = pos;
    this.acc = 0;
    this.bits = 0;
    this.marker = null;
  }

  fill() {
    while (this.bits < 16) {
      let byte = 0;
      if (this.marker === null && this.pos < this.data.length) {
        byte = this.data[this.pos];
        if (byte === 0xff) {
          const next = this.data[this.pos + 1];
          if (next === 0) this.pos += 2;
          else if (next === 0xff) {
            this.pos += 1; // fill bytes before a marker
            continue;
          } else {
            this.marker = next;
            byte = 0;
          }
        } else this.pos++;
      }
      this.acc = (this.acc << 8) | byte;
      this.bits += 8;
    }
  }

  readBits(n) {
    if (!n) return 0;
    this.fill();
    const v = (this.acc >> (this.bits - n)) & ((1 << n) - 1);
    this.bits -= n;
    this.acc &= (1 << this.bits) - 1;
    return v;
  }

  decode(table) {
    this.fill();
    const entry = table[(this.acc >> (this.bits - 16)) & 0xffff];
    const len = entry >> 8;
    if (!len) throw new Error("jpeg: invalid Huffman code in the entropy-coded data");
    this.bits -= len;
    this.acc &= (1 << this.bits) - 1;
    return entry & 0xff;
  }

  /** A magnitude category's bits as a signed value (F.2.2.1 EXTEND). */
  receiveExtend(s) {
    if (!s) return 0;
    const v = this.readBits(s);
    return v < 1 << (s - 1) ? v - (1 << s) + 1 : v;
  }

  /** Moves to the next marker, dropping any buffered bits, and returns its code. */
  findMarker() {
    this.acc = 0;
    this.bits = 0;
    if (this.marker !== null) {
      const m = this.marker;
      this.marker = null;
      return m;
    }
    while (this.pos + 1 < this.data.length) {
      if (this.data[this.pos] === 0xff && this.data[this.pos + 1] !== 0 && this.data[this.pos + 1] !== 0xff) return this.data[this.pos + 1];
      this.pos++;
    }
    return null;
  }

  /** Consumes an RSTn marker and resets the entropy decoder for the next interval. */
  restart() {
    const m = this.findMarker();
    if (m === null || m < 0xd0 || m > 0xd7) throw new Error("jpeg: expected a restart marker between intervals");
    this.pos += 2;
  }
}

function decodeBlock(reader, comp, coeffs, offset) {
  const t = reader.decode(comp.dcTable);
  comp.pred += t === 0 ? 0 : reader.receiveExtend(t);
  coeffs[offset] = comp.pred;
  let k = 1;
  while (k < 64) {
    const rs = reader.decode(comp.acTable);
    const s = rs & 15;
    const r = rs >> 4;
    if (s === 0) {
      if (r < 15) break;
      k += 16;
      continue;
    }
    k += r;
    if (k > 63) throw new Error("jpeg: coefficient index past the end of a block");
    coeffs[offset + ZIGZAG[k]] = reader.receiveExtend(s);
    k++;
  }
}

/** Dequantises one block and writes its 64 samples into a plane. */
function idctBlock(coeffs, offset, q, plane, planeOffset, stride, tmp) {
  for (let v = 0; v < 8; v++) {
    const row = offset + v * 8;
    for (let x = 0; x < 8; x++) {
      let s = 0;
      for (let u = 0; u < 8; u++) {
        const c = coeffs[row + u];
        if (c) s += COS[u * 8 + x] * c * q[v * 8 + u];
      }
      tmp[v * 8 + x] = s;
    }
  }
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      let s = 128;
      for (let v = 0; v < 8; v++) s += COS[v * 8 + y] * tmp[v * 8 + x];
      plane[planeOffset + y * stride + x] = s < 0 ? 0 : s > 255 ? 255 : (s + 0.5) | 0;
    }
  }
}

/** Decodes a baseline JPEG into { width, height, data } with RGBA samples. */
export function decodeJPEG(buffer) {
  const data = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (!isJPEG(data)) throw new Error("not a JPEG file");
  const quant = [];
  const dcTables = [];
  const acTables = [];
  let frame = null;
  let restartInterval = 0;
  let adobeTransform = null;
  let pos = 2;
  const u16 = (p) => (data[p] << 8) | data[p + 1];

  while (pos < data.length) {
    if (data[pos] !== 0xff) throw new Error(`jpeg: expected a marker at byte ${pos}`);
    const marker = data[pos + 1];
    pos += 2;
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || marker === 0x01 || marker === 0xff) continue;
    if (marker === 0xd9) break; // EOI
    const len = u16(pos);
    const seg = pos + 2;
    const end = pos + len;
    if (marker === 0xdb) {
      // DQT: one or more tables, 8- or 16-bit, stored in zigzag order.
      let p = seg;
      while (p < end) {
        const pq = data[p] >> 4;
        const tq = data[p] & 15;
        p++;
        const table = new Uint16Array(64);
        for (let k = 0; k < 64; k++) {
          table[ZIGZAG[k]] = pq ? u16(p + k * 2) : data[p + k];
        }
        p += pq ? 128 : 64;
        quant[tq] = table;
      }
    } else if (marker === 0xc4) {
      // DHT: one or more Huffman tables.
      let p = seg;
      while (p < end) {
        const tc = data[p] >> 4;
        const th = data[p] & 15;
        p++;
        const counts = data.subarray(p, p + 16);
        let total = 0;
        for (let i = 0; i < 16; i++) total += counts[i];
        const symbols = data.subarray(p + 16, p + 16 + total);
        (tc === 0 ? dcTables : acTables)[th] = buildHuffman(counts, symbols);
        p += 16 + total;
      }
    } else if (marker === 0xc0 || marker === 0xc1) {
      if (frame) throw new Error("jpeg: more than one frame");
      const precision = data[seg];
      if (precision !== 8) throw new Error(`jpeg: ${precision}-bit samples are not supported (8-bit baseline only)`);
      const height = u16(seg + 1);
      const width = u16(seg + 3);
      const count = data[seg + 5];
      if (!width || !height) throw new Error("jpeg: the frame has no size (a DNL marker is not supported)");
      const components = [];
      let hmax = 1;
      let vmax = 1;
      for (let i = 0; i < count; i++) {
        const p = seg + 6 + i * 3;
        const h = data[p + 1] >> 4;
        const v = data[p + 1] & 15;
        if (!h || !v) throw new Error("jpeg: a component has a zero sampling factor");
        components.push({ id: data[p], h, v, tq: data[p + 2], pred: 0 });
        if (h > hmax) hmax = h;
        if (v > vmax) vmax = v;
      }
      const mcusPerLine = Math.ceil(width / (8 * hmax));
      const mcusPerColumn = Math.ceil(height / (8 * vmax));
      for (const c of components) {
        c.blocksPerLine = Math.ceil(Math.ceil((width * c.h) / hmax) / 8);
        c.blocksPerColumn = Math.ceil(Math.ceil((height * c.v) / vmax) / 8);
        c.blocksPerLineForMcu = mcusPerLine * c.h;
        c.blocksPerColumnForMcu = mcusPerColumn * c.v;
        c.coeffs = new Int16Array(c.blocksPerLineForMcu * c.blocksPerColumnForMcu * 64);
      }
      frame = { width, height, components, hmax, vmax, mcusPerLine, mcusPerColumn };
    } else if (marker === 0xc2 || marker === 0xc6 || marker === 0xca || marker === 0xce) {
      throw new Error("jpeg: progressive JPEG is not supported (the image models return baseline files)");
    } else if ((marker >= 0xc3 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) || marker === 0xf7) {
      throw new Error("jpeg: lossless, hierarchical and arithmetic-coded JPEG are not supported");
    } else if (marker === 0xdd) {
      restartInterval = u16(seg);
    } else if (marker === 0xee) {
      // APP14 Adobe: transform 0 means the three components are RGB, not YCbCr.
      if (data[seg] === 0x41 && data[seg + 1] === 0x64 && data[seg + 2] === 0x6f && data[seg + 3] === 0x62 && data[seg + 4] === 0x65) adobeTransform = data[seg + 11];
    } else if (marker === 0xda) {
      if (!frame) throw new Error("jpeg: a scan before the frame header");
      const count = data[seg];
      const scan = [];
      for (let i = 0; i < count; i++) {
        const id = data[seg + 1 + i * 2];
        const tables = data[seg + 2 + i * 2];
        const comp = frame.components.find((c) => c.id === id);
        if (!comp) throw new Error(`jpeg: scan names component ${id}, which the frame does not have`);
        comp.dcTable = dcTables[tables >> 4];
        comp.acTable = acTables[tables & 15];
        if (!comp.dcTable || !comp.acTable) throw new Error("jpeg: a scan uses a Huffman table that was never defined");
        comp.pred = 0;
        scan.push(comp);
      }
      const spectralStart = data[seg + 1 + count * 2];
      const spectralEnd = data[seg + 2 + count * 2];
      if (spectralStart !== 0 || spectralEnd !== 63) throw new Error("jpeg: a partial spectral scan is a progressive feature and is not supported");
      pos = decodeScan(data, end, frame, scan, restartInterval);
      continue;
    }
    pos = end;
  }
  if (!frame) throw new Error("jpeg: no frame header found");
  return assemble(frame, quant, adobeTransform);
}

/** Decodes one scan's entropy-coded segment into the components' coefficient arrays, returning the position after it. */
function decodeScan(data, start, frame, scan, restartInterval) {
  const reader = new BitReader(data, start);
  const interleaved = scan.length > 1;
  const total = interleaved ? frame.mcusPerLine * frame.mcusPerColumn : scan[0].blocksPerLine * scan[0].blocksPerColumn;
  let done = 0;
  while (done < total) {
    const run = restartInterval ? Math.min(restartInterval, total - done) : total - done;
    for (let n = 0; n < run; n++, done++) {
      if (interleaved) {
        const mcuRow = (done / frame.mcusPerLine) | 0;
        const mcuCol = done % frame.mcusPerLine;
        for (const comp of scan) {
          for (let v = 0; v < comp.v; v++) {
            for (let h = 0; h < comp.h; h++) {
              const blockRow = mcuRow * comp.v + v;
              const blockCol = mcuCol * comp.h + h;
              decodeBlock(reader, comp, comp.coeffs, (blockRow * comp.blocksPerLineForMcu + blockCol) * 64);
            }
          }
        }
      } else {
        const comp = scan[0];
        const blockRow = (done / comp.blocksPerLine) | 0;
        const blockCol = done % comp.blocksPerLine;
        decodeBlock(reader, comp, comp.coeffs, (blockRow * comp.blocksPerLineForMcu + blockCol) * 64);
      }
    }
    if (done < total) {
      reader.restart();
      for (const comp of scan) comp.pred = 0;
    }
  }
  const marker = reader.findMarker();
  if (marker === null) return data.length;
  return reader.pos;
}

/** Runs the IDCT over every block, upsamples the chroma planes and converts to RGBA. */
function assemble(frame, quant, adobeTransform) {
  const { width, height, components, hmax, vmax } = frame;
  const tmp = new Float32Array(64);
  const planes = components.map((c) => {
    const q = quant[c.tq];
    if (!q) throw new Error("jpeg: a component uses a quantisation table that was never defined");
    const stride = c.blocksPerLineForMcu * 8;
    const plane = new Uint8Array(stride * c.blocksPerColumnForMcu * 8);
    for (let row = 0; row < c.blocksPerColumnForMcu; row++) {
      for (let col = 0; col < c.blocksPerLineForMcu; col++) {
        idctBlock(c.coeffs, (row * c.blocksPerLineForMcu + col) * 64, q, plane, row * 8 * stride + col * 8, stride, tmp);
      }
    }
    c.coeffs = null;
    return { plane, stride, w: Math.ceil((width * c.h) / hmax), h: Math.ceil((height * c.v) / vmax), sx: c.h / hmax, sy: c.v / vmax };
  });

  // Per-axis sampling positions for each subsampled plane: the two source
  // indices and the weight of the second, with centres aligned the way a
  // triangle-filter upsampler aligns them.
  const axis = (n, scale, limit) => {
    const i0 = new Int32Array(n);
    const i1 = new Int32Array(n);
    const t = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const f = (i + 0.5) * scale - 0.5;
      const a = Math.max(0, Math.min(limit - 1, Math.floor(f)));
      i0[i] = a;
      i1[i] = Math.min(limit - 1, a + 1);
      t[i] = f < 0 ? 0 : Math.min(1, f - a);
    }
    return { i0, i1, t };
  };
  const samplers = planes.map((p) => {
    if (p.sx === 1 && p.sy === 1) return null;
    return { x: axis(width, p.sx, p.w), y: axis(height, p.sy, p.h) };
  });
  const sampleAt = (p, s, x, y) => {
    if (!s) return p.plane[y * p.stride + x];
    const { i0: x0, i1: x1, t: tx } = s.x;
    const { i0: y0, i1: y1, t: ty } = s.y;
    const r0 = y0[y] * p.stride;
    const r1 = y1[y] * p.stride;
    const top = p.plane[r0 + x0[x]] + (p.plane[r0 + x1[x]] - p.plane[r0 + x0[x]]) * tx[x];
    const bottom = p.plane[r1 + x0[x]] + (p.plane[r1 + x1[x]] - p.plane[r1 + x0[x]]) * tx[x];
    return top + (bottom - top) * ty[y];
  };

  const out = new Uint8Array(width * height * 4);
  const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : (v + 0.5) | 0);
  if (components.length === 1) {
    const p = planes[0];
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4;
        out[o] = out[o + 1] = out[o + 2] = p.plane[y * p.stride + x];
        out[o + 3] = 255;
      }
    }
    return { width, height, data: out };
  }
  if (components.length !== 3) throw new Error(`jpeg: ${components.length}-component images (CMYK) are not supported`);
  const rgb = adobeTransform === 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      const c0 = sampleAt(planes[0], samplers[0], x, y);
      const c1 = sampleAt(planes[1], samplers[1], x, y);
      const c2 = sampleAt(planes[2], samplers[2], x, y);
      if (rgb) {
        out[o] = clamp(c0);
        out[o + 1] = clamp(c1);
        out[o + 2] = clamp(c2);
      } else {
        out[o] = clamp(c0 + 1.402 * (c2 - 128));
        out[o + 1] = clamp(c0 - 0.344136 * (c1 - 128) - 0.714136 * (c2 - 128));
        out[o + 2] = clamp(c0 + 1.772 * (c1 - 128));
      }
      out[o + 3] = 255;
    }
  }
  return { width, height, data: out };
}

/*
 * A baseline JPEG encoder, the decoder's counterpart, for the store graphics that
 * must fit a byte cap a lossless PNG can pass (GitHub's preview is under 1 MB). One
 * sequential scan, 4:4:4 sampling so brand colours and edges keep their chroma, the
 * Annex K quantisation tables scaled by quality the way libjpeg scales them, and the
 * Annex K Huffman tables. The file has no alpha channel by construction.
 */

const STD_LUMA_Q = [
  16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56, 14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104,
  113, 92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];
const STD_CHROMA_Q = [17, 18, 24, 47, 99, 99, 99, 99, 18, 21, 26, 66, 99, 99, 99, 99, 24, 26, 56, 99, 99, 99, 99, 99, 47, 66, 99, 99, 99, 99, 99, 99, ...new Array(32).fill(99)];

const DC_VALUES = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
/** The Annex K Huffman tables: code counts per length 1 to 16, then the symbols in code order. */
export const JPEG_HUFFMAN = {
  dcLuma: { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], values: DC_VALUES },
  dcChroma: { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], values: DC_VALUES },
  acLuma: {
    bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
    values: [
      0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1,
      0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46,
      0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84,
      0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7,
      0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9,
      0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
    ],
  },
  acChroma: {
    bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
    values: [
      0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52,
      0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
      0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82,
      0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5,
      0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8,
      0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa,
    ],
  },
};

/** Canonical codes for a table: symbol -> { code, len }. */
function huffmanCodes({ bits, values }) {
  const codes = new Map();
  let code = 0;
  let k = 0;
  for (let len = 1; len <= 16; len++) {
    for (let i = 0; i < bits[len - 1]; i++) codes.set(values[k++], { code: code++, len });
    code <<= 1;
  }
  return codes;
}

/** A quantisation table scaled by quality, as libjpeg does (50 is the table as printed). */
function scaledTable(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? 5000 / q : 200 - 2 * q;
  return base.map((v) => Math.min(255, Math.max(1, Math.floor((v * scale + 50) / 100))));
}

/** Encodes an RGBA image (alpha ignored; flatten first) as a baseline JPEG. */
export function encodeJPEG({ width, height, data }, { quality = 90 } = {}) {
  const qt = [scaledTable(STD_LUMA_Q, quality), scaledTable(STD_CHROMA_Q, quality)];
  const dc = [huffmanCodes(JPEG_HUFFMAN.dcLuma), huffmanCodes(JPEG_HUFFMAN.dcChroma)];
  const ac = [huffmanCodes(JPEG_HUFFMAN.acLuma), huffmanCodes(JPEG_HUFFMAN.acChroma)];
  const out = [];
  const byte = (b) => out.push(b & 0xff);
  const word = (w) => {
    byte(w >> 8);
    byte(w);
  };

  word(0xffd8);
  word(0xffe0);
  word(16);
  for (const c of "JFIF") byte(c.charCodeAt(0));
  [0, 1, 1, 0, 0, 1, 0, 1, 0, 0].forEach(byte);
  word(0xffdb);
  word(2 + 2 * 65);
  for (let t = 0; t < 2; t++) {
    byte(t);
    for (let k = 0; k < 64; k++) byte(qt[t][ZIGZAG[k]]);
  }
  word(0xffc0);
  word(17);
  byte(8);
  word(height);
  word(width);
  byte(3);
  for (const [id, tq] of [[1, 0], [2, 1], [3, 1]]) {
    byte(id);
    byte(0x11);
    byte(tq);
  }
  const tables = [[0x00, JPEG_HUFFMAN.dcLuma], [0x10, JPEG_HUFFMAN.acLuma], [0x01, JPEG_HUFFMAN.dcChroma], [0x11, JPEG_HUFFMAN.acChroma]];
  word(0xffc4);
  word(2 + tables.reduce((t, [, h]) => t + 17 + h.values.length, 0));
  for (const [id, h] of tables) {
    byte(id);
    h.bits.forEach(byte);
    h.values.forEach(byte);
  }
  word(0xffda);
  word(12);
  [3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0].forEach(byte);

  // The entropy-coded scan, a bit at a time, with a zero stuffed after every 0xFF.
  let acc = 0;
  let nbits = 0;
  const put = (value, len) => {
    for (let i = len - 1; i >= 0; i--) {
      acc = (acc << 1) | ((value >> i) & 1);
      if (++nbits === 8) {
        out.push(acc);
        if (acc === 0xff) out.push(0);
        acc = 0;
        nbits = 0;
      }
    }
  };
  const category = (v) => {
    let a = Math.abs(v);
    let n = 0;
    while (a) {
      n++;
      a >>= 1;
    }
    return n;
  };
  const amplitude = (v, n) => (v < 0 ? v + (1 << n) - 1 : v);
  const planes = [new Float32Array(64), new Float32Array(64), new Float32Array(64)];
  const rows = new Float32Array(64);
  const coef = new Int32Array(64);
  const pred = [0, 0, 0];

  for (let by = 0; by < height; by += 8) {
    for (let bx = 0; bx < width; bx += 8) {
      for (let y = 0; y < 8; y++) {
        const sy = Math.min(height - 1, by + y);
        for (let x = 0; x < 8; x++) {
          const p = (sy * width + Math.min(width - 1, bx + x)) * 4;
          const r = data[p];
          const g = data[p + 1];
          const b = data[p + 2];
          planes[0][y * 8 + x] = 0.299 * r + 0.587 * g + 0.114 * b - 128;
          planes[1][y * 8 + x] = -0.168736 * r - 0.331264 * g + 0.5 * b;
          planes[2][y * 8 + x] = 0.5 * r - 0.418688 * g - 0.081312 * b;
        }
      }
      for (let c = 0; c < 3; c++) {
        const t = c ? 1 : 0;
        const s = planes[c];
        // Forward DCT on the decoder's basis: rows, then columns, then quantise.
        for (let y = 0; y < 8; y++) {
          for (let u = 0; u < 8; u++) {
            let sum = 0;
            for (let x = 0; x < 8; x++) sum += COS[u * 8 + x] * s[y * 8 + x];
            rows[y * 8 + u] = sum;
          }
        }
        for (let v = 0; v < 8; v++) {
          for (let u = 0; u < 8; u++) {
            let sum = 0;
            for (let y = 0; y < 8; y++) sum += COS[v * 8 + y] * rows[y * 8 + u];
            coef[v * 8 + u] = Math.round(sum / qt[t][v * 8 + u]);
          }
        }
        const diff = coef[0] - pred[c];
        pred[c] = coef[0];
        const dcCat = category(diff);
        const d = dc[t].get(dcCat);
        put(d.code, d.len);
        if (dcCat) put(amplitude(diff, dcCat), dcCat);
        let run = 0;
        for (let k = 1; k < 64; k++) {
          // Baseline AC sizes stop at 10 bits; only quality near 100 on extreme blocks reaches past it.
          const v = Math.max(-1023, Math.min(1023, coef[ZIGZAG[k]]));
          if (!v) {
            run++;
            continue;
          }
          while (run > 15) {
            const z = ac[t].get(0xf0);
            put(z.code, z.len);
            run -= 16;
          }
          const cat = category(v);
          const a = ac[t].get((run << 4) | cat);
          put(a.code, a.len);
          put(amplitude(v, cat), cat);
          run = 0;
        }
        if (run) {
          const e = ac[t].get(0x00);
          put(e.code, e.len);
        }
      }
    }
  }
  if (nbits) put((1 << (8 - nbits)) - 1, 8 - nbits);
  word(0xffd9);
  return Buffer.from(out);
}
