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

- **26 priced comparisons** over **0.3 hours**
- From `2026-09-08T11:54:14.045Z` to `2026-09-08T12:14:47.686Z`
- 26 rows on disk

> This span is under a day. It is enough to show the shape of the cost curve and
> the size at which the cheaper venue changes, and it is **not** enough to say
> anything about how either venue behaves across a full market cycle.

## What it shows

**On-chain was cheaper in 65% of 26 samples**, with a median
edge of **5.29 bps**.

BNBUSDT: on-chain is cheaper to about $10,000, and Binance takes over by $100,000. ETHUSDT: on-chain is cheaper to about $1,000, and Binance takes over by $10,000.

| Pair | Order size | Samples | On-chain cheaper | Median on-chain | Median Binance | Median edge |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 3 | 100% | 2.07 bps | 10.04 bps | 7.98 bps |
| BNBUSDT | $1,000 | 4 | 100% | 1.92 bps | 10.03 bps | 8.11 bps |
| BNBUSDT | $10,000 | 3 | 100% | 2.89 bps | 10.00 bps | 7.18 bps |
| BNBUSDT | $100,000 | 3 | 0% | 12.28 bps | 10.38 bps | -1.69 bps |
| ETHUSDT | $100 | 3 | 100% | 4.85 bps | 10.01 bps | 5.16 bps |
| ETHUSDT | $1,000 | 4 | 100% | 4.73 bps | 10.01 bps | 5.29 bps |
| ETHUSDT | $10,000 | 3 | 0% | 16.31 bps | 10.01 bps | -6.30 bps |
| ETHUSDT | $100,000 | 3 | 0% | 77.12 bps | 10.26 bps | -66.87 bps |

The edge is the better of the two Binance routes minus the on-chain route, so a
positive number means on-chain won.

## Where the on-chain cost goes

| Pair | Order size | pool fee | venue divergence | price impact | gas | wallet service fee |
|---|---|---|---|---|---|---|
| BNBUSDT | $100 | 1.000 | 0.487 | 0.010 | 0.573 | 0.000 |
| BNBUSDT | $1,000 | 1.000 | 0.760 | 0.106 | 0.057 | 0.000 |
| BNBUSDT | $10,000 | 1.000 | 0.771 | 1.061 | 0.009 | 0.000 |
| BNBUSDT | $100,000 | 1.000 | 0.891 | 9.531 | 0.003 | 0.000 |
| ETHUSDT | $100 | 1.000 | 0.123 | 0.226 | 2.141 | 0.000 |
| ETHUSDT | $1,000 | 1.000 | 1.040 | 2.481 | 0.224 | 0.000 |
| ETHUSDT | $10,000 | 5.000 | 4.502 | 6.777 | 0.027 | 0.000 |
| ETHUSDT | $100,000 | 5.000 | 4.502 | 67.442 | 0.006 | 0.000 |

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
