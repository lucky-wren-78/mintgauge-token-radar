# MintGauge — Pre-Token Launch Radar

[![make.fun bounty: token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![MintGauge rank on make.fun](https://make.fun/badge/token-radar-01/lucky-wren-78/mintgauge-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01)
[![MintGauge reward on make.fun](https://make.fun/badge/token-radar-01/lucky-wren-78/mintgauge-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01)

An entry for the make.fun bounty [token-radar-01](https://make.fun/bounty/token-radar-01):
a static dashboard that ranks the pre-token protocols of a sealed DefiLlama
snapshot by implied launch value — what each protocol would be worth if it
launches, times the odds it ever records a token — with both models fitted
on the snapshot itself, validated out of sample in the open, and a concrete
farm plan for every protocol on the board.

## The board

198 protocols are ranked. The snapshot's 758 protocols are accounted for in
the open: 416 already have a token, 91 are bridges, liquid-staking or
name-word derivatives, 42 are centralised exchanges and 11 are versioned
releases — the remaining 198 are ranked, including all 40 watchlist
protocols (40/40). Steakhouse Financial leads the board (token odds 0.40,
implied $43.8M), Sentora is second.

## The models

**Value if it launches** = `exp(10.0549 + 0.1893 × ln TVL + 0.00884 ×
(ln TVL)²) × category premium`, an ordinary-least-squares log-log fit with a
curvature term on the 128 snapshot protocols that already trade. The
curvature bends the effective size slope from 0.50 at $50M TVL to 0.57 at
$2.8B. Each category premium is that category's mean residual, shrunk
toward 1.00 by `n/(n+10)`. A sanity cap holds every value at or below
TVL × 2.956 — the 90th percentile of traded comps' value/TVL — and binds
0 of 198 rows on this snapshot.

**Token odds** = a ridge logit (λ = 2) fitted on all 758 protocols
(outcome: already records a token, 416 vs 342 pre-token) on log age without
a token, ln TVL, 7-day growth, log chain count and category. Ten-fold
Brier 0.197 against the base rate's 0.248; out-of-fold calibration slope
1.01. **Implied value = value × odds.** Printed warning, not buried:
forward in time the odds run over-confident — the walk-forward calibration
slope is only 0.32 — though the Brier still beats the base rate there too
(0.242 vs 0.288).

Validated honestly, out of sample, under three protocols: the value
model's median miss is **×3.57** (random holdout), **×3.71** (leave-one-out)
and **×2.91** (walk-forward), against ×5.07/×5.07/×5.44 for a flat
market-cap/TVL multiple. Every candidate term was tested one at a time
against the base and kept only if it improved BOTH leave-one-out and
walk-forward — momentum and age failed that test for value, so they are
not in the value model (the full 17-row ablation, rejections included, is
printed on the dashboard). Every row carries an uncertainty band from the
quantiles of cross-fitted residuals of the final model (P25–P75, with
P10–P90 in the detail view) and a rank range from 200 bootstrap refits.
The bands' measured coverage is printed as measured — leave-one-out
50%/77% against the 50%/80% claims — not widened after the fact.

## Farm plans

Every row ships an eight-step farm plan derived from that protocol's own
category, chains, TVL tier, age and 7-day trend: a safety-verification
step first, then funding, a tranched entry (half now, half after a week —
the second tranche is conditional on the protocol's actual trend), the
category's core and weekly qualifying actions, a hold-and-monitor step,
a claim step, and a quantitative exit rule with capital rotation. Each
step states its cost and its time, and each row carries the plan's
working capital, estimated cash cost, chain gas and planned hold, so the
board can net every plan against a live scenario (plan size, drop share,
horizon) after costs and per hour of hands-on time, benchmarked against a
4%/yr T-bill on the same money.

## The dashboard

A static page — vanilla HTML/CSS/JS, no framework, no network — with a
dark OKLCH theme. The evidence is printed open above the board, not behind
a disclosure widget: the 758-protocol accounting, a compact ablation
table, and a validation strip carrying all three miss factors, the odds
Brier, the measured band coverage and the walk-forward warning. The page
re-derives every number it shows from `board.json` and prints a
self-verification seal (row count, rank sequence, total, implied = value
× odds on every row, SHA-256 of the board) so the page and the file can be
checked against each other at a glance. Board (sortable by every column
including token odds and net/hour; filterable by text, category, primary
chain and scenario verdict), a full-page per-protocol detail (value
waterfall, odds decomposition, bands with P10–P90 whiskers, seven nearest
traded peers, scenario verdict with T-bill benchmark and break-even drop
shares, sensitivity matrix, farm plan with cost/time chips), a live-comps
reference view, and a method view with the fitted-curve scatter, the odds
decile calibration chart and the full evidence tables.

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
- `dashboard/` — the static page (63,856 bytes of source).
- `screenshots/` — the board, a protocol detail, a filtered view and the
  method view, 1440×900.
- `.makefun/owner.json` — the claim file naming the entrant wallet.

## License

MIT — see [LICENSE](LICENSE).
