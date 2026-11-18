# MintGauge — Pre-Token Launch Radar

[![make.fun bounty: token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![MintGauge rank on make.fun](https://make.fun/badge/token-radar-01/lucky-wren-78/mintgauge-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![MintGauge reward on make.fun](https://make.fun/badge/token-radar-01/lucky-wren-78/mintgauge-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

An entry for the make.fun bounty [token-radar-01](https://make.fun/bounty/token-radar-01):
a static dashboard that ranks the pre-token protocols of a sealed DefiLlama
snapshot by implied launch value, with an honest, validated valuation model
and a concrete farm plan for every protocol on the board.

## The board

198 protocols are ranked. The snapshot's 758 protocols are accounted for in
the open: 416 already have a token, 91 are wrapped/staked/bridged
derivatives, 42 are centralised exchanges and 11 are versioned releases —
the remaining 198 are ranked, including all 40 watchlist protocols (40/40).

## The model

Implied value = `exp(6.9646 + 0.5223 × ln TVL) × category premium`, an
ordinary-least-squares log-log fit on the 128 snapshot protocols that
already trade (market cap > 0, TVL > 0). Each category premium is that
category's mean residual, shrunk toward 1.00 by `n/(n+10)` so thin
categories cannot dominate. A sanity cap holds every implied value at or
below TVL × 2.96 — the 90th percentile of traded comps' market-cap/TVL —
and binds 0 of 198 rows on this snapshot.

Validated honestly, out of sample (25 repeats of an 80/20 holdout): the
model's median miss is **×3.55**, against **×5.07** for a flat
market-cap/TVL multiple. Momentum and age were tested as extra regressors
and rejected — they did not improve the holdout, so they are not in the
model. Every row carries an uncertainty band from the quantiles of
10-fold cross-fitted residuals (P25–P75, with P10–P90 in the detail view)
and a rank range from 200 bootstrap refits (P10–P90) — bands wide enough
to contain the model's actual residual dispersion, not just its parameter
uncertainty.

## Farm plans

Every row ships an eight-step farm plan derived from that protocol's own
category, chains, TVL tier, age and 7-day trend: a safety-verification
step first, then funding, a tranched entry (half now, half after a week —
the second tranche is conditional on the protocol's actual trend), the
category's core and weekly qualifying actions, a hold-and-monitor step,
a claim step, and a quantitative exit rule with capital rotation. Each
step states its cost and its time, and each row carries the plan's
working capital and estimated cash cost, so the detail view can net the
plan against a token drop (3.5% / 7% / 14% of a $1,000 or $10,000
position) after costs. A transparent score (TVL vs the $50M floor, age,
7-day momentum) gives each plan a verdict: FARM (16 rows), MARGINAL (67)
or SKIP (115).

## The dashboard

A static page — vanilla HTML/CSS/JS, no framework, no network — with a
dark OKLCH theme. The holdout results are printed in a validation strip
above the board, not buried in a footnote. It re-derives every number it
shows from `board.json`
and prints a self-verification seal (row count, rank sequence, total,
SHA-256 of the board) so the page and the file can be checked against
each other at a glance. Board, per-protocol detail (value waterfall,
bands with P10–P90 whiskers, nearest traded comparables, farm plan with
its net-of-costs table) and a live-comps reference
view; sortable, filterable by text, category and verdict.

## Run it

Node 22 or later, standard library only, nothing to install:

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <path-to-snapshot.json>
```

This writes `out/board.json`, copies `dashboard/` and `screenshots/` to
`out/`, and writes `out/dossier.json` with the vendored make.fun library
(the scorer rebuilds the dossier from the same output and compares
bytes; two runs here are byte-identical). Serve `out/` over HTTP and
open `out/dashboard/` to read the radar.

## Layout

- `main.ts` — the entry program: snapshot in, board + dossier out.
- `lib/model.ts` — the valuation model, filter, farm plans, gate checks.
- `lib/compat.ts` — the NumPy/CPython numeric pieces the model depends on
  (seeded PCG64 bootstrap, exact rounding and serialisation), so the
  board is reproducible byte-for-byte.
- `vendor/makefun-board.ts` — make.fun's dossier library, vendored
  byte-for-byte as the platform requires.
- `dashboard/` — the static page (37,541 bytes of source).
- `screenshots/` — the board, a protocol detail and a filtered view,
  1440×900.
- `.makefun/owner.json` — the claim file naming the entrant wallet.

## License

MIT — see [LICENSE](LICENSE).
