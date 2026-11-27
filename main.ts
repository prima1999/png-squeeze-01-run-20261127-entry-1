// A lossless PNG squeezer for 1280x720 RGBA screenshots.
//
// Own design: decode the input PNG, pick the smallest-lossless colour
// form per image (palette, grey, grey+alpha, RGB, RGBA, or a single
// transparent key), choose each row's filter by the minimum signed-sum
// heuristic, then compress with a from-scratch optimal-parsing DEFLATE
// encoder (hash-chain lazy matching plus length-limited dynamic Huffman
// blocks) and keep whichever of that stream or zlib level 9 is smaller.
// Everything is deterministic: fixed work budgets, no clock, no
// environment, no files outside the input and output directories.
import { inflateSync, deflateSync } from 'node:zlib';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const W = 1280;
const H = 720;

// ---------- checksums ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes, start, end) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------- PNG decode ----------

function paethPredict(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

const CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function decodePng(bytes) {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('bad PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colourType = 6;
  let palette = null;
  let trns = null;
  const idatParts = [];
  while (at < bytes.length) {
    const len = view.getUint32(at);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (type === 'IHDR') {
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      width = dv.getUint32(0);
      height = dv.getUint32(4);
      colourType = data[9];
    } else if (type === 'PLTE') {
      palette = data;
    } else if (type === 'tRNS') {
      trns = data;
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const raw = inflateSync(Buffer.concat(idatParts));
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) {
      samples.set(raw.subarray(src, src + stride), o);
    } else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) {
        samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
      }
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paethPredict(a, b, c);
      }
    }
  }
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) {
    rgba.set(samples);
  } else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = g;
      rgba[d + 1] = g;
      rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s];
      rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { rgba, width, height };
}

// ---------- image analysis ----------

function analyse(rgba) {
  const n = rgba.length >>> 2;
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const r = rgba[d];
    const g = rgba[d + 1];
    const b = rgba[d + 2];
    const a = rgba[d + 3];
    if (a !== 255) opaque = false;
    if (r !== g || r !== b) grey = false;
    if (!many) {
      const key = (r << 24) | (g << 16) | (b << 8) | a;
      const k = counts.get(key);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(key, 1);
      } else {
        counts.set(key, k + 1);
      }
    }
  }
  const colours = many ? null : [...counts.entries()].map(([key, count]) => ({
    r: (key >>> 24) & 255,
    g: (key >>> 16) & 255,
    b: (key >>> 8) & 255,
    a: key & 255,
    word: key,
    count,
  }));
  return { opaque, grey, colours };
}

function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) {
      out[s] = rgba[d];
    } else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

function paletteForm(rgba, colours, order) {
  const lum = (c) => 299 * c.r + 587 * c.g + 114 * c.b;
  const entries = [...colours].sort((x, y) => {
    const tx = x.a === 255 ? 1 : 0;
    const ty = y.a === 255 ? 1 : 0;
    if (tx !== ty) return tx - ty;
    if (tx === 0 && x.a !== y.a) return x.a - y.a;
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.r;
    plte[i * 3 + 1] = c.g;
    plte[i * 3 + 2] = c.b;
    if (c.a !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.a);
  const n = rgba.length >>> 2;
  const indices = new Uint8Array(n);
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    const key = (rgba[d] << 24) | (rgba[d + 1] << 16) | (rgba[d + 2] << 8) | rgba[d + 3];
    indices[i] = index.get(key);
  }
  return { colourType: 3, bpp: 1, samples: indices, plte, trns };
}

function channelForm(rgba, grey, opaque) {
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  return { colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns };
}

function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    forms.push(paletteForm(rgba, colours, 'count'));
    forms.push(paletteForm(rgba, colours, 'luminance'));
    if (!grey) return forms;
  }
  forms.push(channelForm(rgba, grey, opaque));
  return forms;
}

// ---------- filtering ----------

