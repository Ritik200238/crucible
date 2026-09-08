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

- **630 priced comparisons** over **6.8 hours**
- From `2026-09-08T16:56:30.755Z` to `2026-09-08T23:42:07.453Z`
- 922 rows on disk
- 250 earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither
- Cost model version 3

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 41% of 630 samples**, with a median
edge of **-41.35 bps**.

BNBUSDT: on-chain was cheaper at every size sampled, up to $100,000. BTCUSDT: Binance was cheaper at every size sampled. ETHUSDT: on-chain is cheaper to about $1,000, and Binance takes over by $10,000. XRPUSDT: Binance was cheaper at every size sampled.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 42 | 100% | 1.46 bps | 10.07 bps | 8.63 bps |
| BNBUSDT | $1,000 | 42 | 100% | 1.09 bps | 10.07 bps | 8.94 bps |
| BNBUSDT | $10,000 | 42 | 100% | 1.95 bps | 10.07 bps | 8.12 bps |
| BNBUSDT | $100,000 | 42 | 67% | 11.03 bps | 11.81 bps | 0.47 bps |
| BTCUSDT | $100 | 42 | 0% | 51.70 bps | 10.00 bps | -41.70 bps |
| BTCUSDT | $1,000 | 42 | 0% | 53.40 bps | 10.00 bps | -43.40 bps |
| BTCUSDT | $10,000 | 42 | 0% | 56.28 bps | 10.00 bps | -46.28 bps |
| BTCUSDT | $100,000 | 42 | 0% | 65.56 bps | 10.00 bps | -55.54 bps |
| ETHUSDT | $100 | 42 | 100% | 2.15 bps | 10.02 bps | 7.85 bps |
| ETHUSDT | $1,000 | 42 | 100% | 3.02 bps | 10.02 bps | 6.95 bps |
| ETHUSDT | $10,000 | 42 | 43% | 11.08 bps | 10.02 bps | -1.02 bps |
| ETHUSDT | $100,000 | 42 | 0% | 64.35 bps | 10.21 bps | -54.04 bps |
| XRPUSDT | $100 | 42 | 0% | 81.52 bps | 10.18 bps | -71.34 bps |
| XRPUSDT | $1,000 | 42 | 0% | 82.74 bps | 10.22 bps | -72.62 bps |
| XRPUSDT | $10,000 | 42 | 0% | 111.82 bps | 10.23 bps | -101.56 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | -0.130 | 0.009 | 0.574 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | -0.063 | 0.100 | 0.057 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | -0.071 | 1.005 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | -0.139 | 10.077 | 0.003 | 0.000 |
| BTCUSDT | $100 | 1.000 | -0.342 | 0.241 | 0.692 | 50.000 |
| BTCUSDT | $1,000 | 1.000 | -0.468 | 2.655 | 0.070 | 50.000 |
| BTCUSDT | $10,000 | 5.000 | 0.230 | 1.041 | 0.007 | 50.000 |
| BTCUSDT | $100,000 | 5.000 | 0.230 | 10.417 | 0.001 | 50.000 |
| ETHUSDT | $100 | 1.000 | 0.114 | 0.225 | 0.652 | 0.000 |
| ETHUSDT | $1,000 | 1.000 | -0.610 | 2.475 | 0.069 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | -0.673 | 6.745 | 0.008 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | -0.628 | 61.454 | 0.002 | 0.000 |
| XRPUSDT | $100 | 25.000 | 5.499 | 0.286 | 0.691 | 50.000 |
| XRPUSDT | $1,000 | 25.000 | 4.524 | 3.147 | 0.069 | 50.000 |
| XRPUSDT | $10,000 | 25.000 | 4.524 | 31.841 | 0.009 | 50.000 |

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
