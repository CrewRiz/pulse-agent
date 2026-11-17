// A lossless packer for the agent's state, built for text like a ledger. It is a context-mixing coder: each byte is coded
// as eight binary decisions; six context orders (the last 0, 1, 2, 3, 4 and 6 bytes) each keep an adaptive probability per
// hashed context, a match model predicts the byte that followed the last occurrence of the current context, and an online
// logistic mixer combines them into one probability for an arithmetic coder. The model is rebuilt from the decoded bytes on
// both sides, so nothing but the coded stream is stored. Deterministic. The plaintext's SHA-256 travels in the header and is
// checked on unpack, so a damaged file, or a runtime whose arithmetic differs, fails loudly and never returns wrong bytes.
import { createHash } from "node:crypto";

const MAGIC = Buffer.from("PAZ1"), HEADER = 44;
const ORDERS = [0, 1, 2, 3, 4, 6], K = ORDERS.length, TBITS = 22, TSIZE = 1 << TBITS, LR = 0.02, MIN_MATCH = 6;
// stretch(p) = ln(p / (1 - p)) for a 16-bit probability, tabulated once
const STRETCH = new Float64Array(65536); for (let i = 0; i < 65536; i++) { const p = (i + 0.5) / 65537; STRETCH[i] = Math.log(p / (1 - p)); }
// one fixed random 64-bit symbol per byte value (as two 32-bit halves), plus one for the order's own role
const SYM_HI = new Uint32Array(257), SYM_LO = new Uint32Array(257);
{ let a = 0x54455854; const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (t ^ (t >>> 14)) >>> 0; }; for (let i = 0; i < 257; i++) { SYM_HI[i] = rnd(); SYM_LO[i] = rnd(); } }

