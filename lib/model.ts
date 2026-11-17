// MintGauge's model: the valuation, filter, farm plans and board assembly.
//
// A TypeScript port of the validated Python prototype (model/fit-v1.py's
// variant c2 + entry/build-board.py), reproducing its board byte-for-byte
// (see lib/compat.ts for the NumPy/CPython pieces that takes). The model:
//
//   implied = exp(intercept + slope * ln TVL) * category premium,
//   fitted by OLS on the snapshot's traded protocols (mcap > 0, TVL > 0);
//   each category premium is its mean residual, shrunk by n/(n+10);
//   a sanity cap holds every implied value at or below TVL times the 90th
//   percentile of traded comps' mcap/TVL; uncertainty bands are quantiles of
//   10-fold cross-fitted residuals; rank ranges are percentiles 10-90 of 200
//   bootstrap refits. Momentum and age were tested as regressors and
//   rejected by the holdout, so they are not in the model.

import { BitGen, PyFloat, npMean, npPercentile, npQuantile, pyFixed, pyJsonDump, pyRoundInt, pyRoundTo, pySignedFixed } from './compat.ts';

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

/** A protocol plus the derived fields the model works with. */
interface Enriched {
  p: Protocol;
  lt: number; // ln(tvl_usd)
  lm: number; // ln(mcap_usd), calibration rows only
  age: number | null; // days between listed_at and the snapshot date
}

const SEED = 20261114;
const N_BOOT = 200;
const SHRINK_K = 10.0;
const BAND_Q: [number, number] = [0.25, 0.75]; // the IQR band on every row
const WIDE_Q: [number, number] = [0.1, 0.9]; // the wider band in the detail view
const CAP_PCT = 90; // the cap ratio's percentile of traded comps

