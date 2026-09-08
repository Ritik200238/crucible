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

- **40 priced comparisons** over **40 minutes**
- From `2026-09-08T13:56:45.123Z` to `2026-09-08T14:37:03.312Z`
- 146 rows on disk
- 106 earlier rows excluded: they were priced under an older cost model, and averaging two models together would describe neither
- Cost model version 2

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 78% of 40 samples**, with a median
edge of **6.83 bps**.

BNBUSDT: on-chain was cheaper at every size sampled, up to $100,000. ETHUSDT: on-chain is cheaper to about $1,000, and Binance takes over by $10,000.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 5 | 100% | 1.25 bps | 10.07 bps | 8.81 bps |
| BNBUSDT | $1,000 | 5 | 100% | 1.14 bps | 10.07 bps | 8.92 bps |
| BNBUSDT | $10,000 | 5 | 100% | 2.48 bps | 10.17 bps | 7.67 bps |
| BNBUSDT | $100,000 | 5 | 80% | 11.75 bps | 12.17 bps | 0.43 bps |
| ETHUSDT | $100 | 5 | 100% | 3.11 bps | 10.02 bps | 6.91 bps |
| ETHUSDT | $1,000 | 5 | 100% | 3.27 bps | 10.02 bps | 6.75 bps |
| ETHUSDT | $10,000 | 5 | 40% | 13.34 bps | 10.02 bps | -3.32 bps |
| ETHUSDT | $100,000 | 5 | 0% | 74.22 bps | 10.03 bps | -63.61 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | -0.306 | 0.010 | 0.571 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | 0.224 | 0.045 | 0.057 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | 0.397 | 1.069 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | -0.515 | 10.811 | 0.003 | 0.000 |
| ETHUSDT | $100 | 1.000 | -0.034 | 0.225 | 1.921 | 0.000 |
| ETHUSDT | $1,000 | 1.000 | -0.438 | 2.478 | 0.226 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | 1.403 | 6.765 | 0.025 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | 0.793 | 66.598 | 0.006 | 0.000 |

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