function run(mode, data, n, stream) {                      // mode 0: encode data -> bytes; mode 1: decode stream -> data (filled in place)
  const P = Array.from({ length: K }, () => new Uint16Array(TSIZE).fill(32768));
  const W = new Float64Array(256 * (K + 1)).fill(0.3), MP = new Int32Array(16).fill(52428), MT = new Int32Array(TSIZE);
  const hHi = new Uint32Array(K), hLo = new Uint32Array(K), slot = new Int32Array(K), st = new Float64Array(K);
  let out = mode === 0 ? new Uint8Array(Math.max(64, n + (n >> 3) + 64)) : null, nbits = 0, pend = 0;
  const emit1 = (b) => { if ((nbits >> 3) >= out.length) { const g = new Uint8Array(out.length * 2); g.set(out); out = g; } if (b) out[nbits >> 3] |= 0x80 >> (nbits & 7); nbits++; };
  const emit = (b) => { emit1(b); for (; pend > 0; pend--) emit1(b ^ 1); };
  let rpos = 0; const rbit = () => { const i = rpos >> 3, b = i < stream.length ? (stream[i] >> (7 - (rpos & 7))) & 1 : 0; rpos++; return b; };
  let lo = 0, hi = 4294967295, val = 0, mptr = 0, mlen = 0;
  if (mode === 1) for (let i = 0; i < 32; i++) val = val * 2 + rbit();
  for (let t = 0; t < n; t++) {
    for (let k = 0; k < K; k++) {                            // the context key of each order: its role bound with the bytes behind, each rotated by its position
      let a = SYM_HI[256], b = (SYM_LO[256] ^ (ORDERS[k] + 1)) >>> 0;
      for (let i = 1; i <= ORDERS[k]; i++) {
        const v = t - i >= 0 ? data[t - i] : 0, r = (11 * i) & 63; let x = SYM_HI[v], y = SYM_LO[v];
        if (r >= 32) { const s = x; x = y; y = s; } const q = r & 31;
        if (q) { const nx = ((x << q) | (y >>> (32 - q))) >>> 0; y = ((y << q) | (x >>> (32 - q))) >>> 0; x = nx; }
        a = (a ^ x) >>> 0; b = (b ^ y) >>> 0;
      }
      hHi[k] = a; hLo[k] = b;
    }
    let node = 1, mbad = false; const eb = mptr > 0 ? data[mptr] : -1;
    for (let j = 7; j >= 0; j--) {
      let dot = 0, mst = 0; const wb = node * (K + 1);
      if (eb >= 0 && !mbad) { mst = STRETCH[MP[mlen < 15 ? mlen : 15]] * ((eb >> j) & 1 ? 1 : -1); dot += W[wb + K] * mst; }
      for (let k = 0; k < K; k++) {
        let m = Math.imul(hLo[k] ^ Math.imul(node, 0x9e3779b1), 0x85ebca6b) ^ Math.imul(hHi[k] ^ Math.imul(node, 0xc2b2ae35), 0x27d4eb2f);
        m ^= m >>> 15; m = Math.imul(m, 0x165667b1); m ^= m >>> 13;
        const s = (m >>> (32 - TBITS)); slot[k] = s; st[k] = STRETCH[P[k][s]]; dot += W[wb + k] * st[k];
      }
      const pm = 1 / (1 + Math.exp(-dot)); let f1 = Math.floor(pm * 4096); f1 = f1 < 1 ? 1 : f1 > 4095 ? 4095 : f1;
      const rng = hi - lo + 1, cut = Math.floor(rng * f1 / 4096); let bit;
      if (mode === 1) bit = Math.floor(((val - lo + 1) * 4096 - 1) / rng) < f1 ? 1 : 0; else bit = (data[t] >> j) & 1;
      if (bit) hi = lo + cut - 1; else lo = lo + cut;
      for (;;) {
        if (hi < 2147483648) { if (mode === 0) emit(0); }
        else if (lo >= 2147483648) { if (mode === 0) emit(1); lo -= 2147483648; hi -= 2147483648; val -= 2147483648; }
        else if (lo >= 1073741824 && hi < 3221225472) { pend++; lo -= 1073741824; hi -= 1073741824; val -= 1073741824; }
        else break;
        lo = lo * 2; hi = hi * 2 + 1; if (mode === 1) val = val * 2 + rbit();
      }
      const err = bit - pm;
      for (let k = 0; k < K; k++) { W[wb + k] += LR * err * st[k]; const p = P[k][slot[k]]; P[k][slot[k]] = p + (((bit << 16) - p) >> 4); }
      if (eb >= 0 && !mbad) { W[wb + K] += LR * err * mst; const ok = bit === ((eb >> j) & 1) ? 1 : 0, ml = mlen < 15 ? mlen : 15; MP[ml] += ((ok << 16) - MP[ml]) >> 5; if (!ok) mbad = true; }
      node = node * 2 + bit;
    }
    const v = node - 256; if (mode === 1) data[t] = v;
    if (mptr > 0 && eb === v) { mlen++; mptr++; } else { mlen = 0; mptr = 0; }
    if (t + 1 >= MIN_MATCH) {                                 // where did these last six bytes occur before? predict what followed them
      let h = 0x811c9dc5; for (let i = 0; i < MIN_MATCH; i++) h = Math.imul(h ^ data[t - i], 0x01000193);
      const hk = (h ^ (h >>> 15)) >>> (32 - TBITS);
      if (mlen === 0) { const cand = MT[hk]; if (cand > 0) { let L = 0; while (L < 32 && cand - 1 - L >= 0 && data[cand - 1 - L] === data[t - L]) L++; if (L >= MIN_MATCH) { mptr = cand; mlen = L; } } }
      MT[hk] = t + 1;
    }
  }
  if (mode === 0) { pend++; emit(lo < 1073741824 ? 0 : 1); return out.subarray(0, (nbits + 7) >> 3); }
  return data;
}

/** Buffer -> packed Buffer */
export function pack(input) {
  const data = Buffer.isBuffer(input) ? input : Buffer.from(input), n = data.length;
  const head = Buffer.alloc(HEADER); MAGIC.copy(head, 0); head.writeUInt32LE(n >>> 0, 4); head.writeUInt32LE(Math.floor(n / 4294967296), 8);
  createHash("sha256").update(data).digest().copy(head, 12);
  return Buffer.concat([head, run(0, data, n, null)]);
}

/** packed Buffer -> the original Buffer; throws when the file is not one, or does not decode to the bytes it was made from */
export function unpack(packed) {
  const buf = Buffer.isBuffer(packed) ? packed : Buffer.from(packed);
  if (buf.length < HEADER || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("not a pulse-agent packed file");
  const n = buf.readUInt32LE(4) + buf.readUInt32LE(8) * 4294967296, stream = buf.subarray(HEADER);
  if (n > 2 ** 31 || n > 1048576 + stream.length * 20000) throw new Error("corrupt packed file: the stated length cannot be right");
  const out = run(1, Buffer.alloc(n), n, stream);
  if (!createHash("sha256").update(out).digest().equals(buf.subarray(12, 44))) throw new Error("the packed file does not match the bytes it was made from (corrupt, truncated, or packed by a runtime whose arithmetic differs)");
  return out;
}