// House filter definitions (kit input README): derivative categories, the
// wrapped/staked/staking name words, and the starter's versioned-name regex.
const DERIVATIVE_CATS = new Set(['Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'Bridge', 'Canonical Bridge']);
const DERIV_WORDS = /\b(wrapped|staked|staking)\b/i;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

function parseDay(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function ageDays(p: Protocol, asOfMs: number): number | null {
  if (!p.listed_at) return null;
  return Math.round((asOfMs - parseDay(p.listed_at)) / 86_400_000);
}

function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

function isDerivative(p: Protocol): boolean {
  if (p.category !== null && DERIVATIVE_CATS.has(p.category)) return true;
  return DERIV_WORDS.test(p.name || '');
}

function enrich(p: Protocol, asOfMs: number): Enriched {
  return { p, lt: Math.log(p.tvl_usd), lm: p.mcap_usd !== null ? Math.log(p.mcap_usd) : 0, age: ageDays(p, asOfMs) };
}

// ---------------------------------------------------------------- the fit

/** Closed-form OLS for the two-column design [1, ln TVL] -> ln mcap. */
function ols2(rows: Enriched[]): [number, number] {
  const n = rows.length;
  let sx = 0, sy = 0;
  for (const r of rows) {
    sx += r.lt;
    sy += r.lm;
  }
  const mx = sx / n, my = sy / n;
  let sxy = 0, sxx = 0;
  for (const r of rows) {
    const dx = r.lt - mx;
    sxy += dx * (r.lm - my);
    sxx += dx * dx;
  }
  const slope = sxy / sxx;
  return [my - slope * mx, slope];
}

interface CatShrinkFit {
  beta: [number, number];
  offsets: Map<string, number>;
  predict: (rows: Enriched[]) => number[];
}

/** Variant c2: global log-log slope + category intercepts shrunk by n/(n+10). */
function fitCatShrink(train: Enriched[]): CatShrinkFit {
  const beta = ols2(train);
  const byCat = new Map<string, number[]>();
  for (const r of train) {
    if (r.p.category === null) continue;
    const resid = r.lm - (beta[0] + beta[1] * r.lt);
    const list = byCat.get(r.p.category);
    if (list) list.push(resid);
    else byCat.set(r.p.category, [resid]);
  }
  const offsets = new Map<string, number>();
  for (const [cat, rs] of byCat) offsets.set(cat, (rs.length / (rs.length + SHRINK_K)) * npMean(rs));
  return {
    beta,
    offsets,
    predict: (rows) =>
      rows.map((r) => {
        let v = Math.exp(beta[0] + beta[1] * r.lt);
        if (r.p.category !== null && offsets.has(r.p.category)) v *= Math.exp(offsets.get(r.p.category)!);
        return v;
      }),
  };
}

// ---------------------------------------------------------------- farm plans

const GAS_BY_CHAIN: Record<string, number> = {
  Ethereum: 8, Bitcoin: 5, BSC: 1, 'BNB Chain': 1, Solana: 1, Arbitrum: 1,
  Base: 1, Polygon: 1, Avalanche: 2, Optimism: 1, Tron: 1,
};

const CORE_ACTIONS: Record<string, string> = {
  Lending: "Supply USDC to the protocol's largest lending market",
  'Uncollateralized Lending': "Deposit USDC into the protocol's flagship lending pool",
  Dexs: 'Provide liquidity to the deepest USDC pair and make one small swap',
  Derivatives: 'Deposit margin and open one small hedged position (long spot, short perp)',
  'Interest Rate Derivatives': 'Deposit collateral and open one small fixed-rate position',
  CDP: 'Open a small collateralised vault and mint a conservative amount of its stablecoin (keep collateral ratio above 250%)',
  'CDP Manager': 'Open a managed vault position with a conservative collateral ratio above 250%',
  'Dual-Token Stablecoin': 'Deposit collateral and mint a small amount of the protocol stablecoin',
  Yield: "Deposit USDC into the protocol's flagship yield vault",
  'Yield Aggregator': 'Deposit USDC into the highest-TVL aggregator vault',
  Farm: "Stake into the protocol's main incentivised farm pool",
  'Leveraged Farming': 'Open a small 2x leveraged farm position (never above 2x for a points plan)',
  RWA: 'Complete onboarding/KYC and subscribe to the smallest available real-world-asset vault share',
  'Prediction Market': 'Take small positions on both sides of one liquid market to generate genuine volume',
  'Basis Trading': "Deposit into the protocol's basis-trade vault",
  'Risk Curators': "Allocate to the curator's largest vault and keep the allocation in one market",
  'Onchain Capital Allocator': "Allocate to the allocator's flagship vault",
  'Liquidity Manager': "Deposit into the protocol's managed liquidity vault",
  'Collateral Markets': "Deposit collateral into the protocol's main collateral market",
  Indexes: "Buy and hold a small amount of the protocol's main index token basket",
  'Cross Chain Bridge': "Bridge a small amount across the protocol's busiest route and back",
  Chain: 'Bridge in a small amount and transact with two native dApps (one swap, one lending deposit)',
  Insurance: 'Stake a small amount into the coverage pool (or buy one small cover policy)',
  'Staking Pool': "Stake the chain's native asset through the pool",
  Restaking: 'Deposit and restake a small amount of liquid-staked collateral',
  Payments: 'Activate an account, load a small balance and make two genuine payments',
  'Crypto Card Issuer': 'Order/activate the card product and make two small real purchases',
  'Governance Incentives': 'Stake the governance position and vote in one live governance round',
  'OTC Marketplace': 'Register, complete KYC and request one small RFQ quote',
  CeDeFi: "Deposit into the protocol's flagship earn product",
  'Anchor BTC': 'Deposit a small amount of BTC collateral and mint against it',
  'Decentralized BTC': 'Deposit a small amount of BTC collateral and mint against it',
  'Stablecoin Wrapper': 'Deposit the underlying stablecoin and mint the wrapped version',
};
const CORE_DEFAULT = "Deposit USDC into the protocol's flagship product and make one genuine transaction";

const QUAL_ACTIONS: Record<string, string> = {
  Lending: 'top up or partially repay 5% of the position',
  Dexs: 'rebalance the LP position and make one small swap',
  Derivatives: 'roll or resize the hedge by a small amount',
  RWA: 'add a small subscription top-up or claim distributions',
  'Prediction Market': 'trade one small position in a new market',
  'Cross Chain Bridge': 'bridge a small amount on the same route',
  Chain: 'make two small transactions in native dApps',
};
const QUAL_DEFAULT = 'repeat a small top-up or claim-and-restake of about 5% of the position';

function gasFor(chain: string): number {
  return GAS_BY_CHAIN[chain] ?? 2;
}

function capitalFor(tvl: number): number {
  if (tvl >= 1_000_000_000) return 250;
  if (tvl >= 250_000_000) return 150;
  if (tvl >= 50_000_000) return 100;
  return 50;
}

function holdFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 540) return 45;
  return 30;
}

/** The farm verdict's transparent score: size, age and 7-day momentum. */
function verdictFor(p: Protocol, age: number | null): { verdict: string; score: number } {
  let pts = 0;
  if (p.tvl_usd >= 50_000_000) pts += 2;
  if (p.tvl_usd >= 250_000_000) pts += 1;
  if (age !== null && age >= 180) pts += 1;
  const ch = p.change_7d;
  if (ch !== null && ch >= 0) pts += 1;
  if (ch !== null && ch <= -20) pts -= 2;
  if (pts >= 4) return { verdict: 'FARM', score: pts };
  if (pts >= 2) return { verdict: 'MARGINAL', score: pts };
  return { verdict: 'SKIP', score: pts };
}

function fmtUsd(v: number): string {
  if (v >= 1e9) return `$${pyFixed(v / 1e9, 2)}B`;
  if (v >= 1e6) return `$${pyFixed(v / 1e6, 1)}M`;
  return `$${pyRoundInt(v).toLocaleString('en-US')}`;
}

/** Six steps per protocol, derived from the row's own data; each carries a cost and a time. */
function farmSteps(p: Protocol, age: number | null): string[] {
  const name = p.name;
  const slug = p.slug;
  const cat = p.category || 'DeFi';
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const gas = gasFor(chain);
  const cap = capitalFor(p.tvl_usd);
  const hold = holdFor(age);
  const weeks = Math.max(1, Math.floor(hold / 7));
  const { verdict } = verdictFor(p, age);
  const ch = p.change_7d;
  const chTxt = ch === null ? 'n/a' : `${pySignedFixed(ch, 1)}%`;
  const core = CORE_ACTIONS[cat] ?? CORE_DEFAULT;
  const qual = QUAL_ACTIONS[cat] ?? QUAL_DEFAULT;
  const steps = [
    `Verify ${name} before depositing: open its DefiLlama protocol page (slug '${slug}') and follow only the official app and docs links listed there - never search-engine ads, DMs or look-alike domains. Save the official app URL in your farm log. Cost: $0. Time: 10 min.`,
    `Fund a fresh, farm-only wallet on ${chain} with about $${gas} of gas money; write the seed phrase on paper offline and never route funds from an account you cannot afford to flag. Cost: ~$${gas} gas. Time: 15 min.`,
    `${core} on ${chain}, sized at $${cap} of working capital for a protocol with ${fmtUsd(p.tvl_usd)} TVL; start at half size for the first week. Cost: $${cap} capital + ~$${gas} gas. Time: 20 min.`,
    `Qualify weekly: ${qual}, every week, so the activity appears in at least ${weeks} separate weekly snapshots; log each transaction hash with its date and amount. Cost: ~$2/week in gas. Time: 10 min/week.`,
    `Hold about ${hold} days and monitor weekly: check ${name}'s points or rewards page and its TVL trend (7d change is now ${chTxt}); a TVL drop over 15% in one week moves this plan to the exit watchlist. Cost: $0. Time: 5 min/week.`,
    `Exit rule (plan verdict: ${verdict}): withdraw if TVL falls 25% or more within 7 days, if no token or rewards are announced by day ${hold}, or immediately on any official exploit warning - whichever comes first. Claim only inside the official app; never pay anyone to 'unlock' a claim. Cost: ~$${gas} gas. Time: 15 min.`,
  ];
  return steps.map((s) => (s.length >= 20 ? s : `${s} Keep records.`));
}

// ---------------------------------------------------------------- the board

export type BoardRow = Record<string, unknown>;

/** Build the ranked board (rows in the prototype's exact field order). */
export function buildBoard(snap: Snapshot): BoardRow[] {
  const asOfMs = parseDay(snap.as_of);
  const prots = snap.protocols;
  const watchlist = new Set(snap.watchlist);

  // Calibration set: traded protocols with a real market cap and TVL.
  const cal = prots
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .map((p) => enrich(p, asOfMs));
  const fit = fitCatShrink(cal);
  const beta = fit.beta;
  const premiums = new Map<string, number>();
  for (const [cat, off] of fit.offsets) premiums.set(cat, pyRoundTo(Math.exp(off), 4));

  // Sanity cap from the traded comps' own distribution.
  const compRatios = cal.map((r) => r.p.mcap_usd! / r.p.tvl_usd).sort((a, b) => a - b);
  const capRatio = npPercentile(compRatios, CAP_PCT);

  // Cross-fitted residuals (10-fold) for the uncertainty bands.
  const rng = new BitGen(SEED);
  const perm = rng.permutation(cal.length);
  const cfResid: number[] = new Array<number>(cal.length).fill(0);
  for (let f = 0; f < 10; f++) {
    const fold = new Set(perm.filter((_, idx) => idx % 10 === f));
    const train = cal.filter((_, i) => !fold.has(i));
    const testIdx = [...fold].sort((a, b) => a - b);
    const preds = fitCatShrink(train).predict(testIdx.map((i) => cal[i]!));
    testIdx.forEach((ci, k) => {
      cfResid[ci] = Math.log(cal[ci]!.p.mcap_usd! / preds[k]!);
    });
  }
  const qLo = npQuantile(cfResid, BAND_Q[0]);
  const qHi = npQuantile(cfResid, BAND_Q[1]);
  const qWLo = npQuantile(cfResid, WIDE_Q[0]);
  const qWHi = npQuantile(cfResid, WIDE_Q[1]);

  // The rankable universe, with the exclusion accounting of the prototype.
  const pre = prots.filter(isPreToken).map((p) => enrich(p, asOfMs));
  const nonDeriv = pre.filter((r) => !isDerivative(r.p));
  const nonCex = nonDeriv.filter((r) => r.p.category !== 'CEX');
  const rankable = nonCex.filter((r) => !VERSIONED.test(r.p.name || ''));

  // Values, cap, order.
  const rawVals = fit.predict(rankable);
  interface Meta {
    r: Enriched;
    curve: number;
    val: number;
    capped: boolean;
    implied: number;
    rankLo: number | null;
    rankHi: number | null;
  }
  const metas: Meta[] = rankable.map((r, i) => {
    const curve = Math.exp(beta[0] + beta[1] * Math.log(r.p.tvl_usd));
    const capVal = r.p.tvl_usd * capRatio;
    const raw = rawVals[i]!;
    return { r, curve, val: Math.min(raw, capVal), capped: raw > capVal, implied: 0, rankLo: null, rankHi: null };
  });
  metas.sort((a, b) => b.val - a.val);

  // Round to whole dollars, strictly decreasing (a $1 nudge on a tie).
  let prev: number | null = null;
  for (const m of metas) {
    let v = pyRoundInt(m.val);
    if (prev !== null && v >= prev) v = prev - 1;
    m.implied = Math.max(v, 1);
    prev = m.implied;
  }

  // Rank ranges from 200 bootstrap refits (parameter uncertainty only).
  const boardEnriched = metas.map((m) => m.r);
  const rngb = new BitGen(SEED + 1);
  const rankSamples: number[][] = metas.map(() => []);
  for (let b = 0; b < N_BOOT; b++) {
    const idx = rngb.integers32(cal.length, cal.length);
    const sample = idx.map((i) => cal[i]!);
    let preds: number[];
    try {
      preds = fitCatShrink(sample).predict(boardEnriched);
    } catch {
      continue;
    }
    const order = preds.map((_, i) => i).sort((x, y) => preds[y]! - preds[x]!);
    const ranks = new Array<number>(preds.length);
    order.forEach((rowIdx, k) => {
      ranks[rowIdx] = k + 1;
    });
    ranks.forEach((rk, i) => rankSamples[i]!.push(rk));
  }
  metas.forEach((m, i) => {
    const samples = rankSamples[i]!;
    if (samples.length > 0) {
      m.rankLo = Math.trunc(npPercentile(samples, 10));
      m.rankHi = Math.trunc(npPercentile(samples, 90));
    }
  });

  // Assemble the rows in the prototype's field order.
  return metas.map((m, i) => {
    const p = m.r.p;
    const age = m.r.age;
    const { verdict, score } = verdictFor(p, age);
    const implied = m.implied;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d === null ? null : new PyFloat(p.change_7d),
      age_days: age,
      watchlist: watchlist.has(p.slug),
      implied_value_usd: implied,
      curve_value_usd: pyRoundInt(m.curve),
      premium_mult: new PyFloat(premiums.get(p.category ?? '') ?? 1.0),
      capped: m.capped,
      band_lo_usd: pyRoundInt(implied * Math.exp(qLo)),
      band_hi_usd: pyRoundInt(implied * Math.exp(qHi)),
      wide_lo_usd: pyRoundInt(implied * Math.exp(qWLo)),
      wide_hi_usd: pyRoundInt(implied * Math.exp(qWHi)),
      rank_lo: m.rankLo,
      rank_hi: m.rankHi,
      farm_verdict: verdict,
      farm_score: score,
      farm_steps: farmSteps(p, age),
    } as BoardRow;
  });
}

