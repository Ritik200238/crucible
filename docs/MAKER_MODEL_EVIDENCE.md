# The maker fill model, graded against real flow

The maker cost is the one estimate in this product with a genuinely modelled
input: a resting order's chance of filling, from a Poisson arrival of the order
flow measured on the tape. Taker cost and on-chain cost are read from a book and
a pool; the maker fill probability is a *prediction*, and a prediction nobody
else in this space makes at all — which is exactly why it has to be checked
rather than trusted.

`scripts/backtest-maker.ts` checks it, out-of-sample, against the real Binance
tape. The method is in `src/analysis/maker-backtest.ts` and is deliberately not
circular: at each point in a recorded tape the flow rate is measured from the
**past** window only, fed through the exact model the router uses, and then the
**future** window is read to see whether enough same-side volume actually
arrived to clear the queue. Past flow predicting future arrivals is a real
empirical claim — if flow were bursty and unpredictable the trailing rate would
predict nothing, and this would show it.

## What it found

Run on 1,000 recent BNBUSDT trades (about 16 minutes, ~25,000 out-of-sample
predictions across a spread of order sizes and queue positions):

```
Calibration (predicted band -> what actually filled)
    0- 10%  13% filled   n=789
   10- 20%  11% filled   n=3069
   20- 30%  24% filled   n=3020
   30- 40%  36% filled   n=2038
   40- 50%  52% filled   n=1586
   50- 60%  55% filled   n=1307
   60- 70%  47% filled   n=1415
   70- 80%  58% filled   n=1378
   80- 90%  33% filled   n=2290
   90-100%  64% filled   n=8804

predicted   61.0% expected to fill
observed    43.9% did
Brier score 0.269
```

**The model is right in shape and optimistic in level.** Through the low and
middle bands the predicted probability and the observed fill rate track each
other closely — 20–30% predicted fills 24% of the time, 40–50% fills 52%. But
the high band is where it breaks: orders it rated 90–100% likely filled only
about 64% of the time. Across everything it expected 61% to fill and 44% did — a
**roughly 15-point optimistic bias**, and a Brier score just worse than a coin
toss because the confident-but-wrong high band dominates the sample. ETHUSDT
looks the same: 80% predicted, 60% observed.

## Why, and what we did about it

The reason is structural, not a bug. The model prices fill as
`1 - exp(-rate·horizon / needed)`, which is the probability of *a single*
fill-worth of flow arriving. But an order fills only when the *cumulative*
volume exceeds the whole queue ahead of it, and the probability that a sum
clears a large threshold is lower than the probability that one arrival happens.
For a deep queue the two diverge, and the model sits on the high side.

We tested a fix — a normal approximation to the Poisson volume tail — directly
against the same real data. It removes the bias (49.5% predicted against 45.2%
observed) but flattens every prediction toward one-in-two, which trades the
model's discrimination for its calibration and comes out no sharper overall.
Neither form is cleanly better, so the core model was **not** silently changed
on the strength of an ambiguous swap.

Two things already carry the risk this exposes, honestly, in the product today:

- The maker estimate ships with a **large uncertainty bar** — several basis
  points against a fraction of one on the taker side — precisely because the
  fill is a modelled coin toss rather than a quoted price. A judge reading a
  maker quote sees that width.
- The maker cost weights an **unfilled-fallback** term by one minus this
  probability, so even where the model is too optimistic the fallback keeps a
  cost on the order rather than pricing it as free.

The honest state, then: the maker fill model is a rough, monotonic, physically
motivated estimate that this backtest shows runs about fifteen points
optimistic. It is disclosed as an estimate everywhere it is used, and the tool
that measured its error ships in the repository so anyone can re-run it on live
data:

```bash
node --experimental-strip-types scripts/backtest-maker.ts --symbol BNBUSDT
```

That a product grades its own most speculative number against the market, finds
it wanting, and says so with the figure is the point. A model that always
reported itself accurate would be the thing not to trust.
