/* PolyLean engine: matching, scoring and scorecard maths. No network code here,
   so it can be tested in Node and reused in the browser. */
(function (root) {
  "use strict";

  const SETTINGS = {
    MIN_EDGE: 0.06,          // gap needed after paying the spread before we lean
    MAX_SHRINK: 0.6,         // never move more than 60% of the way from market to sources
    MIN_PRICE: 0.03, MAX_PRICE: 0.97,
    MIN_SIM: { kalshi: 0.5, manifold: 0.55 },
    MIN_VOLUME_24H: 1000,
    BASE_WEIGHT: { kalshi: 1.0, manifold: 0.5 }, // real money counts more than play money
  };

  const STOP = new Set(("will the a an of in on by to be is are for at or and as with from than this that it its " +
    "any before after during if then over under between who what when which how many much " +
    "does do did has have had been not no yes").split(" "));
  const TOKEN_RE = /\$?\d[\d,]*\.?\d*\s?[kmb]?\b|[a-z][a-z'\-]+/g;

  const num = (x, d = null) => {
    if (x === null || x === undefined || x === "") return d;
    const v = Number(x);
    return Number.isFinite(v) ? v : d;
  };

  function canonNumber(tok) {
    let t = tok.replace(/[$, ]/g, "").toLowerCase();
    let mult = 1;
    if (t.length && "kmb".includes(t[t.length - 1])) {
      mult = { k: 1e3, m: 1e6, b: 1e9 }[t[t.length - 1]];
      t = t.slice(0, -1);
    }
    const v = parseFloat(t);
    return Number.isFinite(v) ? String(Math.round(v * mult * 1e6) / 1e6) : null;
  }

  /** Content words and numbers. Numbers are compared exactly, so "$90k" never matches "$100k". */
  function tokens(text) {
    const words = new Set(), nums = new Set();
    for (const m of String(text || "").toLowerCase().matchAll(TOKEN_RE)) {
      const t = m[0];
      if (/[\d$]/.test(t[0])) {
        const c = canonNumber(t);
        if (c) nums.add(c);
      } else if (!STOP.has(t) && t.length > 1) {
        words.add(t);
      }
    }
    return { words, nums };
  }

  const sameSet = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  function similarity(a, b) {
    if (!sameSet(a.nums, b.nums)) return 0;
    if (!a.words.size || !b.words.size) return 0;
    let inter = 0;
    for (const w of a.words) if (b.words.has(w)) inter++;
    return inter / (a.words.size + b.words.size - inter);
  }

  function searchTerm(question, n = 6) {
    return [...tokens(question).words]
      .sort((x, y) => y.length - x.length || (x < y ? -1 : 1))
      .slice(0, n).join(" ");
  }

  const CATEGORY_WORDS = {
    Crypto: "bitcoin btc ethereum eth solana crypto token coinbase binance stablecoin xrp dogecoin".split(" "),
    Politics: ("election president presidential senate congress trump biden vance nominee party vote governor " +
      "mayor parliament minister primary republican democratic democrat poll").split(" "),
    Sports: ("nfl nba mlb nhl fifa uefa premier league cup champions super bowl world series match game vs goals " +
      "points rebounds touchdown tennis ufc f1 grand prix").split(" "),
    Finance: ("fed rate rates inflation cpi gdp stock stocks nasdaq s&p sp500 earnings ipo recession oil gold " +
      "ceo market cap").split(" "),
  };
  function categorize(question) {
    const words = new Set((String(question || "").toLowerCase().match(/[a-z&0-9]+/g)) || []);
    for (const [cat, kws] of Object.entries(CATEGORY_WORDS)) if (kws.some((k) => words.has(k))) return cat;
    return "World & Other";
  }

  // ---- normalising API records --------------------------------------------
  function normalizePm(r) {
    let outcomes, prices;
    try {
      outcomes = JSON.parse(r.outcomes || "[]");
      prices = JSON.parse(r.outcomePrices || "[]").map(Number);
    } catch (e) { return null; }
    if (outcomes.length !== 2 || String(outcomes[0]).toLowerCase() !== "yes" ||
        String(outcomes[1]).toLowerCase() !== "no" || prices.length !== 2 || prices.some((p) => !Number.isFinite(p))) return null;
    if (r.closed || r.acceptingOrders === false) return null;
    const price = prices[0];
    let bid = num(r.bestBid), ask = num(r.bestAsk);
    if (bid === null || ask === null || ask <= 0 || bid > ask) { bid = price; ask = price; }
    const ev = (r.events && r.events[0]) || {};
    const slug = ev.slug || r.slug || "";
    return {
      id: String(r.id), question: r.question || "",
      url: slug ? "https://polymarket.com/event/" + slug : "https://polymarket.com",
      category: categorize(r.question), end: r.endDate || null,
      price, bid, ask, volume24h: num(r.volume24hr, 0), liquidity: num(r.liquidityNum, 0),
    };
  }

  function normalizeKalshi(m) {
    if (m.mve_collection_ticker || String(m.ticker || "").startsWith("KXMVE")) return null;
    if (m.market_type !== "binary") return null;
    const bid = num(m.yes_bid_dollars, 0), ask = num(m.yes_ask_dollars, 1), last = num(m.last_price_dollars, 0);
    let p;
    if (bid > 0 && ask < 1 && ask >= bid) p = (bid + ask) / 2; else if (last > 0) p = last; else return null;
    const title = [m.title, m.yes_sub_title].filter(Boolean).join(" ");
    return {
      kind: "kalshi", title, prob: p,
      url: "https://kalshi.com/markets/" + String(m.event_ticker || "").toLowerCase(),
      strength: Math.min(1, num(m.volume_fp, 0) / 5000),
    };
  }

  function normalizeManifold(it) {
    const p = num(it.probability);
    if (p === null || it.isResolved) return null;
    return {
      kind: "manifold", title: it.question || "", url: it.url || "", prob: p,
      strength: Math.min(1, (it.uniqueBettorCount || 0) / 30),
    };
  }

  // ---- model ----------------------------------------------------------------
  /** Reason to skip before even looking for sources ("" means worth a look). */
  function preCheck(pm, now = new Date()) {
    const p = pm.price;
    if (!(p >= SETTINGS.MIN_PRICE && p <= SETTINGS.MAX_PRICE)) return "Price is already extreme, so there is little to gain.";
    if (pm.volume24h < SETTINGS.MIN_VOLUME_24H) return "Too little trading volume to trust the price or exit easily.";
    const end = pm.end ? new Date(pm.end) : null;
    if (end && !isNaN(end) && end - now < 3600e3) return "Closes within an hour.";
    return "";
  }

  function matchSources(pm, kalshiIdx, manifoldCands) {
    const me = tokens(pm.question);
    const found = [];
    for (const c of kalshiIdx) {
      const s = similarity(me, c.tok || tokens(c.title));
      if (s >= SETTINGS.MIN_SIM.kalshi) found.push(Object.assign({}, c, { sim: Math.round(s * 100) / 100 }));
    }
    for (const c of manifoldCands) {
      const s = similarity(me, tokens(c.title));
      if (s >= SETTINGS.MIN_SIM.manifold) found.push(Object.assign({}, c, { sim: Math.round(s * 100) / 100 }));
    }
    let best = [];
    for (const kind of ["kalshi", "manifold"]) {
      best = best.concat(found.filter((c) => c.kind === kind).sort((a, b) => b.sim - a.sim).slice(0, 2));
    }
    return best.map(({ kind, title, url, prob, sim, strength }) => ({ kind, title, url, prob, sim, strength }));
  }

  function score(pm, sources, now = new Date()) {
    const res = { model_p: pm.price, edge: 0, lean: "Skip", confidence: "-", reason: "" };
    const pre = preCheck(pm, now);
    if (pre) { res.reason = pre; return res; }
    if (!sources.length) { res.reason = "No independent forecast found for this exact question."; return res; }

    const src = sources.map((s) => Object.assign({}, s, {
      weight: Math.round(SETTINGS.BASE_WEIGHT[s.kind] * s.sim * (0.3 + 0.7 * s.strength) * 1000) / 1000 }));
    const wsum = src.reduce((a, s) => a + s.weight, 0);
    const q = src.reduce((a, s) => a + s.weight * s.prob, 0) / wsum;
    const k = Math.min(SETTINGS.MAX_SHRINK, SETTINGS.MAX_SHRINK * wsum);
    const modelP = pm.price + k * (q - pm.price);
    // what it would really cost: pay the ask for Yes, sell into the bid for No
    const edgeYes = modelP - pm.ask, edgeNo = pm.bid - modelP;
    res.model_p = Math.round(modelP * 1e4) / 1e4;
    res.consensus = Math.round(q * 1e4) / 1e4;
    res.sources = src;

    let lean, edge, dir;
    if (edgeYes >= SETTINGS.MIN_EDGE) { lean = "Yes"; edge = edgeYes; dir = 1; }
    else if (edgeNo >= SETTINGS.MIN_EDGE) { lean = "No"; edge = edgeNo; dir = -1; }
    else {
      res.edge = Math.round(Math.max(edgeYes, edgeNo) * 1e4) / 1e4;
      res.reason = "Sources roughly agree with the market, or the gap is smaller than the spread.";
      return res;
    }
    const agreeing = src.filter((s) => (s.prob - pm.price) * dir > 0.02);
    const agree = agreeing.length;
    const kalshiAgrees = agreeing.some((s) => s.kind === "kalshi");
    let conf;
    if (edge >= 0.10 && agree === src.length && src.length >= 2 && kalshiAgrees) conf = "High";
    else if (edge >= 0.08 && agree >= Math.max(1, src.length - 1)) conf = "Medium";
    else conf = "Low";
    Object.assign(res, { lean, edge: Math.round(edge * 1e4) / 1e4, confidence: conf,
      reason: agree + " of " + src.length + " matched sources sit on the " + lean + " side of the market price." });
    return res;
  }

  // ---- scorecard ------------------------------------------------------------
  const buyPrice = (rec) => (rec.lean === "Yes" ? rec.ask : 1 - rec.bid);

  function updateLedger(ledger, picks, nowIso) {
    const have = new Set(ledger.entries.map((e) => e.id));
    for (const r of picks) {
      if (r.lean === "Skip" || have.has(r.id)) continue;
      ledger.entries.push({
        id: r.id, question: r.question, url: r.url, lean: r.lean, confidence: r.confidence,
        entry_price: Math.round(buyPrice(r) * 1e4) / 1e4, market_p: r.price, model_p: r.model_p,
        published: nowIso, end: r.end || null, outcome: null });
      have.add(r.id);
    }
  }

  /** 1 if Yes won, 0 if No won, null if not cleanly resolved. */
  function resolvedOutcome(m) {
    let prices;
    try { prices = JSON.parse(m.outcomePrices || "[]").map(Number); } catch (e) { return null; }
    if (!m.closed || m.umaResolutionStatus !== "resolved" || prices.length !== 2) return null;
    if (prices[0] >= 0.99 && prices[1] <= 0.01) return 1;
    if (prices[1] >= 0.99 && prices[0] <= 0.01) return 0;
    return null;
  }

  function applyResolutions(ledger, fetchedMarkets) {
    for (const m of fetchedMarkets) {
      const y = resolvedOutcome(m);
      if (y === null) continue;
      for (const e of ledger.entries) if (e.id === String(m.id) && e.outcome === null) e.outcome = y ? "Yes" : "No";
    }
  }

  const entryReturn = (e) => (e.lean === e.outcome ? (1 - e.entry_price) / e.entry_price : -1);

  function computeStats(entries) {
    const done = entries.filter((e) => e.outcome === "Yes" || e.outcome === "No");
    const n = done.length;
    const st = { published: entries.length, resolved: n, open: entries.length - n };
    if (!n) return st;
    const y = (e) => (e.outcome === "Yes" ? 1 : 0);
    st.hit_rate = done.filter((e) => e.lean === e.outcome).length / n;
    st.avg_return_per_dollar = done.reduce((a, e) => a + entryReturn(e), 0) / n;
    st.brier_model = done.reduce((a, e) => a + (e.model_p - y(e)) ** 2, 0) / n;
    st.brier_market = done.reduce((a, e) => a + (e.market_p - y(e)) ** 2, 0) / n;
    return st;
  }

  const api = { SETTINGS, tokens, similarity, searchTerm, categorize, normalizePm, normalizeKalshi,
    normalizeManifold, preCheck, matchSources, score, buyPrice, updateLedger, resolvedOutcome,
    applyResolutions, entryReturn, computeStats };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.PolyLean = api;
})(typeof window !== "undefined" ? window : globalThis);
