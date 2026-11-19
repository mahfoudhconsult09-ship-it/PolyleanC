/* PolyLean live app: fetches prices in the visitor's browser, scores them, keeps the
   scorecard in this browser's storage. Needs engine.js loaded first. */
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
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

  // ---- storage (can fail in private mode, so everything is wrapped) ----------
  const store = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } },
  };
  const LEDGER_KEY = "polylean.ledger.v1";

  // ---- network ---------------------------------------------------------------
  const DIRECT = { gamma: "https://gamma-api.polymarket.com", manifold: "https://api.manifold.markets",
    kalshi: "https://api.elections.kalshi.com" };
  const route = {}; // remembers which route worked for each source

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

  /** Try Netlify's forwarding path first (no browser restrictions), then the source directly. */
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

  // ---- one full refresh -----------------------------------------------------------
  const state = { data: null, ledger: null, cat: "All", show: null, running: false };

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
        const srcs = PL.matchSources(m, kalshi, manifold[m.id] || []);
        const res = PL.score(m, srcs, now);
        return Object.assign({}, m, res, { sources: res.sources || srcs });
      });
      picks.sort((a, b) => (a.lean === "Skip") - (b.lean === "Skip") || b.edge - a.edge);

      // scorecard
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

      state.data = { updated: now.toISOString(), scanned: picks.length,
        withSources: picks.filter((p) => p.sources.length).length, leans: picks.filter((p) => p.lean !== "Skip").length,
        markets: picks, warnings, route: Object.assign({}, route) };
      store.set("polylean.last", { updated: state.data.updated });
      if (state.show === null) state.show = state.data.leans ? "leans" : "all";
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

  function render() {
    const d = state.data;
    if (!d) return;
    const status = $("#status"); status.replaceChildren();
    d.warnings.slice(0, 3).forEach((w) => status.append(el("div", { class: "banner", text: w })));
    const via = d.route.gamma ? (d.route.gamma.startsWith("/proxy") ? "via Netlify" : "direct from Polymarket") : "";
    $("#asof").textContent = "Live prices fetched " + ago(d.updated) + (via ? " · " + via : "");
    const cats = ["All", ...new Set(d.markets.map((x) => x.category))];
    const box = $("#filters"); box.replaceChildren();
    cats.forEach((c) => {
      const b = el("button", { class: "chip", "aria-pressed": String(state.cat === c), text: c });
      b.onclick = () => { state.cat = c; render(); };
      box.append(b);
    });
    const t = el("button", { class: "chip", "aria-pressed": String(state.show === "all"),
      text: state.show === "all" ? "Showing: all markets" : "Showing: leans only" });
    t.onclick = () => { state.show = state.show === "all" ? "leans" : "all"; render(); };
    box.append(t);

    $("#meta").textContent = d.scanned + " markets scanned, " + d.withSources + " with a matching outside forecast, " + d.leans + " leans.";
    const rows = d.markets.filter((r) => (state.cat === "All" || r.category === state.cat) && (state.show === "all" || r.lean !== "Skip"));
    const list = $("#list"); list.replaceChildren();
    if (!rows.length) list.append(el("p", { class: "meta", text: "No leans right now. That is normal: most of the time the market already looks right." }));
    rows.forEach((r) => list.append(card(r)));
    renderRecord();
  }

  function card(r) {
    const verdict = r.lean === "Skip" ? "Skip" : r.lean + " · " + r.confidence;
    const head = el("div", { class: "top" },
      el("h3", { class: "q" }, el("a", { href: safeUrl(r.url), target: "_blank", rel: "noopener", text: r.question, class: "plain" })),
      el("span", { class: "badge " + r.lean, text: verdict }));
    const cost = r.lean === "Yes" ? r.ask : r.lean === "No" ? 1 - r.bid : r.price;
    const stats = el("div", { class: "stats" },
      el("div", { class: "stat" }, el("b", { text: pct(r.price) }), el("span", { text: "Market" })),
      el("div", { class: "stat" }, el("b", { text: pct(r.model_p) }), el("span", { text: "PolyLean" })),
      el("div", { class: "stat" }, el("b", { text: r.lean === "Skip" ? "–" : "+" + pct(r.edge, 1) }),
        el("span", { text: r.lean === "Skip" ? "Edge" : "Edge after spread" })));
    const c = el("article", { class: "card" }, head, stats,
      el("p", { class: "why", text: r.reason + (r.lean !== "Skip" ? " Cost to take this side: about " + Math.round(cost * 100) + "¢ per $1." : "") }));
    if (r.sources && r.sources.length) {
      const ul = el("ul");
      r.sources.forEach((s) => ul.append(el("li", {},
        el("a", { href: safeUrl(s.url), target: "_blank", rel: "noopener", text: (s.kind === "kalshi" ? "Kalshi" : "Manifold") + ": " + pct(s.prob) }),
        el("span", { class: "tag", text: "  match " + Math.round(s.sim * 100) + "% · \"" + s.title.slice(0, 90) + "\"" }))));
      c.append(el("details", {}, el("summary", { text: r.sources.length + " source" + (r.sources.length > 1 ? "s" : "") }), ul));
    }
    return c;
  }

  function tile(v, label, cls) { const b = el("b", { text: v }); if (cls) b.className = cls; return el("div", { class: "tile" }, b, el("span", { text: label })); }

  function renderRecord() {
    const box = $("#record"); box.replaceChildren();
    const es = state.ledger.entries, st = PL.computeStats(es);
    const g = el("div", { class: "grid" });
    g.append(tile(String(st.published), "leans recorded"), tile(String(st.resolved), "resolved"));
    if (st.resolved) {
      g.append(tile(pct(st.hit_rate), "hit rate"));
      const r = st.avg_return_per_dollar;
      g.append(tile((r >= 0 ? "+" : "") + (r * 100).toFixed(1) + "¢", "avg per $1, before fees", r >= 0 ? "good" : "bad"));
      g.append(tile(st.brier_model.toFixed(3) + " vs " + st.brier_market.toFixed(3), "Brier: model vs market (lower is better)",
        st.brier_model < st.brier_market ? "good" : "bad"));
    }
    box.append(g);
    box.append(el("p", { class: "meta", text: st.resolved < 30
      ? "Fewer than 30 resolved leans is too small a sample to say anything. Treat early numbers as noise."
      : "Compare the two Brier scores: the model only adds value if its number is lower." }));
    box.append(el("p", { class: "meta", text: "Your scorecard lives in this browser on this device. It only records leans while the page is open and refreshing. Clearing browser data erases it, so use the backup buttons." }));
    const dl = el("button", { class: "chip", text: "Download backup" });
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
    const rs = el("button", { class: "chip", text: "Restore backup" });
    rs.onclick = () => fileIn.click();
    box.append(el("div", { class: "filters" }, dl, rs, fileIn));
    if (!es.length) { box.append(el("p", { class: "meta", text: "No leans recorded yet." })); return; }
    const tb = el("table", {}, el("tr", {}, ["Lean", "Question", "Entry", "Result"].map((h) => el("th", { text: h }))));
    es.slice().reverse().slice(0, 100).forEach((e) => {
      const res = e.outcome ? (e.lean === e.outcome ? "Won" : "Lost") : "Open";
      tb.append(el("tr", {}, el("td", { text: e.lean }), el("td", { text: e.question }),
        el("td", { text: Math.round(e.entry_price * 100) + "¢" }),
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
  state.ledger = store.get(LEDGER_KEY, { entries: [] });
  refresh();
  setInterval(() => { if (!document.hidden && state.data) { render(); } }, 60e3);               // keep "x min ago" honest
  setInterval(() => { if (!document.hidden) refresh(); }, 10 * 60e3);                           // auto-refresh every 10 min
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && state.data && Date.now() - new Date(state.data.updated) > 10 * 60e3) refresh();
  });
})();
