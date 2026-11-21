// MintGauge's model: the valuation, the token odds, the farm plans and the
// board assembly.
//
// A TypeScript port of the validated Python prototypes (model/fit-v1.py,
// model/v3-m2-ablation.py, model/v3-m3-odds.py, model/v3-m4-bands.py),
// reproducing their board (see lib/compat.ts for the NumPy/CPython pieces
// that takes). Two models, both fitted on the snapshot's own numbers:
//
//   VALUE IF IT LAUNCHES — implied by the size curve
//     log(mcap) = b0 + b1 * ln TVL + b2 * (ln TVL)^2, OLS on the snapshot's
//     128 traded protocols (mcap > 0, TVL > 0), plus a per-category
//     intercept: each category's mean residual, shrunk by n/(n+10).
//     The curvature term is the one addition that improved BOTH new test
//     protocols (leave-one-out miss x3.71, walk-forward miss x2.91, random
//     holdout x3.57); momentum, age, chain count, capped multipliers,
//     Huber, alternate fit sets and full per-category fits were all tested
//     against the same two protocols and rejected — the dashboard prints
//     the ablation table. A sanity cap holds every value at or below TVL
//     times the 90th percentile of traded comps' mcap/TVL. Uncertainty
//     bands are quantiles of 10-fold cross-fitted residuals; their
//     held-out coverage is printed on the dashboard (P25-P75 covers 50%
//     at LOO against a 50% claim; P10-P90 covers 77% against 80%).
//
//   TOKEN ODDS — the chance a protocol ever records a token, fitted by a
//     ridge logit (lambda 2.0, chosen on a grid by ten-fold Brier) on all
//     758 snapshot protocols: outcome = already tokenised (416) vs
//     pre-token (342); features = log age without a token, ln TVL, 7-day
//     growth, log chain count, category. Ten-fold Brier 0.197 against the
//     base rate's 0.248; walk-forward Brier 0.242 against 0.288;
//     out-of-fold calibration slope 1.01. The walk-forward calibration
//     slope is only 0.32 — forward in time the odds run over-confident —
//     and the dashboard prints that warning next to the odds.
//
//   implied_value_usd = value if it launches x token odds, rounded to
//   whole dollars, strictly decreasing with rank. Rank ranges are
//   percentiles 10-90 of 200 bootstrap refits of the value model (odds
//   held at their full-fit values).

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
const ODDS_LAMBDA = 2.0; // ridge penalty of the token-odds logit (grid-picked)

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

/** Median of an already-sorted numeric array (statistics.median semantics). */
function medianSorted(a: number[]): number {
  const n = a.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? a[mid]! : (a[mid - 1]! + a[mid]!) / 2;
}

// ------------------------------------------------------- linear algebra

/** Solve A x = b by Gaussian elimination with partial pivoting. */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    if (Math.abs(M[piv]![col]!) < 1e-12) throw new Error('singular matrix');
    if (piv !== col) { const t = M[col]!; M[col] = M[piv]!; M[piv] = t; }
    const pv = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / pv;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c] = M[r]![c]! - f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** Least squares via the normal equations (designs here are tiny). */
function olsMulti(X: number[][], y: number[]): number[] {
  const d = X[0]!.length;
  const XtX: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const Xty = new Array<number>(d).fill(0);
  for (let i = 0; i < X.length; i++) {
    const xi = X[i]!;
    for (let j = 0; j < d; j++) {
      Xty[j] = Xty[j]! + xi[j]! * y[i]!;
      for (let k = j; k < d; k++) XtX[j]![k] = XtX[j]![k]! + xi[j]! * xi[k]!;
    }
  }
  for (let j = 0; j < d; j++) for (let k = 0; k < j; k++) XtX[j]![k] = XtX[k]![j]!;
  return solveLinear(XtX, Xty);
}

// ---------------------------------------------------------------- the fit

interface CatShrinkFit {
  beta: [number, number, number];
  offsets: Map<string, number>;
  predict: (rows: Enriched[]) => number[];
}

/** The value model: global log-log curve with a (ln TVL)^2 curvature term
 *  plus category intercepts shrunk by n/(n+10) (variant c2 + curvature). */
function fitCatShrink(train: Enriched[]): CatShrinkFit {
  const X = train.map((r) => [1, r.lt, r.lt * r.lt]);
  const y = train.map((r) => r.lm);
  const beta = olsMulti(X, y) as [number, number, number];
  const curve = (lt: number) => beta[0] + beta[1] * lt + beta[2] * lt * lt;
  const byCat = new Map<string, number[]>();
  for (const r of train) {
    if (r.p.category === null) continue;
    const resid = r.lm - curve(r.lt);
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
        let v = Math.exp(curve(r.lt));
        if (r.p.category !== null && offsets.has(r.p.category)) v *= Math.exp(offsets.get(r.p.category)!);
        return v;
      }),
  };
}

