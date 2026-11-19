# PolyLean (updated v2)

A self-updating site that compares live Polymarket prices with outside forecasts (Kalshi, PredictIt, Manifold), calculates its own chance of Yes and No for every market, and gives a specific action (Buy Yes / Buy No, limit price, walk-away price, stake) only when the chance is at least 70% and the price is right.

## How it works
- Every time the page opens (and every 10 minutes while open) it fetches live prices. No server and no manual runs.
- Sources: Kalshi and PredictIt (real money, count more) and Manifold (play money, counts less). A source is used only if it is the exact same question (same numbers and years).
- The chance is Polymarket's price moved only part of the way toward the sources' weighted average.
- Scorecard: every lean is recorded in your browser and marked won or lost when the market resolves.

## Files (upload to the repository, top level)
- index.html
- engine.js
- app.js
- _redirects  (it now has 4 lines; the new one is the PredictIt line)
- README.md

## Limits
- Not tested against the live servers (the build environment could not reach them). Tested with simulated responses only.
- Output is a model estimate, not financial advice. Prediction markets can lose your whole stake.
- Metaculus was not added because its access rules could not be confirmed.
