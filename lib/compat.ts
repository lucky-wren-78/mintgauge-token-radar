// Compatibility layer: the numeric pieces of the Python/NumPy prototype
// (model/fit-v1.py + entry/build-board.py) reproduced exactly in TypeScript,
// so the board this program writes is byte-identical to the validated
// prototype board. Every piece below was verified against NumPy 1.26 /
// CPython reference outputs:
//
//   - SeedSequence pool mixing and generate_state (hashmix/mix, INIT/MULT
//     constants) — matches SeedSequence(20261114).pool and its word stream.
//   - PCG64 seeding (O'Neill's srandom_r: inc = (initseq << 1) | 1, state
//     stepped, += initstate, stepped) and the XSL-RR 128/64 output — matches
//     PCG64(20261114).state and .random_raw.
//   - Generator.integers for ranges that fit in 32 bits: Lemire's method over
//     a buffered next_uint32 stream (low half of each uint64 first) — matches
//     25,600 draws of default_rng(20261115).integers(0, 128) by SHA-256.
//   - Generator.permutation: backward Fisher-Yates with mask-rejection
//     bounded uint32 draws — matches default_rng(20261114).permutation(128).
//   - np.mean's pairwise summation, np.quantile/np.percentile's linear
//     interpolation, CPython's round-half-even (via exact BigInt decimal
//     arithmetic), f-string fixed-point formatting, float repr, and
//     json.dump(indent=1, ensure_ascii=False) serialisation.

// ---------------------------------------------------------------- SeedSequence + PCG64

const INIT_A = 0x43b0d7e5, MULT_A = 0x931e8875;
const INIT_B = 0x8b51f9dd, MULT_B = 0x58f38ded;
const MIX_MULT_L = 0xca01f9dd, MIX_MULT_R = 0x4973f715;

const u32 = (x: number): number => x >>> 0;

/** numpy's hashmix: value hashed against an evolving constant. */
function makeHashmix(mult: number): (value: number, hc: { v: number }) => number {
  return (value, hc) => {
    value = u32(value ^ hc.v);
    hc.v = Math.imul(hc.v, mult);
    value = Math.imul(value, hc.v);
    return u32(value ^ (value >>> 16));
  };
}

/** numpy's mix: combine two words with an avalanche step. */
function mixWords(x: number, y: number): number {
  const r = u32(Math.imul(MIX_MULT_L, x) - Math.imul(MIX_MULT_R, y));
  return u32(r ^ (r >>> 16));
}

/** SeedSequence(seed).generate_state(nWords, uint64) for a single-word seed. */
export function seedSequenceU64(seed: number, nWords: number): bigint[] {
  const hashmixA = makeHashmix(MULT_A);
  const hc = { v: INIT_A };
  const pool: number[] = [];
  for (let i = 0; i < 4; i++) pool.push(hashmixA(i === 0 ? seed : 0, hc));
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      if (i !== j) pool[j] = mixWords(pool[j], hashmixA(pool[i], hc));
    }
  }
  const hashmixB = makeHashmix(MULT_B);
  const hcB = { v: INIT_B };
  const w32: number[] = [];
  for (let i = 0; i < nWords * 2; i++) w32.push(hashmixB(pool[i % 4], hcB));
  const out: bigint[] = [];
  for (let i = 0; i < nWords; i++) out.push(BigInt(w32[2 * i]!) + (BigInt(w32[2 * i + 1]!) << 32n));
  return out;
}

const MASK64 = (1n << 64n) - 1n;
const MASK128 = (1n << 128n) - 1n;
const PCG_MULT = 0x2360ed051fc65da44385df649fccf645n;

function rotr64(x: bigint, r: bigint): bigint {
  r &= 63n;
  return ((x >> r) | (x << ((64n - r) & 63n))) & MASK64;
}

/** NumPy's PCG64 bit generator with its SeedSequence seeding procedure. */
export class BitGen {
  private state: bigint;
  private readonly inc: bigint;
  private has32 = false;
  private buf32 = 0;

  constructor(seed: number) {
    const w = seedSequenceU64(seed, 4);
    const initstate = ((w[0]! << 64n) | w[1]!) & MASK128;
    const initseq = ((w[2]! << 64n) | w[3]!) & MASK128;
    this.inc = ((initseq << 1n) | 1n) & MASK128;
    this.state = 0n;
    this.step();
    this.state = (this.state + initstate) & MASK128;
    this.step();
  }

  private step(): void {
    this.state = (this.state * PCG_MULT + this.inc) & MASK128;
  }

  /** The next raw uint64 (XSL-RR output of the stepped state). */
  next64(): bigint {
    this.step();
    return rotr64((this.state >> 64n) ^ (this.state & MASK64), this.state >> 122n);
  }

