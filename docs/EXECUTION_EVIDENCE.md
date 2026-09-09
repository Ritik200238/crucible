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

- **675 priced comparisons** over **7.3 hours**
- From `2026-09-08T16:56:30.755Z` to `2026-09-09T00:12:07.525Z`
- 970 rows on disk
- 250 earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither
- Cost model version 3

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 41% of 675 samples**, with a median
edge of **-41.25 bps**.

BNBUSDT: on-chain was cheaper at every size sampled, up to $100,000. BTCUSDT: Binance was cheaper at every size sampled. ETHUSDT: on-chain is cheaper to about $1,000, and Binance takes over by $10,000. XRPUSDT: Binance was cheaper at every size sampled.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 45 | 100% | 1.50 bps | 10.07 bps | 8.59 bps |
| BNBUSDT | $1,000 | 45 | 100% | 1.11 bps | 10.07 bps | 8.92 bps |
| BNBUSDT | $10,000 | 45 | 100% | 1.95 bps | 10.07 bps | 8.12 bps |
| BNBUSDT | $100,000 | 45 | 69% | 11.04 bps | 11.80 bps | 0.48 bps |
| BTCUSDT | $100 | 45 | 0% | 51.70 bps | 10.00 bps | -41.70 bps |
| BTCUSDT | $1,000 | 45 | 0% | 53.40 bps | 10.00 bps | -43.40 bps |
| BTCUSDT | $10,000 | 45 | 0% | 56.24 bps | 10.00 bps | -46.24 bps |
| BTCUSDT | $100,000 | 45 | 0% | 65.52 bps | 10.00 bps | -55.47 bps |
| ETHUSDT | $100 | 45 | 100% | 2.15 bps | 10.02 bps | 7.87 bps |
| ETHUSDT | $1,000 | 45 | 100% | 2.96 bps | 10.02 bps | 7.06 bps |
| ETHUSDT | $10,000 | 45 | 44% | 10.73 bps | 10.02 bps | -0.71 bps |
| ETHUSDT | $100,000 | 45 | 0% | 64.28 bps | 10.19 bps | -53.69 bps |
| XRPUSDT | $100 | 45 | 0% | 81.21 bps | 10.17 bps | -70.98 bps |
| XRPUSDT | $1,000 | 45 | 0% | 82.04 bps | 10.19 bps | -72.02 bps |
| XRPUSDT | $10,000 | 45 | 0% | 111.62 bps | 10.22 bps | -101.35 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | -0.106 | 0.009 | 0.574 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | -0.032 | 0.099 | 0.058 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | -0.073 | 1.005 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | -0.191 | 10.068 | 0.003 | 0.000 |
| BTCUSDT | $100 | 1.000 | -0.360 | 0.241 | 0.691 | 50.000 |
| BTCUSDT | $1,000 | 1.000 | -0.470 | 2.655 | 0.070 | 50.000 |
| BTCUSDT | $10,000 | 5.000 | 0.194 | 1.041 | 0.007 | 50.000 |
| BTCUSDT | $100,000 | 5.000 | 0.194 | 10.417 | 0.001 | 50.000 |
| ETHUSDT | $100 | 1.000 | 0.070 | 0.225 | 0.660 | 0.000 |
| ETHUSDT | $1,000 | 1.000 | -0.639 | 2.475 | 0.069 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | -1.019 | 6.745 | 0.008 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | -1.019 | 61.459 | 0.002 | 0.000 |
| XRPUSDT | $100 | 25.000 | 5.231 | 0.286 | 0.691 | 50.000 |
| XRPUSDT | $1,000 | 25.000 | 3.817 | 3.146 | 0.069 | 50.000 |
| XRPUSDT | $10,000 | 25.000 | 3.817 | 31.831 | 0.009 | 50.000 |

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
