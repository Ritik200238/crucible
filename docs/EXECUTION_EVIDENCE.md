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

- **75 priced comparisons** over **36 minutes**
- From `2026-09-08T16:56:30.755Z` to `2026-09-08T17:32:06.885Z`
- 330 rows on disk
- 250 earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither
- Cost model version 3

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 37% of 75 samples**, with a median
edge of **-41.58 bps**.

BNBUSDT: on-chain is cheaper to about $10,000, and Binance takes over by $100,000. BTCUSDT: Binance was cheaper at every size sampled. ETHUSDT: on-chain is cheaper to about $1,000, and Binance takes over by $10,000. XRPUSDT: Binance was cheaper at every size sampled.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 5 | 100% | 1.52 bps | 10.07 bps | 8.55 bps |
| BNBUSDT | $1,000 | 5 | 100% | 1.50 bps | 10.07 bps | 8.57 bps |
| BNBUSDT | $10,000 | 5 | 100% | 2.15 bps | 10.07 bps | 7.91 bps |
| BNBUSDT | $100,000 | 5 | 20% | 13.73 bps | 11.67 bps | -1.43 bps |
| BTCUSDT | $100 | 5 | 0% | 51.73 bps | 10.00 bps | -41.73 bps |
| BTCUSDT | $1,000 | 5 | 0% | 52.81 bps | 10.00 bps | -42.82 bps |
| BTCUSDT | $10,000 | 5 | 0% | 55.89 bps | 10.00 bps | -45.89 bps |
| BTCUSDT | $100,000 | 5 | 0% | 64.41 bps | 10.00 bps | -53.91 bps |
| ETHUSDT | $100 | 5 | 100% | 2.67 bps | 10.02 bps | 7.22 bps |
| ETHUSDT | $1,000 | 5 | 100% | 2.25 bps | 10.02 bps | 7.33 bps |
| ETHUSDT | $10,000 | 5 | 40% | 13.62 bps | 10.02 bps | -3.60 bps |
| ETHUSDT | $100,000 | 5 | 0% | 59.85 bps | 10.03 bps | -49.66 bps |
| XRPUSDT | $100 | 5 | 0% | 82.31 bps | 10.33 bps | -71.99 bps |
| XRPUSDT | $1,000 | 5 | 0% | 83.43 bps | 10.28 bps | -73.68 bps |
| XRPUSDT | $10,000 | 5 | 0% | 114.20 bps | 10.31 bps | -104.36 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | 0.126 | 0.009 | 0.576 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | 0.337 | 0.100 | 0.058 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | 0.140 | 1.049 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | -0.191 | 10.775 | 0.003 | 0.000 |
| BTCUSDT | $100 | 1.000 | -0.428 | 0.243 | 0.696 | 50.000 |
| BTCUSDT | $1,000 | 1.000 | -1.070 | 2.677 | 0.070 | 50.000 |
| BTCUSDT | $10,000 | 5.000 | -0.155 | 1.040 | 0.009 | 50.000 |
| BTCUSDT | $100,000 | 5.000 | -0.918 | 10.345 | 0.001 | 50.000 |
| ETHUSDT | $100 | 1.000 | -0.410 | 0.225 | 0.652 | 0.000 |
| ETHUSDT | $1,000 | 1.000 | -0.465 | 1.647 | 0.069 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | 1.866 | 6.745 | 0.009 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | 0.141 | 54.707 | 0.002 | 0.000 |
| XRPUSDT | $100 | 25.000 | 6.988 | 0.324 | 0.691 | 50.000 |
| XRPUSDT | $1,000 | 25.000 | 5.230 | 3.560 | 0.069 | 50.000 |
| XRPUSDT | $10,000 | 25.000 | 6.635 | 36.334 | 0.009 | 50.000 |

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
