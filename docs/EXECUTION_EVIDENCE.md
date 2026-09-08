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

- **8 priced comparisons** over **20 seconds**
- From `2026-09-08T13:56:45.123Z` to `2026-09-08T13:57:05.118Z`
- 114 rows on disk
- 106 earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither
- Cost model version 2

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 88% of 8 samples**, with a median
edge of **7.64 bps**.

BNBUSDT: on-chain was cheaper at every size sampled, up to $100,000. ETHUSDT: on-chain is cheaper to about $10,000, and Binance takes over by $100,000.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1 | 100% | 1.25 bps | 10.07 bps | 8.81 bps |
| BNBUSDT | $1,000 | 1 | 100% | -0.29 bps | 10.07 bps | 10.35 bps |
| BNBUSDT | $10,000 | 1 | 100% | 1.28 bps | 11.03 bps | 9.74 bps |
| BNBUSDT | $100,000 | 1 | 100% | 11.75 bps | 12.17 bps | 0.41 bps |
| ETHUSDT | $100 | 1 | 100% | 3.08 bps | 10.02 bps | 6.94 bps |
| ETHUSDT | $1,000 | 1 | 100% | 1.69 bps | 10.02 bps | 8.33 bps |
| ETHUSDT | $10,000 | 1 | 100% | 7.21 bps | 9.69 bps | 2.47 bps |
| ETHUSDT | $100,000 | 1 | 0% | 69.11 bps | 9.64 bps | -59.48 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | -0.306 | -0.011 | 0.570 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | -1.275 | -0.088 | 0.076 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | -0.794 | 1.069 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | -0.515 | 11.265 | 0.003 | 0.000 |
| ETHUSDT | $100 | 1.000 | 1.313 | -1.474 | 2.238 | 0.000 |
| ETHUSDT | $1,000 | 5.000 | -4.223 | 0.685 | 0.227 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | -4.721 | 6.911 | 0.025 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | -4.355 | 68.460 | 0.006 | 0.000 |

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
