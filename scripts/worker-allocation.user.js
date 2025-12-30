// ==UserScript==
// @name         Terraforming Titans - TT Worker Allocator (Resources + Market) v3.1.2
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      3.1.2
// @description  Worker allocation by RESOURCE with Off/On/Balance + optional Market Buy/Sell. Only touches UNLOCKED/VISIBLE buildings. Left dock (hover expand) that RESIZES the game; no click-lock.
// @author       ChatGPT
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /**********************************************************************
   * v3.1.2 Fixes requested:
   * 1) Game not shifting: use a real #gameHost container sized to remaining viewport.
   * 2) Remove random "TT": rail tag removed.
   **********************************************************************/

  const APP = 'ttwa312';
  const STORAGE_KEY = 'ttwa31_state_v1'; // keep same to preserve your settings

  const RESOURCES = [
    { key: 'metal',       cat: 'colony',  label: 'Metal' },
    { key: 'glass',       cat: 'colony',  label: 'Glass' },
    { key: 'water',       cat: 'colony',  label: 'Water' },
    { key: 'food',        cat: 'colony',  label: 'Food' },
    { key: 'components',  cat: 'colony',  label: 'Components' },
    { key: 'electronics', cat: 'colony',  label: 'Electronics' },
    { key: 'androids',    cat: 'colony',  label: 'Androids' },
    { key: 'spaceships',  cat: 'special', label: 'Spaceships' },
  ];
  const RESOURCE_SET = new Set(RESOURCES.map(r => r.key));
  const MODES = { OFF: 'off', ON: 'on', BALANCE: 'balance' };

  const DEFAULT_STATE = {
    enabled: true,
    pinned: false,
    railWidth: 26,
    expandedWidth: 520,

    targetFill: {
      metal: 0.70,
      glass: 0.55,
      water: 0.55,
      food: 0.65,
      components: 0.45,
      electronics: 0.35,
      androids: 0.35,
      spaceships: 0.10,
    },

    resources: Object.fromEntries(RESOURCES.map(r => [r.key, {
      mode: MODES.OFF,
      producer: '',
      weight: 1,
      marketBuy: false,
      marketSell: false,
    }])),

    market: {
      enabled: true,
      buyHorizonSec: 120,
      sellHorizonSec: 180,
      fundingHorizonSec: 60,
      fundingBufferPct: 0.01,
    },
  };

  let state = loadState();

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return structuredClone(DEFAULT_STATE);
      const parsed = JSON.parse(raw);
      const s = structuredClone(DEFAULT_STATE);

      Object.assign(s, parsed);
      s.targetFill = { ...DEFAULT_STATE.targetFill, ...(parsed.targetFill || {}) };
      s.market = { ...DEFAULT_STATE.market, ...(parsed.market || {}) };
      s.resources = { ...DEFAULT_STATE.resources, ...(parsed.resources || {}) };
      for (const r of RESOURCES) if (!s.resources[r.key]) s.resources[r.key] = structuredClone(DEFAULT_STATE.resources[r.key]);
      return s;
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  function saveState() { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch {} }

  const N = (v, d = 0) => (Number.isFinite(v) ? v : d);
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function gameReady() { return !!(globalThis.resources && globalThis.buildings); }
  function getResObj(cat, key) { return globalThis.resources?.[cat]?.[key] || null; }
  function getWorkersObj() { return globalThis.resources?.colony?.workers || null; }
  function getFundingObj() { return globalThis.resources?.colony?.funding || null; }

  function getMarketProject() {
    const pm = globalThis.projectManager;
    if (!pm) return null;
    if (pm.projects?.galactic_market) return pm.projects.galactic_market;
    if (typeof pm.getProject === 'function') { try { return pm.getProject('galactic_market'); } catch {} }
    const projects = pm.projects || {};
    for (const k of Object.keys(projects)) {
      const p = projects[k];
      const name = String(p?.name || p?.displayName || '').toLowerCase();
      if (name.includes('galactic') && name.includes('market')) return p;
    }
    return null;
  }

  function getAutobuildAvgCost(cat, key) {
    if (cat !== 'colony') return 0;
    const t = globalThis.autobuildCostTracker;
    if (!t || typeof t.getAverageCost !== 'function') return 0;
    try { return N(t.getAverageCost(cat, key), 0); } catch { return 0; }
  }

  function getByTypeNet(resObj, sourceName) {
    let prod = 0, cons = 0;
    const pbt = resObj.productionRateByType || {};
    for (const t of Object.keys(pbt)) prod += N(pbt[t]?.[sourceName], 0);
    const cbt = resObj.consumptionRateByType || {};
    for (const t of Object.keys(cbt)) cons += N(cbt[t]?.[sourceName], 0);
    return prod - cons;
  }

  function getBaselineNet(resObj) {
    const totalNet = N(resObj.productionRate, 0) - N(resObj.consumptionRate, 0);
    const gmNet = getByTypeNet(resObj, 'Galactic Market');
    const ab = getAutobuildAvgCost(resObj.category, resObj.name);
    return totalNet - gmNet - ab;
  }

  function getFill(resObj) {
    const cap = N(resObj.cap, Infinity);
    if (!Number.isFinite(cap) || cap <= 0) return 0;
    return clamp(N(resObj.value, 0) / cap, 0, 1);
  }

  function isBuildingVisibleUnlocked(b) {
    if (!b) return false;
    const unlocked =
      (typeof b.isUnlocked === 'function') ? !!b.isUnlocked() :
      ('unlocked' in b) ? !!b.unlocked :
      (N(b.count, 0) > 0);
    if (!unlocked) return false;

    if (b.isHidden) return false;
    if (typeof b.isVisible === 'function') { try { if (!b.isVisible()) return false; } catch {} }
    return true;
  }

  function getWorkerNeed(b) {
    try {
      const base =
        (typeof b.getTotalWorkerNeed === 'function') ? N(b.getTotalWorkerNeed(), 0) :
        N(b.totalWorkerNeed ?? b.workerNeed ?? b.workersRequired ?? b.requiresWorkers ?? b.requiresWorker ?? b.workers ?? 0, 0);

      const mult =
        (typeof b.getEffectiveWorkerMultiplier === 'function') ? N(b.getEffectiveWorkerMultiplier(), 1) :
        N(b.workerMultiplier ?? b.effectiveWorkerMultiplier ?? 1, 1);

      const out = base * mult;
      return Number.isFinite(out) ? Math.max(0, out) : 0;
    } catch { return 0; }
  }

  function extractProducedResourceKeys(prodObj) {
    const out = new Set();
    const seen = new Set();

    const norm = (k) => String(k).toLowerCase().trim().replace(/\s+/g, '').replace(/_/g, '');
    const wanted = new Map();
    for (const r of RESOURCE_SET) wanted.set(norm(r), r);

    const alias = new Map([
      ['ore', 'metal'],
      ['iron', 'metal'],
      ['metalore', 'metal'],
      ['watervapor', 'water'],
      ['vapor', 'water'],
      ['ice', 'water'],
      ['component', 'components'],
      ['electronic', 'electronics'],
      ['android', 'androids'],
      ['spaceship', 'spaceships'],
    ]);

    const stack = [prodObj];
    while (stack.length) {
      const cur = stack.pop();
      if (!cur || typeof cur !== 'object') continue;
      if (seen.has(cur)) continue;
      seen.add(cur);

      if (Array.isArray(cur)) {
        for (const v of cur) if (v && typeof v === 'object') stack.push(v);
        continue;
      }

      for (const [k, v] of Object.entries(cur)) {
        const nk = norm(k);

        const canon = wanted.get(nk);
        if (canon) out.add(canon);

        const ali = alias.get(nk);
        if (ali && RESOURCE_SET.has(ali)) out.add(ali);

        if (!canon && nk.endsWith('s')) {
          const sing = nk.slice(0, -1);
          const canon2 = wanted.get(sing);
          if (canon2) out.add(canon2);
        }

        if (v && typeof v === 'object') stack.push(v);
      }
    }
    return [...out];
  }

  function chooseAutoProducer(snap, resourceKey) {
    const ids = snap.producersByRes[resourceKey] || [];
    if (!ids.length) return '';
    let best = ids[0], bestCount = N(snap.buildingMeta[best]?.count, 0);
    for (const id of ids) {
      const c = N(snap.buildingMeta[id]?.count, 0);
      if (c > bestCount) { best = id; bestCount = c; }
    }
    return best;
  }

  function snapshot() {
    const snap = {
      workersCap: 0,
      workersVal: 0,
      funding: { value: 0, netBaseline: 0, netTotal: 0 },
      marketUnlocked: false,
      res: {},
      buildingMeta: {},
      producersByRes: {},
    };

    const w = getWorkersObj();
    snap.workersCap = N(w?.cap, 0);
    snap.workersVal = N(w?.value, 0);

    const f = getFundingObj();
    if (f) {
      const totalNet = N(f.productionRate, 0) - N(f.consumptionRate, 0);
      const gmNet = getByTypeNet(f, 'Galactic Market');
      snap.funding.value = N(f.value, 0);
      snap.funding.netTotal = totalNet;
      snap.funding.netBaseline = totalNet - gmNet;
    }

    snap.marketUnlocked = !!getMarketProject();

    for (const r of RESOURCES) {
      const obj = getResObj(r.cat, r.key);
      if (!obj || !obj.unlocked) continue;
      snap.res[r.key] = {
        key: r.key,
        label: r.label,
        cat: r.cat,
        value: N(obj.value, 0),
        cap: N(obj.cap, Infinity),
        fill: getFill(obj),
        netBaseline: getBaselineNet(obj),
        shortage: !!obj.autobuildShortage,
        limited: !!obj.automationLimited,
      };
    }

    const buildings = globalThis.buildings || {};
    for (const id of Object.keys(buildings)) {
      const b = buildings[id];
      if (!isBuildingVisibleUnlocked(b)) continue;

      const produced = extractProducedResourceKeys(b.production || {});
      if (!produced.length) continue;

      snap.buildingMeta[id] = {
        id,
        name: String(b.displayName || b.name || id),
        count: N(b.count, 0),
        workerNeed: getWorkerNeed(b),
        produced,
      };

      for (const k of produced) {
        if (!snap.producersByRes[k]) snap.producersByRes[k] = [];
        snap.producersByRes[k].push(id);
      }
    }

    for (const k of Object.keys(snap.producersByRes)) {
      snap.producersByRes[k].sort((a, b) => (snap.buildingMeta[a]?.name || a).localeCompare(snap.buildingMeta[b]?.name || b));
    }

    return snap;
  }

  function dynamicWeight(resourceKey, baseWeight, rs) {
    if (!rs) return 0;
    const target = N(state.targetFill[resourceKey], 0.5);
    const fill = N(rs.fill, 0);

    let f = 1;

    if (Number.isFinite(rs.cap) && rs.cap > 0) {
      const diff = target - fill;
      if (diff >= 0) {
        const mult = (resourceKey === 'food') ? 6.0 : 5.0;
        f *= clamp(1 + diff * mult, 0.15, 6.0);
      } else {
        const mult = (resourceKey === 'food') ? 3.5 : 4.0;
        f *= clamp(1 / (1 + (-diff) * mult), 0.15, 3.0);
      }
    }

    if (N(rs.netBaseline, 0) < 0) f *= (resourceKey === 'food') ? 1.55 : 1.30;
    if (rs.shortage) f *= (resourceKey === 'food') ? 2.00 : 1.55;
    if (rs.limited) f *= 0.85;

    return Math.max(0, N(baseWeight, 0)) * f;
  }

  function computeWorkerPlan(snap) {
    const Wcap = Math.floor(N(snap.workersCap, 0));
    if (Wcap <= 0) return [];

    const buildingLines = new Map();

    for (const r of RESOURCES) {
      const cfg = state.resources[r.key];
      if (!cfg || cfg.mode === MODES.OFF) continue;

      const rs = snap.res[r.key];
      if (!rs) continue;

      const producerIds = snap.producersByRes[r.key] || [];
      if (!producerIds.length) continue;

      let pid = String(cfg.producer || '');
      if (!pid || !producerIds.includes(pid)) pid = chooseAutoProducer(snap, r.key);
      if (!pid) continue;

      const bm = snap.buildingMeta[pid];
      if (!bm) continue;

      const need = N(bm.workerNeed, 0);
      if (need <= 0) continue;

      const dynW = dynamicWeight(r.key, N(cfg.weight, 1), rs);
      if (dynW <= 0) continue;

      const existing = buildingLines.get(pid);
      if (!existing) {
        buildingLines.set(pid, { id: pid, mode: cfg.mode, need, dynWeight: dynW });
      } else {
        existing.dynWeight += dynW;
        if (existing.mode !== MODES.BALANCE && cfg.mode === MODES.BALANCE) existing.mode = MODES.BALANCE;
      }
    }

    const lines = [...buildingLines.values()];
    if (!lines.length) return [];

    const sumW = lines.reduce((s, x) => s + x.dynWeight, 0);
    if (sumW <= 0) return [];

    const desiredWorkers = lines.map(x => Wcap * (x.dynWeight / sumW));
    const counts = lines.map((x, i) => Math.max(0, Math.floor(desiredWorkers[i] / x.need)));

    for (let i = 0; i < counts.length; i++) {
      if (lines[i].mode !== MODES.BALANCE) continue;
      const built = Math.floor(N(snap.buildingMeta[lines[i].id]?.count, 0));
      if (counts[i] > built) counts[i] = built;
    }

    let used = counts.reduce((s, c, i) => s + c * lines[i].need, 0);
    let remaining = Math.max(0, Wcap - used);

    const canAdd = (i) => {
      if (remaining + 1e-9 < lines[i].need) return false;
      if (lines[i].mode === MODES.BALANCE) {
        const built = Math.floor(N(snap.buildingMeta[lines[i].id]?.count, 0));
        if (counts[i] + 1 > built) return false;
      }
      return true;
    };

    let iters = 0;
    while (remaining > 0 && iters++ < 5000) {
      let bestIdx = -1;
      let bestScore = -Infinity;

      for (let i = 0; i < lines.length; i++) {
        if (!canAdd(i)) continue;
        const alloc = counts[i] * lines[i].need;
        const deficit = desiredWorkers[i] - alloc;
        const score = deficit / lines[i].need;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }

      if (bestIdx === -1 || bestScore <= 0) {
        bestIdx = -1; bestScore = -Infinity;
        for (let i = 0; i < lines.length; i++) {
          if (!canAdd(i)) continue;
          const score = lines[i].dynWeight / lines[i].need;
          if (score > bestScore) { bestScore = score; bestIdx = i; }
        }
        if (bestIdx === -1) break;
      }

      counts[bestIdx] += 1;
      remaining -= lines[bestIdx].need;
    }

    return lines.map((x, i) => {
      const allocWorkers = counts[i] * x.need;
      const pct = (Wcap > 0) ? (allocWorkers / Wcap) * 100 : 0;
      return { id: x.id, mode: x.mode, percent: clamp(pct, 0, 100) };
    });
  }

  function applyWorkerPlan(plan) {
    const buildings = globalThis.buildings || {};
    for (const step of plan) {
      const b = buildings[step.id];
      if (!isBuildingVisibleUnlocked(b)) continue;
      try {
        b.autoActiveEnabled = true;
        b.autoBuildBasis = 'workers';
        b.autoBuildPercent = N(step.percent, 0);
        if (step.mode === MODES.ON) b.autoBuildEnabled = true;
        if (step.mode === MODES.BALANCE) b.autoBuildEnabled = false;
      } catch {}
    }
  }

  function planMarket(snap) {
    if (!state.market.enabled) return null;
    const proj = getMarketProject();
    if (!proj) return null;

    const buyH = Math.max(10, N(state.market.buyHorizonSec, 120));
    const sellH = Math.max(10, N(state.market.sellHorizonSec, 180));
    const horizon = Math.max(10, N(state.market.fundingHorizonSec, 60));
    const buffer = Math.max(0, N(snap.funding.value, 0) * N(state.market.fundingBufferPct, 0.01));

    const buys = [];
    const sells = [];

    for (const r of RESOURCES) {
      const cfg = state.resources[r.key];
      const rs = snap.res[r.key];
      if (!cfg || !rs) continue;

      const target = N(state.targetFill[r.key], 0.5);

      if (cfg.marketBuy) {
        const deficitRate = Math.max(0, -N(rs.netBaseline, 0));
        let refillRate = 0;
        if (Number.isFinite(rs.cap) && rs.cap > 0) {
          const desired = rs.cap * target;
          if (rs.value < desired) refillRate = (desired - rs.value) / buyH;
        }
        let rate = deficitRate + refillRate;
        if (rs.shortage) rate *= 1.35;
        if (rate > 0) buys.push({ category: r.cat, resource: r.key, quantity: rate });
      }

      if (cfg.marketSell) {
        if (!rs.shortage) {
          const surplusRate = Math.max(0, N(rs.netBaseline, 0));
          let overfillRate = 0;
          if (Number.isFinite(rs.cap) && rs.cap > 0) {
            const desired = rs.cap * target;
            if (rs.value > desired) overfillRate = (rs.value - desired) / sellH;
          }
          const rate = surplusRate + overfillRate;
          if (rate > 0) sells.push({ category: r.cat, resource: r.key, quantity: rate });
        }
      }
    }

    const roundQ = (q) => {
      if (!Number.isFinite(q) || q <= 0) return 0;
      if (q < 1) return Number(q.toFixed(3));
      return Math.floor(q);
    };
    buys.forEach(x => x.quantity = roundQ(x.quantity));
    sells.forEach(x => x.quantity = roundQ(x.quantity));
    const buys2 = buys.filter(x => x.quantity > 0);
    const sells2 = sells.filter(x => x.quantity > 0);

    const fundingNow = N(snap.funding.value, 0);
    const baselineNet = N(snap.funding.netBaseline, 0);

    const buyCostPerUnit = (cat, res) => {
      try { if (typeof proj.getBuyPrice === 'function') return N(proj.getBuyPrice(cat, res, 1), 0); } catch {}
      return 1;
    };
    const sellRevPerUnit = (cat, res) => {
      try { if (typeof proj.getSellPrice === 'function') return N(proj.getSellPrice(cat, res, 1), 0); } catch {}
      return 1;
    };

    let buyCost = 0, sellRev = 0;
    for (const b of buys2) buyCost += b.quantity * buyCostPerUnit(b.category, b.resource);
    for (const s of sells2) sellRev += s.quantity * sellRevPerUnit(s.category, s.resource);
    const marketNet = sellRev - buyCost;

    const projected = fundingNow + (baselineNet + marketNet) * horizon;

    if (projected < buffer && buyCost > 0) {
      const needImprove = buffer - projected;
      const maxBuyCost = buyCost - (needImprove / horizon);
      const scale = clamp(maxBuyCost / buyCost, 0, 1);
      for (const b of buys2) b.quantity = roundQ(b.quantity * scale);
    }

    return { buys: buys2.filter(x => x.quantity > 0), sells: sells2 };
  }

  function applyMarket(plan) {
    if (!plan) return;
    const proj = getMarketProject();
    if (!proj) return;
    try {
      proj.buySelections = plan.buys.map(x => ({ category: x.category, resource: x.resource, quantity: x.quantity }));
      proj.sellSelections = plan.sells.map(x => ({ category: x.category, resource: x.resource, quantity: x.quantity }));
      proj.autoStart = true;
      if ('run' in proj) proj.run = true;
      if ('isPaused' in proj) proj.isPaused = false;
    } catch {}
  }

  // ---------- UI + layout host ----------
  let root = null;
  let closeTimer = null;
  let gameHost = null;

  function fmt(n) {
    n = Number(n);
    if (!Number.isFinite(n)) return '0';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const units = [{ v: 1e12, s: 'T' }, { v: 1e9, s: 'B' }, { v: 1e6, s: 'M' }, { v: 1e3, s: 'k' }];
    for (const u of units) if (abs >= u.v) return `${sign}${(abs / u.v).toFixed(abs >= u.v * 10 ? 1 : 2)}${u.s}`;
    return `${sign}${abs.toFixed(abs >= 100 ? 0 : 2)}`;
  }

  function ensureCSS() {
    if (document.getElementById(`${APP}-css`)) return;
    const css = document.createElement('style');
    css.id = `${APP}-css`;
    css.textContent = `
      :root{
        --ttwa-rail:${state.railWidth}px;
        --ttwa-wide:${state.expandedWidth}px;
        --ttwa-pad: var(--ttwa-rail);
        --ttwa-bg:#2b3240;
        --ttwa-panel:#2f3747;
        --ttwa-row1:#354155;
        --ttwa-row2:#313b4d;
        --ttwa-border:rgba(255,255,255,0.10);
        --ttwa-text:#e8edf7;
        --ttwa-muted:rgba(232,237,247,0.70);
      }

      html, body { height:100%; }
      body{ margin:0 !important; overflow:hidden; }

      /* Host the actual game in a constrained viewport (left offset) */
      #${APP}-gameHost{
        position:fixed;
        top:0; bottom:0;
        left: var(--ttwa-pad);
        right:0;
        overflow:hidden;
        /* Make fixed-position children use this as containing block */
        transform: translateZ(0);
      }

      #${APP}-root, #${APP}-root *{ box-sizing:border-box; }
      #${APP}-root{
        position:fixed; top:0; left:0; height:100vh;
        width: var(--ttwa-rail);
        z-index:2147483647;
        background: var(--ttwa-bg);
        border-right:1px solid var(--ttwa-border);
        color: var(--ttwa-text);
        font: 12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
        overflow:hidden;
      }
      #${APP}-root.open{ width: var(--ttwa-wide); }

      #${APP}-header{
        display:flex; align-items:center; justify-content:space-between; gap:8px;
        padding:8px 10px;
        background: var(--ttwa-panel);
        border-bottom:1px solid var(--ttwa-border);
      }
      #${APP}-title{
        font-weight:800;
        letter-spacing:.2px;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .ttwa-btn{
        border:1px solid var(--ttwa-border);
        background: rgba(255,255,255,0.06);
        color: var(--ttwa-text);
        padding:5px 8px;
        border-radius:8px;
        cursor:pointer;
      }
      .ttwa-btn:hover{ background: rgba(255,255,255,0.10); }

      #${APP}-status{
        padding:8px 10px;
        border-bottom:1px solid var(--ttwa-border);
        background: rgba(0,0,0,0.10);
        color: var(--ttwa-muted);
        display:grid;
        gap:3px;
      }

      #${APP}-list{
        height: calc(100vh - 88px);
        overflow:auto;
        padding:8px;
        display:flex;
        flex-direction:column;
        gap:7px;
      }

      .ttwa-row{
        border:1px solid var(--ttwa-border);
        border-radius:10px;
        padding:7px 8px;
      }
      .ttwa-row:nth-child(odd){ background: var(--ttwa-row1); }
      .ttwa-row:nth-child(even){ background: var(--ttwa-row2); }

      .ttwa-top{
        display:flex;
        align-items:baseline;
        justify-content:space-between;
        gap:10px;
        min-width:0;
      }
      .ttwa-label{
        font-weight:900;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .ttwa-stats{
        color: var(--ttwa-muted);
        font-size:11px;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        text-align:right;
      }

      .ttwa-controls{
        margin-top:6px;
        display:grid;
        grid-template-columns: 96px 1fr 66px 124px;
        gap:6px;
        align-items:center;
      }

      .good{ color:#baf7d0; }
      .bad{ color:#ffb2b2; }
      .warn{ color:#ffe2a8; }

      select.ttwa-sel, input.ttwa-in{
        width:100%;
        border-radius:8px;
        border:1px solid rgba(255,255,255,0.16);
        background: rgba(18, 22, 30, 0.55);
        color: #f0f4ff;
        padding:5px 7px;
        font-size:12px;
        outline:none;
      }
      select.ttwa-sel option{ background:#242b38; color:#f0f4ff; }
      input.ttwa-in{ text-align:right; }

      .ttwa-market{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        font-size:11px;
        color: var(--ttwa-muted);
        padding:0 2px;
      }
      .ttwa-market label{
        display:flex;
        gap:6px;
        align-items:center;
        user-select:none;
      }
    `;
    document.head.appendChild(css);
  }

  function setPad(px) {
    document.documentElement.style.setProperty('--ttwa-pad', `${px}px`);
  }

  function ensureGameHost() {
    if (gameHost && document.body.contains(gameHost)) return;

    gameHost = document.createElement('div');
    gameHost.id = `${APP}-gameHost`;

    // Move current body children into gameHost (except our own nodes if already injected)
    const nodes = Array.from(document.body.childNodes);
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      const el = node;
      if (el.id === `${APP}-root`) continue;
      if (el.id === `${APP}-gameHost`) continue;
      if (el.id && el.id.startsWith(APP)) continue;
      gameHost.appendChild(el);
    }

    document.body.appendChild(gameHost);
  }

  function setOpen(open) {
    if (!root) return;
    root.classList.toggle('open', open);
    const pad = open ? state.expandedWidth : state.railWidth;
    setPad(pad);
  }

  function buildUI() {
    if (root) return;

    ensureCSS();
    ensureGameHost();

    root = document.createElement('div');
    root.id = `${APP}-root`;
    root.innerHTML = `
      <div id="${APP}-header">
        <div id="${APP}-title">TT Worker Allocator</div>
        <div style="display:flex; gap:6px;">
          <button class="ttwa-btn" id="${APP}-run"></button>
          <button class="ttwa-btn" id="${APP}-pin"></button>
        </div>
      </div>
      <div id="${APP}-status"></div>
      <div id="${APP}-list"></div>
    `;
    document.body.appendChild(root);

    const runBtn = root.querySelector(`#${APP}-run`);
    const pinBtn = root.querySelector(`#${APP}-pin`);

    const syncBtns = () => {
      runBtn.textContent = state.enabled ? 'Stop' : 'Run';
      pinBtn.textContent = state.pinned ? 'Unpin' : 'Pin';
    };
    syncBtns();

    runBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.enabled = !state.enabled;
      saveState();
      syncBtns();
    });

    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      state.pinned = !state.pinned;
      saveState();
      setOpen(state.pinned);
      syncBtns();
    });

    root.addEventListener('mouseenter', () => {
      if (state.pinned) return;
      if (closeTimer) clearTimeout(closeTimer);
      setOpen(true);
    });

    root.addEventListener('mouseleave', () => {
      if (state.pinned) return;
      if (closeTimer) clearTimeout(closeTimer);
      closeTimer = setTimeout(() => setOpen(false), 130);
    });

    // Panic toggle: Ctrl+Shift+X
    window.addEventListener('keydown', (e) => {
      if (e.ctrlKey && e.shiftKey && (e.key === 'x' || e.key === 'X')) {
        state.enabled = !state.enabled;
        saveState();
        syncBtns();
      }
    }, true);

    setOpen(!!state.pinned);
  }

  function render(snap) {
    if (!root) return;

    const status = root.querySelector(`#${APP}-status`);
    const list = root.querySelector(`#${APP}-list`);

    const workersCap = snap ? snap.workersCap : 0;
    const workersVal = snap ? snap.workersVal : 0;
    const funding = snap ? snap.funding.value : 0;
    const market = snap ? (snap.marketUnlocked ? 'unlocked' : 'locked') : '…';

    status.innerHTML = `
      <div>Workers: <b>${fmt(workersVal)}</b> / <b>${fmt(workersCap)}</b></div>
      <div>Funding: <b>${fmt(funding)}</b> <span style="opacity:.75">| Market: ${market}</span></div>
    `;

    list.innerHTML = '';

    for (const r of RESOURCES) {
      const cfg = state.resources[r.key];
      const rs = snap?.res?.[r.key] || null;
      const unlocked = !!rs;

      const fillTxt = unlocked && Number.isFinite(rs.cap) ? `${Math.round(rs.fill * 100)}%` : '—';
      const net = unlocked ? N(rs.netBaseline, 0) : 0;
      const netCls = net < 0 ? 'bad' : (net > 0 ? 'good' : '');
      const flags = unlocked
        ? (rs.shortage ? `<span class="warn">shortage</span>` : (rs.limited ? `<span class="warn">limited</span>` : ''))
        : `<span class="warn">locked</span>`;

      const producers = snap?.producersByRes?.[r.key] || [];
      const nameOf = (id) => snap?.buildingMeta?.[id]?.name || id;

      const row = document.createElement('div');
      row.className = 'ttwa-row';
      row.innerHTML = `
        <div class="ttwa-top">
          <div class="ttwa-label">${r.label}</div>
          <div class="ttwa-stats">
            Fill <b>${fillTxt}</b> · Net <b class="${netCls}">${net >= 0 ? '+' : ''}${fmt(net)}/s</b>
            ${flags ? ` · ${flags}` : ''}
          </div>
        </div>

        <div class="ttwa-controls">
          <select class="ttwa-sel" data-k="mode" title="Control mode">
            <option value="on">On</option>
            <option value="balance">Balance</option>
            <option value="off">Off</option>
          </select>

          <select class="ttwa-sel" data-k="producer" title="Producer building">
            <option value="">Auto</option>
            ${producers.map(id => `<option value="${id}">${nameOf(id)}</option>`).join('')}
          </select>

          <input class="ttwa-in" data-k="weight" type="number" min="0" max="100" step="0.25" title="Weight"/>

          <div class="ttwa-market">
            <label title="Buy from Galactic Market when needed"><input type="checkbox" data-k="buy"/> Buy</label>
            <label title="Sell surplus to Galactic Market"><input type="checkbox" data-k="sell"/> Sell</label>
          </div>
        </div>
      `;

      const modeSel = row.querySelector('select[data-k="mode"]');
      const prodSel = row.querySelector('select[data-k="producer"]');
      const wInp = row.querySelector('input[data-k="weight"]');
      const buyChk = row.querySelector('input[data-k="buy"]');
      const sellChk = row.querySelector('input[data-k="sell"]');

      modeSel.value = cfg.mode;
      prodSel.value = cfg.producer || '';
      wInp.value = String(N(cfg.weight, 1));
      buyChk.checked = !!cfg.marketBuy;
      sellChk.checked = !!cfg.marketSell;

      if (!producers.length) prodSel.disabled = true;

      const onChange = () => {
        cfg.mode = modeSel.value;
        cfg.producer = prodSel.value;
        cfg.weight = clamp(parseFloat(wInp.value), 0, 100);
        cfg.marketBuy = !!buyChk.checked;
        cfg.marketSell = !!sellChk.checked;
        state.resources[r.key] = cfg;
        saveState();
      };

      modeSel.addEventListener('change', onChange);
      prodSel.addEventListener('change', onChange);
      wInp.addEventListener('change', onChange);
      buyChk.addEventListener('change', onChange);
      sellChk.addEventListener('change', onChange);

      list.appendChild(row);
    }
  }

  function tick() {
    try {
      if (!root) buildUI();
      ensureGameHost(); // in case the page replaced body contents

      if (!gameReady()) {
        render(null);
        return;
      }

      const snap = snapshot();
      render(snap);

      if (!state.enabled) return;

      applyWorkerPlan(computeWorkerPlan(snap));
      if (snap.marketUnlocked) applyMarket(planMarket(snap));
    } catch {
      // swallow errors - don't break the page
    }
  }

  buildUI();
  tick();
  setInterval(tick, 1100);
})();
