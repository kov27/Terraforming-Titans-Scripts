// ==UserScript==
// @name         Terraforming Titans Worker Allocator (Resources + Market) [Docked Left Popout Fix] v2.0.5
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      2.0.5
// @description  Resource-centric worker allocator with Off/On/Balance + Market Buy/Sell. Docked left slide-out that RESIZES game. Fixes popout hover + avoids click-lock.
// @author       ChatGPT
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const PAGE = (W && W.wrappedJSObject) ? W.wrappedJSObject : W;

  // ---------------- Storage ----------------
  const STORE_KEY = 'ttwa2_resource_state_v1';
  const GLOBAL_KEY = 'ttwa2_global_v3';

  const DEFAULT_GLOBAL = {
    enabled: true,
    pinned: false,
    expandedWidth: 320,
    collapsedWidth: 44, // wider hotzone so hover works reliably
    tickMs: 1200,

    // Worker allocation
    workerReservePct: 0.04, // keep a few workers free

    // Market tuning
    marketHorizonSec: 20,
    marketMaxBuyFracPerTick: 0.05,      // was too timid for big caps; still clamped by funding
    marketSellKeepBase: 0.60,           // keep this much when not buying anything
    marketSellKeepWhenBuying: 0.40,     // keep less when you have market-buy enabled somewhere
    minFunding: 0,                      // keep funding >= this
  };

  function gmGet(k, d) {
    try { return (typeof GM_getValue === 'function') ? GM_getValue(k, d) : d; } catch { return d; }
  }
  function gmSet(k, v) {
    try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch {}
  }

  let rowState = gmGet(STORE_KEY, null);
  if (!rowState || typeof rowState !== 'object') rowState = {};
  let globalState = gmGet(GLOBAL_KEY, null);
  if (!globalState || typeof globalState !== 'object') globalState = { ...DEFAULT_GLOBAL };
  globalState = { ...DEFAULT_GLOBAL, ...globalState };

  function saveAll() {
    gmSet(STORE_KEY, rowState);
    gmSet(GLOBAL_KEY, globalState);
  }

  // ---------------- Utils ----------------
  function safeNum(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }
  function clamp(x, a, b) { x = Number(x); if (!isFinite(x)) return a; return Math.max(a, Math.min(b, x)); }

  function formatNum(n) {
    n = Number(n);
    if (!isFinite(n)) return '0';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const units = [
      { v: 1e12, s: 'T' }, { v: 1e9, s: 'B' }, { v: 1e6, s: 'M' }, { v: 1e3, s: 'k' }
    ];
    for (const u of units) {
      if (abs >= u.v) return `${sign}${(abs / u.v).toFixed(abs >= u.v * 10 ? 1 : 2)}${u.s}`;
    }
    return `${sign}${abs.toFixed(abs >= 100 ? 0 : 2)}`;
  }

  function humanResourceName(rk) {
    const parts = String(rk).split(':');
    const res = parts[1] || rk;
    return res.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
  }

  function ensureRowDefaults(rk) {
    if (!rowState[rk]) {
      rowState[rk] = { mode: 'off', producerKey: null, weight: 1, mBuy: false, mSell: false };
      saveAll();
    } else {
      const r = rowState[rk];
      if (!['off', 'on', 'balance'].includes(r.mode)) r.mode = 'off';
      r.weight = clamp(r.weight, 0, 10);
      r.mBuy = !!r.mBuy;
      r.mSell = !!r.mSell;
      if (r.producerKey != null && typeof r.producerKey !== 'string') r.producerKey = null;
    }
  }

  function getPageProp(name) {
    try { if (PAGE && typeof PAGE[name] !== 'undefined') return PAGE[name]; } catch {}
    try { if (W && typeof W[name] !== 'undefined') return W[name]; } catch {}
    return undefined;
  }

  // ---------------- Game helpers ----------------
  function effectiveWorkerNeed(b) {
    // Be defensive: game builds sometimes rename these fields.
    try {
      const base =
        (b && typeof b.getTotalWorkerNeed === 'function') ? safeNum(b.getTotalWorkerNeed()) :
        safeNum(
          b?.totalWorkerNeed ??
          b?.workerNeed ??
          b?.workersRequired ??
          b?.requiresWorkers ??
          b?.requiresWorker ??
          b?.workers ??
          b?.worker ??
          0
        );

      const mult =
        (b && typeof b.getEffectiveWorkerMultiplier === 'function') ? safeNum(b.getEffectiveWorkerMultiplier()) :
        safeNum(b?.workerMultiplier ?? b?.effectiveWorkerMultiplier ?? 1);

      const out = base * (mult || 1);
      return isFinite(out) ? out : 0;
    } catch { return 0; }
  }

  function collectProducedKeys(b) {
    const out = [];
    const prod = b && b.production ? b.production : {};
    for (const cat in prod) {
      if (!prod[cat] || typeof prod[cat] !== 'object') continue;
      if (cat !== 'colony' && cat !== 'special') continue;
      for (const res in prod[cat]) out.push(`${cat}:${res}`);
    }
    return out;
  }

  function getResState(resources, rk) {
    const [cat, res] = rk.split(':');
    try {
      const r = resources?.[cat]?.[res];
      if (!r) return null;
      const prod = safeNum(r.productionRate);
      const cons = safeNum(r.consumptionRate);
      return {
        displayName: r.displayName || humanResourceName(rk),
        value: safeNum(r.value),
        cap: safeNum(r.cap),
        prod,
        cons,
        net: prod - cons,
        unlocked: !!r.unlocked,
      };
    } catch { return null; }
  }

  // ---------------- Market project discovery (best effort) ----------------
  function findMarketProject() {
    const pm = getPageProp('projectManager');
    const projects = pm?.projects || getPageProp('projects') || {};
    if (!projects || typeof projects !== 'object') return null;

    if (projects.galactic_market) return projects.galactic_market;

    for (const k of Object.keys(projects)) {
      const p = projects[k];
      if (!p) continue;
      const hasSel = Array.isArray(p.buySelections) && Array.isArray(p.sellSelections);
      const name = String(p.displayName || p.name || k).toLowerCase();
      if (hasSel && name.includes('galactic') && name.includes('market')) return p;
      if (hasSel && k.toLowerCase().includes('galactic') && k.toLowerCase().includes('market')) return p;
    }
    return null;
  }

  // Try not to “click” UI or do anything that can steal focus / lock inputs.
  function bestEffortStartMarket(proj) {
    if (!proj) return;
    try {
      if ('autoStart' in proj) proj.autoStart = true;
      if ('isPaused' in proj) proj.isPaused = false;
      if ('run' in proj) proj.run = true;
      if (typeof proj.setEnabled === 'function') proj.setEnabled(true);
    } catch {}
  }

  function priceFromProject(proj, side, key) {
    if (!proj) return null;
    const fnNames = side === 'buy' ? ['getBuyPrice', 'getBuyCost'] : ['getSellPrice', 'getSellGain'];
    for (const fn of fnNames) {
      try {
        if (typeof proj[fn] === 'function') {
          const v = proj[fn](key);
          const n = Number(v);
          if (isFinite(n) && n > 0) return n;
        }
      } catch {}
    }
    const maps = side === 'buy'
      ? ['buyPrices', 'buyPrice', 'buyPriceByResource', 'pricesBuy']
      : ['sellPrices', 'sellPrice', 'sellPriceByResource', 'pricesSell'];
    for (const m of maps) {
      try {
        const obj = proj[m];
        if (!obj || typeof obj !== 'object') continue;
        const n = Number(obj[key]);
        if (isFinite(n) && n > 0) return n;
      } catch {}
    }
    return null;
  }

  function marketKeyCandidates(rk) {
    const parts = String(rk).split(':');
    const short = parts[1] || rk;
    const strip = rk.replace(/^colony:/, '').replace(/^special:/, '');
    const arr = [rk, short, strip];
    return Array.from(new Set(arr.filter(Boolean)));
  }

  const marketKeyCache = new Map();
  function resolveMarketKey(proj, rk) {
    if (!proj) return rk;
    const cacheKey = `${rk}::${proj?.name || proj?.displayName || 'proj'}`;
    if (marketKeyCache.has(cacheKey)) return marketKeyCache.get(cacheKey);

    const cands = marketKeyCandidates(rk);
    // Prefer the candidate that yields a price from the project
    for (const c of cands) {
      const pb = priceFromProject(proj, 'buy', c);
      const ps = priceFromProject(proj, 'sell', c);
      if ((pb != null && pb > 0) || (ps != null && ps > 0)) {
        marketKeyCache.set(cacheKey, c);
        return c;
      }
    }
    // Fall back to first
    marketKeyCache.set(cacheKey, cands[0] || rk);
    return marketKeyCache.get(cacheKey);
  }

  function selectionShape(proj) {
    // Try to match whatever shape the game uses in buySelections.
    const sample = (Array.isArray(proj?.buySelections) && proj.buySelections.length) ? proj.buySelections[0] : null;
    if (sample && typeof sample === 'object') {
      const keyProp = ('resource' in sample) ? 'resource' : (('resourceKey' in sample) ? 'resourceKey' : (('key' in sample) ? 'key' : 'resource'));
      const amtProp = ('amount' in sample) ? 'amount' : (('qty' in sample) ? 'qty' : (('value' in sample) ? 'value' : 'amount'));
      return { keyProp, amtProp };
    }
    return { keyProp: 'resource', amtProp: 'amount' };
  }

  function snapshot() {
    const resources = getPageProp('resources');
    const buildings = getPageProp('buildings') || {};
    if (!resources || !resources.colony) return null;

    const pop = safeNum(resources.colony.colonists?.value);
    const popCap = safeNum(resources.colony.colonists?.cap);
    const workerCap = safeNum(resources.colony.workers?.cap);
    const workerFree = safeNum(resources.colony.workers?.value);

    // Always include common market resources (even if not produced yet)
    const alwaysKeys = [
      'colony:metal', 'colony:glass', 'colony:water', 'colony:food',
      'colony:components', 'colony:electronics', 'colony:androids',
      'special:spaceships'
    ];

    const producedSet = {};
    for (const rk of alwaysKeys) producedSet[rk] = true;

    const bList = [];
    for (const key of Object.keys(buildings)) {
      const b = buildings[key];
      if (!b) continue;
      const produces = collectProducedKeys(b);
      for (const rk of produces) producedSet[rk] = true;
      bList.push({
        key,
        name: String(b.displayName || b.name || key),
        unlocked: !!b.unlocked,
        effNeed: effectiveWorkerNeed(b),
        count: safeNum(b.count),
        produces,
        autoBuildEnabled: !!b.autoBuildEnabled,
        autoActiveEnabled: !!b.autoActiveEnabled,
        autoBuildPercent: safeNum(b.autoBuildPercent),
        autoBuildBasis: String(b.autoBuildBasis || 'population'),
      });
    }

    const res = {};
    for (const rk of Object.keys(producedSet)) {
      const st = getResState(resources, rk);
      if (st) res[rk] = st;
    }

    return {
      pop, popCap, workerCap, workerFree,
      funding: safeNum(resources.colony.funding?.value),
      buildings: bList,
      res
    };
  }

  function buildProducerMap(snap) {
    const map = new Map();
    for (const b of snap.buildings) {
      if (!(b.effNeed > 0)) continue;
      for (const rk of (b.produces || [])) {
        if (!map.has(rk)) map.set(rk, []);
        map.get(rk).push(b);
      }
    }
    for (const [rk, arr] of map.entries()) arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    return map;
  }

  function severityBoost(resSt) {
    if (!resSt) return 1;
    const cap = resSt.cap;
    const fill = cap > 0 ? (resSt.value / cap) : 0;
    const cons = Math.max(0, resSt.cons);
    const net = resSt.net;
    let sev = 0;
    if (net < 0) {
      const denom = Math.max(1, cons);
      sev += Math.min(1.5, (-net) / denom);
    }
    if (cap > 0 && fill < 0.15) sev += 0.5;
    if (cap > 0 && fill < 0.05) sev += 0.5;
    return 1 + sev;
  }

  function computeBuildingPlan(snap, producerMap) {
    const workerCap = Math.max(1, snap.workerCap);
    const reservePct = clamp(globalState.workerReservePct, 0, 0.30);
    const workerBudget = Math.max(0, workerCap * (1 - reservePct));

    const chosen = new Map();

    for (const rk of Object.keys(snap.res)) {
      ensureRowDefaults(rk);
      const rCfg = rowState[rk];
      if (rCfg.mode === 'off') continue;

      const producers = producerMap.get(rk) || [];
      if (!producers.length) continue;

      const chosenKey = rCfg.producerKey && producers.some(p => p.key === rCfg.producerKey)
        ? rCfg.producerKey
        : producers[0].key;

      const b = producers.find(p => p.key === chosenKey) || producers[0];

      const w = Math.max(0, Number(rCfg.weight) || 0) * severityBoost(snap.res[rk]);
      if (w <= 0) continue;

      const ex = chosen.get(b.key);
      if (!ex) {
        chosen.set(b.key, {
          key: b.key,
          mode: rCfg.mode,
          weight: w,
          effNeed: Math.max(0.0001, b.effNeed || 1),
          count: b.count || 0
        });
      } else {
        ex.mode = (ex.mode === 'balance' || rCfg.mode === 'balance') ? 'balance' : 'on';
        ex.weight += w;
      }
    }

    const items = Array.from(chosen.values());
    const sumW = items.reduce((a, x) => a + x.weight, 0);
    if (!(sumW > 0)) return {};

    const targets = items.map(it => {
      const share = it.weight / sumW;
      const desiredWorkers = workerBudget * share;
      let targetCount = Math.ceil(desiredWorkers / it.effNeed);
      if (it.mode === 'balance') targetCount = Math.min(targetCount, Math.floor(it.count));
      targetCount = Math.max(0, targetCount);
      return { ...it, targetCount };
    });

    const totalWorkers = (arr) => arr.reduce((a, x) => a + x.targetCount * x.effNeed, 0);
    let tw = totalWorkers(targets);
    if (tw > workerBudget && tw > 0) {
      const scale = workerBudget / tw;
      for (const t of targets) t.targetCount = Math.max(0, Math.floor(t.targetCount * scale));
    }

    const updates = {};
    for (const t of targets) {
      const pct = (t.targetCount / workerCap) * 100;
      updates[t.key] = {
        autoBuildBasis: 'workers',
        autoBuildPercent: Math.max(0, Math.min(100, pct)),
        autoActiveEnabled: true,
        autoBuildEnabled: (t.mode === 'on') // balance => false (no building)
      };
    }
    return updates;
  }

  function applyBuildingUpdates(updates) {
    const buildings = getPageProp('buildings') || {};
    for (const key of Object.keys(updates)) {
      const u = updates[key];
      const b = buildings[key];
      if (!b || !u) continue;
      try {
        b.autoBuildBasis = 'workers';
        if (typeof u.autoBuildEnabled === 'boolean') b.autoBuildEnabled = u.autoBuildEnabled;
        if (typeof u.autoActiveEnabled === 'boolean') b.autoActiveEnabled = u.autoActiveEnabled;
        if (u.hasOwnProperty('autoBuildPercent')) {
          const v = Number(u.autoBuildPercent);
          if (isFinite(v)) b.autoBuildPercent = v;
        }
      } catch {}
    }
  }

  function computeMarketPlan(snap) {
    const buys = {};
    const sells = {};
    const horizon = clamp(globalState.marketHorizonSec, 5, 120);
    const baseMaxBuyFrac = clamp(globalState.marketMaxBuyFracPerTick, 0.001, 0.20);
    const keepBase = clamp(globalState.marketSellKeepBase, 0.10, 0.95);
    const keepAgg = clamp(globalState.marketSellKeepWhenBuying, 0.10, 0.95);

    let anyBuy = false;
    for (const rk of Object.keys(snap.res)) if (rowState[rk]?.mBuy) { anyBuy = true; break; }

    for (const rk of Object.keys(snap.res)) {
      ensureRowDefaults(rk);
      const cfg = rowState[rk];
      const rs = snap.res[rk];
      if (!rs || !rs.unlocked) continue;

      const cap = rs.cap;
      const val = rs.value;
      const net = rs.net;
      const fill = cap > 0 ? (val / cap) : 0;

      // --- BUY ---
      if (cfg.mBuy) {
        let want = 0;

        if (cap > 0) {
          const fillTarget = (net < 0) ? 0.14 : 0.08;
          want += Math.max(0, cap * fillTarget - val);
          want += Math.max(0, -net) * horizon;

          // If critically low + negative net, allow bigger bite per tick
          let maxBuyFrac = baseMaxBuyFrac;
          if (net < 0 && fill < 0.05) maxBuyFrac = Math.max(maxBuyFrac, 0.12);
          else if (net < 0 && fill < 0.10) maxBuyFrac = Math.max(maxBuyFrac, 0.08);

          want = Math.min(want, cap * maxBuyFrac);
          if (fill > fillTarget * 1.25) want = 0;
        } else {
          want = Math.max(0, -net) * horizon;
        }

        if (want > 0) buys[rk] = Math.floor(want);
      }

      // --- SELL ---
      if (cfg.mSell) {
        let want = 0;
        if (cap > 0) {
          let keepFrac = anyBuy ? keepAgg : keepBase;

          // If very full and net positive, sell more aggressively (metal -> electronics use-case)
          if (net > 0 && fill > 0.95) keepFrac = Math.min(keepFrac, 0.25);
          if (net > 0 && fill > 0.985) keepFrac = Math.min(keepFrac, 0.15);

          const keep = cap * keepFrac;
          want = Math.max(0, val - keep);

          // allow bigger per-tick sales when extremely full
          const maxPerTick =
            (fill > 0.985) ? cap * 0.50 :
            (fill > 0.95)  ? cap * 0.35 :
                             cap * 0.20;

          want = Math.min(want, maxPerTick);

          // If net negative, don't sell unless almost capped
          if (net < 0 && fill < 0.98) want = 0;
        } else {
          if (net > 0 && val > 0) want = Math.min(val * 0.20, net * horizon);
        }

        if (want > 0) sells[rk] = Math.floor(want);
      }
    }

    return { buys, sells };
  }

  function clampMarketToFunding(snap, plan) {
    const funding = safeNum(snap.funding);
    const minFunding = Math.max(0, safeNum(globalState.minFunding));
    if (funding <= minFunding + 1) return { ...plan, buys: {} };

    const proj = findMarketProject();
    if (!proj) return plan;

    let buyCost = 0, sellRev = 0;
    let havePrice = false;

    for (const rk of Object.keys(plan.buys || {})) {
      const amt = safeNum(plan.buys[rk]);
      if (amt <= 0) continue;
      const key = resolveMarketKey(proj, rk);
      const p = priceFromProject(proj, 'buy', key);
      if (p != null) { havePrice = true; buyCost += amt * p; }
    }
    for (const rk of Object.keys(plan.sells || {})) {
      const amt = safeNum(plan.sells[rk]);
      if (amt <= 0) continue;
      const key = resolveMarketKey(proj, rk);
      const p = priceFromProject(proj, 'sell', key);
      if (p != null) { havePrice = true; sellRev += amt * p; }
    }

    // If we can't price, be conservative when low funding.
    if (!havePrice) {
      if (funding < 1000) return { ...plan, buys: {} };
      return plan;
    }

    const netCost = buyCost - sellRev;
    const maxSpend = Math.max(0, funding - minFunding);
    if (netCost <= maxSpend) return plan;

    if (buyCost <= 0) return plan;

    const allowedBuyCost = Math.max(0, maxSpend + sellRev);
    const scale = clamp(allowedBuyCost / buyCost, 0, 1);

    const newBuys = {};
    for (const rk of Object.keys(plan.buys || {})) {
      const scaled = Math.floor(safeNum(plan.buys[rk]) * scale);
      if (scaled > 0) newBuys[rk] = scaled;
    }
    return { ...plan, buys: newBuys };
  }

  function applyMarketPlan(plan) {
    const proj = findMarketProject();
    if (!proj) return;

    const shape = selectionShape(proj);
    const buySel = [];
    const sellSel = [];

    for (const rk of Object.keys(plan.buys || {})) {
      const amt = Math.max(0, Number(plan.buys[rk]) || 0);
      if (amt <= 0) continue;
      const key = resolveMarketKey(proj, rk);
      const obj = {};
      obj[shape.keyProp] = key;
      obj[shape.amtProp] = amt;
      buySel.push(obj);
    }

    for (const rk of Object.keys(plan.sells || {})) {
      const amt = Math.max(0, Number(plan.sells[rk]) || 0);
      if (amt <= 0) continue;
      const key = resolveMarketKey(proj, rk);
      const obj = {};
      obj[shape.keyProp] = key;
      obj[shape.amtProp] = amt;
      sellSel.push(obj);
    }

    try {
      if (Array.isArray(proj.buySelections)) proj.buySelections = buySel;
      if (Array.isArray(proj.sellSelections)) proj.sellSelections = sellSel;

      // Also support map-style internals if present
      if (proj.buySelectionMap && typeof proj.buySelectionMap === 'object') {
        proj.buySelectionMap = {};
        for (const x of buySel) proj.buySelectionMap[x[shape.keyProp]] = x[shape.amtProp];
      }
      if (proj.sellSelectionMap && typeof proj.sellSelectionMap === 'object') {
        proj.sellSelectionMap = {};
        for (const x of sellSel) proj.sellSelectionMap[x[shape.keyProp]] = x[shape.amtProp];
      }

      bestEffortStartMarket(proj);
    } catch {}
  }

  // ---------------- UI (Popout fixed: separate rail + panel) ----------------
  const UI = {
    panel: null,
    rail: null,
    rowsWrap: null,
    rows: new Map(),
    open: false,
  };

  function ensureCSS() {
    if (document.getElementById('ttwa2-css')) return;
    const css = document.createElement('style');
    css.id = 'ttwa2-css';
    css.textContent = `
      #ttwa2-rail{
        position:fixed; top:0; left:0; height:100vh;
        width: var(--ttwa2-railw, 44px);
        z-index: 999998;
        background: rgba(0,0,0,0.01);
        cursor: pointer;
      }
      #ttwa2-panel{
        position:fixed; top:0; left:0; height:100vh;
        width: var(--ttwa2-panelw, 320px);
        transform: translateX(calc(var(--ttwa2-railw, 44px) - var(--ttwa2-panelw, 320px)));
        transition: transform 140ms ease;
        z-index: 999999;
        background: rgba(25,25,28,0.96);
        color:#e6e6e6;
        font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        border-right: 1px solid rgba(255,255,255,0.08);
        box-shadow: 2px 0 10px rgba(0,0,0,0.35);
        overflow:hidden;
      }
      #ttwa2-panel.ttwa2-open{ transform: translateX(0); }
      #ttwa2-panel .head{
        display:flex; align-items:center; justify-content:space-between;
        padding:8px 10px; gap:8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
      }
      #ttwa2-panel .title{ font-weight:700; letter-spacing:.2px; }
      #ttwa2-panel button{
        background: rgba(255,255,255,0.08);
        color:#eee;
        border:1px solid rgba(255,255,255,0.10);
        padding:4px 8px;
        border-radius:6px;
        cursor:pointer;
      }
      #ttwa2-panel button:hover{ background: rgba(255,255,255,0.12); }
      #ttwa2-panel .body{
        height: calc(100vh - 44px);
        overflow:auto;
        padding:10px;
      }
      .card{
        border:1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.18);
        border-radius:10px;
        padding:8px;
        margin-bottom:10px;
      }
      .muted{ opacity:.8; }
      .grid2{ display:grid; grid-template-columns:1fr 1fr; gap:6px 10px; }
      .rows{ display:flex; flex-direction:column; gap:8px; }
      .row{
        border:1px solid rgba(255,255,255,0.10);
        border-radius:10px;
        padding:8px;
        background: rgba(0,0,0,0.15);
      }
      .row .top{ display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .row .name{ font-weight:700; }
      .row .bar{ height:6px; background: rgba(255,255,255,0.10); border-radius:99px; overflow:hidden; margin-top:6px; }
      .row .bar > i{ display:block; height:100%; width:0%; background: rgba(120,220,120,0.9); }
      .row .mini{ display:flex; gap:10px; margin-top:6px; opacity:.9; }
      .row .mini span{ white-space:nowrap; }
      .row .ctrl{
        display:grid;
        grid-template-columns:1fr 1fr;
        gap:6px 8px;
        margin-top:8px;
      }
      .row select, .row input[type="number"]{
        width:100%;
        background: rgba(255,255,255,0.06);
        color:#eee;
        border:1px solid rgba(255,255,255,0.10);
        border-radius:8px;
        padding:4px 6px;
      }
      .row label.chk{ display:flex; align-items:center; gap:6px; user-select:none; }
    `;
    document.head.appendChild(css);
  }

  function applyDockShift(open) {
    const shift = open ? globalState.expandedWidth : globalState.collapsedWidth;

    // Prefer itch wrapper container
    const gc = document.getElementById('game-container');
    if (gc) {
      gc.style.marginLeft = `${shift}px`;
      gc.style.width = `calc(100% - ${shift}px)`;
      gc.style.maxWidth = `calc(100% - ${shift}px)`;
      gc.style.transition = 'margin-left 140ms ease, width 140ms ease';
      return;
    }

    // Fallback
    document.body.style.paddingLeft = `${shift}px`;
  }

  function setOpen(v) {
    UI.open = !!v;
    if (!UI.panel) return;
    UI.panel.classList.toggle('ttwa2-open', UI.open);
    applyDockShift(UI.open);
  }

  function buildUI() {
    ensureCSS();
    if (UI.panel) return;

    document.documentElement.style.setProperty('--ttwa2-panelw', `${globalState.expandedWidth}px`);
    document.documentElement.style.setProperty('--ttwa2-railw', `${globalState.collapsedWidth}px`);

    const rail = document.createElement('div');
    rail.id = 'ttwa2-rail';
    document.body.appendChild(rail);

    const panel = document.createElement('div');
    panel.id = 'ttwa2-panel';
    panel.innerHTML = `
      <div class="head">
        <div class="title">TT Worker Allocator</div>
        <div style="display:flex; gap:6px;">
          <button id="ttwa2-run">${globalState.enabled ? 'Stop' : 'Start'}</button>
          <button id="ttwa2-pin">${globalState.pinned ? 'Unpin' : 'Pin'}</button>
        </div>
      </div>
      <div class="body">
        <div class="card">
          <div class="grid2">
            <div><span class="muted">Workers</span> <b id="ttwa2-workers">–</b></div>
            <div><span class="muted">Free</span> <b id="ttwa2-free">–</b></div>
            <div><span class="muted">Pop</span> <b id="ttwa2-pop">–</b></div>
            <div><span class="muted">Funding</span> <b id="ttwa2-funding">–</b></div>
          </div>
          <div class="muted" style="margin-top:6px;">
            Off = hands off. On = can build. Balance = no building (autobuild off) but balances activation.
          </div>
        </div>
        <div class="card">
          <div class="muted" style="margin-bottom:6px;">Resources</div>
          <div class="rows" id="ttwa2-rows"></div>
        </div>
      </div>
    `;
    document.body.appendChild(panel);

    UI.panel = panel;
    UI.rail = rail;
    UI.rowsWrap = panel.querySelector('#ttwa2-rows');

    const runBtn = panel.querySelector('#ttwa2-run');
    const pinBtn = panel.querySelector('#ttwa2-pin');

    runBtn.addEventListener('click', () => {
      globalState.enabled = !globalState.enabled;
      runBtn.textContent = globalState.enabled ? 'Stop' : 'Start';
      saveAll();
    });

    pinBtn.addEventListener('click', () => {
      globalState.pinned = !globalState.pinned;
      pinBtn.textContent = globalState.pinned ? 'Unpin' : 'Pin';
      saveAll();
      setOpen(globalState.pinned);
    });

    // Hover open/close
    let closeTimer = null;
    const openIfAllowed = () => {
      if (closeTimer) clearTimeout(closeTimer);
      if (!globalState.pinned) setOpen(true);
    };
    const scheduleClose = () => {
      if (globalState.pinned) return;
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => setOpen(false), 160);
    };

    rail.addEventListener('mouseenter', openIfAllowed);
    panel.addEventListener('mouseenter', openIfAllowed);
    rail.addEventListener('mouseleave', scheduleClose);
    panel.addEventListener('mouseleave', scheduleClose);

    // Safety panic switch: Ctrl+Shift+X toggles the script off/on (keeps UI).
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'X' || e.key === 'x')) {
        globalState.enabled = !globalState.enabled;
        const b = UI.panel?.querySelector('#ttwa2-run');
        if (b) b.textContent = globalState.enabled ? 'Stop' : 'Start';
        saveAll();
      }
    }, true);

    setOpen(!!globalState.pinned);
  }

  function buildRow(rk) {
    ensureRowDefaults(rk);
    const s = rowState[rk];

    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.rk = rk;
    row.innerHTML = `
      <div class="top">
        <div class="name"></div>
        <div class="muted" style="text-align:right;"><span class="fill">–</span></div>
      </div>
      <div class="bar"><i></i></div>
      <div class="mini">
        <span class="muted">net</span> <span class="net">–</span>
        <span class="muted">cap</span> <span class="cap">–</span>
      </div>
      <div class="ctrl">
        <div>
          <div class="muted">Mode</div>
          <select class="mode">
            <option value="off">Off</option>
            <option value="on">On</option>
            <option value="balance">Balance</option>
          </select>
        </div>
        <div>
          <div class="muted">Producer</div>
          <select class="producer"></select>
        </div>
        <div>
          <div class="muted">Weight</div>
          <input class="weight" type="number" min="0" max="10" step="0.1"/>
        </div>
        <div>
          <div class="muted">Market</div>
          <div style="display:flex; gap:10px; align-items:center; height:28px;">
            <label class="chk"><input class="mbuy" type="checkbox"/> Buy</label>
            <label class="chk"><input class="msell" type="checkbox"/> Sell</label>
          </div>
        </div>
      </div>
    `;

    row.querySelector('.mode').value = s.mode;
    row.querySelector('.weight').value = String(s.weight);
    row.querySelector('.mbuy').checked = !!s.mBuy;
    row.querySelector('.msell').checked = !!s.mSell;

    row.querySelector('.mode').addEventListener('change', (e) => { s.mode = e.target.value; saveAll(); });
    row.querySelector('.weight').addEventListener('change', (e) => { s.weight = clamp(e.target.value, 0, 10); e.target.value = String(s.weight); saveAll(); });
    row.querySelector('.mbuy').addEventListener('change', (e) => { s.mBuy = !!e.target.checked; saveAll(); });
    row.querySelector('.msell').addEventListener('change', (e) => { s.mSell = !!e.target.checked; saveAll(); });
    row.querySelector('.producer').addEventListener('change', (e) => { s.producerKey = e.target.value || null; saveAll(); });

    UI.rows.set(rk, row);
    return row;
  }

  function setProducerOptions(rowEl, rk, producers) {
    const sel = rowEl.querySelector('.producer');
    const s = rowState[rk];
    const prev = s.producerKey;
    sel.innerHTML = '';

    if (!producers || producers.length === 0) {
      // IMPORTANT: only disable the producer dropdown, NOT mode/weight/market
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— (no worker building)';
      sel.appendChild(opt);
      sel.disabled = true;
      return;
    }

    sel.disabled = false;

    const auto = document.createElement('option');
    auto.value = '';
    auto.textContent = 'Auto';
    sel.appendChild(auto);

    for (const b of producers) {
      const opt = document.createElement('option');
      opt.value = b.key;
      opt.textContent = b.name;
      sel.appendChild(opt);
    }

    if (prev && producers.some(p => p.key === prev)) sel.value = prev;
    else sel.value = '';
  }

  // ---------------- Main loop ----------------
  let lastBuildSig = '';
  let lastMarketSig = '';

  function sig(obj) {
    try {
      const keys = Object.keys(obj).sort();
      let s = '';
      for (const k of keys) {
        const v = obj[k];
        if (v && typeof v === 'object' && !Array.isArray(v)) {
          const kk = Object.keys(v).sort();
          s += k + '{';
          for (const x of kk) s += x + ':' + Math.floor(Number(v[x]) || 0) + ',';
          s += '}';
        } else s += k + ':' + String(v) + ';';
      }
      return s;
    } catch { return String(Math.random()); }
  }

  function tick() {
    buildUI();
    const snap = snapshot();
    if (!snap) return;

    UI.panel.querySelector('#ttwa2-workers').textContent = formatNum(snap.workerCap);
    UI.panel.querySelector('#ttwa2-free').textContent = formatNum(snap.workerFree);
    UI.panel.querySelector('#ttwa2-pop').textContent = `${formatNum(snap.pop)}/${formatNum(snap.popCap)}`;
    UI.panel.querySelector('#ttwa2-funding').textContent = formatNum(snap.funding);

    const producerMap = buildProducerMap(snap);

    const rks = Object.keys(snap.res).sort((a, b) => humanResourceName(a).localeCompare(humanResourceName(b)));
    for (const rk of rks) {
      ensureRowDefaults(rk);
      if (!UI.rows.has(rk)) UI.rowsWrap.appendChild(buildRow(rk));
      const rowEl = UI.rows.get(rk);

      const rs = snap.res[rk];
      rowEl.querySelector('.name').textContent = rs.displayName || humanResourceName(rk);

      const cap = rs.cap;
      const val = rs.value;
      const fill = cap > 0 ? (val / cap) : 0;
      rowEl.querySelector('.fill').textContent = cap > 0 ? `${Math.floor(fill * 100)}%` : '—';
      rowEl.querySelector('.cap').textContent = cap > 0 ? formatNum(cap) : '—';

      const net = rs.net;
      rowEl.querySelector('.net').textContent = (net >= 0 ? '+' : '') + formatNum(net) + '/s';

      const bar = rowEl.querySelector('.bar > i');
      bar.style.width = `${clamp(fill * 100, 0, 100)}%`;
      bar.style.background = net < 0 ? 'rgba(255,120,120,0.9)' : 'rgba(120,220,120,0.9)';

      setProducerOptions(rowEl, rk, producerMap.get(rk) || []);
    }

    if (!globalState.enabled) return;

    const buildUpdates = computeBuildingPlan(snap, producerMap);
    const buildS = sig(buildUpdates);
    if (buildS !== lastBuildSig) {
      applyBuildingUpdates(buildUpdates);
      lastBuildSig = buildS;
    }

    let mPlan = computeMarketPlan(snap);
    mPlan = clampMarketToFunding(snap, mPlan);
    const mS = sig(mPlan);
    if (mS !== lastMarketSig) {
      applyMarketPlan(mPlan);
      lastMarketSig = mS;
    }
  }

  setInterval(tick, clamp(globalState.tickMs, 500, 5000));
  tick();

})();