function filterRowInto(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) {
    out.set(cur);
  } else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) {
      out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
    }
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paethPredict(a, b, c);
    }
  }
}

function filterFixed(samples, width, height, bpp, type) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    raw[at] = type;
    filterRowInto(type, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
  }
  return raw;
}

function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

function filterPairs(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) trials.push(new Uint8Array(stride));
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let bestType = 0;
    let bestScore = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t]);
      const s = pairsOf(trials[t], seen, ++stamp);
      if (s < bestScore) {
        bestScore = s;
        bestType = t;
      }
    }
    const at = y * (stride + 1);
    raw[at] = bestType;
    raw.set(trials[bestType], at + 1);
  }
  return raw;
}

function filterBrute(samples, width, height, bpp) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trials = [];
  for (let t = 0; t < 5; t++) {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    trials.push(row);
  }
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    const before = raw.subarray(Math.max(0, at - 32768), at);
    let bestType = 0;
    let bestSize = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRowInto(t, cur, prev, bpp, trials[t].subarray(1));
      const opts = before.length === 0 ? { level: 4, memLevel: 9 } : { level: 4, memLevel: 9, dictionary: before };
      const size = deflateSync(trials[t], opts).length;
      if (size < bestSize) {
        bestSize = size;
        bestType = t;
      }
    }
    raw.set(trials[bestType], at);
  }
  return raw;
}

// ---------- DEFLATE: length-limited Huffman ----------

const LEN_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

function lenCodeOf(len) {
  for (let i = 28; i >= 0; i--) if (len >= LEN_BASE[i]) return i;
  return 0;
}

function distCodeOf(dist) {
  for (let i = 29; i >= 0; i--) if (dist >= DIST_BASE[i]) return i;
  return 0;
}

// Length-limited Huffman code lengths from symbol frequencies.
// Builds a plain Huffman tree, then repairs any over-long code with the
// classic overflow redistribution and reassigns lengths by frequency.
function huffLengths(freq, maxLen) {
  const n = freq.length;
  const len = new Uint8Array(n);
  const syms = [];
  for (let i = 0; i < n; i++) if (freq[i] > 0) syms.push(i);
  if (syms.length === 0) return len;
  if (syms.length === 1) {
    len[syms[0]] = 1;
    return len;
  }
  // Binary heap of tree nodes, smallest frequency first.
  const heapFreq = [];
  const heapNode = [];
  const nodes = [];
  function heapPush(f, node) {
    heapFreq.push(f);
    heapNode.push(node);
    let i = heapFreq.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heapFreq[p] <= heapFreq[i]) break;
      const tf = heapFreq[p];
      heapFreq[p] = heapFreq[i];
      heapFreq[i] = tf;
      const tn = heapNode[p];
      heapNode[p] = heapNode[i];
      heapNode[i] = tn;
      i = p;
    }
  }
  function heapPop() {
    const topF = heapFreq[0];
    const topN = heapNode[0];
    const lastF = heapFreq.pop();
    const lastN = heapNode.pop();
    if (heapFreq.length > 0) {
      heapFreq[0] = lastF;
      heapNode[0] = lastN;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heapFreq.length && heapFreq[l] < heapFreq[m]) m = l;
        if (r < heapFreq.length && heapFreq[r] < heapFreq[m]) m = r;
        if (m === i) break;
        const tf = heapFreq[m];
        heapFreq[m] = heapFreq[i];
        heapFreq[i] = tf;
        const tn = heapNode[m];
        heapNode[m] = heapNode[i];
        heapNode[i] = tn;
        i = m;
      }
    }
    return [topF, topN];
  }
  const ordered = [...syms].sort((a, b) => freq[a] - freq[b] || a - b);
  for (const s of ordered) {
    nodes.push({ sym: s, left: -1, right: -1 });
    heapPush(freq[s], nodes.length - 1);
  }
  while (heapFreq.length > 1) {
    const [f1, n1] = heapPop();
    const [f2, n2] = heapPop();
    nodes.push({ sym: -1, left: n1, right: n2 });
    heapPush(f1 + f2, nodes.length - 1);
  }
  const root = heapNode[0];
  const depth = new Uint8Array(nodes.length);
  const stack = [root];
  depth[root] = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    const nd = nodes[node];
    if (nd.sym >= 0) {
      len[nd.sym] = depth[node];
    } else {
      depth[nd.left] = depth[node] + 1;
      depth[nd.right] = depth[node] + 1;
      stack.push(nd.left);
      stack.push(nd.right);
    }
  }
  const blCount = new Int32Array(maxLen + 2);
  let overflow = 0;
  for (const s of syms) {
    const l = len[s];
    if (l > maxLen) {
      overflow++;
      blCount[maxLen]++;
    } else {
      blCount[l]++;
    }
  }
  if (overflow > 0) {
    do {
      let bits = maxLen - 1;
      while (blCount[bits] === 0) bits--;
      blCount[bits] -= 1;
      blCount[bits + 1] += 2;
      blCount[maxLen] -= 1;
      overflow -= 2;
    } while (overflow > 0);
    const byFreq = [...syms].sort((a, b) => freq[b] - freq[a] || a - b);
    let idx = 0;
    for (let bits = 1; bits <= maxLen; bits++) {
      for (let k = 0; k < blCount[bits]; k++) len[byFreq[idx++]] = bits;
    }
  }
  return len;
}