  /** The next uint32: halves of each uint64, low half first, high buffered. */
  next32(): number {
    if (this.has32) {
      this.has32 = false;
      return this.buf32;
    }
    const v = this.next64();
    this.buf32 = Number(v >> 32n);
    this.has32 = true;
    return Number(v & 0xffffffffn);
  }

  /** A draw in [0, range) by Lemire's 32-bit method (Generator.integers). */
  lemire32(range: number): number {
    let x = this.next32();
    let m = BigInt(x) * BigInt(range);
    let l = Number(m & 0xffffffffn);
    if (l < range) {
      const t = ((1n << 32n) - BigInt(range)) % BigInt(range);
      while (BigInt(l) < t) {
        x = this.next32();
        m = BigInt(x) * BigInt(range);
        l = Number(m & 0xffffffffn);
      }
    }
    return Number(m >> 32n);
  }

  /** A draw in [0, range) by mask rejection (the bounded draw shuffle uses). */
  mask32(range: number): number {
    let msk = range - 1;
    msk |= msk >> 1;
    msk |= msk >> 2;
    msk |= msk >> 4;
    msk |= msk >> 8;
    msk |= msk >> 16;
    for (;;) {
      const v = this.next32() & msk;
      if (v < range) return v;
    }
  }

  /** `count` successive integers in [0, range), Generator.integers style. */
  integers32(range: number, count: number): number[] {
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(this.lemire32(range));
    return out;
  }

  /** Generator.permutation(n): arange shuffled by backward Fisher-Yates. */
  permutation(n: number): number[] {
    const a = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = this.mask32(i + 1);
      const tmp = a[i]!;
      a[i] = a[j]!;
      a[j] = tmp;
    }
    return a;
  }
}

// ---------------------------------------------------------------- NumPy reductions

/** numpy's pairwise summation (the algorithm np.sum/np.mean reduce with). */
export function pairwiseSum(a: number[]): number {
  const n = a.length;
  if (n < 8) {
    let r = 0;
    for (let i = 0; i < n; i++) r += a[i]!;
    return r;
  }
  if (n <= 128) {
    const r = a.slice(0, 8);
    let i = 8;
    const stop = n - (n % 8);
    for (; i < stop; i += 8) {
      for (let k = 0; k < 8; k++) r[k] = r[k]! + a[i + k]!;
    }
    let res = ((r[0]! + r[1]!) + (r[2]! + r[3]!)) + ((r[4]! + r[5]!) + (r[6]! + r[7]!));
    for (; i < n; i++) res += a[i]!;
    return res;
  }
  // Beyond numpy's unrolled block it recurses on 128-wide blocks; the model
  // never sums more than 128 values, so a blocked equivalent suffices here.
  let total = 0;
  for (let at = 0; at < n; at += 128) total += pairwiseSum(a.slice(at, at + 128));
  return total;
}

/** np.mean over a small array: pairwise sum divided by the count. */
export function npMean(a: number[]): number {
  return pairwiseSum(a) / a.length;
}

/** numpy's interpolation between two sorted neighbours. */
function npLerp(a: number, b: number, t: number): number {
  const diff = b - a;
  return t < 0.5 ? a + diff * t : b - diff * (1 - t);
}

/** np.quantile with the default linear method. */
export function npQuantile(values: number[], q: number): number {
  const s = [...values].sort((x, y) => x - y);
  const n = s.length;
  if (n === 1) return s[0]!;
  const idx = q * (n - 1);
  const lo = Math.floor(idx);
  if (lo + 1 >= n) return s[lo]!;
  return npLerp(s[lo]!, s[lo + 1]!, idx - lo);
}

/** np.percentile with the default linear method. */
export function npPercentile(values: number[], p: number): number {
  return npQuantile(values, p / 100);
}

// ---------------------------------------------------------------- CPython rounding & formatting

const f64view = new DataView(new ArrayBuffer(8));

/** Decompose a finite double: value = (neg ? -1 : 1) * m * 2^e, m a BigInt. */
function decompose(x: number): { neg: boolean; m: bigint; e: number } {
  f64view.setFloat64(0, x);
  const hi = f64view.getUint32(0);
  const lo = f64view.getUint32(4);
  const neg = (hi >>> 31) !== 0;
  const expField = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (expField === 0) return { neg, m: frac, e: -1074 };
  return { neg, m: frac | (1n << 52n), e: expField - 1075 };
}

