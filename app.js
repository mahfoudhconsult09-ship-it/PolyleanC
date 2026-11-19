/* PolyLean v2 app: live prices in the visitor's browser, chance for every market,
   a minimum-chance filter, and a concrete action plan. Needs engine.js loaded first. */
(function () {
  "use strict";
  const PL = window.PolyLean;
  const $ = (s) => document.querySelector(s);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "text") n.textContent = v; else if (k === "class") n.className = v; else n.setAttribute(k, v);
    }
    kids.flat().forEach((k) => n.append(k));
    return n;
  };
  const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
  const cents = (x) => Math.round(x * 100) + "¢";
  const centsDown = (x) => Math.floor(x * 100 + 1e-9) + "¢";   // walk-away prices round down, never up
  const money = (x) => "$" + (x >= 100 ? Math.round(x).toLocaleString("en-US") : x.toFixed(2));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

  // ---- storage (can fail in private mode, so everything is wrapped) ----------
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const LEDGER_KEY = "polylean.ledger.v1";   // same key as v1, so an existing scorecard carries over

  // ---- network ---------------------------------------------------------------
  const DIRECT = { gamma: "https://gamma-api.polymarket.com", manifold: "https://api.manifold.markets",
    kalshi: "https://api.elections.kalshi.com", predictit: "https://www.predictit.org" };
  const route = {};

  function qs(params) {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params || {})) (Array.isArray(v) ? v : [v]).forEach((x) => u.append(k, x));
    const s = u.toString();
    return s ? "?" + s : "";
  }

  async function fetchJson(url, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctl.signal });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (!(r.headers.get("content-type") || "").includes("json")) throw new Error("not JSON");
      return await r.json();
    } finally { clearTimeout(timer); }
  }

  /** Netlify's forwarding path first (no browser restrictions), then the source directly. */
  async function api(kind, path, params, ms = 20000) {
    const bases = route[kind] ? [route[kind]] : ["/proxy/" + kind, DIRECT[kind]];
    let last;
    for (const b of bases) {
      try { const j = await fetchJson(b + path + qs(params), ms); route[kind] = b; return j; } catch (e) { last = e; }
    }
    throw last;
  }

  // ---- data steps --------------------------------------------------------------
  const STALE_MIN = 30;
  const fresh = (c) => c && Date.now() - c.t < STALE_MIN * 60e3;

  async function loadPolymarket() {
    const pages = await Promise.all([0, 100].map((offset) =>
      api("gamma", "/markets", { active: "true", closed: "false", order: "volume24hr", ascending: "false", limit: 100, offset })));
    return pages.flat().map(PL.normalizePm).filter(Boolean);
  }

  async function loadKalshi() {
    const cached = store.get("polylean.kalshi", null);
    if (fresh(cached)) return cached.items.map((i) => Object.assign(i, { tok: PL.tokens(i.title) }));
    const items = [];
    let cursor = "";
    for (let page = 0; page < 2; page++) {
      const p = { limit: 1000, status: "open", mve_filter: "exclude" };
      if (cursor) p.cursor = cursor;
      const data = await api("kalshi", "/trade-api/v2/markets", p, 30000);
      (data.markets || []).map(PL.normalizeKalshi).filter(Boolean).forEach((k) => items.push(k));
      cursor = data.cursor;
      if (!cursor) break;
    }
    store.set("polylean.kalshi", { t: Date.now(), items });
    return items.map((i) => Object.assign(i, { tok: PL.tokens(i.title) }));
  }

  async function loadPredictIt() {
    const cached = store.get("polylean.predictit", null);
    const tok = (i) => Object.assign(i, { tok: PL.tokens(i.title) });
    if (fresh(cached)) return cached.items.map(tok);
    const data = await api("predictit", "/api/marketdata/all/", {}, 30000);
    const items = [];
    (data.markets || []).forEach((m) => PL.normalizePredictIt(m).forEach((c) => items.push(c)));
    store.set("polylean.predictit", { t: Date.now(), items });
    return items.map(tok);
  }

  async function loadManifold(question, health) {
    const term = PL.searchTerm(question);
    const key = "polylean.mf." + term;
    const cached = store.get(key, null);
    if (fresh(cached)) return cached.items;
    if (health.fails >= 5) return [];
    try {
      const raw = await api("manifold", "/v0/search-markets", { term, filter: "open", contractType: "BINARY", limit: 5 }, 12000);
      const items = raw.map(PL.normalizeManifold).filter(Boolean);
      store.set(key, { t: Date.now(), items });
      health.fails = 0;
      return items;
    } catch (e) {
      health.fails++;
      if (health.fails === 5) health.note = "Manifold failed 5 times in a row, so it was skipped for this refresh.";
      return [];
    }
  }

  async function pool(items, size, fn) {
    let i = 0;
    await Promise.all(Array.from({ length: size }, async () => {
      while (i < items.length) { const item = items[i++]; await fn(item); }
    }));
  }

  // ---- state -------------------------------------------------------------------
  const THRESHOLDS = [0.6, 0.7, 0.75, 0.8, 0.9];
  const state = {
    data: null, ledger: { entries: [] }, cat: "All", running: false,
    view: "actions",                                         // actions | likely | all
    threshold: store.get("polylean.threshold", PL.PLAN.DEFAULT_THRESHOLD),
    bankroll: store.get("polylean.bankroll", 0),
  };
  if (!THRESHOLDS.includes(state.threshold)) state.threshold = PL.PLAN.DEFAULT_THRESHOLD;
  if (!(state.bankroll >= 0)) state.bankroll = 0;

  // ---- one full refresh -----------------------------------------------------------
  async function refresh() {
    if (state.running) return;
    state.running = true;
    $("#refresh").disabled = true;
    const warnings = [];
    const say = (t) => { $("#progress").textContent = t; };
    try {
      say("Getting live Polymarket prices…");
      let markets;
      try { markets = await loadPolymarket(); }
      catch (e) {
        throw new Error("Could not load Polymarket prices (" + e.message + "). Check your connection and tap Refresh. " +
          "If it keeps failing, the file named _redirects may not have been uploaded with the site.");
      }
      if (!markets.length) throw new Error("Polymarket returned no usable markets.");

      say("Getting Kalshi forecasts…");
      let kalshi = [];
      try { kalshi = await loadKalshi(); } catch (e) { warnings.push("Kalshi unavailable this refresh (" + e.message + ")."); }

      say("Getting PredictIt forecasts…");
      let predictit = [];
      try { predictit = await loadPredictIt(); } catch (e) { warnings.push("PredictIt unavailable this refresh (" + e.message + ")."); }

      const now = new Date();
      const candidates = markets.filter((m) => !PL.preCheck(m, now)).sort((a, b) => b.volume24h - a.volume24h).slice(0, 60);
      const manifold = {}, health = { fails: 0, note: "" };
      let done = 0;
      await pool(candidates, 5, async (m) => {
        manifold[m.id] = await loadManifold(m.question, health);
        say("Checking Manifold " + (++done) + "/" + candidates.length + "…");
      });
      if (health.note) warnings.push(health.note);

      const picks = markets.map((m) => {
        const srcs = PL.matchSources(m, kalshi, manifold[m.id] || [], predictit);
        const res = PL.score(m, srcs, now);
        return Object.assign({}, m, res, { sources: res.sources || srcs });
      });

      // scorecard: records every lean the model makes, whatever the chance
      const ledger = store.get(LEDGER_KEY, { entries: [] });
      PL.updateLedger(ledger, picks, now.toISOString());
      const open = ledger.entries.filter((e) => e.outcome === null).map((e) => e.id);
      for (let i = 0; i < open.length; i += 50) {
        try {
          const got = await api("gamma", "/markets", { id: open.slice(i, i + 50), closed: "any", limit: 100 });
          PL.applyResolutions(ledger, got);
        } catch (e) { warnings.push("Could not check resolved markets this refresh."); break; }
      }
      if (!store.set(LEDGER_KEY, ledger)) warnings.push("Could not save your scorecard (browser storage is blocked).");
      state.ledger = ledger;

      state.data = { updated: now.toISOString(), markets: picks, warnings, route: Object.assign({}, route) };
      $("#error").hidden = true;
      render();
    } catch (e) {
      const box = $("#error"); box.textContent = e.message; box.hidden = false;
    } finally {
      state.running = false; $("#refresh").disabled = false; say("");
    }
  }

  // ---- drawing ----------------------------------------------------------------
  function ago(iso) {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 1 ? "just now" : m < 60 ? m + " min ago" : Math.round(m / 60) + " h ago";
  }
  function endText(iso) {
    const d = iso ? new Date(iso) : null;
    if (!d || isNaN(d)) return "";
    return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  }

  function tierOf(r) { return PL.classify(r, state.threshold); }

  function chip(text, pressed, onclick) {
    const b = el("button", { class: "chip", "aria-pressed": String(pressed), text, type: "button" });
    b.onclick = onclick;
    return b;
  }

  function render() {
    const d = state.data;
    if (!d) return;
    const status = $("#status"); status.replaceChildren();
    d.warnings.slice(0, 3).forEach((w) => status.append(el("div", { class: "banner", text: w })));
    const via = d.route.gamma ? (d.route.gamma.startsWith("/proxy") ? "via Netlify" : "direct from Polymarket") : "";
    $("#asof").textContent = "Live prices fetched " + ago(d.updated) + (via ? " · " + via : "");

    const tiers = d.markets.map((r) => ({ r, c: tierOf(r) }));
    const count = (t) => tiers.filter((x) => x.c.tier === t).length;
    const nAction = count("action"), nLikely = count("likely"), nLow = count("lowchance");

    // minimum chance
    const thr = $("#thr"); thr.replaceChildren();
    THRESHOLDS.forEach((t) => thr.append(chip(Math.round(t * 100) + "%", state.threshold === t, () => {
      state.threshold = t; store.set("polylean.threshold", t); render();
    })));

    // which list
    const views = $("#views"); views.replaceChildren();
    [["actions", "Actions (" + nAction + ")"], ["likely", "High chance, no edge (" + nLikely + ")"], ["all", "All markets (" + d.markets.length + ")"]]
      .forEach(([v, label]) => views.append(chip(label, state.view === v, () => { state.view = v; render(); })));

    // category
    const cats = ["All", ...new Set(d.markets.map((x) => x.category))];
    const box = $("#filters"); box.replaceChildren();
    cats.forEach((c) => box.append(chip(c, state.cat === c, () => { state.cat = c; render(); })));

    const withSources = d.markets.filter((m) => m.sources.length).length;
    $("#meta").textContent = d.markets.length + " markets scanned, " + withSources + " with a matching outside forecast. " +
      nAction + " action" + (nAction === 1 ? "" : "s") + " at " + Math.round(state.threshold * 100) + "%+ chance" +
      (nLow ? ", " + nLow + " more with an edge but a lower chance." : ".");

    const wanted = (x) => state.view === "all" || (state.view === "actions" && x.c.tier === "action") || (state.view === "likely" && x.c.tier === "likely");
    const rows = tiers.filter((x) => wanted(x) && (state.cat === "All" || x.r.category === state.cat));
    rows.sort((a, b) => (b.c.tier === "action") - (a.c.tier === "action") || (b.c.tier === "likely") - (a.c.tier === "likely") ||
      b.r.edge - a.r.edge || b.r.volume24h - a.r.volume24h);
    const list = $("#list"); list.replaceChildren();
    if (!rows.length) list.append(el("p", { class: "meta", text: state.view === "actions"
      ? "No actions right now at " + Math.round(state.threshold * 100) + "%+ chance. That is normal: most of the time the market already looks right. Try the other lists to see why."
      : "Nothing matches this list and category." }));
    rows.forEach((x) => list.append(card(x.r, x.c)));
    renderRecord();
  }

  function chanceBar(r) {
    const yes = r.model_p, no = 1 - r.model_p;
    const bar = el("div", { class: "bar", role: "img", "aria-label": "Chance Yes " + pct(yes) + ", chance No " + pct(no) });
    bar.append(el("span", { class: "y", style: "width:" + (yes * 100).toFixed(1) + "%" }), el("span", { class: "n", style: "width:" + (no * 100).toFixed(1) + "%" }));
    return el("div", { class: "chance" },
      el("div", { class: "cl" }, el("span", { text: "Chance it happens (Yes) " }), el("b", { class: "gy", text: pct(yes) }),
        el("span", { text: "   ·   Chance it doesn't (No) " }), el("b", { class: "rn", text: pct(no) })),
      bar);
  }

  function doBox(r) {
    const p = PL.plan(r, state.bankroll);
    const rows = [
      ["Action", "Buy " + p.side + ", with a limit order at " + cents(p.cost) + " or less"],
      ["Walk away if", "the price rises above " + centsDown(p.maxPrice) + " (the edge is gone)"],
      ["If you are right", "+" + Math.round(p.winPerDollar * 100) + "¢ for every $1 staked"],
      ["If you are wrong", "you lose the whole stake (about " + Math.round((1 - p.chance) * 100) + "% chance by this model)"],
    ];
    if (p.stakePct < 0.001) rows.push(["Stake", "the edge is too thin to size a bet"]);
    else if (p.stake) rows.push(["Stake", pct(p.stakePct, 1) + " of your bankroll ≈ " + money(p.stake) + " (about " + Math.floor(p.shares) + " shares)"]);
    else rows.push(["Stake", pct(p.stakePct, 1) + " of your bankroll. Enter your bankroll above to see dollars."]);
    const ends = endText(r.end);
    if (ends) rows.push(["Market ends", ends]);
    const dl = el("dl", { class: "rows" });
    rows.forEach(([k, v]) => dl.append(el("dt", { text: k }), el("dd", { text: v })));
    return el("div", { class: "do " + p.side },
      el("p", { class: "do-title", text: "Do this: BUY " + p.side.toUpperCase() }), dl,
      el("p", { class: "how", text: "On Polymarket: open the market, tap " + p.side + ", choose Buy, switch to Limit, set the price, enter the shares, confirm." }),
      el("p", { class: "fine", text: "Model output, not financial advice. Prediction markets can lose the whole stake." }));
  }

  function noTradeBox(r) {
    const p = PL.priced(r);
    return el("div", { class: "notrade" },
      el("p", { class: "do-title", text: "No trade" }),
      el("p", { class: "why", text: p.side + " is priced at " + cents(p.cost) + " for about a " + pct(p.chance) + " chance. Buying wins only +" +
        Math.round(p.winPerDollar * 100) + "¢ per $1, but loses the whole stake about " + Math.round(p.lossChance * 100) +
        "% of the time. The price already matches the chance, so there is no edge." +
        (r.sources.length ? "" : " No outside forecast was found, so this chance is just the market's own price.") }));
  }

  function card(r, c) {
    const badge = c.tier === "action" ? "BUY " + c.side.toUpperCase() : c.tier === "lowchance" ? "Watch" : c.tier === "likely" ? "No trade" : "Skip";
    const cls = c.tier === "action" ? c.side : c.tier === "lowchance" ? "Watch" : "Skip";
    const head = el("div", { class: "top" },
      el("h3", { class: "q" }, el("a", { href: safeUrl(r.url), target: "_blank", rel: "noopener", text: r.question, class: "plain" })),
      el("span", { class: "badge " + cls, text: badge }));
    const card = el("article", { class: "card tier-" + c.tier }, head, chanceBar(r),
      el("p", { class: "mk", text: "Polymarket price: Yes " + cents(r.price) + " · No " + cents(1 - r.price) + "   (PolyLean's estimate may differ)" }));
    if (c.tier === "action") card.append(doBox(r));
    else if (c.tier === "likely") card.append(noTradeBox(r));
    else if (c.tier === "lowchance") card.append(el("p", { class: "why", text: "The model sees an edge on " + c.side + ", but that side has only a " + pct(c.chance) +
      " chance, below your " + Math.round(state.threshold * 100) + "% minimum. Not an action." }));
    else card.append(el("p", { class: "why", text: r.reason }));
    if (r.sources && r.sources.length) {
      const ul = el("ul");
      r.sources.forEach((s) => ul.append(el("li", {},
        el("a", { href: safeUrl(s.url), target: "_blank", rel: "noopener", text: ({ kalshi: "Kalshi", predictit: "PredictIt", manifold: "Manifold" }[s.kind] || s.kind) + ": " + pct(s.prob) }),
        el("span", { class: "tag", text: "  match " + Math.round(s.sim * 100) + "% · \"" + s.title.slice(0, 90) + "\"" }))));
      card.append(el("details", {}, el("summary", { text: r.sources.length + " source" + (r.sources.length > 1 ? "s" : "") }), ul));
    }
    return card;
  }

  function tile(v, label, cls) { const b = el("b", { text: v }); if (cls) b.className = cls; return el("div", { class: "tile" }, b, el("span", { text: label })); }

  function statTiles(st) {
    const g = el("div", { class: "grid" });
    g.append(tile(String(st.published), "leans recorded"), tile(String(st.resolved), "resolved"));
    if (st.resolved) {
      g.append(tile(pct(st.hit_rate), "hit rate"));
      const r = st.avg_return_per_dollar;
      g.append(tile((r >= 0 ? "+" : "") + (r * 100).toFixed(1) + "¢", "avg per $1, before fees", r >= 0 ? "good" : "bad"));
    }
    return g;
  }

  function renderRecord() {
    const box = $("#record"); box.replaceChildren();
    const es = state.ledger.entries;
    const acts = es.filter((e) => PL.entryChance(e) >= state.threshold);
    box.append(el("h3", { class: "sec", text: "Action picks (" + Math.round(state.threshold * 100) + "%+ chance)" }), statTiles(PL.computeStats(acts)));
    const all = PL.computeStats(es);
    box.append(el("h3", { class: "sec", text: "Every lean, any chance" }), statTiles(all));
    if (all.resolved) {
      const better = all.brier_model < all.brier_market;
      box.append(el("div", { class: "grid" }, tile(all.brier_model.toFixed(3) + " vs " + all.brier_market.toFixed(3),
        "Brier: model vs market (lower is better)", better ? "good" : "bad")));
    }
    box.append(el("p", { class: "meta", text: all.resolved < 30
      ? "Fewer than 30 resolved leans is too small a sample to say anything. Treat early numbers as noise."
      : "Compare the two Brier scores: the model only adds value if its number is lower." }));
    box.append(el("p", { class: "meta", text: "Your scorecard lives in this browser on this device. It only records leans while the page is open and refreshing. Clearing browser data erases it, so use the backup buttons." }));
    const dl = el("button", { class: "chip", text: "Download backup", type: "button" });
    dl.onclick = () => {
      const a = el("a", { href: URL.createObjectURL(new Blob([JSON.stringify(state.ledger)], { type: "application/json" })), download: "polylean-scorecard.json" });
      document.body.append(a); a.click(); a.remove();
    };
    const fileIn = el("input", { type: "file", accept: "application/json", hidden: "" });
    fileIn.onchange = async () => {
      try {
        const j = JSON.parse(await fileIn.files[0].text());
        if (!j || !Array.isArray(j.entries)) throw new Error("bad file");
        store.set(LEDGER_KEY, { entries: j.entries }); state.ledger = { entries: j.entries }; renderRecord();
      } catch (e) { alert("That file is not a PolyLean backup."); }
    };
    const rs = el("button", { class: "chip", text: "Restore backup", type: "button" });
    rs.onclick = () => fileIn.click();
    box.append(el("div", { class: "filters" }, dl, rs, fileIn));
    if (!es.length) { box.append(el("p", { class: "meta", text: "No leans recorded yet." })); return; }
    const tb = el("table", {}, el("tr", {}, ["Lean", "Chance", "Question", "Entry", "Result"].map((h) => el("th", { text: h }))));
    es.slice().reverse().slice(0, 100).forEach((e) => {
      const res = e.outcome ? (e.lean === e.outcome ? "Won" : "Lost") : "Open";
      tb.append(el("tr", {}, el("td", { text: e.lean }), el("td", { text: pct(PL.entryChance(e)) }), el("td", { text: e.question }),
        el("td", { text: cents(e.entry_price) }),
        el("td", { class: res === "Won" ? "good" : res === "Lost" ? "bad" : "", text: res })));
    });
    box.append(tb);
  }

  // ---- wiring ----------------------------------------------------------------------
  document.querySelectorAll("nav button").forEach((b) => b.onclick = () => {
    document.querySelectorAll("nav button").forEach((x) => x.setAttribute("aria-selected", String(x === b)));
    ["picks", "record", "how"].forEach((id) => { $("#" + id).hidden = id !== b.dataset.tab; });
  });
  $("#refresh").onclick = refresh;
  const bank = $("#bank");
  if (state.bankroll > 0) bank.value = String(state.bankroll);
  bank.addEventListener("input", () => {
    const v = parseFloat(bank.value);
    state.bankroll = v > 0 ? v : 0;
    store.set("polylean.bankroll", state.bankroll);
    render();
  });
  state.ledger = store.get(LEDGER_KEY, { entries: [] });
  refresh();
  setInterval(() => { if (!document.hidden && state.data) render(); }, 60e3);           // keep "x min ago" honest
  setInterval(() => { if (!document.hidden) refresh(); }, 10 * 60e3);                   // auto-refresh every 10 min
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.data && Date.now() - new Date(state.data.updated) > 10 * 60e3) refresh();
  });
})();