function canonicalCodes(len) {
  const n = len.length;
  const maxLen = Math.max(0, ...len);
  const count = new Int32Array(maxLen + 1);
  for (let i = 0; i < n; i++) count[len[i]]++;
  count[0] = 0;
  const next = new Int32Array(maxLen + 1);
  let code = 0;
  for (let bits = 1; bits <= maxLen; bits++) {
    code = (code + count[bits - 1]) << 1;
    next[bits] = code;
  }
  const codes = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (len[i] !== 0) codes[i] = next[len[i]]++;
  }
  return codes;
}

// ---------- DEFLATE: bit writer ----------

class BitWriter {
  constructor() {
    this.bytes = [];
    this.bitBuf = 0;
    this.bitCnt = 0;
  }
  writeBits(value, count) {
    this.bitBuf |= (value & ((1 << count) - 1)) << this.bitCnt;
    this.bitCnt += count;
    while (this.bitCnt >= 8) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf >>>= 8;
      this.bitCnt -= 8;
    }
  }
  writeCode(code, len) {
    // Canonical Huffman codes are written most-significant-bit first.
    let reversed = 0;
    for (let i = 0; i < len; i++) {
      reversed = (reversed << 1) | ((code >>> i) & 1);
    }
    this.writeBits(reversed, len);
  }
  alignByte() {
    if (this.bitCnt > 0) {
      this.bytes.push(this.bitBuf & 0xff);
      this.bitBuf = 0;
      this.bitCnt = 0;
    }
  }
  streamBits() {
    return this.bytes.length * 8 + this.bitCnt;
  }
  writeStoredBlock(data, isFinal) {
    this.alignByte();
    this.bytes.push(isFinal ? 1 : 0);
    const len = data.length;
    this.bytes.push(len & 0xff, (len >>> 8) & 0xff, (~len) & 0xff, ((~len) >>> 8) & 0xff);
    for (let i = 0; i < len; i++) this.bytes.push(data[i]);
  }
  finish() {
    this.alignByte();
    return Uint8Array.from(this.bytes);
  }
}

// ---------- DEFLATE: LZ77 optimal-ish parsing ----------

const BLOCK = 262144;
const MAX_CHAIN = 512;

function hash3(d, p) {
  const x = (d[p] << 16) ^ (d[p + 1] << 8) ^ d[p + 2];
  return (Math.imul(x, 2654435761) >>> 17) & 32767;
}

