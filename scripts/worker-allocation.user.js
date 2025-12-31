// ==UserScript==
// @name         Terraforming Titans - Worker Allocation (Resources + Market)
// @namespace    https://kov27.github.io/
// @version      3.2.0
// @description  Resource-centric worker allocator with On/Off/Balance + Market Buy/Sell, docked left popout UI.
// @author       kov27 + ChatGPT
// @match        *://*.itch.io/*
// @match        *://itch.io/*
// @match        *://*.html5.gamemonetize.co/*
// @match        *://html5.gamemonetize.co/*
// @match        *://*.terraformingtitans.com/*
// @match        *://terraformingtitans.com/*
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /********************************************************************
   * Safety/Compatibility Notes
   * - Only manipulates buildings that are (a) in globalThis.buildings and
   *   (b) visible/unhidden in the game's own Buildings UI (build button exists
   *       and the row isn't ".hidden"). This prevents interacting with locked
   *       buildings (e.g., Recycling Facility) on a world where you can't see it.
   * - UI is rendered once; periodic updates do NOT rebuild controls, preventing
   *   dropdowns closing / spinners breaking.
   ********************************************************************/

  const VERSION = '3.2.0';
  const STATE_KEY = 'ttwa_state_v3_2_0';

  // Only track gameplay-relevant colony resources (exclude energy/antimatter/dusts etc.)
  const RESOURCES = [
    { key: 'metal',          label: 'Metal',          cat: 'colony' },
    { key: 'glass',          label: 'Glass',          cat: 'colony' },
    { key: 'water',          label: 'Water',          cat: 'colony' },
    { key: 'food',           label: 'Food',           cat: 'colony' },
    { key: 'components',     label: 'Components',     cat: 'colony' },
    { key: 'electronics',    label: 'Electronics',    cat: 'colony' },
    { key: 'superconductors',label: 'Superconductors',cat: 'colony' },
    { key: 'androids',       label: 'Androids',       cat: 'colony' },
    { key: 'colonists',      label: 'Colonists',      cat: 'colony' }, // cloning facility
    { key: 'spaceships',     label: 'Spaceships',     cat: 'colony' },
  ];

  // Default target stockpile fill (as ratio of cap)
  const DEFAULT_TARGET_FILL = {
    metal: 0.55,
    glass: 0.55,
    water: 0.55,
    food: 0.65,          // food treated more conservatively (like v1)
    components: 0.55,
    electronics: 0.55,
    superconductors: 0.45,
    androids: 0.45,
    colonists: 0.45,
    spaceships: 0.35,
  };

  // UI sizing
  const RAIL_W = 34;
  const EXPAND_W = 560;

  // Worker allocation cadence
  const TICK_MS = 1100;

  // Market tuning
  const MARKET_BUY_HORIZON_SEC = 12;     // cover deficit over short horizon
  const MARKET_SELL_HORIZON_SEC = 30;    // drain overfill over longer horizon
  const MARKET_MIN_TRADE = 1e-6;         // ignore tiny noise
  const FUNDS_MIN_BUFFER = 0;            // keep funding >= 0 (no buffer)

  // Helpers
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const fmt = (n, digits = 2) => {
    if (!Number.isFinite(n)) return '—';
    const abs = Math.abs(n);
    if (abs >= 1e9) return (n / 1e9).toFixed(digits) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(digits) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(digits) + 'K';
    if (abs >= 1) return n.toFixed(digits);
    return n.toFixed(Math.max(digits, 4));
  };

  // Persistent State
  function defaultState() {
    const resources = {};
    for (const r of RESOURCES) {
      resources[r.key] = {
        mode: 'off',           // 'off' | 'on' | 'balance'
        producer: 'auto',      // building id or 'auto'
        weight: 1.0,           // base weight
        marketBuy: false,
        marketSell: false,
        targetFill: DEFAULT_TARGET_FILL[r.key] ?? 0.55,
      };
    }
    return {
      version: VERSION,
      pinnedOpen: true,
      resources,
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STATE_KEY);
      if (!raw) return defaultState();
      const parsed = JSON.parse(raw);
      const base = defaultState();

      // Merge safely
      const out = { ...base, ...parsed };
      out.resources = { ...base.resources, ...(parsed.resources || {}) };
      for (const k of Object.keys(out.resources)) {
        out.resources[k] = { ...base.resources[k], ...out.resources[k] };
        // sanitize
        if (!['off', 'on', 'balance'].includes(out.resources[k].mode)) out.resources[k].mode = 'off';
        if (typeof out.resources[k].producer !== 'string') out.resources[k].producer = 'auto';
        out.resources[k].weight = Number.isFinite(+out.resources[k].weight) ? +out.resources[k].weight : 1.0;
        out.resources[k].targetFill = clamp(Number(out.resources[k].targetFill ?? base.resources[k].targetFill), 0.05, 0.95);
        out.resources[k].marketBuy = !!out.resources[k].marketBuy;
        out.resources[k].marketSell = !!out.resources[k].marketSell;
      }
      out.pinnedOpen = !!out.pinnedOpen;
      out.version = VERSION;
      return out;
    } catch {
      return defaultState();
    }
  }

  let STATE = loadState();
  let saveTimer = null;
  function saveStateSoon() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(STATE));
      } catch {}
    }, 250);
  }

  /********************************************************************
   * Game Introspection (safe, UI-driven visibility)
   ********************************************************************/

  function gameReady() {
    return !!(globalThis.resources && globalThis.buildings && globalThis.projectManager);
  }

  function getResourceObj(cat, key) {
    const c = globalThis.resources?.[cat];
    return c?.[key] || null;
  }

  function getFundingObj() {
    return globalThis.resources?.colony?.funding || null;
  }

  // Visible in the game's Buildings tab UI if build button exists and is not hidden.
  function isBuildingVisibleInUI(building) {
    if (!building || !building.name) return false;
    const btn = document.getElementById(`build-${building.name}`);
    if (!btn) return false;
    const row = btn.closest('.combined-building-row');
    if (row && row.classList.contains('hidden')) return false;
    // Some UIs may hide via style/display
    if (row) {
      const cs = window.getComputedStyle(row);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    }
    return true;
  }

  function getBuildingWorkerNeed(building) {
    if (!building) return 0;
    if (typeof building.getTotalWorkerNeed === 'function') return Number(building.getTotalWorkerNeed()) || 0;
    return Number(building.requiresWorker) || 0;
  }

  function extractProducedKeysFromProduction(prod) {
    const keys = new Set();
    const wanted = new Set(RESOURCES.map(r => r.key));
    const visit = (v) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, vv] of Object.entries(v)) {
        if (wanted.has(k)) keys.add(k);
        visit(vv);
      }
    };
    visit(prod);
    return [...keys];
  }

  function snapshot() {
    const snap = {
      now: Date.now(),
      workerCap: Number(globalThis.resources?.colony?.workers?.cap) || 0,
      workersValue: Number(globalThis.resources?.colony?.workers?.value) || 0,
      funding: {
        value: Number(getFundingObj()?.value) || 0,
        cap: Number(getFundingObj()?.cap) || 0,
      },
      resources: {},          // key -> { value, cap, totalNet, marketNet, baselineNet, fill }
      buildings: {},          // id -> { id, displayName, need, count, produces[] }
      producersByRes: {},     // resKey -> [{id, name, need}]
      market: null,           // { project, buyPriceFn, sellPriceFn }
    };

    // resources
    for (const r of RESOURCES) {
      const obj = getResourceObj(r.cat, r.key);
      if (!obj) continue;
      const value = Number(obj.value) || 0;
      const cap = Number(obj.cap ?? obj.max ?? 0) || 0;
      const totalNet = (Number(obj.productionRate) || 0) - (Number(obj.consumptionRate) || 0);
      const marketNet = getMarketNetFromRates(obj);
      const autobuildAvg = getAutobuildAvgCost(r.cat, r.key);
      const baselineNet = totalNet - marketNet - autobuildAvg;

      snap.resources[r.key] = {
        value,
        cap,
        fill: cap > 0 ? value / cap : 0,
        totalNet,
        marketNet,
        autobuildAvg,
        baselineNet,
        unlocked: obj.unlocked !== undefined ? !!obj.unlocked : true,
      };
    }

    // buildings visible in UI
    const bdict = globalThis.buildings || {};
    for (const [id, b] of Object.entries(bdict)) {
      if (!b || !b.name) continue;
      if (!isBuildingVisibleInUI(b)) continue;

      const produces = extractProducedKeysFromProduction(b.production);
      if (!produces.length) continue;

      const need = getBuildingWorkerNeed(b);
      snap.buildings[id] = {
        id,
        displayName: b.displayName || b.name || id,
        need,
        count: Number(b.count) || 0,
        produces,
      };
    }

    // producers per resource
    for (const r of RESOURCES) {
      const list = [];
      for (const [id, meta] of Object.entries(snap.buildings)) {
        if (meta.produces.includes(r.key)) {
          list.push({ id, name: meta.displayName, need: meta.need });
        }
      }
      list.sort((a, b) => (a.need - b.need) || a.name.localeCompare(b.name));
      snap.producersByRes[r.key] = list;
    }

    // market project
    snap.market = getMarketHandle();

    return snap;
  }

  function getMarketNetFromRates(resObj) {
    if (!resObj) return 0;
    // market uses type 'project' and source 'Galactic Market'
    const pr = resObj.productionRateByType?.project || {};
    const cr = resObj.consumptionRateByType?.project || {};
    const sumRates = (map, sign) => {
      let s = 0;
      for (const [src, v] of Object.entries(map)) {
        if (src === 'Galactic Market') s += sign * (Number(v) || 0);
      }
      return s;
    };
    return sumRates(pr, +1) + sumRates(cr, -1);
  }

  function getAutobuildAvgCost(category, resourceKey) {
    const tracker = globalThis.autobuildCostTracker;
    if (!tracker || typeof tracker.getAverageCost !== 'function') return 0;
    const v = tracker.getAverageCost(category, resourceKey);
    return Number(v) || 0;
  }

  function getMarketHandle() {
    try {
      const pm = globalThis.projectManager;
      const proj = pm?.projects?.galactic_market || null;
      if (!proj) return null;
      const buyPrice = (cat, resKey) => {
        if (typeof proj.getBuyPrice === 'function') return Number(proj.getBuyPrice(cat, resKey)) || 0;
        return 0;
      };
      const sellPrice = (cat, resKey, qty) => {
        if (typeof proj.getSellPrice === 'function') return Number(proj.getSellPrice(cat, resKey, qty)) || 0;
        return 0;
      };
      return { project: proj, buyPrice, sellPrice };
    } catch {
      return null;
    }
  }

  /********************************************************************
   * Worker Allocation Planning
   ********************************************************************/

  function dynamicWeight(resKey, snapRes, baseWeight, targetFill) {
    const fill = snapRes.cap > 0 ? snapRes.fill : 0;
    const net = snapRes.baselineNet;

    // Core v1-like feel: stockpile influences urgency strongly.
    let stockFactor = 1;
    if (snapRes.cap > 0) {
      const deficit = clamp((targetFill - fill) / Math.max(0.05, targetFill), -1, 1);
      // deficit positive => under target => increase weight
      stockFactor = 1 + deficit * 1.6; // up to 2.6x, down to -0.6x (clamped later)
    }

    // Net trend influence (smaller than stockpile)
    let netFactor = 1;
    if (Number.isFinite(net)) {
      if (net < 0) netFactor = 1.25;
      else if (net > 0) netFactor = 0.90;
    }

    // Food special handling (more conservative like v1)
    let foodFactor = 1;
    if (resKey === 'food') {
      const hunger = snapRes.cap > 0 ? clamp((0.75 - fill) / 0.75, 0, 1) : 0.5;
      foodFactor = 1 + hunger * 1.4; // up to 2.4x when low
      if (net < 0) foodFactor *= 1.1;
    }

    let w = baseWeight * stockFactor * netFactor * foodFactor;
    if (!Number.isFinite(w)) w = baseWeight;
    return clamp(w, 0.05, 50);
  }

  function chooseAutoProducer(resKey, producers, snap) {
    // Prefer the one with highest built count; tie-break by worker need (lower), then name.
    let best = null;
    let bestCount = -1;
    let bestNeed = Infinity;
    for (const p of producers) {
      const cnt = snap.buildings?.[p.id]?.count ?? 0;
      const need = snap.buildings?.[p.id]?.need ?? 0;
      if (cnt > bestCount) {
        best = p.id; bestCount = cnt; bestNeed = need;
      } else if (cnt === bestCount) {
        if (need < bestNeed) {
          best = p.id; bestNeed = need;
        } else if (need === bestNeed && best && p.id.localeCompare(best) < 0) {
          best = p.id;
        }
      }
    }
    return best || (producers[0]?.id ?? null);
  }

  function computeWorkerPlan(snap) {
    const Wcap = snap.workerCap;
    const plan = {
      workerCap: Wcap,
      lines: [],      // { buildingId, desiredCount, mode, need, reasonResKeys:[] }
      counts: {},     // buildingId -> count integer
      market: { buy: [], sell: [], note: '' },
      notes: [],
    };

    if (!Wcap || Wcap <= 0) {
      plan.notes.push('No worker cap detected.');
      return plan;
    }

    // Build list of controlled resources and chosen producers
    const lines = [];
    const buildingToRes = new Map(); // buildingId -> [resKey,...] for combined weight
    for (const r of RESOURCES) {
      const st = STATE.resources[r.key];
      if (!st) continue;
      if (st.mode === 'off') continue;

      const producers = snap.producersByRes[r.key] || [];
      if (!producers.length) continue;

      let producerId = st.producer;
      if (producerId === 'auto' || !snap.buildings?.[producerId]) {
        producerId = chooseAutoProducer(r.key, producers, snap);
      }
      if (!producerId || !snap.buildings?.[producerId]) continue;

      const bmeta = snap.buildings[producerId];
      // record mapping
      if (!buildingToRes.has(producerId)) buildingToRes.set(producerId, []);
      buildingToRes.get(producerId).push(r.key);

      // Create a line only if building uses workers (>0)
      if ((bmeta.need || 0) > 0) {
        lines.push({ resKey: r.key, buildingId: producerId, mode: st.mode });
      }
    }

    // Deduplicate by building: sum weights across resources that map to same building
    const unique = new Map(); // buildingId -> { buildingId, mode, resKeys[], weightSum }
    for (const [bid, resKeys] of buildingToRes.entries()) {
      const bmeta = snap.buildings[bid];
      const need = bmeta?.need || 0;
      if (need <= 0) continue; // no worker plan line for 0-worker buildings
      // Mode: if any mapped resource is 'on', treat as 'on' (more permissive), else balance.
      let mode = 'balance';
      for (const rk of resKeys) {
        const m = STATE.resources[rk]?.mode;
        if (m === 'on') { mode = 'on'; break; }
      }
      // Weight sum:
      let wsum = 0;
      for (const rk of resKeys) {
        const snapRes = snap.resources[rk];
        if (!snapRes) continue;
        const st = STATE.resources[rk];
        const w = dynamicWeight(rk, snapRes, st.weight, st.targetFill);
        wsum += w;
      }
      unique.set(bid, { buildingId: bid, mode, resKeys, need, weight: wsum });
    }

    const items = [...unique.values()].filter(x => x.weight > 0 && x.need > 0);
    if (!items.length) {
      plan.notes.push('No worker-using producers selected (or none unlocked/visible).');
      return plan;
    }

    const sumW = items.reduce((a, x) => a + x.weight, 0);
    if (sumW <= 0) {
      plan.notes.push('All weights were zero.');
      return plan;
    }

    // Compute desired workers, convert to desired building counts
    for (const it of items) {
      const desiredWorkers = (Wcap * it.weight) / sumW;
      let desiredCount = desiredWorkers / it.need;

      // In balance mode, do not exceed built count.
      const built = snap.buildings?.[it.buildingId]?.count ?? 0;
      if (it.mode === 'balance') desiredCount = Math.min(desiredCount, built);

      plan.lines.push({
        buildingId: it.buildingId,
        desiredCount,
        mode: it.mode,
        need: it.need,
        reasonResKeys: it.resKeys.slice(),
      });
    }

    // Integer rounding + fill to use workers
    const counts = {};
    for (const line of plan.lines) {
      counts[line.buildingId] = Math.max(0, Math.floor(line.desiredCount));
    }

    const caps = {}; // max counts for balance lines
    for (const line of plan.lines) {
      if (line.mode === 'balance') {
        const built = snap.buildings?.[line.buildingId]?.count ?? 0;
        caps[line.buildingId] = Math.max(0, Math.floor(built));
        counts[line.buildingId] = Math.min(counts[line.buildingId], caps[line.buildingId]);
      } else {
        caps[line.buildingId] = Infinity;
      }
    }

    const usedWorkers = (cs) => {
      let u = 0;
      for (const line of plan.lines) {
        const c = cs[line.buildingId] || 0;
        u += c * line.need;
      }
      return u;
    };

    function greedyFill(cs) {
      let remaining = Wcap - usedWorkers(cs);
      if (remaining <= 0) return remaining;

      // Precompute desired workers for scoring
      const desiredWorkers = {};
      for (const line of plan.lines) desiredWorkers[line.buildingId] = (line.desiredCount * line.need);

      const minNeed = Math.min(...plan.lines.map(l => l.need));
      let guard = 0;
      while (remaining >= minNeed && guard++ < 20000) {
        let bestId = null;
        let bestScore = -Infinity;

        for (const line of plan.lines) {
          const id = line.buildingId;
          if ((cs[id] || 0) >= (caps[id] ?? Infinity)) continue;
          if (line.need > remaining) continue;

          const allocW = (cs[id] || 0) * line.need;
          const def = (desiredWorkers[id] ?? 0) - allocW;
          // Prefer filling deficits first; normalize by worker cost
          const score = (def / line.need);
          if (score > bestScore) {
            bestScore = score;
            bestId = id;
          }
        }

        if (!bestId) break;
        cs[bestId] = (cs[bestId] || 0) + 1;
        remaining -= plan.lines.find(l => l.buildingId === bestId).need;
      }
      return remaining;
    }

    // Initial greedy fill
    let remaining = greedyFill(counts);

    // One-step improvement: remove one building from a line to free workers and refill (helps use more workers)
    // Only do if it improves leftover substantially.
    if (remaining > 0) {
      let best = { leftover: remaining, counts: null };

      for (const line of plan.lines) {
        const id = line.buildingId;
        if ((counts[id] || 0) <= 0) continue;

        const trial = { ...counts };
        trial[id] = trial[id] - 1;
        // Refill
        const trialLeftover = greedyFill(trial);
        if (trialLeftover < best.leftover) {
          best = { leftover: trialLeftover, counts: trial };
          if (best.leftover === 0) break;
        }
      }
      if (best.counts) {
        Object.assign(counts, best.counts);
        remaining = best.leftover;
      }
    }

    plan.counts = counts;
    if (remaining > 0) plan.notes.push(`Unused workers: ${remaining.toFixed(0)} (couldn't fit smallest building need).`);

    return plan;
  }

  /********************************************************************
   * Market Planning (Buy = cover deficit only; Sell = surplus + drain overfill)
   ********************************************************************/

  function computeMarketPlan(snap) {
    const m = { buy: [], sell: [], note: '' };
    const mh = snap.market;
    if (!mh || !mh.project) {
      m.note = 'Market project not found.';
      return m;
    }

    // Build desired buy/sell quantities per resource
    const buy = [];
    const sell = [];

    for (const r of RESOURCES) {
      const st = STATE.resources[r.key];
      const sr = snap.resources[r.key];
      if (!st || !sr || !sr.unlocked) continue;

      const cat = r.cat;

      // Buy: cover deficit only (baselineNet includes autobuild costs, excludes market)
      if (st.marketBuy) {
        const deficitPerSec = Math.max(0, -(sr.baselineNet));
        const qty = deficitPerSec * MARKET_BUY_HORIZON_SEC;
        if (qty > MARKET_MIN_TRADE) buy.push({ category: cat, resource: r.key, quantity: qty });
      }

      // Sell: surplus rate PLUS overfill drain (B)
      if (st.marketSell) {
        const surplusPerSec = Math.max(0, sr.baselineNet);
        let qty = surplusPerSec * MARKET_BUY_HORIZON_SEC; // sell some of the surplus promptly
        if (sr.cap > 0) {
          const target = clamp(st.targetFill, 0.05, 0.95);
          const over = Math.max(0, sr.value - sr.cap * target);
          qty += (over / MARKET_SELL_HORIZON_SEC);
        }
        if (qty > MARKET_MIN_TRADE) sell.push({ category: cat, resource: r.key, quantity: qty });
      }
    }

    // Funding protection: scale buys down if funding would go < 0 over horizon
    const funding = getFundingObj();
    const fundingNow = Number(funding?.value) || 0;

    const baseFundingNet = (() => {
      if (!funding) return 0;
      const total = (Number(funding.productionRate) || 0) - (Number(funding.consumptionRate) || 0);
      const marketNet = getMarketNetFromRates(funding); // market affects funding too
      const autobuildAvg = getAutobuildAvgCost('colony', 'funding');
      return total - marketNet - autobuildAvg;
    })();

    const buyCostPerSec = (() => {
      let c = 0;
      for (const x of buy) c += x.quantity * mh.buyPrice(x.category, x.resource);
      return c / MARKET_BUY_HORIZON_SEC;
    })();

    const sellRevPerSec = (() => {
      let rps = 0;
      for (const x of sell) rps += x.quantity * mh.sellPrice(x.category, x.resource, x.quantity);
      // x.quantity is in "units over horizon"; convert to per second
      return rps / Math.max(MARKET_BUY_HORIZON_SEC, 1);
    })();

    const horizon = MARKET_BUY_HORIZON_SEC;
    const projected = fundingNow + (baseFundingNet + sellRevPerSec - buyCostPerSec) * horizon;

    if (projected < FUNDS_MIN_BUFFER && buy.length) {
      const numerator = (fundingNow - FUNDS_MIN_BUFFER) + (baseFundingNet + sellRevPerSec) * horizon;
      const denom = (buyCostPerSec * horizon);
      const scale = denom > 0 ? clamp(numerator / denom, 0, 1) : 0;

      if (scale < 1) {
        for (const x of buy) x.quantity *= scale;
        m.note = `Buy scaled to ${(scale * 100).toFixed(0)}% to keep funding ≥ ${FUNDS_MIN_BUFFER}.`;
      }
    }

    // Remove tiny entries after scaling
    m.buy = buy.filter(x => x.quantity > MARKET_MIN_TRADE);
    m.sell = sell.filter(x => x.quantity > MARKET_MIN_TRADE);
    return m;
  }

  function applyMarketPlan(marketPlan, snap) {
    const mh = snap.market;
    if (!mh || !mh.project) return;

    const proj = mh.project;
    proj.buySelections = marketPlan.buy.map(x => ({ ...x, quantity: x.quantity }));
    proj.sellSelections = marketPlan.sell.map(x => ({ ...x, quantity: x.quantity }));

    // If nothing to do, don't force-start
    if (!proj.buySelections.length && !proj.sellSelections.length) return;

    // Start if not active, or if automation is locked and it stops quickly (keep it running)
    if (!proj.isActive) {
      try { globalThis.projectManager.startProject('galactic_market'); } catch {}
    } else {
      // ensure not paused
      proj.isPaused = false;
    }
  }

  /********************************************************************
   * Apply Worker Plan to Buildings (only visible/unlocked)
   ********************************************************************/

  function percentForTargetCount(count, base) {
    if (!base || base <= 0) return 0;
    if (!count || count <= 0) return 0;
    // avoid float causing ceil to overshoot by 1
    const pct = (count / base) * 100;
    return Math.max(0, pct - 1e-6);
  }

  function applyPlan(plan, snap) {
    const bdict = globalThis.buildings || {};
    const controlledBuildings = new Set();

    // For each resource with mode on/balance, find chosen producer and mark it controlled
    for (const r of RESOURCES) {
      const st = STATE.resources[r.key];
      if (!st || st.mode === 'off') continue;

      const producers = snap.producersByRes[r.key] || [];
      if (!producers.length) continue;

      let producerId = st.producer;
      if (producerId === 'auto' || !snap.buildings?.[producerId]) {
        producerId = chooseAutoProducer(r.key, producers, snap);
      }
      if (!producerId) continue;

      const b = bdict[producerId];
      if (!b || !isBuildingVisibleInUI(b)) continue;
      controlledBuildings.add(producerId);

      const need = getBuildingWorkerNeed(b);

      // Always enable auto-active for controlled buildings (lets Balance still control activation)
      b.autoActiveEnabled = true;

      if (need > 0) {
        // Use workers basis so percent maps to target building count via workerCap
        b.autoBuildBasis = 'workers';

        const targetCount = plan.counts[producerId] ?? Math.min(Number(b.count) || 0, Math.ceil((Number(b.active) || 0)));
        const pct = percentForTargetCount(Math.max(0, Math.floor(targetCount)), plan.workerCap);
        b.autoBuildPercent = pct;

        // Build enable depends on mode
        b.autoBuildEnabled = (st.mode === 'on');
      } else {
        // Non-worker buildings: don't force basis/percent (avoid runaway counts),
        // but respect On vs Balance for auto-building.
        b.autoBuildEnabled = (st.mode === 'on');
      }
    }

    // Do not touch any other buildings.
  }

  /********************************************************************
   * UI (dock-left popout, stable controls)
   ********************************************************************/

  const UI = {
    root: null,
    rail: null,
    panel: null,
    rows: {},        // resKey -> row meta
    status: null,
    notes: null,
    pinnedBtn: null,
    isOpen: false,
  };

  function injectStyles() {
    if (document.getElementById('ttwa-style')) return;
    const style = document.createElement('style');
    style.id = 'ttwa-style';
    style.textContent = `
      :root { --ttwa-pad: ${EXPAND_W}px; }
      #ttwa-root {
        position: fixed;
        top: 0;
        left: 0;
        height: 100vh;
        z-index: 999999;
        display: flex;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        pointer-events: auto;
      }
      #ttwa-rail {
        width: ${RAIL_W}px;
        background: rgba(18, 22, 28, 0.92);
        border-right: 1px solid rgba(255,255,255,0.08);
        display: flex;
        flex-direction: column;
        align-items: center;
        padding: 8px 0;
        gap: 10px;
        box-shadow: 0 0 0 1px rgba(0,0,0,0.25) inset;
      }
      #ttwa-rail .ttwa-logo {
        font-weight: 800;
        letter-spacing: 0.5px;
        color: rgba(255,255,255,0.85);
        font-size: 12px;
        user-select: none;
      }
      #ttwa-rail button {
        width: 24px;
        height: 24px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color: rgba(255,255,255,0.9);
        cursor: pointer;
      }
      #ttwa-panel {
        width: ${EXPAND_W}px;
        height: 100vh;
        background: rgba(26, 30, 38, 0.92);
        border-right: 1px solid rgba(255,255,255,0.10);
        box-shadow: 0 10px 30px rgba(0,0,0,0.35);
        display: flex;
        flex-direction: column;
        transform: translateX(-${EXPAND_W}px);
        transition: transform 140ms ease-out;
      }
      #ttwa-root.open #ttwa-panel {
        transform: translateX(0);
      }
      #ttwa-header {
        padding: 10px 12px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.10);
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      #ttwa-title {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
      }
      #ttwa-title .name {
        color: rgba(255,255,255,0.92);
        font-weight: 700;
        font-size: 14px;
      }
      #ttwa-title .ver {
        color: rgba(255,255,255,0.60);
        font-size: 11px;
      }
      #ttwa-status {
        color: rgba(255,255,255,0.70);
        font-size: 12px;
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
      }
      #ttwa-notes {
        color: rgba(255,255,255,0.65);
        font-size: 12px;
        padding: 6px 12px 0;
        min-height: 18px;
      }

      #ttwa-body {
        padding: 10px 12px 12px;
        overflow: auto;
        flex: 1;
      }

      .ttwa-row {
        display: grid;
        grid-template-columns: 120px 92px 92px 90px 1fr;
        gap: 8px 10px;
        align-items: center;
        padding: 6px 8px;
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        margin-bottom: 8px;
      }
      .ttwa-row:nth-child(odd) { background: rgba(255,255,255,0.06); }
      .ttwa-row:nth-child(even){ background: rgba(255,255,255,0.09); }

      .ttwa-name {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .ttwa-name .lbl {
        color: rgba(255,255,255,0.92);
        font-weight: 700;
        font-size: 13px;
        line-height: 1.1;
      }
      .ttwa-name .sub {
        color: rgba(255,255,255,0.65);
        font-size: 11px;
        line-height: 1.1;
      }

      .ttwa-metric {
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .ttwa-metric .top {
        color: rgba(255,255,255,0.80);
        font-size: 12px;
        line-height: 1.1;
      }
      .ttwa-metric .bot {
        color: rgba(255,255,255,0.60);
        font-size: 11px;
        line-height: 1.1;
      }
      .ttwa-metric .good { color: rgba(170, 255, 190, 0.90); }
      .ttwa-metric .bad  { color: rgba(255, 170, 170, 0.90); }

      .ttwa-controls {
        display: grid;
        grid-template-columns: 88px 1fr 72px;
        gap: 8px;
        align-items: center;
      }
      .ttwa-controls select,
      .ttwa-controls input[type="number"] {
        width: 100%;
        height: 28px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(16, 18, 24, 0.55);
        color: rgba(255,255,255,0.92);
        padding: 0 8px;
        font-size: 12px;
        outline: none;
      }
      .ttwa-controls select option { color: #e8eef7; background: #0f1218; }
      .ttwa-controls input[type="number"]::-webkit-outer-spin-button,
      .ttwa-controls input[type="number"]::-webkit-inner-spin-button {
        opacity: 1;
      }
      .ttwa-flags {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 10px;
      }
      .ttwa-flag {
        display: flex;
        align-items: center;
        gap: 6px;
        color: rgba(255,255,255,0.78);
        font-size: 12px;
        user-select: none;
      }
      .ttwa-flag input {
        width: 14px;
        height: 14px;
        accent-color: #8fd3ff;
      }

      .ttwa-small {
        color: rgba(255,255,255,0.62);
        font-size: 11px;
      }
    `;
    document.head.appendChild(style);
  }

  function setGamePadding(px) {
    const gc = document.getElementById('game-container');
    if (!gc) return;
    // Apply as inline styles to avoid relying on site CSS
    gc.style.marginLeft = `${px}px`;
    gc.style.width = `calc(100vw - ${px}px)`;
    gc.style.boxSizing = 'border-box';
  }

  function setOpen(open) {
    UI.isOpen = open;
    if (!UI.root) return;
    UI.root.classList.toggle('open', open);

    const pad = open ? EXPAND_W + RAIL_W : RAIL_W;
    setGamePadding(pad);
  }

  function buildUI() {
    if (UI.root) return;
    injectStyles();

    const root = document.createElement('div');
    root.id = 'ttwa-root';
    root.classList.toggle('open', !!STATE.pinnedOpen);

    const rail = document.createElement('div');
    rail.id = 'ttwa-rail';

    const logo = document.createElement('div');
    logo.className = 'ttwa-logo';
    logo.textContent = 'TTWA';
    rail.appendChild(logo);

    const pinBtn = document.createElement('button');
    pinBtn.title = 'Pin open/closed';
    pinBtn.textContent = STATE.pinnedOpen ? '⟂' : '↔';
    pinBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      STATE.pinnedOpen = !STATE.pinnedOpen;
      pinBtn.textContent = STATE.pinnedOpen ? '⟂' : '↔';
      saveStateSoon();
      setOpen(STATE.pinnedOpen);
    });
    rail.appendChild(pinBtn);

    const panel = document.createElement('div');
    panel.id = 'ttwa-panel';

    const header = document.createElement('div');
    header.id = 'ttwa-header';

    const title = document.createElement('div');
    title.id = 'ttwa-title';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = 'Worker Allocator';
    const ver = document.createElement('div');
    ver.className = 'ver';
    ver.textContent = `v${VERSION}`;
    title.appendChild(name);
    title.appendChild(ver);

    const status = document.createElement('div');
    status.id = 'ttwa-status';
    status.textContent = 'Waiting for game…';

    const notes = document.createElement('div');
    notes.id = 'ttwa-notes';
    notes.textContent = '';

    header.appendChild(title);
    header.appendChild(status);
    header.appendChild(notes);

    const body = document.createElement('div');
    body.id = 'ttwa-body';

    panel.appendChild(header);
    panel.appendChild(body);

    root.appendChild(rail);
    root.appendChild(panel);
    document.body.appendChild(root);

    UI.root = root;
    UI.rail = rail;
    UI.panel = panel;
    UI.status = status;
    UI.notes = notes;
    UI.pinnedBtn = pinBtn;

    // Hover popout (when not pinned)
    root.addEventListener('mouseenter', () => {
      if (!STATE.pinnedOpen) setOpen(true);
    });
    root.addEventListener('mouseleave', () => {
      if (!STATE.pinnedOpen) setOpen(false);
    });

    // Build rows once
    for (const r of RESOURCES) {
      const row = document.createElement('div');
      row.className = 'ttwa-row';
      row.dataset.resKey = r.key;

      const nameCell = document.createElement('div');
      nameCell.className = 'ttwa-name';
      const lbl = document.createElement('div');
      lbl.className = 'lbl';
      lbl.textContent = r.label;
      const sub = document.createElement('div');
      sub.className = 'sub';
      sub.textContent = '—';
      nameCell.appendChild(lbl);
      nameCell.appendChild(sub);

      const fillCell = document.createElement('div');
      fillCell.className = 'ttwa-metric';
      const fillTop = document.createElement('div');
      fillTop.className = 'top';
      fillTop.textContent = 'Fill: —';
      const fillBot = document.createElement('div');
      fillBot.className = 'bot';
      fillBot.textContent = 'Cap: —';
      fillCell.appendChild(fillTop);
      fillCell.appendChild(fillBot);

      const netCell = document.createElement('div');
      netCell.className = 'ttwa-metric';
      const netTop = document.createElement('div');
      netTop.className = 'top';
      netTop.textContent = 'Net: —';
      const netBot = document.createElement('div');
      netBot.className = 'bot';
      netBot.textContent = 'Base: —';
      netCell.appendChild(netTop);
      netCell.appendChild(netBot);

      const controlsCell = document.createElement('div');
      controlsCell.className = 'ttwa-controls';

      // Mode
      const modeSel = document.createElement('select');
      modeSel.innerHTML = `
        <option value="off">Off</option>
        <option value="on">On</option>
        <option value="balance">Balance</option>
      `;
      modeSel.value = STATE.resources[r.key]?.mode ?? 'off';
      modeSel.addEventListener('change', () => {
        STATE.resources[r.key].mode = modeSel.value;
        saveStateSoon();
      });

      // Producer
      const prodSel = document.createElement('select');
      prodSel.innerHTML = `<option value="auto">Auto</option>`;
      prodSel.value = STATE.resources[r.key]?.producer ?? 'auto';
      prodSel.addEventListener('change', () => {
        STATE.resources[r.key].producer = prodSel.value;
        saveStateSoon();
      });

      // Weight
      const wInput = document.createElement('input');
      wInput.type = 'number';
      wInput.step = '0.1';
      wInput.min = '0.1';
      wInput.max = '50';
      wInput.value = String(STATE.resources[r.key]?.weight ?? 1.0);
      wInput.addEventListener('input', () => {
        const v = Number(wInput.value);
        if (Number.isFinite(v)) {
          STATE.resources[r.key].weight = clamp(v, 0.1, 50);
          saveStateSoon();
        }
      });

      controlsCell.appendChild(modeSel);
      controlsCell.appendChild(prodSel);
      controlsCell.appendChild(wInput);

      const flagsCell = document.createElement('div');
      flagsCell.className = 'ttwa-flags';

      const buyLbl = document.createElement('label');
      buyLbl.className = 'ttwa-flag';
      const buyChk = document.createElement('input');
      buyChk.type = 'checkbox';
      buyChk.checked = !!STATE.resources[r.key]?.marketBuy;
      buyChk.addEventListener('change', () => {
        STATE.resources[r.key].marketBuy = buyChk.checked;
        saveStateSoon();
      });
      buyLbl.appendChild(buyChk);
      buyLbl.appendChild(document.createTextNode('Buy'));

      const sellLbl = document.createElement('label');
      sellLbl.className = 'ttwa-flag';
      const sellChk = document.createElement('input');
      sellChk.type = 'checkbox';
      sellChk.checked = !!STATE.resources[r.key]?.marketSell;
      sellChk.addEventListener('change', () => {
        STATE.resources[r.key].marketSell = sellChk.checked;
        saveStateSoon();
      });
      sellLbl.appendChild(sellChk);
      sellLbl.appendChild(document.createTextNode('Sell'));

      flagsCell.appendChild(buyLbl);
      flagsCell.appendChild(sellLbl);

      row.appendChild(nameCell);
      row.appendChild(fillCell);
      row.appendChild(netCell);
      row.appendChild(controlsCell);
      row.appendChild(flagsCell);

      body.appendChild(row);

      UI.rows[r.key] = {
        row,
        sub,
        fillTop,
        fillBot,
        netTop,
        netBot,
        modeSel,
        prodSel,
        wInput,
        buyChk,
        sellChk,
        producersSig: '',
      };
    }

    // Initialize padding state
    setOpen(!!STATE.pinnedOpen);
  }

  function updateProducerOptions(resKey, producers) {
    const ui = UI.rows[resKey];
    if (!ui) return;

    // signature to avoid unnecessary DOM work
    const sig = producers.map(p => `${p.id}:${p.need}`).join('|');
    const select = ui.prodSel;

    // Don't rebuild while user is interacting with select
    const isFocused = (document.activeElement === select);

    if (sig === ui.producersSig) return;
    if (isFocused) return;

    const current = select.value || 'auto';
    select.textContent = '';
    const optAuto = document.createElement('option');
    optAuto.value = 'auto';
    optAuto.textContent = 'Auto';
    select.appendChild(optAuto);

    for (const p of producers) {
      const o = document.createElement('option');
      o.value = p.id;
      const needTxt = p.need > 0 ? `${p.need}w` : '0w';
      o.textContent = `${p.name} (${needTxt})`;
      select.appendChild(o);
    }

    // restore selection if possible
    const exists = [...select.options].some(o => o.value === current);
    select.value = exists ? current : 'auto';

    ui.producersSig = sig;
  }

  function updateUI(snap, plan) {
    if (!UI.root) return;

    // Header status
    const workerCap = snap.workerCap || 0;
    const funding = getFundingObj();
    const fNow = Number(funding?.value) || 0;
    const fNet = funding ? ((Number(funding.productionRate)||0) - (Number(funding.consumptionRate)||0) - getMarketNetFromRates(funding) - getAutobuildAvgCost('colony','funding')) : 0;

    UI.status.textContent =
      `Workers: ${snap.workersValue.toFixed(0)}/${workerCap.toFixed(0)}  ·  Funding: ${fmt(fNow, 2)} (base ${fmt(fNet, 2)}/s)`;

    // Notes
    const notes = [];
    if (plan?.notes?.length) notes.push(...plan.notes);
    if (plan?.market?.note) notes.push(plan.market.note);
    UI.notes.textContent = notes.join('  ·  ');

    // Per-row updates
    for (const r of RESOURCES) {
      const ui = UI.rows[r.key];
      if (!ui) continue;

      const sr = snap.resources[r.key];
      if (!sr) {
        ui.sub.textContent = 'Not present';
        ui.fillTop.textContent = 'Fill: —';
        ui.fillBot.textContent = 'Cap: —';
        ui.netTop.textContent = 'Net: —';
        ui.netBot.textContent = 'Base: —';
        continue;
      }

      // update producer options
      updateProducerOptions(r.key, snap.producersByRes[r.key] || []);

      const st = STATE.resources[r.key];

      const capTxt = sr.cap > 0 ? fmt(sr.cap, 2) : '—';
      const fillPct = sr.cap > 0 ? (sr.fill * 100) : 0;
      ui.sub.textContent = sr.unlocked ? `Target ${(st.targetFill*100).toFixed(0)}%` : 'Locked';

      ui.fillTop.textContent = `Fill: ${sr.cap > 0 ? fillPct.toFixed(1) + '%' : '—'}`;
      ui.fillBot.textContent = `Val: ${fmt(sr.value, 2)} / ${capTxt}`;

      // net info (show total and baseline)
      ui.netTop.textContent = `Net: ${fmt(sr.totalNet, 2)}/s`;
      ui.netBot.textContent = `Base: ${fmt(sr.baselineNet, 2)}/s`;

      // color hints
      ui.netTop.classList.toggle('good', sr.totalNet > 0);
      ui.netTop.classList.toggle('bad', sr.totalNet < 0);
    }
  }

  /********************************************************************
   * Main Loop
   ********************************************************************/

  function mainTick() {
    if (!gameReady()) return;

    buildUI();

    const snap = snapshot();

    // Compute plans
    const workerPlan = computeWorkerPlan(snap);
    const marketPlan = computeMarketPlan(snap);
    workerPlan.market = marketPlan;

    // Apply
    applyPlan(workerPlan, snap);
    applyMarketPlan(marketPlan, snap);

    // UI update
    updateUI(snap, workerPlan);
  }

  // Boot
  const boot = () => {
    buildUI();
    // Wait a moment for game globals to appear
    const timer = setInterval(() => {
      if (gameReady()) {
        clearInterval(timer);
        mainTick();
        setInterval(mainTick, TICK_MS);
      }
    }, 400);
  };

  boot();
})();
