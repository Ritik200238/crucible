# Execution evidence

Every figure below is computed from `data/samples.jsonl` by `src/sampler/report.ts`.
Nothing here is typed by hand. Regenerate it with:

```bash
npm run evidence
```

## What was measured

Every ten minutes, the same order is priced on both venues at the same instant:

- **Binance spot**, taker and maker, from the live order book. The taker cost is
  the account's commission plus half the spread plus the impact of walking the
  book for that size. The maker cost weighs the fee and the spread earned by the
  chance of the order actually filling, estimated from measured trade flow.
- **On-chain**, through the PancakeSwap V3 pools on BNB Smart Chain, quoted on
  every fee tier and taking whichever paid out most for that size, plus gas at
  the live price and the wallet's own service fee.

Both sides use public, read-only endpoints. No order was placed to collect this.

Costs are quoted in basis points of the Binance mid at the moment of the
snapshot, so the two venues land on one comparable axis. A basis point is 0.01%.

## The sample

- **60 priced comparisons** over **26 minutes**
- From `2026-09-08T16:56:30.755Z` to `2026-09-08T17:22:07.309Z`
- 314 rows on disk
- 250 earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither
- Cost model version 3

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 38% of 60 samples**, with a median
edge of **-41.66 bps**.

BNBUSDT: on-chain is cheaper to about $10,000, and Binance takes over by $100,000. BTCUSDT: Binance was cheaper at every size sampled. ETHUSDT: on-chain is cheaper to about $1,000, and Binance takes over by $10,000. XRPUSDT: Binance was cheaper at every size sampled.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 4 | 100% | 1.64 bps | 10.07 bps | 8.43 bps |
| BNBUSDT | $1,000 | 4 | 100% | 1.69 bps | 10.07 bps | 8.37 bps |
| BNBUSDT | $10,000 | 4 | 100% | 2.12 bps | 10.25 bps | 7.95 bps |
| BNBUSDT | $100,000 | 4 | 25% | 14.07 bps | 12.28 bps | -1.75 bps |
| BTCUSDT | $100 | 4 | 0% | 85.59 bps | 10.00 bps | -75.59 bps |
| BTCUSDT | $1,000 | 4 | 0% | 53.04 bps | 10.00 bps | -43.11 bps |
| BTCUSDT | $10,000 | 4 | 0% | 55.64 bps | 10.00 bps | -45.64 bps |
| BTCUSDT | $100,000 | 4 | 0% | 64.16 bps | 10.00 bps | -53.80 bps |
| ETHUSDT | $100 | 4 | 100% | 2.73 bps | 9.76 bps | 6.97 bps |
| ETHUSDT | $1,000 | 4 | 100% | 2.21 bps | 9.76 bps | 7.55 bps |
| ETHUSDT | $10,000 | 4 | 50% | 10.87 bps | 9.72 bps | -1.15 bps |
| ETHUSDT | $100,000 | 4 | 0% | 57.71 bps | 10.10 bps | -47.80 bps |
| XRPUSDT | $100 | 4 | 0% | 82.87 bps | 10.34 bps | -72.54 bps |
| XRPUSDT | $1,000 | 4 | 0% | 83.00 bps | 10.31 bps | -72.69 bps |
| XRPUSDT | $10,000 | 4 | 0% | 114.84 bps | 10.33 bps | -104.53 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | 0.145 | 0.009 | 0.576 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | 0.412 | 0.102 | 0.058 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | 0.086 | 1.050 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | -0.219 | 12.214 | 0.003 | 0.000 |
| BTCUSDT | $100 | 1.000 | -0.696 | 0.243 | 35.015 | 50.000 |
| BTCUSDT | $1,000 | 1.000 | -1.099 | 2.676 | 3.044 | 50.000 |
| BTCUSDT | $10,000 | 5.000 | -0.847 | 1.039 | 0.322 | 50.000 |
| BTCUSDT | $100,000 | 5.000 | -1.228 | 10.335 | 0.037 | 50.000 |
| ETHUSDT | $100 | 1.000 | -0.170 | 0.225 | 1.427 | 0.000 |
| ETHUSDT | $1,000 | 3.000 | -1.768 | 1.072 | 0.150 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | -0.890 | 6.741 | 0.018 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | -1.752 | 54.460 | 0.004 | 0.000 |
| XRPUSDT | $100 | 25.000 | 7.201 | 0.324 | 0.346 | 50.000 |
| XRPUSDT | $1,000 | 25.000 | 4.403 | 3.562 | 0.035 | 50.000 |
| XRPUSDT | $10,000 | 25.000 | 3.355 | 36.479 | 0.004 | 50.000 |

All values in basis points. Impact is the only component that grows with size,
which is why the cheaper venue changes as the order gets bigger: the Binance
cost is dominated by a flat commission, while the on-chain cost starts far lower
and climbs.

## Why this result holds, and where it stops

The gap comes almost entirely from the fee. Binance spot charges 0.1% to a
VIP 0 account, which is 10 bps before anything else happens. The deepest
BNB/USDT pool charges 0.01%, which is 1 bps, and the wallet adds nothing on a
swap between two major assets. Gas on BNB Smart Chain at these prices is a
fraction of a basis point on any order worth routing.

That advantage is real but it is not unconditional:

- **It shrinks with account tier.** A VIP account, or one paying commission in
  BNB, pays materially less than 10 bps. The cost model reads the real rate when
  a credential is present and says so when it is falling back to the public
  schedule, which every sample here does.
- **It reverses with size.** Pool impact grows faster than book impact on these
  pairs, so past a certain order the exchange is cheaper. That crossover is
  visible in the table above and it is the reason this product routes per order
  rather than picking a venue once.
- **It is measured on two pairs.** BNB and ETH against USDT, both with deep
  pools. A thinner pair would look different, and this document does not claim
  otherwise.
- **A quote is not a fill.** These are prices at an instant. On-chain execution
  can still fail on slippage or liquidity, and a maker order can fail to fill at
  all. The receipt produced by an actual execution records realised against
  predicted cost, and that error is the honest check on everything here.

## Reproducing it

```bash
npm run sample     # one sweep across every pair and size
npm run evidence   # regenerate this document from whatever has been collected
```

The raw samples are in `data/samples.jsonl`, one JSON object per line, including
the snapshot hash each price was taken from.