// ------------------------------------------------------------- token odds

/**
 * The token-odds logit, fitted on every snapshot protocol. Features, in
 * order: log1p age without a token (missing listing dates imputed with the
 * median age), ln TVL, 7-day growth in percent clipped to [-60, 120] and
 * scaled to a fraction (null counts as 0), log chain count, a missing-age
 * dummy, then one dummy per category. The continuous block is standardised
 * on the full population (the missing-age dummy passes through unscaled);
 * every coefficient except the intercept carries the ridge penalty.
 */
function fitOdds(prots: Protocol[], asOfMs: number): Map<string, number> {
  const cats = [...new Set(prots.map((p) => p.category).filter((c): c is string => c !== null))].sort();
  const ages = prots.map((p) => ageDays(p, asOfMs));
  const known = ages.filter((a): a is number => a !== null).sort((a, b) => a - b);
  const ageMed = medianSorted(known);
  const NC = 5; // continuous features ahead of the category dummies
  const raw: number[][] = prots.map((p, i) => {
    const a = ages[i]!;
    const missing = a === null ? 1 : 0;
    const age = a === null ? ageMed : a;
    const ch = p.change_7d === null ? 0 : Math.max(-60, Math.min(120, p.change_7d)) / 100;
    const cont = [Math.log1p(Math.max(age, 0)), Math.log(p.tvl_usd), ch, Math.log(Math.max(p.chains.length, 1)), missing];
    return [...cont, ...cats.map((c) => (p.category === c ? 1 : 0))];
  });
  const mu = new Array<number>(NC).fill(0);
  const sd = new Array<number>(NC).fill(1);
  for (let j = 0; j < NC; j++) {
    if (j === 4) { mu[j] = 0; sd[j] = 1; continue; } // the missing-age dummy is not scaled
    let m = 0;
    for (const row of raw) m += row[j]!;
    m /= raw.length;
    let v = 0;
    for (const row of raw) v += (row[j]! - m) * (row[j]! - m);
    mu[j] = m;
    sd[j] = Math.sqrt(v / raw.length) + 1e-12;
  }
  const d = 1 + NC + cats.length;
  const X: Float64Array[] = raw.map((row) => {
    const x = new Float64Array(d);
    x[0] = 1;
    for (let j = 0; j < NC; j++) x[1 + j] = (row[j]! - mu[j]!) / sd[j]!;
    for (let j = 0; j < cats.length; j++) x[1 + NC + j] = row[NC + j]!;
    return x;
  });
  const y = prots.map((p) => (isPreToken(p) ? 0 : 1));
  // Newton / IRLS for the ridge logit.
  const beta = new Float64Array(d);
  const pen = new Float64Array(d).fill(ODDS_LAMBDA);
  pen[0] = 0;
  const grad = new Float64Array(d);
  const H: number[][] = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  for (let iter = 0; iter < 100; iter++) {
    grad.fill(0);
    for (const row of H) row.fill(0);
    for (let i = 0; i < X.length; i++) {
      const xi = X[i]!;
      let z = 0;
      for (let j = 0; j < d; j++) z += xi[j]! * beta[j]!;
      const zc = Math.max(-35, Math.min(35, z));
      const pr = 1 / (1 + Math.exp(-zc));
      const w = pr * (1 - pr) + 1e-9;
      const res = y[i]! - pr;
      for (let j = 0; j < d; j++) {
        grad[j] = grad[j]! + xi[j]! * res;
        const wxj = w * xi[j]!;
        for (let k = j; k < d; k++) H[j]![k] = H[j]![k]! + wxj * xi[k]!;
      }
    }
    for (let j = 0; j < d; j++) {
      grad[j] = grad[j]! - pen[j]! * beta[j]!;
      H[j]![j] = H[j]![j]! + pen[j]!;
      for (let k = 0; k < j; k++) H[j]![k] = H[k]![j]!;
    }
    const step = solveLinear(H, [...grad]);
    let maxStep = 0;
    for (let j = 0; j < d; j++) {
      beta[j] = beta[j]! + step[j]!;
      maxStep = Math.max(maxStep, Math.abs(step[j]!));
    }
    if (maxStep < 1e-9) break;
  }
  const odds = new Map<string, number>();
  prots.forEach((p, i) => {
    const xi = X[i]!;
    let z = 0;
    for (let j = 0; j < d; j++) z += xi[j]! * beta[j]!;
    const zc = Math.max(-35, Math.min(35, z));
    odds.set(p.slug, 1 / (1 + Math.exp(-zc)));
  });
  return odds;
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

/**
 * A row's farm-plan economics: the working capital (returned on exit, so
 * not a cost) and the estimated cash cost — gas for the fund, enter, claim
 * and exit transactions plus $2/week of qualifying-action gas across the
 * plan's weekly snapshots.
 */
function planEconomics(p: Protocol, age: number | null): { capital: number; cash: number } {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'Ethereum';
  const gas = gasFor(chain);
  const weeks = Math.max(1, Math.floor(holdFor(age) / 7));
  return { capital: capitalFor(p.tvl_usd), cash: 4 * gas + 2 * weeks };
}

/** Eight steps per protocol, derived from the row's own data; each carries a cost and a time. */
function farmSteps(p: Protocol, age: number | null): string[] {
  const name = p.name;
  const slug = p.slug;
  const cat = p.category || 'DeFi';
  const chains = p.chains.length > 0 ? p.chains : ['Ethereum'];
  const chain = chains[0]!;
  const gas = gasFor(chain);
  const { capital: cap, cash } = planEconomics(p, age);
  const half = Math.floor(cap / 2);
  const rest = cap - half;
  const hold = holdFor(age);
  const weeks = Math.max(1, Math.floor(hold / 7));
  const { verdict } = verdictFor(p, age);
  const ch = p.change_7d;
  const chTxt = ch === null ? 'n/a' : `${pySignedFixed(ch, 1)}%`;
  const chAbs = ch === null ? '' : `${pyFixed(Math.abs(ch), 1)}%`;
  const core = CORE_ACTIONS[cat] ?? CORE_DEFAULT;
  const qual = QUAL_ACTIONS[cat] ?? QUAL_DEFAULT;
  const chainNote = chains.length > 1
    ? `${name} runs on ${chains.length} chains in the snapshot; keep the whole plan on ${chain}, its first-listed chain, instead of splitting activity across chains.`
    : `${name} runs only on ${chain} in the snapshot, so there is no chain choice to make.`;
  const scale = ch === null
    ? `Scale after 7 days: the snapshot prints no 7-day change for ${name}, so add the second tranche of $${rest} only if its live TVL on DefiLlama is flat or higher than on entry day; if TVL slipped, keep the plan at half size. Cost: $${rest} capital + ~$${gas} gas. Time: 10 min.`
    : ch >= 0
      ? `Scale after 7 days: ${name}'s TVL is trending up (${chTxt} over the 7 days in the snapshot), so add the second tranche of $${rest} on schedule - unless the live TVL has reversed by then. Cost: $${rest} capital + ~$${gas} gas. Time: 10 min.`
      : `Scale with caution: ${name}'s TVL fell ${chAbs} over the 7 days in the snapshot, so add the second tranche of $${rest} only after a flat or positive week on its DefiLlama page; a second falling week cancels the scale-up. Cost: $${rest} capital + ~$${gas} gas. Time: 10 min.`;
  const agePhrase = age === null
    ? `has no listing date in the snapshot, so the plan uses the standard ${hold}-day hold`
    : age < 180
      ? `was listed only ${age} days before the snapshot - a young protocol, hence the longer ${hold}-day hold`
      : age < 540
        ? `was listed ${age} days before the snapshot`
        : `was listed ${age} days before the snapshot and is well seasoned, hence the shorter ${hold}-day hold`;
  const steps = [
    `Verify ${name} before depositing: open its DefiLlama protocol page (slug '${slug}') and follow only the official app and docs links listed there - never search-engine ads, DMs or look-alike domains. Save the official app URL in your farm log. Cost: $0. Time: 10 min.`,
    `Fund a fresh, farm-only wallet on ${chain} with the full $${cap} of working capital plus about $${gas} of gas money; write the seed phrase on paper offline and never route funds from an account you cannot afford to flag. Cost: ~$${gas} gas. Time: 15 min.`,
    `${core} on ${chain} with only the first tranche of $${half} of the $${cap} plan, against ${fmtUsd(p.tvl_usd)} of TVL. ${chainNote} Cost: $${half} capital + ~$${gas} gas. Time: 20 min.`,
    scale,
    `Qualify weekly: ${qual}, every week, so the activity appears in at least ${weeks} separate weekly snapshots; log each transaction hash with its date and amount. Cost: ~$2/week in gas. Time: 10 min/week.`,
    `Hold about ${hold} days and monitor weekly: ${name} ${agePhrase}; check its points or rewards page and its TVL trend (7d change is now ${chTxt}) and write the points balance into the farm log each week; a TVL drop over 15% in one week moves this plan to the exit watchlist. Cost: $0. Time: 5 min/week.`,
    `Claim when the token or rewards land: claim only inside the official app you saved in step 1, and re-check the claim page against the official docs before signing - never pay anyone to 'unlock' a claim. Sell enough of the claim to cover this plan's cash costs of about $${cash}; keep the rest as upside. Cost: ~$${gas} gas. Time: 15 min.`,
    `Exit rule (plan verdict: ${verdict}): withdraw if TVL falls 25% or more within 7 days, if no token or rewards are announced by day ${hold}, or immediately on any official exploit warning - whichever comes first. Then record the plan's net result (claimed value minus about $${cash} of cash costs) in the farm log and rotate the freed $${cap} to the next FARM-verdict protocol on your list. Cost: ~$${gas} gas. Time: 15 min.`,
  ];
  return steps.map((s) => (s.length >= 20 ? s : `${s} Keep records.`));
}

// ---------------------------------------------------------------- the board

export type BoardRow = Record<string, unknown>;

/** Build the ranked board: rows ranked by value-if-launches x token odds. */
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

  // Token odds for every protocol in the snapshot (full-population fit).
  const odds = fitOdds(prots, asOfMs);

  // Sanity cap from the traded comps' own distribution.
  const compRatios = cal.map((r) => r.p.mcap_usd! / r.p.tvl_usd).sort((a, b) => a - b);
  const capRatio = npPercentile(compRatios, CAP_PCT);

  // Cross-fitted residuals (10-fold) of the value model for the bands.
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

  // Values, cap, odds, order — ranked by value x odds.
  const rawVals = fit.predict(rankable);
  interface Meta {
    r: Enriched;
    curve: number;
    val: number;
    capped: boolean;
    odds: number;
    implied: number;
    rankLo: number | null;
    rankHi: number | null;
  }
  const metas: Meta[] = rankable.map((r, i) => {
    const curve = Math.exp(beta[0] + beta[1] * r.lt + beta[2] * r.lt * r.lt);
    const capVal = r.p.tvl_usd * capRatio;
    const raw = rawVals[i]!;
    const val = Math.min(raw, capVal);
    return { r, curve, val, capped: raw > capVal, odds: odds.get(r.p.slug) ?? 0, implied: 0, rankLo: null, rankHi: null };
  });
  metas.sort((a, b) => b.val * b.odds - a.val * a.odds);

  // Round the implied values to whole dollars, strictly decreasing.
  let prev: number | null = null;
  for (const m of metas) {
    let v = pyRoundInt(m.val * m.odds);
    if (prev !== null && v >= prev) v = prev - 1;
    m.implied = Math.max(v, 1);
    prev = m.implied;
  }

  // Rank ranges from 200 bootstrap refits of the value model (parameter
  // uncertainty only; the odds stay at their full-fit values).
  const boardEnriched = metas.map((m) => m.r);
  const boardOdds = metas.map((m) => m.odds);
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
    const scored = preds.map((v, i) => v * boardOdds[i]!);
    const order = scored.map((_, i) => i).sort((x, y) => scored[y]! - scored[x]!);
    const ranks = new Array<number>(scored.length);
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

  // Assemble the rows. The uncertainty bands belong to the value estimate,
  // so they are drawn around value_if_launches_usd, not around the
  // odds-weighted implied value.
  return metas.map((m, i) => {
    const p = m.r.p;
    const age = m.r.age;
    const { verdict, score } = verdictFor(p, age);
    const econ = planEconomics(p, age);
    const valueIf = pyRoundInt(m.val);
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
      implied_value_usd: m.implied,
      value_if_launches_usd: valueIf,
      token_odds: new PyFloat(pyRoundTo(m.odds, 4)),
      curve_value_usd: pyRoundInt(m.curve),
      premium_mult: new PyFloat(premiums.get(p.category ?? '') ?? 1.0),
      capped: m.capped,
      band_lo_usd: pyRoundInt(valueIf * Math.exp(qLo)),
      band_hi_usd: pyRoundInt(valueIf * Math.exp(qHi)),
      wide_lo_usd: pyRoundInt(valueIf * Math.exp(qWLo)),
      wide_hi_usd: pyRoundInt(valueIf * Math.exp(qWHi)),
      rank_lo: m.rankLo,
      rank_hi: m.rankHi,
      farm_verdict: verdict,
      farm_score: score,
      farm_cash_cost_usd: econ.cash,
      farm_capital_usd: econ.capital,
      gas_usd: gasFor(p.chains.length > 0 ? p.chains[0]! : 'Ethereum'),
      hold_days: holdFor(age),
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