// Parse one block into literal/length symbols and distances, counting
// frequencies. Returns { syms, dists, count, litFreq, distFreq }.
function parseBlock(d, start) {
  const n = d.length;
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const head = new Int32Array(32768).fill(-1);
  const prev = new Int32Array(n).fill(-1);
  const syms = new Int32Array(n + 1);
  const dists = new Int32Array(n + 1);
  const lens = new Int32Array(n + 1);
  const litFreq = new Int32Array(286);
  const distFreq = new Int32Array(30);
  let count = 0;
  function insertPos(p) {
    const h = hash3(d, p);
    prev[p] = head[h];
    head[h] = p;
  }
  function findMatch(p, maxLen) {
    let bestLen = 2;
    let bestDist = 0;
    if (p + 2 >= n) return [0, 0];
    const h = hash3(d, p);
    let cand = head[h];
    let tries = 0;
    const limit = Math.min(maxLen, n - p);
    while (cand >= 0 && tries < MAX_CHAIN) {
      const dist = p - cand;
      if (dist > 32768) break;
      if (d[cand + bestLen] === d[p + bestLen] && d[cand] === d[p]) {
        let len = 0;
        const end = p + limit;
        let a = p;
        let b = cand;
        while (a + 4 <= end && dv.getUint32(a, true) === dv.getUint32(b, true)) {
          a += 4;
          b += 4;
        }
        while (a < end && d[a] === d[b]) {
          a++;
          b++;
        }
        len = a - p;
        if (len > bestLen) {
          bestLen = len;
          bestDist = dist;
          if (len >= 64) break;
        }
      }
      cand = prev[cand];
      tries++;
    }
    if (bestLen < 3) return [0, 0];
    return [bestLen, bestDist];
  }
  let p = 0;
  while (p < n) {
    if (p < start) {
      if (p + 2 < n) insertPos(p);
      p++;
      continue;
    }
    if (p + 2 >= n) {
      syms[count] = d[p];
      dists[count] = 0;
      litFreq[d[p]]++;
      count++;
      p++;
      continue;
    }
    let [len1, dist1] = findMatch(p, 258);
    insertPos(p);
    if (len1 >= 3 && len1 < 32 && p + 3 < n) {
      const [len2] = findMatch(p + 1, 258);
      if (len2 > len1) {
        syms[count] = d[p];
        dists[count] = 0;
        litFreq[d[p]]++;
        count++;
        p++;
        continue;
      }
    }
    if (len1 >= 3) {
      const lc = lenCodeOf(len1);
      syms[count] = 257 + lc;
      dists[count] = dist1;
      lens[count] = len1;
      litFreq[257 + lc]++;
      distFreq[distCodeOf(dist1)]++;
      count++;
      for (let j = 1; j < len1; j++) {
        if (p + j + 2 < n) insertPos(p + j);
      }
      p += len1;
    } else {
      syms[count] = d[p];
      dists[count] = 0;
      litFreq[d[p]]++;
      count++;
      p++;
    }
  }
  syms[count] = 256;
  dists[count] = 0;
  lens[count] = 0;
  litFreq[256]++;
  count++;
  return { syms, dists, lens, count, litFreq, distFreq };
}

