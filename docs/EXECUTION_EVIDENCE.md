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

- **165 priced comparisons** over **1.6 hours**
- From `2026-09-08T16:56:30.755Z` to `2026-09-08T18:32:07.327Z`
- 426 rows on disk
- 250 earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither
- Cost model version 3

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 39% of 165 samples**, with a median
edge of **-41.48 bps**.

BNBUSDT: on-chain is cheaper to about $10,000, and Binance takes over by $100,000. BTCUSDT: Binance was cheaper at every size sampled. ETHUSDT: on-chain is cheaper to about $10,000, and Binance takes over by $100,000. XRPUSDT: Binance was cheaper at every size sampled.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 11 | 100% | 1.61 bps | 10.07 bps | 8.46 bps |
| BNBUSDT | $1,000 | 11 | 100% | 1.55 bps | 10.07 bps | 8.52 bps |
| BNBUSDT | $10,000 | 11 | 100% | 2.27 bps | 10.07 bps | 7.79 bps |
| BNBUSDT | $100,000 | 11 | 27% | 11.76 bps | 11.63 bps | -0.12 bps |
| BTCUSDT | $100 | 11 | 0% | 51.71 bps | 10.00 bps | -41.72 bps |
| BTCUSDT | $1,000 | 11 | 0% | 52.81 bps | 10.00 bps | -42.82 bps |
| BTCUSDT | $10,000 | 11 | 0% | 55.89 bps | 10.00 bps | -45.89 bps |
| BTCUSDT | $100,000 | 11 | 0% | 64.41 bps | 10.00 bps | -53.91 bps |
| ETHUSDT | $100 | 11 | 100% | 2.66 bps | 10.02 bps | 7.36 bps |
| ETHUSDT | $1,000 | 11 | 100% | 3.37 bps | 10.02 bps | 6.65 bps |
| ETHUSDT | $10,000 | 11 | 55% | 9.86 bps | 10.02 bps | 0.16 bps |
| ETHUSDT | $100,000 | 11 | 0% | 60.22 bps | 10.16 bps | -50.14 bps |
| XRPUSDT | $100 | 11 | 0% | 76.63 bps | 10.15 bps | -67.02 bps |
| XRPUSDT | $1,000 | 11 | 0% | 78.89 bps | 10.25 bps | -69.27 bps |
| XRPUSDT | $10,000 | 11 | 0% | 110.38 bps | 10.22 bps | -100.00 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | 0.126 | 0.009 | 0.575 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | 0.384 | 0.100 | 0.058 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | 0.198 | 1.005 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | 0.232 | 10.175 | 0.003 | 0.000 |
| BTCUSDT | $100 | 1.000 | -0.402 | 0.243 | 0.664 | 50.000 |
| BTCUSDT | $1,000 | 1.000 | -1.070 | 2.677 | 0.070 | 50.000 |
| BTCUSDT | $10,000 | 5.000 | -0.155 | 1.040 | 0.007 | 50.000 |
| BTCUSDT | $100,000 | 5.000 | -0.918 | 10.348 | 0.001 | 50.000 |
| ETHUSDT | $100 | 1.000 | 0.070 | 0.225 | 0.652 | 0.000 |
| ETHUSDT | $1,000 | 1.000 | -0.465 | 2.473 | 0.069 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | -1.515 | 6.744 | 0.009 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | -1.435 | 54.707 | 0.002 | 0.000 |
| XRPUSDT | $100 | 25.000 | 0.687 | 0.285 | 0.663 | 50.000 |
| XRPUSDT | $1,000 | 25.000 | 0.687 | 3.135 | 0.069 | 50.000 |
| XRPUSDT | $10,000 | 25.000 | -0.004 | 35.009 | 0.009 | 50.000 |

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