/** round(|x| * 10^digits) to a BigInt, ties to even, on the exact binary value. */
function roundScaled(x: number, digits: number): { neg: boolean; q: bigint } {
  const { neg, m, e } = decompose(x);
  const num = m * 10n ** BigInt(digits);
  if (e >= 0) return { neg, q: num << BigInt(e) };
  const den = 1n << BigInt(-e);
  let q = num / den;
  const r = num % den;
  const twice = r * 2n;
  if (twice > den || (twice === den && (q & 1n) === 1n)) q += 1n;
  return { neg, q };
}

/** CPython round(x) to an integer (returned as a JS number). */
export function pyRoundInt(x: number): number {
  const { neg, q } = roundScaled(x, 0);
  return Number(neg ? -q : q);
}

/** CPython round(x, digits): the double nearest the exactly rounded decimal. */
export function pyRoundTo(x: number, digits: number): number {
  const { neg, q } = roundScaled(x, digits);
  let s = q.toString();
  if (digits > 0) {
    s = s.padStart(digits + 1, '0');
    s = `${s.slice(0, s.length - digits)}.${s.slice(s.length - digits)}`;
  }
  return Number((neg ? '-' : '') + s);
}

/** CPython f"{x:.Nf}": fixed-point, exactly N decimals, ties to even. */
export function pyFixed(x: number, digits: number): string {
  const { neg, q } = roundScaled(x, digits);
  let s = q.toString();
  if (digits > 0) {
    s = s.padStart(digits + 1, '0');
    s = `${s.slice(0, s.length - digits)}.${s.slice(s.length - digits)}`;
  }
  return (neg ? '-' : '') + s;
}

/** CPython f"{x:+.Nf}": fixed-point with an explicit sign (sign of the value, -0.0 included). */
export function pySignedFixed(x: number, digits: number): string {
  const neg = x < 0 || Object.is(x, -0);
  return (neg ? '-' : '+') + pyFixed(Math.abs(x), digits);
}

/**
 * CPython repr of a float: the shortest digit string that round-trips
 * (JS String gives the same digits), rendered with Python's notation rules:
 * fixed notation unless the decimal exponent is below -4 or at least 16.
 */
export function pyFloatRepr(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const neg = x < 0;
  const s = String(Math.abs(x));
  let digits: string;
  let exp: number; // value = digits[0].digits[1..] * 10^exp
  const eAt = s.indexOf('e');
  if (eAt >= 0) {
    digits = s.slice(0, eAt).replace('.', '');
    exp = Number(s.slice(eAt + 1));
  } else {
    const dot = s.indexOf('.');
    const intPart = dot >= 0 ? s.slice(0, dot) : s;
    const fracPart = dot >= 0 ? s.slice(dot + 1) : '';
    if (intPart !== '0') {
      digits = (intPart + fracPart).replace(/0+$/, '');
      exp = intPart.length - 1;
    } else {
      const zeros = fracPart.match(/^0*/)![0].length;
      digits = fracPart.slice(zeros).replace(/0+$/, '');
      exp = -(zeros + 1);
    }
  }
  let body: string;
  if (exp < -4 || exp >= 16) {
    body = digits[0]! + (digits.length > 1 ? `.${digits.slice(1)}` : '') +
      `e${exp < 0 ? '-' : '+'}${String(Math.abs(exp)).padStart(2, '0')}`;
  } else if (exp >= 0) {
    const padded = digits.padEnd(exp + 1, '0');
    const intPart = padded.slice(0, exp + 1);
    const fracPart = digits.slice(exp + 1);
    body = fracPart.length > 0 ? `${intPart}.${fracPart}` : `${intPart}.0`;
  } else {
    body = `0.${'0'.repeat(-exp - 1)}${digits}`;
  }
  return (neg ? '-' : '') + body;
}

// ---------------------------------------------------------------- json.dump(indent=1, ensure_ascii=False)

/** A value Python would type as float (so it serialises as one, e.g. 1.0). */
export class PyFloat {
  v: number;
  constructor(v: number) {
    this.v = v;
  }
}

/** Python's json string escaping with ensure_ascii=False. */
function pyJsonString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20) out += `\\u${c.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return out + '"';
}

/** Serialise like CPython json.dump(value, indent=1, ensure_ascii=False). */
export function pyJsonDump(value: unknown, level = 0): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (value instanceof PyFloat) return pyFloatRepr(value.v);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`pyJsonDump: untagged float ${value}`);
    return String(value);
  }
  if (typeof value === 'string') return pyJsonString(value);
  const pad = ' '.repeat(level + 1);
  const closePad = ' '.repeat(level);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((v) => pad + pyJsonDump(v, level + 1)).join(',\n')}\n${closePad}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    return `{\n${entries.map(([k, v]) => `${pad}${pyJsonString(k)}: ${pyJsonDump(v, level + 1)}`).join(',\n')}\n${closePad}}`;
  }
  throw new Error(`pyJsonDump: unsupported value ${String(value)}`);
}