/** The gate's board checks, in words: the first problem found, or null. */
export function boardIssue(rows: BoardRow[], snap: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100-4000`;
  const slugs = new Set(snap.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  let prevImplied: number | null = null;
  let firstImplied: number | null = null;
  let allEqual = true;
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const slug = r['slug'];
    if (typeof slug !== 'string' || slug.length < 1 || slug.length > 128 || slug.includes(' ')) return `row ${i}: bad slug`;
    if (!slugs.has(slug)) return `row ${i}: slug ${slug} is not in the snapshot`;
    if (seen.has(slug)) return `row ${i}: duplicate slug ${slug}`;
    seen.add(slug);
    if (typeof r['name'] !== 'string' || (r['name'] as string).length === 0) return `row ${i}: empty name`;
    if (r['rank'] !== i + 1) return `row ${i}: rank is not ${i + 1}`;
    const implied = r['implied_value_usd'];
    if (typeof implied !== 'number' || !Number.isInteger(implied) || implied <= 0 || implied > 100_000_000_000_000) return `row ${i}: bad implied value`;
    if (prevImplied !== null && implied > prevImplied) return `row ${i}: implied value rises with rank`;
    if (firstImplied === null) firstImplied = implied;
    else if (implied !== firstImplied) allEqual = false;
    prevImplied = implied;
    const steps = r['farm_steps'];
    if (!Array.isArray(steps) || steps.length < 3 || steps.length > 12) return `row ${i}: farm steps outside 3-12`;
    for (const s of steps) {
      if (typeof s !== 'string') return `row ${i}: a farm step is not a string`;
      const len = [...s.trim()].length;
      if (len < 20 || len > 600) return `row ${i}: a farm step is ${len} characters, outside 20-600`;
    }
  }
  if (rows.length >= 2 && allEqual) return 'every implied value is the same';
  for (const slug of snap.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol ${slug} is not on the board`;
  }
  return null;
}

/** board.json exactly as the prototype wrote it: json.dump(indent=1), no trailing newline. */
export function serializeBoard(rows: BoardRow[]): string {
  return pyJsonDump({ rows });
}
