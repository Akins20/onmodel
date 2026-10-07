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