// Encode one parsed block as a dynamic-Huffman DEFLATE block, with each
// match's real length carried in the token stream's side array.
function encodeBlockWithLengths(parsed, writer, isFinal) {
  const { syms, dists, count, litFreq, distFreq, lens } = parsed;
  const litLen = huffLengths(litFreq, 15);
  if (distFreq.every((f) => f === 0)) {
    distFreq[0] = 1;
    distFreq[1] = 1;
  }
  const distLen = huffLengths(distFreq, 15);
  let litCount = 286;
  while (litCount > 257 && litLen[litCount - 1] === 0) litCount--;
  let distCount = 30;
  while (distCount > 1 && distLen[distCount - 1] === 0) distCount--;
  const seq = new Uint8Array(litCount + distCount);
  seq.set(litLen.subarray(0, litCount), 0);
  seq.set(distLen.subarray(0, distCount), litCount);
  const clFreq = new Int32Array(19);
  const items = [];
  let i = 0;
  while (i < seq.length) {
    const v = seq[i];
    let run = 1;
    while (i + run < seq.length && seq[i + run] === v) run++;
    if (v === 0) {
      let left = run;
      while (left >= 11) {
        const take = Math.min(left, 138);
        items.push([18, take - 11]);
        clFreq[18]++;
        left -= take;
      }
      if (left >= 3) {
        items.push([17, left - 3]);
        clFreq[17]++;
        left = 0;
      }
      while (left > 0) {
        items.push([0, 0]);
        clFreq[0]++;
        left--;
      }
    } else {
      items.push([v, 0]);
      clFreq[v]++;
      let left = run - 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        items.push([16, take - 3]);
        clFreq[16]++;
        left -= take;
      }
      while (left > 0) {
        items.push([v, 0]);
        clFreq[v]++;
        left--;
      }
    }
    i += run;
  }
  const clLen = huffLengths(clFreq, 7);
  if (clLen.filter((l) => l > 0).length === 1) {
    let only = -1;
    for (let k = 0; k < 19; k++) if (clLen[k] > 0) only = k;
    clLen[only] = 1;
    clLen[only === 0 ? 1 : 0] = 1;
  }
  const clCode = canonicalCodes(clLen);
  const litCode = canonicalCodes(litLen);
  const distCode = canonicalCodes(distLen);
  const ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
  let hclen = 19;
  while (hclen > 4 && clLen[ORDER[hclen - 1]] === 0) hclen--;
  writer.writeBits(isFinal ? 1 : 0, 1);
  writer.writeBits(2, 2);
  writer.writeBits(litCount - 257, 5);
  writer.writeBits(distCount - 1, 5);
  writer.writeBits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) writer.writeBits(clLen[ORDER[k]], 3);
  for (const [sym, extra] of items) {
    writer.writeCode(clCode[sym], clLen[sym]);
    if (sym === 16) writer.writeBits(extra, 2);
    else if (sym === 17) writer.writeBits(extra, 3);
    else if (sym === 18) writer.writeBits(extra, 7);
  }
  for (let k = 0; k < count; k++) {
    const s = syms[k];
    if (s <= 256) {
      writer.writeCode(litCode[s], litLen[s]);
    } else {
      const lc = s - 257;
      writer.writeCode(litCode[s], litLen[s]);
      const matchLen = lens[k];
      writer.writeBits(matchLen - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dist = dists[k];
      const dc = distCodeOf(dist);
      writer.writeCode(distCode[dc], distLen[dc]);
      writer.writeBits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
}

// Encode one parsed block with the fixed Huffman codes: often smaller
// than a dynamic block when the symbols are spread evenly, as in
// photo-like patches, because it pays no code-length header.
function encodeBlockFixed(parsed, writer, isFinal) {
  const litLen = new Uint8Array(288);
  for (let i = 0; i < 144; i++) litLen[i] = 8;
  for (let i = 144; i < 256; i++) litLen[i] = 9;
  for (let i = 256; i < 280; i++) litLen[i] = 7;
  for (let i = 280; i < 288; i++) litLen[i] = 8;
  const litCode = canonicalCodes(litLen);
  const { syms, dists, lens, count } = parsed;
  writer.writeBits(isFinal ? 1 : 0, 1);
  writer.writeBits(1, 2);
  for (let k = 0; k < count; k++) {
    const s = syms[k];
    if (s <= 256) {
      writer.writeCode(litCode[s], litLen[s]);
    } else {
      const lc = s - 257;
      writer.writeCode(litCode[s], litLen[s]);
      writer.writeBits(lens[k] - LEN_BASE[lc], LEN_EXTRA[lc]);
      const dist = dists[k];
      const dc = distCodeOf(dist);
      writer.writeCode(dc, 5);
      writer.writeBits(dist - DIST_BASE[dc], DIST_EXTRA[dc]);
    }
  }
}

// Compress raw filtered bytes into a zlib stream with the own encoder.
function deflateOwn(raw) {
  const writer = new BitWriter();
  const blocks = Math.max(1, Math.ceil(raw.length / BLOCK));
  for (let b = 0; b < blocks; b++) {
    const from = b * BLOCK;
    const block = raw.subarray(from, Math.min(raw.length, from + BLOCK));
    const winFrom = Math.max(0, from - 32768);
    const copy = new Uint8Array(raw.subarray(winFrom, Math.min(raw.length, from + BLOCK)));
    const parsed = parseBlock(copy, from - winFrom);
    const isFinal = b === blocks - 1;
    const dynTrial = new BitWriter();
    encodeBlockWithLengths(parsed, dynTrial, isFinal);
    const dynBits = dynTrial.streamBits();
    const fixTrial = new BitWriter();
    encodeBlockFixed(parsed, fixTrial, isFinal);
    const fixBits = fixTrial.streamBits();
    const cur = writer.streamBits();
    const pad = (8 - (cur % 8)) % 8;
    const storedBits = pad + 8 + 32 + block.length * 8;
    if (storedBits <= dynBits && storedBits <= fixBits) {
      writer.writeStoredBlock(block, isFinal);
    } else if (fixBits < dynBits) {
      encodeBlockFixed(parsed, writer, isFinal);
    } else {
      encodeBlockWithLengths(parsed, writer, isFinal);
    }
  }
  const body = writer.finish();
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0x9c;
  out.set(body, 2);
  new DataView(out.buffer).setUint32(2 + body.length, adler32(raw));
  return out;
}

// ---------- PNG encode ----------

function pngOf(chunks) {
  let size = 8;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set([137, 80, 78, 71, 13, 10, 26, 10], 0);
  let at = 8;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    for (let i = 0; i < 4; i++) out[at + 4 + i] = type.charCodeAt(i);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

function encodeImage(rgba, width, height) {
  let bestTotal = Infinity;
  let bestRaw = null;
  let bestForm = null;
  let bestZlib = null;
  for (const form of formsOf(rgba)) {
    const overhead = 57 + (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    const variants = form.colourType === 3
      ? [filterFixed(form.samples, width, height, form.bpp, 0), filterBrute(form.samples, width, height, form.bpp)]
      : [filterFixed(form.samples, width, height, form.bpp, 0), filterFixed(form.samples, width, height, form.bpp, 1), filterFixed(form.samples, width, height, form.bpp, 2), filterFixed(form.samples, width, height, form.bpp, 4), filterPairs(form.samples, width, height, form.bpp), filterBrute(form.samples, width, height, form.bpp)];
    for (const raw of variants) {
      const zlibbed = deflateSync(raw, { level: 9, memLevel: 9 });
      const total = zlibbed.length + overhead;
      if (total < bestTotal) {
        bestTotal = total;
        bestRaw = raw;
        bestForm = form;
        bestZlib = zlibbed;
      }
    }
  }
  const own = deflateOwn(bestRaw);
  const stream = own.length <= bestZlib.length ? own : new Uint8Array(bestZlib.buffer, bestZlib.byteOffset, bestZlib.length);
  const chunks = [['IHDR', ihdrOf(width, height, bestForm.colourType)]];
  if (bestForm.plte !== null) chunks.push(['PLTE', bestForm.plte]);
  if (bestForm.trns !== null) chunks.push(['tRNS', bestForm.trns]);
  chunks.push(['IDAT', stream]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

// ---------- main ----------

for (const id of readdirSync(IN_DIR).sort()) {
  const bytes = new Uint8Array(readFileSync(join(IN_DIR, id, 'image.png')));
  const { rgba, width, height } = decodePng(bytes);
  const png = encodeImage(rgba, width, height);
  mkdirSync(join(OUT_DIR, id), { recursive: true });
  writeFileSync(join(OUT_DIR, id, 'image.png'), png);
}
